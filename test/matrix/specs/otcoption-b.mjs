// OTC options (engine family "otcoption"), the products the catalog marks as partly supported, each with its manual
// workflow worked through to completion: cds_swaption, barrier_option, asian_option, lookback_option, basket_option,
// spread_option, quanto_option, compound_option. One scenario per product, on its own fictional contract registered
// as exactly that product.
//
// Every expected number is a literal worked out by hand from the inputs in the same spec, with the arithmetic in a
// comment beside it. Nothing here is copied from what the Terminal prints. The general rules (quantity, premium,
// stated fill price, marks by hand, commission, settlement lag, collateral basis, exercise styles) are restated at the
// top of otcoption-a.mjs. What each of these products adds, and what is recorded by hand:
//   - barrier: a knock-in or knock-out is recorded by hand on the position (Lifecycle, Barrier event), once; at expiry
//     a knocked-out (or never knocked-in) option pays its rebate, a live one its intrinsic value. Prices between closes
//     are not monitored.
//   - Asian: the payoff is max(A - K, 0) for a call, max(K - A, 0) for a put, A the arithmetic mean of the underlying's
//     closes on the averaging dates; each close is supplied by a close fixture or entered by hand for its date.
//   - lookback (fixed strike): the observed maximum (call) or minimum (put), recorded by hand on the position, against
//     the strike; floating strike: the expiry close against the observed minimum (call) or maximum (put).
//   - basket and spread: the composite's value at expiry is entered by hand on the expiry item; the payoff is worked
//     out from it against the strike.
//   - quanto: the underlying's close in its own currency against the strike in that currency, converted into the
//     trading currency at the contract's fixed rate.
//   - compound: exercised into the underlying option at the strike (a premium per unit of the underlying option);
//     at expiry, against the underlying option's mark for that date.
//   - credit-default swaption: knocked out by a credit event on the reference entity, recorded by hand; exercised into
//     the registered credit default swap at an upfront stated per 100.

export const family = 'otcoption';

const dst = (date) => date >= '2026-03-08' && date < '2026-11-01';
/** 10:00 New York as a UTC instant. */
const at = (date, hhmm) => `${date}T${hhmm || (dst(date) ? '14:00' : '15:00')}:00.000Z`;
/** 17:30 New York: after the 17:00 end-of-day pass. */
const eod = (date) => `${date}T${dst(date) ? '21:30' : '22:30'}:00.000Z`;

const FILL = { halfSpreadBps: { equity: 0, otcoption: 0, bond: 0, crypto: 0, spot: 0, fx: 0 }, optionHalfSpreadPct: 0, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false, maxPreviewDriftPct: 0.5 };
const NO_FEE = { perUnit: 0, minimum: 0, bps: 0 };

const OTC_TICKET = {
  ticket: 'Registry form (Instruments, New instrument) for the contract: underlying, Type, Strike, Expiration, Payoff and its own fields, Exercise style, Settlement, Multiplier, Counterparty and the required Collateral terms group; then the instrument drawer, Trade tab (Buy / Sell, quantity, State a fill price); the strategy instance for close and the Lifecycle menu; Accounting, Pending for the inputs an expiry item waits for',
  requiredFields: ['Underlying instrument (or the underlying reference)', 'Type', 'Strike', 'Expiration', 'Payoff', 'Collateral basis', 'Account', 'Action', 'Quantity', 'State a fill price (the premium agreed with the dealer: no executable quote exists for an OTC option)'],
};
const otcTicket = ({ instrument, side, qty, premium, ...rest }) => ({ action: 'ticket', instrument, side, qty, order: { statedPrice: premium }, ...rest });
const usdStart = (account, treasury) => ({
  cash: {
    account: { USD: { settled: account, unsettled: 0, reserved: 0, restricted: 0, margin: 0, availableToTrade: account, availableToWithdraw: account } },
    treasury: { USD: { settled: treasury } },
  },
  positions: [], pending: [], openOrders: [], lifecycle: [], borrowings: [], otc: [], alerts: [],
  nav: { account, treasury, book: account + treasury },
  provisional: { account: false, book: false },
  failed: { orders: 0, settlements: 0, lifecycle: 0 },
});

