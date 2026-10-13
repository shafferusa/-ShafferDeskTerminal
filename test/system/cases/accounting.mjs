// Accounting verification: one Book ("Verification Book", reporting USD) with Treasury and two Accounts, taken
// step by step through every situation in the owner's section 7 and back to a clean end state. After every step the
// Terminal's figures are compared with literals worked out by hand from the inputs below, never with anything the
// Terminal printed. docs/ACCOUNTING-VERIFICATION.md is the worked ledger: every literal here is derived there, in
// prose and tables, with the arithmetic and the Terminal's figure beside it.
//
// The same scenario runs at three levels:
//   engine   test/core/accounting-verification.test.js (part of npm test): in-process, the real route handlers,
//            engine and ledger on a disposable database file, frozen clock
//   API      SA:accounting:verification-book, a disposable server process, real HTTP
//   browser  SB:accounting:verification-book, the same API steps, then at the checkpoints the Accounting screens
//            (balance sheet worksheet, P&L statement, positions, Treasury oversight) are read and compared with the
//            same hand-worked literals, to the decimals shown
//
// Inputs (fixtures stand in for Shaffer MarketData and are labelled "Test fixture" wherever they appear):
//   EUR/USD 1.10, USD/JPY 150 until Friday 6 March 10:05 New York, then 1.12 and 160.
//   VRFY   Verity Instruments, NYSE, USD          99.90 / 100.00, last 99.95; from Mon 9 March 101.90 / 102.00, last 101.95
//   EURF   Eurofab SE, XETRA, EUR                 49.90 / 50.00, last 49.95;  from Mon 9 March 50.40 / 50.50, last 50.45
//   PUT    VRFY 20 Mar 2026 95 put, 100 shares     1.20 / 1.30, last 1.25;     from Mon 9 March 0.80 / 0.90, last 0.85
//   BOND   Verity Capital 6.00% 6-Mar-2031, 30/360, semi-annual (6 Mar / 6 Sep), % of par, multiplier 0.01
//                                                 98.40 / 98.50, last 98.45;  from Mon 9 March 98.90 / 99.00, last 98.95
//   FUT    Verity 500 index future Jun 2026, 50 USD a point, initial margin 10,000 a contract
//                                                 4,999.75 / 5,000.00; settlement 5,010 on 2-5 March, 5,020 on 6 March;
//                                                 from Mon 9 March 5,024.75 / 5,025.00
//   IRS    pay 4.00% fixed / receive VER-3M on 1,000,000, under "CSA Verification Bank" (independent amount 2% of
//          notional, variation margin, threshold 0, minimum transfer 0, netting per position); mark per 100 notional
//          0.00 (current), +1.50 as of 27 Feb (stale) from Monday's end of day, +1.00 (current) from Friday 10:05
//          (in North's favour: the counterparty posts variation margin, held as restricted cash and owed back)
//   Borrow of VRFY: available, fee 1.00% a year on market value (ACT/360).
//   Book: equity commission 0.01 a share (minimum 1.00), options 0.65 a contract, futures 2.25 a contract, bonds,
//   FX and swaps none; T+1 US equities, bonds and options, T+2 foreign equities and spot FX; short collateral 102%
//   of market value, margin hold 30%; written puts cash-secured; no dividend withholding.

import { evening } from '../lib/world.mjs';

export const area = 'accounting';

// ---- dates (2 to 11 March 2026: no US, SIFMA, TARGET or Tokyo holiday; US daylight time from Sunday 8 March) ----
export const AT = {
  mon: '2026-03-02T15:00:00.000Z', monEod: evening('2026-03-02'), tue: '2026-03-03T15:00:00.000Z',
  fri: '2026-03-06T15:00:00.000Z', friFx: '2026-03-06T15:05:00.000Z', friGap: '2026-03-06T15:10:00.000Z', friBack: '2026-03-06T15:15:00.000Z', friEod: evening('2026-03-06'),
  mon2: '2026-03-09T14:00:00.000Z', wed2: '2026-03-11T14:00:00.000Z',
};

