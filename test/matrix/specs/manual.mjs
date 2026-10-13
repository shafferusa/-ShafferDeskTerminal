// Manual family (engine family "manual", catalog support "manual"): sixteen products that the Terminal neither prices
// nor runs automatically. Every term, valuation, capital call, distribution, redemption, loss event and settlement is
// entered by hand through the interface (the position's Lifecycle menu, the ticket at a stated price) and is labelled
// as manual on screen and in the history. One scenario per product, each on its own fictional instrument registered
// as exactly that product with the terms such a product has.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec, with the arithmetic in the
// comment beside it. Nothing here is copied from what the Terminal prints.
//
// The manual workflow these scenarios rely on (server/products/manual.js, restated so the arithmetic can be followed):
//   - Entry, secondary sale, partial sale and early termination are tickets at a stated price ("State a fill price",
//     fill model stated-price, a manual input). Cash moves on the settlement date (the Book's manual lag, 2 business
//     days, unless the ticket states a settlement date). No commission: the Book's manual fee schedule is zero.
//   - A fund interest (private equity, venture capital) is held as a share of the interest (1 = the whole commitment)
//     and valued at the value of the whole interest. Committed = commitment x share held. A capital call raises cost by
//     its investment part, books its management-fee part as a fee, and counts in full against the commitment. A
//     distribution is entered in parts: return of capital (lowers cost; never more than the cost left), realized gain,
//     income (Dividends line), less carried interest withheld (Fees). A secondary sale of part of the interest takes the
//     same share of what was called. The final wind-up realises the cost left and releases what was never called.
//   - A valuation is entered with its valuation date and source; the value entered is for the holding, stored per unit
//     (value / share held). It is rolled forward by the calls and distributions recorded after its valuation date
//     (value = reported value + investment part of later calls - later distributions, before carry), and goes stale
//     once older than the contract's "valuation goes stale after" days; a stale or missing valuation makes the net
//     asset value provisional. A position with no valuation is carried at cost.

export const family = 'manual';

