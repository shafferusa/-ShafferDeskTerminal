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

export default [privateEquity, ventureCapital];