export const SETTINGS = {
  fees: {
    equity: { perUnit: 0.01, minimum: 1, bps: 0 }, option: { perUnit: 0.65, minimum: 0, bps: 0 }, future: { perUnit: 2.25, minimum: 0, bps: 0 },
    fx: { perUnit: 0, minimum: 0, bps: 0 }, bond: { perUnit: 0, minimum: 0, bps: 0 }, swap: { perUnit: 0, minimum: 0, bps: 0 },
  },
  fill: { halfSpreadBps: { equity: 2, bond: 3 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false },
  settlement: { equity: 1, bond: 1, option: 1, foreignCash: 2, future: 0 },
  short: { collateralPct: 1.02, marginPct: 0.3 },
  margin: { nakedCallPct: 0.2 },
  dividends: { withholdingPct: 0 },
};

const Q = {
  vrfy: { bid: 99.90, ask: 100.00, last: 99.95, bidSize: 100_000, askSize: 100_000 },
  vrfy2: { bid: 101.90, ask: 102.00, last: 101.95, bidSize: 100_000, askSize: 100_000 },
  eurf: { bid: 49.90, ask: 50.00, last: 49.95, bidSize: 100_000, askSize: 100_000 },
  eurf2: { bid: 50.40, ask: 50.50, last: 50.45, bidSize: 100_000, askSize: 100_000 },
  put: { bid: 1.20, ask: 1.30, last: 1.25, bidSize: 500, askSize: 500 },
  put2: { bid: 0.80, ask: 0.90, last: 0.85, bidSize: 500, askSize: 500 },
  bond: { bid: 98.40, ask: 98.50, last: 98.45, bidSize: 10_000_000, askSize: 10_000_000 },
  bond2: { bid: 98.90, ask: 99.00, last: 98.95, bidSize: 10_000_000, askSize: 10_000_000 },
  fut: { bid: 4999.75, ask: 5000.00, last: 5000.00, bidSize: 200, askSize: 200 },
  fut2: { bid: 5009.75, ask: 5010.00, last: 5010.00, bidSize: 200, askSize: 200 },
  fut3: { bid: 5019.75, ask: 5020.00, last: 5020.00, bidSize: 200, askSize: 200 },
  fut4: { bid: 5024.75, ask: 5025.00, last: 5025.00, bidSize: 200, askSize: 200 },
  jpy150: { bid: 150, ask: 150, last: 150, bidSize: 1e9, askSize: 1e9 },
  jpy160: { bid: 160, ask: 160, last: 160, bidSize: 1e9, askSize: 1e9 },
};

const DRAFTS = {
  vrfy: { productId: 'common_stock', name: 'Verity Instruments Inc.', symbol: 'VRFY', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: 'Verity Instruments Inc.', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {} },
  eurf: { productId: 'common_stock', name: 'Eurofab SE', symbol: 'EURF', marketView: 'FOREIGN_CASH', venue: 'XETRA', venueType: 'exchange', venueCountry: 'DE', issuer: 'Eurofab SE', domicile: 'DE', underlyingGeo: 'DE', tradingCcy: 'EUR', terms: {} },
  usdjpy: { productId: 'fx_spot', name: 'USD/JPY spot', symbol: 'USD/JPY', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'JPY', terms: { base: 'USD', quote: 'JPY', settleDays: 2 } },
  put: (underlyingId) => ({ productId: 'equity_option', name: 'VRFY 20 March 2026 95 put', symbol: 'VRFY260320P95', marketView: 'US_DERIV', venue: 'Cboe Options Exchange', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', underlyingId, multiplier: 100,
    terms: { right: 'P', strike: 95, expiration: '2026-03-20', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } }),
  bond: { productId: 'corporate_bond', name: 'Verity Capital 6.00% Notes 6-Mar-2031', symbol: 'VRFC-6-MAR31', marketView: 'US_CASH', venueType: 'otc', issuer: 'Verity Capital', domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 0.01,
    terms: { couponType: 'fixed', couponRate: 0.06, frequency: 2, maturity: '2031-03-06', issueDate: '2024-03-06', dayCount: '30/360', redemption: 100, minDenomination: 1_000 } },
  fut: { productId: 'equity_index_future', name: 'Verity 500 Index future, June 2026', symbol: 'V5M6', marketView: 'US_DERIV', venue: 'CME', venueType: 'exchange', venueCountry: 'US', underlyingGeo: 'US', tradingCcy: 'USD', multiplier: 50,
    terms: { root: 'V5', expiration: '2026-06-18', tickSize: 0.25, initialMargin: 10_000, settlement: 'cash', priceUnits: 'index points' } },
  irs: (agreementId) => ({ productId: 'interest_rate_swap', name: 'IRS pay 4.00% / receive VER-3M 1Y', symbol: 'IRS-VER-1Y', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', jurisdiction: 'US',
    terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Verification Bank', collateralBasis: { type: 'agreement', agreementId }, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'VER-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } }),
};
const loanContract = (ccy, name, terms) => ({ productId: 'unsecured_loan', name, marketView: ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH', venueType: 'otc', tradingCcy: ccy, tags: [], externalIds: {}, terms });
const repoContract = (collateralInstrumentId) => ({ productId: 'repo', name: 'Verity notes repo', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', tags: [], externalIds: {},
  terms: { collateralInstrumentId, collateralQty: 100_000, haircut: 0.02, buffer: 1_000, rateType: 'fixed', rate: 0.045, dayCount: 'ACT/360', term: 'term', endDate: '2026-03-10', style: 'classic', collateralType: 'gc', triparty: false, counterparty: 'Kittering Securities' } });

// =====================================================================================================================
// The hand-worked expectations. Every figure is derived in docs/ACCOUNTING-VERIFICATION.md (the section of the same
// name); the arithmetic is repeated in the comments. Amounts are in the currency named; rc = reporting currency (USD).
// Units: T = Treasury, N = North, S = South. Balance-sheet lines are the Terminal's line keys; liabilities positive.
// Capital, internal funding and results are stated in USD at the rates in force when each flow was booked.
// =====================================================================================================================

/** Book line totals by currency are the sum of the three owners' lines, so they are not restated by hand. */
export const EXPECT = {
  // C0: capital in, Treasury funds both Accounts, North sends 50,000 to South. Nothing else.
  C0: {
    units: {
      // T: 2,000,000 - 900,000 - 500,000 = 600,000 USD; 100,000 - 60,000 = 40,000 EUR (44,000 at 1.10).
      T: { lines: { cash: { USD: 600_000, EUR: 40_000 } }, assets: 644_000, liabilities: 0, netAssets: 644_000, capital: 2_110_000, internal: -1_466_000, results: 0 },
      // N: 900,000 - 50,000.
      N: { lines: { cash: { USD: 850_000 } }, assets: 850_000, liabilities: 0, netAssets: 850_000, capital: 0, internal: 850_000, results: 0 },
      // S: 500,000 + 50,000 USD, 60,000 EUR (66,000).
      S: { lines: { cash: { USD: 550_000, EUR: 60_000 } }, assets: 616_000, liabilities: 0, netAssets: 616_000, capital: 0, internal: 616_000, results: 0 },
    },
    // capital 2,000,000 + 100,000 x 1.10 = 2,110,000; funding advanced 900,000 + 500,000 + 66,000 = 1,466,000.
    book: { assets: 2_110_000, liabilities: 0, netAssets: 2_110_000, capital: 2_110_000, results: 0, advanced: 1_466_000, received: 1_466_000 },
    pnl: { book: { realized: 0, dividends: 0, couponInterest: 0, borrowFunding: 0, lendingIncome: 0, commissions: 0, fees: 0, unrealized: 0, fx: 0, total: 0 },
      T: { total: 0 }, N: { total: 0 }, S: { total: 0 } },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: false, affected: [],
    borrowings: [],
  },

  // C1: Monday 10:00, every opening trade on trade date.
  C1: {
    units: {
      // T: JPY 30,000,000 borrowed (settled at once) and sold for 200,000 USD at 150, value Wed 4 March.
      //   assets 600,000 + 44,000 + 200,000 (JPY cash) + 200,000 (USD receivable) = 1,044,000
      //   liabilities 200,000 (JPY payable) + 200,000 (JPY loan) = 400,000
      T: { lines: { cash: { USD: 600_000, EUR: 40_000, JPY: 30_000_000 }, receivable: { USD: 200_000 }, payable: { JPY: 30_000_000 }, borrowed: { JPY: 30_000_000 } },
        assets: 1_044_000, liabilities: 400_000, netAssets: 644_000, capital: 2_110_000, internal: -1_466_000, results: 0 },
      // N: cash 850,000 + 300,000 loan - 250 loan fee - 20,000 futures margin - 4.50 futures commission - 20,000 swap
      //    independent amount = 1,109,745.50; margin 40,000; payable 100,010 (1,000 VRFY at 100.00 + 10.00) + 101,450
      //    (bond 98,500 + 2,950 accrued); accrued income 2,950; positions 99,950 + 98,450 + 0 + 0 = 198,400.
      N: { lines: { cash: { USD: 1_109_745.50 }, margin: { USD: 40_000 }, accruedIncome: { USD: 2_950 }, positions: { USD: 198_400 }, payable: { USD: 201_460 }, borrowed: { USD: 300_000 } },
        assets: 1_351_095.50, liabilities: 501_460, netAssets: 849_635.50, capital: 0, internal: 850_000, results: -364.50 },
      // S: receivable 49,945 (short) + 238.70 (puts); positions -49,975 - 250 USD and 49,950 EUR; payable 50,010 EUR.
      //    assets 550,000 + 66,000 + 50,183.70 + (-50,225 + 54,945) = 670,903.70; liabilities 55,011.
      S: { lines: { cash: { USD: 550_000, EUR: 60_000 }, receivable: { USD: 50_183.70 }, positions: { USD: -50_225, EUR: 49_950 }, payable: { EUR: 50_010 } },
        assets: 670_903.70, liabilities: 55_011, netAssets: 615_892.70, capital: 0, internal: 616_000, results: -107.30 },
    },
    book: { assets: 3_065_999.20, liabilities: 956_471, netAssets: 2_109_528.20, capital: 2_110_000, results: -471.80, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      // commissions 10 + 4.50 + 5 + 1.30 + 10 EUR (11.00) = 31.80; unrealized -50 -50 -25 -10 -55 = -190.
      book: { realized: 0, dividends: 0, couponInterest: 0, borrowFunding: 0, lendingIncome: 0, commissions: -31.80, fees: -250, unrealized: -190, fx: 0, total: -471.80 },
      T: { total: 0 }, N: { commissions: -14.50, fees: -250, unrealized: -100, total: -364.50 }, S: { commissions: -17.30, unrealized: -90, total: -107.30 },
    },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: false, affected: [],
    borrowings: [
      { owner: 'N', family: 'loan', ccy: 'USD', principal: 300_000, principalRc: 300_000, accrued: 0, interestToDate: 0, feesToDate: 250 },
      { owner: 'S', family: 'secloan', ccy: 'USD', principal: null, securitiesQty: 500, securitiesValue: 49_975, accrued: 0, interestToDate: 0, collateralCash: null },
      { owner: 'T', family: 'loan', ccy: 'JPY', principal: 30_000_000, principalRc: 200_000, accrued: 0, interestToDate: 0, feesToDate: 0 },
    ],
    holdings: { VRFY: { long: 1000, short: 500, net: 500, N: [1000, 0, 1000], S: [0, 500, -500], exposure: 49_975 } },
    cash: {
      // S: 550,000 + 50,183.70 owed - 49,945 that will arrive restricted - 33,992.50 reserved (0.30 x 500 x 99.95 = 14,992.50 margin
      //    hold; 2 x 100 x 95 = 19,000 put reserve) = 516,246.20 to trade; 550,000 - 33,992.50 = 516,007.50 to withdraw.
      S: { USD: { settled: 550_000, restricted: 0, margin: 0, receivable: 50_183.70, payable: 0, reserved: 33_992.50, availableToTrade: 516_246.20, availableToWithdraw: 516_007.50 } },
      N: { USD: { settled: 1_109_745.50, restricted: 0, margin: 40_000, receivable: 0, payable: 201_460, reserved: 0, availableToTrade: 908_285.50, availableToWithdraw: 908_285.50 } },
    },
  },

  // C2: Monday 17:30, end of day. Futures settle at 5,010 (+1,000 received); the swap is marked +1.50 on a stale mark
  // (value +15,000; the counterparty posts 15,000, held restricted and owed back; provisional); the short's collateral
  // is topped up to 102% before its proceeds arrive.
  C2: {
    units: {
      T: { lines: { cash: { USD: 600_000, EUR: 40_000, JPY: 30_000_000 }, receivable: { USD: 200_000 }, payable: { JPY: 30_000_000 }, borrowed: { JPY: 30_000_000 } },
        assets: 1_044_000, liabilities: 400_000, netAssets: 644_000, capital: 2_110_000, internal: -1_466_000, results: 0 },
      // N: cash 1,109,745.50 + 1,000 = 1,110,745.50; restricted 15,000 received, owed back 15,000; positions
      //    99,950 + 98,450 + 0 + 15,000 = 213,400. Assets 1,110,745.50 + 40,000 + 15,000 + 2,950 + 213,400 = 1,382,095.50.
      N: { lines: { cash: { USD: 1_110_745.50 }, restricted: { USD: 15_000 }, margin: { USD: 40_000 }, accruedIncome: { USD: 2_950 }, positions: { USD: 213_400 }, payable: { USD: 201_460 }, borrowed: { USD: 300_000 }, collateralReceived: { USD: 15_000 } },
        assets: 1_382_095.50, liabilities: 516_460, netAssets: 865_635.50, capital: 0, internal: 850_000, results: 15_635.50 },
      // S: 1.02 x 500 x 99.95 = 50,974.50 required, 49,945 pending: 1,029.50 moves from cash to restricted.
      S: { lines: { cash: { USD: 548_970.50, EUR: 60_000 }, restricted: { USD: 1_029.50 }, receivable: { USD: 50_183.70 }, positions: { USD: -50_225, EUR: 49_950 }, payable: { EUR: 50_010 } },
        assets: 670_903.70, liabilities: 55_011, netAssets: 615_892.70, capital: 0, internal: 616_000, results: -107.30 },
    },
    book: { assets: 3_096_999.20, liabilities: 971_471, netAssets: 2_125_528.20, capital: 2_110_000, results: 15_528.20, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      book: { realized: 1_000, dividends: 0, couponInterest: 0, borrowFunding: 0, lendingIncome: 0, commissions: -31.80, fees: -250, unrealized: 14_810, fx: 0, total: 15_528.20 },
      T: { total: 0 }, N: { realized: 1_000, unrealized: 14_900, total: 15_635.50 }, S: { total: -107.30 },
    },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: true, affected: [['stale-price', 'IRS-VER-1Y', 'North']],
    swap: { value: 15_000, independentHeld: 20_000, variationPosted: 0, variationReceived: 15_000, provisional: true },
    cash: {
      // S: 548,970.50 + 50,183.70 - 49,945 - 33,992.50 = 515,216.70; withdraw 548,970.50 - 33,992.50 = 514,978.
      S: { USD: { settled: 548_970.50, restricted: 1_029.50, margin: 0, receivable: 50_183.70, payable: 0, reserved: 33_992.50, availableToTrade: 515_216.70, availableToWithdraw: 514_978 } },
      N: { USD: { settled: 1_110_745.50, restricted: 15_000, margin: 40_000, payable: 201_460, availableToTrade: 909_285.50, availableToWithdraw: 909_285.50, collateralReceived: 15_000 } },
    },
  },

  // C3: Tuesday 10:00. Monday's T+1 trades settle; North repos the bond (98,372 = 101,400 less 2% less 1,000 buffer).
  C3: {
    units: {
      T: { lines: { cash: { USD: 600_000, EUR: 40_000, JPY: 30_000_000 }, receivable: { USD: 200_000 }, payable: { JPY: 30_000_000 }, borrowed: { JPY: 30_000_000 } },
        assets: 1_044_000, liabilities: 400_000, netAssets: 644_000, capital: 2_110_000, internal: -1_466_000, results: 0 },
      // N: 1,110,745.50 - 100,010 - 101,450 + 98,372 = 1,007,657.50; borrowed 300,000 + 98,372.
      N: { lines: { cash: { USD: 1_007_657.50 }, restricted: { USD: 15_000 }, margin: { USD: 40_000 }, accruedIncome: { USD: 2_950 }, positions: { USD: 213_400 }, borrowed: { USD: 398_372 }, collateralReceived: { USD: 15_000 } },
        assets: 1_279_007.50, liabilities: 413_372, netAssets: 865_635.50, capital: 0, internal: 850_000, results: 15_635.50 },
      // S: 49,945 lands in restricted cash (1,029.50 + 49,945 = 50,974.50); 238.70 of put premium in cash.
      S: { lines: { cash: { USD: 549_209.20, EUR: 60_000 }, restricted: { USD: 50_974.50 }, positions: { USD: -50_225, EUR: 49_950 }, payable: { EUR: 50_010 } },
        assets: 670_903.70, liabilities: 55_011, netAssets: 615_892.70, capital: 0, internal: 616_000, results: -107.30 },
    },
    book: { assets: 2_993_911.20, liabilities: 868_383, netAssets: 2_125_528.20, capital: 2_110_000, results: 15_528.20, advanced: 1_466_000, received: 1_466_000 },
    pnl: { book: { realized: 1_000, dividends: 0, couponInterest: 0, borrowFunding: 0, lendingIncome: 0, commissions: -31.80, fees: -250, unrealized: 14_810, fx: 0, total: 15_528.20 },
      T: { total: 0 }, N: { total: 15_635.50 }, S: { total: -107.30 } },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: true, affected: [['stale-price', 'IRS-VER-1Y', 'North']],
    repo: { worth: 101_400, clean: 98_450, accrued: 2_950, haircutAmount: 2_028, afterHaircut: 99_372, buffer: 1_000, supports: 98_372 },
    borrowings: [
      { owner: 'N', family: 'loan', ccy: 'USD', principal: 300_000, principalRc: 300_000, accrued: 0, interestToDate: 0, feesToDate: 250 },
      { owner: 'N', family: 'repo', ccy: 'USD', principal: 98_372, principalRc: 98_372, accrued: 0, interestToDate: 0, feesToDate: 0, collateral: 'VRFC-6-MAR31: 100,000 pledged, haircut 2.00%' },
      { owner: 'S', family: 'secloan', ccy: 'USD', principal: null, securitiesQty: 500, securitiesValue: 49_975, accrued: 0, interestToDate: 0, collateralCash: 50_974.50 },
      { owner: 'T', family: 'loan', ccy: 'JPY', principal: 30_000_000, principalRc: 200_000, accrued: 0, interestToDate: 0, feesToDate: 0 },
    ],
    cash: {
      // S: settled 549,209.20, reserved 33,992.50: 515,216.70 to trade and to withdraw. The 50,974.50 restricted is neither.
      S: { USD: { settled: 549_209.20, restricted: 50_974.50, margin: 0, receivable: 0, payable: 0, reserved: 33_992.50, availableToTrade: 515_216.70, availableToWithdraw: 515_216.70 } },
      N: { USD: { settled: 1_007_657.50, restricted: 15_000, margin: 40_000, payable: 0, receivable: 0, availableToTrade: 1_007_657.50, availableToWithdraw: 1_007_657.50, collateralReceived: 15_000 } },
    },
  },

  // C4: Friday 10:00, after the end-of-day runs of 3, 4 and 5 March, Wednesday's T+2 settlements, the dividend
  // (ex and pay Thursday 5 March, 0.50 a share) and the bond coupon of Friday 6 March.
  C4: {
    units: {
      // T: the conversion settled (30,000,000 JPY out, 200,000 USD in); 3 days of yen interest 3 x 1,200 = 3,600 JPY (24.00).
      T: { lines: { cash: { USD: 800_000, EUR: 40_000 }, borrowed: { JPY: 30_000_000 }, accruedExpense: { JPY: 3_600 } },
        assets: 844_000, liabilities: 200_024, netAssets: 643_976, capital: 2_110_000, internal: -1_466_000, results: -24 },
      // N: + 500 dividend + 3,000 coupon; loan interest 3 x 50 = 150; repo 98,372 x 0.045 x 2 / 360 = 24.593 -> 24.59.
      N: { lines: { cash: { USD: 1_011_157.50 }, restricted: { USD: 15_000 }, margin: { USD: 40_000 }, positions: { USD: 213_400 }, borrowed: { USD: 398_372 }, accruedExpense: { USD: 174.59 }, collateralReceived: { USD: 15_000 } },
        assets: 1_279_557.50, liabilities: 413_546.59, netAssets: 866_010.91, capital: 0, internal: 850_000, results: 16_010.91 },
      // S: - 250 dividend compensation; borrow fee 3 x 500 x 99.95 x 0.01 / 360 = 4.1646 -> 4.16; EURF settled (EUR cash 9,990).
      S: { lines: { cash: { USD: 548_959.20, EUR: 9_990 }, restricted: { USD: 50_974.50 }, positions: { USD: -50_225, EUR: 49_950 }, accruedExpense: { USD: 4.16 } },
        assets: 615_642.70, liabilities: 4.16, netAssets: 615_638.54, capital: 0, internal: 616_000, results: -361.46 },
    },
    book: { assets: 2_739_200.20, liabilities: 613_574.75, netAssets: 2_125_625.45, capital: 2_110_000, results: 15_625.45, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      // coupon income 3,000 - 2,950 bought = 50; borrowing and funding 174.59 + 4.16 + 250 + 24 = 452.75.
      book: { realized: 1_000, dividends: 500, couponInterest: 50, borrowFunding: -452.75, lendingIncome: 0, commissions: -31.80, fees: -250, unrealized: 14_810, fx: 0, total: 15_625.45 },
      T: { borrowFunding: -24, total: -24 }, N: { dividends: 500, couponInterest: 50, borrowFunding: -174.59, total: 16_010.91 }, S: { borrowFunding: -254.16, total: -361.46 },
    },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: true, affected: [['stale-price', 'IRS-VER-1Y', 'North']],
    borrowings: [
      { owner: 'N', family: 'loan', ccy: 'USD', principal: 300_000, principalRc: 300_000, accrued: 150, interestToDate: 150, feesToDate: 250 },
      { owner: 'N', family: 'repo', ccy: 'USD', principal: 98_372, principalRc: 98_372, accrued: 24.59, interestToDate: 24.59, feesToDate: 0 },
      { owner: 'S', family: 'secloan', ccy: 'USD', principal: null, securitiesQty: 500, securitiesValue: 49_975, accrued: 4.16, interestToDate: 4.16, collateralCash: 50_974.50 },
      { owner: 'T', family: 'loan', ccy: 'JPY', principal: 30_000_000, principalRc: 200_000, accrued: 3_600, interestToDate: 3_600, interestToDateRc: 24, feesToDate: 0 },
    ],
  },

  // C5: Friday 10:05. EUR/USD 1.12 and USD/JPY 160; the swap gets a current mark of +1.00 (value +10,000).
  C5: {
    units: {
      // T: 40,000 EUR = 44,800; JPY loan 30,000,000 / 160 = 187,500; accrued 3,600 / 160 = 22.50.
      T: { lines: { cash: { USD: 800_000, EUR: 40_000 }, borrowed: { JPY: 30_000_000 }, accruedExpense: { JPY: 3_600 } },
        assets: 844_800, liabilities: 187_522.50, netAssets: 657_277.50, capital: 2_110_000, internal: -1_466_000, results: 13_277.50 },
      N: { lines: { cash: { USD: 1_011_157.50 }, restricted: { USD: 15_000 }, margin: { USD: 40_000 }, positions: { USD: 208_400 }, borrowed: { USD: 398_372 }, accruedExpense: { USD: 174.59 }, collateralReceived: { USD: 15_000 } },
        assets: 1_274_557.50, liabilities: 413_546.59, netAssets: 861_010.91, capital: 0, internal: 850_000, results: 11_010.91 },
      // S: EUR 9,990 x 1.12 = 11,188.80; EURF 49,950 x 1.12 = 55,944.
      S: { lines: { cash: { USD: 548_959.20, EUR: 9_990 }, restricted: { USD: 50_974.50 }, positions: { USD: -50_225, EUR: 49_950 }, accruedExpense: { USD: 4.16 } },
        assets: 616_841.50, liabilities: 4.16, netAssets: 616_837.34, capital: 0, internal: 616_000, results: 837.34 },
    },
    book: { assets: 2_736_199, liabilities: 601_073.25, netAssets: 2_135_125.75, capital: 2_110_000, results: 25_125.75, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      // FX: EUR (40,000 + 59,990) x 0.02 = 1,999.80; JPY 30,000,000 x (1/150 - 1/160) = 12,500 and 3,600 accrued 24.00 -> 22.50 = 1.50.
      // Unrealized -50 -50 -25 -10 + 10,000 and -50 EUR at 1.12 = -56: 9,809.
      book: { realized: 1_000, dividends: 500, couponInterest: 50, borrowFunding: -452.75, lendingIncome: 0, commissions: -31.80, fees: -250, unrealized: 9_809, fx: 14_501.30, total: 25_125.75 },
      T: { fx: 13_301.50, total: 13_277.50 }, N: { unrealized: 9_900, total: 11_010.91 }, S: { unrealized: -91, fx: 1_199.80, total: 837.34 },
    },
    fxByCcy: { EUR: 1_999.80, JPY: 12_501.50 },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: false, affected: [],
  },

  // C6: Friday 10:10. The put has no price at all, and the EUR/USD rate is two days old: provisional, named, nothing fabricated.
  C6: {
    units: {
      T: { netAssets: 657_277.50 },
      N: { netAssets: 861_010.91 },
      // S: the put is carried at its cost, -240, not at a price: positions -49,975 - 240 = -50,215 USD.
      S: { lines: { cash: { USD: 548_959.20, EUR: 9_990 }, restricted: { USD: 50_974.50 }, positions: { USD: -50_215, EUR: 49_950 }, accruedExpense: { USD: 4.16 } }, netAssets: 616_847.34 },
    },
    book: { netAssets: 2_135_135.75 },
    pnl: { book: { unrealized: 9_819, total: 25_135.75, unrealizedComplete: false } },
    provisional: true, complete: false, affected: [['unpriced', 'VRFY260320P95', 'South'], ['fx-stale', 'EUR']],
  },

  // C7: Friday 17:30, end of day. Futures settle at 5,020 (+1,000); the swap's current mark +1.00 supports 10,000 of collateral
  // received: 5,000 goes back to the counterparty.
  C7: {
    units: {
      // T: one more day of yen interest at 160: 1,200 JPY = 7.50; accrued 4,800 JPY = 30.00.
      T: { lines: { cash: { USD: 800_000, EUR: 40_000 }, borrowed: { JPY: 30_000_000 }, accruedExpense: { JPY: 4_800 } },
        assets: 844_800, liabilities: 187_530, netAssets: 657_270, capital: 2_110_000, internal: -1_466_000, results: 13_270 },
      // N: cash + 1,000; restricted and owed back 15,000 - 5,000 = 10,000; loan 4 x 50 = 200; repo 3 days 36.8895 -> 36.89.
      N: { lines: { cash: { USD: 1_012_157.50 }, restricted: { USD: 10_000 }, margin: { USD: 40_000 }, positions: { USD: 208_400 }, borrowed: { USD: 398_372 }, accruedExpense: { USD: 236.89 }, collateralReceived: { USD: 10_000 } },
        assets: 1_270_557.50, liabilities: 408_608.89, netAssets: 861_948.61, capital: 0, internal: 850_000, results: 11_948.61 },
      // S: borrow fee 4 days 5.5528 -> 5.55.
      S: { lines: { cash: { USD: 548_959.20, EUR: 9_990 }, restricted: { USD: 50_974.50 }, positions: { USD: -50_225, EUR: 49_950 }, accruedExpense: { USD: 5.55 } },
        assets: 616_841.50, liabilities: 5.55, netAssets: 616_835.95, capital: 0, internal: 616_000, results: 835.95 },
    },
    book: { assets: 2_732_199, liabilities: 596_144.44, netAssets: 2_136_054.56, capital: 2_110_000, results: 26_054.56, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      // borrowing and funding 236.89 + 5.55 + 250 + 24 + 7.50 = 523.94.
      book: { realized: 2_000, dividends: 500, couponInterest: 50, borrowFunding: -523.94, lendingIncome: 0, commissions: -31.80, fees: -250, unrealized: 9_809, fx: 14_501.30, total: 26_054.56 },
      T: { borrowFunding: -31.50, fx: 13_301.50, total: 13_270 }, N: { realized: 2_000, borrowFunding: -236.89, total: 11_948.61 }, S: { borrowFunding: -255.55, total: 835.95 },
    },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: false, affected: [],
    swap: { value: 10_000, independentHeld: 20_000, variationPosted: 0, variationReceived: 10_000, provisional: false },
  },

  // C8: Monday 9 March 10:00, every position closed and North's loan repaid; Treasury has bought the yen to repay (value Wed 11).
  C8: {
    units: {
      // T: receivable 30,010,800 JPY (187,567.50), payable 187,567.50 USD.
      T: { lines: { cash: { USD: 800_000, EUR: 40_000 }, receivable: { JPY: 30_010_800 }, payable: { USD: 187_567.50 }, borrowed: { JPY: 30_000_000 }, accruedExpense: { JPY: 4_800 } },
        assets: 1_032_367.50, liabilities: 375_097.50, netAssets: 657_270, capital: 2_110_000, internal: -1_466_000, results: 13_270 },
      // N: 1,012,157.50 - 98,445.78 (repo and 73.78 interest) + 20,000 + 475 - 4.50 (futures) + 20,000 (independent amount
      //    back) - 300,350 (loan and 7 days' interest) = 653,832.22; the 10,000 held from the counterparty goes back to it;
      //    receivable 98,966.67 (bond) + 101,890 (VRFY) + 10,000 (swap terminated at +1.00, value Wed 11).
      N: { lines: { cash: { USD: 653_832.22 }, receivable: { USD: 210_856.67 } },
        assets: 864_688.89, liabilities: 0, netAssets: 864_688.89, capital: 0, internal: 850_000, results: 14_688.89 },
      // S: borrow fee 9.80 paid; payable 51,005 (cover) + 181.30 (puts); EURF sold: receivable 50,390 EUR.
      S: { lines: { cash: { USD: 548_949.40, EUR: 9_990 }, restricted: { USD: 50_974.50 }, receivable: { EUR: 50_390 }, payable: { USD: 51_186.30 } },
        assets: 667_549.50, liabilities: 51_186.30, netAssets: 616_363.20, capital: 0, internal: 616_000, results: 363.20 },
    },
    book: { assets: 2_564_605.89, liabilities: 426_283.80, netAssets: 2_138_322.09, capital: 2_110_000, results: 28_322.09, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      // realized: futures 1,000 + 1,000 + 475; VRFY 1,900; bond 400; swap 10,000; short -1,050; puts 60; EURF 400 EUR = 448.
      book: { realized: 14_233, dividends: 500, couponInterest: 116.67, borrowFunding: -715.08, lendingIncome: 0, commissions: -63.80, fees: -250, unrealized: 0, fx: 14_501.30, total: 28_322.09 },
      T: { total: 13_270 }, N: { realized: 14_775, couponInterest: 116.67, borrowFunding: -423.78, commissions: -29, total: 14_688.89 }, S: { realized: -542, borrowFunding: -259.80, commissions: -34.80, total: 363.20 },
    },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: false, affected: [],
    borrowings: [{ owner: 'T', family: 'loan', ccy: 'JPY', principal: 30_000_000, principalRc: 187_500, accrued: 4_800, interestToDate: 4_800, interestToDateRc: 31.50, feesToDate: 0 }],
  },

  // C9: Wednesday 11 March 10:00: everything settled, the yen loan repaid with 9 days' interest (10,800 JPY). Only cash is left.
  C9: {
    units: {
      // T: 800,000 - 187,567.50 = 612,432.50 USD; 40,000 EUR (44,800).
      T: { lines: { cash: { USD: 612_432.50, EUR: 40_000 } }, assets: 657_232.50, liabilities: 0, netAssets: 657_232.50, capital: 2_110_000, internal: -1_466_000, results: 13_232.50 },
      N: { lines: { cash: { USD: 864_688.89 } }, assets: 864_688.89, liabilities: 0, netAssets: 864_688.89, capital: 0, internal: 850_000, results: 14_688.89 },
      // S: 548,949.40 - 30.50 - 181.30 = 548,737.60 USD (the cover took the 50,974.50 restricted and 30.50 more); 9,990 + 50,390 EUR.
      S: { lines: { cash: { USD: 548_737.60, EUR: 60_380 } }, assets: 616_363.20, liabilities: 0, netAssets: 616_363.20, capital: 0, internal: 616_000, results: 363.20 },
    },
    book: { assets: 2_138_284.59, liabilities: 0, netAssets: 2_138_284.59, capital: 2_110_000, results: 28_284.59, advanced: 1_466_000, received: 1_466_000 },
    pnl: {
      book: { realized: 14_233, dividends: 500, couponInterest: 116.67, borrowFunding: -752.58, lendingIncome: 0, commissions: -63.80, fees: -250, unrealized: 0, fx: 14_501.30, total: 28_284.59 },
      T: { borrowFunding: -69, fx: 13_301.50, total: 13_232.50 }, N: { total: 14_688.89 }, S: { total: 363.20 },
    },
    flows: { book: 2_110_000, T: 644_000, N: 850_000, S: 616_000 },
    provisional: false, affected: [],
    borrowings: [],
  },

  // C10: the Accounts send everything back to Treasury. Internal only: no P&L, Book unchanged.
  C10: {
    units: {
      // T: 612,432.50 + 864,688.89 + 548,737.60 = 2,025,858.99 USD; 40,000 + 60,380 = 100,380 EUR (112,425.60).
      // Funding at booked rates: USD -1,400,000 + 1,413,426.49 = 13,426.49; EUR -60,000 x 1.10 + 60,380 x 1.12 = 1,625.60: 15,052.09.
      T: { lines: { cash: { USD: 2_025_858.99, EUR: 100_380 } }, assets: 2_138_284.59, liabilities: 0, netAssets: 2_138_284.59, capital: 2_110_000, internal: 15_052.09, results: 13_232.50 },
      N: { lines: {}, assets: 0, liabilities: 0, netAssets: 0, capital: 0, internal: -14_688.89, results: 14_688.89 },
      // S: USD 550,000 - 548,737.60 = 1,262.40; EUR 66,000 - 67,625.60 = -1,625.60: -363.20.
      S: { lines: {}, assets: 0, liabilities: 0, netAssets: 0, capital: 0, internal: -363.20, results: 363.20 },
    },
    book: { assets: 2_138_284.59, liabilities: 0, netAssets: 2_138_284.59, capital: 2_110_000, results: 28_284.59 },
    pnl: { book: { realized: 14_233, dividends: 500, couponInterest: 116.67, borrowFunding: -752.58, lendingIncome: 0, commissions: -63.80, fees: -250, unrealized: 0, fx: 14_501.30, total: 28_284.59 },
      T: { total: 13_232.50 }, N: { total: 14_688.89 }, S: { total: 363.20 } },
    // Net flows per scope at booked rates: N 850,000 - 864,688.89; S 616,000 - 616,363.20; T 644,000 + 1,481,052.09.
    flows: { book: 2_110_000, T: 2_125_052.09, N: -14_688.89, S: -363.20 },
    provisional: false, affected: [],
    borrowings: [],
  },
};

// =====================================================================================================================
// Reading and comparing
// =====================================================================================================================

const r2 = (x) => Math.round(x * 100) / 100;
const TOL = 0.005;
const near = (a, b, tol = TOL) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const amounts = (cell) => Object.fromEntries((cell?.byCurrency || []).filter((x) => Math.abs(x.amount) > 0.004).map((x) => [x.ccy, x.amount]));
const sameAmounts = (a, b) => { const k = new Set([...Object.keys(a), ...Object.keys(b)]); return [...k].every((c) => near(a[c] ?? 0, b[c] ?? 0)); };

/** Everything a checkpoint compares, read through the API of the world (engine handlers or HTTP). */
export async function readBooks(w, ids) {
  const scopes = { book: 'book', T: 'treasury', N: ids.N, S: ids.S };
  const get = (tab, scope) => w.get(`/api/books/${ids.book}/accounting/${tab}`, { scope });
  const out = { bs: {}, pnl: {}, pos: {} };
  for (const [k, scope] of Object.entries(scopes)) {
    out.bs[k] = await get('balance', scope);
    out.pnl[k] = await get('pnl', scope);
  }
  out.pos.book = await get('positions', 'book');
  out.borrowings = (await get('borrowings', 'book')).items;
  out.integrity = await w.get(`/api/books/${ids.book}/integrity`);
  return out;
}

const PNL_KEYS = ['realized', 'dividends', 'couponInterest', 'borrowFunding', 'lendingIncome', 'commissions', 'fees'];
export function pnlFigures(p) {
  const o = Object.fromEntries(PNL_KEYS.map((k) => [k, p.categories.find((c) => c.key === k)?.rc ?? 0]));
  // FX effects: the translation of each currency's balances, and the dealing cost on conversions (the rest of the FX line),
  // as the P&L statement shows them.
  const translation = Object.fromEntries((p.fx.byCurrency || []).map((x) => [x.ccy, x.translation]));
  return { ...o, unrealized: p.unrealized.current, unrealizedComplete: p.unrealized.complete, fx: p.fx.current, total: p.investmentPnl, fxByCcy: translation, fxDealing: r2(p.fx.current - Object.values(translation).reduce((a, x) => a + x, 0)) };
}
const repBy = (bs, key, unit) => { const r = bs.representedBy.find((x) => x.key === key); return unit ? r.cells[unit]?.rc ?? 0 : r.total.rc; };

/**
 * Compare one checkpoint. `c` collects checks. Literal comparisons come from EXPECT; the structural checks below are
 * the owner's rules (A - L = NA at every scope, the Book equals its owners after the elimination, each borrowing once,
 * transfers make no P&L, P&L reconciles with the change in net assets net of capital flows, integrity clean).
 */
export function compareCheckpoint(c, name, books, ids) {
  const X = EXPECT[name];
  const L = (label) => `${name}: ${label}`;
  const unitId = { T: ids.T, N: ids.N, S: ids.S };
  const unitName = { T: 'Treasury', N: 'North', S: 'South' };

  // ---- each owner on its own balance sheet ----------------------------------------------------------------------
  for (const [k, ux] of Object.entries(X.units || {})) {
    const bs = books.bs[k];
    const id = unitId[k];
    if (ux.lines) {
      const keys = new Set([...Object.keys(ux.lines), ...bs.lines.map((l) => l.key)]);
      for (const key of keys) {
        const want = ux.lines[key] || {};
        const got = amounts(bs.lines.find((l) => l.key === key)?.cells[id]);
        c.ok(sameAmounts(got, want), L(`${unitName[k]} line "${key}" by currency`), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
    }
    for (const f of ['assets', 'liabilities', 'netAssets']) if (ux[f] !== undefined) c.near(bs[f].cells[id].rc, ux[f], L(`${unitName[k]} ${f} (USD)`), 0.011);
    if (ux.capital !== undefined) c.near(repBy(bs, 'capital', id), ux.capital, L(`${unitName[k]} external capital, at booked rates`), 0.011);
    if (ux.internal !== undefined) c.near(repBy(bs, 'internal', id), ux.internal, L(`${unitName[k]} internal funding, at booked rates`), 0.011);
    if (ux.results !== undefined) c.near(repBy(bs, 'results', id), ux.results, L(`${unitName[k]} results to date`), 0.011);
    // Assets less liabilities equal net assets, in every currency and in USD.
    const a = amounts(bs.assets.cells[id]), l = amounts(bs.liabilities.cells[id]), n = amounts(bs.netAssets.cells[id]);
    const diff = { ...a }; for (const [ccy, v] of Object.entries(l)) diff[ccy] = (diff[ccy] || 0) - v;
    c.ok(sameAmounts(diff, n), L(`${unitName[k]}: assets - liabilities = net assets in each currency`), `${JSON.stringify(diff)} vs ${JSON.stringify(n)}`);
    c.near(bs.assets.cells[id].rc - bs.liabilities.cells[id].rc, bs.netAssets.cells[id].rc, L(`${unitName[k]}: assets - liabilities = net assets in USD`), 0.011 * Math.max(1, Object.keys(n).length));
    c.near(bs.nav.value, bs.netAssets.total.rc, L(`${unitName[k]}: net asset value = net assets`), 0.011 * Math.max(1, Object.keys(n).length));
  }

  // ---- the Book, against its owners ---------------------------------------------------------------------------------
  const book = books.bs.book;
  if (X.book) {
    for (const f of ['assets', 'liabilities', 'netAssets']) if (X.book[f] !== undefined) c.near(book[f].total.rc, X.book[f], L(`Book ${f} (USD)`), 0.011);
    if (X.book.capital !== undefined) c.near(repBy(book, 'capital'), X.book.capital, L('Book external capital, at booked rates'), 0.011);
    if (X.book.results !== undefined) c.near(repBy(book, 'results'), X.book.results, L('Book results to date'), 0.011);
    const internal = book.representedBy.find((r) => r.key === 'internal');
    c.near(internal.total.rc, 0, L('internal funding is eliminated from the Book total'));
    c.eq(internal.residual, [], L('no internal funding residual'));
    if (X.book.advanced !== undefined) { c.near(internal.gross.advanced, X.book.advanced, L('funding advanced (elimination, one side)')); c.near(internal.gross.received, X.book.received, L('funding received (elimination, other side)')); }
    c.near(Object.values(internal.cells).reduce((a, x) => a + x.rc, 0) + (internal.elimination?.rc ?? 0), 0, L('owners\' funding plus the elimination is nil'));
  }
  // Every Book line is the sum of the owners' own lines, currency by currency (Book = owners after elimination).
  for (const line of book.lines) {
    const sum = {};
    for (const k of ['T', 'N', 'S']) for (const [ccy, v] of Object.entries(amounts(books.bs[k].lines.find((x) => x.key === line.key)?.cells[unitId[k]]))) sum[ccy] = (sum[ccy] || 0) + v;
    c.ok(sameAmounts(sum, amounts(line.total)), L(`Book line "${line.key}" = Treasury + North + South`), `${JSON.stringify(sum)} vs ${JSON.stringify(amounts(line.total))}`);
  }
  const ownNet = ['T', 'N', 'S'].reduce((a, k) => a + books.bs[k].netAssets.cells[unitId[k]].rc, 0);
  c.near(book.netAssets.total.rc, ownNet, L('Book net assets = the owners\' net assets added up'), 0.03);
  c.near(book.assets.total.rc - book.liabilities.total.rc, book.netAssets.total.rc, L('Book: assets - liabilities = net assets'), 0.03);

  // ---- P&L --------------------------------------------------------------------------------------------------------
  for (const [k, px] of Object.entries(X.pnl || {})) {
    const got = pnlFigures(books.pnl[k]);
    for (const [f, v] of Object.entries(px)) {
      if (f === 'unrealizedComplete') c.eq(got.unrealizedComplete, v, L(`P&L ${k}: unrealized complete`));
      else c.near(got[f], v, L(`P&L ${k === 'book' ? 'Book' : unitName[k]}: ${f}`), 0.011);
    }
  }
  if (X.fxByCcy) {
    for (const [ccy, v] of Object.entries(X.fxByCcy)) c.near(pnlFigures(books.pnl.book).fxByCcy[ccy], v, L(`FX effect: translation of ${ccy} balances`), 0.011);
    c.near(pnlFigures(books.pnl.book).fxDealing, 0, L('FX effect: no dealing cost (every conversion at the reporting rate)'), 0.011);
  }
  // Internal transfers make no Book P&L: the owners' P&L adds up to the Book's.
  const sumTotals = ['T', 'N', 'S'].reduce((a, k) => a + (books.pnl[k].investmentPnl ?? 0), 0);
  c.near(books.pnl.book.investmentPnl, sumTotals, L('Book P&L = Treasury + North + South (internal transfers create none)'), 0.03);
  // Realized, unrealized, income, financing and FX add up to the change in net assets net of capital flows.
  for (const k of ['book', 'T', 'N', 'S']) {
    const p = books.pnl[k];
    const parts = PNL_KEYS.reduce((a, f) => a + (p.categories.find((x) => x.key === f)?.rc ?? 0), 0) + p.unrealized.current + p.fx.current;
    c.near(p.investmentPnl, parts, L(`P&L ${k}: categories + unrealized + FX = total`), 0.011);
    if (X.flows?.[k] !== undefined) c.near(p.capital.net, X.flows[k], L(`P&L ${k}: net capital and funding flows at booked rates`), 0.011);
    if (p.nav.endComplete) c.near(p.nav.end - p.capital.net, p.investmentPnl, L(`P&L ${k}: change in net assets net of flows = P&L`), 0.03);
  }

  // ---- provisional NAV ----------------------------------------------------------------------------------------------
  if (X.provisional !== undefined) c.eq(book.nav.provisional, X.provisional, L('Book NAV provisional'));
  if (X.complete !== undefined) c.eq(book.nav.complete, X.complete, L('Book NAV complete'));
  if (X.affected) {
    const got = book.nav.affected.map((a) => (a.kind.startsWith('fx') ? [a.kind, a.ccy] : [a.kind, a.instrument?.symbol, a.owner])).sort();
    c.eq(got, [...X.affected].sort(), L('what makes the NAV provisional, named with its owner'));
  }

  // ---- borrowings: one record each, owned once --------------------------------------------------------------------
  if (X.borrowings) {
    const reg = books.borrowings;
    const ownerKey = (b) => Object.keys(unitId).find((k) => unitId[k] === b.owner.id);
    const got = reg.map((b) => ({ owner: ownerKey(b), family: b.family, ccy: b.ccy, principal: b.principal, principalRc: b.principalRc, securitiesQty: b.securities?.qty, securitiesValue: b.securities?.value, accrued: b.accrued, interestToDate: b.interestToDate, interestToDateRc: b.interestToDateRc, feesToDate: b.feesToDate, collateralCash: b.collateral?.cash ?? null, collateral: b.collateral?.description, accountOriginated: b.accountOriginated }));
    c.eq(got.length, X.borrowings.length, L('number of borrowing records in the Book'));
    for (const want of X.borrowings) {
      const hit = got.find((g) => g.owner === want.owner && g.family === want.family && g.ccy === want.ccy);
      if (!c.ok(hit, L(`borrowing of ${unitName[want.owner]} (${want.family} ${want.ccy}) is in the register`))) continue;
      for (const [f, v] of Object.entries(want)) {
        if (['owner', 'family', 'ccy'].includes(f)) continue;
        if (typeof v === 'number') c.near(hit[f], v, L(`borrowing ${want.owner}/${want.family}/${want.ccy}: ${f}`), 0.005); else c.eq(hit[f] ?? null, v, L(`borrowing ${want.owner}/${want.family}/${want.ccy}: ${f}`));
      }
      c.eq(hit.accountOriginated, want.owner !== 'T', L(`borrowing ${want.owner}/${want.family}: Account-originated flag`));
    }
    c.eq(new Set(reg.map((b) => b.id)).size, reg.length, L('each borrowing record appears once in the Book register'));
    // The owner's balance sheet carries it; Treasury's own sheet carries only Treasury's; oversight lists the Accounts' records.
    const tOwn = books.bs.T.borrowings.map((b) => b.id).sort();
    c.eq(tOwn, reg.filter((b) => b.owner.kind === 'treasury').map((b) => b.id).sort(), L('Treasury\'s own balance sheet lists only its own borrowings'));
    c.eq((books.bs.T.oversight?.accountBorrowings || []).map((b) => b.id).sort(), reg.filter((b) => b.owner.kind === 'account').map((b) => b.id).sort(), L('Treasury oversight lists the Accounts\' records, the same IDs'));
    for (const k of ['N', 'S']) c.eq(books.bs[k].borrowings.map((b) => b.id).sort(), reg.filter((b) => b.owner.id === unitId[k]).map((b) => b.id).sort(), L(`${unitName[k]}'s balance sheet lists its own borrowings`));
    // Each accrual sits once: the register's accrued interest equals the owner's accrued-expense line, currency by currency.
    for (const k of ['T', 'N', 'S']) {
      const byCcy = {};
      for (const b of reg.filter((x) => x.owner.id === unitId[k])) byCcy[b.ccy] = (byCcy[b.ccy] || 0) + b.accrued;
      const line = amounts(books.bs[k].lines.find((l) => l.key === 'accruedExpense')?.cells[unitId[k]]);
      c.ok(sameAmounts(Object.fromEntries(Object.entries(byCcy).filter(([, v]) => Math.abs(v) > 0.004)), line), L(`${unitName[k]}: accrued interest in the register = accrued-expense line`), `${JSON.stringify(byCcy)} vs ${JSON.stringify(line)}`);
    }
  }

  // ---- gross holdings and net exposure ----------------------------------------------------------------------------
  if (X.holdings) {
    for (const [sym, hx] of Object.entries(X.holdings)) {
      const h = books.pos.book.holdings.find((x) => x.instrument.symbol === sym);
      if (!c.ok(h, L(`holding ${sym} is listed`))) continue;
      c.eq([h.long, h.short, h.net], [hx.long, hx.short, hx.net], L(`${sym}: long, short and net held apart`));
      for (const k of ['N', 'S']) if (hx[k]) { const o = h.owners.find((x) => x.id === unitId[k]); c.eq(o ? [o.long, o.short, o.net] : null, hx[k], L(`${sym}: ${unitName[k]}'s own long, short, net`)); }
      const exposure = books.pos.book.positions.filter((p) => p.instrument.symbol === sym).reduce((a, p) => a + (p.exposure ?? 0), 0);
      c.near(exposure, hx.exposure, L(`${sym}: net exposure (long less short market value)`));
    }
  }

  // ---- cash: what is spendable --------------------------------------------------------------------------------------
  for (const [k, byCcy] of Object.entries(X.cash || {})) {
    for (const [ccy, want] of Object.entries(byCcy)) {
      const got = books.pos.book.cash.find((x) => x.owner.id === unitId[k] && x.ccy === ccy) || {};
      for (const [f, v] of Object.entries(want)) c.near(got[f] ?? 0, v, L(`${unitName[k]} ${ccy} ${f}`));
    }
  }

  // ---- OTC collateral of the swap ------------------------------------------------------------------------------------
  if (X.swap) {
    const p = books.pos.book.positions.find((x) => x.instrument.symbol === 'IRS-VER-1Y');
    if (c.ok(p, L('the swap is an open position'))) {
      c.near(p.mv, X.swap.value, L('swap value'));
      c.near(p.otcCollateral?.independent?.held, X.swap.independentHeld, L('swap independent amount held'));
      c.near(p.otcCollateral?.variation?.posted ?? 0, X.swap.variationPosted, L('swap variation margin posted'));
      c.near(p.otcCollateral?.variation?.received ?? 0, X.swap.variationReceived, L('swap variation margin received from the counterparty'));
      c.eq(Boolean(p.otcCollateral?.variation?.provisional), X.swap.provisional, L('variation margin call provisional (stale mark)'));
    }
  }

  // ---- integrity ---------------------------------------------------------------------------------------------------
  c.ok(books.integrity.ok, L('the integrity read is clean'), (books.integrity.problems || []).join(' | '));
}

// =====================================================================================================================
// The scenario
// =====================================================================================================================

/**
 * Run the whole scenario through `w` (a World of test/system/lib/world.mjs). `onCheckpoint(name, ctx)` is awaited after
 * every checkpoint's comparison (the browser level reads the screens there). Returns the context (ids, Terminal figures).
 */
export async function runVerification(w, c, { onCheckpoint = null, record = null } = {}) {
  const ids = {};
  const inst = {};
  const strat = {};
  const fx = (pair, rate, asOf) => w.fixture('fx', asOf ? { pair, rate, asOf } : { pair, rate });
  const quote = (id, q) => w.fixture('quote', { instrumentId: id, ...q });
  const checkpoint = async (name) => {
    const books = await readBooks(w, ids);
    if (record) record(name, books);
    compareCheckpoint(c, name, books, ids);
    if (onCheckpoint) await onCheckpoint(name, { ids, inst, strat, books });
    return books;
  };
  const trade = async (label, input) => {
    const pv = await w.post('/api/strategies/preview', input);
    if (pv.blocking) throw new Error(`${label}: preview blocked: ${pv.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | ')}`);
    const out = await w.post('/api/strategies', w.confirmBody(pv));
    for (const o of out.strategy.orders.filter((x) => x.submission === pv.token || !x.submission)) if (o.status !== 'filled') throw new Error(`${label}: leg ${o.kind} ${o.action} is ${o.status} (${o.statusReason || ''})`);
    return { pv, strategy: out.strategy };
  };
  const posOf = async (strategyId, family) => (await w.get(`/api/strategies/${strategyId}`)).positions.find((p) => p.family === family && Math.abs(p.qty) > 1e-9);

  // ---- C0: the Book, capital, funding ---------------------------------------------------------------------------------
  await w.clock(AT.mon);
  await fx('EUR/USD', 1.10);
  await fx('USD/JPY', 150);
  const b = await w.post('/api/books', { name: 'Verification Book', reportingCcy: 'USD' });
  ids.book = b.id;
  ids.T = b.units.find((u) => u.kind === 'treasury').id;
  await w.put(`/api/books/${b.id}`, { settings: SETTINGS });
  await w.post(`/api/books/${b.id}/capital`, { type: 'deposit', ccy: 'USD', amount: 2_000_000, note: 'External capital' });
  await w.post(`/api/books/${b.id}/capital`, { type: 'deposit', ccy: 'EUR', amount: 100_000, note: 'External capital' });
  ids.N = (await w.post(`/api/books/${b.id}/accounts`, { name: 'North' })).id;
  ids.S = (await w.post(`/api/books/${b.id}/accounts`, { name: 'South' })).id;
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.T, toUnitId: ids.N, ccy: 'USD', amount: 900_000, purpose: 'Treasury funding' });
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.T, toUnitId: ids.S, ccy: 'USD', amount: 500_000, purpose: 'Treasury funding' });
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.T, toUnitId: ids.S, ccy: 'EUR', amount: 60_000, purpose: 'Treasury funding' });
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.N, toUnitId: ids.S, ccy: 'USD', amount: 50_000, purpose: 'Account to Account' });
  await checkpoint('C0');

  // ---- instruments and fixtures ------------------------------------------------------------------------------------
  inst.vrfy = await w.instrument(DRAFTS.vrfy); await quote(inst.vrfy.id, Q.vrfy);
  await w.fixture('borrow', { instrumentId: inst.vrfy.id, available: true, quantity: 100_000, feeRate: 0.01 });
  inst.eurf = await w.instrument(DRAFTS.eurf); await quote(inst.eurf.id, Q.eurf);
  inst.usdjpy = await w.instrument(DRAFTS.usdjpy); await quote(inst.usdjpy.id, Q.jpy150);
  inst.put = await w.instrument(DRAFTS.put(inst.vrfy.id)); await quote(inst.put.id, Q.put);
  inst.bond = await w.instrument(DRAFTS.bond); await quote(inst.bond.id, Q.bond);
  inst.fut = await w.instrument(DRAFTS.fut); await quote(inst.fut.id, Q.fut);
  for (const d of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) await w.fixture('close', { instrumentId: inst.fut.id, date: d, value: 5010 });
  await w.fixture('close', { instrumentId: inst.fut.id, date: '2026-03-06', value: 5020 });
  await w.fixture('rate', { code: 'VER-3M', value: 4.0 });
  const agr = await w.post(`/api/books/${b.id}/agreements`, {
    name: 'CSA Verification Bank', counterparty: 'Verification Bank', kind: 'bilateral', unitIds: [ids.N],
    terms: { baseCcy: 'USD', postingCcy: 'USD', nettingScope: 'position', threshold: 0, minimumTransfer: 0, independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, eligible: [{ type: 'cash', ccy: 'USD', haircut: 0 }] },
  });
  inst.irs = await w.instrument(DRAFTS.irs(agr.id)); await quote(inst.irs.id, { last: 0 });

  // ---- C1: the openings --------------------------------------------------------------------------------------------
  // North borrows 300,000 USD from a bank (6.00% ACT/360, 50.00 a day) and pays a 250.00 arrangement fee on it.
  strat.loan = (await trade('North loan', { bookId: b.id, unitId: ids.N, template: 'custom', name: 'North bank loan', legs: [{ kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: 300_000,
    contract: loanContract('USD', 'Verification Bank term loan', { loanType: 'unsecured', rateType: 'fixed', rate: 0.06, dayCount: 'ACT/360', maturity: '2026-04-01', interestPayment: 'maturity', counterparty: 'Verification Bank' }) }] })).strategy;
  const loanPos = await posOf(strat.loan.id, 'loan');
  await w.post(`/api/positions/${loanPos.positionId}/lifecycle`, { action: 'cashflow', category: 'fee', amount: -250, note: 'Arrangement fee charged by Verification Bank' });
  // Treasury borrows 30,000,000 JPY (1.46% ACT/365, 1,200 JPY a day) and sells it at once for 200,000 USD at 150 (value Wed 4 March).
  strat.jpy = (await trade('Treasury borrow and convert', { bookId: b.id, unitId: ids.T, template: 'custom', name: 'Borrow yen, convert to dollars', legs: [
    { kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: 30_000_000, contract: loanContract('JPY', 'Tokyo Bank yen loan', { loanType: 'unsecured', rateType: 'fixed', rate: 0.0146, dayCount: 'ACT/365', maturity: '2026-04-01', interestPayment: 'maturity', counterparty: 'Tokyo Bank' }) },
    { kind: 'trade', action: 'buy', instrumentId: inst.usdjpy.id, qty: 200_000, dependsOn: [1] }] })).strategy;
  // North buys 1,000 VRFY at the ask, 100.00; South sells 500 short at the bid, 99.90, against a securities borrow.
  strat.long = (await trade('North long', w.ticketInput({ id: b.id, accountId: ids.N }, inst.vrfy, 'buy', 1000))).strategy;
  strat.short = (await trade('South short', w.ticketInput({ id: b.id, accountId: ids.S }, inst.vrfy, 'sell_short', 500))).strategy;
  // North buys 100,000 face of the bond at 98.50, between coupons: settles Tue 3 March with 177 days (30/360) of interest.
  const bondTrade = await trade('North bond', { bookId: b.id, unitId: ids.N, template: 'long', underlyingId: inst.bond.id, origin: 'marketplace', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.bond.id, qty: 100_000, role: 'underlying', orderType: 'market', tif: 'day' }] });
  strat.bond = bondTrade.strategy;
  // Quotation in % of par, accrued interest and the settlement amount, as the preview states them.
  const bl = bondTrade.pv.legs[0];
  c.near(bl.price?.estimate ?? bl.estimate, 98.50, 'bond preview: price in % of par (clean)');
  c.near(Math.abs(bl.cash), 101_450, 'bond preview: settlement amount 98,500.00 + 2,950.00 accrued');
  c.eq(bl.settleDate, '2026-03-03', 'bond preview: settles T+1');
  // South writes 2 puts at the bid, 1.20: 240 premium, reserve 2 x 100 x 95 = 19,000.
  const putTrade = await trade('South puts', { bookId: b.id, unitId: ids.S, template: 'custom', underlyingId: inst.put.id, origin: 'marketplace', legs: [{ kind: 'trade', action: 'sell', instrumentId: inst.put.id, qty: 2, role: 'underlying', orderType: 'market', tif: 'day' }] });
  strat.puts = putTrade.strategy;
  c.near(putTrade.pv.totals.cash.USD.reserved, 19_000, 'put preview: cash-secured reserve 2 x 100 x 95');
  // North buys 2 futures at the ask, 5,000.00: initial margin 2 x 10,000; notional 2 x 5,000 x 50 = 500,000.
  const futTrade = await trade('North future', { bookId: b.id, unitId: ids.N, template: 'custom', underlyingId: inst.fut.id, origin: 'marketplace', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.fut.id, qty: 2, role: 'underlying', orderType: 'market', tif: 'day' }] });
  strat.fut = futTrade.strategy;
  c.near(futTrade.pv.legs[0].initialMargin, 20_000, 'future preview: initial margin 2 x 10,000');
  c.near(futTrade.pv.legs[0].notional, 500_000, 'future preview: notional 2 x 5,000.00 x 50');
  // South buys 1,000 EURF at the ask, 50.00 EUR (T+2 on TARGET: Wed 4 March).
  strat.eurf = (await trade('South EURF', w.ticketInput({ id: b.id, accountId: ids.S }, inst.eurf, 'buy', 1000))).strategy;
  // North enters the swap at zero upfront under the agreement: independent amount 2% x 1,000,000 = 20,000.
  const swapTrade = await trade('North swap', { bookId: b.id, unitId: ids.N, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.irs.id, qty: 1_000_000, statedPrice: 0 }] });
  strat.swap = swapTrade.strategy;
  c.near(swapTrade.pv.legs[0].initialMargin, 20_000, 'swap preview: independent amount 2% of 1,000,000');
  await checkpoint('C1');

  // ---- C2: Monday's end of day ---------------------------------------------------------------------------------------
  await quote(inst.fut.id, Q.fut2);
  await quote(inst.irs.id, { last: 1.5, asOf: '2026-02-27T21:00:00.000Z' });
  await w.clock(AT.monEod);
  await checkpoint('C2');

  // ---- C3: Tuesday: settlements, the repo, and what cannot be spent --------------------------------------------------
  await w.clock(AT.tue);
  const bondPos = await posOf(strat.bond.id, 'bond');
  // Asking for one cent more than the collateral supports is refused.
  const tooMuch = await w.req('POST', '/api/strategies/preview', { bookId: b.id, unitId: ids.N, template: 'custom', name: 'Verity notes repo', legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 98_372.01, contract: repoContract(inst.bond.id), collateralPositionId: bondPos.positionId }] });
  c.ok(tooMuch.ok && tooMuch.body.blocking > 0 && /supports at most 98,372\.00 USD/.test(tooMuch.body.checks.map((x) => x.message).join(' ')), 'repo: 98,372.01 is refused: the collateral supports at most 98,372.00', tooMuch.ok ? tooMuch.body.checks.map((x) => x.message).join(' | ') : tooMuch.error);
  const repoTrade = await trade('North repo', { bookId: b.id, unitId: ids.N, template: 'custom', name: 'Verity notes repo', legs: [{ kind: 'repo_open', action: 'repo', purpose: 'financing', qty: 98_372, contract: repoContract(inst.bond.id), collateralPositionId: bondPos.positionId }] });
  strat.repo = repoTrade.strategy;
  const coll = repoTrade.pv.legs[0].financing?.collateral || {};
  for (const [k, v] of Object.entries(EXPECT.C3.repo)) c.near(coll[k], v, `repo proceeds reconciliation: ${k}`);
  // Restricted short proceeds and reserved cash cannot be transferred: South holds 549,209.20 settled, 33,992.50 reserved.
  const tr = await w.req('POST', `/api/books/${b.id}/transfers`, { fromUnitId: ids.S, toUnitId: ids.T, ccy: 'USD', amount: 520_000, purpose: 'Would use restricted cash' });
  c.refused(tr, { code: 'insufficient_cash', text: 'South has 515,216.70 USD of settled USD available; 520,000.00 USD requested.' }, 'transfer that would use restricted proceeds and reserved cash');
  // A trade that would use them is refused: 5,200 VRFY at 100.00 + 52.00 commission = 520,052.00 against 515,216.70 free.
  const big = await w.preview(w.ticketInput({ id: b.id, accountId: ids.S }, inst.vrfy, 'buy', 5200));
  c.ok(big.ok && big.body.blocking > 0 && /short 4,835\.30 USD/.test(big.body.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' ')), 'purchase that would use restricted proceeds is refused (short 4,835.30)', big.ok ? big.body.checks.map((x) => x.message).join(' | ') : big.error);
  // Margin posted (40,000) and cash collateral received from the swap counterparty (15,000, restricted, owed back) are not
  // spendable: North holds 1,007,657.50 settled; 1,062,657.50 with them. 1,050,000 is refused.
  const tm = await w.req('POST', `/api/books/${b.id}/transfers`, { fromUnitId: ids.N, toUnitId: ids.T, ccy: 'USD', amount: 1_050_000, purpose: 'Would use margin and collateral received' });
  c.refused(tm, { code: 'insufficient_cash', text: 'North has 1,007,657.50 USD of settled USD available; 1,050,000.00 USD requested.' }, 'transfer that would use posted margin and cash collateral received');
  // Pledged notes cannot be sold.
  const pledged = await w.post(`/api/strategies/${strat.bond.id}/preview-action`, { action: 'close', positionIds: [bondPos.positionId] });
  c.ok(pledged.blocking > 0, 'the pledged notes cannot be sold while the repo is open', pledged.checks.map((x) => x.message).join(' | '));
  await checkpoint('C3');

  // ---- C4: to Friday morning ------------------------------------------------------------------------------------------
  await w.post('/api/corporate-actions', { instrumentId: inst.vrfy.id, type: 'cash_dividend', exDate: '2026-03-05', payDate: '2026-03-05', amount: 0.5 });
  await w.clock(AT.fri);
  await checkpoint('C4');

  // ---- C5: FX moves; the swap gets a current mark ----------------------------------------------------------------------
  await w.clock(AT.friFx);
  await fx('EUR/USD', 1.12);
  await fx('USD/JPY', 160);
  await quote(inst.usdjpy.id, Q.jpy160);
  await quote(inst.irs.id, { last: 1 });
  await w.tick();
  await checkpoint('C5');

  // ---- C6: a missing mark and a stale rate ------------------------------------------------------------------------------
  await w.clock(AT.friGap);
  await w.fixture('quote', { instrumentId: inst.put.id, clear: true });
  await fx('EUR/USD', 1.12, '2026-03-04T15:00:00.000Z');
  await checkpoint('C6');
  await w.clock(AT.friBack);
  await quote(inst.put.id, Q.put);
  await fx('EUR/USD', 1.12);
  await w.tick();

  // ---- C7: Friday's end of day ----------------------------------------------------------------------------------------
  await quote(inst.fut.id, Q.fut3);
  await w.clock(AT.friEod);
  await checkpoint('C7');

  // ---- C8: Monday 9 March: everything is closed ----------------------------------------------------------------------
  await w.clock(AT.mon2);
  await quote(inst.vrfy.id, Q.vrfy2); await quote(inst.eurf.id, Q.eurf2); await quote(inst.put.id, Q.put2); await quote(inst.bond.id, Q.bond2); await quote(inst.fut.id, Q.fut4);
  const repoPos = await posOf(strat.repo.id, 'repo');
  await trade('North repo repurchase', { bookId: b.id, unitId: ids.N, template: 'custom', attachTo: strat.repo.id, legs: [{ kind: 'repo_close', action: 'close_repo', purpose: 'financing', targetPositionId: repoPos.positionId, qty: 98_372 }] });
  const closeAll = async (label, strategyId, args = {}) => {
    const pv = await w.post(`/api/strategies/${strategyId}/preview-action`, { action: 'close', ...args });
    if (pv.blocking) throw new Error(`${label}: close blocked: ${pv.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | ')}`);
    return (await w.post('/api/strategies', w.confirmBody(pv))).strategy;
  };
  await closeAll('North bond', strat.bond.id);
  await closeAll('North VRFY', strat.long.id);
  await closeAll('North future', strat.fut.id);
  await closeAll('North swap', strat.swap.id, { order: { statedPrice: 1 } });
  await trade('North loan repayment', { bookId: b.id, unitId: ids.N, template: 'custom', attachTo: strat.loan.id, legs: [{ kind: 'repay', action: 'repay_cash', purpose: 'financing', targetPositionId: loanPos.positionId, qty: 300_000 }] });
  await closeAll('South cover', strat.short.id);
  await closeAll('South puts', strat.puts.id);
  await closeAll('South EURF', strat.eurf.id);
  // Treasury buys the yen it will repay on Wednesday: 30,000,000 + 9 days x 1,200 = 30,010,800 JPY = 187,567.50 USD at 160.
  strat.jpyBack = (await trade('Treasury buys yen', { bookId: b.id, unitId: ids.T, template: 'custom', name: 'Yen for the repayment', legs: [{ kind: 'trade', action: 'sell', instrumentId: inst.usdjpy.id, qty: 187_567.50 }] })).strategy;
  await checkpoint('C8');

  // ---- C9: Wednesday 11 March: settled; the yen loan is repaid -------------------------------------------------------
  await w.clock(AT.wed2);
  const jpyPos = await posOf(strat.jpy.id, 'loan');
  await trade('Treasury yen repayment', { bookId: b.id, unitId: ids.T, template: 'custom', attachTo: strat.jpy.id, legs: [{ kind: 'repay', action: 'repay_cash', purpose: 'financing', targetPositionId: jpyPos.positionId, qty: 30_000_000 }] });
  await checkpoint('C9');

  // ---- C10: the Accounts return everything to Treasury ---------------------------------------------------------------
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.N, toUnitId: ids.T, ccy: 'USD', amount: 864_688.89, purpose: 'Return to Treasury' });
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.S, toUnitId: ids.T, ccy: 'USD', amount: 548_737.60, purpose: 'Return to Treasury' });
  await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: ids.S, toUnitId: ids.T, ccy: 'EUR', amount: 60_380, purpose: 'Return to Treasury' });
  await checkpoint('C10');
  return { ids, inst, strat };
}

