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

export default [privateEquity];
