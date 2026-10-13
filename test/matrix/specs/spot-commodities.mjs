// Spot family, physical commodities (engine family "spot", catalog support "partial"): eleven products, one
// scenario each. The environmental products of the same family are in spot.mjs.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec, with the arithmetic in the
// comment beside each trade. (The arithmetic was done with a small calculator script of my own,
// $SP/c2/gen.py, which models the rules below and imports nothing from the Terminal; the literals are its output.)
//
// What the catalog leaves to the user ("partial"), established by reading the spot plugin (server/products/security.js)
// and the position lifecycle route (server/api.js), and recorded by hand in these scenarios to completion:
//   - storage, insurance, inspection, freight, pipeline and port charges, feedlot yardage, warehouse rent: manual cash
//     flows on the position (Lifecycle, Manual cash flow, kind Fee);
//   - quality and location terms that change the price (API gravity, calorific value, protein, heat content): a price
//     adjustment as a manual cash flow (kind Realized P&L), or, for the heat content of an LNG cargo, the multiplier;
//   - quantity lost in handling (boil-off, transit shrink): a sale at a stated fill price of 0.00;
//   - the end of an electricity delivery period: the delivery to the offtaker as a sale at the agreed price (State a
//     fill price), and the imbalance charge as a fee; nothing ends the position automatically;
//   - physical delivery itself (load-out, lifting, discharge, vault withdrawal, nominations) is NOT simulated: the
//     Terminal moves no goods. The Lifecycle menu does not offer it and the API refuses it with that reason; each
//     scenario asserts the refusal. A purchase or a sale "delivers" only as its cash settlement (simulated).
//
// Conventions these scenarios rely on (the Terminal's documented rules, restated so the arithmetic can be followed):
//   - A market buy fills at the ask, a market sell at the bid. Value and cash = quantity x price x multiplier, where the
//     quantity is in the product's own unit and the price in its own price unit (`terms.quantityUnit`, `terms.priceUnits`);
//     the multiplier is price units per quantity unit (32.1507466 troy ounces per kilogram, 42 gallons per barrel, 0.01
//     dollars per US cent, 0.01 hundredweight per pound, 2.2046226 pounds per kilogram, 51.8 MMBtu per tonne of LNG).
//   - Cost is booked to the cent; average cost is cost / (quantity x multiplier), in price units; a sale removes cost at
//     the average (all of it when the position closes); realized = proceeds - cost removed.
//   - Commission from the Book's spot fee schedule (per unit of quantity, or basis points of principal), expensed.
//   - Settlement lag: the instrument's own lag when set, else the Book's (settlement.spot = 2, or foreignCash = 2 for a
//     Foreign Based asset), counted on the calendar of the venue's country (US, UK, TARGET2 for the Netherlands and
//     France, Tokyo for Japan). Positions are valued at the last price. No short sale.
//   - US clocks are on daylight time from 8 March 2026: 10:00 New York is 15:00 UTC before and 14:00 UTC after.

export const family = 'spot';