// ---------------------------------------------------------------------------------------------
// barrier_option
// ---------------------------------------------------------------------------------------------
// Two barrier options on Norland Mining (NRLD, NYSE), cash-settled against the 18 June 2026 close, dealt with Dealer K:
//   - an up-and-out call struck at 40 with a barrier at 50 and a rebate of 1.00 a unit, bought on 20,000 units;
//     uncollateralized (explicit paper assumption).
//   - a down-and-in put struck at 45 with a barrier at 30, written on 20,000 units; position-level terms: independent
//     amount 10% of strike notional, no variation margin.
// NRLD falls to 29.80 in March (the put is knocked in: recorded by hand; a second record is refused), rallies to 50.20 in
// April (the call is knocked out: recorded by hand) and closes at 42.00 on 18 June. A vanilla call would pay 2.00; the
// knocked-out call pays its 1.00 rebate. The knocked-in put pays 45 - 42 = 3.00. Both are paid T+1, which is Monday 22
// June (Friday 19 June is Juneteenth).
const UOC = 'NRLD 40 up-and-out call, barrier 50, rebate 1.00, 18 Jun 2026 (Dealer K)';
const DIP = 'NRLD 45 down-and-in put, barrier 30, 18 Jun 2026 (Dealer K)';
const barrierOption = {
  productId: 'barrier_option',
  title: 'Norland Mining barriers: up-and-out call (knocked out, pays its rebate) bought; down-and-in put (knocked in, pays at expiry) written',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Barrier (up / down, in / out)', 'Barrier level', 'Rebate per unit'],
    automaticInputs: ['NRLD price (quote fixture standing in for Shaffer MarketData) for the notional', 'premium settlement date, T+2 on the US calendar', 'commission per unit from the Book fee schedule', 'independent amount from the position-level terms', 'expiry item settled against the NRLD close for the expiration date (close fixture), taking the recorded barrier events into account'],
    manualInputs: ['premium agreed with the dealer (stated fill price)', 'marks entered by hand (Manual entry)', 'each barrier event, recorded by hand on the position (Lifecycle, Barrier event), once', 'a second barrier event on the same position, refused'],
    settlement: 'Premium and commission T+2 on the US calendar; the rebate and the put\'s payoff T+1 after expiry, across Juneteenth',
    lifecycle: 'Barrier events recorded by hand (intraday monitoring is not simulated); at expiry a knocked-out call pays its rebate, a knocked-in put its intrinsic value; nothing scheduled afterwards',
    accounting: 'Premium per unit x units; premium realized at expiry against the rebate or payoff; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): uncollateralized, an explicit paper assumption. Put (written): position-level terms, independent amount 10% x 20,000 x 45 = 90,000, posted at entry and returned at expiry',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix barrier option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Exotics', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.01, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { otcoption: 2, equity: 1 } },
  },
  instruments: {
    stock: { productId: 'common_stock', name: 'Norland Mining Corp.', symbol: 'NRLD', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Norland Mining Corp.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    call: {
      productId: 'barrier_option', name: UOC, symbol: 'NRLD-UOC40', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'C', strike: 40, expiration: '2026-06-18', optionType: 'barrier', barrier: { type: 'up-out', level: 50, rebate: 1 }, exercise: 'european', settlement: 'cash', counterparty: 'Dealer K', collateralBasis: { type: 'uncollateralized' } },
    },
    put: {
      productId: 'barrier_option', name: DIP, symbol: 'NRLD-DIP45', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'P', strike: 45, expiration: '2026-06-18', optionType: 'barrier', barrier: { type: 'down-in', level: 30 }, exercise: 'european', settlement: 'cash', counterparty: 'Dealer K',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false, threshold: 0, minimumTransfer: 0 } },
    },
  },
  quotes: { stock: { bid: 39.98, ask: 40.02, last: 40, bidSize: 200_000, askSize: 200_000 } },
  expectAtStart: usdStart(1_000_000, 1_000_000),
  steps: [
    otcTicket({
      id: 'buy-up-and-out-call', covers: 'open', instrument: 'call', side: 'buy', qty: 20_000, premium: 2.10, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 20_000, estimate: 2.1, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -42_000, fees: 200, notional: 800_000 }], // 20,000 x 2.10; 20,000 x 0.01; 20,000 x 40
          cash: { USD: { purchases: 42_000, fees: 200, margin: 0, required: 42_200, available: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 20_000, avgPrice: 2.1 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 20,000 NRLD-UOC40 @ 2.10 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -42_200, availableToTrade: 957_800, availableToWithdraw: 957_800 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 20_000, avgCost: 2.1, cost: 42_000, price: null, value: null, unrealized: null, provisional: true, notional: 800_000, margin: 0 }],
        holdings: { call: { long: 20_000, short: 0, net: 20_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -42_200, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-18', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', qty: 20_000, basis: 'uncollateralized', mark: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -200, unrealized: 0, total: -200 } },
        nav: { account: 999_800, book: 1_999_800 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, payable: 42_200, positions: 42_000, assets: 1_042_000, liabilities: 42_200, netAssets: 999_800 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 10% x 20,000 x 45 x 1 = 90,000.
      id: 'write-down-and-in-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 20_000, premium: 1.20, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 20_000, estimate: 1.2, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 24_000, fees: 200, notional: 800_000 }],
          cash: { USD: { proceeds: 24_000, fees: 200, margin: 90_000, required: 90_200, available: 957_800, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 20_000, avgPrice: 1.2 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 20,000 NRLD-DIP45 @ 1.20 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${DIP} under its position-level terms: 90,000.00 USD (independent amount, 10.00% of 900,000.00 USD notional)`, cash: { USD: -90_000 } },
        ],
        cash: { account: { USD: { settled: 910_000, unsettled: -18_400, margin: 90_000, availableToTrade: 891_600, availableToWithdraw: 867_800 } } }, // -42,200 + 23,800; 910,000 - 42,200
        positions: [
          { instrument: 'call', lot: 'calls', qty: 20_000 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -20_000, avgCost: 1.2, cost: -24_000, price: null, value: null, unrealized: null, provisional: true, notional: 800_000, margin: 90_000 },
        ],
        holdings: { put: { long: 0, short: 20_000, net: -20_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -42_200, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 23_800, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-18', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-06-18', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -20_000, basis: 'position', iaRequired: 90_000, iaPosted: 90_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -400, total: -400 } },
        nav: { account: 999_600, book: 1_999_600 }, // 910,000 + 90,000 + 23,800 - 42,200 + 42,000 - 24,000
        balance: { account: { cash: 910_000, margin: 90_000, receivable: 23_800, payable: 42_200, positions: 18_000, assets: 1_041_800, liabilities: 42_200, netAssets: 999_600 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 2.00, note: 'Dealer K mark, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 2, value: 40_000, unrealized: -2_000, provisional: false }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 2, markValue: 40_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: -2_000, total: -2_400 } },
        nav: { account: 997_600, book: 1_997_600 },
        balance: { account: { positions: 16_000, assets: 1_039_800, netAssets: 997_600 } }, // 40,000 - 24,000
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 1.50, note: 'Dealer K mark, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 1.5, value: -30_000, unrealized: -6_000, provisional: false }], // -20,000 x 1.50; + 24,000
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 1.5, markValue: -30_000 }],
        pnl: { account: { unrealized: -8_000, total: -8_400 } },
        nav: { account: 991_600, book: 1_991_600 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 10_000, assets: 1_033_800, netAssets: 991_600 } },
      },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 23,800.00 USD into settled cash', cash: { USD: 23_800 } },
          { type: 'settlement.pay', summary: 'paid 42,200.00 USD from settled cash', cash: { USD: -42_200 } },
        ],
        cash: { account: { USD: { settled: 891_600, unsettled: 0, availableToTrade: 891_600, availableToWithdraw: 891_600 } } },
        pending: [],
        balance: { account: { cash: 891_600, receivable: null, payable: null, assets: 991_600, liabilities: 0 } },
      },
    },
    { id: 'monday-16-march', action: 'clock', to: at('2026-03-16'), expect: {} },
    {
      id: 'nrld-falls', action: 'quote', instrument: 'stock', quote: { bid: 29.78, ask: 29.82, last: 29.80, bidSize: 200_000, askSize: 200_000 },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: 596_000 }, { instrument: 'put', lot: 'puts', notional: 596_000 }] }, // 20,000 x 29.80
    },
    {
      id: 'put-knocked-in', covers: 'barrier event', action: 'lifecycle', lot: 'puts', body: { action: 'barrier', note: 'NRLD traded at 29.80, below the 30.00 barrier' },
      expect: { events: [{ type: 'option.barrier_event', summary: 'Barrier event recorded on NRLD-DIP45: down-in at 30. NRLD traded at 29.80, below the 30.00 barrier', owner: 'account', date: '2026-03-16' }] },
    },
    {
      id: 'second-barrier-event-refused', covers: 'barrier event', action: 'lifecycle', lot: 'puts', body: { action: 'barrier', note: 'again' },
      status: 'blocked', reason: 'A barrier event is recorded once on a position: the put is already knocked in.',
      expect: { refused: { engine: 'The barrier event is already recorded on this position', api: 'The barrier event is already recorded on this position', browser: '"Barrier event" is not offered' } },
    },
    { id: 'monday-20-april', action: 'clock', to: at('2026-04-20'), expect: {} },
    {
      id: 'nrld-rallies', action: 'quote', instrument: 'stock', quote: { bid: 50.18, ask: 50.22, last: 50.20, bidSize: 200_000, askSize: 200_000 },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: 1_004_000 }, { instrument: 'put', lot: 'puts', notional: 1_004_000 }] }, // 20,000 x 50.20
    },
    {
      id: 'call-knocked-out', covers: 'barrier event', action: 'lifecycle', lot: 'calls', body: { action: 'barrier', note: 'NRLD traded at 50.20, above the 50.00 barrier' },
      expect: { events: [{ type: 'option.barrier_event', summary: 'Barrier event recorded on NRLD-UOC40: up-out at 50. NRLD traded at 50.20, above the 50.00 barrier', owner: 'account', date: '2026-04-20' }] },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'stock', date: '2026-06-18', value: 42, expect: {} },
    {
      // NRLD closed at 42.00. Call: knocked out, so it pays its rebate, 1.00 a unit: 20,000, not the 2.00 a vanilla call would
      // pay; realized 20,000 - 42,000. Put: knocked in, 45 - 42 = 3.00 a unit: 60,000 paid by the Account; realized 24,000 -
      // 60,000. Both T+1: Monday 22 June (19 June is Juneteenth). The 90,000 comes back.
      id: 'expiry', covers: ['expiry', 'rebate', 'cash settlement', 'collateral'], action: 'clock', to: eod('2026-06-18'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Exercised (cash settlement): 20,000 NRLD-UOC40 at 1.00 USD per unit (barrier rebate)', owner: 'account', date: '2026-06-18' },
          { type: 'option.cash_settled', summary: 'Assigned (cash settlement): 20,000 NRLD-DIP45 at 3.00 USD per unit (fixing 42.00)', owner: 'account', date: '2026-06-18' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${DIP} under its position-level terms: 90,000.00 USD (independent amount, the position ended)`, cash: { USD: 90_000 } },
        ],
        cash: { account: { USD: { settled: 981_600, margin: 0, unsettled: -40_000, availableToTrade: 941_600, availableToWithdraw: 921_600 } } }, // 891,600 + 90,000; 20,000 - 60,000
        positions: [], holdings: { call: null, put: null }, otc: [], lifecycle: [],
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-06-22', amount: 20_000, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-06-22', amount: -60_000, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: -58_000, unrealized: 0, total: -58_400 } }, // -22,000 - 36,000; - 400
        nav: { account: 941_600, book: 1_941_600 },
        balance: { account: { cash: 981_600, margin: null, receivable: 20_000, payable: 60_000, positions: null, assets: 1_001_600, liabilities: 60_000, netAssets: 941_600 } },
      },
    },
    {
      id: 'settle-after-juneteenth', covers: ['settlement', 'holiday'], action: 'clock', to: at('2026-06-22'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 20,000.00 USD into settled cash', cash: { USD: 20_000 } },
          { type: 'settlement.pay', summary: 'paid 60,000.00 USD from settled cash', cash: { USD: -60_000 } },
        ],
        cash: { account: { USD: { settled: 941_600, unsettled: 0, availableToTrade: 941_600, availableToWithdraw: 941_600 } } },
        pending: [],
        balance: { account: { cash: 941_600, receivable: null, payable: null, assets: 941_600, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// asian_option
// ---------------------------------------------------------------------------------------------
// Two average-price options on gold held in a New York vault (Hudson Bullion, USD per troy ounce; quantity in troy
// ounces), cash-settled, dealt with Dealer L. The average is the arithmetic mean of the gold closes on the last five
// business days of May 2026: Friday 22, Tuesday 26 (Monday 25 is Memorial Day), Wednesday 27, Thursday 28 and Friday 29
// May (expiration). Payoff: call max(A - K, 0), put max(K - A, 0), per ounce.
//   - an average-price call struck at 2,400, bought on 1,000 oz; position-level terms: variation margin over 25,000.
//   - an average-price put struck at 2,350, written on 1,000 oz; position-level terms: independent amount 5% of strike
//     notional.
// Three closes are supplied by the close fixture (22 May 2,410; 26 May 2,425; 28 May 2,430). The other two are not: the
// expiry items wait, naming the missing dates, until each is entered by hand (27 May 2,440; 29 May 2,445).
// A = (2,410 + 2,425 + 2,440 + 2,430 + 2,445) / 5 = 12,150 / 5 = 2,430.00. Call: 30.00 an ounce, 30,000. Put: lapses.
const GOLD = 'Gold, 400-oz Good Delivery bars, New York vault (Hudson Bullion)';
const ACALL = 'Gold average-price call 2,400, May 2026 (Dealer L)';
const APUT = 'Gold average-price put 2,350, May 2026 (Dealer L)';
const AVERAGING = ['2026-05-22', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29'];
const asianOption = {
  productId: 'asian_option',
  title: 'Gold average-price options on five May closes: call 2,400 bought (pays), put 2,350 written (lapses); two fixings entered by hand',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Payoff: Asian (average of fixings)', 'Averaging dates'],
    automaticInputs: ['gold price (quote fixture standing in for Shaffer MarketData) for the notional', 'gold closes for the averaging dates where supplied (close fixture)', 'the average and the payoff, worked out from the five closes', 'premium settlement date, T+2 on the US calendar', 'commission per ounce from the Book fee schedule', 'variation margin and independent amount from the position-level terms'],
    manualInputs: ['premium per ounce agreed with the dealer (stated fill price)', 'marks entered by hand (Manual entry)', 'each averaging fixing the data service has not supplied, entered by hand as the closing price for its date (instrument drawer, Overview)'],
    settlement: 'Premium and commission T+2 on the US calendar; the cash settlement T+1 after expiry',
    lifecycle: 'Expiry item on 29 May waits for every averaging fixing, naming the missing dates; once all five exist the call pays (A - K) x ounces and the put lapses; held across Memorial Day; nothing scheduled afterwards',
    accounting: 'Premium per ounce x ounces; payoff max(A - K, 0) from the arithmetic mean of the fixings; premium realized at expiry; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): position-level terms, variation margin over 25,000, received from the dealer and returned at settlement. Put (written): independent amount 5% x 1,000 x 2,350 = 117,500, returned at expiry',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix Asian option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 4_000_000 }],
    account: { name: 'Metals', funding: [{ ccy: 'USD', amount: 1_000_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.50, minimum: 0, bps: 0 }, spot: NO_FEE }, fill: FILL, settlement: { otcoption: 2, spot: 2 } }, // 0.50 an ounce
  },
  instruments: {
    gold: { productId: 'precious_metal', name: GOLD, symbol: 'XAU-HB', marketView: 'US_CASH', venue: 'Hudson Bullion (OTC dealer)', venueType: 'otc', venueCountry: 'US', issuer: 'Hudson Bullion LLC', domicile: 'US', underlyingGeo: 'Global', tradingCcy: 'USD', terms: { quantityUnit: 'troy ounces', priceUnits: 'USD per troy ounce' } },
    call: {
      productId: 'asian_option', name: ACALL, symbol: 'XAU-AC2400-MAY26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'gold', multiplier: 1,
      terms: { right: 'C', strike: 2_400, expiration: '2026-05-29', optionType: 'asian', averagingDates: AVERAGING, exercise: 'european', settlement: 'cash', counterparty: 'Dealer L',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 25_000, minimumTransfer: 5_000 } },
    },
    put: {
      productId: 'asian_option', name: APUT, symbol: 'XAU-AP2350-MAY26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'gold', multiplier: 1,
      terms: { right: 'P', strike: 2_350, expiration: '2026-05-29', optionType: 'asian', averagingDates: AVERAGING, exercise: 'european', settlement: 'cash', counterparty: 'Dealer L',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: false, threshold: 0, minimumTransfer: 0 } },
    },
  },
  quotes: { gold: { bid: 2_349, ask: 2_351, last: 2_350, bidSize: 100_000, askSize: 100_000 } },
  closes: { gold: { '2026-05-22': 2_410, '2026-05-26': 2_425, '2026-05-28': 2_430 } }, // supplied; 27 and 29 May are not
  expectAtStart: usdStart(1_000_000, 3_000_000),
  steps: [
    otcTicket({
      id: 'buy-average-call', covers: 'open', instrument: 'call', side: 'buy', qty: 1_000, premium: 45, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 1_000, estimate: 45, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -45_000, fees: 500, notional: 2_350_000 }], // 1,000 x 45; 1,000 x 0.50; 1,000 x 2,350
          cash: { USD: { purchases: 45_000, fees: 500, margin: 0, required: 45_500, available: 1_000_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 1_000, avgPrice: 45 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 1,000 XAU-AC2400-MAY26 @ 45.00 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 1_000_000, unsettled: -45_500, availableToTrade: 954_500, availableToWithdraw: 954_500 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 1_000, avgCost: 45, cost: 45_000, price: null, value: null, unrealized: null, provisional: true, notional: 2_350_000, margin: 0 }],
        holdings: { call: { long: 1_000, short: 0, net: 1_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -45_500, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-05-29', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', qty: 1_000, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 999_500, book: 3_999_500 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 1_000_000, payable: 45_500, positions: 45_000, assets: 1_045_000, liabilities: 45_500, netAssets: 999_500 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 5% x 1,000 x 2,350 = 117,500.
      id: 'write-average-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 1_000, premium: 25, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 1_000, estimate: 25, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 25_000, fees: 500, notional: 2_350_000 }],
          cash: { USD: { proceeds: 25_000, fees: 500, margin: 117_500, required: 118_000, available: 954_500, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 1_000, avgPrice: 25 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 1,000 XAU-AP2350-MAY26 @ 25.00 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${APUT} under its position-level terms: 117,500.00 USD (independent amount, 5.00% of 2,350,000.00 USD notional)`, cash: { USD: -117_500 } },
        ],
        cash: { account: { USD: { settled: 882_500, unsettled: -21_000, margin: 117_500, availableToTrade: 861_500, availableToWithdraw: 837_000 } } }, // -45,500 + 24,500; 882,500 - 45,500
        positions: [
          { instrument: 'call', lot: 'calls', qty: 1_000 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -1_000, avgCost: 25, cost: -25_000, price: null, value: null, unrealized: null, provisional: true, notional: 2_350_000, margin: 117_500 },
        ],
        holdings: { put: { long: 0, short: 1_000, net: -1_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -45_500, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 24_500, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-05-29', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-29', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -1_000, basis: 'position', iaRequired: 117_500, iaPosted: 117_500, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -1_000, total: -1_000 } },
        nav: { account: 999_000, book: 3_999_000 }, // 882,500 + 117,500 + 24,500 - 45,500 + 45,000 - 25,000
        balance: { account: { cash: 882_500, margin: 117_500, receivable: 24_500, payable: 45_500, positions: 20_000, assets: 1_044_500, liabilities: 45_500, netAssets: 999_000 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 52, note: 'Dealer L mark per ounce, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 52, value: 52_000, unrealized: 7_000, provisional: false }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 52, markValue: 52_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: 7_000, total: 6_000 } },
        nav: { account: 1_006_000, book: 4_006_000 },
        balance: { account: { positions: 27_000, assets: 1_051_500, netAssets: 1_006_000 } }, // 52,000 - 25,000
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 20, note: 'Dealer L mark per ounce, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 20, value: -20_000, unrealized: 5_000, provisional: false }],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 20, markValue: -20_000 }],
        pnl: { account: { unrealized: 12_000, total: 11_000 } },
        nav: { account: 1_011_000, book: 4_011_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 32_000, assets: 1_056_500, netAssets: 1_011_000 } },
      },
    },
    {
      // Call marked at 52,000: 27,000 beyond its 25,000 threshold, posted by Dealer L.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 27,000.00 USD received. Netting set of 1 position marked at 52,000.00 USD; threshold 25,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 27_000 } } },
        otc: [{ instrument: 'call', vmHeld: 27_000, vmExposure: 52_000, vmStatus: 'ok' }, { instrument: 'put' }],
        balance: { account: { restricted: 27_000, collateralReceived: 27_000, assets: 1_083_500, liabilities: 72_500, netAssets: 1_011_000 } },
      },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 24,500.00 USD into settled cash', cash: { USD: 24_500 } },
          { type: 'settlement.pay', summary: 'paid 45,500.00 USD from settled cash', cash: { USD: -45_500 } },
        ],
        cash: { account: { USD: { settled: 861_500, unsettled: 0, availableToTrade: 861_500, availableToWithdraw: 861_500 } } },
        pending: [],
        balance: { account: { cash: 861_500, receivable: null, payable: null, assets: 1_038_000, liabilities: 27_000 } }, // 861,500 + 27,000 + 117,500 + 32,000
      },
    },
    // The dealer's gold quote stops before the averaging window (it would otherwise stand in for a missing close): from
    // here the only closes are the three the fixture supplies and those entered by hand.
    { id: 'thursday-21-may', action: 'clock', to: at('2026-05-21'), expect: {} },
    {
      id: 'gold-quote-withdrawn', action: 'quote', instrument: 'gold', quote: { clear: true },
      expect: { positions: [{ instrument: 'call', lot: 'calls', notional: null }, { instrument: 'put', lot: 'puts', notional: null }] }, // no gold price: the notional is missing, not zero
    },
    {
      // Expiration, after the close: three of the five averaging closes are supplied; 27 and 29 May are missing.
      id: 'expiry-awaits-fixings', covers: ['expiry', 'averaging fixings', 'holiday'], action: 'clock', to: eod('2026-05-29'),
      expect: {
        events: [],
        lifecycle: [
          { type: 'option.expiry', instrument: 'call', dueDate: '2026-05-29', status: 'blocked', reason: /^Awaiting the averaging fixings of XAU-HB for 2026-05-27, 2026-05-29\./ },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-29', status: 'blocked', reason: /^Awaiting the averaging fixings of XAU-HB for 2026-05-27, 2026-05-29\./ },
        ],
      },
    },
    {
      id: 'fixing-27-may-by-hand', covers: 'averaging fixings', action: 'manual_price', instrument: 'gold', value: 2_440, forDate: '2026-05-27', note: 'Gold close for 27 May, entered by hand',
      expect: {
        events: [],
        // The price entered by hand is now the latest gold price known: the notional is 1,000 x 2,440.
        positions: [{ instrument: 'call', lot: 'calls', notional: 2_440_000 }, { instrument: 'put', lot: 'puts', notional: 2_440_000 }],
        lifecycle: [
          { type: 'option.expiry', instrument: 'call', dueDate: '2026-05-29', status: 'blocked', reason: /^Awaiting the averaging fixings of XAU-HB for 2026-05-29\./ },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-05-29', status: 'blocked', reason: /^Awaiting the averaging fixings of XAU-HB for 2026-05-29\./ },
        ],
      },
    },
    {
      // The last fixing, entered by hand. A = 12,150 / 5 = 2,430.00. Call: 2,430 - 2,400 = 30.00 an ounce: 30,000, T+1
      // (Monday 1 June); realized 30,000 - 45,000; the 27,000 Dealer L posted goes back. Put: 2,430 is above 2,350: it lapses,
      // 25,000 realized; the 117,500 comes back.
      id: 'fixing-29-may-by-hand', covers: ['averaging fixings', 'expiry', 'cash settlement', 'lapse', 'collateral'], action: 'manual_price', instrument: 'gold', value: 2_445, forDate: '2026-05-29', note: 'Gold close for 29 May, entered by hand',
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Exercised (cash settlement): 1,000 XAU-AC2400-MAY26 at 30.00 USD per unit (average of 5 fixings 2,430.00)', owner: 'account', date: '2026-05-29' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 27,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'account' },
          { type: 'option.expired', summary: 'Expired worthless: 1,000 XAU-AP2350-MAY26 (average of 5 fixings 2,430.00)', owner: 'account', date: '2026-05-29' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${APUT} under its position-level terms: 117,500.00 USD (independent amount, the position ended)`, cash: { USD: 117_500 } },
        ],
        cash: { account: { USD: { settled: 979_000, restricted: 0, margin: 0, unsettled: 30_000, availableToTrade: 1_009_000, availableToWithdraw: 979_000 } } }, // 861,500 + 117,500
        positions: [], holdings: { call: null, put: null }, otc: [], lifecycle: [],
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-06-01', amount: 30_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 10_000, unrealized: 0, total: 9_000 } }, // -15,000 + 25,000; - 1,000
        nav: { account: 1_009_000, book: 4_009_000 },
        balance: { account: { cash: 979_000, receivable: 30_000, restricted: null, collateralReceived: null, margin: null, positions: null, assets: 1_009_000, liabilities: 0, netAssets: 1_009_000 } },
      },
    },
    {
      id: 'settle-cash-settlement', covers: 'settlement', action: 'clock', to: at('2026-06-01'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 30,000.00 USD into settled cash', cash: { USD: 30_000 } }],
        cash: { account: { USD: { settled: 1_009_000, unsettled: 0, availableToTrade: 1_009_000, availableToWithdraw: 1_009_000 } } },
        pending: [],
        balance: { account: { cash: 1_009_000, receivable: null } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// lookback_option
// ---------------------------------------------------------------------------------------------
// Two lookback options on Calder Biotech (CLDR, NASDAQ), cash-settled at expiry on Friday 12 June 2026, dealt with
// Dealer M. The Terminal does not monitor prices between closes: the extreme is recorded by hand on the position
// (Lifecycle, Lookback extreme) and a later record replaces it.
//   - a fixed-strike lookback call struck at 60, bought on 5,000 units; uncollateralized (explicit paper assumption).
//     Payoff: observed maximum - strike. Maximum recorded at 66.40 in April, then 71.25 in May: 11.25 a unit, 56,250.
//   - a floating-strike lookback put, written on 5,000 units (strike 62 recorded as the reference level at trade);
//     position-level terms: a fixed independent amount of 30,000. Payoff: observed maximum - expiry close. Its maximum
//     is not recorded when it expires: the item waits; once 71.25 is recorded it pays 71.25 - 68.00 = 3.25 a unit.
// Early exercise of the cash-settled call is refused: it is settled by its expiry item.
const LBC = 'CLDR fixed-strike lookback call 60, 12 Jun 2026 (Dealer M)';
const LBP = 'CLDR floating-strike lookback put, 12 Jun 2026 (Dealer M)';
const lookbackOption = {
  productId: 'lookback_option',
  title: 'Calder Biotech lookbacks: fixed-strike call bought (maximum recorded by hand, replaced once); floating-strike put written (waits for its maximum)',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Payoff: Lookback', 'Lookback strike (fixed or floating)'],
    automaticInputs: ['CLDR price (quote fixture standing in for Shaffer MarketData) for the notional', 'CLDR close for the expiration date (close fixture), for the floating-strike put', 'the payoff, worked out from the recorded extreme (and the close)', 'premium settlement date, T+2 on the US calendar', 'commission per unit from the Book fee schedule', 'independent amount from the position-level terms'],
    manualInputs: ['premium agreed with the dealer (stated fill price)', 'marks entered by hand (Manual entry)', 'the observed maximum, recorded by hand on each position (Lifecycle, Lookback extreme); a later record replaces an earlier one', 'early exercise of a cash-settled lookback, refused'],
    settlement: 'Premium and commission T+2 on the US calendar; the cash settlements T+1 after expiry',
    lifecycle: 'Extremes recorded by hand; at expiry the fixed-strike call pays (maximum - strike); the floating-strike put waits until its maximum is recorded, then pays (maximum - close); nothing scheduled afterwards',
    accounting: 'Premium per unit x units; payoff from the recorded extreme; premium realized at expiry; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): uncollateralized. Put (written): fixed independent amount 30,000, posted at entry and returned at settlement',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix lookback option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Exotics', funding: [{ ccy: 'USD', amount: 400_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.01, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { otcoption: 2, equity: 1 } },
  },
  instruments: {
    stock: { productId: 'common_stock', name: 'Calder Biotech Inc.', symbol: 'CLDR', marketView: 'US_CASH', venue: 'NASDAQ', venueType: 'exchange', venueCountry: 'US', issuer: 'Calder Biotech Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
    call: {
      productId: 'lookback_option', name: LBC, symbol: 'CLDR-LBC60-JUN26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'C', strike: 60, expiration: '2026-06-12', optionType: 'lookback', lookbackType: 'fixed', exercise: 'european', settlement: 'cash', counterparty: 'Dealer M', collateralBasis: { type: 'uncollateralized' } },
    },
    put: {
      productId: 'lookback_option', name: LBP, symbol: 'CLDR-LBPF-JUN26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'P', strike: 62, expiration: '2026-06-12', optionType: 'lookback', lookbackType: 'floating', exercise: 'european', settlement: 'cash', counterparty: 'Dealer M',
        collateralBasis: { type: 'position', independentAmount: { type: 'fixed', amount: 30_000 }, variationMargin: false, threshold: 0, minimumTransfer: 0 } },
    },
  },
  quotes: { stock: { bid: 61.98, ask: 62.02, last: 62, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: usdStart(400_000, 600_000),
  steps: [
    otcTicket({
      id: 'buy-lookback-call', covers: 'open', instrument: 'call', side: 'buy', qty: 5_000, premium: 6.50, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 5_000, estimate: 6.5, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -32_500, fees: 50, notional: 310_000 }], // 5,000 x 6.50; 5,000 x 0.01; 5,000 x 62
          cash: { USD: { purchases: 32_500, fees: 50, margin: 0, required: 32_550, available: 400_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 5_000, avgPrice: 6.5 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 5,000 CLDR-LBC60-JUN26 @ 6.50 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 400_000, unsettled: -32_550, availableToTrade: 367_450, availableToWithdraw: 367_450 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 5_000, avgCost: 6.5, cost: 32_500, price: null, value: null, unrealized: null, provisional: true, notional: 310_000, margin: 0 }],
        holdings: { call: { long: 5_000, short: 0, net: 5_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -32_550, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-12', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', qty: 5_000, basis: 'uncollateralized', mark: null, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -50, unrealized: 0, total: -50 } },
        nav: { account: 399_950, book: 999_950 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 400_000, payable: 32_550, positions: 32_500, assets: 432_500, liabilities: 32_550, netAssets: 399_950 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      id: 'write-lookback-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 5_000, premium: 4.00, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 5_000, estimate: 4, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 20_000, fees: 50, notional: 310_000 }],
          cash: { USD: { proceeds: 20_000, fees: 50, margin: 30_000, required: 30_050, available: 367_450, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 5_000, avgPrice: 4 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 5,000 CLDR-LBPF-JUN26 @ 4.00 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${LBP} under its position-level terms: 30,000.00 USD (independent amount, fixed amount for the position)`, cash: { USD: -30_000 } },
        ],
        cash: { account: { USD: { settled: 370_000, unsettled: -12_600, margin: 30_000, availableToTrade: 357_400, availableToWithdraw: 337_450 } } }, // -32,550 + 19,950; 370,000 - 32,550
        positions: [
          { instrument: 'call', lot: 'calls', qty: 5_000 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -5_000, avgCost: 4, cost: -20_000, price: null, value: null, unrealized: null, provisional: true, notional: 310_000, margin: 30_000 },
        ],
        holdings: { put: { long: 0, short: 5_000, net: -5_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -32_550, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 19_950, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-12', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-06-12', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -5_000, basis: 'position', iaRequired: 30_000, iaPosted: 30_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -100, total: -100 } },
        nav: { account: 399_900, book: 999_900 }, // 370,000 + 30,000 + 19,950 - 32,550 + 32,500 - 20,000
        balance: { account: { cash: 370_000, margin: 30_000, receivable: 19_950, payable: 32_550, positions: 12_500, assets: 432_450, liabilities: 32_550, netAssets: 399_900 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 7.00, note: 'Dealer M mark, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 7, value: 35_000, unrealized: 2_500, provisional: false }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 7, markValue: 35_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: 2_500, total: 2_400 } },
        nav: { account: 402_400, book: 1_002_400 },
        balance: { account: { positions: 15_000, assets: 434_950, netAssets: 402_400 } }, // 35,000 - 20,000
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 4.20, note: 'Dealer M mark, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 4.2, value: -21_000, unrealized: -1_000, provisional: false }],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 4.2, markValue: -21_000 }],
        pnl: { account: { unrealized: 1_500, total: 1_400 } },
        nav: { account: 401_400, book: 1_001_400 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 14_000, assets: 433_950, netAssets: 401_400 } },
      },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 19,950.00 USD into settled cash', cash: { USD: 19_950 } },
          { type: 'settlement.pay', summary: 'paid 32,550.00 USD from settled cash', cash: { USD: -32_550 } },
        ],
        cash: { account: { USD: { settled: 357_400, unsettled: 0, availableToTrade: 357_400, availableToWithdraw: 357_400 } } },
        pending: [],
        balance: { account: { cash: 357_400, receivable: null, payable: null, assets: 401_400, liabilities: 0 } },
      },
    },
    {
      id: 'early-exercise-refused', covers: 'exercise style', action: 'lifecycle', lot: 'calls', body: { action: 'exercise', contracts: 5_000 },
      status: 'blocked', reason: 'A cash-settled lookback is settled by its expiry item from the recorded extreme; it is not exercised by hand.',
      expect: { refused: 'A cash-settled lookback option is settled by its expiry item, from the extreme recorded on it' },
    },
    { id: 'wednesday-15-april', action: 'clock', to: at('2026-04-15'), expect: {} },
    {
      id: 'maximum-recorded', covers: 'lookback extreme', action: 'lifecycle', lot: 'calls', body: { action: 'extreme', value: 66.40, date: '2026-04-14', note: 'Dealer M confirmation' },
      expect: { events: [{ type: 'option.lookback_extreme', summary: 'Observed maximum of CLDR recorded on CLDR-LBC60-JUN26: 66.40 on 2026-04-14, recorded by hand. Dealer M confirmation', owner: 'account', date: '2026-04-15' }] },
    },
    { id: 'wednesday-20-may', action: 'clock', to: at('2026-05-20'), expect: {} },
    {
      id: 'higher-maximum-replaces', covers: 'lookback extreme', action: 'lifecycle', lot: 'calls', body: { action: 'extreme', value: 71.25, date: '2026-05-19', note: 'Dealer M confirmation' },
      expect: { events: [{ type: 'option.lookback_extreme', summary: 'Observed maximum of CLDR recorded on CLDR-LBC60-JUN26: 71.25 on 2026-05-19 (replaces 66.40), recorded by hand. Dealer M confirmation', owner: 'account', date: '2026-05-20' }] },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'stock', date: '2026-06-12', value: 68, expect: {} },
    {
      // Call: 71.25 - 60.00 = 11.25 a unit: 56,250, T+1 (Monday 15 June); realized 56,250 - 32,500 = 23,750. The put has
      // no recorded maximum: it waits.
      id: 'expiry', covers: ['expiry', 'cash settlement'], action: 'clock', to: eod('2026-06-12'),
      expect: {
        events: [{ type: 'option.cash_settled', summary: 'Exercised (cash settlement): 5,000 CLDR-LBC60-JUN26 at 11.25 USD per unit (observed maximum 71.25, recorded by hand)', owner: 'account', date: '2026-06-12' }],
        cash: { account: { USD: { unsettled: 56_250, availableToTrade: 413_650, availableToWithdraw: 357_400 } } },
        positions: [{ instrument: 'put', lot: 'puts', qty: -5_000 }],
        holdings: { call: null },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-06-15', amount: 56_250, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-06-12', status: 'blocked', reason: /^Record the observed maximum of CLDR over the life of the option/ }],
        otc: [{ instrument: 'put', lot: 'puts' }],
        pnl: { account: { realized: 23_750, unrealized: -1_000, total: 22_650 } },
        nav: { account: 422_650, book: 1_022_650 }, // 357,400 + 30,000 + 56,250 - 21,000
        balance: { account: { receivable: 56_250, positions: -21_000, assets: 422_650, netAssets: 422_650 } },
      },
    },
    {
      // The put's maximum, recorded by hand: 71.25. Floating strike: 71.25 - 68.00 (the close) = 3.25 a unit: 16,250 paid by
      // the Account, T+1; realized 20,000 - 16,250 = 3,750. The 30,000 comes back.
      id: 'put-maximum-recorded', covers: ['lookback extreme', 'expiry', 'cash settlement', 'collateral'], action: 'lifecycle', lot: 'puts', body: { action: 'extreme', value: 71.25, date: '2026-05-19', note: 'Dealer M confirmation' },
      expect: {
        events: [
          { type: 'option.lookback_extreme', summary: 'Observed maximum of CLDR recorded on CLDR-LBPF-JUN26: 71.25 on 2026-05-19, recorded by hand. Dealer M confirmation', owner: 'account' },
          { type: 'option.cash_settled', summary: 'Assigned (cash settlement): 5,000 CLDR-LBPF-JUN26 at 3.25 USD per unit (close 68.00 against the observed maximum 71.25, recorded by hand)', owner: 'account', date: '2026-06-12' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${LBP} under its position-level terms: 30,000.00 USD (independent amount, the position ended)`, cash: { USD: 30_000 } },
        ],
        cash: { account: { USD: { settled: 387_400, margin: 0, unsettled: 40_000, availableToTrade: 427_400, availableToWithdraw: 371_150 } } }, // 357,400 + 30,000; 56,250 - 16,250; 387,400 - 16,250
        positions: [], holdings: { put: null }, otc: [], lifecycle: [],
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-06-15', amount: 56_250, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-06-15', amount: -16_250, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: 27_500, unrealized: 0, total: 27_400 } }, // 23,750 + 3,750; - 100
        nav: { account: 427_400, book: 1_027_400 },
        balance: { account: { cash: 387_400, margin: null, receivable: 56_250, payable: 16_250, positions: null, assets: 443_650, liabilities: 16_250, netAssets: 427_400 } },
      },
    },
    {
      id: 'settle-cash-settlements', covers: 'settlement', action: 'clock', to: at('2026-06-15'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 56,250.00 USD into settled cash', cash: { USD: 56_250 } },
          { type: 'settlement.pay', summary: 'paid 16,250.00 USD from settled cash', cash: { USD: -16_250 } },
        ],
        cash: { account: { USD: { settled: 427_400, unsettled: 0, availableToTrade: 427_400, availableToWithdraw: 427_400 } } },
        pending: [],
        balance: { account: { cash: 427_400, receivable: null, payable: null, assets: 427_400, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// basket_option
// ---------------------------------------------------------------------------------------------
// Two options on an equal-weight basket of three fictional US rail stocks, owned by Treasury and dealt with Dealer N.
// The basket is a composite the Terminal does not compute: its level (100.00 on 2 March 2026, the average of the three
// price ratios x 100) is agreed with the dealer at expiry and entered by hand on each expiry item; the payoff is worked
// out from it against the strike, per unit of the level. Expiry Wednesday 16 September 2026, cash, paid T+1.
//   - a basket call struck at 100, bought on 10,000 units; position-level terms: variation margin over 20,000.
//   - a basket put struck at 95, written on 10,000 units; position-level terms: independent amount 10% of strike notional.
// The level at expiry is 108.40: the call pays 8.40 a unit, 84,000; the put lapses.
const BASKET = 'Equal-weight basket of Halden Rail (HRSI), Northway Rail (NRWY) and Coastal Transit (CSTX): 100.00 on 2 Mar 2026, average of the three price ratios x 100';
const BCALL = 'US rail basket call 100, 16 Sep 2026 (Dealer N)';
const BPUT = 'US rail basket put 95, 16 Sep 2026 (Dealer N)';
const basketOption = {
  productId: 'basket_option',
  title: 'Rail stock basket options owned by Treasury: call 100 bought, put 95 written; the basket level at expiry entered by hand',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields.filter((f) => !f.startsWith('Underlying instrument')), 'Payoff: Basket', 'Underlying reference: the basket, its components and weights'],
    automaticInputs: ['premium settlement date, T+2 on the US calendar', 'commission per unit from the Book fee schedule', 'variation margin and independent amount from the position-level terms', 'the payoff, worked out from the basket level entered against the strike'],
    manualInputs: ['premium agreed with the dealer (stated fill price)', 'marks entered by hand (Manual entry)', 'the basket level at expiry, entered by hand on each expiry item (Accounting, Pending, Settlement value)'],
    settlement: 'Premium and commission T+2 on the US calendar; the cash settlement T+1 after expiry',
    lifecycle: 'At expiry each item waits for the basket level; once entered, the call pays (level - strike) x units and the put lapses; held across Independence Day and Labor Day; nothing scheduled afterwards',
    accounting: 'Premium per unit of level x units; payoff from the level entered; premium realized at expiry; commission expensed; marks by hand drive unrealized P&L. The notional is shown at the strike: no basket price is available',
    collateral: 'Call (bought): position-level terms, variation margin over 20,000, received from the dealer and returned at settlement. Put (written): independent amount 10% x 10,000 x 95 = 95,000, returned at expiry',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix basket option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 3_000_000 }],
    account: { name: 'Alpha', funding: [{ ccy: 'USD', amount: 500_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.05, minimum: 0, bps: 0 } }, fill: FILL, settlement: { otcoption: 2 } },
  },
  instruments: {
    call: {
      productId: 'basket_option', name: BCALL, symbol: 'RAIL-BC100-SEP26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1,
      terms: { right: 'C', strike: 100, expiration: '2026-09-16', optionType: 'basket', underlyingDescription: BASKET, exercise: 'european', settlement: 'cash', counterparty: 'Dealer N',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 20_000, minimumTransfer: 5_000 } },
    },
    put: {
      productId: 'basket_option', name: BPUT, symbol: 'RAIL-BP95-SEP26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1,
      terms: { right: 'P', strike: 95, expiration: '2026-09-16', optionType: 'basket', underlyingDescription: BASKET, exercise: 'european', settlement: 'cash', counterparty: 'Dealer N',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false, threshold: 0, minimumTransfer: 0 } },
    },
  },
  expectAtStart: usdStart(500_000, 2_500_000),
  steps: [
    otcTicket({
      id: 'buy-basket-call', covers: 'open', owner: 'treasury', instrument: 'call', side: 'buy', qty: 10_000, premium: 4.20, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 10_000, estimate: 4.2, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -42_000, fees: 500, notional: 1_000_000 }], // 10,000 x 4.20; 10,000 x 0.05; 10,000 x 100 (at the strike)
          cash: { USD: { purchases: 42_000, fees: 500, margin: 0, required: 42_500, available: 2_500_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000, avgPrice: 4.2 }] },
        events: [{ type: 'strategy.submitted', owner: 'treasury' }, { type: 'trade.fill', summary: 'Bought 10,000 RAIL-BC100-SEP26 @ 4.20 USD', owner: 'treasury', date: '2026-03-02' }],
        cash: { treasury: { USD: { settled: 2_500_000, unsettled: -42_500, availableToTrade: 2_457_500, availableToWithdraw: 2_457_500 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'treasury', direction: 'long', qty: 10_000, avgCost: 4.2, cost: 42_000, price: null, value: null, unrealized: null, provisional: true, notional: null, margin: 0 }], // no basket price: no notional on the position
        holdings: { call: { long: 10_000, short: 0, net: 10_000 } },
        pending: [{ instrument: 'call', owner: 'treasury', dueDate: '2026-03-04', amount: -42_500, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-09-16', status: 'pending', owner: 'treasury' }],
        otc: [{ instrument: 'call', lot: 'calls', owner: 'treasury', qty: 10_000, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: 0, unrealized: 0, total: 0 }, treasury: { realized: 0, commissions: -500, unrealized: 0, total: -500 }, book: { commissions: -500, total: -500 } },
        nav: { account: 500_000, treasury: 2_499_500, book: 2_999_500 },
        provisional: { account: false, book: true },
        balance: {
          account: { cash: 500_000, assets: 500_000, liabilities: 0, netAssets: 500_000 },
          treasury: { cash: 2_500_000, payable: 42_500, positions: 42_000, assets: 2_542_000, liabilities: 42_500, netAssets: 2_499_500 },
        },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 10% x 10,000 x 95 = 95,000.
      id: 'write-basket-put', covers: ['write', 'collateral'], owner: 'treasury', instrument: 'put', side: 'sell', qty: 10_000, premium: 2.10, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 10_000, estimate: 2.1, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 21_000, fees: 500, notional: 950_000 }], // 10,000 x 95
          cash: { USD: { proceeds: 21_000, fees: 500, margin: 95_000, required: 95_500, available: 2_457_500, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000, avgPrice: 2.1 }] },
        events: [
          { type: 'strategy.submitted', owner: 'treasury' },
          { type: 'trade.fill', summary: 'Sold 10,000 RAIL-BP95-SEP26 @ 2.10 USD', owner: 'treasury' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${BPUT} under its position-level terms: 95,000.00 USD (independent amount, 10.00% of 950,000.00 USD notional)`, cash: { USD: -95_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 2_405_000, unsettled: -22_000, margin: 95_000, availableToTrade: 2_383_000, availableToWithdraw: 2_362_500 } } }, // -42,500 + 20,500; 2,405,000 - 42,500
        positions: [
          { instrument: 'call', lot: 'calls', qty: 10_000 },
          { instrument: 'put', lot: 'puts', owner: 'treasury', direction: 'short', qty: -10_000, avgCost: 2.1, cost: -21_000, price: null, value: null, unrealized: null, provisional: true, notional: null, margin: 95_000 },
        ],
        holdings: { put: { long: 0, short: 10_000, net: -10_000 } },
        pending: [
          { instrument: 'call', owner: 'treasury', dueDate: '2026-03-04', amount: -42_500, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'treasury', dueDate: '2026-03-04', amount: 20_500, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-09-16', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-09-16', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', owner: 'treasury', qty: -10_000, basis: 'position', iaRequired: 95_000, iaPosted: 95_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { treasury: { commissions: -1_000, total: -1_000 }, book: { commissions: -1_000, total: -1_000 } },
        nav: { treasury: 2_499_000, book: 2_999_000 }, // 2,405,000 + 95,000 + 20,500 - 42,500 + 42,000 - 21,000
        balance: { treasury: { cash: 2_405_000, margin: 95_000, receivable: 20_500, payable: 42_500, positions: 21_000, assets: 2_541_500, liabilities: 42_500, netAssets: 2_499_000 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 6.80, note: 'Dealer N mark, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 6.8, value: 68_000, unrealized: 26_000, provisional: false }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 6.8, markValue: 68_000 }, { instrument: 'put' }],
        pnl: { treasury: { unrealized: 26_000, total: 25_000 }, book: { unrealized: 26_000, total: 25_000 } },
        nav: { treasury: 2_525_000, book: 3_025_000 },
        balance: { treasury: { positions: 47_000, assets: 2_567_500, netAssets: 2_525_000 } }, // 68,000 - 21,000
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 1.10, note: 'Dealer N mark, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 1.1, value: -11_000, unrealized: 10_000, provisional: false }],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 1.1, markValue: -11_000 }],
        pnl: { treasury: { unrealized: 36_000, total: 35_000 }, book: { unrealized: 36_000, total: 35_000 } },
        nav: { treasury: 2_535_000, book: 3_035_000 },
        provisional: { book: false },
        balance: { treasury: { positions: 57_000, assets: 2_577_500, netAssets: 2_535_000 } },
      },
    },
    {
      // Call marked at 68,000: 48,000 beyond its 20,000 threshold, posted to Treasury by Dealer N.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 48,000.00 USD received. Netting set of 1 position marked at 68,000.00 USD; threshold 20,000.00 USD.', owner: 'treasury' }],
        cash: { treasury: { USD: { restricted: 48_000 } } },
        otc: [{ instrument: 'call', vmHeld: 48_000, vmExposure: 68_000, vmStatus: 'ok' }, { instrument: 'put' }],
        balance: { treasury: { restricted: 48_000, collateralReceived: 48_000, assets: 2_625_500, liabilities: 90_500, netAssets: 2_535_000 } },
      },
    },
    { id: 'treasury-screens', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 20,500.00 USD into settled cash', cash: { USD: 20_500 }, owner: 'treasury' },
          { type: 'settlement.pay', summary: 'paid 42,500.00 USD from settled cash', cash: { USD: -42_500 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 2_383_000, unsettled: 0, availableToTrade: 2_383_000, availableToWithdraw: 2_383_000 } } },
        pending: [],
        balance: { treasury: { cash: 2_383_000, receivable: null, payable: null, assets: 2_583_000, liabilities: 48_000 } }, // 2,383,000 + 48,000 + 95,000 + 57,000
      },
    },
    {
      // Expiry, after the close (held across Independence Day and Labor Day): both items wait for the basket level.
      id: 'expiry-awaits-basket-level', covers: ['expiry', 'holiday'], action: 'clock', to: eod('2026-09-16'),
      expect: {
        events: [],
        lifecycle: [
          { type: 'option.expiry', instrument: 'call', dueDate: '2026-09-16', status: 'blocked', reason: /^Enter the basket value at expiry \(Equal-weight basket of Halden Rail/ },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-09-16', status: 'blocked', reason: /^Enter the basket value at expiry/ },
        ],
      },
    },
    {
      // The level agreed with Dealer N, 108.40, entered on the call's item: (108.40 - 100) = 8.40 a unit: 84,000, T+1;
      // realized 84,000 - 42,000. The 48,000 Dealer N posted goes back.
      id: 'call-basket-level', covers: ['settlement value', 'expiry', 'cash settlement', 'collateral'], action: 'settlement_value', lot: 'calls', value: 108.40,
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Exercised (cash settlement): 10,000 RAIL-BC100-SEP26 at 8.40 USD per unit (basket value 108.40, entered by hand)', owner: 'treasury', date: '2026-09-16' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 48,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'treasury' },
        ],
        cash: { treasury: { USD: { restricted: 0, unsettled: 84_000, availableToTrade: 2_467_000, availableToWithdraw: 2_383_000 } } },
        positions: [{ instrument: 'put', lot: 'puts', qty: -10_000 }],
        holdings: { call: null },
        pending: [{ instrument: 'call', owner: 'treasury', dueDate: '2026-09-17', amount: 84_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-09-16', status: 'blocked' }],
        otc: [{ instrument: 'put', lot: 'puts' }],
        pnl: { treasury: { realized: 42_000, unrealized: 10_000, total: 51_000 }, book: { realized: 42_000, unrealized: 10_000, total: 51_000 } },
        nav: { treasury: 2_551_000, book: 3_051_000 }, // 2,383,000 + 95,000 + 84,000 - 11,000
        balance: { treasury: { restricted: null, collateralReceived: null, receivable: 84_000, positions: -11_000, assets: 2_551_000, liabilities: 0, netAssets: 2_551_000 } },
      },
    },
    {
      // The same level on the put's item: 108.40 is above 95: it lapses, 21,000 realized; the 95,000 comes back.
      id: 'put-basket-level', covers: ['settlement value', 'expiry', 'lapse', 'collateral'], action: 'settlement_value', lot: 'puts', value: 108.40,
      expect: {
        events: [
          { type: 'option.expired', summary: 'Expired worthless: 10,000 RAIL-BP95-SEP26 (basket value 108.40, entered by hand)', owner: 'treasury', date: '2026-09-16' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${BPUT} under its position-level terms: 95,000.00 USD (independent amount, the position ended)`, cash: { USD: 95_000 }, owner: 'treasury' },
        ],
        cash: { treasury: { USD: { settled: 2_478_000, margin: 0, availableToTrade: 2_562_000, availableToWithdraw: 2_478_000 } } },
        positions: [], holdings: { put: null }, otc: [], lifecycle: [],
        pnl: { treasury: { realized: 63_000, unrealized: 0, total: 62_000 }, book: { realized: 63_000, unrealized: 0, total: 62_000 } },
        nav: { treasury: 2_562_000, book: 3_062_000 },
        balance: { treasury: { cash: 2_478_000, margin: null, positions: null, assets: 2_562_000, netAssets: 2_562_000 } },
      },
    },
    {
      id: 'settle-cash-settlement', covers: 'settlement', action: 'clock', to: at('2026-09-17'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 84,000.00 USD into settled cash', cash: { USD: 84_000 }, owner: 'treasury' }],
        cash: { treasury: { USD: { settled: 2_562_000, unsettled: 0, availableToTrade: 2_562_000, availableToWithdraw: 2_562_000 } } },
        pending: [],
        balance: { treasury: { cash: 2_562_000, receivable: null } },
      },
    },
    { id: 'treasury-screens-closed', covers: 'owner screens', action: 'owner_screens', owner: 'treasury', expect: {} },
  ],
};