/** Every manual scenario states its Book in full: no commission on hand-entered trades; the manual lag is 2 business days. */
const SETTINGS = {
  fees: { manual: { perUnit: 0, minimum: 0, bps: 0 } },
  fill: { halfSpreadBps: { manual: 0 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 },
  settlement: { manual: 2, foreignCash: 2 },
};
const MANUAL_TICKET = {
  ticket: 'Instrument drawer, Trade tab (security ticket; Buy and Sell carry the product\'s own labels), always with "State a fill price"; then the trade preview. Events by hand: the position\'s Lifecycle menu in the strategy instance',
  automaticInputs: ['settlement date from the Book\'s manual lag on the instrument\'s calendar (or a date stated on the ticket)', 'cost, realized P&L and the manual workflow figures worked out from what is entered'],
};

// ---------------------------------------------------------------------------------------------
// private_equity
// ---------------------------------------------------------------------------------------------
// A primary commitment of 10,000,000 to a mid-market buyout fund. Two capital calls (each with a management-fee part),
// quarterly valuations from the general partner entered by hand with their dates, one valuation left to go stale, a
// distribution split into return of capital, gain and income with carried interest withheld, a secondary sale of a
// quarter of the interest (the buyer takes over a quarter of the commitment), a refused over-call, the final
// distribution and the wind-up, which releases the commitment never called.
const PE_START = { cash: { account: { USD: { settled: 12_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 12_000_000 } }, treasury: { USD: { settled: 8_000_000 } } },
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], nav: { account: 12_000_000, treasury: 8_000_000, book: 20_000_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } };
const PE_POS = { instrument: 'main', lot: 'interest', owner: 'account', direction: 'committed' };
const peM = (o) => ({ kind: 'commitment', feesCalled: 0, returnOfCapital: 0, realizedGain: 0, income: 0, carry: 0, expenses: 0, ...o });
const privateEquity = {
  productId: 'private_equity',
  title: 'Harrow Peak Capital Partners VII: 10,000,000 commitment to a buyout fund, calls, GP valuations, distributions, secondary sale and wind-up, all by hand',
  matrix: {
    ...MANUAL_TICKET,
    requiredFields: ['Trading owner', 'Action (Commit or acquire, Sell (secondary))', 'Share of the interest', 'State a fill price', 'Commitment (registration)', 'Valuation goes stale after (registration)'],
    manualInputs: ['commitment and fund terms at registration', 'capital calls (amount, management-fee part)', 'valuations (value of the holding, valuation date, source)', 'distributions (return of capital, realized gain, income, carried interest withheld)', 'secondary sale price and transfer date', 'final wind-up'],
    settlement: 'Capital calls and distributions in cash when recorded; the secondary sale on the transfer date stated on the ticket (13 November 2026)',
    lifecycle: 'Nothing automated. Calls, valuations, distributions and the wind-up recorded by hand to completion; a call above the uncalled commitment is refused',
    accounting: 'Cost = investment part of calls less return of capital; fee parts and carried interest in Fees; gains in Realized P&L; income in Dividends; valued at the GP valuation rolled forward for later calls and distributions; stale after 120 days (NAV provisional)',
    collateral: 'None: a fund interest held long, no counterparty exposure beyond the fund itself',
  },
  start: '2026-03-02T15:00:00.000Z', // Monday 2 March 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: 'Matrix private equity', reportingCcy: 'USD', capital: [{ ccy: 'USD', amount: 20_000_000 }], account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 12_000_000 }] }, settings: SETTINGS },
  instruments: {
    main: { productId: 'private_equity', name: 'Harrow Peak Capital Partners VII, L.P.', symbol: 'HPCP7', marketView: 'US_CASH', venueType: 'otc', issuer: 'Harrow Peak Capital LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD',
      terms: { commitment: 10_000_000, vintage: 2026, manager: 'Harrow Peak Capital LLC', strategy: 'North American mid-market buyout', valuationMaxAgeDays: 120 } },
  },
  expectAtStart: PE_START,
  steps: [
    {
      // The commitment is entered at a stated price of 0.00: nothing is paid at signing; capital is called later.
      id: 'commit', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1, as: 'interest', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1, estimate: 0, model: 'stated-price', settleDate: '2026-03-04', cash: 0, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1, avgPrice: 0, fills: [{ qty: 1, price: 0, model: 'stated-price' }] }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 HPCP7 @ 0.00 USD', owner: 'account', date: '2026-03-02' }],
        positions: [{ ...PE_POS, qty: 1, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, priceSource: null, freshness: null,
          manual: peM({ committed: 10_000_000, called: 0, uncalled: 10_000_000, valuation: null }) }], // committed = 10,000,000 x 1
        holdings: { main: { long: 1, short: 0, net: 1 } },
        pending: [], // a stated price of 0.00 leaves nothing to settle
        pnl: { account: { realized: 0, dividends: 0, fees: 0, commissions: 0 } },
        nav: { account: 12_000_000, book: 20_000_000 }, // held at its cost of 0.00 until a valuation is entered
        provisional: { account: true, book: true }, // no valuation: the net asset value is provisional
        balance: { account: { cash: 12_000_000, assets: 12_000_000, liabilities: 0, netAssets: 12_000_000 } },
      },
    },
    { id: 'call-date', action: 'clock', to: '2026-03-10T14:00:00.000Z', expect: {} }, // Tuesday 10 March 2026, 10:00 New York (daylight time)
    {
      // First call: 1,500,000, of which 37,500 is the quarterly management fee (1.5% a year of 10,000,000 / 4).
      id: 'call-1', covers: 'capital call', action: 'lifecycle', lot: 'interest', body: { action: 'capital_call', amount: 1_500_000, feePortion: 37_500, note: 'Call notice 1: acquisition of Corvel Packaging' },
      expect: {
        events: [{ type: 'manual.capital_call', summary: 'Capital call on HPCP7 entered by hand: paid 1,500,000.00 USD (1,462,500.00 USD invested, 37,500.00 USD management fee); called 1,500,000.00 USD of 10,000,000.00 USD, uncalled 8,500,000.00 USD. Call notice 1: acquisition of Corvel Packaging', cash: { USD: -1_500_000 }, owner: 'account', date: '2026-03-10' }],
        cash: { account: { USD: { settled: 10_500_000, availableToTrade: 10_500_000 } } }, // 12,000,000 - 1,500,000
        positions: [{ ...PE_POS, qty: 1, avgCost: 1_462_500, cost: 1_462_500, price: null, value: null, unrealized: null, provisional: true, // 1,500,000 - 37,500
          manual: peM({ committed: 10_000_000, called: 1_500_000, uncalled: 8_500_000, feesCalled: 37_500, valuation: null }) }],
        pnl: { account: { fees: -37_500 } },
        nav: { account: 11_962_500, book: 19_962_500 }, // 10,500,000 cash + 1,462,500 at cost
        balance: { account: { cash: 10_500_000, positions: 1_462_500, assets: 11_962_500, netAssets: 11_962_500 } },
      },
    },
    { id: 'statement-q1-date', action: 'clock', to: '2026-05-15T14:00:00.000Z', expect: {} }, // Friday 15 May 2026
    {
      // The Q1 capital account statement arrives: our interest is worth 1,480,000 at 31 March 2026.
      id: 'valuation-q1', covers: 'valuation', action: 'lifecycle', lot: 'interest', body: { action: 'valuation', value: 1_480_000, asOf: '2026-03-31', source: 'Harrow Peak Q1 2026 capital account statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of HPCP7 entered by hand: 1,480,000.00 USD for the 1 held, as of 2026-03-31, source: Harrow Peak Q1 2026 capital account statement. A manual input, not a market quote', owner: 'account' }],
        positions: [{ ...PE_POS, qty: 1, avgCost: 1_462_500, cost: 1_462_500, price: 1_480_000, value: 1_480_000, unrealized: 17_500, provisional: false, priceSource: 'Manual entry', freshness: 'manual', // 1,480,000 - 1,462,500
          manual: peM({ committed: 10_000_000, called: 1_500_000, uncalled: 8_500_000, feesCalled: 37_500, valuation: { date: '2026-03-31', source: 'Harrow Peak Q1 2026 capital account statement', stale: false, reported: 1_480_000, rolledForward: 0 } }) }],
        pnl: { account: { unrealized: 17_500, total: -20_000 } }, // -37,500 + 17,500
        nav: { account: 11_980_000, book: 19_980_000 }, // 10,500,000 + 1,480,000
        provisional: { account: false, book: false }, // valued, 45 days old (limit 120)
        balance: { account: { positions: 1_480_000, assets: 11_980_000, netAssets: 11_980_000 } },
      },
    },
    { id: 'call-2-date', action: 'clock', to: '2026-06-01T14:00:00.000Z', expect: {} }, // Monday 1 June 2026
    {
      id: 'call-2', covers: 'capital call', action: 'lifecycle', lot: 'interest', body: { action: 'capital_call', amount: 2_500_000, feePortion: 37_500, note: 'Call notice 2: add-on for Corvel and Q2 fee' },
      expect: {
        events: [{ type: 'manual.capital_call', summary: 'Capital call on HPCP7 entered by hand: paid 2,500,000.00 USD (2,462,500.00 USD invested, 37,500.00 USD management fee); called 4,000,000.00 USD of 10,000,000.00 USD, uncalled 6,000,000.00 USD. Call notice 2: add-on for Corvel and Q2 fee', cash: { USD: -2_500_000 } }],
        cash: { account: { USD: { settled: 8_000_000, availableToTrade: 8_000_000 } } }, // 10,500,000 - 2,500,000
        // Rolled forward: the 31 March value 1,480,000 + 2,462,500 invested since = 3,942,500. Cost 1,462,500 + 2,462,500 = 3,925,000.
        positions: [{ ...PE_POS, qty: 1, avgCost: 3_925_000, cost: 3_925_000, price: 3_942_500, value: 3_942_500, unrealized: 17_500, provisional: false,
          manual: peM({ committed: 10_000_000, called: 4_000_000, uncalled: 6_000_000, feesCalled: 75_000, valuation: { date: '2026-03-31', source: 'Harrow Peak Q1 2026 capital account statement', stale: false, reported: 1_480_000, rolledForward: 2_462_500 } }) }],
        pnl: { account: { fees: -75_000, unrealized: 17_500, total: -57_500 } },
        nav: { account: 11_942_500, book: 19_942_500 }, // 8,000,000 + 3,942,500
        balance: { account: { cash: 8_000_000, positions: 3_942_500, assets: 11_942_500, netAssets: 11_942_500 } },
      },
    },
    {
      // Friday 14 August 2026: the 31 March valuation is 136 days old, past the 120-day limit, before the Q2 statement is entered.
      id: 'statement-q2-date', covers: 'valuation', action: 'clock', to: '2026-08-14T14:00:00.000Z',
      expect: {
        positions: [{ ...PE_POS, qty: 1, cost: 3_925_000, price: 3_942_500, value: 3_942_500, unrealized: 17_500, provisional: false, freshness: 'stale',
          manual: peM({ committed: 10_000_000, called: 4_000_000, uncalled: 6_000_000, feesCalled: 75_000, valuation: { date: '2026-03-31', source: 'Harrow Peak Q1 2026 capital account statement', stale: true, reported: 1_480_000, rolledForward: 2_462_500 } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      id: 'valuation-q2', covers: 'valuation', action: 'lifecycle', lot: 'interest', body: { action: 'valuation', value: 4_150_000, asOf: '2026-06-30', source: 'Harrow Peak Q2 2026 capital account statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of HPCP7 entered by hand: 4,150,000.00 USD for the 1 held, as of 2026-06-30, source: Harrow Peak Q2 2026 capital account statement. A manual input, not a market quote' }],
        // Nothing was called or distributed after 30 June: the value is the statement's.
        positions: [{ ...PE_POS, qty: 1, cost: 3_925_000, price: 4_150_000, value: 4_150_000, unrealized: 225_000, provisional: false, freshness: 'manual', // 4,150,000 - 3,925,000
          manual: peM({ committed: 10_000_000, called: 4_000_000, uncalled: 6_000_000, feesCalled: 75_000, valuation: { date: '2026-06-30', source: 'Harrow Peak Q2 2026 capital account statement', stale: false, reported: 4_150_000, rolledForward: 0 } }) }],
        pnl: { account: { unrealized: 225_000, total: 150_000 } }, // -75,000 + 225,000
        nav: { account: 12_150_000, book: 20_150_000 },
        provisional: { account: false, book: false }, // a current valuation again
        balance: { account: { positions: 4_150_000, assets: 12_150_000, netAssets: 12_150_000 } },
      },
    },
    { id: 'distribution-1-date', action: 'clock', to: '2026-09-14T14:00:00.000Z', expect: {} }, // Monday 14 September 2026
    {
      // Sale of Corvel Packaging: 600,000 return of capital, 450,000 gain, 50,000 income; 20% carry on the gain withheld (90,000).
      id: 'distribution-1', covers: 'distribution', action: 'lifecycle', lot: 'interest', body: { action: 'distribution', returnOfCapital: 600_000, realizedGain: 450_000, income: 50_000, carry: 90_000, note: 'Distribution notice 1: sale of Corvel Packaging' },
      expect: {
        events: [{ type: 'manual.distribution', summary: 'Distribution from HPCP7 entered by hand: 600,000.00 USD return of capital, 450,000.00 USD realized gain, 50,000.00 USD income, less 90,000.00 USD carried interest withheld; received 1,010,000.00 USD. Distribution notice 1: sale of Corvel Packaging', cash: { USD: 1_010_000 } }], // 1,100,000 - 90,000
        cash: { account: { USD: { settled: 9_010_000, availableToTrade: 9_010_000 } } }, // 8,000,000 + 1,010,000
        // Cost 3,925,000 - 600,000 = 3,325,000. Value rolled forward: 4,150,000 - 1,100,000 distributed since 30 June = 3,050,000.
        positions: [{ ...PE_POS, qty: 1, avgCost: 3_325_000, cost: 3_325_000, price: 3_050_000, value: 3_050_000, unrealized: -275_000,
          manual: peM({ committed: 10_000_000, called: 4_000_000, uncalled: 6_000_000, feesCalled: 75_000, returnOfCapital: 600_000, realizedGain: 450_000, income: 50_000, carry: 90_000,
            valuation: { date: '2026-06-30', source: 'Harrow Peak Q2 2026 capital account statement', stale: false, reported: 4_150_000, rolledForward: -1_100_000 } }) }],
        pnl: { account: { realized: 450_000, dividends: 50_000, fees: -165_000, unrealized: -275_000, total: 60_000 } }, // fees 75,000 + 90,000; 450,000 + 50,000 - 165,000 - 275,000
        nav: { account: 12_060_000, book: 20_060_000 }, // 9,010,000 + 3,050,000
        balance: { account: { cash: 9_010_000, positions: 3_050_000, assets: 12_060_000, netAssets: 12_060_000 } },
      },
    },
    {
      // Monday 2 November 2026 (standard time again: 10:00 New York is 15:00 UTC). The 30 June valuation is now 125 days old.
      id: 'valuation-stale', covers: 'valuation', action: 'clock', to: '2026-11-02T15:00:00.000Z',
      expect: {
        positions: [{ ...PE_POS, qty: 1, cost: 3_325_000, price: 3_050_000, value: 3_050_000, unrealized: -275_000, provisional: false, freshness: 'stale',
          manual: peM({ committed: 10_000_000, called: 4_000_000, uncalled: 6_000_000, feesCalled: 75_000, returnOfCapital: 600_000, realizedGain: 450_000, income: 50_000, carry: 90_000,
            valuation: { date: '2026-06-30', source: 'Harrow Peak Q2 2026 capital account statement', stale: true, reported: 4_150_000, rolledForward: -1_100_000 } }) }],
        provisional: { account: true, book: true }, // valued on a stale valuation: the figure stands, flagged provisional
      },
    },
    {
      // A quarter of the interest is sold to a secondary buyer at 3,200,000 for the whole interest (800,000 for the quarter);
      // the transfer closes on Friday 13 November 2026. The buyer takes over a quarter of the commitment and of what was called.
      id: 'secondary-sale', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 0.25, from: 'interest', order: { statedPrice: 3_200_000, settle: { date: '2026-11-13' } }, settlementCheck: false, // the transfer date is stated on the ticket
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.25, estimate: 3_200_000, model: 'stated-price', settleDate: '2026-11-13', cash: 800_000, fees: 0 }] }, // 0.25 x 3,200,000
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 0.25, avgPrice: 3_200_000 }] },
        // Cost removed 3,325,000 x 0.25 = 831,250; realized 800,000 - 831,250 = -31,250.
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 0.25 HPCP7 @ 3,200,000.00 USD (realized -31,250.00 USD)' }],
        cash: { account: { USD: { settled: 9_010_000, unsettled: 800_000, availableToTrade: 9_810_000 } } },
        // Remaining cost 2,493,750; value 0.75 x 3,050,000 = 2,287,500; called 4,000,000 x 0.75 = 3,000,000; committed 7,500,000.
        positions: [{ ...PE_POS, qty: 0.75, avgCost: 3_325_000, cost: 2_493_750, price: 3_050_000, value: 2_287_500, unrealized: -206_250, freshness: 'stale',
          manual: peM({ committed: 7_500_000, called: 3_000_000, uncalled: 4_500_000, feesCalled: 56_250, returnOfCapital: 600_000, realizedGain: 450_000, income: 50_000, carry: 90_000,
            valuation: { date: '2026-06-30', source: 'Harrow Peak Q2 2026 capital account statement', stale: true, reported: 4_150_000, rolledForward: -825_000 } }) }], // -1,100,000 per unit x 0.75
        holdings: { main: { long: 0.75, short: 0, net: 0.75 } },
        pending: [{ instrument: 'main', lot: 'interest', owner: 'account', dueDate: '2026-11-13', amount: 800_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 418_750, unrealized: -206_250, total: 97_500 } }, // 450,000 - 31,250; 418,750 + 50,000 - 165,000 - 206,250
        nav: { account: 12_097_500, book: 20_097_500 }, // 9,010,000 + 800,000 receivable + 2,287,500
        balance: { account: { cash: 9_010_000, receivable: 800_000, positions: 2_287_500, assets: 12_097_500, netAssets: 12_097_500 } },
      },
    },
    {
      id: 'over-call', covers: 'capital call', action: 'lifecycle', lot: 'interest', body: { action: 'capital_call', amount: 5_000_000, feePortion: 0 },
      status: 'blocked', reason: 'After the secondary sale 4,500,000 of the commitment is uncalled; a call of 5,000,000 cannot be met from it.',
      expect: { refused: 'Only 4,500,000.00 USD of the commitment is uncalled' },
    },
    {
      id: 'sale-settles', covers: 'settlement', action: 'clock', to: '2026-11-13T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 800,000.00 USD into settled cash', cash: { USD: 800_000 }, date: '2026-11-13' }],
        cash: { account: { USD: { settled: 9_810_000, unsettled: 0, availableToTrade: 9_810_000 } } },
        pending: [],
        balance: { account: { cash: 9_810_000, receivable: null } },
      },
    },
    { id: 'statement-q3-date', action: 'clock', to: '2026-11-16T15:00:00.000Z', expect: {} }, // Monday 16 November 2026
    {
      // Q3 statement for our three quarters: 2,400,000 at 30 September (3,200,000 a whole interest). Nothing called or distributed since.
      id: 'valuation-q3', covers: 'valuation', action: 'lifecycle', lot: 'interest', body: { action: 'valuation', value: 2_400_000, asOf: '2026-09-30', source: 'Harrow Peak Q3 2026 capital account statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of HPCP7 entered by hand: 2,400,000.00 USD for the 0.75 held (3,200,000.00 value of the whole interest), as of 2026-09-30, source: Harrow Peak Q3 2026 capital account statement. A manual input, not a market quote' }],
        positions: [{ ...PE_POS, qty: 0.75, cost: 2_493_750, price: 3_200_000, value: 2_400_000, unrealized: -93_750, freshness: 'manual', // 2,400,000 - 2,493,750
          manual: peM({ committed: 7_500_000, called: 3_000_000, uncalled: 4_500_000, feesCalled: 56_250, returnOfCapital: 600_000, realizedGain: 450_000, income: 50_000, carry: 90_000,
            valuation: { date: '2026-09-30', source: 'Harrow Peak Q3 2026 capital account statement', stale: false, reported: 3_200_000, rolledForward: 0 } }) }],
        pnl: { account: { unrealized: -93_750, total: 210_000 } }, // 418,750 + 50,000 - 165,000 - 93,750
        nav: { account: 12_210_000, book: 20_210_000 }, // 9,810,000 + 2,400,000
        provisional: { account: false, book: false },
        balance: { account: { positions: 2_400_000, assets: 12_210_000, netAssets: 12_210_000 } },
      },
    },
    { id: 'final-date', action: 'clock', to: '2026-12-01T15:00:00.000Z', expect: {} }, // Tuesday 1 December 2026
    {
      // The last companies are sold: 2,100,000 return of capital and 300,000 gain (2,400,000, the 30 September value); 20% carry on the gain.
      id: 'distribution-final', covers: 'distribution', action: 'lifecycle', lot: 'interest', body: { action: 'distribution', returnOfCapital: 2_100_000, realizedGain: 300_000, carry: 60_000, note: 'Distribution notice 2: final realisations' },
      expect: {
        events: [{ type: 'manual.distribution', summary: 'Distribution from HPCP7 entered by hand: 2,100,000.00 USD return of capital, 300,000.00 USD realized gain, less 60,000.00 USD carried interest withheld; received 2,340,000.00 USD. Distribution notice 2: final realisations', cash: { USD: 2_340_000 } }],
        cash: { account: { USD: { settled: 12_150_000, availableToTrade: 12_150_000 } } }, // 9,810,000 + 2,340,000
        // Cost 2,493,750 - 2,100,000 = 393,750. Value 2,400,000 - 2,400,000 distributed since 30 September = 0.
        positions: [{ ...PE_POS, qty: 0.75, avgCost: 525_000, cost: 393_750, price: 0, value: 0, unrealized: -393_750, // 393,750 / 0.75
          manual: peM({ committed: 7_500_000, called: 3_000_000, uncalled: 4_500_000, feesCalled: 56_250, returnOfCapital: 2_700_000, realizedGain: 750_000, income: 50_000, carry: 150_000,
            valuation: { date: '2026-09-30', source: 'Harrow Peak Q3 2026 capital account statement', stale: false, reported: 3_200_000, rolledForward: -2_400_000 } }) }],
        pnl: { account: { realized: 718_750, fees: -225_000, unrealized: -393_750, total: 150_000 } }, // 418,750 + 300,000; 165,000 + 60,000; 718,750 + 50,000 - 225,000 - 393,750
        nav: { account: 12_150_000, book: 20_150_000 },
        balance: { account: { cash: 12_150_000, positions: null, assets: 12_150_000, netAssets: 12_150_000 } }, // a line that sums to 0.00 (cost 393,750, unrealized -393,750) is not shown
      },
    },
    {
      // The fund is wound up: the 393,750 of cost left is realized as a loss and the 4,500,000 never called is released.
      id: 'wind-up', covers: 'close', action: 'lifecycle', lot: 'interest', body: { action: 'wind_up', note: 'Final distribution notice; fund dissolved' },
      expect: {
        events: [{ type: 'manual.wind_up', summary: 'Final realisation of HPCP7 entered by hand: the fund is wound up; remaining cost 393,750.00 USD realized, uncalled commitment of 4,500,000.00 USD released. Final distribution notice; fund dissolved', owner: 'account' }],
        positions: [],
        holdings: { main: null },
        pending: [],
        // Over the life: 4,000,000 called; 1,010,000 + 800,000 + 2,340,000 = 4,150,000 received; net +150,000 = the P&L total.
        pnl: { account: { realized: 325_000, dividends: 50_000, fees: -225_000, unrealized: 0, total: 150_000 } }, // 718,750 - 393,750
        nav: { account: 12_150_000, book: 20_150_000 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 12_150_000, positions: null, assets: 12_150_000, liabilities: 0, netAssets: 12_150_000 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// venture_capital
// ---------------------------------------------------------------------------------------------
// A EUR 3,000,000 commitment to a Luxembourg venture fund, held by the Account of a US dollar Book (EUR/USD from a
// labelled fixture: 1.10, then 1.12, then 1.08). Two calls, an expense billed outside the calls, a down valuation, a
// distribution from an exit with no carry (below the hurdle), a valuation that goes stale, a later write-down, the final
// distribution and the wind-up writing off the cost left. The Lifecycle menu does not offer a redemption notice (a
// closed-end fund interest cannot be redeemed): refused. Reporting-currency figures: every EUR entry is converted at the
// rate in force when it is posted; the FX effect is the change of the EUR balances at the current rate.
// The interest is held across Good Friday (3 April) and Easter Monday (6 April 2026), TARGET closing days.
const VC_START = { cash: { account: { EUR: { settled: 4_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 4_000_000 } }, treasury: { EUR: { settled: 2_000_000 }, USD: { settled: 5_000_000 } } },
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], nav: { account: 4_400_000, treasury: 7_200_000, book: 11_600_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } };
// Account NAV 4,000,000 EUR x 1.10; Treasury 5,000,000 USD + 2,000,000 EUR x 1.10.
const VC_POS = { instrument: 'main', lot: 'fund', owner: 'account', direction: 'committed' };
const vcM = (o) => ({ kind: 'commitment', returnOfCapital: 0, realizedGain: 0, income: 0, carry: 0, expenses: 0, ...o });
const VC_Q2 = { date: '2026-06-30', source: 'Nordlicht Q2 2026 quarterly report', stale: false, reported: 840_000 };
const VC_Q3 = { date: '2026-09-30', source: 'Nordlicht Q3 2026 quarterly report', stale: false, reported: 1_350_000 };
const ventureCapital = {
  productId: 'venture_capital',
  title: 'Nordlicht Ventures Fund III (Luxembourg): EUR 3,000,000 commitment in a USD Book, calls, write-downs, an exit and the wind-up, by hand',
  matrix: {
    ...MANUAL_TICKET,
    requiredFields: ['Trading owner', 'Action (Commit or acquire)', 'Share of the interest', 'State a fill price', 'Commitment (registration)', 'Valuation goes stale after (registration)'],
    manualInputs: ['commitment and fund terms at registration', 'capital calls with their management-fee part', 'fund expenses billed outside the calls', 'valuations with date and source', 'distributions (return of capital, realized gain)', 'final wind-up'],
    settlement: 'Calls, expenses and distributions in EUR cash when recorded; nothing waits for settlement',
    lifecycle: 'Nothing automated; calls, valuations, distributions and the wind-up by hand. A redemption notice is not offered (closed-end fund)',
    accounting: 'In EUR, reported in USD at the fixture rate in force when each entry is posted; FX effect on the EUR balances at the current rate; cost, fees, realized and unrealized as for private equity',
    collateral: 'None: a fund interest held long',
  },
  start: '2026-04-01T14:00:00.000Z', // Wednesday 1 April 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: ['2026-04-03', '2026-04-06'] }, // TARGET: Good Friday and Easter Monday
  book: { name: 'Matrix venture capital', reportingCcy: 'USD', capital: [{ ccy: 'USD', amount: 5_000_000 }, { ccy: 'EUR', amount: 6_000_000 }], account: { name: 'Alpha', funding: [{ ccy: 'EUR', amount: 4_000_000 }] }, settings: SETTINGS },
  fx: { 'EUR/USD': 1.10 },
  instruments: {
    main: { productId: 'venture_capital', name: 'Nordlicht Ventures Fund III SCSp', symbol: 'NLVF3', marketView: 'FOREIGN_CASH', venueType: 'otc', issuer: 'Nordlicht Ventures S.a r.l.', domicile: 'LU', underlyingGeo: 'Europe', tradingCcy: 'EUR',
      terms: { commitment: 3_000_000, vintage: 2025, manager: 'Nordlicht Ventures S.a r.l.', strategy: 'Seed and Series A, European software', valuationMaxAgeDays: 100 } },
  },
  expectAtStart: VC_START,
  steps: [
    {
      id: 'commit', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1, as: 'fund', order: { statedPrice: 0 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1, estimate: 0, model: 'stated-price', settleDate: '2026-04-07', calendar: 'TARGET', cash: 0, fees: 0 }] }, // T+2 on TARGET: Friday 3 and Monday 6 April are closed
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1, avgPrice: 0 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 NLVF3 @ 0.00 EUR', owner: 'account', date: '2026-04-01' }],
        positions: [{ ...VC_POS, qty: 1, avgCost: 0, cost: 0, price: null, value: null, unrealized: null, provisional: true, freshness: null, manual: vcM({ committed: 3_000_000, called: 0, uncalled: 3_000_000, feesCalled: 0, valuation: null }) }],
        holdings: { main: { long: 1, short: 0, net: 1 } },
        pending: [],
        pnl: { account: { realized: 0, fees: 0, fx: 0 } },
        nav: { account: 4_400_000, book: 11_600_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 4_400_000, assets: 4_400_000, liabilities: 0, netAssets: 4_400_000, local: { EUR: { cash: 4_000_000 } } } },
      },
    },
    { id: 'after-easter', action: 'clock', to: '2026-04-07T14:00:00.000Z', expect: {} }, // Tuesday 7 April 2026, after the TARGET Easter closing days
    {
      // 900,000 called, 15,000 of it the quarterly fee (2% a year of 3,000,000 / 4). Posted at 1.10.
      id: 'call-1', covers: 'capital call', action: 'lifecycle', lot: 'fund', body: { action: 'capital_call', amount: 900_000, feePortion: 15_000, note: 'Drawdown 1' },
      expect: {
        events: [{ type: 'manual.capital_call', summary: 'Capital call on NLVF3 entered by hand: paid 900,000.00 EUR (885,000.00 EUR invested, 15,000.00 EUR management fee); called 900,000.00 EUR of 3,000,000.00 EUR, uncalled 2,100,000.00 EUR. Drawdown 1', cash: { EUR: -900_000 }, owner: 'account' }],
        cash: { account: { EUR: { settled: 3_100_000, availableToTrade: 3_100_000 } } },
        positions: [{ ...VC_POS, qty: 1, avgCost: 885_000, cost: 885_000, price: null, value: null, unrealized: null, provisional: true, manual: vcM({ committed: 3_000_000, called: 900_000, uncalled: 2_100_000, feesCalled: 15_000, valuation: null }) }],
        pnl: { account: { fees: -16_500 } }, // 15,000 x 1.10
        nav: { account: 4_383_500, book: 11_583_500 }, // (3,100,000 + 885,000 at cost) x 1.10
        balance: { account: { cash: 3_410_000, positions: 973_500, assets: 4_383_500, netAssets: 4_383_500, local: { EUR: { cash: 3_100_000, positions: 885_000 } } } },
      },
    },
    {
      id: 'fund-expense', covers: 'fee', action: 'lifecycle', lot: 'fund', body: { action: 'expense', kind: 'other', amount: 6_000, note: 'Organisational expenses billed to investors' },
      expect: {
        events: [{ type: 'manual.expense', summary: 'Expense on NLVF3 entered by hand: paid 6,000.00 EUR. Organisational expenses billed to investors', cash: { EUR: -6_000 } }],
        cash: { account: { EUR: { settled: 3_094_000, availableToTrade: 3_094_000 } } },
        positions: [{ ...VC_POS, qty: 1, cost: 885_000, value: null, provisional: true, manual: vcM({ committed: 3_000_000, called: 900_000, uncalled: 2_100_000, feesCalled: 15_000, expenses: 6_000, valuation: null }) }],
        pnl: { account: { fees: -23_100 } }, // -16,500 - 6,000 x 1.10
        nav: { account: 4_376_900, book: 11_576_900 }, // (3,094,000 + 885,000) x 1.10
        balance: { account: { cash: 3_403_400, assets: 4_376_900, netAssets: 4_376_900, local: { EUR: { cash: 3_094_000 } } } },
      },
    },
    {
      id: 'redemption-not-offered', covers: 'redeem', action: 'lifecycle', lot: 'fund', body: { action: 'redemption_notice', shares: 1 },
      status: 'unsupported', reason: 'A closed-end venture fund interest has no redemption: it ends with the fund\'s wind-up, or is sold on the secondary market.',
      expect: { refused: { engine: 'is not recorded for NLVF3', api: 'is not recorded for NLVF3', browser: 'offers only' } },
    },
    {
      // EUR/USD 1.12 (fixture). EUR balances 3,094,000 cash and 885,000 at cost = 3,979,000 x 1.12 = 4,456,480; posted at 4,376,900.
      id: 'eur-up', action: 'fx_rate', pair: 'EUR/USD', rate: 1.12,
      expect: {
        nav: { account: 4_456_480, treasury: 7_240_000, book: 11_696_480 }, // Treasury 5,000,000 + 2,000,000 x 1.12
        pnl: { account: { fx: 79_580, total: 56_480 } }, // 4,456,480 - 4,376,900; -23,100 + 79,580
        balance: { account: { cash: 3_465_280, positions: 991_200, assets: 4_456_480, netAssets: 4_456_480 } }, // 3,094,000 x 1.12; 885,000 x 1.12
      },
    },
    { id: 'statement-q2-date', action: 'clock', to: '2026-08-17T14:00:00.000Z', expect: {} }, // Monday 17 August 2026
    {
      // The Q2 report values the interest at 840,000 at 30 June (a portfolio company written down).
      id: 'valuation-q2', covers: 'valuation', action: 'lifecycle', lot: 'fund', body: { action: 'valuation', value: 840_000, asOf: '2026-06-30', source: 'Nordlicht Q2 2026 quarterly report' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of NLVF3 entered by hand: 840,000.00 EUR for the 1 held, as of 2026-06-30, source: Nordlicht Q2 2026 quarterly report. A manual input, not a market quote' }],
        positions: [{ ...VC_POS, qty: 1, cost: 885_000, price: 840_000, value: 840_000, unrealized: -45_000, provisional: false, freshness: 'manual', priceSource: 'Manual entry',
          manual: vcM({ committed: 3_000_000, called: 900_000, uncalled: 2_100_000, feesCalled: 15_000, expenses: 6_000, valuation: { ...VC_Q2, rolledForward: 0 } }) }],
        pnl: { account: { unrealized: -50_400, total: 6_080 } }, // -45,000 x 1.12; -23,100 - 50,400 + 79,580
        nav: { account: 4_406_080, book: 11_646_080 }, // (3,094,000 + 840,000) x 1.12
        provisional: { account: false, book: false },
        balance: { account: { positions: 940_800, assets: 4_406_080, netAssets: 4_406_080, local: { EUR: { positions: 840_000 } } } },
      },
    },
    { id: 'call-2-date', action: 'clock', to: '2026-09-01T14:00:00.000Z', expect: {} }, // Tuesday 1 September 2026; the 30 June valuation is 63 days old
    {
      id: 'call-2', covers: 'capital call', action: 'lifecycle', lot: 'fund', body: { action: 'capital_call', amount: 600_000, feePortion: 15_000, note: 'Drawdown 2' },
      expect: {
        events: [{ type: 'manual.capital_call', summary: 'Capital call on NLVF3 entered by hand: paid 600,000.00 EUR (585,000.00 EUR invested, 15,000.00 EUR management fee); called 1,500,000.00 EUR of 3,000,000.00 EUR, uncalled 1,500,000.00 EUR. Drawdown 2', cash: { EUR: -600_000 } }],
        cash: { account: { EUR: { settled: 2_494_000, availableToTrade: 2_494_000 } } },
        // Cost 885,000 + 585,000 = 1,470,000; value rolled forward 840,000 + 585,000 = 1,425,000.
        positions: [{ ...VC_POS, qty: 1, avgCost: 1_470_000, cost: 1_470_000, price: 1_425_000, value: 1_425_000, unrealized: -45_000,
          manual: vcM({ committed: 3_000_000, called: 1_500_000, uncalled: 1_500_000, feesCalled: 30_000, expenses: 6_000, valuation: { ...VC_Q2, rolledForward: 585_000 } }) }],
        pnl: { account: { fees: -39_900, unrealized: -50_400, total: -10_720 } }, // -23,100 - 15,000 x 1.12; -39,900 - 50,400 + 79,580
        nav: { account: 4_389_280, book: 11_629_280 }, // (2,494,000 + 1,425,000) x 1.12
        balance: { account: { cash: 2_793_280, positions: 1_596_000, assets: 4_389_280, netAssets: 4_389_280, local: { EUR: { cash: 2_494_000, positions: 1_425_000 } } } }, // 2,494,000 x 1.12; 1,425,000 x 1.12
      },
    },
    {
      // Monday 19 October 2026: the 30 June valuation is 111 days old, past the 100-day limit.
      id: 'valuation-stale', covers: 'valuation', action: 'clock', to: '2026-10-19T14:00:00.000Z',
      expect: {
        positions: [{ ...VC_POS, qty: 1, cost: 1_470_000, price: 1_425_000, value: 1_425_000, unrealized: -45_000, freshness: 'stale',
          manual: vcM({ committed: 3_000_000, called: 1_500_000, uncalled: 1_500_000, feesCalled: 30_000, expenses: 6_000, valuation: { ...VC_Q2, stale: true, rolledForward: 585_000 } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      // An exit: 300,000 return of capital and 200,000 gain; no carry (the fund is below its hurdle). Posted at 1.12.
      id: 'distribution-exit', covers: 'distribution', action: 'lifecycle', lot: 'fund', body: { action: 'distribution', returnOfCapital: 300_000, realizedGain: 200_000, note: 'Sale of Kantwerk GmbH' },
      expect: {
        events: [{ type: 'manual.distribution', summary: 'Distribution from NLVF3 entered by hand: 300,000.00 EUR return of capital, 200,000.00 EUR realized gain; received 500,000.00 EUR. Sale of Kantwerk GmbH', cash: { EUR: 500_000 } }],
        cash: { account: { EUR: { settled: 2_994_000, availableToTrade: 2_994_000 } } },
        // Cost 1,470,000 - 300,000 = 1,170,000; value 840,000 + 585,000 - 500,000 = 925,000.
        positions: [{ ...VC_POS, qty: 1, avgCost: 1_170_000, cost: 1_170_000, price: 925_000, value: 925_000, unrealized: -245_000, freshness: 'stale',
          manual: vcM({ committed: 3_000_000, called: 1_500_000, uncalled: 1_500_000, feesCalled: 30_000, expenses: 6_000, returnOfCapital: 300_000, realizedGain: 200_000, valuation: { ...VC_Q2, stale: true, rolledForward: 85_000 } }) }], // 585,000 - 500,000
        pnl: { account: { realized: 224_000, unrealized: -274_400, total: -10_720 } }, // 200,000 x 1.12; -245,000 x 1.12; 224,000 - 39,900 - 274,400 + 79,580
        nav: { account: 4_389_280, book: 11_629_280 }, // (2,994,000 + 925,000) x 1.12
        balance: { account: { cash: 3_353_280, positions: 1_036_000, assets: 4_389_280, netAssets: 4_389_280, local: { EUR: { cash: 2_994_000, positions: 925_000 } } } }, // 2,994,000 x 1.12; 925,000 x 1.12
      },
    },
    {
      // EUR/USD 1.08. EUR cash 2,994,000 was posted at 3,291,400 (4,400,000 - 990,000 - 6,600 - 672,000 + 560,000); the 1,170,000 of
      // cost at 1,292,700 (973,500 + 655,200 - 336,000). Translation: 2,994,000 x 1.08 - 3,291,400 = -57,880; 1,170,000 x 1.08 - 1,292,700 = -29,100.
      id: 'eur-down', action: 'fx_rate', pair: 'EUR/USD', rate: 1.08,
      expect: {
        nav: { account: 4_232_520, treasury: 7_160_000, book: 11_392_520 }, // 3,919,000 x 1.08; 5,000,000 + 2,160,000
        pnl: { account: { realized: 224_000, fees: -39_900, unrealized: -264_600, fx: -86_980, total: -167_480 } }, // -245,000 x 1.08
        balance: { account: { cash: 3_233_520, positions: 999_000, assets: 4_232_520, netAssets: 4_232_520 } }, // 2,994,000 x 1.08; 925,000 x 1.08
      },
    },
    { id: 'statement-q3-date', action: 'clock', to: '2026-11-16T15:00:00.000Z', expect: {} }, // Monday 16 November 2026, 10:00 New York (standard time)
    {
      // The Q3 report: 1,350,000 at 30 September. The October distribution of 500,000 came after it: value 850,000.
      id: 'valuation-q3', covers: 'valuation', action: 'lifecycle', lot: 'fund', body: { action: 'valuation', value: 1_350_000, asOf: '2026-09-30', source: 'Nordlicht Q3 2026 quarterly report' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of NLVF3 entered by hand: 1,350,000.00 EUR for the 1 held, as of 2026-09-30, source: Nordlicht Q3 2026 quarterly report. A manual input, not a market quote' }],
        positions: [{ ...VC_POS, qty: 1, cost: 1_170_000, price: 850_000, value: 850_000, unrealized: -320_000, freshness: 'manual',
          manual: vcM({ committed: 3_000_000, called: 1_500_000, uncalled: 1_500_000, feesCalled: 30_000, expenses: 6_000, returnOfCapital: 300_000, realizedGain: 200_000, valuation: { ...VC_Q3, rolledForward: -500_000 } }) }],
        pnl: { account: { unrealized: -345_600, total: -248_480 } }, // -320,000 x 1.08; 224,000 - 39,900 - 345,600 - 86,980
        nav: { account: 4_151_520, book: 11_311_520 }, // (2,994,000 + 850,000) x 1.08
        provisional: { account: false, book: false },
        balance: { account: { positions: 918_000, assets: 4_151_520, netAssets: 4_151_520, local: { EUR: { positions: 850_000 } } } },
      },
    },
    { id: 'final-date', action: 'clock', to: '2026-12-15T15:00:00.000Z', expect: {} }, // Tuesday 15 December 2026
    {
      id: 'distribution-final', covers: 'distribution', action: 'lifecycle', lot: 'fund', body: { action: 'distribution', returnOfCapital: 850_000, note: 'Final distribution: sale of the remaining portfolio' },
      expect: {
        events: [{ type: 'manual.distribution', summary: 'Distribution from NLVF3 entered by hand: 850,000.00 EUR return of capital; received 850,000.00 EUR. Final distribution: sale of the remaining portfolio', cash: { EUR: 850_000 } }],
        cash: { account: { EUR: { settled: 3_844_000, availableToTrade: 3_844_000 } } },
        positions: [{ ...VC_POS, qty: 1, avgCost: 320_000, cost: 320_000, price: 0, value: 0, unrealized: -320_000,
          manual: vcM({ committed: 3_000_000, called: 1_500_000, uncalled: 1_500_000, feesCalled: 30_000, expenses: 6_000, returnOfCapital: 1_150_000, realizedGain: 200_000, valuation: { ...VC_Q3, rolledForward: -1_350_000 } }) }],
        pnl: { account: { total: -248_480 } },
        nav: { account: 4_151_520, book: 11_311_520 }, // 3,844,000 x 1.08
        balance: { account: { cash: 4_151_520, positions: null, assets: 4_151_520, netAssets: 4_151_520, local: { EUR: { cash: 3_844_000, positions: null } } } },
      },
    },
    {
      // The fund is wound up: 320,000 of cost written off (345,600 at 1.08); 1,500,000 never called is released.
      id: 'wind-up', covers: 'close', action: 'lifecycle', lot: 'fund', body: { action: 'wind_up' },
      expect: {
        events: [{ type: 'manual.wind_up', summary: 'Final realisation of NLVF3 entered by hand: the fund is wound up; remaining cost 320,000.00 EUR realized, uncalled commitment of 1,500,000.00 EUR released', owner: 'account' }],
        positions: [],
        holdings: { main: null },
        // Translation now: cash 3,844,000 x 1.08 - 4,209,400 posted = -57,880; the cost account (now 0) carries -29,100: FX -86,980.
        pnl: { account: { realized: -121_600, fees: -39_900, unrealized: 0, fx: -86_980, total: -248_480 } }, // 224,000 - 345,600
        nav: { account: 4_151_520, book: 11_311_520 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 4_151_520, positions: null, assets: 4_151_520, liabilities: 0, netAssets: 4_151_520, local: { EUR: { cash: 3_844_000 } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// hedge_fund
// ---------------------------------------------------------------------------------------------
// Class A USD shares of a Cayman global macro fund: subscribed at the dealing NAV on the ticket, monthly NAVs entered by
// hand from the administrator's statements (stale after 35 days), a lock-up to 31 March 2026, and a full redemption by
// notice: 45 days' notice before a quarter end, an investor-level gate of 50% of the shares held at the first dealing
// date, proceeds 10 business days after the dealing date on the USD payment calendar (Federal Reserve holidays: the
// second payment is counted across Columbus Day, 12 October 2026). The ticket's Redeem is refused: redemption is by notice.
// Management and performance fees are inside the NAV the administrator strikes; nothing is charged apart.
const HF_POS = { instrument: 'main', lot: 'shares', owner: 'account', direction: 'long' };
const hfM = (o) => ({ kind: 'fund_interest', redemptions: [], noticed: 0, expenses: 0, ...o });
const HF_NOTICE = [{ noticeDate: '2026-04-13', dealingDate: '2026-06-30', shares: 2000 }];
const hedgeFund = {
  productId: 'hedge_fund',
  title: 'Kestrel Point Global Macro Fund (Cayman), Class A USD: subscription at NAV, monthly NAVs by hand, lock-up, notice, 50% investor gate, redemption over two quarters',
  matrix: {
    ...MANUAL_TICKET,
    requiredFields: ['Trading owner', 'Action (Subscribe)', 'Shares', 'State a fill price (the dealing NAV)', 'Dealing frequency, notice, payment days (registration)', 'Valuation goes stale after (registration)'],
    manualInputs: ['subscription NAV (stated fill price)', 'monthly NAV per share with date and source', 'redemption notice (shares)', 'NAV per share struck for each dealing date'],
    automaticInputs: [...MANUAL_TICKET.automaticInputs, 'dealing date from the notice period and the dealing frequency', 'gate cap and the shares carried to the next dealing date', 'payment date of redemption proceeds on the payment calendar'],
    settlement: 'Subscription T+2 on the USD payment calendar; redemption proceeds 10 business days after the dealing date (14 July and 15 October 2026)',
    lifecycle: 'Redemption only by notice: dealt on the first quarter end at least 45 days after the notice, at most 50% of the shares held at the first dealing date each time; each dealing date waits (blocked, visible) until its NAV is entered by hand. Lock-up refused before 31 March 2026; a sale on the ticket is refused',
    accounting: 'Average cost per share; realized P&L on each redemption at the dealing NAV; valued at the latest NAV per share, stale after 35 days (NAV provisional)',
    collateral: 'None: a fund interest held long',
  },
  start: '2026-02-02T15:00:00.000Z', // Monday 2 February 2026, 10:00 New York
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: 'Matrix hedge fund', reportingCcy: 'USD', capital: [{ ccy: 'USD', amount: 6_000_000 }], account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 4_000_000 }] }, settings: SETTINGS },
  instruments: {
    main: { productId: 'hedge_fund', name: 'Kestrel Point Global Macro Fund Ltd, Class A USD', symbol: 'KPGM-A', marketView: 'FOREIGN_CASH', venueType: 'otc', issuer: 'Kestrel Point Global Macro Fund Ltd', domicile: 'KY', underlyingGeo: 'Global', tradingCcy: 'USD',
      terms: { manager: 'Kestrel Point Capital Management LP', dealingFrequency: 'quarterly', noticeDays: 45, gatePct: 0.5, paymentDays: 10, lockupUntil: '2026-03-31', valuationMaxAgeDays: 35 } },
  },
  expectAtStart: { cash: { account: { USD: { settled: 4_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 4_000_000 } }, treasury: { USD: { settled: 2_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], nav: { account: 4_000_000, treasury: 2_000_000, book: 6_000_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    {
      // 2,000 shares at the 30 January dealing NAV of 1,250.00 = 2,500,000.
      id: 'subscribe', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 2000, as: 'shares', order: { statedPrice: 1250 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 2000, estimate: 1250, model: 'stated-price', settleDate: '2026-02-04', calendar: 'USD', cash: -2_500_000, fees: 0 }],
          cash: { USD: { purchases: 2_500_000, fees: 0, required: 2_500_000, available: 4_000_000, shortfall: 0 } } },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 2000, avgPrice: 1250 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 2,000 KPGM-A @ 1,250.00 USD', owner: 'account', date: '2026-02-02' }],
        cash: { account: { USD: { settled: 4_000_000, unsettled: -2_500_000, availableToTrade: 1_500_000 } } },
        positions: [{ ...HF_POS, qty: 2000, avgCost: 1250, cost: 2_500_000, price: null, value: null, unrealized: null, provisional: true, freshness: null, manual: hfM({ valuation: null }) }],
        holdings: { main: { long: 2000, short: 0, net: 2000 } },
        pending: [{ instrument: 'main', lot: 'shares', owner: 'account', dueDate: '2026-02-04', amount: -2_500_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 0, fees: 0, commissions: 0 } },
        nav: { account: 4_000_000, book: 6_000_000 }, // carried at cost until a NAV is entered
        provisional: { account: true, book: true },
        balance: { account: { cash: 4_000_000, positions: 2_500_000, payable: 2_500_000, assets: 6_500_000, liabilities: 2_500_000, netAssets: 4_000_000 } },
      },
    },
    {
      id: 'settle-subscription', covers: 'settlement', action: 'clock', to: '2026-02-04T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 2,500,000.00 USD from settled cash', cash: { USD: -2_500_000 }, date: '2026-02-04' }],
        cash: { account: { USD: { settled: 1_500_000, unsettled: 0, availableToTrade: 1_500_000 } } },
        pending: [],
        balance: { account: { cash: 1_500_000, payable: null, assets: 4_000_000, liabilities: 0 } },
      },
    },
    { id: 'february-statement-date', action: 'clock', to: '2026-03-16T14:00:00.000Z', expect: {} }, // Monday 16 March 2026
    {
      id: 'valuation-feb', covers: 'valuation', action: 'lifecycle', lot: 'shares', body: { action: 'valuation', value: 1275.50, asOf: '2026-02-27', source: 'Harbourside Fund Services, February 2026 NAV statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of KPGM-A entered by hand: 1,275.50 NAV per share, as of 2026-02-27, source: Harbourside Fund Services, February 2026 NAV statement. A manual input, not a market quote', owner: 'account' }],
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, price: 1275.5, value: 2_551_000, unrealized: 51_000, provisional: false, freshness: 'manual', priceSource: 'Manual entry', // 2,000 x 1,275.50
          manual: hfM({ valuation: { date: '2026-02-27', source: 'Harbourside Fund Services, February 2026 NAV statement', stale: false } }) }],
        pnl: { account: { unrealized: 51_000, total: 51_000 } },
        nav: { account: 4_051_000, book: 6_051_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 2_551_000, assets: 4_051_000, netAssets: 4_051_000 } },
      },
    },
    {
      id: 'sale-on-ticket', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 500, from: 'shares', order: { statedPrice: 1275.5 },
      status: 'unsupported', reason: 'A hedge fund interest is redeemed by notice on the fund\'s dealing dates, not sold.',
      expect: { refused: 'is redeemed through a redemption notice' },
    },
    {
      id: 'notice-in-lockup', covers: 'redeem', action: 'lifecycle', lot: 'shares', body: { action: 'redemption_notice', shares: 500 },
      status: 'blocked', reason: 'The shares are locked up until 31 March 2026.',
      expect: { refused: 'locked up until 2026-03-31' },
    },
    {
      // Monday 13 April 2026: the February NAV (27 February) is 45 days old, past the 35-day limit.
      id: 'march-statement-date', covers: 'valuation', action: 'clock', to: '2026-04-13T14:00:00.000Z',
      expect: {
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, price: 1275.5, value: 2_551_000, unrealized: 51_000, freshness: 'stale',
          manual: hfM({ valuation: { date: '2026-02-27', source: 'Harbourside Fund Services, February 2026 NAV statement', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      id: 'valuation-mar', covers: 'valuation', action: 'lifecycle', lot: 'shares', body: { action: 'valuation', value: 1301.25, asOf: '2026-03-31', source: 'Harbourside Fund Services, March 2026 NAV statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of KPGM-A entered by hand: 1,301.25 NAV per share, as of 2026-03-31, source: Harbourside Fund Services, March 2026 NAV statement. A manual input, not a market quote' }],
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, price: 1301.25, value: 2_602_500, unrealized: 102_500, freshness: 'manual', // 2,000 x 1,301.25
          manual: hfM({ valuation: { date: '2026-03-31', source: 'Harbourside Fund Services, March 2026 NAV statement', stale: false } }) }],
        pnl: { account: { unrealized: 102_500, total: 102_500 } },
        nav: { account: 4_102_500, book: 6_102_500 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 2_602_500, assets: 4_102_500, netAssets: 4_102_500 } },
      },
    },
    {
      // Notice on 13 April + 45 days = 28 May: dealt on the quarter end, Tuesday 30 June 2026.
      id: 'notice', covers: 'redeem', action: 'lifecycle', lot: 'shares', body: { action: 'redemption_notice', shares: 2000, note: 'Full redemption' },
      expect: {
        events: [{ type: 'manual.redemption_notice', summary: "Redemption notice for 2,000 shares of KPGM-A entered by hand on 2026-04-13: 45 days' notice, quarterly dealing, so it is dealt on 2026-06-30 (gate 50% of the holding per dealing date). Full redemption", owner: 'account' }],
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, value: 2_602_500, manual: hfM({ redemptions: HF_NOTICE, noticed: 2000, valuation: { date: '2026-03-31', source: 'Harbourside Fund Services, March 2026 NAV statement', stale: false } }) }],
        lifecycle: [{ type: 'manual.redemption', instrument: 'main', dueDate: '2026-06-30', status: 'pending', owner: 'account' }],
      },
    },
    {
      id: 'over-notice', covers: 'redeem', action: 'lifecycle', lot: 'shares', body: { action: 'redemption_notice', shares: 1 },
      status: 'blocked', reason: 'All 2,000 shares are already under notice.',
      expect: { refused: '2,000 shares are held and 2,000 are already under notice' },
    },
    {
      // Monday 11 May 2026: the March NAV (31 March) is 41 days old, past the 35-day limit, until the April NAV is entered.
      id: 'april-statement-date', covers: 'valuation', action: 'clock', to: '2026-05-11T14:00:00.000Z',
      expect: {
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, value: 2_602_500, freshness: 'stale', manual: hfM({ redemptions: HF_NOTICE, noticed: 2000, valuation: { date: '2026-03-31', source: 'Harbourside Fund Services, March 2026 NAV statement', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      id: 'valuation-apr', covers: 'valuation', action: 'lifecycle', lot: 'shares', body: { action: 'valuation', value: 1288, asOf: '2026-04-30', source: 'Harbourside Fund Services, April 2026 NAV statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of KPGM-A entered by hand: 1,288.00 NAV per share, as of 2026-04-30, source: Harbourside Fund Services, April 2026 NAV statement. A manual input, not a market quote' }],
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, price: 1288, value: 2_576_000, unrealized: 76_000, freshness: 'manual',
          manual: hfM({ redemptions: HF_NOTICE, noticed: 2000, valuation: { date: '2026-04-30', source: 'Harbourside Fund Services, April 2026 NAV statement', stale: false } }) }],
        pnl: { account: { unrealized: 76_000, total: 76_000 } },
        nav: { account: 4_076_000, book: 6_076_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 2_576_000, assets: 4_076_000, netAssets: 4_076_000 } },
      },
    },
    {
      // Wednesday 1 July 2026: the dealing date has passed. It waits, visibly, for its NAV; the April NAV is now 62 days old.
      id: 'dealing-date-waits', covers: 'redeem', action: 'clock', to: '2026-07-01T14:00:00.000Z',
      expect: {
        lifecycle: [{ type: 'manual.redemption', instrument: 'main', dueDate: '2026-06-30', status: 'blocked', owner: 'account', reason: 'Waiting for the NAV per share of the dealing date 2026-06-30, entered by hand (Lifecycle, Redemption at NAV).' }],
        positions: [{ ...HF_POS, qty: 2000, cost: 2_500_000, value: 2_576_000, freshness: 'stale',
          manual: hfM({ redemptions: HF_NOTICE, noticed: 2000, valuation: { date: '2026-04-30', source: 'Harbourside Fund Services, April 2026 NAV statement', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    { id: 'june-nav-date', action: 'clock', to: '2026-07-13T14:00:00.000Z', expect: {} }, // Monday 13 July 2026
    {
      // NAV for 30 June: 1,320.00. Gate: 50% of the 2,000 held = 1,000 shares now (1,320,000), 1,000 carried to 30 September.
      // Paid 30 June + 10 business days on the USD calendar = 14 July. Cost removed 1,000 x 1,250 = 1,250,000; realized 70,000.
      id: 'redemption-q2', covers: 'redeem', action: 'lifecycle', lot: 'shares', body: { action: 'redemption', nav: 1320 },
      expect: {
        events: [{ type: 'manual.redemption', summary: 'Redemption of 1,000 shares of KPGM-A at the NAV of 2026-06-30, 1,320.00 per share (entered by hand): 1,320,000.00 USD paid 2026-07-14; gate 50% of 2,000 held at the first dealing date = 1,000; 1,000 carried to the dealing date 2026-09-30', owner: 'account', date: '2026-07-13' }],
        cash: { account: { USD: { settled: 1_500_000, unsettled: 1_320_000, availableToTrade: 2_820_000 } } },
        positions: [{ ...HF_POS, qty: 1000, avgCost: 1250, cost: 1_250_000, price: 1320, value: 1_320_000, unrealized: 70_000, freshness: 'manual',
          manual: hfM({ redemptions: [{ noticeDate: '2026-04-13', dealingDate: '2026-09-30', shares: 1000 }], noticed: 1000, valuation: { date: '2026-06-30', source: 'NAV per share struck for the dealing date 2026-06-30 (redemption)', stale: false } }) }],
        holdings: { main: { long: 1000, short: 0, net: 1000 } },
        pending: [{ instrument: 'main', lot: 'shares', owner: 'account', dueDate: '2026-07-14', amount: 1_320_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'manual.redemption', instrument: 'main', dueDate: '2026-09-30', status: 'pending', owner: 'account' }],
        pnl: { account: { realized: 70_000, unrealized: 70_000, total: 140_000 } },
        nav: { account: 4_140_000, book: 6_140_000 }, // 1,500,000 + 1,320,000 receivable + 1,320,000
        provisional: { account: false, book: false },
        balance: { account: { cash: 1_500_000, receivable: 1_320_000, positions: 1_320_000, assets: 4_140_000, netAssets: 4_140_000 } },
      },
    },
    {
      id: 'redemption-q2-paid', covers: 'settlement', action: 'clock', to: '2026-07-14T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,320,000.00 USD into settled cash', cash: { USD: 1_320_000 }, date: '2026-07-14' }],
        cash: { account: { USD: { settled: 2_820_000, unsettled: 0, availableToTrade: 2_820_000 } } },
        pending: [],
        balance: { account: { cash: 2_820_000, receivable: null } },
      },
    },
    {
      // Monday 14 September 2026: the 30 June NAV is 76 days old.
      id: 'august-statement-date', covers: 'valuation', action: 'clock', to: '2026-09-14T14:00:00.000Z',
      expect: {
        positions: [{ ...HF_POS, qty: 1000, cost: 1_250_000, value: 1_320_000, freshness: 'stale',
          manual: hfM({ redemptions: [{ noticeDate: '2026-04-13', dealingDate: '2026-09-30', shares: 1000 }], noticed: 1000, valuation: { date: '2026-06-30', source: 'NAV per share struck for the dealing date 2026-06-30 (redemption)', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      id: 'valuation-aug', covers: 'valuation', action: 'lifecycle', lot: 'shares', body: { action: 'valuation', value: 1342, asOf: '2026-08-31', source: 'Harbourside Fund Services, August 2026 NAV statement' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of KPGM-A entered by hand: 1,342.00 NAV per share, as of 2026-08-31, source: Harbourside Fund Services, August 2026 NAV statement. A manual input, not a market quote' }],
        positions: [{ ...HF_POS, qty: 1000, cost: 1_250_000, price: 1342, value: 1_342_000, unrealized: 92_000, freshness: 'manual',
          manual: hfM({ redemptions: [{ noticeDate: '2026-04-13', dealingDate: '2026-09-30', shares: 1000 }], noticed: 1000, valuation: { date: '2026-08-31', source: 'Harbourside Fund Services, August 2026 NAV statement', stale: false } }) }],
        pnl: { account: { unrealized: 92_000, total: 162_000 } },
        nav: { account: 4_162_000, book: 6_162_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 1_342_000, assets: 4_162_000, netAssets: 4_162_000 } },
      },
    },
    {
      id: 'second-dealing-date-waits', covers: 'redeem', action: 'clock', to: '2026-10-01T14:00:00.000Z',
      expect: { lifecycle: [{ type: 'manual.redemption', instrument: 'main', dueDate: '2026-09-30', status: 'blocked', owner: 'account', reason: 'Waiting for the NAV per share of the dealing date 2026-09-30, entered by hand (Lifecycle, Redemption at NAV).' }] },
    },
    {
      // Tuesday 13 October 2026: the 31 August NAV is 43 days old.
      id: 'september-nav-date', covers: 'valuation', action: 'clock', to: '2026-10-13T14:00:00.000Z',
      expect: {
        positions: [{ ...HF_POS, qty: 1000, cost: 1_250_000, value: 1_342_000, freshness: 'stale',
          manual: hfM({ redemptions: [{ noticeDate: '2026-04-13', dealingDate: '2026-09-30', shares: 1000 }], noticed: 1000, valuation: { date: '2026-08-31', source: 'Harbourside Fund Services, August 2026 NAV statement', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      // NAV for 30 September: 1,355.00. Gate 50% of the 2,000 held at the first dealing date = 1,000: the last 1,000 shares go.
      // Paid 30 September + 10 business days on the USD calendar, skipping Columbus Day (12 October) = 15 October.
      id: 'redemption-q3', covers: 'close', action: 'lifecycle', lot: 'shares', body: { action: 'redemption', nav: 1355 },
      expect: {
        events: [{ type: 'manual.redemption', summary: 'Redemption of 1,000 shares of KPGM-A at the NAV of 2026-09-30, 1,355.00 per share (entered by hand): 1,355,000.00 USD paid 2026-10-15; gate 50% of 2,000 held at the first dealing date = 1,000', owner: 'account' }],
        cash: { account: { USD: { settled: 2_820_000, unsettled: 1_355_000, availableToTrade: 4_175_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'shares', owner: 'account', dueDate: '2026-10-15', amount: 1_355_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: 175_000, unrealized: 0, total: 175_000 } }, // 70,000 + (1,355,000 - 1,250,000)
        nav: { account: 4_175_000, book: 6_175_000 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 2_820_000, receivable: 1_355_000, positions: null, assets: 4_175_000, netAssets: 4_175_000 } },
      },
    },
    {
      id: 'redemption-q3-paid', covers: 'settlement', action: 'clock', to: '2026-10-15T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 1,355,000.00 USD into settled cash', cash: { USD: 1_355_000 }, date: '2026-10-15' }],
        cash: { account: { USD: { settled: 4_175_000, unsettled: 0, availableToTrade: 4_175_000 } }, treasury: { USD: { settled: 2_000_000 } } },
        pending: [],
        balance: { account: { cash: 4_175_000, receivable: null, assets: 4_175_000, liabilities: 0, netAssets: 4_175_000 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// infrastructure
// ---------------------------------------------------------------------------------------------
// Treasury buys 40% of the equity of a toll-road concession company at 50,000,000 for the whole (20,000,000), closing
// on a stated date; an independent valuation at close; project distributions, capital expenditure (added to cost and to
// the value until the next appraisal) and an operating expense by hand; the valuation goes stale after 190 days; a
// semi-annual appraisal; a quarter of the stake sold, then the rest. Treasury's own Accounting screens are read and
// compared with the API at browser level (owner_screens).
const INF_POS = { instrument: 'main', lot: 'stake', owner: 'treasury', direction: 'owned' };
const infM = (o) => ({ kind: 'direct_asset', capex: 0, income: 0, expenses: 0, ...o });
const INF_V1 = { date: '2026-03-16', source: 'Independent valuation at financial close, Corland Advisory', stale: false, reported: 51_000_000 };
const INF_V2 = { date: '2026-09-30', source: 'Semi-annual appraisal, Corland Advisory', stale: false, reported: 55_000_000 };
const infrastructure = {
  productId: 'infrastructure',
  title: 'Ridgeline Toll Road Holdings: a 40% equity stake held by Treasury, bought and sold at stated prices, distributions, capex, appraisals by hand',
  matrix: {
    ...MANUAL_TICKET,
    requiredFields: ['Trading owner (Treasury)', 'Action (Acquire, Sell)', 'Share of the asset', 'State a fill price (price for the whole asset)', 'Settlement date (financial close)', 'Asset (registration)', 'Valuation goes stale after (registration)'],
    manualInputs: ['purchase and sale prices with their closing dates', 'valuations (value of the stake, date, source)', 'project distributions (income)', 'capital expenditure', 'operating expenses'],
    settlement: 'Purchase and sales on the closing dates stated on the ticket (16 March, 16 November, 29 December 2026), on the US calendar',
    lifecycle: 'Nothing automated; distributions, capex, expenses and valuations by hand; the valuation goes stale after 190 days',
    accounting: 'Cost = purchase price plus capital expenditure; distributions in Dividends; expenses in Fees; valued at the appraisal plus capex since; realized P&L on each sale at average cost',
    collateral: 'None: an equity stake held long',
  },
  start: '2026-03-02T15:00:00.000Z',
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: 'Matrix infrastructure', reportingCcy: 'USD', capital: [{ ccy: 'USD', amount: 30_000_000 }], account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 1_000_000 }] }, settings: SETTINGS },
  instruments: {
    main: { productId: 'infrastructure', name: 'Ridgeline Toll Road Holdings LLC', symbol: 'RIDGE-TR', marketView: 'US_CASH', venueType: 'otc', issuer: 'Ridgeline Toll Road Holdings LLC', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD',
      terms: { assetDescription: 'Ridgeline Toll Road: 42-mile tolled highway concession to 2061', location: 'Colorado, United States', valuationMaxAgeDays: 190 } },
  },
  expectAtStart: { cash: { account: { USD: { settled: 1_000_000 } }, treasury: { USD: { settled: 29_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 29_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], nav: { account: 1_000_000, treasury: 29_000_000, book: 30_000_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    {
      // 0.4 of the asset at 50,000,000 for the whole = 20,000,000, paid at financial close on Monday 16 March 2026.
      id: 'acquire', covers: 'open', action: 'ticket', owner: 'treasury', instrument: 'main', side: 'buy', qty: 0.4, as: 'stake', order: { statedPrice: 50_000_000, settle: { date: '2026-03-16' } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 0.4, estimate: 50_000_000, model: 'stated-price', settleDate: '2026-03-16', calendar: 'US', cash: -20_000_000, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 0.4, avgPrice: 50_000_000 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 0.4 RIDGE-TR @ 50,000,000.00 USD', owner: 'treasury', date: '2026-03-02' }],
        cash: { treasury: { USD: { settled: 29_000_000, unsettled: -20_000_000, availableToTrade: 9_000_000 } } },
        positions: [{ ...INF_POS, qty: 0.4, avgCost: 50_000_000, cost: 20_000_000, price: null, value: null, unrealized: null, provisional: true, manual: infM({ valuation: null }) }],
        holdings: { main: { long: 0.4, short: 0, net: 0.4 } },
        pending: [{ instrument: 'main', lot: 'stake', owner: 'treasury', dueDate: '2026-03-16', amount: -20_000_000, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 0, dividends: 0, fees: 0 } },
        nav: { account: 1_000_000, treasury: 29_000_000, book: 30_000_000 },
        provisional: { account: false, book: true }, // only Treasury holds the unvalued stake
        balance: { treasury: { cash: 29_000_000, positions: 20_000_000, payable: 20_000_000, assets: 49_000_000, liabilities: 20_000_000, netAssets: 29_000_000 } },
      },
    },
    { id: 'treasury-screens-after-purchase', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'financial-close', covers: 'settlement', action: 'clock', to: '2026-03-16T14:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 20,000,000.00 USD from settled cash', cash: { USD: -20_000_000 }, owner: 'treasury', date: '2026-03-16' }],
        cash: { treasury: { USD: { settled: 9_000_000, unsettled: 0, availableToTrade: 9_000_000 } } },
        pending: [],
        balance: { treasury: { cash: 9_000_000, payable: null, assets: 29_000_000, liabilities: 0 } },
      },
    },
    {
      // 20,400,000 for our 0.4 at close: 51,000,000 for the whole asset.
      id: 'valuation-at-close', covers: 'valuation', action: 'lifecycle', lot: 'stake', body: { action: 'valuation', value: 20_400_000, asOf: '2026-03-16', source: 'Independent valuation at financial close, Corland Advisory' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of RIDGE-TR entered by hand: 20,400,000.00 USD for the 0.4 held (51,000,000.00 value of the whole asset), as of 2026-03-16, source: Independent valuation at financial close, Corland Advisory. A manual input, not a market quote', owner: 'treasury' }],
        positions: [{ ...INF_POS, qty: 0.4, cost: 20_000_000, price: 51_000_000, value: 20_400_000, unrealized: 400_000, provisional: false, freshness: 'manual', priceSource: 'Manual entry', manual: infM({ valuation: { ...INF_V1, rolledForward: 0 } }) }],
        pnl: { treasury: { unrealized: 400_000, total: 400_000 } },
        nav: { treasury: 29_400_000, book: 30_400_000 },
        provisional: { account: false, book: false },
        balance: { treasury: { positions: 20_400_000, assets: 29_400_000, netAssets: 29_400_000 } },
      },
    },
    { id: 'q2-distribution-date', action: 'clock', to: '2026-06-30T14:00:00.000Z', expect: {} },
    {
      id: 'distribution-q2', covers: 'income', action: 'lifecycle', lot: 'stake', body: { action: 'income', kind: 'dividend', amount: 850_000, note: 'Q2 distribution from the concession company' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Dividend from RIDGE-TR entered by hand: received 850,000.00 USD. Q2 distribution from the concession company', cash: { USD: 850_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 9_850_000, availableToTrade: 9_850_000 } } },
        positions: [{ ...INF_POS, qty: 0.4, cost: 20_000_000, value: 20_400_000, unrealized: 400_000, manual: infM({ income: 850_000, valuation: { ...INF_V1, rolledForward: 0 } }) }],
        pnl: { treasury: { dividends: 850_000, total: 1_250_000 } },
        nav: { treasury: 30_250_000, book: 31_250_000 },
        balance: { treasury: { cash: 9_850_000, assets: 30_250_000, netAssets: 30_250_000 } },
      },
    },
    { id: 'capex-date', action: 'clock', to: '2026-07-15T14:00:00.000Z', expect: {} },
    {
      // Capex raises cost to 21,200,000 and, until the next appraisal, the value to 20,400,000 + 1,200,000 = 21,600,000.
      id: 'capex', covers: 'capital expenditure', action: 'lifecycle', lot: 'stake', body: { action: 'capex', amount: 1_200_000, note: 'Interchange widening at mile 17 (our 40% share)' },
      expect: {
        events: [{ type: 'manual.capex', summary: 'Capital expenditure on RIDGE-TR entered by hand: paid 1,200,000.00 USD, added to cost. Interchange widening at mile 17 (our 40% share)', cash: { USD: -1_200_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 8_650_000, availableToTrade: 8_650_000 } } },
        positions: [{ ...INF_POS, qty: 0.4, avgCost: 53_000_000, cost: 21_200_000, price: 54_000_000, value: 21_600_000, unrealized: 400_000, // 21,200,000 / 0.4; 21,600,000 / 0.4
          manual: infM({ capex: 1_200_000, income: 850_000, valuation: { ...INF_V1, rolledForward: 1_200_000 } }) }],
        nav: { treasury: 30_250_000, book: 31_250_000 },
        balance: { treasury: { cash: 8_650_000, positions: 21_600_000 } },
      },
    },
    {
      id: 'operating-expense', covers: 'fee', action: 'lifecycle', lot: 'stake', body: { action: 'expense', kind: 'operating', amount: 150_000, note: 'Asset management and insurance, July' },
      expect: {
        events: [{ type: 'manual.expense', summary: 'Operating expense on RIDGE-TR entered by hand: paid 150,000.00 USD. Asset management and insurance, July', cash: { USD: -150_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 8_500_000, availableToTrade: 8_500_000 } } },
        positions: [{ ...INF_POS, qty: 0.4, cost: 21_200_000, value: 21_600_000, manual: infM({ capex: 1_200_000, income: 850_000, expenses: 150_000, valuation: { ...INF_V1, rolledForward: 1_200_000 } }) }],
        pnl: { treasury: { fees: -150_000, total: 1_100_000 } }, // 850,000 + 400,000 - 150,000
        nav: { treasury: 30_100_000, book: 31_100_000 },
        balance: { treasury: { cash: 8_500_000, assets: 30_100_000, netAssets: 30_100_000 } },
      },
    },
    {
      // Monday 28 September 2026: the valuation at close (16 March) is 196 days old, past the 190-day limit.
      id: 'valuation-stale', covers: 'valuation', action: 'clock', to: '2026-09-28T14:00:00.000Z',
      expect: {
        positions: [{ ...INF_POS, qty: 0.4, cost: 21_200_000, value: 21_600_000, freshness: 'stale', manual: infM({ capex: 1_200_000, income: 850_000, expenses: 150_000, valuation: { ...INF_V1, stale: true, rolledForward: 1_200_000 } }) }],
        provisional: { account: false, book: true },
      },
    },
    { id: 'appraisal-date', action: 'clock', to: '2026-10-19T14:00:00.000Z', expect: {} },
    {
      // 22,000,000 for our 0.4 at 30 September (55,000,000 for the whole); the July capex is before that date, so nothing is rolled forward.
      id: 'appraisal', covers: 'valuation', action: 'lifecycle', lot: 'stake', body: { action: 'valuation', value: 22_000_000, asOf: '2026-09-30', source: 'Semi-annual appraisal, Corland Advisory' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of RIDGE-TR entered by hand: 22,000,000.00 USD for the 0.4 held (55,000,000.00 value of the whole asset), as of 2026-09-30, source: Semi-annual appraisal, Corland Advisory. A manual input, not a market quote', owner: 'treasury' }],
        positions: [{ ...INF_POS, qty: 0.4, cost: 21_200_000, price: 55_000_000, value: 22_000_000, unrealized: 800_000, freshness: 'manual', manual: infM({ capex: 1_200_000, income: 850_000, expenses: 150_000, valuation: { ...INF_V2, rolledForward: 0 } }) }],
        pnl: { treasury: { unrealized: 800_000, total: 1_500_000 } },
        nav: { treasury: 30_500_000, book: 31_500_000 },
        provisional: { account: false, book: false },
        balance: { treasury: { positions: 22_000_000, assets: 30_500_000, netAssets: 30_500_000 } },
      },
    },
    { id: 'treasury-screens-after-appraisal', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      // A quarter of the stake (0.1 of the asset) at 56,000,000 for the whole = 5,600,000, closing 16 November.
      // Cost removed 21,200,000 x 0.1 / 0.4 = 5,300,000; realized 300,000.
      id: 'partial-sale', covers: 'reduce', action: 'ticket', owner: 'treasury', instrument: 'main', side: 'sell', qty: 0.1, from: 'stake', order: { statedPrice: 56_000_000, settle: { date: '2026-11-16' } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.1, estimate: 56_000_000, model: 'stated-price', settleDate: '2026-11-16', cash: 5_600_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 0.1, avgPrice: 56_000_000 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 0.1 RIDGE-TR @ 56,000,000.00 USD (realized 300,000.00 USD)', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 8_500_000, unsettled: 5_600_000, availableToTrade: 14_100_000 } } },
        positions: [{ ...INF_POS, qty: 0.3, avgCost: 53_000_000, cost: 15_900_000, price: 55_000_000, value: 16_500_000, unrealized: 600_000, manual: infM({ capex: 1_200_000, income: 850_000, expenses: 150_000, valuation: { ...INF_V2, rolledForward: 0 } }) }],
        holdings: { main: { long: 0.3, short: 0, net: 0.3 } },
        pending: [{ instrument: 'main', lot: 'stake', owner: 'treasury', dueDate: '2026-11-16', amount: 5_600_000, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 300_000, unrealized: 600_000, total: 1_600_000 } },
        nav: { treasury: 30_600_000, book: 31_600_000 }, // 8,500,000 + 5,600,000 + 16,500,000
        balance: { treasury: { cash: 8_500_000, receivable: 5_600_000, positions: 16_500_000, assets: 30_600_000, netAssets: 30_600_000 } },
      },
    },
    {
      id: 'partial-sale-closes', covers: 'settlement', action: 'clock', to: '2026-11-16T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 5,600,000.00 USD into settled cash', cash: { USD: 5_600_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 14_100_000, unsettled: 0, availableToTrade: 14_100_000 } } },
        pending: [],
        balance: { treasury: { cash: 14_100_000, receivable: null } },
      },
    },
    { id: 'year-end-date', action: 'clock', to: '2026-12-15T15:00:00.000Z', expect: {} },
    {
      id: 'distribution-q4', covers: 'income', action: 'lifecycle', lot: 'stake', body: { action: 'income', kind: 'dividend', amount: 600_000, note: 'Q4 distribution (our 30%)' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Dividend from RIDGE-TR entered by hand: received 600,000.00 USD. Q4 distribution (our 30%)', cash: { USD: 600_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 14_700_000, availableToTrade: 14_700_000 } } },
        positions: [{ ...INF_POS, qty: 0.3, cost: 15_900_000, value: 16_500_000, manual: infM({ capex: 1_200_000, income: 1_450_000, expenses: 150_000, valuation: { ...INF_V2, rolledForward: 0 } }) }],
        pnl: { treasury: { dividends: 1_450_000, total: 2_200_000 } },
        nav: { treasury: 31_200_000, book: 32_200_000 },
        balance: { treasury: { cash: 14_700_000, assets: 31_200_000, netAssets: 31_200_000 } },
      },
    },
    {
      // The rest, 0.3 at 57,000,000 = 17,100,000, closing Tuesday 29 December (after Christmas). Cost 15,900,000; realized 1,200,000.
      id: 'final-sale', covers: 'close', action: 'ticket', owner: 'treasury', instrument: 'main', side: 'sell', qty: 0.3, from: 'stake', order: { statedPrice: 57_000_000, settle: { date: '2026-12-29' } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.3, estimate: 57_000_000, model: 'stated-price', settleDate: '2026-12-29', cash: 17_100_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 0.3, avgPrice: 57_000_000 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 0.3 RIDGE-TR @ 57,000,000.00 USD (realized 1,200,000.00 USD)', owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 14_700_000, unsettled: 17_100_000, availableToTrade: 31_800_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'stake', owner: 'treasury', dueDate: '2026-12-29', amount: 17_100_000, ccy: 'USD', into: 'cash' }],
        pnl: { treasury: { realized: 1_500_000, dividends: 1_450_000, fees: -150_000, unrealized: 0, total: 2_800_000 } },
        nav: { treasury: 31_800_000, book: 32_800_000 },
        balance: { treasury: { cash: 14_700_000, receivable: 17_100_000, positions: null, assets: 31_800_000, netAssets: 31_800_000 } },
      },
    },
    {
      id: 'final-sale-closes', covers: 'settlement', action: 'clock', to: '2026-12-29T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 17,100,000.00 USD into settled cash', cash: { USD: 17_100_000 }, owner: 'treasury', date: '2026-12-29' }],
        cash: { treasury: { USD: { settled: 31_800_000, unsettled: 0, availableToTrade: 31_800_000 } }, account: { USD: { settled: 1_000_000 } } },
        pending: [],
        balance: { treasury: { cash: 31_800_000, receivable: null, assets: 31_800_000, liabilities: 0, netAssets: 31_800_000 } },
      },
    },
    { id: 'treasury-screens-at-the-end', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// direct_real_estate
// ---------------------------------------------------------------------------------------------
// A London office building bought outright in sterling by the Account of a US dollar Book (GBP/USD 1.25 from a labelled
// fixture, unchanged, so every reporting figure is the sterling figure x 1.25). Completion on a stated date across the
// Easter bank holidays; acquisition costs capitalised; rent and an operating expense by hand; a roof replacement; the
// acquisition valuation goes stale after 180 days; 49% sold to a joint-venture partner; an autumn appraisal; the rest sold,
// completing across Christmas and the substitute Boxing Day holiday (UK calendar).
const RE_POS = { instrument: 'main', lot: 'building', owner: 'account', direction: 'owned' };
const reM = (o) => ({ kind: 'direct_asset', capex: 0, income: 0, expenses: 0, ...o });
const RE_V1 = { date: '2026-04-07', source: 'Acquisition valuation, Rothwell Chartered Surveyors', stale: false, reported: 20_500_000 };
const RE_V2 = { date: '2026-10-31', source: 'Autumn appraisal, Rothwell Chartered Surveyors', stale: false, reported: 21_400_000 };
const directRealEstate = {
  productId: 'direct_real_estate',
  title: '14 Albion Wharf, London SE1: an office building bought in GBP in a USD Book, rent, costs, capex, appraisals, a 49% joint-venture sale and the final sale, by hand',
  matrix: {
    ...MANUAL_TICKET,
    requiredFields: ['Trading owner', 'Action (Acquire, Sell)', 'Share of the asset', 'State a fill price (price for the whole asset)', 'Settlement date (completion)', 'Asset (registration)', 'Valuation goes stale after (registration)'],
    manualInputs: ['purchase and sale prices with completion dates', 'acquisition costs and capital expenditure (added to cost)', 'rent received', 'operating expenses', 'valuations with date and source'],
    settlement: 'Purchase and sales on the completion dates stated on the ticket, checked against the UK calendar (7 April after Easter; 30 December after Christmas and 28 December)',
    lifecycle: 'Nothing automated; rent, expenses, capex and appraisals by hand; valuation stale after 180 days',
    accounting: 'In GBP, reported in USD at 1.25; cost = price + capitalised costs and capex; rent in Dividends; expenses in Fees; valued at the appraisal plus capex since; realized P&L on each sale at average cost',
    collateral: 'None: a building owned outright',
  },
  start: '2026-03-02T15:00:00.000Z',
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: 'Matrix direct real estate', reportingCcy: 'USD', capital: [{ ccy: 'USD', amount: 2_000_000 }, { ccy: 'GBP', amount: 30_000_000 }], account: { name: 'Alpha', funding: [{ ccy: 'GBP', amount: 25_000_000 }] }, settings: SETTINGS },
  fx: { 'GBP/USD': 1.25 },
  instruments: {
    main: { productId: 'direct_real_estate', name: '14 Albion Wharf, London SE1 (office building)', symbol: 'ALBW14', marketView: 'FOREIGN_CASH', venueType: 'otc', issuer: 'Albion Wharf Property Ltd', domicile: 'GB', underlyingGeo: 'GB', tradingCcy: 'GBP',
      terms: { assetDescription: 'Grade A office building, 82,000 sq ft, let to three tenants', location: 'London SE1, United Kingdom', valuationMaxAgeDays: 180 } },
  },
  expectAtStart: { cash: { account: { GBP: { settled: 25_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 25_000_000 } }, treasury: { GBP: { settled: 5_000_000 }, USD: { settled: 2_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], nav: { account: 31_250_000, treasury: 8_250_000, book: 39_500_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    {
      id: 'acquire', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 1, as: 'building', order: { statedPrice: 20_000_000, settle: { date: '2026-04-07' } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 1, estimate: 20_000_000, model: 'stated-price', settleDate: '2026-04-07', calendar: 'UK', cash: -20_000_000, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1, avgPrice: 20_000_000 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1 ALBW14 @ 20,000,000.00 GBP', owner: 'account', date: '2026-03-02' }],
        cash: { account: { GBP: { settled: 25_000_000, unsettled: -20_000_000, availableToTrade: 5_000_000 } } },
        positions: [{ ...RE_POS, qty: 1, avgCost: 20_000_000, cost: 20_000_000, price: null, value: null, unrealized: null, provisional: true, manual: reM({ valuation: null }) }],
        holdings: { main: { long: 1, short: 0, net: 1 } },
        pending: [{ instrument: 'main', lot: 'building', owner: 'account', dueDate: '2026-04-07', amount: -20_000_000, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { realized: 0, dividends: 0, fees: 0, fx: 0 } },
        nav: { account: 31_250_000, book: 39_500_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 31_250_000, positions: 25_000_000, payable: 25_000_000, assets: 56_250_000, liabilities: 25_000_000, netAssets: 31_250_000, local: { GBP: { cash: 25_000_000, positions: 20_000_000, payable: 20_000_000 } } } },
      },
    },
    {
      id: 'completion', covers: 'settlement', action: 'clock', to: '2026-04-07T14:00:00.000Z', // Tuesday 7 April 2026, after Good Friday and Easter Monday
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 20,000,000.00 GBP from settled cash', cash: { GBP: -20_000_000 }, date: '2026-04-07' }],
        cash: { account: { GBP: { settled: 5_000_000, unsettled: 0, availableToTrade: 5_000_000 } } },
        pending: [],
        balance: { account: { cash: 6_250_000, payable: null, assets: 31_250_000, liabilities: 0, local: { GBP: { cash: 5_000_000, positions: 20_000_000, payable: null } } } },
      },
    },
    {
      id: 'acquisition-costs', covers: 'capital expenditure', action: 'lifecycle', lot: 'building', body: { action: 'capex', amount: 1_100_000, note: 'Stamp duty land tax and legal fees on acquisition' },
      expect: {
        events: [{ type: 'manual.capex', summary: 'Capital expenditure on ALBW14 entered by hand: paid 1,100,000.00 GBP, added to cost. Stamp duty land tax and legal fees on acquisition', cash: { GBP: -1_100_000 } }],
        cash: { account: { GBP: { settled: 3_900_000, availableToTrade: 3_900_000 } } },
        positions: [{ ...RE_POS, qty: 1, avgCost: 21_100_000, cost: 21_100_000, value: null, provisional: true, manual: reM({ capex: 1_100_000, valuation: null }) }],
        nav: { account: 31_250_000, book: 39_500_000 }, // (3,900,000 + 21,100,000 at cost) x 1.25
        balance: { account: { cash: 4_875_000, positions: 26_375_000, local: { GBP: { cash: 3_900_000, positions: 21_100_000 } } } },
      },
    },
    {
      // The surveyor values the building at 20,500,000 on completion; the costs paid that day are not part of its value.
      id: 'valuation-at-acquisition', covers: 'valuation', action: 'lifecycle', lot: 'building', body: { action: 'valuation', value: 20_500_000, asOf: '2026-04-07', source: 'Acquisition valuation, Rothwell Chartered Surveyors' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of ALBW14 entered by hand: 20,500,000.00 GBP for the 1 held, as of 2026-04-07, source: Acquisition valuation, Rothwell Chartered Surveyors. A manual input, not a market quote' }],
        positions: [{ ...RE_POS, qty: 1, cost: 21_100_000, price: 20_500_000, value: 20_500_000, unrealized: -600_000, provisional: false, freshness: 'manual', priceSource: 'Manual entry', manual: reM({ capex: 1_100_000, valuation: { ...RE_V1, rolledForward: 0 } }) }],
        pnl: { account: { unrealized: -750_000, total: -750_000 } }, // -600,000 x 1.25
        nav: { account: 30_500_000, book: 38_750_000 }, // (3,900,000 + 20,500,000) x 1.25
        provisional: { account: false, book: false },
        balance: { account: { positions: 25_625_000, assets: 30_500_000, netAssets: 30_500_000, local: { GBP: { positions: 20_500_000 } } } },
      },
    },
    { id: 'april-rent-date', action: 'clock', to: '2026-04-30T14:00:00.000Z', expect: {} },
    {
      id: 'rent-april', covers: 'income', action: 'lifecycle', lot: 'building', body: { action: 'income', kind: 'rent', amount: 105_000, note: 'Rent for April, three tenants' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Rent from ALBW14 entered by hand: received 105,000.00 GBP. Rent for April, three tenants', cash: { GBP: 105_000 } }],
        cash: { account: { GBP: { settled: 4_005_000, availableToTrade: 4_005_000 } } },
        positions: [{ ...RE_POS, qty: 1, cost: 21_100_000, value: 20_500_000, manual: reM({ capex: 1_100_000, income: 105_000, valuation: { ...RE_V1, rolledForward: 0 } }) }],
        pnl: { account: { dividends: 131_250, total: -618_750 } }, // 105,000 x 1.25
        nav: { account: 30_631_250, book: 38_881_250 },
        balance: { account: { cash: 5_006_250, assets: 30_631_250, netAssets: 30_631_250, local: { GBP: { cash: 4_005_000 } } } },
      },
    },
    {
      id: 'operating-costs', covers: 'fee', action: 'lifecycle', lot: 'building', body: { action: 'expense', kind: 'operating', amount: 18_000, note: 'Service charge shortfall and business rates on vacant space, April' },
      expect: {
        events: [{ type: 'manual.expense', summary: 'Operating expense on ALBW14 entered by hand: paid 18,000.00 GBP. Service charge shortfall and business rates on vacant space, April', cash: { GBP: -18_000 } }],
        cash: { account: { GBP: { settled: 3_987_000, availableToTrade: 3_987_000 } } },
        positions: [{ ...RE_POS, qty: 1, cost: 21_100_000, value: 20_500_000, manual: reM({ capex: 1_100_000, income: 105_000, expenses: 18_000, valuation: { ...RE_V1, rolledForward: 0 } }) }],
        pnl: { account: { fees: -22_500, total: -641_250 } },
        nav: { account: 30_608_750, book: 38_858_750 },
        balance: { account: { cash: 4_983_750, assets: 30_608_750, netAssets: 30_608_750, local: { GBP: { cash: 3_987_000 } } } },
      },
    },
    { id: 'may-rent-date', action: 'clock', to: '2026-05-29T14:00:00.000Z', expect: {} },
    {
      id: 'rent-may', covers: 'income', action: 'lifecycle', lot: 'building', body: { action: 'income', kind: 'rent', amount: 105_000, note: 'Rent for May' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Rent from ALBW14 entered by hand: received 105,000.00 GBP. Rent for May', cash: { GBP: 105_000 } }],
        cash: { account: { GBP: { settled: 4_092_000, availableToTrade: 4_092_000 } } },
        positions: [{ ...RE_POS, qty: 1, cost: 21_100_000, value: 20_500_000, manual: reM({ capex: 1_100_000, income: 210_000, expenses: 18_000, valuation: { ...RE_V1, rolledForward: 0 } }) }],
        pnl: { account: { dividends: 262_500, total: -510_000 } },
        nav: { account: 30_740_000, book: 38_990_000 },
        balance: { account: { cash: 5_115_000, assets: 30_740_000, netAssets: 30_740_000, local: { GBP: { cash: 4_092_000 } } } },
      },
    },
    { id: 'roof-date', action: 'clock', to: '2026-06-15T14:00:00.000Z', expect: {} },
    {
      // Roof replacement: cost 21,100,000 + 400,000 = 21,500,000; value 20,500,000 + 400,000 since the valuation = 20,900,000.
      id: 'roof', covers: 'capital expenditure', action: 'lifecycle', lot: 'building', body: { action: 'capex', amount: 400_000, note: 'Roof replacement and plant upgrade' },
      expect: {
        events: [{ type: 'manual.capex', summary: 'Capital expenditure on ALBW14 entered by hand: paid 400,000.00 GBP, added to cost. Roof replacement and plant upgrade', cash: { GBP: -400_000 } }],
        cash: { account: { GBP: { settled: 3_692_000, availableToTrade: 3_692_000 } } },
        positions: [{ ...RE_POS, qty: 1, avgCost: 21_500_000, cost: 21_500_000, price: 20_900_000, value: 20_900_000, unrealized: -600_000, manual: reM({ capex: 1_500_000, income: 210_000, expenses: 18_000, valuation: { ...RE_V1, rolledForward: 400_000 } }) }],
        nav: { account: 30_740_000, book: 38_990_000 },
        balance: { account: { cash: 4_615_000, positions: 26_125_000, local: { GBP: { cash: 3_692_000, positions: 20_900_000 } } } },
      },
    },
    {
      // Monday 5 October 2026: the acquisition valuation (7 April) is 181 days old, past the 180-day limit.
      id: 'valuation-stale', covers: 'valuation', action: 'clock', to: '2026-10-05T14:00:00.000Z',
      expect: {
        positions: [{ ...RE_POS, qty: 1, cost: 21_500_000, value: 20_900_000, freshness: 'stale', manual: reM({ capex: 1_500_000, income: 210_000, expenses: 18_000, valuation: { ...RE_V1, stale: true, rolledForward: 400_000 } }) }],
        provisional: { account: true, book: true },
      },
    },
    { id: 'jv-sale-date', action: 'clock', to: '2026-11-02T15:00:00.000Z', expect: {} },
    {
      // 49% to a joint-venture partner at 21,000,000 for the whole = 10,290,000, completing 16 November.
      // Cost removed 21,500,000 x 0.49 = 10,535,000; realized -245,000. Value left 0.51 x 20,900,000 = 10,659,000 against cost 10,965,000.
      id: 'joint-venture-sale', covers: 'reduce', action: 'ticket', instrument: 'main', side: 'sell', qty: 0.49, from: 'building', order: { statedPrice: 21_000_000, settle: { date: '2026-11-16' } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.49, estimate: 21_000_000, model: 'stated-price', settleDate: '2026-11-16', cash: 10_290_000, fees: 0 }] },
        result: { status: 'open', orders: [{ action: 'sell', status: 'filled', filledQty: 0.49, avgPrice: 21_000_000 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 0.49 ALBW14 @ 21,000,000.00 GBP (realized -245,000.00 GBP)' }],
        cash: { account: { GBP: { settled: 3_692_000, unsettled: 10_290_000, availableToTrade: 13_982_000 } } },
        positions: [{ ...RE_POS, qty: 0.51, avgCost: 21_500_000, cost: 10_965_000, price: 20_900_000, value: 10_659_000, unrealized: -306_000, freshness: 'stale',
          manual: reM({ capex: 1_500_000, income: 210_000, expenses: 18_000, valuation: { ...RE_V1, stale: true, rolledForward: 204_000 } }) }], // 400,000 a unit x 0.51
        holdings: { main: { long: 0.51, short: 0, net: 0.51 } },
        pending: [{ instrument: 'main', lot: 'building', owner: 'account', dueDate: '2026-11-16', amount: 10_290_000, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { realized: -306_250, unrealized: -382_500, total: -448_750 } }, // -245,000 x 1.25; -306,000 x 1.25; -306,250 + 262,500 - 22,500 - 382,500
        nav: { account: 30_801_250, book: 39_051_250 }, // (3,692,000 + 10,290,000 + 10,659,000) x 1.25
        balance: { account: { cash: 4_615_000, receivable: 12_862_500, positions: 13_323_750, assets: 30_801_250, netAssets: 30_801_250, local: { GBP: { cash: 3_692_000, receivable: 10_290_000, positions: 10_659_000 } } } },
      },
    },
    {
      id: 'joint-venture-completes', covers: 'settlement', action: 'clock', to: '2026-11-16T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 10,290,000.00 GBP into settled cash', cash: { GBP: 10_290_000 } }],
        cash: { account: { GBP: { settled: 13_982_000, unsettled: 0, availableToTrade: 13_982_000 } } },
        pending: [],
        balance: { account: { cash: 17_477_500, receivable: null, local: { GBP: { cash: 13_982_000, receivable: null } } } },
      },
    },
    {
      // Our 51% is worth 10,914,000 at 31 October (21,400,000 for the whole building).
      id: 'appraisal', covers: 'valuation', action: 'lifecycle', lot: 'building', body: { action: 'valuation', value: 10_914_000, asOf: '2026-10-31', source: 'Autumn appraisal, Rothwell Chartered Surveyors' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of ALBW14 entered by hand: 10,914,000.00 GBP for the 0.51 held (21,400,000.00 value of the whole asset), as of 2026-10-31, source: Autumn appraisal, Rothwell Chartered Surveyors. A manual input, not a market quote' }],
        positions: [{ ...RE_POS, qty: 0.51, cost: 10_965_000, price: 21_400_000, value: 10_914_000, unrealized: -51_000, freshness: 'manual', manual: reM({ capex: 1_500_000, income: 210_000, expenses: 18_000, valuation: { ...RE_V2, rolledForward: 0 } }) }],
        pnl: { account: { unrealized: -63_750, total: -130_000 } }, // -51,000 x 1.25
        nav: { account: 31_120_000, book: 39_370_000 }, // (13,982,000 + 10,914,000) x 1.25
        provisional: { account: false, book: false },
        balance: { account: { positions: 13_642_500, assets: 31_120_000, netAssets: 31_120_000, local: { GBP: { positions: 10_914_000 } } } },
      },
    },
    { id: 'final-sale-date', action: 'clock', to: '2026-12-15T15:00:00.000Z', expect: {} },
    {
      // The remaining 51% at 21,600,000 for the whole = 11,016,000, completing Wednesday 30 December (after 25 and 28 December).
      // Cost 10,965,000; realized 51,000.
      id: 'final-sale', covers: 'close', action: 'ticket', instrument: 'main', side: 'sell', qty: 0.51, from: 'building', order: { statedPrice: 21_600_000, settle: { date: '2026-12-30' } }, settlementCheck: false,
      expect: {
        preview: { blocking: 0, legs: [{ action: 'sell', qty: 0.51, estimate: 21_600_000, model: 'stated-price', settleDate: '2026-12-30', cash: 11_016_000, fees: 0 }] },
        result: { status: 'closed', orders: [{ action: 'sell', status: 'filled', filledQty: 0.51, avgPrice: 21_600_000 }] },
        events: [{ type: 'strategy.legs_added' }, { type: 'trade.fill', summary: 'Sold 0.51 ALBW14 @ 21,600,000.00 GBP (realized 51,000.00 GBP)' }],
        cash: { account: { GBP: { settled: 13_982_000, unsettled: 11_016_000, availableToTrade: 24_998_000 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'building', owner: 'account', dueDate: '2026-12-30', amount: 11_016_000, ccy: 'GBP', into: 'cash' }],
        pnl: { account: { realized: -242_500, dividends: 262_500, fees: -22_500, unrealized: 0, fx: 0, total: -2_500 } }, // (-245,000 + 51,000) x 1.25
        nav: { account: 31_247_500, book: 39_497_500 }, // 24,998,000 x 1.25
        balance: { account: { cash: 17_477_500, receivable: 13_770_000, positions: null, assets: 31_247_500, netAssets: 31_247_500, local: { GBP: { cash: 13_982_000, receivable: 11_016_000, positions: null } } } },
      },
    },
    {
      id: 'final-completion', covers: 'settlement', action: 'clock', to: '2026-12-30T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 11,016,000.00 GBP into settled cash', cash: { GBP: 11_016_000 }, date: '2026-12-30' }],
        cash: { account: { GBP: { settled: 24_998_000, unsettled: 0, availableToTrade: 24_998_000 } } },
        pending: [],
        balance: { account: { cash: 31_247_500, receivable: null, assets: 31_247_500, liabilities: 0, netAssets: 31_247_500, local: { GBP: { cash: 24_998_000, receivable: null } } } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// insurance_linked_security
// ---------------------------------------------------------------------------------------------
// A privately placed collateralised reinsurance note (not a listed catastrophe bond): 5,000,000 face bought at par, priced
// in % of face (multiplier 0.01, set by the product), quarterly coupons of 9.50% a year entered by hand, broker indications
// as valuations (stale after 45 days), a hurricane: the price falls, then the cedent's loss notice writes 30% of principal
// down (a realized loss), coupons continue on the face left, and the rest is redeemed at par at maturity. The redemption is
// paid T+2 on the USD calendar, across New Year's Day 2027. An early redemption is refused before maturity.
const ILS_POS = { instrument: 'main', lot: 'note', owner: 'account', direction: 'long' };
const ilsM = (o) => ({ kind: 'ils', faceLost: 0, coupons: 0, ...o });
const ILS_TASK = { type: 'manual.maturity', instrument: 'main', dueDate: '2026-12-31', owner: 'account' };
const insuranceLinked = {
  productId: 'insurance_linked_security',
  title: 'Sable Harbor Re 2026-1 Class A: a collateralised reinsurance note, coupons, broker marks, a hurricane loss writing down 30% of face, redemption at maturity, by hand',
  matrix: {
    ...MANUAL_TICKET,
    requiredFields: ['Trading owner', 'Action (Buy)', 'Face amount', 'State a fill price (% of face)', 'Peril and maturity (registration)', 'Valuation goes stale after (registration)'],
    manualInputs: ['purchase price', 'coupons received', 'broker indications as valuations (% of face, date, source)', 'loss event (face written down)', 'redemption price at maturity'],
    settlement: 'Purchase T+2 on the USD payment calendar; redemption T+2 after maturity (31 December 2026 to 5 January 2027, across New Year\'s Day)',
    lifecycle: 'Maturity is a lifecycle item that waits, visibly, for the redemption entered by hand; coupons and the loss event by hand; an early redemption is refused',
    accounting: 'Face amount at average cost in % of face; coupons in Coupon and interest income; principal written down realized as a loss at its cost; valued at the latest broker indication, stale after 45 days',
    collateral: 'None held by the investor: the note is backed by a collateral trust at the issuer (recorded in the terms, not simulated)',
  },
  start: '2026-03-02T15:00:00.000Z',
  settlementCheck: { lag: 2, holidays: [] },
  book: { name: 'Matrix insurance-linked', reportingCcy: 'USD', capital: [{ ccy: 'USD', amount: 8_000_000 }], account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 6_000_000 }] }, settings: SETTINGS },
  instruments: {
    main: { productId: 'insurance_linked_security', name: 'Sable Harbor Re 2026-1 Class A collateralised reinsurance note', symbol: 'SHRE26A', marketView: 'FOREIGN_CASH', venueType: 'otc', issuer: 'Sable Harbor Re Ltd', domicile: 'BM', underlyingGeo: 'US', tradingCcy: 'USD',
      terms: { peril: 'US named storm and earthquake, per-occurrence excess of loss', trigger: 'indemnity', maturity: '2026-12-31', couponRate: 0.095, valuationMaxAgeDays: 45 } },
  },
  expectAtStart: { cash: { account: { USD: { settled: 6_000_000, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: 6_000_000 } }, treasury: { USD: { settled: 2_000_000 } } },
    positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], nav: { account: 6_000_000, treasury: 2_000_000, book: 8_000_000 }, provisional: { account: false, book: false }, failed: { orders: 0, settlements: 0, lifecycle: 0 } },
  steps: [
    {
      // 5,000,000 face at 100 (% of face) x 0.01 = 5,000,000.
      id: 'buy', covers: 'open', action: 'ticket', instrument: 'main', side: 'buy', qty: 5_000_000, as: 'note', order: { statedPrice: 100 },
      expect: {
        preview: { blocking: 0, errors: [], legs: [{ kind: 'trade', action: 'buy', instrument: 'main', qty: 5_000_000, estimate: 100, model: 'stated-price', settleDate: '2026-03-04', calendar: 'USD', cash: -5_000_000, fees: 0 }] },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5_000_000, avgPrice: 100 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 5,000,000 SHRE26A @ 100.00 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 6_000_000, unsettled: -5_000_000, availableToTrade: 1_000_000 } } },
        positions: [{ ...ILS_POS, qty: 5_000_000, avgCost: 100, cost: 5_000_000, price: null, value: null, unrealized: null, provisional: true, manual: ilsM({ valuation: null }) }], // 5,000,000 / (5,000,000 x 0.01)
        holdings: { main: { long: 5_000_000, short: 0, net: 5_000_000 } },
        pending: [{ instrument: 'main', lot: 'note', owner: 'account', dueDate: '2026-03-04', amount: -5_000_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ ...ILS_TASK, status: 'pending' }],
        pnl: { account: { realized: 0, couponInterest: 0, fees: 0 } },
        nav: { account: 6_000_000, book: 8_000_000 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 6_000_000, positions: 5_000_000, payable: 5_000_000, assets: 11_000_000, liabilities: 5_000_000, netAssets: 6_000_000 } },
      },
    },
    {
      id: 'settle-purchase', covers: 'settlement', action: 'clock', to: '2026-03-04T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.pay', summary: 'paid 5,000,000.00 USD from settled cash', cash: { USD: -5_000_000 } }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: 0, availableToTrade: 1_000_000 } } },
        pending: [],
        balance: { account: { cash: 1_000_000, payable: null, assets: 6_000_000, liabilities: 0 } },
      },
    },
    { id: 'first-mark-date', action: 'clock', to: '2026-03-16T14:00:00.000Z', expect: {} },
    {
      id: 'valuation-march', covers: 'valuation', action: 'lifecycle', lot: 'note', body: { action: 'valuation', value: 99.75, asOf: '2026-03-13', source: 'Broker indication, Thornbury Re Capital (bid side)' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of SHRE26A entered by hand: 99.75 % of face, as of 2026-03-13, source: Broker indication, Thornbury Re Capital (bid side). A manual input, not a market quote' }],
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, price: 99.75, value: 4_987_500, unrealized: -12_500, provisional: false, freshness: 'manual', priceSource: 'Manual entry', // 5,000,000 x 99.75 x 0.01
          manual: ilsM({ valuation: { date: '2026-03-13', source: 'Broker indication, Thornbury Re Capital (bid side)', stale: false } }) }],
        pnl: { account: { unrealized: -12_500, total: -12_500 } },
        nav: { account: 5_987_500, book: 7_987_500 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 4_987_500, assets: 5_987_500, netAssets: 5_987_500 } },
      },
    },
    { id: 'q1-coupon-date', action: 'clock', to: '2026-04-01T14:00:00.000Z', expect: {} },
    {
      // 5,000,000 x 9.50% / 4 = 118,750.
      id: 'coupon-q1', covers: 'coupon', action: 'lifecycle', lot: 'note', body: { action: 'income', kind: 'coupon', amount: 118_750, note: 'Quarterly coupon, 9.50% a year on 5,000,000 face' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Coupon from SHRE26A entered by hand: received 118,750.00 USD. Quarterly coupon, 9.50% a year on 5,000,000 face', cash: { USD: 118_750 } }],
        cash: { account: { USD: { settled: 1_118_750, availableToTrade: 1_118_750 } } },
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, value: 4_987_500, manual: ilsM({ coupons: 118_750, valuation: { date: '2026-03-13', source: 'Broker indication, Thornbury Re Capital (bid side)', stale: false } }) }],
        pnl: { account: { couponInterest: 118_750, total: 106_250 } },
        nav: { account: 6_106_250, book: 8_106_250 },
        balance: { account: { cash: 1_118_750, assets: 6_106_250, netAssets: 6_106_250 } },
      },
    },
    {
      // Monday 4 May 2026: the 13 March indication is 52 days old, past the 45-day limit.
      id: 'mark-stale', covers: 'valuation', action: 'clock', to: '2026-05-04T14:00:00.000Z',
      expect: {
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, value: 4_987_500, freshness: 'stale', manual: ilsM({ coupons: 118_750, valuation: { date: '2026-03-13', source: 'Broker indication, Thornbury Re Capital (bid side)', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      id: 'valuation-april', covers: 'valuation', action: 'lifecycle', lot: 'note', body: { action: 'valuation', value: 100.10, asOf: '2026-04-30', source: 'Broker indication, Thornbury Re Capital (bid side)' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of SHRE26A entered by hand: 100.10 % of face, as of 2026-04-30, source: Broker indication, Thornbury Re Capital (bid side). A manual input, not a market quote' }],
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, price: 100.1, value: 5_005_000, unrealized: 5_000, freshness: 'manual', manual: ilsM({ coupons: 118_750, valuation: { date: '2026-04-30', source: 'Broker indication, Thornbury Re Capital (bid side)', stale: false } }) }],
        pnl: { account: { unrealized: 5_000, total: 123_750 } },
        nav: { account: 6_123_750, book: 8_123_750 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 5_005_000, assets: 6_123_750, netAssets: 6_123_750 } },
      },
    },
    { id: 'q2-coupon-date', action: 'clock', to: '2026-07-01T14:00:00.000Z', expect: {} },
    {
      // Wednesday 1 July: the 30 April indication is 62 days old (stale) when the second coupon arrives.
      id: 'coupon-q2', covers: 'coupon', action: 'lifecycle', lot: 'note', body: { action: 'income', kind: 'coupon', amount: 118_750, note: 'Quarterly coupon' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Coupon from SHRE26A entered by hand: received 118,750.00 USD. Quarterly coupon', cash: { USD: 118_750 } }],
        cash: { account: { USD: { settled: 1_237_500, availableToTrade: 1_237_500 } } },
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, value: 5_005_000, freshness: 'stale', manual: ilsM({ coupons: 237_500, valuation: { date: '2026-04-30', source: 'Broker indication, Thornbury Re Capital (bid side)', stale: true } }) }],
        pnl: { account: { couponInterest: 237_500, total: 242_500 } },
        nav: { account: 6_242_500, book: 8_242_500 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_237_500, assets: 6_242_500, netAssets: 6_242_500 } },
      },
    },
    { id: 'landfall-date', action: 'clock', to: '2026-09-28T14:00:00.000Z', expect: {} },
    {
      // After Hurricane Delphine makes landfall the note is indicated at 72.00: 5,000,000 x 72 x 0.01 = 3,600,000.
      id: 'valuation-after-landfall', covers: 'valuation', action: 'lifecycle', lot: 'note', body: { action: 'valuation', value: 72, asOf: '2026-09-25', source: 'Broker indication after Hurricane Delphine landfall' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of SHRE26A entered by hand: 72.00 % of face, as of 2026-09-25, source: Broker indication after Hurricane Delphine landfall. A manual input, not a market quote' }],
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, price: 72, value: 3_600_000, unrealized: -1_400_000, freshness: 'manual', manual: ilsM({ coupons: 237_500, valuation: { date: '2026-09-25', source: 'Broker indication after Hurricane Delphine landfall', stale: false } }) }],
        pnl: { account: { unrealized: -1_400_000, total: -1_162_500 } },
        nav: { account: 4_837_500, book: 6_837_500 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 3_600_000, assets: 4_837_500, netAssets: 4_837_500 } },
      },
    },
    { id: 'q3-coupon-date', action: 'clock', to: '2026-10-01T14:00:00.000Z', expect: {} },
    {
      id: 'coupon-q3', covers: 'coupon', action: 'lifecycle', lot: 'note', body: { action: 'income', kind: 'coupon', amount: 118_750, note: 'Quarterly coupon, before the loss notice' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Coupon from SHRE26A entered by hand: received 118,750.00 USD. Quarterly coupon, before the loss notice', cash: { USD: 118_750 } }],
        cash: { account: { USD: { settled: 1_356_250, availableToTrade: 1_356_250 } } },
        positions: [{ ...ILS_POS, qty: 5_000_000, cost: 5_000_000, value: 3_600_000, manual: ilsM({ coupons: 356_250, valuation: { date: '2026-09-25', source: 'Broker indication after Hurricane Delphine landfall', stale: false } }) }],
        pnl: { account: { couponInterest: 356_250, total: -1_043_750 } },
        nav: { account: 4_956_250, book: 6_956_250 },
        balance: { account: { cash: 1_356_250, assets: 4_956_250, netAssets: 4_956_250 } },
      },
    },
    { id: 'loss-notice-date', action: 'clock', to: '2026-11-02T15:00:00.000Z', expect: {} },
    {
      // The cedent's loss notice: 30% of principal is lost: 1,500,000 of face written down at its cost (100) = 1,500,000 realized.
      // Face left 3,500,000 at cost 3,500,000, still indicated at 72: 2,520,000.
      id: 'loss-event', covers: 'loss event', action: 'lifecycle', lot: 'note', body: { action: 'loss_event', face: 1_500_000, note: 'Cedent loss notice: Hurricane Delphine, 30% of principal' },
      expect: {
        events: [{ type: 'manual.loss_event', summary: 'Loss event on SHRE26A entered by hand: 1,500,000.00 USD of face written down (principal lost), cost 1,500,000.00 USD realized. Cedent loss notice: Hurricane Delphine, 30% of principal', owner: 'account' }],
        positions: [{ ...ILS_POS, qty: 3_500_000, avgCost: 100, cost: 3_500_000, price: 72, value: 2_520_000, unrealized: -980_000, manual: ilsM({ faceLost: 1_500_000, coupons: 356_250, valuation: { date: '2026-09-25', source: 'Broker indication after Hurricane Delphine landfall', stale: false } }) }],
        holdings: { main: { long: 3_500_000, short: 0, net: 3_500_000 } },
        pnl: { account: { realized: -1_500_000, unrealized: -980_000, total: -2_123_750 } },
        nav: { account: 3_876_250, book: 5_876_250 }, // 1,356,250 + 2,520,000
        balance: { account: { positions: 2_520_000, assets: 3_876_250, netAssets: 3_876_250 } },
      },
    },
    {
      id: 'early-redemption', covers: 'redeem', action: 'lifecycle', lot: 'note', body: { action: 'settle', redemptionPrice: 100 },
      status: 'blocked', reason: 'The note matures on 31 December 2026; it cannot be redeemed before.',
      expect: { refused: 'SHRE26A matures on 2026-12-31' },
    },
    { id: 'residual-mark-date', action: 'clock', to: '2026-11-16T15:00:00.000Z', expect: {} },
    {
      id: 'valuation-residual', covers: 'valuation', action: 'lifecycle', lot: 'note', body: { action: 'valuation', value: 98.5, asOf: '2026-11-13', source: 'Broker indication, residual exposure after the loss notice' },
      expect: {
        events: [{ type: 'manual.valuation', summary: 'Valuation of SHRE26A entered by hand: 98.50 % of face, as of 2026-11-13, source: Broker indication, residual exposure after the loss notice. A manual input, not a market quote' }],
        positions: [{ ...ILS_POS, qty: 3_500_000, cost: 3_500_000, price: 98.5, value: 3_447_500, unrealized: -52_500, freshness: 'manual', manual: ilsM({ faceLost: 1_500_000, coupons: 356_250, valuation: { date: '2026-11-13', source: 'Broker indication, residual exposure after the loss notice', stale: false } }) }],
        pnl: { account: { unrealized: -52_500, total: -1_196_250 } },
        nav: { account: 4_803_750, book: 6_803_750 },
        balance: { account: { positions: 3_447_500, assets: 4_803_750, netAssets: 4_803_750 } },
      },
    },
    {
      // Thursday 31 December 2026: maturity. The lifecycle item waits for the redemption entered by hand; the 13 November
      // indication is 48 days old.
      id: 'maturity-waits', covers: 'redeem', action: 'clock', to: '2026-12-31T15:00:00.000Z',
      expect: {
        lifecycle: [{ ...ILS_TASK, status: 'blocked', reason: 'Waiting for the redemption of SHRE26A, entered by hand (Lifecycle, Redemption at maturity).' }],
        positions: [{ ...ILS_POS, qty: 3_500_000, cost: 3_500_000, value: 3_447_500, freshness: 'stale', manual: ilsM({ faceLost: 1_500_000, coupons: 356_250, valuation: { date: '2026-11-13', source: 'Broker indication, residual exposure after the loss notice', stale: true } }) }],
        provisional: { account: true, book: true },
      },
    },
    {
      // Last coupon on the face left: 3,500,000 x 9.50% / 4 = 83,125.
      id: 'coupon-q4', covers: 'coupon', action: 'lifecycle', lot: 'note', body: { action: 'income', kind: 'coupon', amount: 83_125, note: 'Final quarterly coupon on 3,500,000 face' },
      expect: {
        events: [{ type: 'manual.income', summary: 'Coupon from SHRE26A entered by hand: received 83,125.00 USD. Final quarterly coupon on 3,500,000 face', cash: { USD: 83_125 } }],
        cash: { account: { USD: { settled: 1_439_375, availableToTrade: 1_439_375 } } },
        positions: [{ ...ILS_POS, qty: 3_500_000, cost: 3_500_000, value: 3_447_500, manual: ilsM({ faceLost: 1_500_000, coupons: 439_375, valuation: { date: '2026-11-13', source: 'Broker indication, residual exposure after the loss notice', stale: true } }) }],
        pnl: { account: { couponInterest: 439_375, total: -1_113_125 } },
        nav: { account: 4_886_875, book: 6_886_875 },
        balance: { account: { cash: 1_439_375, assets: 4_886_875, netAssets: 4_886_875 } },
      },
    },
    {
      // 3,500,000 face at 100 = 3,500,000, paid T+2 on the USD calendar: Friday 1 January 2027 is a holiday, so Tuesday 5 January.
      id: 'redemption', covers: 'close', action: 'lifecycle', lot: 'note', body: { action: 'settle', redemptionPrice: 100 },
      expect: {
        events: [{ type: 'manual.settlement', summary: 'Redemption at maturity of SHRE26A entered by hand: 3,500,000.00 USD of face at 100.00% = 3,500,000.00 USD, paid 2027-01-05', owner: 'account', date: '2026-12-31' }],
        cash: { account: { USD: { settled: 1_439_375, unsettled: 3_500_000, availableToTrade: 4_939_375 } } },
        positions: [],
        holdings: { main: null },
        pending: [{ instrument: 'main', lot: 'note', owner: 'account', dueDate: '2027-01-05', amount: 3_500_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [],
        pnl: { account: { realized: -1_500_000, couponInterest: 439_375, unrealized: 0, total: -1_060_625 } },
        nav: { account: 4_939_375, book: 6_939_375 },
        provisional: { account: false, book: false },
        balance: { account: { cash: 1_439_375, receivable: 3_500_000, positions: null, assets: 4_939_375, netAssets: 4_939_375 } },
      },
    },
    {
      id: 'redemption-paid', covers: 'settlement', action: 'clock', to: '2027-01-05T15:00:00.000Z',
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 3,500,000.00 USD into settled cash', cash: { USD: 3_500_000 }, date: '2027-01-05' }],
        cash: { account: { USD: { settled: 4_939_375, unsettled: 0, availableToTrade: 4_939_375 } } },
        pending: [],
        balance: { account: { cash: 4_939_375, receivable: null, assets: 4_939_375, liabilities: 0, netAssets: 4_939_375 } },
      },
    },
  ],
};

export default [privateEquity, ventureCapital, hedgeFund, infrastructure, directRealEstate, insuranceLinked];