// =====================================================================================================================
// Browser level: the Accounting screens at the checkpoints
// =====================================================================================================================

const SCREEN_AT = new Set(['C1', 'C3', 'C5', 'C6', 'C9', 'C10']);

async function readScreensAt(b, c, name, ctx) {
  const { page, ui } = b;
  const X = EXPECT[name];
  const L = (label) => `${name} screen: ${label}`;
  const { shown } = await import('../../matrix/drivers/browser.mjs');
  const near2 = (s, want, label) => c.ok(s && s.value !== null && Math.abs(s.value - want) <= 0.5 * 10 ** -s.decimals + 1e-9, L(label), `expected ${want}, the screen shows "${s?.text}"`);

  // The Book selector, as a user does.
  if (!b.entered) {
    await ui.goto('#/books');
    const selector = page.locator('.topbar select').first();
    await selector.selectOption({ label: 'Verification Book' });
    b.entered = true;
  }
  // Balance sheet, whole Book: the consolidation worksheet.
  await ui.goto('#/accounting/balance/book');
  await page.locator('main .bs-body table').first().waitFor();
  await ui.drawn();
  const grid = await page.evaluate(() => {
    const head = [...document.querySelectorAll('main .bs-head thead tr:first-child th')].map((th) => th.innerText.trim().split('\n')[0]);
    const rows = [...document.querySelectorAll('main .bs-body tbody tr')].filter((tr) => !tr.classList.contains('group')).map((tr) => [...tr.children].map((td) => td.innerText.trim()));
    return { head, rows };
  });
  const col = (title) => grid.head.findIndex((h) => h === title);
  const row = (label) => grid.rows.find((r) => r[0].split('\n')[0].replace(/\s*(show|hide) currencies$/, '').trim() === label);
  const cols = { T: col('Treasury'), N: col('North'), S: col('South'), book: col('Whole Book') };
  c.ok(cols.T > 0 && cols.N > 0 && cols.S > 0 && cols.book > 0, L('the worksheet has a column for Treasury, North, South and the Whole Book'), JSON.stringify(grid.head));
  for (const [label, key] of [['Total assets', 'assets'], ['Total liabilities', 'liabilities'], ['Net assets', 'netAssets']]) {
    const r = row(label);
    if (!c.ok(r, L(`row "${label}"`))) continue;
    for (const k of ['T', 'N', 'S']) if (X.units?.[k]?.[key] !== undefined) near2(shown(r[cols[k]]), X.units[k][key], `${label}, ${k}`);
    if (X.book?.[key] !== undefined) near2(shown(r[cols.book]), X.book[key], `${label}, Whole Book`);
  }
  const fund = row('Funding between Treasury and Accounts');
  if (fund && X.book?.advanced !== undefined) {
    const elim = fund[col('Eliminations')] || '';
    c.match(elim, /eliminated/, L('internal funding shown as eliminated'));
    near2(shown(/([\d,.]+)\s+advanced/.exec(elim)?.[1]), X.book.advanced, 'funding advanced, beside the elimination');
    near2(shown(/([\d,.]+)\s+received/.exec(elim)?.[1]), X.book.received, 'funding received, beside the elimination');
    near2(shown(fund[cols.book]), 0, 'internal funding in the Whole Book column');
  }
  const capRow = row('External capital contributed');
  if (capRow && X.book?.capital !== undefined) near2(shown(capRow[cols.book]), X.book.capital, 'external capital, Whole Book');
  const resRow = row('Results to date');
  if (resRow && X.book?.results !== undefined) near2(shown(resRow[cols.book]), X.book.results, 'results to date, Whole Book');
  const navTxt = (await page.locator('main .notice, main').filter({ hasText: /Net asset value|provisional/ }).first().innerText().catch(() => '')) || '';
  if (X.provisional) c.match(navTxt, /provisional/i, L('the balance sheet says the net asset value is provisional'));

  // P&L statement, whole Book.
  if (X.pnl?.book) {
    await ui.goto('#/accounting/pnl/book');
    await page.locator('main header h3', { hasText: /^Statement for/ }).first().waitFor();
    await ui.drawn();
    const stmt = (await ui.tables(page.locator('main'))).find((t) => /^Statement for/.test(t.title));
    const labels = { realized: 'Realized P&L', dividends: 'Dividends', couponInterest: 'Coupon and interest income', borrowFunding: 'Borrowing and funding expenses', lendingIncome: 'Lending income', commissions: 'Commissions', fees: 'Fees', unrealized: 'Unrealized P&L', fx: 'FX effects', total: 'Investment P&L' };
    for (const [k, label] of Object.entries(labels)) {
      if (X.pnl.book[k] === undefined) continue;
      const r = (stmt?.rows || []).find((x) => { const first = (x.cells[0] || '').split('\n')[0].trim(); return first === label || first.startsWith(`${label} `); });
      if (c.ok(r, L(`P&L line "${label}"`))) near2(shown(r.cells[r.cells.length - 1]), X.pnl.book[k], `P&L ${label}`);
    }
  }

  // Positions, whole Book: the net asset value and what makes it provisional; gross holdings.
  await ui.goto('#/accounting/positions/book');
  await page.locator('main .stat .k', { hasText: /^Net asset value/ }).first().waitFor();
  await page.locator('main table thead th', { hasText: /^Cash, \d+ owners/ }).first().waitFor();
  await ui.drawn();
  const navStat = (await page.locator('main .stat').filter({ has: page.locator('.k', { hasText: /^Net asset value/ }) }).first().locator('.v').innerText()).trim();
  if (X.book?.netAssets !== undefined) near2(shown(navStat), X.book.netAssets, 'Book net asset value');
  c.eq(/provisional/i.test(navStat), Boolean(X.provisional), L('net asset value labelled provisional exactly when it is'));
  if (X.affected?.length) {
    const body = await page.locator('main').innerText();
    for (const a of X.affected) c.match(body, a[0].startsWith('fx') ? new RegExp(`${a[1]}: converted at a rate that is not current`) : new RegExp(`${a[1]} \\(${a[2]}\\)`), L(`the screen names ${a[1]}`));
  }
  if (X.holdings) {
    const held = (await ui.tables(page.locator('main'))).find((t) => /^Holdings by instrument/.test(t.title));
    for (const [sym, hx] of Object.entries(X.holdings)) {
      const r = (held?.rows || []).find((x) => (x.cells[0] || '').split(/\s/)[0] === sym);
      if (!c.ok(r, L(`holdings row ${sym}`))) continue;
      const text = r.cells.slice(1).join(' ');
      near2(shown(/Long ([\d,.]+)/.exec(text)?.[1]), hx.long, `${sym} long`);
      near2(shown(/Short ([\d,.]+)/.exec(text)?.[1]), hx.short, `${sym} short`);
    }
  }

  // Treasury alone: its own balances, and the Accounts' borrowings under oversight, not in its liabilities.
  if (X.units?.T?.liabilities !== undefined) {
    await ui.goto('#/accounting/balance/treasury');
    await page.locator('main .bs-body table').first().waitFor();
    await ui.drawn();
    const tl = await page.evaluate(() => [...document.querySelectorAll('main .bs-body tbody tr')].map((tr) => [...tr.children].map((td) => td.innerText.trim())));
    const liab = tl.find((r) => r[0].split('\n')[0].replace(/\s*(show|hide) currencies$/, '').trim() === 'Total liabilities');
    if (c.ok(liab, L('Treasury: total liabilities row'))) near2(shown(liab[1]), X.units.T.liabilities, 'Treasury\'s own liabilities exclude the Accounts\' borrowings');
    const accountBorrowings = (ctx.books.bs.T.oversight?.accountBorrowings || []).length;
    if (accountBorrowings) await page.locator('main h3, main h2', { hasText: /^Account-originated borrowings/ }).first().waitFor();
    if (accountBorrowings) c.ok(await page.locator('main', { hasText: /Accounts under Treasury oversight/ }).count(), L('Treasury shows the Accounts\' borrowings under oversight'));
  }
}