const FILL = { halfSpreadBps: { spot: 5 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const SPOT_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket: Buy, Sell; no Sell short; quantity in the product\'s own unit), then the trade preview; position Lifecycle menu for manual cash flows',
  requiredFields: ['Account (trading owner)', 'Action', 'Quantity in the product\'s own unit'],
  automaticInputs: ['bid, ask, last and size (quote fixture standing in for Shaffer MarketData)', 'fill price and fill model', 'value and cash = quantity x price x multiplier (unit conversion)', 'settlement date on the venue country\'s calendar', 'commission from the Book spot fee schedule'],
};

// ---------------------------------------------------------------------------------------------
// physical_commodity
// ---------------------------------------------------------------------------------------------
// U3O8 bought from a broker for book transfer at a converter. The material is held in kilograms and priced in US dollars per
// pound, so the multiplier is the pounds in a kilogram (2.2046226). Converter storage and insurance are recorded by hand;
// physical delivery out of the converter account is not simulated and is refused; the material is sold in two parts.
const physicalCommodity = {
  productId: 'physical_commodity',
  title: "Uranium concentrate (U3O8) on a converter account: held in kilograms, priced per pound (x 2.2046226 lb/kg), storage and insurance by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["converter storage fee, recorded by hand as a manual cash flow (fee)", "insurance of material at the converter, recorded by hand (fee)"],
    settlement: "T+2 (Book setting settlement.spot) on the US calendar, by book transfer at the converter (simulated: the Terminal moves no material)",
    lifecycle: "Nothing automated; storage and insurance recorded by hand; delivery out of the converter account is not simulated (refused, visibly)",
    accounting: "Value = kilograms x USD per pound x 2.2046226; average cost per pound; broker commission 10 bp expensed; storage and insurance in fees; realized P&L on sale",
    collateral: "None; no short sale",
  },
  start: '2026-04-13T14:00:00.000Z', // Monday 13 April 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix physical commodity", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 10 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "physical_commodity", name: "Uranium concentrate (U3O8), converter account", symbol: "U3O8-CNV", marketView: "US_CASH", venue: "Northline Nuclear Fuels (OTC broker)", venueType: "otc", venueCountry: "US", issuer: "Northline Nuclear Fuels Inc.", domicile: "US", underlyingGeo: "US", tradingCcy: "USD", multiplier: 2.2046226, terms: { quantityUnit: "kilograms U3O8", priceUnits: "USD per pound U3O8" } } },
  quotes: { main: { bid: 82.1, ask: 82.4, last: 82.25, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 2,000 x 82.40 x 2.2046226 = 363_321.80448; fee 363.32
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 2000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2000, estimate: 82.4, model: 'quoted-bid-ask', settleDate: '2026-04-15', calendar: 'US', cash: -363_321.8, fees: 363.32 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2000, avgPrice: 82.4 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 2,000 U3O8-CNV @ 82.40 USD", owner: 'account', date: '2026-04-13' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -363_685.12, availableToTrade: 636_314.88, availableToWithdraw: 636_314.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2000, avgCost: 82.399999, cost: 363_321.8, price: 82.25, value: 362_660.42, unrealized: -661.38, priceSource: 'Test fixture' }], // value 2,000 x 82.25 x 2.2046226 = 362_660.4177; avgCost 363_321.8 / (2,000 x 2.2046226),
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-15', amount: -363_685.12, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -363.32, fees: 0, unrealized: -661.38, total: -1024.7 } },
        nav: { account: 998_975.3, book: 1_998_975.3 },
        balance: { account: { cash: 1_000_000, positions: 362_660.42, receivable: null, payable: 363_685.12, assets: 1_362_660.42, liabilities: 363_685.12, netAssets: 998_975.3 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-04-15T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 363,685.12 USD from settled cash', cash: { USD: -363_685.12 }, owner: 'account', date: '2026-04-15' }],
        cash: { account: { USD: { settled: 636_314.88, unsettled: 0, availableToTrade: 636_314.88, availableToWithdraw: 636_314.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2000, avgCost: 82.399999, cost: 363_321.8, price: 82.25, value: 362_660.42, unrealized: -661.38, priceSource: 'Test fixture' }], // value 2,000 x 82.25 x 2.2046226 = 362_660.4177; avgCost 363_321.8 / (2,000 x 2.2046226),
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -363.32, fees: 0, unrealized: -661.38, total: -1024.7 } },
        nav: { account: 998_975.3, book: 1_998_975.3 },
        balance: { account: { cash: 636_314.88, positions: 362_660.42, receivable: null, payable: null, assets: 998_975.3, liabilities: 0, netAssets: 998_975.3 } },
      },
    },
    {
      id: 'converter-storage', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -1250, note: "Converter storage for April, Port Hope account",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on U3O8-CNV: paid 1,250.00 USD. Converter storage for April, Port Hope account", cash: { USD: -1250 }, owner: 'account' }],
        cash: { account: { USD: { settled: 635_064.88, unsettled: 0, availableToTrade: 635_064.88, availableToWithdraw: 635_064.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2000, avgCost: 82.399999, cost: 363_321.8, price: 82.25, value: 362_660.42, unrealized: -661.38, priceSource: 'Test fixture' }], // value 2,000 x 82.25 x 2.2046226 = 362_660.4177; avgCost 363_321.8 / (2,000 x 2.2046226),
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -363.32, fees: -1250, unrealized: -661.38, total: -2274.7 } },
        nav: { account: 997_725.3, book: 1_997_725.3 },
        balance: { account: { cash: 635_064.88, positions: 362_660.42, receivable: null, payable: null, assets: 997_725.3, liabilities: 0, netAssets: 997_725.3 } },
      },
    },
    {
      id: 'insurance', covers: "insurance", action: 'cashflow', lot: 'lot', category: 'fee', amount: -480, note: "Insurance of material held at the converter, April",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on U3O8-CNV: paid 480.00 USD. Insurance of material held at the converter, April", cash: { USD: -480 }, owner: 'account' }],
        cash: { account: { USD: { settled: 634_584.88, unsettled: 0, availableToTrade: 634_584.88, availableToWithdraw: 634_584.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2000, avgCost: 82.399999, cost: 363_321.8, price: 82.25, value: 362_660.42, unrealized: -661.38, priceSource: 'Test fixture' }], // value 2,000 x 82.25 x 2.2046226 = 362_660.4177; avgCost 363_321.8 / (2,000 x 2.2046226),
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -363.32, fees: -1730, unrealized: -661.38, total: -2754.7 } },
        nav: { account: 997_245.3, book: 1_997_245.3 },
        balance: { account: { cash: 634_584.88, positions: 362_660.42, receivable: null, payable: null, assets: 997_245.3, liabilities: 0, netAssets: 997_245.3 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 84, ask: 84.3, last: 84.15, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 634_584.88, unsettled: 0, availableToTrade: 634_584.88, availableToWithdraw: 634_584.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2000, avgCost: 82.399999, cost: 363_321.8, price: 84.15000000000000568434188608, value: 371_037.98, unrealized: 7716.18, priceSource: 'Test fixture' }], // value 2,000 x 84.15 x 2.2046226 = 371_037.9835800000250636571764; avgCost 363_321.8 / (2,000 x 2.2046226),
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -363.32, fees: -1730, unrealized: 7716.18, total: 5622.86 } },
        nav: { account: 1_005_622.86, book: 2_005_622.86 },
        balance: { account: { cash: 634_584.88, positions: 371_037.98, receivable: null, payable: null, assets: 1_005_622.86, liabilities: 0, netAssets: 1_005_622.86 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Moving the material out of the converter account is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 800 x 84.00 x 2.2046226 = 148_150.63872; fee 148.15; realized 148_150.64 - cost out 145_328.72 = 2821.92
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 800, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 800, estimate: 84, model: 'quoted-bid-ask', settleDate: '2026-04-17', calendar: 'US', cash: 148_150.64, fees: 148.15 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 800, avgPrice: 84 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 800 U3O8-CNV @ 84.00 USD (realized 2,821.92 USD)", owner: 'account', date: '2026-04-15' }],
        cash: { account: { USD: { settled: 634_584.88, unsettled: 148_002.49, availableToTrade: 782_587.37, availableToWithdraw: 634_584.88 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 1200, avgCost: 82.399999, cost: 217_993.08, price: 84.15000000000000568434188608, value: 222_622.79, unrealized: 4629.71, priceSource: 'Test fixture' }], // value 1,200 x 84.15 x 2.2046226 = 222_622.7901480000150381943058; avgCost 217_993.08 / (1,200 x 2.2046226),
        holdings: { main: { long: 1200, short: 0, net: 1200 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-17', amount: 148_002.49, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 2821.92, commissions: -511.47, fees: -1730, unrealized: 4629.71, total: 5210.16 } },
        nav: { account: 1_005_210.16, book: 2_005_210.16 },
        balance: { account: { cash: 634_584.88, positions: 222_622.79, receivable: 148_002.49, payable: null, assets: 1_005_210.16, liabilities: 0, netAssets: 1_005_210.16 } },
      },
    },
    // 1,200 x 84.00 x 2.2046226 = 222_225.95808; fee 222.23; realized 222_225.96 - cost out 217_993.08 = 4232.88
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 1200, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 1200, estimate: 84, model: 'quoted-bid-ask', settleDate: '2026-04-17', calendar: 'US', cash: 222_225.96, fees: 222.23 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 1200, avgPrice: 84 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 1,200 U3O8-CNV @ 84.00 USD (realized 4,232.88 USD)", owner: 'account', date: '2026-04-15' }],
        cash: { account: { USD: { settled: 634_584.88, unsettled: 370_006.22, availableToTrade: 1_004_591.1, availableToWithdraw: 634_584.88 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-17', amount: 148_002.49, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-17', amount: 222_003.73, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 7054.8, commissions: -733.7, fees: -1730, unrealized: 0, total: 4591.1 } },
        nav: { account: 1_004_591.1, book: 2_004_591.1 },
        balance: { account: { cash: 634_584.88, positions: null, receivable: 370_006.22, payable: null, assets: 1_004_591.1, liabilities: 0, netAssets: 1_004_591.1 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-04-17T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 148,002.49 USD into settled cash', cash: { USD: 148_002.49 }, owner: 'account', date: '2026-04-17' }, { type: 'settlement.receive', summary: 'received 222,003.73 USD into settled cash', cash: { USD: 222_003.73 }, owner: 'account', date: '2026-04-17' }],
        cash: { account: { USD: { settled: 1_004_591.1, unsettled: 0, availableToTrade: 1_004_591.1, availableToWithdraw: 1_004_591.1 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 7054.8, commissions: -733.7, fees: -1730, unrealized: 0, total: 4591.1 } },
        nav: { account: 1_004_591.1, book: 2_004_591.1 },
        balance: { account: { cash: 1_004_591.1, positions: null, receivable: null, payable: null, assets: 1_004_591.1, liabilities: 0, netAssets: 1_004_591.1 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// precious_metal
// ---------------------------------------------------------------------------------------------
// Treasury buys five allocated 1 kg gold bars from a London dealer. Bars are whole (lot size 1); the price is US dollars per troy
// ounce and a kilogram is 32.1507466 troy ounces. Bought on Thursday 30 April, the trade settles T+2 on the London calendar:
// Friday 1 May, then Tuesday 5 May (Monday 4 May is the Early May bank holiday). Vault storage and insurance are recorded by hand.
const preciousMetal = {
  productId: 'precious_metal',
  title: "Allocated gold kilobars in a London vault, held by Treasury: kilograms priced per troy ounce (x 32.1507466), settlement over the May bank holiday",
  matrix: {
    ...SPOT_TICKET,
    requiredFields: ["Account (trading owner: Treasury)", "Action", "Kilograms (whole bars: lot size 1)"],
    manualInputs: ["allocated vault storage, recorded by hand (fee)", "insurance, recorded by hand (fee)"],
    settlement: "T+2 (Book setting settlement.foreignCash) on the London calendar: over the Early May bank holiday",
    lifecycle: "Nothing automated; storage and insurance recorded by hand; taking the bars out of the vault is not simulated (refused, visibly)",
    accounting: "Value = kilograms x USD per troy ounce x 32.1507466; average cost per troy ounce; no commission (dealer spread only); realized P&L on sale; owned by Treasury",
    collateral: "None; no short sale",
  },
  start: '2026-04-30T14:00:00.000Z', // Thursday 30 April 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: ["2026-05-04"] },
  book: { name: "Matrix precious metal", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "precious_metal", name: "Gold kilobar, 995 fine, allocated, London vault", symbol: "AU-KB-LDN", marketView: "FOREIGN_CASH", venue: "Thameside Bullion (OTC dealer)", venueType: "otc", venueCountry: "GB", issuer: "Thameside Bullion Ltd", domicile: "GB", underlyingGeo: "Global", tradingCcy: "USD", multiplier: 32.1507466, terms: { lotSize: 1, quantityUnit: "kilograms (1 kg bars)", priceUnits: "USD per troy ounce" } } },
  quotes: { main: { bid: 2298, ask: 2300, last: 2299, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { treasury: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, account: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { treasury: 1000000, account: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 5 x 2,300.00 x 32.1507466 = 369_733.5859
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 5, as: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5, estimate: 2300, model: 'quoted-bid-ask', settleDate: '2026-05-05', calendar: 'UK', cash: -369_733.59, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5, avgPrice: 2300 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 5 AU-KB-LDN @ 2,300.00 USD", owner: 'treasury', date: '2026-04-30' }],
        cash: { treasury: { USD: { settled: 1_000_000, unsettled: -369_733.59, availableToTrade: 630_266.41, availableToWithdraw: 630_266.41 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 5, avgCost: 2300.000026, cost: 369_733.59, price: 2299, value: 369_572.83, unrealized: -160.76, priceSource: 'Test fixture' }], // value 5 x 2299 x 32.1507466 = 369_572.832167; avgCost 369_733.59 / (5 x 32.1507466),
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-05-05', amount: -369_733.59, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 0, commissions: 0, fees: 0, unrealized: -160.76, total: -160.76 } },
        nav: { treasury: 999_839.24, book: 1_999_839.24 },
        balance: { treasury: { cash: 1_000_000, positions: 369_572.83, receivable: null, payable: 369_733.59, assets: 1_369_572.83, liabilities: 369_733.59, netAssets: 999_839.24 } },
      },
    },
    {
      id: 'fractional-bar', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2.5, owner: 'treasury',
      status: 'blocked', reason: "Kilobars are whole bars (lot size 1).",
      expect: {
        refused: 'quantity must be a multiple of 1',
      },
    },
    {
      id: 'friday', action: 'clock', to: '2026-05-01T14:00:00.000Z',
      expect: {
      },
    },
    {
      id: 'uk-bank-holiday', action: 'clock', to: '2026-05-04T14:00:00.000Z',
      expect: {
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-05-05T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 369,733.59 USD from settled cash', cash: { USD: -369_733.59 }, owner: 'treasury', date: '2026-05-05' }],
        cash: { treasury: { USD: { settled: 630_266.41, unsettled: 0, availableToTrade: 630_266.41, availableToWithdraw: 630_266.41 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 5, avgCost: 2300.000026, cost: 369_733.59, price: 2299, value: 369_572.83, unrealized: -160.76, priceSource: 'Test fixture' }], // value 5 x 2299 x 32.1507466 = 369_572.832167; avgCost 369_733.59 / (5 x 32.1507466),
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: 0, fees: 0, unrealized: -160.76, total: -160.76 } },
        nav: { treasury: 999_839.24, book: 1_999_839.24 },
        balance: { treasury: { cash: 630_266.41, positions: 369_572.83, receivable: null, payable: null, assets: 999_839.24, liabilities: 0, netAssets: 999_839.24 } },
      },
    },
    {
      id: 'vault-storage', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -310, note: "Allocated vault storage for May",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on AU-KB-LDN: paid 310.00 USD. Allocated vault storage for May", cash: { USD: -310 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 629_956.41, unsettled: 0, availableToTrade: 629_956.41, availableToWithdraw: 629_956.41 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 5, avgCost: 2300.000026, cost: 369_733.59, price: 2299, value: 369_572.83, unrealized: -160.76, priceSource: 'Test fixture' }], // value 5 x 2299 x 32.1507466 = 369_572.832167; avgCost 369_733.59 / (5 x 32.1507466),
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: 0, fees: -310, unrealized: -160.76, total: -470.76 } },
        nav: { treasury: 999_529.24, book: 1_999_529.24 },
        balance: { treasury: { cash: 629_956.41, positions: 369_572.83, receivable: null, payable: null, assets: 999_529.24, liabilities: 0, netAssets: 999_529.24 } },
      },
    },
    {
      id: 'insurance', covers: "insurance", action: 'cashflow', lot: 'lot', category: 'fee', amount: -95, note: "Insurance of the bars in the vault, May",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on AU-KB-LDN: paid 95.00 USD. Insurance of the bars in the vault, May", cash: { USD: -95 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 629_861.41, unsettled: 0, availableToTrade: 629_861.41, availableToWithdraw: 629_861.41 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 5, avgCost: 2300.000026, cost: 369_733.59, price: 2299, value: 369_572.83, unrealized: -160.76, priceSource: 'Test fixture' }], // value 5 x 2299 x 32.1507466 = 369_572.832167; avgCost 369_733.59 / (5 x 32.1507466),
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: 0, fees: -405, unrealized: -160.76, total: -565.76 } },
        nav: { treasury: 999_434.24, book: 1_999_434.24 },
        balance: { treasury: { cash: 629_861.41, positions: 369_572.83, receivable: null, payable: null, assets: 999_434.24, liabilities: 0, netAssets: 999_434.24 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 2350, ask: 2352, last: 2351, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { treasury: { USD: { settled: 629_861.41, unsettled: 0, availableToTrade: 629_861.41, availableToWithdraw: 629_861.41 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 5, avgCost: 2300.000026, cost: 369_733.59, price: 2351, value: 377_932.03, unrealized: 8198.44, priceSource: 'Test fixture' }], // value 5 x 2351 x 32.1507466 = 377_932.026283; avgCost 369_733.59 / (5 x 32.1507466),
        holdings: { main: { long: 5, short: 0, net: 5 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: 0, fees: -405, unrealized: 8198.44, total: 7793.44 } },
        nav: { treasury: 1_007_793.44, book: 2_007_793.44 },
        balance: { treasury: { cash: 629_861.41, positions: 377_932.03, receivable: null, payable: null, assets: 1_007_793.44, liabilities: 0, netAssets: 1_007_793.44 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Taking the bars out of the vault is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 2 x 2,350.00 x 32.1507466 = 151_108.50902; realized 151_108.51 - cost out 147_893.44 = 3215.07
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 2, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2, estimate: 2350, model: 'quoted-bid-ask', settleDate: '2026-05-07', calendar: 'UK', cash: 151_108.51, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2, avgPrice: 2350 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 2 AU-KB-LDN @ 2,350.00 USD (realized 3,215.07 USD)", owner: 'treasury', date: '2026-05-05' }],
        cash: { treasury: { USD: { settled: 629_861.41, unsettled: 151_108.51, availableToTrade: 780_969.92, availableToWithdraw: 629_861.41 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 3, avgCost: 2299.999984, cost: 221_840.15, price: 2351, value: 226_759.22, unrealized: 4919.07, priceSource: 'Test fixture' }], // value 3 x 2351 x 32.1507466 = 226_759.2157698; avgCost 221_840.15 / (3 x 32.1507466),
        holdings: { main: { long: 3, short: 0, net: 3 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-05-07', amount: 151_108.51, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 3215.07, commissions: 0, fees: -405, unrealized: 4919.07, total: 7729.14 } },
        nav: { treasury: 1_007_729.14, book: 2_007_729.14 },
        balance: { treasury: { cash: 629_861.41, positions: 226_759.22, receivable: 151_108.51, payable: null, assets: 1_007_729.14, liabilities: 0, netAssets: 1_007_729.14 } },
      },
    },
    // 3 x 2,350.00 x 32.1507466 = 226_662.76353; realized 226_662.76 - cost out 221_840.15 = 4822.61
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 3, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3, estimate: 2350, model: 'quoted-bid-ask', settleDate: '2026-05-07', calendar: 'UK', cash: 226_662.76, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 3, avgPrice: 2350 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 3 AU-KB-LDN @ 2,350.00 USD (realized 4,822.61 USD)", owner: 'treasury', date: '2026-05-05' }],
        cash: { treasury: { USD: { settled: 629_861.41, unsettled: 377_771.27, availableToTrade: 1_007_632.68, availableToWithdraw: 629_861.41 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-05-07', amount: 151_108.51, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-05-07', amount: 226_662.76, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 8037.68, commissions: 0, fees: -405, unrealized: 0, total: 7632.68 } },
        nav: { treasury: 1_007_632.68, book: 2_007_632.68 },
        balance: { treasury: { cash: 629_861.41, positions: null, receivable: 377_771.27, payable: null, assets: 1_007_632.68, liabilities: 0, netAssets: 1_007_632.68 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-05-07T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 151,108.51 USD into settled cash', cash: { USD: 151_108.51 }, owner: 'treasury', date: '2026-05-07' }, { type: 'settlement.receive', summary: 'received 226,662.76 USD into settled cash', cash: { USD: 226_662.76 }, owner: 'treasury', date: '2026-05-07' }],
        cash: { treasury: { USD: { settled: 1_007_632.68, unsettled: 0, availableToTrade: 1_007_632.68, availableToWithdraw: 1_007_632.68 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { treasury: { realized: 8037.68, commissions: 0, fees: -405, unrealized: 0, total: 7632.68 } },
        nav: { treasury: 1_007_632.68, book: 2_007_632.68 },
        balance: { treasury: { cash: 1_007_632.68, positions: null, receivable: null, payable: null, assets: 1_007_632.68, liabilities: 0, netAssets: 1_007_632.68 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// industrial_metal
// ---------------------------------------------------------------------------------------------
// Copper cathode on warrant in an LME-registered warehouse in Rotterdam, dealt in lots of 25 tonnes (lot size 25), priced in US
// dollars per tonne, settled T+2 on TARGET2 days (the venue is in the Netherlands). Warehouse rent is recorded by hand.
const industrialMetal = {
  productId: 'industrial_metal',
  title: "Copper cathode, LME Grade A, in a Rotterdam warehouse: tonnes in 25-tonne lots, warehouse rent by hand",
  matrix: {
    ...SPOT_TICKET,
    requiredFields: ["Account (trading owner)", "Action", "Tonnes (lots of 25)"],
    manualInputs: ["LME warehouse rent, recorded by hand (fee)"],
    settlement: "T+2 (Book setting settlement.foreignCash) on the TARGET2 calendar of the Rotterdam venue",
    lifecycle: "Nothing automated; warehouse rent recorded by hand; load-out (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = tonnes x USD per tonne; commission 1.00 per tonne expensed; rent in fees; realized P&L on sale",
    collateral: "None; no short sale",
  },
  start: '2026-03-03T15:00:00.000Z', // Tuesday 3 March 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix industrial metal", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 1, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "industrial_metal", name: "Copper cathode, LME Grade A, Rotterdam warehouse", symbol: "CU-ROT", marketView: "FOREIGN_CASH", venue: "Maasvlakte Metals (OTC dealer)", venueType: "otc", venueCountry: "NL", issuer: "Maasvlakte Metals BV", domicile: "NL", underlyingGeo: "Global", tradingCcy: "USD", terms: { lotSize: 25, quantityUnit: "tonnes", priceUnits: "USD per tonne" } } },
  quotes: { main: { bid: 9840, ask: 9850, last: 9845, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 50 x 9,850.00 x 1 = 492_500; fee 50
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 50, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 50, estimate: 9850, model: 'quoted-bid-ask', settleDate: '2026-03-05', calendar: 'TARGET', cash: -492_500, fees: 50 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50, avgPrice: 9850 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 50 CU-ROT @ 9,850.00 USD", owner: 'account', date: '2026-03-03' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -492_550, availableToTrade: 507_450, availableToWithdraw: 507_450 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50, avgCost: 9850, cost: 492_500, price: 9845, value: 492_250, unrealized: -250, priceSource: 'Test fixture' }], // value 50 x 9845 x 1 = 492_250; avgCost 492_500 / (50 x 1),
        holdings: { main: { long: 50, short: 0, net: 50 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-05', amount: -492_550, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -50, fees: 0, unrealized: -250, total: -300 } },
        nav: { account: 999_700, book: 1_999_700 },
        balance: { account: { cash: 1_000_000, positions: 492_250, receivable: null, payable: 492_550, assets: 1_492_250, liabilities: 492_550, netAssets: 999_700 } },
      },
    },
    {
      id: 'odd-lot', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 60,
      status: 'blocked', reason: "Copper is dealt in lots of 25 tonnes.",
      expect: {
        refused: 'quantity must be a multiple of 25',
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-03-05T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 492,550.00 USD from settled cash', cash: { USD: -492_550 }, owner: 'account', date: '2026-03-05' }],
        cash: { account: { USD: { settled: 507_450, unsettled: 0, availableToTrade: 507_450, availableToWithdraw: 507_450 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50, avgCost: 9850, cost: 492_500, price: 9845, value: 492_250, unrealized: -250, priceSource: 'Test fixture' }], // value 50 x 9845 x 1 = 492_250; avgCost 492_500 / (50 x 1),
        holdings: { main: { long: 50, short: 0, net: 50 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -50, fees: 0, unrealized: -250, total: -300 } },
        nav: { account: 999_700, book: 1_999_700 },
        balance: { account: { cash: 507_450, positions: 492_250, receivable: null, payable: null, assets: 999_700, liabilities: 0, netAssets: 999_700 } },
      },
    },
    {
      id: 'warehouse-rent', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -1845, note: "LME warehouse rent for March, Rotterdam",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on CU-ROT: paid 1,845.00 USD. LME warehouse rent for March, Rotterdam", cash: { USD: -1845 }, owner: 'account' }],
        cash: { account: { USD: { settled: 505_605, unsettled: 0, availableToTrade: 505_605, availableToWithdraw: 505_605 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50, avgCost: 9850, cost: 492_500, price: 9845, value: 492_250, unrealized: -250, priceSource: 'Test fixture' }], // value 50 x 9845 x 1 = 492_250; avgCost 492_500 / (50 x 1),
        holdings: { main: { long: 50, short: 0, net: 50 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -50, fees: -1845, unrealized: -250, total: -2145 } },
        nav: { account: 997_855, book: 1_997_855 },
        balance: { account: { cash: 505_605, positions: 492_250, receivable: null, payable: null, assets: 997_855, liabilities: 0, netAssets: 997_855 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 9960, ask: 9970, last: 9965, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 505_605, unsettled: 0, availableToTrade: 505_605, availableToWithdraw: 505_605 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50, avgCost: 9850, cost: 492_500, price: 9965, value: 498_250, unrealized: 5750, priceSource: 'Test fixture' }], // value 50 x 9965 x 1 = 498_250; avgCost 492_500 / (50 x 1),
        holdings: { main: { long: 50, short: 0, net: 50 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -50, fees: -1845, unrealized: 5750, total: 3855 } },
        nav: { account: 1_003_855, book: 2_003_855 },
        balance: { account: { cash: 505_605, positions: 498_250, receivable: null, payable: null, assets: 1_003_855, liabilities: 0, netAssets: 1_003_855 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Load-out of the cathode from the warehouse is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 25 x 9,960.00 x 1 = 249_000; fee 25; realized 249_000 - cost out 246_250 = 2750
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 25, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 25, estimate: 9960, model: 'quoted-bid-ask', settleDate: '2026-03-09', calendar: 'TARGET', cash: 249_000, fees: 25 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 25, avgPrice: 9960 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 25 CU-ROT @ 9,960.00 USD (realized 2,750.00 USD)", owner: 'account', date: '2026-03-05' }],
        cash: { account: { USD: { settled: 505_605, unsettled: 248_975, availableToTrade: 754_580, availableToWithdraw: 505_605 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 25, avgCost: 9850, cost: 246_250, price: 9965, value: 249_125, unrealized: 2875, priceSource: 'Test fixture' }], // value 25 x 9965 x 1 = 249_125; avgCost 246_250 / (25 x 1),
        holdings: { main: { long: 25, short: 0, net: 25 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-09', amount: 248_975, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 2750, commissions: -75, fees: -1845, unrealized: 2875, total: 3705 } },
        nav: { account: 1_003_705, book: 2_003_705 },
        balance: { account: { cash: 505_605, positions: 249_125, receivable: 248_975, payable: null, assets: 1_003_705, liabilities: 0, netAssets: 1_003_705 } },
      },
    },
    // 25 x 9,960.00 x 1 = 249_000; fee 25; realized 249_000 - cost out 246_250 = 2750
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 25, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 25, estimate: 9960, model: 'quoted-bid-ask', settleDate: '2026-03-09', calendar: 'TARGET', cash: 249_000, fees: 25 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 25, avgPrice: 9960 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 25 CU-ROT @ 9,960.00 USD (realized 2,750.00 USD)", owner: 'account', date: '2026-03-05' }],
        cash: { account: { USD: { settled: 505_605, unsettled: 497_950, availableToTrade: 1_003_555, availableToWithdraw: 505_605 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-09', amount: 248_975, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-09', amount: 248_975, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 5500, commissions: -100, fees: -1845, unrealized: 0, total: 3555 } },
        nav: { account: 1_003_555, book: 2_003_555 },
        balance: { account: { cash: 505_605, positions: null, receivable: 497_950, payable: null, assets: 1_003_555, liabilities: 0, netAssets: 1_003_555 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-03-09T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 248,975.00 USD into settled cash', cash: { USD: 248_975 }, owner: 'account', date: '2026-03-09' }, { type: 'settlement.receive', summary: 'received 248,975.00 USD into settled cash', cash: { USD: 248_975 }, owner: 'account', date: '2026-03-09' }],
        cash: { account: { USD: { settled: 1_003_555, unsettled: 0, availableToTrade: 1_003_555, availableToWithdraw: 1_003_555 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 5500, commissions: -100, fees: -1845, unrealized: 0, total: 3555 } },
        nav: { account: 1_003_555, book: 2_003_555 },
        balance: { account: { cash: 1_003_555, positions: null, receivable: null, payable: null, assets: 1_003_555, liabilities: 0, netAssets: 1_003_555 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// crude_oil
// ---------------------------------------------------------------------------------------------
// WTI pipeline barrels at Cushing, Oklahoma, in barrels and US dollars per barrel, with a broker fee of 0.02 per barrel. Tank storage,
// the pipeline's quality-bank credit for a higher API gravity than specified, and the pipeline tariff to the buyer are recorded by hand.
const crudeOil = {
  productId: 'crude_oil',
  title: "WTI crude oil at Cushing (pipeline barrels): tank storage, quality bank credit and pipeline tariff by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["tank storage, recorded by hand (fee)", "quality-bank adjustment for API gravity, recorded by hand (realized)", "pipeline tariff (delivery cost), recorded by hand (fee)"],
    settlement: "T+2 (Book setting settlement.spot) on the US calendar",
    lifecycle: "Nothing automated; storage, quality and delivery costs recorded by hand; lifting the barrels (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = barrels x USD per barrel; broker fee 0.02 per barrel expensed; storage and tariff in fees; quality credit in realized P&L",
    collateral: "None; no short sale",
  },
  start: '2026-03-09T14:00:00.000Z', // Monday 9 March 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix crude oil", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0.02, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "crude_oil", name: "WTI crude oil, Cushing, Oklahoma (pipeline barrels)", symbol: "WTI-CUSH", marketView: "US_CASH", venue: "Prairie Energy Marketing (OTC)", venueType: "otc", venueCountry: "US", issuer: "Prairie Energy Marketing LLC", domicile: "US", underlyingGeo: "US", tradingCcy: "USD", terms: { quantityUnit: "barrels", priceUnits: "USD per barrel" } } },
  quotes: { main: { bid: 71.35, ask: 71.4, last: 71.38, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 10,000 x 71.40 x 1 = 714_000; fee 200
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 10_000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 10_000, estimate: 71.4, model: 'quoted-bid-ask', settleDate: '2026-03-11', calendar: 'US', cash: -714_000, fees: 200 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000, avgPrice: 71.4 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 10,000 WTI-CUSH @ 71.40 USD", owner: 'account', date: '2026-03-09' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -714_200, availableToTrade: 285_800, availableToWithdraw: 285_800 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 10_000, avgCost: 71.4, cost: 714_000, price: 71.37999999999999545252649114, value: 713_800, unrealized: -200, priceSource: 'Test fixture' }], // value 10,000 x 71.38 x 1 = 713_799.9999999999545252649114; avgCost 714_000 / (10,000 x 1),
        holdings: { main: { long: 10_000, short: 0, net: 10_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-11', amount: -714_200, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -200, fees: 0, unrealized: -200, total: -400 } },
        nav: { account: 999_600, book: 1_999_600 },
        balance: { account: { cash: 1_000_000, positions: 713_800, receivable: null, payable: 714_200, assets: 1_713_800, liabilities: 714_200, netAssets: 999_600 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-03-11T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 714,200.00 USD from settled cash', cash: { USD: -714_200 }, owner: 'account', date: '2026-03-11' }],
        cash: { account: { USD: { settled: 285_800, unsettled: 0, availableToTrade: 285_800, availableToWithdraw: 285_800 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 10_000, avgCost: 71.4, cost: 714_000, price: 71.37999999999999545252649114, value: 713_800, unrealized: -200, priceSource: 'Test fixture' }], // value 10,000 x 71.38 x 1 = 713_799.9999999999545252649114; avgCost 714_000 / (10,000 x 1),
        holdings: { main: { long: 10_000, short: 0, net: 10_000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -200, fees: 0, unrealized: -200, total: -400 } },
        nav: { account: 999_600, book: 1_999_600 },
        balance: { account: { cash: 285_800, positions: 713_800, receivable: null, payable: null, assets: 999_600, liabilities: 0, netAssets: 999_600 } },
      },
    },
    {
      id: 'tank-storage', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -1500, note: "Tank storage at Cushing for March",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on WTI-CUSH: paid 1,500.00 USD. Tank storage at Cushing for March", cash: { USD: -1500 }, owner: 'account' }],
        cash: { account: { USD: { settled: 284_300, unsettled: 0, availableToTrade: 284_300, availableToWithdraw: 284_300 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 10_000, avgCost: 71.4, cost: 714_000, price: 71.37999999999999545252649114, value: 713_800, unrealized: -200, priceSource: 'Test fixture' }], // value 10,000 x 71.38 x 1 = 713_799.9999999999545252649114; avgCost 714_000 / (10,000 x 1),
        holdings: { main: { long: 10_000, short: 0, net: 10_000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -200, fees: -1500, unrealized: -200, total: -1900 } },
        nav: { account: 998_100, book: 1_998_100 },
        balance: { account: { cash: 284_300, positions: 713_800, receivable: null, payable: null, assets: 998_100, liabilities: 0, netAssets: 998_100 } },
      },
    },
    {
      id: 'quality-bank', covers: "quality adjustment", action: 'cashflow', lot: 'lot', category: 'realized', amount: 420, note: "Quality bank credit: API gravity 40.2 delivered against 39.6 specified",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual realized on WTI-CUSH: received 420.00 USD. Quality bank credit: API gravity 40.2 delivered against 39.6 specified", cash: { USD: 420 }, owner: 'account' }],
        cash: { account: { USD: { settled: 284_720, unsettled: 0, availableToTrade: 284_720, availableToWithdraw: 284_720 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 10_000, avgCost: 71.4, cost: 714_000, price: 71.37999999999999545252649114, value: 713_800, unrealized: -200, priceSource: 'Test fixture' }], // value 10,000 x 71.38 x 1 = 713_799.9999999999545252649114; avgCost 714_000 / (10,000 x 1),
        holdings: { main: { long: 10_000, short: 0, net: 10_000 } },
        pending: [],
        pnl: { account: { realized: 420, commissions: -200, fees: -1500, unrealized: -200, total: -1480 } },
        nav: { account: 998_520, book: 1_998_520 },
        balance: { account: { cash: 284_720, positions: 713_800, receivable: null, payable: null, assets: 998_520, liabilities: 0, netAssets: 998_520 } },
      },
    },
    {
      id: 'pipeline-tariff', covers: "delivery cost", action: 'cashflow', lot: 'lot', category: 'fee', amount: -850, note: "Pipeline tariff to the buyer tank at Cushing (delivery cost)",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on WTI-CUSH: paid 850.00 USD. Pipeline tariff to the buyer tank at Cushing (delivery cost)", cash: { USD: -850 }, owner: 'account' }],
        cash: { account: { USD: { settled: 283_870, unsettled: 0, availableToTrade: 283_870, availableToWithdraw: 283_870 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 10_000, avgCost: 71.4, cost: 714_000, price: 71.37999999999999545252649114, value: 713_800, unrealized: -200, priceSource: 'Test fixture' }], // value 10,000 x 71.38 x 1 = 713_799.9999999999545252649114; avgCost 714_000 / (10,000 x 1),
        holdings: { main: { long: 10_000, short: 0, net: 10_000 } },
        pending: [],
        pnl: { account: { realized: 420, commissions: -200, fees: -2350, unrealized: -200, total: -2330 } },
        nav: { account: 997_670, book: 1_997_670 },
        balance: { account: { cash: 283_870, positions: 713_800, receivable: null, payable: null, assets: 997_670, liabilities: 0, netAssets: 997_670 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 72.1, ask: 72.15, last: 72.12, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 283_870, unsettled: 0, availableToTrade: 283_870, availableToWithdraw: 283_870 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 10_000, avgCost: 71.4, cost: 714_000, price: 72.12000000000000454747350886, value: 721_200, unrealized: 7200, priceSource: 'Test fixture' }], // value 10,000 x 72.12 x 1 = 721_200.0000000000454747350886; avgCost 714_000 / (10,000 x 1),
        holdings: { main: { long: 10_000, short: 0, net: 10_000 } },
        pending: [],
        pnl: { account: { realized: 420, commissions: -200, fees: -2350, unrealized: 7200, total: 5070 } },
        nav: { account: 1_005_070, book: 2_005_070 },
        balance: { account: { cash: 283_870, positions: 721_200, receivable: null, payable: null, assets: 1_005_070, liabilities: 0, netAssets: 1_005_070 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Lifting the barrels from the tank is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 4,000 x 72.10 x 1 = 288_400; fee 80; realized 288_400 - cost out 285_600 = 2800
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 4000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 4000, estimate: 72.1, model: 'quoted-bid-ask', settleDate: '2026-03-13', calendar: 'US', cash: 288_400, fees: 80 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 4000, avgPrice: 72.1 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 4,000 WTI-CUSH @ 72.10 USD (realized 2,800.00 USD)", owner: 'account', date: '2026-03-11' }],
        cash: { account: { USD: { settled: 283_870, unsettled: 288_320, availableToTrade: 572_190, availableToWithdraw: 283_870 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 6000, avgCost: 71.4, cost: 428_400, price: 72.12000000000000454747350886, value: 432_720, unrealized: 4320, priceSource: 'Test fixture' }], // value 6,000 x 72.12 x 1 = 432_720.0000000000272848410532; avgCost 428_400 / (6,000 x 1),
        holdings: { main: { long: 6000, short: 0, net: 6000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-13', amount: 288_320, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 3220, commissions: -280, fees: -2350, unrealized: 4320, total: 4910 } },
        nav: { account: 1_004_910, book: 2_004_910 },
        balance: { account: { cash: 283_870, positions: 432_720, receivable: 288_320, payable: null, assets: 1_004_910, liabilities: 0, netAssets: 1_004_910 } },
      },
    },
    // 6,000 x 72.10 x 1 = 432_600; fee 120; realized 432_600 - cost out 428_400 = 4200
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 6000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 6000, estimate: 72.1, model: 'quoted-bid-ask', settleDate: '2026-03-13', calendar: 'US', cash: 432_600, fees: 120 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 6000, avgPrice: 72.1 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 6,000 WTI-CUSH @ 72.10 USD (realized 4,200.00 USD)", owner: 'account', date: '2026-03-11' }],
        cash: { account: { USD: { settled: 283_870, unsettled: 720_800, availableToTrade: 1_004_670, availableToWithdraw: 283_870 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-13', amount: 288_320, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-13', amount: 432_480, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 7420, commissions: -400, fees: -2350, unrealized: 0, total: 4670 } },
        nav: { account: 1_004_670, book: 2_004_670 },
        balance: { account: { cash: 283_870, positions: null, receivable: 720_800, payable: null, assets: 1_004_670, liabilities: 0, netAssets: 1_004_670 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-03-13T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 288,320.00 USD into settled cash', cash: { USD: 288_320 }, owner: 'account', date: '2026-03-13' }, { type: 'settlement.receive', summary: 'received 432,480.00 USD into settled cash', cash: { USD: 432_480 }, owner: 'account', date: '2026-03-13' }],
        cash: { account: { USD: { settled: 1_004_670, unsettled: 0, availableToTrade: 1_004_670, availableToWithdraw: 1_004_670 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 7420, commissions: -400, fees: -2350, unrealized: 0, total: 4670 } },
        nav: { account: 1_004_670, book: 2_004_670 },
        balance: { account: { cash: 1_004_670, positions: null, receivable: null, payable: null, assets: 1_004_670, liabilities: 0, netAssets: 1_004_670 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// refined_product
// ---------------------------------------------------------------------------------------------
// Diesel bought by the barrel and priced in US dollars per US gallon, as New York Harbor barges are: the multiplier is the 42
// gallons in a barrel. Barge freight (the delivery leg) and the independent inspection are recorded by hand.
const refinedProduct = {
  productId: 'refined_product',
  title: "Ultra-low sulphur diesel, New York Harbor barge: barrels priced per US gallon (x 42), barge freight and inspection by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["barge freight (delivery cost), recorded by hand (fee)", "independent quantity and quality inspection, recorded by hand (fee)"],
    settlement: "T+2 (Book setting settlement.spot) on the US calendar",
    lifecycle: "Nothing automated; freight and inspection recorded by hand; discharging the barge (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = barrels x 42 x USD per gallon; freight and inspection in fees; realized P&L on sale",
    collateral: "None; no short sale",
  },
  start: '2026-03-10T14:00:00.000Z', // Tuesday 10 March 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix refined product", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "refined_product", name: "Ultra-low sulphur diesel, New York Harbor barge", symbol: "ULSD-NYH", marketView: "US_CASH", venue: "Harborline Petroleum (OTC)", venueType: "otc", venueCountry: "US", issuer: "Harborline Petroleum Corp.", domicile: "US", underlyingGeo: "US", tradingCcy: "USD", multiplier: 42, terms: { quantityUnit: "barrels", priceUnits: "USD per US gallon" } } },
  quotes: { main: { bid: 2.41, ask: 2.415, last: 2.4125, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 5,000 x 2.415 x 42 = 507_150
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 5000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5000, estimate: 2.415, model: 'quoted-bid-ask', settleDate: '2026-03-12', calendar: 'US', cash: -507_150, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5000, avgPrice: 2.415 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 5,000 ULSD-NYH @ 2.415 USD", owner: 'account', date: '2026-03-10' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -507_150, availableToTrade: 492_850, availableToWithdraw: 492_850 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 2.415, cost: 507_150, price: 2.41250000000000008881784197, value: 506_625, unrealized: -525, priceSource: 'Test fixture' }], // value 5,000 x 2.4125 x 42 = 506_625.0000000000186517468137; avgCost 507_150 / (5,000 x 42),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-12', amount: -507_150, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: 0, fees: 0, unrealized: -525, total: -525 } },
        nav: { account: 999_475, book: 1_999_475 },
        balance: { account: { cash: 1_000_000, positions: 506_625, receivable: null, payable: 507_150, assets: 1_506_625, liabilities: 507_150, netAssets: 999_475 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-03-12T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 507,150.00 USD from settled cash', cash: { USD: -507_150 }, owner: 'account', date: '2026-03-12' }],
        cash: { account: { USD: { settled: 492_850, unsettled: 0, availableToTrade: 492_850, availableToWithdraw: 492_850 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 2.415, cost: 507_150, price: 2.41250000000000008881784197, value: 506_625, unrealized: -525, priceSource: 'Test fixture' }], // value 5,000 x 2.4125 x 42 = 506_625.0000000000186517468137; avgCost 507_150 / (5,000 x 42),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: 0, fees: 0, unrealized: -525, total: -525 } },
        nav: { account: 999_475, book: 1_999_475 },
        balance: { account: { cash: 492_850, positions: 506_625, receivable: null, payable: null, assets: 999_475, liabilities: 0, netAssets: 999_475 } },
      },
    },
    {
      id: 'barge-freight', covers: "delivery cost", action: 'cashflow', lot: 'lot', category: 'fee', amount: -6250, note: "Barge freight, Linden to Port Reading (delivery cost)",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on ULSD-NYH: paid 6,250.00 USD. Barge freight, Linden to Port Reading (delivery cost)", cash: { USD: -6250 }, owner: 'account' }],
        cash: { account: { USD: { settled: 486_600, unsettled: 0, availableToTrade: 486_600, availableToWithdraw: 486_600 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 2.415, cost: 507_150, price: 2.41250000000000008881784197, value: 506_625, unrealized: -525, priceSource: 'Test fixture' }], // value 5,000 x 2.4125 x 42 = 506_625.0000000000186517468137; avgCost 507_150 / (5,000 x 42),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: 0, fees: -6250, unrealized: -525, total: -6775 } },
        nav: { account: 993_225, book: 1_993_225 },
        balance: { account: { cash: 486_600, positions: 506_625, receivable: null, payable: null, assets: 993_225, liabilities: 0, netAssets: 993_225 } },
      },
    },
    {
      id: 'inspection', covers: "inspection", action: 'cashflow', lot: 'lot', category: 'fee', amount: -850, note: "Independent inspection of quantity and quality",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on ULSD-NYH: paid 850.00 USD. Independent inspection of quantity and quality", cash: { USD: -850 }, owner: 'account' }],
        cash: { account: { USD: { settled: 485_750, unsettled: 0, availableToTrade: 485_750, availableToWithdraw: 485_750 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 2.415, cost: 507_150, price: 2.41250000000000008881784197, value: 506_625, unrealized: -525, priceSource: 'Test fixture' }], // value 5,000 x 2.4125 x 42 = 506_625.0000000000186517468137; avgCost 507_150 / (5,000 x 42),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: 0, fees: -7100, unrealized: -525, total: -7625 } },
        nav: { account: 992_375, book: 1_992_375 },
        balance: { account: { cash: 485_750, positions: 506_625, receivable: null, payable: null, assets: 992_375, liabilities: 0, netAssets: 992_375 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 2.46, ask: 2.465, last: 2.4625, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 485_750, unsettled: 0, availableToTrade: 485_750, availableToWithdraw: 485_750 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 2.415, cost: 507_150, price: 2.46249999999999991118215803, value: 517_125, unrealized: 9975, priceSource: 'Test fixture' }], // value 5,000 x 2.4625 x 42 = 517_124.9999999999813482531863; avgCost 507_150 / (5,000 x 42),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: 0, fees: -7100, unrealized: 9975, total: 2875 } },
        nav: { account: 1_002_875, book: 2_002_875 },
        balance: { account: { cash: 485_750, positions: 517_125, receivable: null, payable: null, assets: 1_002_875, liabilities: 0, netAssets: 1_002_875 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Discharging the barge into the buyer tank is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 2,000 x 2.46 x 42 = 206_640; realized 206_640 - cost out 202_860 = 3780
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 2000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2000, estimate: 2.46, model: 'quoted-bid-ask', settleDate: '2026-03-16', calendar: 'US', cash: 206_640, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2000, avgPrice: 2.46 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 2,000 ULSD-NYH @ 2.46 USD (realized 3,780.00 USD)", owner: 'account', date: '2026-03-12' }],
        cash: { account: { USD: { settled: 485_750, unsettled: 206_640, availableToTrade: 692_390, availableToWithdraw: 485_750 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 3000, avgCost: 2.415, cost: 304_290, price: 2.46249999999999991118215803, value: 310_275, unrealized: 5985, priceSource: 'Test fixture' }], // value 3,000 x 2.4625 x 42 = 310_274.9999999999888089519118; avgCost 304_290 / (3,000 x 42),
        holdings: { main: { long: 3000, short: 0, net: 3000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-16', amount: 206_640, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 3780, commissions: 0, fees: -7100, unrealized: 5985, total: 2665 } },
        nav: { account: 1_002_665, book: 2_002_665 },
        balance: { account: { cash: 485_750, positions: 310_275, receivable: 206_640, payable: null, assets: 1_002_665, liabilities: 0, netAssets: 1_002_665 } },
      },
    },
    // 3,000 x 2.46 x 42 = 309_960; realized 309_960 - cost out 304_290 = 5670
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 3000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3000, estimate: 2.46, model: 'quoted-bid-ask', settleDate: '2026-03-16', calendar: 'US', cash: 309_960, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 3000, avgPrice: 2.46 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 3,000 ULSD-NYH @ 2.46 USD (realized 5,670.00 USD)", owner: 'account', date: '2026-03-12' }],
        cash: { account: { USD: { settled: 485_750, unsettled: 516_600, availableToTrade: 1_002_350, availableToWithdraw: 485_750 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-16', amount: 206_640, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-16', amount: 309_960, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 9450, commissions: 0, fees: -7100, unrealized: 0, total: 2350 } },
        nav: { account: 1_002_350, book: 2_002_350 },
        balance: { account: { cash: 485_750, positions: null, receivable: 516_600, payable: null, assets: 1_002_350, liabilities: 0, netAssets: 1_002_350 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-03-16T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 206,640.00 USD into settled cash', cash: { USD: 206_640 }, owner: 'account', date: '2026-03-16' }, { type: 'settlement.receive', summary: 'received 309,960.00 USD into settled cash', cash: { USD: 309_960 }, owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: { settled: 1_002_350, unsettled: 0, availableToTrade: 1_002_350, availableToWithdraw: 1_002_350 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 9450, commissions: 0, fees: -7100, unrealized: 0, total: 2350 } },
        nav: { account: 1_002_350, book: 2_002_350 },
        balance: { account: { cash: 1_002_350, positions: null, receivable: null, payable: null, assets: 1_002_350, liabilities: 0, netAssets: 1_002_350 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// natural_gas
// ---------------------------------------------------------------------------------------------
// Treasury buys gas at Henry Hub for storage, in MMBtu and US dollars per MMBtu, settling the next business day (the instrument
// settlement lag 1), with a broker fee of 0.005 per MMBtu. The storage injection and withdrawal fees are recorded by hand.
const naturalGas = {
  productId: 'natural_gas',
  title: "Natural gas at Henry Hub, held by Treasury in storage: MMBtu, next-day settlement, injection and withdrawal fees by hand",
  matrix: {
    ...SPOT_TICKET,
    requiredFields: ["Account (trading owner: Treasury)", "Action", "MMBtu"],
    manualInputs: ["storage injection fee, recorded by hand (fee)", "storage withdrawal fee, recorded by hand (fee)"],
    settlement: "T+1 (the instrument's settlement lag) on the US calendar",
    lifecycle: "Nothing automated; storage fees recorded by hand; nominating the gas out of storage (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = MMBtu x USD per MMBtu; broker fee 0.005 per MMBtu expensed; storage fees in fees; realized P&L on sale; owned by Treasury",
    collateral: "None; no short sale",
  },
  start: '2026-03-11T14:00:00.000Z', // Wednesday 11 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: [] },
  book: { name: "Matrix natural gas", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0.005, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "natural_gas", name: "Natural gas, Henry Hub, Erath, Louisiana", symbol: "NG-HH", marketView: "US_CASH", venue: "Bayou Gas Marketing (OTC)", venueType: "otc", venueCountry: "US", issuer: "Bayou Gas Marketing LLC", domicile: "US", underlyingGeo: "US", tradingCcy: "USD", terms: { settleDays: 1, quantityUnit: "MMBtu", priceUnits: "USD per MMBtu" } } },
  quotes: { main: { bid: 3.12, ask: 3.125, last: 3.1225, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { treasury: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, account: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { treasury: 1000000, account: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 100,000 x 3.125 x 1 = 312_500; fee 500
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 100_000, as: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 100_000, estimate: 3.125, model: 'quoted-bid-ask', settleDate: '2026-03-12', calendar: 'US', cash: -312_500, fees: 500 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 100_000, avgPrice: 3.125 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 100,000 NG-HH @ 3.125 USD", owner: 'treasury', date: '2026-03-11' }],
        cash: { treasury: { USD: { settled: 1_000_000, unsettled: -313_000, availableToTrade: 687_000, availableToWithdraw: 687_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 100_000, avgCost: 3.125, cost: 312_500, price: 3.122500000000000053290705182, value: 312_250, unrealized: -250, priceSource: 'Test fixture' }], // value 100,000 x 3.1225 x 1 = 312_250.0000000000053290705182; avgCost 312_500 / (100,000 x 1),
        holdings: { main: { long: 100_000, short: 0, net: 100_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-03-12', amount: -313_000, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 0, commissions: -500, fees: 0, unrealized: -250, total: -750 } },
        nav: { treasury: 999_250, book: 1_999_250 },
        balance: { treasury: { cash: 1_000_000, positions: 312_250, receivable: null, payable: 313_000, assets: 1_312_250, liabilities: 313_000, netAssets: 999_250 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, owner: 'treasury', borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-03-12T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 313,000.00 USD from settled cash', cash: { USD: -313_000 }, owner: 'treasury', date: '2026-03-12' }],
        cash: { treasury: { USD: { settled: 687_000, unsettled: 0, availableToTrade: 687_000, availableToWithdraw: 687_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 100_000, avgCost: 3.125, cost: 312_500, price: 3.122500000000000053290705182, value: 312_250, unrealized: -250, priceSource: 'Test fixture' }], // value 100,000 x 3.1225 x 1 = 312_250.0000000000053290705182; avgCost 312_500 / (100,000 x 1),
        holdings: { main: { long: 100_000, short: 0, net: 100_000 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: -500, fees: 0, unrealized: -250, total: -750 } },
        nav: { treasury: 999_250, book: 1_999_250 },
        balance: { treasury: { cash: 687_000, positions: 312_250, receivable: null, payable: null, assets: 999_250, liabilities: 0, netAssets: 999_250 } },
      },
    },
    {
      id: 'storage-injection', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -2500, note: "Storage injection fee, Bayou salt cavern",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on NG-HH: paid 2,500.00 USD. Storage injection fee, Bayou salt cavern", cash: { USD: -2500 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 684_500, unsettled: 0, availableToTrade: 684_500, availableToWithdraw: 684_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 100_000, avgCost: 3.125, cost: 312_500, price: 3.122500000000000053290705182, value: 312_250, unrealized: -250, priceSource: 'Test fixture' }], // value 100,000 x 3.1225 x 1 = 312_250.0000000000053290705182; avgCost 312_500 / (100,000 x 1),
        holdings: { main: { long: 100_000, short: 0, net: 100_000 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: -500, fees: -2500, unrealized: -250, total: -3250 } },
        nav: { treasury: 996_750, book: 1_996_750 },
        balance: { treasury: { cash: 684_500, positions: 312_250, receivable: null, payable: null, assets: 996_750, liabilities: 0, netAssets: 996_750 } },
      },
    },
    {
      id: 'storage-withdrawal', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -2000, note: "Storage withdrawal fee, Bayou salt cavern",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on NG-HH: paid 2,000.00 USD. Storage withdrawal fee, Bayou salt cavern", cash: { USD: -2000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 682_500, unsettled: 0, availableToTrade: 682_500, availableToWithdraw: 682_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 100_000, avgCost: 3.125, cost: 312_500, price: 3.122500000000000053290705182, value: 312_250, unrealized: -250, priceSource: 'Test fixture' }], // value 100,000 x 3.1225 x 1 = 312_250.0000000000053290705182; avgCost 312_500 / (100,000 x 1),
        holdings: { main: { long: 100_000, short: 0, net: 100_000 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: -500, fees: -4500, unrealized: -250, total: -5250 } },
        nav: { treasury: 994_750, book: 1_994_750 },
        balance: { treasury: { cash: 682_500, positions: 312_250, receivable: null, payable: null, assets: 994_750, liabilities: 0, netAssets: 994_750 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 3.3, ask: 3.305, last: 3.3025, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { treasury: { USD: { settled: 682_500, unsettled: 0, availableToTrade: 682_500, availableToWithdraw: 682_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 100_000, avgCost: 3.125, cost: 312_500, price: 3.302500000000000213162820728, value: 330_250, unrealized: 17_750, priceSource: 'Test fixture' }], // value 100,000 x 3.3025 x 1 = 330_250.0000000000213162820728; avgCost 312_500 / (100,000 x 1),
        holdings: { main: { long: 100_000, short: 0, net: 100_000 } },
        pending: [],
        pnl: { treasury: { realized: 0, commissions: -500, fees: -4500, unrealized: 17_750, total: 12_750 } },
        nav: { treasury: 1_012_750, book: 2_012_750 },
        balance: { treasury: { cash: 682_500, positions: 330_250, receivable: null, payable: null, assets: 1_012_750, liabilities: 0, netAssets: 1_012_750 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Nominating the gas out of storage to a pipeline is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 40,000 x 3.30 x 1 = 132_000; fee 200; realized 132_000 - cost out 125_000 = 7000
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 40_000, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 40_000, estimate: 3.3, model: 'quoted-bid-ask', settleDate: '2026-03-13', calendar: 'US', cash: 132_000, fees: 200 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 40_000, avgPrice: 3.3 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 40,000 NG-HH @ 3.30 USD (realized 7,000.00 USD)", owner: 'treasury', date: '2026-03-12' }],
        cash: { treasury: { USD: { settled: 682_500, unsettled: 131_800, availableToTrade: 814_300, availableToWithdraw: 682_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'treasury', direction: 'long', qty: 60_000, avgCost: 3.125, cost: 187_500, price: 3.302500000000000213162820728, value: 198_150, unrealized: 10_650, priceSource: 'Test fixture' }], // value 60,000 x 3.3025 x 1 = 198_150.0000000000127897692437; avgCost 187_500 / (60,000 x 1),
        holdings: { main: { long: 60_000, short: 0, net: 60_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-03-13', amount: 131_800, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 7000, commissions: -700, fees: -4500, unrealized: 10_650, total: 12_450 } },
        nav: { treasury: 1_012_450, book: 2_012_450 },
        balance: { treasury: { cash: 682_500, positions: 198_150, receivable: 131_800, payable: null, assets: 1_012_450, liabilities: 0, netAssets: 1_012_450 } },
      },
    },
    // 60,000 x 3.30 x 1 = 198_000; fee 300; realized 198_000 - cost out 187_500 = 10_500
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 60_000, from: 'lot', owner: 'treasury',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 60_000, estimate: 3.3, model: 'quoted-bid-ask', settleDate: '2026-03-13', calendar: 'US', cash: 198_000, fees: 300 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 60_000, avgPrice: 3.3 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 60,000 NG-HH @ 3.30 USD (realized 10,500.00 USD)", owner: 'treasury', date: '2026-03-12' }],
        cash: { treasury: { USD: { settled: 682_500, unsettled: 329_500, availableToTrade: 1_012_000, availableToWithdraw: 682_500 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-03-13', amount: 131_800, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'treasury', dueDate: '2026-03-13', amount: 197_700, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 17_500, commissions: -1000, fees: -4500, unrealized: 0, total: 12_000 } },
        nav: { treasury: 1_012_000, book: 2_012_000 },
        balance: { treasury: { cash: 682_500, positions: null, receivable: 329_500, payable: null, assets: 1_012_000, liabilities: 0, netAssets: 1_012_000 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-03-13T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 131,800.00 USD into settled cash', cash: { USD: 131_800 }, owner: 'treasury', date: '2026-03-13' }, { type: 'settlement.receive', summary: 'received 197,700.00 USD into settled cash', cash: { USD: 197_700 }, owner: 'treasury', date: '2026-03-13' }],
        cash: { treasury: { USD: { settled: 1_012_000, unsettled: 0, availableToTrade: 1_012_000, availableToWithdraw: 1_012_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { treasury: { realized: 17_500, commissions: -1000, fees: -4500, unrealized: 0, total: 12_000 } },
        nav: { treasury: 1_012_000, book: 2_012_000 },
        balance: { treasury: { cash: 1_012_000, positions: null, receivable: null, payable: null, assets: 1_012_000, liabilities: 0, netAssets: 1_012_000 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// lng
// ---------------------------------------------------------------------------------------------
// A share of an LNG cargo delivered ex-ship at Futtsu, Japan, held in tonnes of LNG and priced in US dollars per MMBtu (JKM-linked).
// The cargo's quality certificate gives 51.8 MMBtu per tonne, entered as the multiplier. Bought Thursday 16 July, it settles T+2 on
// the Tokyo calendar over Marine Day (Monday 20 July). Port and terminal charges are recorded by hand, and so is the boil-off
// lost on the voyage (25 tonnes, a sale at 0.00). The rest is sold in two parts.
const lng = {
  productId: 'lng',
  title: "LNG cargo share delivered ex-ship in Japan: tonnes priced per MMBtu (x 51.8 from the cargo's quality certificate), boil-off and port charges by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["heat content (51.8 MMBtu per tonne) from the cargo quality certificate, entered as the multiplier", "port and regasification terminal charges (cargo logistics), recorded by hand (fee)", "boil-off lost on the voyage, recorded by hand as a sale at a stated fill price of 0.00"],
    settlement: "T+2 (Book setting settlement.foreignCash) on the Tokyo calendar, over Marine Day",
    lifecycle: "Nothing automated; cargo logistics and boil-off recorded by hand; discharge to the terminal (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = tonnes x 51.8 MMBtu per tonne x USD per MMBtu; port charges in fees; boil-off realizes its cost as a loss; realized P&L on sale",
    collateral: "None; no short sale",
  },
  start: '2026-07-16T14:00:00.000Z', // Thursday 16 July 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: ["2026-07-20"] },
  book: { name: "Matrix LNG", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 8_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 4_000_000 }] }, settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "lng", name: "LNG cargo share, delivered ex-ship Futtsu, Japan (JKM-linked)", symbol: "LNG-FUT", marketView: "FOREIGN_CASH", venue: "Pacific LNG Trading (OTC)", venueType: "otc", venueCountry: "JP", issuer: "Pacific LNG Trading KK", domicile: "JP", underlyingGeo: "Japan", tradingCcy: "USD", multiplier: 51.8, terms: { quantityUnit: "tonnes of LNG", priceUnits: "USD per MMBtu" } } },
  quotes: { main: { bid: 11.95, ask: 12.05, last: 12, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 4000000, unsettled: 0, availableToTrade: 4000000 } }, treasury: { USD: { settled: 4000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 4000000, treasury: 4000000, book: 8000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 5,000 x 12.05 x 51.8 = 3_120_950
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 5000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5000, estimate: 12.05, model: 'quoted-bid-ask', settleDate: '2026-07-21', calendar: 'JP', cash: -3_120_950, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5000, avgPrice: 12.05 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 5,000 LNG-FUT @ 12.05 USD", owner: 'account', date: '2026-07-16' }],
        cash: { account: { USD: { settled: 4_000_000, unsettled: -3_120_950, availableToTrade: 879_050, availableToWithdraw: 879_050 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 12.05, cost: 3_120_950, price: 12, value: 3_108_000, unrealized: -12_950, priceSource: 'Test fixture' }], // value 5,000 x 12.0 x 51.8 = 3_108_000; avgCost 3_120_950 / (5,000 x 51.8),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-07-21', amount: -3_120_950, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: 0, fees: 0, unrealized: -12_950, total: -12_950 } },
        nav: { account: 3_987_050, book: 7_987_050 },
        balance: { account: { cash: 4_000_000, positions: 3_108_000, receivable: null, payable: 3_120_950, assets: 7_108_000, liabilities: 3_120_950, netAssets: 3_987_050 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'friday', action: 'clock', to: '2026-07-17T14:00:00.000Z',
      expect: {
      },
    },
    {
      id: 'marine-day', action: 'clock', to: '2026-07-20T14:00:00.000Z',
      expect: {
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-07-21T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 3,120,950.00 USD from settled cash', cash: { USD: -3_120_950 }, owner: 'account', date: '2026-07-21' }],
        cash: { account: { USD: { settled: 879_050, unsettled: 0, availableToTrade: 879_050, availableToWithdraw: 879_050 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 12.05, cost: 3_120_950, price: 12, value: 3_108_000, unrealized: -12_950, priceSource: 'Test fixture' }], // value 5,000 x 12.0 x 51.8 = 3_108_000; avgCost 3_120_950 / (5,000 x 51.8),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: 0, fees: 0, unrealized: -12_950, total: -12_950 } },
        nav: { account: 3_987_050, book: 7_987_050 },
        balance: { account: { cash: 879_050, positions: 3_108_000, receivable: null, payable: null, assets: 3_987_050, liabilities: 0, netAssets: 3_987_050 } },
      },
    },
    {
      id: 'port-charges', covers: "cargo logistics", action: 'cashflow', lot: 'lot', category: 'fee', amount: -42_000, note: "Port and regasification terminal charges at Futtsu (cargo logistics)",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on LNG-FUT: paid 42,000.00 USD. Port and regasification terminal charges at Futtsu (cargo logistics)", cash: { USD: -42_000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 837_050, unsettled: 0, availableToTrade: 837_050, availableToWithdraw: 837_050 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 12.05, cost: 3_120_950, price: 12, value: 3_108_000, unrealized: -12_950, priceSource: 'Test fixture' }], // value 5,000 x 12.0 x 51.8 = 3_108_000; avgCost 3_120_950 / (5,000 x 51.8),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: 0, fees: -42_000, unrealized: -12_950, total: -54_950 } },
        nav: { account: 3_945_050, book: 7_945_050 },
        balance: { account: { cash: 837_050, positions: 3_108_000, receivable: null, payable: null, assets: 3_945_050, liabilities: 0, netAssets: 3_945_050 } },
      },
    },
    // Boil-off on the voyage, 25 t, recorded by hand as a sale at 0.00. 25 x 0.00 x 51.8 = 0; realized 0 - cost out 15_604.75 = -15_604.75
    {
      id: 'boil-off-by-hand', covers: "boil-off", action: 'ticket', instrument: 'main', side: 'sell', qty: 25, from: 'lot', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 25, estimate: 0, model: 'stated-price', settleDate: '2026-07-23', calendar: 'JP', cash: 0, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 25, avgPrice: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 25 LNG-FUT @ 0.00 USD (realized -15,604.75 USD)", owner: 'account', date: '2026-07-21' }],
        cash: { account: { USD: { settled: 837_050, unsettled: 0, availableToTrade: 837_050, availableToWithdraw: 837_050 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 4975, avgCost: 12.05, cost: 3_105_345.25, price: 12, value: 3_092_460, unrealized: -12_885.25, priceSource: 'Test fixture' }], // value 4,975 x 12.0 x 51.8 = 3_092_460; avgCost 3_105_345.25 / (4,975 x 51.8),
        holdings: { main: { long: 4975, short: 0, net: 4975 } },
        pending: [],
        pnl: { account: { realized: -15_604.75, commissions: 0, fees: -42_000, unrealized: -12_885.25, total: -70_490 } },
        nav: { account: 3_929_510, book: 7_929_510 },
        balance: { account: { cash: 837_050, positions: 3_092_460, receivable: null, payable: null, assets: 3_929_510, liabilities: 0, netAssets: 3_929_510 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 12.4, ask: 12.5, last: 12.45, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 837_050, unsettled: 0, availableToTrade: 837_050, availableToWithdraw: 837_050 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 4975, avgCost: 12.05, cost: 3_105_345.25, price: 12.44999999999999928945726424, value: 3_208_427.25, unrealized: 103_082, priceSource: 'Test fixture' }], // value 4,975 x 12.45 x 51.8 = 3_208_427.249999999816889584281; avgCost 3_105_345.25 / (4,975 x 51.8),
        holdings: { main: { long: 4975, short: 0, net: 4975 } },
        pending: [],
        pnl: { account: { realized: -15_604.75, commissions: 0, fees: -42_000, unrealized: 103_082, total: 45_477.25 } },
        nav: { account: 4_045_477.25, book: 8_045_477.25 },
        balance: { account: { cash: 837_050, positions: 3_208_427.25, receivable: null, payable: null, assets: 4_045_477.25, liabilities: 0, netAssets: 4_045_477.25 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Discharging the cargo to the terminal is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 2,000 x 12.40 x 51.8 = 1_284_640; realized 1_284_640 - cost out 1_248_380 = 36_260
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 2000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2000, estimate: 12.4, model: 'quoted-bid-ask', settleDate: '2026-07-23', calendar: 'JP', cash: 1_284_640, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2000, avgPrice: 12.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 2,000 LNG-FUT @ 12.40 USD (realized 36,260.00 USD)", owner: 'account', date: '2026-07-21' }],
        cash: { account: { USD: { settled: 837_050, unsettled: 1_284_640, availableToTrade: 2_121_690, availableToWithdraw: 837_050 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 2975, avgCost: 12.05, cost: 1_856_965.25, price: 12.44999999999999928945726424, value: 1_918_607.25, unrealized: 61_642, priceSource: 'Test fixture' }], // value 2,975 x 12.45 x 51.8 = 1_918_607.249999999890501811705; avgCost 1_856_965.25 / (2,975 x 51.8),
        holdings: { main: { long: 2975, short: 0, net: 2975 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-07-23', amount: 1_284_640, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 20_655.25, commissions: 0, fees: -42_000, unrealized: 61_642, total: 40_297.25 } },
        nav: { account: 4_040_297.25, book: 8_040_297.25 },
        balance: { account: { cash: 837_050, positions: 1_918_607.25, receivable: 1_284_640, payable: null, assets: 4_040_297.25, liabilities: 0, netAssets: 4_040_297.25 } },
      },
    },
    // 2,975 x 12.40 x 51.8 = 1_910_902; realized 1_910_902 - cost out 1_856_965.25 = 53_936.75
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 2975, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2975, estimate: 12.4, model: 'quoted-bid-ask', settleDate: '2026-07-23', calendar: 'JP', cash: 1_910_902, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2975, avgPrice: 12.4 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 2,975 LNG-FUT @ 12.40 USD (realized 53,936.75 USD)", owner: 'account', date: '2026-07-21' }],
        cash: { account: { USD: { settled: 837_050, unsettled: 3_195_542, availableToTrade: 4_032_592, availableToWithdraw: 837_050 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-07-23', amount: 1_284_640, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-07-23', amount: 1_910_902, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 74_592, commissions: 0, fees: -42_000, unrealized: 0, total: 32_592 } },
        nav: { account: 4_032_592, book: 8_032_592 },
        balance: { account: { cash: 837_050, positions: null, receivable: 3_195_542, payable: null, assets: 4_032_592, liabilities: 0, netAssets: 4_032_592 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-07-23T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,284,640.00 USD into settled cash', cash: { USD: 1_284_640 }, owner: 'account', date: '2026-07-23' }, { type: 'settlement.receive', summary: 'received 1,910,902.00 USD into settled cash', cash: { USD: 1_910_902 }, owner: 'account', date: '2026-07-23' }],
        cash: { account: { USD: { settled: 4_032_592, unsettled: 0, availableToTrade: 4_032_592, availableToWithdraw: 4_032_592 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 74_592, commissions: 0, fees: -42_000, unrealized: 0, total: 32_592 } },
        nav: { account: 4_032_592, book: 8_032_592 },
        balance: { account: { cash: 4_032_592, positions: null, receivable: null, payable: null, assets: 4_032_592, liabilities: 0, netAssets: 4_032_592 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// coal
// ---------------------------------------------------------------------------------------------
// Steam coal of 6,000 kcal/kg NAR in a Rotterdam stockpile, in tonnes and US dollars per tonne, with a broker fee of 0.10 per tonne,
// settled T+2 on TARGET2 days. The delivered calorific value was below specification: the price adjustment is recorded by hand,
// as is stockpile storage.
const coal = {
  productId: 'coal',
  title: "Steam coal CIF ARA in a Rotterdam stockpile: tonnes, calorific-value adjustment and stockpile storage by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["calorific-value (quality) adjustment, recorded by hand (realized)", "stockpile storage, recorded by hand (fee)"],
    settlement: "T+2 (Book setting settlement.foreignCash) on the TARGET2 calendar of the Rotterdam venue",
    lifecycle: "Nothing automated; quality adjustment and storage recorded by hand; loading the coal out (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = tonnes x USD per tonne; broker fee 0.10 per tonne expensed; storage in fees; quality adjustment in realized P&L",
    collateral: "None; no short sale",
  },
  start: '2026-03-12T14:00:00.000Z', // Thursday 12 March 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix coal", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0.1, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "coal", name: "Steam coal, 6,000 kcal/kg NAR, CIF ARA (Rotterdam stockpile)", symbol: "COAL-ARA", marketView: "FOREIGN_CASH", venue: "Rhine Bulk Commodities (OTC)", venueType: "otc", venueCountry: "NL", issuer: "Rhine Bulk Commodities BV", domicile: "NL", underlyingGeo: "Northwest Europe", tradingCcy: "USD", terms: { quantityUnit: "tonnes", priceUnits: "USD per tonne" } } },
  quotes: { main: { bid: 110.25, ask: 110.5, last: 110.4, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 5,000 x 110.50 x 1 = 552_500; fee 500
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 5000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5000, estimate: 110.5, model: 'quoted-bid-ask', settleDate: '2026-03-16', calendar: 'TARGET', cash: -552_500, fees: 500 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5000, avgPrice: 110.5 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 5,000 COAL-ARA @ 110.50 USD", owner: 'account', date: '2026-03-12' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -553_000, availableToTrade: 447_000, availableToWithdraw: 447_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 110.5, cost: 552_500, price: 110.4000000000000056843418861, value: 552_000, unrealized: -500, priceSource: 'Test fixture' }], // value 5,000 x 110.4 x 1 = 552_000.0000000000284217094304; avgCost 552_500 / (5,000 x 1),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-16', amount: -553_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -500, fees: 0, unrealized: -500, total: -1000 } },
        nav: { account: 999_000, book: 1_999_000 },
        balance: { account: { cash: 1_000_000, positions: 552_000, receivable: null, payable: 553_000, assets: 1_552_000, liabilities: 553_000, netAssets: 999_000 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'friday', action: 'clock', to: '2026-03-13T14:00:00.000Z',
      expect: {
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-03-16T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 553,000.00 USD from settled cash', cash: { USD: -553_000 }, owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: { settled: 447_000, unsettled: 0, availableToTrade: 447_000, availableToWithdraw: 447_000 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 110.5, cost: 552_500, price: 110.4000000000000056843418861, value: 552_000, unrealized: -500, priceSource: 'Test fixture' }], // value 5,000 x 110.4 x 1 = 552_000.0000000000284217094304; avgCost 552_500 / (5,000 x 1),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -500, fees: 0, unrealized: -500, total: -1000 } },
        nav: { account: 999_000, book: 1_999_000 },
        balance: { account: { cash: 447_000, positions: 552_000, receivable: null, payable: null, assets: 999_000, liabilities: 0, netAssets: 999_000 } },
      },
    },
    {
      id: 'calorific-value-adjustment', covers: "quality adjustment", action: 'cashflow', lot: 'lot', category: 'realized', amount: -1375, note: "Quality adjustment: 5,890 kcal/kg NAR delivered against 6,000 specified",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual realized on COAL-ARA: paid 1,375.00 USD. Quality adjustment: 5,890 kcal/kg NAR delivered against 6,000 specified", cash: { USD: -1375 }, owner: 'account' }],
        cash: { account: { USD: { settled: 445_625, unsettled: 0, availableToTrade: 445_625, availableToWithdraw: 445_625 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 110.5, cost: 552_500, price: 110.4000000000000056843418861, value: 552_000, unrealized: -500, priceSource: 'Test fixture' }], // value 5,000 x 110.4 x 1 = 552_000.0000000000284217094304; avgCost 552_500 / (5,000 x 1),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: -1375, commissions: -500, fees: 0, unrealized: -500, total: -2375 } },
        nav: { account: 997_625, book: 1_997_625 },
        balance: { account: { cash: 445_625, positions: 552_000, receivable: null, payable: null, assets: 997_625, liabilities: 0, netAssets: 997_625 } },
      },
    },
    {
      id: 'stockpile-storage', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -2000, note: "Stockpile storage at Rotterdam for March",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on COAL-ARA: paid 2,000.00 USD. Stockpile storage at Rotterdam for March", cash: { USD: -2000 }, owner: 'account' }],
        cash: { account: { USD: { settled: 443_625, unsettled: 0, availableToTrade: 443_625, availableToWithdraw: 443_625 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 110.5, cost: 552_500, price: 110.4000000000000056843418861, value: 552_000, unrealized: -500, priceSource: 'Test fixture' }], // value 5,000 x 110.4 x 1 = 552_000.0000000000284217094304; avgCost 552_500 / (5,000 x 1),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: -1375, commissions: -500, fees: -2000, unrealized: -500, total: -4375 } },
        nav: { account: 995_625, book: 1_995_625 },
        balance: { account: { cash: 443_625, positions: 552_000, receivable: null, payable: null, assets: 995_625, liabilities: 0, netAssets: 995_625 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 112, ask: 112.25, last: 112.1, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 443_625, unsettled: 0, availableToTrade: 443_625, availableToWithdraw: 443_625 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 5000, avgCost: 110.5, cost: 552_500, price: 112.0999999999999943156581139, value: 560_500, unrealized: 8000, priceSource: 'Test fixture' }], // value 5,000 x 112.1 x 1 = 560_499.9999999999715782905696; avgCost 552_500 / (5,000 x 1),
        holdings: { main: { long: 5000, short: 0, net: 5000 } },
        pending: [],
        pnl: { account: { realized: -1375, commissions: -500, fees: -2000, unrealized: 8000, total: 4125 } },
        nav: { account: 1_004_125, book: 2_004_125 },
        balance: { account: { cash: 443_625, positions: 560_500, receivable: null, payable: null, assets: 1_004_125, liabilities: 0, netAssets: 1_004_125 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Loading the coal out of the stockpile is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 2,000 x 112.00 x 1 = 224_000; fee 200; realized 224_000 - cost out 221_000 = 3000
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 2000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 2000, estimate: 112, model: 'quoted-bid-ask', settleDate: '2026-03-18', calendar: 'TARGET', cash: 224_000, fees: 200 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 2000, avgPrice: 112 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 2,000 COAL-ARA @ 112.00 USD (realized 3,000.00 USD)", owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: { settled: 443_625, unsettled: 223_800, availableToTrade: 667_425, availableToWithdraw: 443_625 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 3000, avgCost: 110.5, cost: 331_500, price: 112.0999999999999943156581139, value: 336_300, unrealized: 4800, priceSource: 'Test fixture' }], // value 3,000 x 112.1 x 1 = 336_299.9999999999829469743418; avgCost 331_500 / (3,000 x 1),
        holdings: { main: { long: 3000, short: 0, net: 3000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-18', amount: 223_800, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 1625, commissions: -700, fees: -2000, unrealized: 4800, total: 3725 } },
        nav: { account: 1_003_725, book: 2_003_725 },
        balance: { account: { cash: 443_625, positions: 336_300, receivable: 223_800, payable: null, assets: 1_003_725, liabilities: 0, netAssets: 1_003_725 } },
      },
    },
    // 3,000 x 112.00 x 1 = 336_000; fee 300; realized 336_000 - cost out 331_500 = 4500
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 3000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 3000, estimate: 112, model: 'quoted-bid-ask', settleDate: '2026-03-18', calendar: 'TARGET', cash: 336_000, fees: 300 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 3000, avgPrice: 112 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 3,000 COAL-ARA @ 112.00 USD (realized 4,500.00 USD)", owner: 'account', date: '2026-03-16' }],
        cash: { account: { USD: { settled: 443_625, unsettled: 559_500, availableToTrade: 1_003_125, availableToWithdraw: 443_625 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-18', amount: 223_800, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-18', amount: 335_700, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 6125, commissions: -1000, fees: -2000, unrealized: 0, total: 3125 } },
        nav: { account: 1_003_125, book: 2_003_125 },
        balance: { account: { cash: 443_625, positions: null, receivable: 559_500, payable: null, assets: 1_003_125, liabilities: 0, netAssets: 1_003_125 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-03-18T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 223,800.00 USD into settled cash', cash: { USD: 223_800 }, owner: 'account', date: '2026-03-18' }, { type: 'settlement.receive', summary: 'received 335,700.00 USD into settled cash', cash: { USD: 335_700 }, owner: 'account', date: '2026-03-18' }],
        cash: { account: { USD: { settled: 1_003_125, unsettled: 0, availableToTrade: 1_003_125, availableToWithdraw: 1_003_125 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 6125, commissions: -1000, fees: -2000, unrealized: 0, total: 3125 } },
        nav: { account: 1_003_125, book: 2_003_125 },
        balance: { account: { cash: 1_003_125, positions: null, receivable: null, payable: null, assets: 1_003_125, liabilities: 0, netAssets: 1_003_125 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// electricity
// ---------------------------------------------------------------------------------------------
// 20 MW of German baseload power for one delivery day (20 MW x 24 h = 480 MWh), bought in the day-ahead auction on the Thursday in
// euros per MWh, in a USD-reporting Book (EUR/USD 1.10). Power cannot be stored: 120 MWh is sold back intraday, and after the delivery
// day the imbalance charge and the delivery of the remaining 360 MWh to the offtaker at the agreed 96.50 are recorded by hand. Exchange
// fee 0.05 per MWh; settlement T+1 (the instrument's lag) on TARGET2 days.
const electricity = {
  productId: 'electricity',
  title: "German baseload power for Friday 20 March 2026 on the EPEX SPOT day-ahead auction, in EUR: intraday sale, delivery period recorded by hand",
  matrix: {
    ...SPOT_TICKET,
    requiredFields: ["Account (trading owner)", "Action", "MWh"],
    manualInputs: ["delivery of the energy to the offtaker after the delivery period, recorded by hand as a sale at the agreed price (State a fill price)", "imbalance charge for the delivery day, recorded by hand (fee)"],
    settlement: "T+1 (the instrument's settlement lag) on the TARGET2 calendar of the venue",
    lifecycle: "Nothing automated: the Terminal does not end the position at the end of the delivery period (power cannot be stored, but nothing enforces it); the delivery and the imbalance are recorded by hand; physical delivery itself is not simulated (refused, visibly)",
    accounting: "Value = MWh x EUR per MWh, reported at EUR/USD 1.10; exchange fee 0.05 per MWh expensed; imbalance in fees; realized P&L on the intraday sale and on the delivery to the offtaker",
    collateral: "None; no short sale",
  },
  start: '2026-03-19T14:00:00.000Z', // Thursday 19 March 2026, 10:00 New York
  settlementCheck: { lag: 1, holidays: [] },
  book: { name: "Matrix electricity", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 1_000_000 }, { ccy: "EUR", amount: 200_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 500_000 }, { ccy: "EUR", amount: 200_000 }] }, settings: { fees: { spot: { perUnit: 0.05, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  fx: { EUR/USD: 1.1 },
  instruments: { main: { productId: "electricity", name: "German power, baseload, delivery Friday 20 March 2026 (day-ahead)", symbol: "DE-BASE-0320", marketView: "FOREIGN_CASH", venue: "EPEX SPOT day-ahead auction", venueType: "exchange", venueCountry: "FR", issuer: "EPEX SPOT SE", underlyingGeo: "Germany", tradingCcy: "EUR", terms: { settleDays: 1, quantityUnit: "MWh", priceUnits: "EUR per MWh" } } },
  quotes: { main: { bid: 92.1, ask: 92.4, last: 92.25, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 500_000, unsettled: 0 }, EUR: { settled: 200_000, unsettled: 0, availableToTrade: 200_000 } }, treasury: { USD: { settled: 500_000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 720_000, treasury: 500_000, book: 1_220_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 20 MW x 24 h = 480 MWh. 480 x 92.40 x 1 = 44_352; fee 24
    {
      id: 'buy-day-ahead', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 480, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 480, estimate: 92.4, model: 'quoted-bid-ask', settleDate: '2026-03-20', calendar: 'TARGET', cash: -44_352, fees: 24 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 480, avgPrice: 92.4 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 480 DE-BASE-0320 @ 92.40 EUR", owner: 'account', date: '2026-03-19' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 200_000, unsettled: -44_376, availableToTrade: 155_624, availableToWithdraw: 155_624 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 480, avgCost: 92.4, cost: 44_352, price: 92.25, value: 44_280, unrealized: -72, priceSource: 'Test fixture' }], // value 480 x 92.25 x 1 = 44_280; avgCost 44_352 / (480 x 1),
        holdings: { main: { long: 480, short: 0, net: 480 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-20', amount: -44_376, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -26.4, fees: 0, unrealized: -79.2, total: -105.6 } },
        nav: { account: 719_894.4, book: 1_219_894.4 },
        balance: { account: { cash: 720_000, positions: 48_708, receivable: null, payable: 48_813.6, assets: 768_708, liabilities: 48_813.6, netAssets: 719_894.4, local: { EUR: { cash: 200_000, positions: 44_280, receivable: null, payable: 44_376 } } } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'intraday-quote', action: 'quote', instrument: 'main', quote: { bid: 93, ask: 93.3, last: 93.15, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 200_000, unsettled: -44_376, availableToTrade: 155_624, availableToWithdraw: 155_624 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 480, avgCost: 92.4, cost: 44_352, price: 93.15000000000000568434188608, value: 44_712, unrealized: 360, priceSource: 'Test fixture' }], // value 480 x 93.15 x 1 = 44_712.00000000000272848410532; avgCost 44_352 / (480 x 1),
        holdings: { main: { long: 480, short: 0, net: 480 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-20', amount: -44_376, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -26.4, fees: 0, unrealized: 396, total: 369.6 } },
        nav: { account: 720_369.6, book: 1_220_369.6 },
        balance: { account: { cash: 720_000, positions: 49_183.2, receivable: null, payable: 48_813.6, assets: 769_183.2, liabilities: 48_813.6, netAssets: 720_369.6, local: { EUR: { cash: 200_000, positions: 44_712, receivable: null, payable: 44_376 } } } },
      },
    },
    // 120 x 93.00 x 1 = 11_160; fee 6; realized 11_160 - cost out 11_088 = 72
    {
      id: 'sell-back-intraday', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 120, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 120, estimate: 93, model: 'quoted-bid-ask', settleDate: '2026-03-20', calendar: 'TARGET', cash: 11_160, fees: 6 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 120, avgPrice: 93 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 120 DE-BASE-0320 @ 93.00 EUR (realized 72.00 EUR)", owner: 'account', date: '2026-03-19' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 200_000, unsettled: -33_222, availableToTrade: 166_778, availableToWithdraw: 155_624 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 360, avgCost: 92.4, cost: 33_264, price: 93.15000000000000568434188608, value: 33_534, unrealized: 270, priceSource: 'Test fixture' }], // value 360 x 93.15 x 1 = 33_534.00000000000204636307899; avgCost 33_264 / (360 x 1),
        holdings: { main: { long: 360, short: 0, net: 360 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-20', amount: -44_376, ccy: 'EUR', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-20', amount: 11_154, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 79.2, commissions: -33, fees: 0, unrealized: 297, total: 343.2 } },
        nav: { account: 720_343.2, book: 1_220_343.2 },
        balance: { account: { cash: 720_000, positions: 36_887.4, receivable: 12_269.4, payable: 48_813.6, assets: 769_156.8, liabilities: 48_813.6, netAssets: 720_343.2, local: { EUR: { cash: 200_000, positions: 33_534, receivable: 11_154, payable: 44_376 } } } },
      },
    },
    {
      id: 'delivery-day', covers: "settlement", action: 'clock', to: '2026-03-20T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 11,154.00 EUR into settled cash', cash: { EUR: 11_154 }, owner: 'account', date: '2026-03-20' }, { type: 'settlement.pay', summary: 'paid 44,376.00 EUR from settled cash', cash: { EUR: -44_376 }, owner: 'account', date: '2026-03-20' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 166_778, unsettled: 0, availableToTrade: 166_778, availableToWithdraw: 166_778 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 360, avgCost: 92.4, cost: 33_264, price: 93.15000000000000568434188608, value: 33_534, unrealized: 270, priceSource: 'Test fixture' }], // value 360 x 93.15 x 1 = 33_534.00000000000204636307899; avgCost 33_264 / (360 x 1),
        holdings: { main: { long: 360, short: 0, net: 360 } },
        pending: [],
        pnl: { account: { realized: 79.2, commissions: -33, fees: 0, unrealized: 297, total: 343.2 } },
        nav: { account: 720_343.2, book: 1_220_343.2 },
        balance: { account: { cash: 683_455.8, positions: 36_887.4, receivable: null, payable: null, assets: 720_343.2, liabilities: 0, netAssets: 720_343.2, local: { EUR: { cash: 166_778, positions: 33_534, receivable: null, payable: null } } } },
      },
    },
    {
      id: 'imbalance-charge', covers: "imbalance", action: 'cashflow', lot: 'lot', category: 'fee', amount: -310, note: "Imbalance settlement for the delivery day (transmission system operator)",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on DE-BASE-0320: paid 310.00 EUR. Imbalance settlement for the delivery day (transmission system operator)", cash: { EUR: -310 }, owner: 'account' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 166_468, unsettled: 0, availableToTrade: 166_468, availableToWithdraw: 166_468 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 360, avgCost: 92.4, cost: 33_264, price: 93.15000000000000568434188608, value: 33_534, unrealized: 270, priceSource: 'Test fixture' }], // value 360 x 93.15 x 1 = 33_534.00000000000204636307899; avgCost 33_264 / (360 x 1),
        holdings: { main: { long: 360, short: 0, net: 360 } },
        pending: [],
        pnl: { account: { realized: 79.2, commissions: -33, fees: -341, unrealized: 297, total: 2.2 } },
        nav: { account: 720_002.2, book: 1_220_002.2 },
        balance: { account: { cash: 683_114.8, positions: 36_887.4, receivable: null, payable: null, assets: 720_002.2, liabilities: 0, netAssets: 720_002.2, local: { EUR: { cash: 166_468, positions: 33_534, receivable: null, payable: null } } } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "The physical flow of the power during the delivery day is not simulated.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // Delivery period completed: 360 MWh delivered to the offtaker at the agreed 96.50, recorded by hand. 360 x 96.50 x 1 = 34_740; fee 18; realized 34_740 - cost out 33_264 = 1476
    {
      id: 'delivered-to-offtaker', covers: "delivery period", action: 'ticket', instrument: 'main', side: 'sell', qty: 360, from: 'lot', order: { statedPrice: 96.5 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 360, estimate: 96.5, model: 'stated-price', settleDate: '2026-03-23', calendar: 'TARGET', cash: 34_740, fees: 18 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 360, avgPrice: 96.5 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 360 DE-BASE-0320 @ 96.50 EUR (realized 1,476.00 EUR)", owner: 'account', date: '2026-03-20' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 166_468, unsettled: 34_722, availableToTrade: 201_190, availableToWithdraw: 166_468 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-03-23', amount: 34_722, ccy: 'EUR', into: 'cash' }],
        pnl: { account: { realized: 1702.8, commissions: -52.8, fees: -341, unrealized: 0, total: 1309 } },
        nav: { account: 721_309, book: 1_221_309 },
        balance: { account: { cash: 683_114.8, positions: null, receivable: 38_194.2, payable: null, assets: 721_309, liabilities: 0, netAssets: 721_309, local: { EUR: { cash: 166_468, positions: null, receivable: 34_722, payable: null } } } },
      },
    },
    {
      id: 'settle-offtake', covers: "settlement", action: 'clock', to: '2026-03-23T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 34,722.00 EUR into settled cash', cash: { EUR: 34_722 }, owner: 'account', date: '2026-03-23' }],
        cash: { account: { USD: { settled: 500_000, unsettled: 0, availableToTrade: 500_000, availableToWithdraw: 500_000 }, EUR: { settled: 201_190, unsettled: 0, availableToTrade: 201_190, availableToWithdraw: 201_190 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 1702.8, commissions: -52.8, fees: -341, unrealized: 0, total: 1309 } },
        nav: { account: 721_309, book: 1_221_309 },
        balance: { account: { cash: 721_309, positions: null, receivable: null, payable: null, assets: 721_309, liabilities: 0, netAssets: 721_309, local: { EUR: { cash: 201_190, positions: null, receivable: null, payable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// agricultural_commodity
// ---------------------------------------------------------------------------------------------
// Wheat in bushels, priced in US cents per bushel as the grain trade quotes it, so the multiplier is 0.01 dollars per cent; broker fee
// 0.01 dollars per bushel. Elevator storage and the protein premium earned on the grade are recorded by hand.
const agriculturalCommodity = {
  productId: 'agricultural_commodity',
  title: "Hard red winter wheat at a Kansas City elevator: bushels priced in US cents per bushel (x 0.01), storage and protein premium by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["elevator storage, recorded by hand (fee)", "protein premium for the delivered grade, recorded by hand (realized)"],
    settlement: "T+2 (Book setting settlement.spot) on the US calendar",
    lifecycle: "Nothing automated; storage and grade premium recorded by hand; loading out of the elevator (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = bushels x US cents per bushel x 0.01; broker fee 0.01 per bushel expensed; storage in fees; protein premium in realized P&L",
    collateral: "None; no short sale",
  },
  start: '2026-04-06T14:00:00.000Z', // Monday 6 April 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix agricultural commodity", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0.01, minimum: 0, bps: 0 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "agricultural_commodity", name: "Hard red winter wheat No. 2, Kansas City elevator", symbol: "HRW-KC", marketView: "US_CASH", venue: "Plains Grain Merchants (OTC)", venueType: "otc", venueCountry: "US", issuer: "Plains Grain Merchants Inc.", domicile: "US", underlyingGeo: "US", tradingCcy: "USD", multiplier: 0.01, terms: { quantityUnit: "bushels", priceUnits: "US cents per bushel" } } },
  quotes: { main: { bid: 610.25, ask: 612.5, last: 611.5, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // 50,000 x 612.50 x 0.01 = 306_250; fee 500
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 50_000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 50_000, estimate: 612.5, model: 'quoted-bid-ask', settleDate: '2026-04-08', calendar: 'US', cash: -306_250, fees: 500 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 50_000, avgPrice: 612.5 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 50,000 HRW-KC @ 612.50 USD", owner: 'account', date: '2026-04-06' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -306_750, availableToTrade: 693_250, availableToWithdraw: 693_250 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50_000, avgCost: 612.5, cost: 306_250, price: 611.5, value: 305_750, unrealized: -500, priceSource: 'Test fixture' }], // value 50,000 x 611.5 x 0.01 = 305_750; avgCost 306_250 / (50,000 x 0.01),
        holdings: { main: { long: 50_000, short: 0, net: 50_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-08', amount: -306_750, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -500, fees: 0, unrealized: -500, total: -1000 } },
        nav: { account: 999_000, book: 1_999_000 },
        balance: { account: { cash: 1_000_000, positions: 305_750, receivable: null, payable: 306_750, assets: 1_305_750, liabilities: 306_750, netAssets: 999_000 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-04-08T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 306,750.00 USD from settled cash', cash: { USD: -306_750 }, owner: 'account', date: '2026-04-08' }],
        cash: { account: { USD: { settled: 693_250, unsettled: 0, availableToTrade: 693_250, availableToWithdraw: 693_250 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50_000, avgCost: 612.5, cost: 306_250, price: 611.5, value: 305_750, unrealized: -500, priceSource: 'Test fixture' }], // value 50,000 x 611.5 x 0.01 = 305_750; avgCost 306_250 / (50,000 x 0.01),
        holdings: { main: { long: 50_000, short: 0, net: 50_000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -500, fees: 0, unrealized: -500, total: -1000 } },
        nav: { account: 999_000, book: 1_999_000 },
        balance: { account: { cash: 693_250, positions: 305_750, receivable: null, payable: null, assets: 999_000, liabilities: 0, netAssets: 999_000 } },
      },
    },
    {
      id: 'elevator-storage', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -1500, note: "Elevator storage for April",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on HRW-KC: paid 1,500.00 USD. Elevator storage for April", cash: { USD: -1500 }, owner: 'account' }],
        cash: { account: { USD: { settled: 691_750, unsettled: 0, availableToTrade: 691_750, availableToWithdraw: 691_750 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50_000, avgCost: 612.5, cost: 306_250, price: 611.5, value: 305_750, unrealized: -500, priceSource: 'Test fixture' }], // value 50,000 x 611.5 x 0.01 = 305_750; avgCost 306_250 / (50,000 x 0.01),
        holdings: { main: { long: 50_000, short: 0, net: 50_000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -500, fees: -1500, unrealized: -500, total: -2500 } },
        nav: { account: 997_500, book: 1_997_500 },
        balance: { account: { cash: 691_750, positions: 305_750, receivable: null, payable: null, assets: 997_500, liabilities: 0, netAssets: 997_500 } },
      },
    },
    {
      id: 'protein-premium', covers: "quality adjustment", action: 'cashflow', lot: 'lot', category: 'realized', amount: 750, note: "Protein premium: 12.4% protein delivered against an 11.0% basis",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual realized on HRW-KC: received 750.00 USD. Protein premium: 12.4% protein delivered against an 11.0% basis", cash: { USD: 750 }, owner: 'account' }],
        cash: { account: { USD: { settled: 692_500, unsettled: 0, availableToTrade: 692_500, availableToWithdraw: 692_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50_000, avgCost: 612.5, cost: 306_250, price: 611.5, value: 305_750, unrealized: -500, priceSource: 'Test fixture' }], // value 50,000 x 611.5 x 0.01 = 305_750; avgCost 306_250 / (50,000 x 0.01),
        holdings: { main: { long: 50_000, short: 0, net: 50_000 } },
        pending: [],
        pnl: { account: { realized: 750, commissions: -500, fees: -1500, unrealized: -500, total: -1750 } },
        nav: { account: 998_250, book: 1_998_250 },
        balance: { account: { cash: 692_500, positions: 305_750, receivable: null, payable: null, assets: 998_250, liabilities: 0, netAssets: 998_250 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 620, ask: 622.25, last: 621, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 692_500, unsettled: 0, availableToTrade: 692_500, availableToWithdraw: 692_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 50_000, avgCost: 612.5, cost: 306_250, price: 621, value: 310_500, unrealized: 4250, priceSource: 'Test fixture' }], // value 50,000 x 621.0 x 0.01 = 310_500; avgCost 306_250 / (50,000 x 0.01),
        holdings: { main: { long: 50_000, short: 0, net: 50_000 } },
        pending: [],
        pnl: { account: { realized: 750, commissions: -500, fees: -1500, unrealized: 4250, total: 3000 } },
        nav: { account: 1_003_000, book: 2_003_000 },
        balance: { account: { cash: 692_500, positions: 310_500, receivable: null, payable: null, assets: 1_003_000, liabilities: 0, netAssets: 1_003_000 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Loading the wheat out of the elevator is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 20,000 x 620.00 x 0.01 = 124_000; fee 200; realized 124_000 - cost out 122_500 = 1500
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 20_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 20_000, estimate: 620, model: 'quoted-bid-ask', settleDate: '2026-04-10', calendar: 'US', cash: 124_000, fees: 200 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 20_000, avgPrice: 620 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 20,000 HRW-KC @ 620.00 USD (realized 1,500.00 USD)", owner: 'account', date: '2026-04-08' }],
        cash: { account: { USD: { settled: 692_500, unsettled: 123_800, availableToTrade: 816_300, availableToWithdraw: 692_500 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 30_000, avgCost: 612.5, cost: 183_750, price: 621, value: 186_300, unrealized: 2550, priceSource: 'Test fixture' }], // value 30,000 x 621.0 x 0.01 = 186_300; avgCost 183_750 / (30,000 x 0.01),
        holdings: { main: { long: 30_000, short: 0, net: 30_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-10', amount: 123_800, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 2250, commissions: -700, fees: -1500, unrealized: 2550, total: 2600 } },
        nav: { account: 1_002_600, book: 2_002_600 },
        balance: { account: { cash: 692_500, positions: 186_300, receivable: 123_800, payable: null, assets: 1_002_600, liabilities: 0, netAssets: 1_002_600 } },
      },
    },
    // 30,000 x 620.00 x 0.01 = 186_000; fee 300; realized 186_000 - cost out 183_750 = 2250
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 30_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 30_000, estimate: 620, model: 'quoted-bid-ask', settleDate: '2026-04-10', calendar: 'US', cash: 186_000, fees: 300 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 30_000, avgPrice: 620 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 30,000 HRW-KC @ 620.00 USD (realized 2,250.00 USD)", owner: 'account', date: '2026-04-08' }],
        cash: { account: { USD: { settled: 692_500, unsettled: 309_500, availableToTrade: 1_002_000, availableToWithdraw: 692_500 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-10', amount: 123_800, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-10', amount: 185_700, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 4500, commissions: -1000, fees: -1500, unrealized: 0, total: 2000 } },
        nav: { account: 1_002_000, book: 2_002_000 },
        balance: { account: { cash: 692_500, positions: null, receivable: 309_500, payable: null, assets: 1_002_000, liabilities: 0, netAssets: 1_002_000 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-04-10T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 123,800.00 USD into settled cash', cash: { USD: 123_800 }, owner: 'account', date: '2026-04-10' }, { type: 'settlement.receive', summary: 'received 185,700.00 USD into settled cash', cash: { USD: 185_700 }, owner: 'account', date: '2026-04-10' }],
        cash: { account: { USD: { settled: 1_002_000, unsettled: 0, availableToTrade: 1_002_000, availableToWithdraw: 1_002_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 4500, commissions: -1000, fees: -1500, unrealized: 0, total: 2000 } },
        nav: { account: 1_002_000, book: 2_002_000 },
        balance: { account: { cash: 1_002_000, positions: null, receivable: null, payable: null, assets: 1_002_000, liabilities: 0, netAssets: 1_002_000 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// livestock
// ---------------------------------------------------------------------------------------------
// Live cattle bought at auction in pounds of live weight, priced in US dollars per hundredweight (100 lb), so the multiplier is 0.01;
// auction commission 0.25%. Feedlot yardage is recorded by hand, and so is the weight lost in transit (1,200 lb, a sale at 0.00).
// The cattle are then sold to a packer in two lots.
const livestock = {
  productId: 'livestock',
  title: "Live steers at the Oklahoma National Stockyards: pounds of live weight priced per hundredweight (x 0.01), yardage and transit shrink by hand",
  matrix: {
    ...SPOT_TICKET,
    manualInputs: ["feedlot yardage and feed, recorded by hand (fee)", "transit shrink (live weight lost), recorded by hand as a sale at a stated fill price of 0.00"],
    settlement: "T+2 (Book setting settlement.spot) on the US calendar",
    lifecycle: "Nothing automated; yardage and shrink recorded by hand; shipping the cattle to the packer (physical delivery) is not simulated (refused, visibly)",
    accounting: "Value = pounds x USD per hundredweight x 0.01; auction commission 25 bp expensed; yardage in fees; shrink realizes its cost as a loss; realized P&L on sale",
    collateral: "None; no short sale",
  },
  start: '2026-04-14T14:00:00.000Z', // Tuesday 14 April 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: "Matrix livestock", reportingCcy: "USD", capital: [{ ccy: "USD", amount: 2_000_000 }], account: { name: "Alpha", funding: [{ ccy: "USD", amount: 1_000_000 }] }, settings: { fees: { spot: { perUnit: 0, minimum: 0, bps: 25 } }, fill: FILL, settlement: { spot: 2, foreignCash: 2 } } },
  instruments: { main: { productId: "livestock", name: "Live steers, 1,400 to 1,500 lb, Oklahoma National Stockyards", symbol: "CATTLE-OK", marketView: "US_CASH", venue: "Oklahoma National Stockyards (auction)", venueType: "otc", venueCountry: "US", issuer: "Oklahoma National Stockyards Co.", domicile: "US", underlyingGeo: "US", tradingCcy: "USD", multiplier: 0.01, terms: { quantityUnit: "pounds (live weight)", priceUnits: "USD per hundredweight" } } },
  quotes: { main: { bid: 224, ask: 225, last: 224.5, bidSize: 1_000_000, askSize: 1_000_000 } },
  expectAtStart: { cash: { account: { USD: { settled: 1000000, unsettled: 0, availableToTrade: 1000000 } }, treasury: { USD: { settled: 1000000 } } }, positions: [], pending: [], openOrders: [], borrowings: [], nav: { account: 1000000, treasury: 1000000, book: 2000000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    // About 80 head at 1,500 lb. 120,000 x 225.00 x 0.01 = 270_000; fee 675
    {
      id: 'buy', covers: "open", action: 'ticket', instrument: 'main', side: 'buy', qty: 120_000, as: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 120_000, estimate: 225, model: 'quoted-bid-ask', settleDate: '2026-04-16', calendar: 'US', cash: -270_000, fees: 675 }] },
        result: { orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 120_000, avgPrice: 225 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: "Bought 120,000 CATTLE-OK @ 225.00 USD", owner: 'account', date: '2026-04-14' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -270_675, availableToTrade: 729_325, availableToWithdraw: 729_325 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 120_000, avgCost: 225, cost: 270_000, price: 224.5, value: 269_400, unrealized: -600, priceSource: 'Test fixture' }], // value 120,000 x 224.5 x 0.01 = 269_400; avgCost 270_000 / (120,000 x 0.01),
        holdings: { main: { long: 120_000, short: 0, net: 120_000 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-16', amount: -270_675, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, commissions: -675, fees: 0, unrealized: -600, total: -1275 } },
        nav: { account: 998_725, book: 1_998_725 },
        balance: { account: { cash: 1_000_000, positions: 269_400, receivable: null, payable: 270_675, assets: 1_269_400, liabilities: 270_675, netAssets: 998_725 } },
      },
    },
    {
      id: 'short-sale', covers: 'open', action: 'ticket', instrument: 'main', side: 'sell_short', qty: 100, borrow: { available: true, feeRate: 0.02 },
      status: 'unsupported', reason: "A physical commodity cannot be borrowed in the Terminal; a short position is not offered.",
      expect: {
        refused: { engine: 'cannot be traded with "sell short"', api: 'cannot be traded with "sell short"', browser: 'does not offer "Sell short"' },
      },
    },
    {
      id: 'settle-purchase', covers: "settlement", action: 'clock', to: '2026-04-16T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 270,675.00 USD from settled cash', cash: { USD: -270_675 }, owner: 'account', date: '2026-04-16' }],
        cash: { account: { USD: { settled: 729_325, unsettled: 0, availableToTrade: 729_325, availableToWithdraw: 729_325 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 120_000, avgCost: 225, cost: 270_000, price: 224.5, value: 269_400, unrealized: -600, priceSource: 'Test fixture' }], // value 120,000 x 224.5 x 0.01 = 269_400; avgCost 270_000 / (120,000 x 0.01),
        holdings: { main: { long: 120_000, short: 0, net: 120_000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -675, fees: 0, unrealized: -600, total: -1275 } },
        nav: { account: 998_725, book: 1_998_725 },
        balance: { account: { cash: 729_325, positions: 269_400, receivable: null, payable: null, assets: 998_725, liabilities: 0, netAssets: 998_725 } },
      },
    },
    {
      id: 'feedlot-yardage', covers: "storage", action: 'cashflow', lot: 'lot', category: 'fee', amount: -4800, note: "Feedlot yardage and feed for two weeks",
      expect: {
        events: [{ type: 'manual.cashflow', summary: "Manual fee on CATTLE-OK: paid 4,800.00 USD. Feedlot yardage and feed for two weeks", cash: { USD: -4800 }, owner: 'account' }],
        cash: { account: { USD: { settled: 724_525, unsettled: 0, availableToTrade: 724_525, availableToWithdraw: 724_525 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 120_000, avgCost: 225, cost: 270_000, price: 224.5, value: 269_400, unrealized: -600, priceSource: 'Test fixture' }], // value 120,000 x 224.5 x 0.01 = 269_400; avgCost 270_000 / (120,000 x 0.01),
        holdings: { main: { long: 120_000, short: 0, net: 120_000 } },
        pending: [],
        pnl: { account: { realized: 0, commissions: -675, fees: -4800, unrealized: -600, total: -6075 } },
        nav: { account: 993_925, book: 1_993_925 },
        balance: { account: { cash: 724_525, positions: 269_400, receivable: null, payable: null, assets: 993_925, liabilities: 0, netAssets: 993_925 } },
      },
    },
    // Transit shrink: 1,200 lb of live weight lost, recorded by hand as a sale at 0.00. 1,200 x 0.00 x 0.01 = 0; realized 0 - cost out 2700 = -2700
    {
      id: 'transit-shrink-by-hand', covers: "weight loss", action: 'ticket', instrument: 'main', side: 'sell', qty: 1200, from: 'lot', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 1200, estimate: 0, model: 'stated-price', settleDate: '2026-04-20', calendar: 'US', cash: 0, fees: 0 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 1200, avgPrice: 0 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 1,200 CATTLE-OK @ 0.00 USD (realized -2,700.00 USD)", owner: 'account', date: '2026-04-16' }],
        cash: { account: { USD: { settled: 724_525, unsettled: 0, availableToTrade: 724_525, availableToWithdraw: 724_525 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 118_800, avgCost: 225, cost: 267_300, price: 224.5, value: 266_706, unrealized: -594, priceSource: 'Test fixture' }], // value 118,800 x 224.5 x 0.01 = 266_706; avgCost 267_300 / (118,800 x 0.01),
        holdings: { main: { long: 118_800, short: 0, net: 118_800 } },
        pending: [],
        pnl: { account: { realized: -2700, commissions: -675, fees: -4800, unrealized: -594, total: -8769 } },
        nav: { account: 991_231, book: 1_991_231 },
        balance: { account: { cash: 724_525, positions: 266_706, receivable: null, payable: null, assets: 991_231, liabilities: 0, netAssets: 991_231 } },
      },
    },
    {
      id: 'quote-up', action: 'quote', instrument: 'main', quote: { bid: 230, ask: 231, last: 230.5, bidSize: 1_000_000, askSize: 1_000_000 },
      expect: {
        cash: { account: { USD: { settled: 724_525, unsettled: 0, availableToTrade: 724_525, availableToWithdraw: 724_525 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 118_800, avgCost: 225, cost: 267_300, price: 230.5, value: 273_834, unrealized: 6534, priceSource: 'Test fixture' }], // value 118,800 x 230.5 x 0.01 = 273_834; avgCost 267_300 / (118,800 x 0.01),
        holdings: { main: { long: 118_800, short: 0, net: 118_800 } },
        pending: [],
        pnl: { account: { realized: -2700, commissions: -675, fees: -4800, unrealized: 6534, total: -1641 } },
        nav: { account: 998_359, book: 1_998_359 },
        balance: { account: { cash: 724_525, positions: 273_834, receivable: null, payable: null, assets: 998_359, liabilities: 0, netAssets: 998_359 } },
      },
    },
    {
      id: 'physical-delivery', covers: 'physical delivery', action: 'lifecycle', lot: 'lot', body: { action: 'deliver' },
      status: 'unsupported', reason: "Shipping the cattle to the packer is a physical delivery, which the Terminal does not simulate.",
      expect: {
        refused: { engine: 'Physical delivery is not simulated', api: 'Physical delivery is not simulated', browser: '"deliver" is not offered' },
      },
    },
    // 40,000 x 230.00 x 0.01 = 92_000; fee 230; realized 92_000 - cost out 90_000 = 2000
    {
      id: 'reduce', covers: "reduce", action: 'ticket', instrument: 'main', side: 'sell', qty: 40_000, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 40_000, estimate: 230, model: 'quoted-bid-ask', settleDate: '2026-04-20', calendar: 'US', cash: 92_000, fees: 230 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 40_000, avgPrice: 230 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 40,000 CATTLE-OK @ 230.00 USD (realized 2,000.00 USD)", owner: 'account', date: '2026-04-16' }],
        cash: { account: { USD: { settled: 724_525, unsettled: 91_770, availableToTrade: 816_295, availableToWithdraw: 724_525 } } },
        positions: [{ instrument: 'main', lot: 'lot', owner: 'account', direction: 'long', qty: 78_800, avgCost: 225, cost: 177_300, price: 230.5, value: 181_634, unrealized: 4334, priceSource: 'Test fixture' }], // value 78,800 x 230.5 x 0.01 = 181_634; avgCost 177_300 / (78,800 x 0.01),
        holdings: { main: { long: 78_800, short: 0, net: 78_800 } },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-20', amount: 91_770, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: -700, commissions: -905, fees: -4800, unrealized: 4334, total: -2071 } },
        nav: { account: 997_929, book: 1_997_929 },
        balance: { account: { cash: 724_525, positions: 181_634, receivable: 91_770, payable: null, assets: 997_929, liabilities: 0, netAssets: 997_929 } },
      },
    },
    // 78,800 x 230.00 x 0.01 = 181_240; fee 453.1; realized 181_240 - cost out 177_300 = 3940
    {
      id: 'close', covers: "close", action: 'ticket', instrument: 'main', side: 'sell', qty: 78_800, from: 'lot',
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'sell', instrument: 'main', qty: 78_800, estimate: 230, model: 'quoted-bid-ask', settleDate: '2026-04-20', calendar: 'US', cash: 181_240, fees: 453.1 }] },
        result: { orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 78_800, avgPrice: 230 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: "Sold 78,800 CATTLE-OK @ 230.00 USD (realized 3,940.00 USD)", owner: 'account', date: '2026-04-16' }],
        cash: { account: { USD: { settled: 724_525, unsettled: 272_556.9, availableToTrade: 997_081.9, availableToWithdraw: 724_525 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-20', amount: 91_770, ccy: 'USD', into: 'cash' }, { instrument: 'main', lot: 'lot', owner: 'account', dueDate: '2026-04-20', amount: 180_786.9, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 3240, commissions: -1358.1, fees: -4800, unrealized: 0, total: -2918.1 } },
        nav: { account: 997_081.9, book: 1_997_081.9 },
        balance: { account: { cash: 724_525, positions: null, receivable: 272_556.9, payable: null, assets: 997_081.9, liabilities: 0, netAssets: 997_081.9 } },
      },
    },
    {
      id: 'settle-sales', covers: "settlement", action: 'clock', to: '2026-04-20T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 91,770.00 USD into settled cash', cash: { USD: 91_770 }, owner: 'account', date: '2026-04-20' }, { type: 'settlement.receive', summary: 'received 180,786.90 USD into settled cash', cash: { USD: 180_786.9 }, owner: 'account', date: '2026-04-20' }],
        cash: { account: { USD: { settled: 997_081.9, unsettled: 0, availableToTrade: 997_081.9, availableToWithdraw: 997_081.9 } } },
        positions: [],
        holdings: { main: null },
        pending: [],
        pnl: { account: { realized: 3240, commissions: -1358.1, fees: -4800, unrealized: 0, total: -2918.1 } },
        nav: { account: 997_081.9, book: 1_997_081.9 },
        balance: { account: { cash: 997_081.9, positions: null, receivable: null, payable: null, assets: 997_081.9, liabilities: 0, netAssets: 997_081.9 } },
      },
    },
  ],
};

export default [physicalCommodity, preciousMetal, industrialMetal, crudeOil, refinedProduct, naturalGas, lng, coal, electricity, agriculturalCommodity, livestock];