// ---------------------------------------------------------------------------------------------
// spread_option
// ---------------------------------------------------------------------------------------------
// Two options on the RBOB gasoline / WTI crude crack spread (USD per barrel; quantity in barrels), dealt with Dealer P
// under one CSA whose netting set is the Account (independent amount 5% of strike notional on a written option;
// variation margin over a 100,000 threshold, minimum transfer 25,000). The spread is a composite the Terminal does not
// compute: its value at expiry (the May RBOB settlement x 42 less the May WTI settlement, agreed with the dealer) is
// entered by hand on each expiry item. Expiry Tuesday 28 April 2026, cash, paid T+1.
//   - a spread call struck at 20.00, bought on 100,000 bbl;
//   - a spread put struck at 25.00, written on 100,000 bbl.
// The spread settles at 23.10: the call pays 3.10 a barrel, 310,000; the put is in the money too and costs 1.90 a barrel,
// 190,000.
const CRACK = 'RBOB gasoline / WTI crude crack spread, May 2026 settlements (RBOB x 42 less WTI), USD per barrel';
const SCALL = 'RBOB-WTI crack spread call 20.00, 28 Apr 2026 (Dealer P)';
const SPUT = 'RBOB-WTI crack spread put 25.00, 28 Apr 2026 (Dealer P)';
const spreadOption = {
  productId: 'spread_option',
  title: 'RBOB-WTI crack spread options netted under one CSA: call 20.00 bought, put 25.00 written; the spread at expiry entered by hand',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields.filter((f) => !f.startsWith('Underlying instrument')), 'Payoff: Spread', 'Underlying reference: the two legs of the spread'],
    automaticInputs: ['premium settlement date, T+2 on the US calendar', 'commission per barrel from the Book fee schedule', 'independent amount on the written put and variation margin on the Account netting set, from the CSA terms', 'the payoff, worked out from the spread value entered against the strike'],
    manualInputs: ['premium per barrel agreed with the dealer (stated fill price)', 'marks per barrel entered by hand (Manual entry)', 'the spread value at expiry, entered by hand on each expiry item (Accounting, Pending, Settlement value)'],
    settlement: 'Premium and commission T+2 on the US calendar; the cash settlements T+1 after expiry',
    lifecycle: 'At expiry each item waits for the spread value; once entered, the call pays (spread - 20) and the put costs (25 - spread) per barrel; nothing scheduled afterwards',
    accounting: 'Premium per barrel x barrels; payoff from the spread value entered; premium realized at expiry; commission expensed; marks by hand drive unrealized P&L. The notional is shown at the strike: no spread price is available',
    collateral: 'Agreement "CSA Dealer P", netting scope the Account: one netting set for both options; independent amount on the written put, 5% x 100,000 x 25 = 125,000, returned at expiry; the set marked at +30,000 stays inside its 100,000 threshold, so no variation margin moves',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix spread option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 2_000_000 }],
    account: { name: 'Refining', funding: [{ ccy: 'USD', amount: 800_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.005, minimum: 0, bps: 0 } }, fill: FILL, settlement: { otcoption: 2 } }, // 0.005 a barrel
  },
  instruments: {},
  tradedOn: 'Both spread options name the CSA recorded by the first step, so each is registered by a register_instrument step (Instruments, New instrument).',
  expectAtStart: usdStart(800_000, 1_200_000),
  steps: [
    {
      id: 'agreement', covers: 'collateral', action: 'agreement', as: 'csa',
      agreement: { name: 'CSA Dealer P', counterparty: 'Dealer P', kind: 'bilateral', independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true, threshold: 100_000, minimumTransfer: 25_000, nettingScope: 'account' },
      expect: { events: [{ type: 'collateral.agreement', summary: 'Collateral agreement recorded: CSA Dealer P with Dealer P (Bilateral (CSA-style))', owner: 'treasury' }] },
    },
    {
      id: 'register-call', action: 'register_instrument', as: 'call',
      draft: { productId: 'spread_option', name: SCALL, symbol: 'CRACK-SC20-APR26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1,
        terms: { right: 'C', strike: 20, expiration: '2026-04-28', optionType: 'spread', underlyingDescription: CRACK, exercise: 'european', settlement: 'cash', counterparty: 'Dealer P', collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } } },
      expect: {},
    },
    {
      id: 'register-put', action: 'register_instrument', as: 'put',
      draft: { productId: 'spread_option', name: SPUT, symbol: 'CRACK-SP25-APR26', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 1,
        terms: { right: 'P', strike: 25, expiration: '2026-04-28', optionType: 'spread', underlyingDescription: CRACK, exercise: 'european', settlement: 'cash', counterparty: 'Dealer P', collateralBasis: { type: 'agreement', agreementId: '$agreement:csa' } } },
      expect: {},
    },
    otcTicket({
      id: 'buy-spread-call', covers: 'open', instrument: 'call', side: 'buy', qty: 100_000, premium: 1.40, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 100_000, estimate: 1.4, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -140_000, fees: 500, notional: 2_000_000 }], // 100,000 x 1.40; 100,000 x 0.005; 100,000 x 20 (at the strike)
          cash: { USD: { purchases: 140_000, fees: 500, margin: 0, required: 140_500, available: 800_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 100_000, avgPrice: 1.4 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 100,000 CRACK-SC20-APR26 @ 1.40 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 800_000, unsettled: -140_500, availableToTrade: 659_500, availableToWithdraw: 659_500 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 100_000, avgCost: 1.4, cost: 140_000, price: null, value: null, unrealized: null, provisional: true, notional: null, margin: 0 }],
        holdings: { call: { long: 100_000, short: 0, net: 100_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -140_500, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-28', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', qty: 100_000, basis: 'agreement', agreement: 'CSA Dealer P', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -500, unrealized: 0, total: -500 } },
        nav: { account: 799_500, book: 1_999_500 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 800_000, payable: 140_500, positions: 140_000, assets: 940_000, liabilities: 140_500, netAssets: 799_500 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 5% x 100,000 x 25 = 125,000.
      id: 'write-spread-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 100_000, premium: 2.30, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 100_000, estimate: 2.3, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 230_000, fees: 500, notional: 2_500_000 }],
          cash: { USD: { proceeds: 230_000, fees: 500, margin: 125_000, required: 125_500, available: 659_500, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 100_000, avgPrice: 2.3 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 100,000 CRACK-SP25-APR26 @ 2.30 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${SPUT} under "CSA Dealer P" (Dealer P): 125,000.00 USD (independent amount, 5.00% of 2,500,000.00 USD notional)`, cash: { USD: -125_000 } },
        ],
        cash: { account: { USD: { settled: 675_000, unsettled: 89_000, margin: 125_000, availableToTrade: 764_000, availableToWithdraw: 534_500 } } }, // -140,500 + 229,500; 675,000 - 140,500
        positions: [
          { instrument: 'call', lot: 'calls', qty: 100_000 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -100_000, avgCost: 2.3, cost: -230_000, price: null, value: null, unrealized: null, provisional: true, notional: null, margin: 125_000 },
        ],
        holdings: { put: { long: 0, short: 100_000, net: -100_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -140_500, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 229_500, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-04-28', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-04-28', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -100_000, basis: 'agreement', agreement: 'CSA Dealer P', iaRequired: 125_000, iaPosted: 125_000, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -1_000, total: -1_000 } },
        nav: { account: 799_000, book: 1_999_000 }, // 675,000 + 125,000 + 229,500 - 140,500 + 140,000 - 230,000
        balance: { account: { cash: 675_000, margin: 125_000, receivable: 229_500, payable: 140_500, positions: -90_000, assets: 939_500, liabilities: 140_500, netAssets: 799_000 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 2.10, note: 'Dealer P mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 2.1, value: 210_000, unrealized: 70_000, provisional: false }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 2.1, markValue: 210_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: 70_000, total: 69_000 } },
        nav: { account: 869_000, book: 2_069_000 },
        balance: { account: { positions: -20_000, assets: 1_009_500, netAssets: 869_000 } }, // 210,000 - 230,000 (put at cost)
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 1.80, note: 'Dealer P mark per barrel, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 1.8, value: -180_000, unrealized: 50_000, provisional: false }],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 1.8, markValue: -180_000 }],
        pnl: { account: { unrealized: 120_000, total: 119_000 } },
        nav: { account: 919_000, book: 2_119_000 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 30_000, assets: 1_059_500, netAssets: 919_000 } },
      },
    },
    {
      // One netting set: 210,000 - 180,000 = +30,000, inside the 100,000 threshold: nothing moves.
      id: 'netting-set-inside-threshold', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: { events: [], otc: [{ instrument: 'call', vmExposure: 30_000, vmStatus: 'ok' }, { instrument: 'put', vmExposure: 30_000, vmStatus: 'ok' }] },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 229,500.00 USD into settled cash', cash: { USD: 229_500 } },
          { type: 'settlement.pay', summary: 'paid 140,500.00 USD from settled cash', cash: { USD: -140_500 } },
        ],
        cash: { account: { USD: { settled: 764_000, unsettled: 0, availableToTrade: 764_000, availableToWithdraw: 764_000 } } },
        pending: [],
        balance: { account: { cash: 764_000, receivable: null, payable: null, assets: 919_000, liabilities: 0 } }, // 764,000 + 125,000 + 30,000
      },
    },
    {
      id: 'expiry-awaits-spread-value', covers: 'expiry', action: 'clock', to: eod('2026-04-28'),
      expect: {
        events: [],
        lifecycle: [
          { type: 'option.expiry', instrument: 'call', dueDate: '2026-04-28', status: 'blocked', reason: /^Enter the spread value at expiry \(RBOB gasoline \/ WTI crude crack spread/ },
          { type: 'option.expiry', instrument: 'put', dueDate: '2026-04-28', status: 'blocked', reason: /^Enter the spread value at expiry/ },
        ],
      },
    },
    {
      // 23.10 agreed with Dealer P. Call: 23.10 - 20.00 = 3.10 a barrel: 310,000, T+1; realized 310,000 - 140,000.
      id: 'call-spread-value', covers: ['settlement value', 'expiry', 'cash settlement'], action: 'settlement_value', lot: 'calls', value: 23.10,
      expect: {
        events: [{ type: 'option.cash_settled', summary: 'Exercised (cash settlement): 100,000 CRACK-SC20-APR26 at 3.10 USD per unit (spread value 23.10, entered by hand)', owner: 'account', date: '2026-04-28' }],
        cash: { account: { USD: { unsettled: 310_000, availableToTrade: 1_074_000, availableToWithdraw: 764_000 } } },
        positions: [{ instrument: 'put', lot: 'puts', qty: -100_000 }],
        holdings: { call: null },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-04-29', amount: 310_000, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'put', dueDate: '2026-04-28', status: 'blocked' }],
        otc: [{ instrument: 'put', lot: 'puts' }],
        pnl: { account: { realized: 170_000, unrealized: 50_000, total: 219_000 } },
        nav: { account: 1_019_000, book: 2_219_000 }, // 764,000 + 125,000 + 310,000 - 180,000
        balance: { account: { receivable: 310_000, positions: -180_000, assets: 1_019_000, netAssets: 1_019_000 } },
      },
    },
    {
      // Put: 25.00 - 23.10 = 1.90 a barrel: 190,000 paid by the Account, T+1; realized 230,000 - 190,000. The 125,000 comes back.
      id: 'put-spread-value', covers: ['settlement value', 'expiry', 'cash settlement', 'collateral'], action: 'settlement_value', lot: 'puts', value: 23.10,
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Assigned (cash settlement): 100,000 CRACK-SP25-APR26 at 1.90 USD per unit (spread value 23.10, entered by hand)', owner: 'account', date: '2026-04-28' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${SPUT} under "CSA Dealer P" (Dealer P): 125,000.00 USD (independent amount, the position ended)`, cash: { USD: 125_000 } },
        ],
        cash: { account: { USD: { settled: 889_000, margin: 0, unsettled: 120_000, availableToTrade: 1_009_000, availableToWithdraw: 699_000 } } }, // 310,000 - 190,000; 889,000 - 190,000
        positions: [], holdings: { put: null }, otc: [], lifecycle: [],
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-04-29', amount: 310_000, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-04-29', amount: -190_000, ccy: 'USD', into: 'cash' },
        ],
        pnl: { account: { realized: 210_000, unrealized: 0, total: 209_000 } },
        nav: { account: 1_009_000, book: 2_209_000 },
        balance: { account: { cash: 889_000, margin: null, payable: 190_000, positions: null, assets: 1_199_000, liabilities: 190_000, netAssets: 1_009_000 } },
      },
    },
    {
      id: 'settle-cash-settlements', covers: 'settlement', action: 'clock', to: at('2026-04-29'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 310,000.00 USD into settled cash', cash: { USD: 310_000 } },
          { type: 'settlement.pay', summary: 'paid 190,000.00 USD from settled cash', cash: { USD: -190_000 } },
        ],
        cash: { account: { USD: { settled: 1_009_000, unsettled: 0, availableToTrade: 1_009_000, availableToWithdraw: 1_009_000 } } },
        pending: [],
        balance: { account: { cash: 1_009_000, receivable: null, payable: null, assets: 1_009_000, liabilities: 0 } },
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
// quanto_option
// ---------------------------------------------------------------------------------------------
// Two quanto options on Sakuragawa Electric (6599, Tokyo Stock Exchange, priced in JPY), paying US dollars at a rate
// fixed in the contract, 0.0068 USD per JPY (the market rate stays at 150 JPY per USD, 0.006667: it is not used),
// dealt with Dealer Q. Strike and fixing in JPY; premium in USD per share; quantity in shares. Expiry Friday 12 June
// 2026 against the Tokyo close, cash, paid T+1 on the US calendar.
//   - a quanto call struck at 3,000 JPY, bought on 10,000 shares; position-level terms: variation margin over 5,000.
//   - a quanto put struck at 2,800 JPY, written on 10,000 shares; position-level terms: independent amount 10% of the
//     strike notional in USD, 10,000 x 2,800 x 0.0068 = 190,400, so 19,040.
// The close is 3,250 JPY: the call pays (3,250 - 3,000) x 0.0068 = 1.70 USD a share, 17,000; the put lapses.
const SKRG = 'Sakuragawa Electric Co., Ltd.';
const QCALL = '6599 quanto call 3,000 JPY, paid in USD at 0.0068, 12 Jun 2026 (Dealer Q)';
const QPUT = '6599 quanto put 2,800 JPY, paid in USD at 0.0068, 12 Jun 2026 (Dealer Q)';
const quantoOption = {
  productId: 'quanto_option',
  title: 'Quanto options on a Tokyo-listed stock paid in USD at a fixed 0.0068: call bought (pays), put written (lapses)',
  matrix: {
    ...OTC_TICKET,
    requiredFields: [...OTC_TICKET.requiredFields, 'Payoff: Quanto', 'Fixed conversion rate (trading currency per unit of the underlying\'s currency)', 'Strike in the underlying\'s currency'],
    automaticInputs: ['the stock price in JPY (quote fixture standing in for Shaffer MarketData) for the notional, converted at the fixed rate', 'the Tokyo close for the expiration date (close fixture)', 'the payoff: (close - strike) in JPY x the fixed rate, in USD', 'premium settlement date, T+2 on the US calendar', 'commission per share from the Book fee schedule', 'variation margin and independent amount from the position-level terms'],
    manualInputs: ['premium in USD per share agreed with the dealer (stated fill price)', 'marks in USD per share entered by hand (Manual entry)'],
    settlement: 'Premium and commission T+2 on the US calendar; the cash settlement in USD T+1 after expiry',
    lifecycle: 'Expiry item settled against the Tokyo close for 12 June: the call pays its JPY intrinsic value converted at the fixed rate; the put lapses; nothing scheduled afterwards',
    accounting: 'Premium in USD per share x shares; payoff in USD at the contract\'s fixed rate, never at the market rate; premium realized at expiry; commission expensed; marks by hand drive unrealized P&L',
    collateral: 'Call (bought): position-level terms, variation margin over 5,000, received from the dealer and returned at settlement. Put (written): independent amount 10% of the USD strike notional, 19,040, returned at expiry',
  },
  start: at('2026-03-02'),
  settlementCheck: { lag: 2, holidays: [] },
  book: {
    name: 'Matrix quanto option', reportingCcy: 'USD',
    capital: [{ ccy: 'USD', amount: 1_000_000 }],
    account: { name: 'Japan', funding: [{ ccy: 'USD', amount: 300_000 }] },
    settings: { fees: { otcoption: { perUnit: 0.01, minimum: 0, bps: 0 }, equity: NO_FEE }, fill: FILL, settlement: { otcoption: 2, equity: 2 } },
  },
  fx: { 'USD/JPY': 150 },
  instruments: {
    stock: { productId: 'common_stock', name: SKRG, symbol: '6599', marketView: 'FOREIGN_CASH', venue: 'Tokyo Stock Exchange', venueType: 'exchange', venueCountry: 'JP', issuer: SKRG, domicile: 'JP', underlyingGeo: 'JP', tradingCcy: 'JPY', terms: {} },
    call: {
      productId: 'quanto_option', name: QCALL, symbol: 'SKRG-QC3000-JUN26', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'C', strike: 3_000, expiration: '2026-06-12', optionType: 'quanto', quantoRate: 0.0068, exercise: 'european', settlement: 'cash', counterparty: 'Dealer Q',
        collateralBasis: { type: 'position', independentAmount: { type: 'none' }, variationMargin: true, threshold: 5_000, minimumTransfer: 1_000 } },
    },
    put: {
      productId: 'quanto_option', name: QPUT, symbol: 'SKRG-QP2800-JUN26', marketView: 'FOREIGN_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', underlying: 'stock', multiplier: 1,
      terms: { right: 'P', strike: 2_800, expiration: '2026-06-12', optionType: 'quanto', quantoRate: 0.0068, exercise: 'european', settlement: 'cash', counterparty: 'Dealer Q',
        collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.10 }, variationMargin: false, threshold: 0, minimumTransfer: 0 } },
    },
  },
  quotes: { stock: { bid: 2_999, ask: 3_001, last: 3_000, bidSize: 100_000, askSize: 100_000 } },
  expectAtStart: usdStart(300_000, 700_000),
  steps: [
    otcTicket({
      id: 'buy-quanto-call', covers: 'open', instrument: 'call', side: 'buy', qty: 10_000, premium: 1.50, as: 'calls',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'buy', instrument: 'call', qty: 10_000, estimate: 1.5, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: -15_000, fees: 100, notional: 204_000 }], // 10,000 x 1.50; 10,000 x 0.01; 10,000 x 3,000 JPY x 0.0068
          cash: { USD: { purchases: 15_000, fees: 100, margin: 0, required: 15_100, available: 300_000, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'buy', status: 'filled', filledQty: 10_000, avgPrice: 1.5 }] },
        events: [{ type: 'strategy.submitted' }, { type: 'trade.fill', summary: 'Bought 10,000 SKRG-QC3000-JUN26 @ 1.50 USD', owner: 'account', date: '2026-03-02' }],
        cash: { account: { USD: { settled: 300_000, unsettled: -15_100, availableToTrade: 284_900, availableToWithdraw: 284_900 } } },
        positions: [{ instrument: 'call', lot: 'calls', owner: 'account', direction: 'long', qty: 10_000, avgCost: 1.5, cost: 15_000, price: null, value: null, unrealized: null, provisional: true, notional: 204_000, margin: 0 }],
        holdings: { call: { long: 10_000, short: 0, net: 10_000 } },
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -15_100, ccy: 'USD', into: 'cash' }],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-12', status: 'pending' }],
        otc: [{ instrument: 'call', lot: 'calls', qty: 10_000, basis: 'position', mark: null, iaRequired: 0, iaPosted: 0, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { realized: 0, commissions: -100, unrealized: 0, total: -100 } },
        nav: { account: 299_900, book: 999_900 },
        provisional: { account: true, book: true },
        balance: { account: { cash: 300_000, payable: 15_100, positions: 15_000, assets: 315_000, liabilities: 15_100, netAssets: 299_900 } },
      },
    }),
    { id: 'half-an-hour-later', action: 'clock', to: at('2026-03-02', '15:30'), expect: {} },
    otcTicket({
      // Written: independent amount 10% x 10,000 x 2,800 JPY x 0.0068 = 19,040 USD.
      id: 'write-quanto-put', covers: ['write', 'collateral'], instrument: 'put', side: 'sell', qty: 10_000, premium: 0.80, as: 'puts',
      expect: {
        preview: {
          blocking: 0, errors: [],
          legs: [{ kind: 'trade', action: 'sell', instrument: 'put', qty: 10_000, estimate: 0.8, model: 'stated-price', settleDate: '2026-03-04', calendar: 'US', cash: 8_000, fees: 100, notional: 204_000 }],
          cash: { USD: { proceeds: 8_000, fees: 100, margin: 19_040, required: 19_140, available: 284_900, shortfall: 0 } },
        },
        result: { status: 'open', orders: [{ kind: 'trade', action: 'sell', status: 'filled', filledQty: 10_000, avgPrice: 0.8 }] },
        events: [
          { type: 'strategy.submitted' },
          { type: 'trade.fill', summary: 'Sold 10,000 SKRG-QP2800-JUN26 @ 0.80 USD', owner: 'account' },
          { type: 'otcoption.collateral', summary: `Collateral posted on ${QPUT} under its position-level terms: 19,040.00 USD (independent amount, 10.00% of 190,400.00 USD notional)`, cash: { USD: -19_040 } },
        ],
        cash: { account: { USD: { settled: 280_960, unsettled: -7_200, margin: 19_040, availableToTrade: 273_760, availableToWithdraw: 265_860 } } }, // -15,100 + 7,900; 280,960 - 15,100
        positions: [
          { instrument: 'call', lot: 'calls', qty: 10_000 },
          { instrument: 'put', lot: 'puts', owner: 'account', direction: 'short', qty: -10_000, avgCost: 0.8, cost: -8_000, price: null, value: null, unrealized: null, provisional: true, notional: 204_000, margin: 19_040 },
        ],
        holdings: { put: { long: 0, short: 10_000, net: -10_000 } },
        pending: [
          { instrument: 'call', owner: 'account', dueDate: '2026-03-04', amount: -15_100, ccy: 'USD', into: 'cash' },
          { instrument: 'put', owner: 'account', dueDate: '2026-03-04', amount: 7_900, ccy: 'USD', into: 'cash' },
        ],
        lifecycle: [{ type: 'option.expiry', instrument: 'call', dueDate: '2026-06-12', status: 'pending' }, { type: 'option.expiry', instrument: 'put', dueDate: '2026-06-12', status: 'pending' }],
        otc: [{ instrument: 'call' }, { instrument: 'put', lot: 'puts', qty: -10_000, basis: 'position', iaRequired: 19_040, iaPosted: 19_040, vmPosted: 0, vmHeld: 0 }],
        pnl: { account: { commissions: -200, total: -200 } },
        nav: { account: 299_800, book: 999_800 }, // 280,960 + 19,040 + 7,900 - 15,100 + 15,000 - 8,000
        balance: { account: { cash: 280_960, margin: 19_040, receivable: 7_900, payable: 15_100, positions: 7_000, assets: 314_900, liabilities: 15_100, netAssets: 299_800 } },
      },
    }),
    {
      id: 'mark-call', covers: 'manual mark', action: 'manual_price', instrument: 'call', value: 1.80, note: 'Dealer Q mark in USD per share, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls', price: 1.8, value: 18_000, unrealized: 3_000, provisional: false }, { instrument: 'put', lot: 'puts' }],
        otc: [{ instrument: 'call', mark: 1.8, markValue: 18_000 }, { instrument: 'put' }],
        pnl: { account: { unrealized: 3_000, total: 2_800 } },
        nav: { account: 302_800, book: 1_002_800 },
        balance: { account: { positions: 10_000, assets: 317_900, netAssets: 302_800 } }, // 18,000 - 8,000
      },
    },
    {
      id: 'mark-put', covers: 'manual mark', action: 'manual_price', instrument: 'put', value: 0.50, note: 'Dealer Q mark in USD per share, by hand',
      expect: {
        positions: [{ instrument: 'call', lot: 'calls' }, { instrument: 'put', lot: 'puts', price: 0.5, value: -5_000, unrealized: 3_000, provisional: false }],
        otc: [{ instrument: 'call' }, { instrument: 'put', mark: 0.5, markValue: -5_000 }],
        pnl: { account: { unrealized: 6_000, total: 5_800 } },
        nav: { account: 305_800, book: 1_005_800 },
        provisional: { account: false, book: false },
        balance: { account: { positions: 13_000, assets: 320_900, netAssets: 305_800 } },
      },
    },
    {
      // Call marked at 18,000: 13,000 beyond its 5,000 threshold, posted by Dealer Q.
      id: 'variation-margin-received', covers: 'variation margin', action: 'clock', to: eod('2026-03-02'),
      expect: {
        events: [{ type: 'collateral.variation', summary: 'Variation margin under position-level terms: 13,000.00 USD received. Netting set of 1 position marked at 18,000.00 USD; threshold 5,000.00 USD.', owner: 'account' }],
        cash: { account: { USD: { restricted: 13_000 } } },
        otc: [{ instrument: 'call', vmHeld: 13_000, vmExposure: 18_000, vmStatus: 'ok' }, { instrument: 'put' }],
        balance: { account: { restricted: 13_000, collateralReceived: 13_000, assets: 333_900, liabilities: 28_100, netAssets: 305_800 } },
      },
    },
    {
      id: 'settle-premiums', covers: 'settlement', action: 'clock', to: at('2026-03-04'),
      expect: {
        events: [
          { type: 'settlement.receive', summary: 'received 7,900.00 USD into settled cash', cash: { USD: 7_900 } },
          { type: 'settlement.pay', summary: 'paid 15,100.00 USD from settled cash', cash: { USD: -15_100 } },
        ],
        cash: { account: { USD: { settled: 273_760, unsettled: 0, availableToTrade: 273_760, availableToWithdraw: 273_760 } } },
        pending: [],
        balance: { account: { cash: 273_760, receivable: null, payable: null, assets: 318_800, liabilities: 13_000 } }, // 273,760 + 13,000 + 19,040 + 13,000
      },
    },
    { id: 'settlement-price-known-later', action: 'close_price', instrument: 'stock', date: '2026-06-12', value: 3_250, expect: {} },
    {
      // Tokyo close 3,250 JPY. Call: (3,250 - 3,000) x 0.0068 = 1.70 USD a share: 17,000, T+1 (Monday 15 June); realized
      // 17,000 - 15,000; the 13,000 Dealer Q posted goes back. At the market rate it would have been 250 / 150 x 10,000 =
      // 16,666.67: the fixed rate is what counts. Put: lapses, 8,000 realized; the 19,040 comes back.
      id: 'expiry', covers: ['expiry', 'cash settlement', 'fixed conversion rate', 'lapse', 'collateral'], action: 'clock', to: eod('2026-06-12'),
      expect: {
        events: [
          { type: 'option.cash_settled', summary: 'Exercised (cash settlement): 10,000 SKRG-QC3000-JUN26 at 1.70 USD per unit (fixing 3,250.00, converted at the fixed rate 0.0068)', owner: 'account', date: '2026-06-12' },
          { type: 'collateral.variation', summary: 'Variation margin under position-level terms: 13,000.00 USD returned to the counterparty. The last position of the netting set ended.', owner: 'account' },
          { type: 'option.expired', summary: 'Expired worthless: 10,000 SKRG-QP2800-JUN26 (fixing 3,250.00, converted at the fixed rate 0.0068)', owner: 'account', date: '2026-06-12' },
          { type: 'otcoption.collateral', summary: `Collateral returned on ${QPUT} under its position-level terms: 19,040.00 USD (independent amount, the position ended)`, cash: { USD: 19_040 } },
        ],
        cash: { account: { USD: { settled: 292_800, restricted: 0, margin: 0, unsettled: 17_000, availableToTrade: 309_800, availableToWithdraw: 292_800 } } }, // 273,760 + 19,040
        positions: [], holdings: { call: null, put: null }, otc: [], lifecycle: [],
        pending: [{ instrument: 'call', owner: 'account', dueDate: '2026-06-15', amount: 17_000, ccy: 'USD', into: 'cash' }],
        pnl: { account: { realized: 10_000, unrealized: 0, total: 9_800 } }, // 2,000 + 8,000; - 200
        nav: { account: 309_800, book: 1_009_800 },
        balance: { account: { cash: 292_800, receivable: 17_000, restricted: null, collateralReceived: null, margin: null, positions: null, assets: 309_800, liabilities: 0, netAssets: 309_800 } },
      },
    },
    {
      id: 'settle-cash-settlement', covers: 'settlement', action: 'clock', to: at('2026-06-15'),
      expect: {
        events: [{ type: 'settlement.receive', summary: 'received 17,000.00 USD into settled cash', cash: { USD: 17_000 } }],
        cash: { account: { USD: { settled: 309_800, unsettled: 0, availableToTrade: 309_800, availableToWithdraw: 309_800 } } },
        pending: [],
        balance: { account: { cash: 309_800, receivable: null } },
      },
    },
  ],
};

export default [barrierOption, asianOption, lookbackOption, basketOption, spreadOption, quantoOption];