export default [
  {
    id: 'verification-book',
    title: 'Accounting verified against hand-worked figures: one Book, Treasury and two Accounts, every situation of section 7',
    proves: 'Assets less liabilities equal net assets at Account, Treasury and Book scope; the Book equals its owners after the internal funding is eliminated; each borrowing, interest, fee and collateral amount appears once; internal transfers make no P&L; long, short, derivative, loan and collateral balances are classified as stated; gross holdings and net exposure reconcile; bond quotation, accrued interest, multipliers, currencies and settlement amounts reconcile; repo proceeds reconcile to collateral value, haircut and buffer; realized and unrealized P&L, income, financing costs and FX effects add up to the change in net assets net of capital flows; a missing mark and a stale rate give a provisional NAV that names them; the integrity read is clean after every step.',
    expected: 'Eleven checkpoints from capital in (C0) to a clean end state (C10) match the literals of EXPECT in test/system/cases/accounting.mjs, each derived by hand in docs/ACCOUNTING-VERIFICATION.md: e.g. at C5 (EUR/USD 1.12, USD/JPY 160) the Book holds 2,135,125.75 with FX effects 14,501.30 kept apart from performance; at the end the Book holds 2,138,284.59 in cash against 2,110,000.00 contributed, results 28,284.59 = realized 14,233.00 + dividends 500.00 + coupon 116.67 - financing 752.58 - commissions 63.80 - fees 250.00 + FX 14,501.30. A transfer and a purchase that would use restricted short proceeds or reserved cash are refused, and so is a transfer of posted margin or of cash collateral received.',
    expectedBrowser: 'The same API steps; at C1, C3, C5, C6, C9 and C10 the Accounting screens (Book balance-sheet worksheet with its elimination, Book P&L statement, Book positions with the net asset value and holdings, Treasury\'s own balance sheet with its oversight) show the hand-worked figures to the decimals displayed, and the provisional net asset value at C6 names the unpriced put and the stale EUR rate.',
    levels: {
      engine: 'The engine level of this scenario is test/core/accounting-verification.test.js, which runs runVerification from this file in-process (route handlers, engine and ledger on a disposable database) as part of npm test, so it is not run a second time here.',
      api: async (w, c) => { await runVerification(w, c); },
      browser: async (b, c) => { await runVerification(b, c, { onCheckpoint: (name, ctx) => (SCREEN_AT.has(name) ? readScreensAt(b, c, name, ctx) : null) }); },
    },
    timeoutMs: 600_000,
  },
];
