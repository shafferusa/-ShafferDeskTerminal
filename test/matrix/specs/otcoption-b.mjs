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

export default [barrierOption, asianOption];
