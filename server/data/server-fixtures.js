// Demo fixtures for the server client (demo mode only).
//
// They stand in for Shaffer MarketData and Analytics Lab so every instrument-detail screen and every failure mode of
// owner section 8 can be exercised before the real contract exists. Everything here is FICTIONAL, labelled
// "Demo fixture" in every envelope (source.label) and every document, and never reaches the normal Terminal.
// Fixture IDs (fixture-ins-*, fixture-iss-*, fixture-ctr-*, fixture-strat-*) are not a guess at the real ID scheme.
//
// Quotes, history, FX and rates come from the simulated demo feed (labelled "Simulated demo feed"), so the
// detail header and the ticket see the same price. Company data and analytics are static fixture records dated
// relative to the Terminal clock (so an "upcoming" earnings date stays upcoming).
//
// Built-in cases (no control needed):
//   - ALFA statements: 12 quarters, 3 years, TTM; a restated quarter (original kept); YTD cash-flow quarters
//   - ALFA earnings: 8 reported quarters (one revised) and an upcoming ESTIMATED date; BRVO upcoming CONFIRMED
//   - ALFA filings (23) and news (25): paginated, cursor shape (filings) and page shape (news)
//   - ALFA corporate actions: a quarterly dividend delivered twice (same event ID)
//   - ALFA analytics: two SP3E runs, the older one historical; BRVO analytics partial; KAIJ in JPY
//   - BRVO statements: annual only (quarterly coverage missing); SIMGOV31: issuer only, no listing / equity data
//   - KAIJ filings: 403 (no permission for that issuer's documents); KAIJ corporate actions: server error (500)
//   - BRVO news: slow (1.5 s); KAIJ news: empty
//   - Options and futures: no issuer financials of their own; the envelope links to the underlying (`related`)
//   - p1 product pages: ratings and covenants (SIMCORP29, SIMGOV31), yield and spread (same), option Greeks (any demo
//     option: illustrative values, not calculated), futures curve (demo-feed prices of the registered months) and
//     exchange margin (S5, SKJ), fund holdings and fees (any fund), OTC marks (any swap, CDS, forward or OTC option),
//     FX forward points (EUR/USD, USD/JPY)
//
// Controls (POST /api/demo/fixtures/server): per dataset, mode available | stale | unavailable | empty | error |
// slow | partial | forbidden, optional delayMs; `reset` restores the built-in behaviour.

import { addDays, diffDays } from '../quant/dates.js';
import { AppError } from '../core/util.js';
import { GatewayError, SOURCES } from './server-client.js';
import { SERVER_DATASETS } from './ports.js';

export const FIXTURE_MODES = ['available', 'stale', 'unavailable', 'empty', 'error', 'slow', 'partial', 'forbidden',
  // Acceptance modes (i1): throttled = HTTP 429 with Retry-After (retried, bounded); offline = the gateway cannot be
  // reached (network error: disconnection); revised = a later delivery restates / revises what was shown first;
  // duplicate = the same record delivered twice in one answer; currency-mismatch / unit-mismatch = values in another
  // currency or scale than the instrument's quote (analytics) or than the other statements (statements).
  'throttled', 'offline', 'revised', 'duplicate', 'currency-mismatch', 'unit-mismatch'];
export const SP3E_FIXTURE_STRATEGY = { id: 'fixture-strat-sp3e', name: 'SP3E (demo fixture)', version: 'fixture-1' };
const NOTE = 'Demo fixture: fictional data for the demo instruments. Not Shaffer data and not market data.';
const SRC = SOURCES.demoFixture;
const FEED = SOURCES.demoFeed;

const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const iso = (d, time = '21:00:00') => `${d}T${time}.000Z`;

/** A one-page PDF with the given lines of text (Helvetica), with a correct cross-reference table. */
function fixturePdf(lines) {
  const esc = (t) => String(t).replace(/[\\()]/g, (c) => `\\${c}`);
  const text = lines.map((l, i) => `BT /F1 12 Tf 56 ${770 - i * 20} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- static company records -----------------------------------------------------------------------------------

const COMPANIES = {
  ALFA: {
    issuer: { id: 'fixture-iss-alfa', name: 'Alfa Industries (demo)', description: 'Fictional diversified industrial manufacturer used by the demo. Makes motion-control systems, sensors and aftermarket services.', sector: 'Industrials', industry: 'Machinery', classifications: [{ scheme: 'Demo sector scheme', level: 1, code: 'IND', label: 'Industrials' }, { scheme: 'Demo sector scheme', level: 2, code: 'IND-MCH', label: 'Machinery' }], country: 'US', employees: 18400, fiscalYearEnd: '12-31' },
    listing: { exchange: 'SIM-US', symbol: 'ALFA', currency: 'USD', sharesOutstanding: 412.5e6, floatShares: 405.1e6, marketCapBasis: 'server', marketCap: 75.2e9, listedSince: '1998-06-12' },
    highlights: { revenueTTM: null, dividendPerShareAnnual: 2.2, units: 'USD' },
    stmt: { base: 4200, growth: 0.015, margin: 0.18, ccy: 'USD', years: 3, quarterly: true },
  },
  BRVO: {
    issuer: { id: 'fixture-iss-brvo', name: 'Bravo Biotech (demo)', description: 'Fictional clinical-stage biotechnology company used by the demo.', sector: 'Health Care', industry: 'Biotechnology', classifications: [{ scheme: 'Demo sector scheme', level: 1, code: 'HC', label: 'Health Care' }], country: 'US', employees: 640, fiscalYearEnd: '12-31' },
    listing: { exchange: 'SIM-US', symbol: 'BRVO', currency: 'USD', sharesOutstanding: 88.0e6, floatShares: 71.4e6, marketCap: 4.05e9, listedSince: '2017-03-03' },
    highlights: { dividendPerShareAnnual: null, units: 'USD' },
    stmt: { base: 120, growth: 0.04, margin: -0.35, ccy: 'USD', years: 3, quarterly: false },
  },
  KAIJ: {
    issuer: { id: 'fixture-iss-kaij', name: 'Kaiju Motors (demo)', description: 'Fictional Japanese vehicle maker used by the demo.', sector: 'Consumer Discretionary', industry: 'Automobiles', classifications: [{ scheme: 'Demo sector scheme', level: 1, code: 'CD', label: 'Consumer Discretionary' }], country: 'JP', employees: 51200, fiscalYearEnd: '03-31' },
    listing: { exchange: 'SIM-JP', symbol: 'KAIJ', currency: 'JPY', sharesOutstanding: 1.21e9, floatShares: 1.02e9, marketCap: 3.45e12, listedSince: '1972-10-02' },
    highlights: { dividendPerShareAnnual: 60, units: 'JPY' },
    stmt: { base: 2.9e6, growth: 0.008, margin: 0.07, ccy: 'JPY', years: 2, quarterly: true },
  },
  SIMGOV31: {
    issuer: { id: 'fixture-iss-simgov', name: 'Sim Government (demo)', description: 'Fictional sovereign issuer of the demo government notes.', sector: 'Government', industry: 'Sovereign', classifications: [], country: 'US', employees: null, fiscalYearEnd: '09-30' },
    listing: null,
    highlights: null,
    stmt: null,
  },
};

// Analytics Lab fixture records (literal values as the server would send them; the Terminal computes none of them).
const ANALYTICS = {
  ALFA: [
    { runId: 'fixture-run-alfa-0002', version: 'sp3e-fixture-2.4', ageDays: 1, cutoffDays: 2, horizon: '12M', efs: 0.62, sectorScore: 71, equityScore: 68, fundamentalFairValue: 205.4, realisticFairValue: 196.1, fairValueCurrency: 'USD', fairValueUnits: 'per share', fundamentalGapPct: 11.8, realisticGapPct: 6.7, gapReference: { price: 183.7, units: 'per share', currency: 'USD', note: 'Gap % as supplied by Analytics Lab against its reference price at calculation time' }, uncertainty: { fundamental: { low: 188.0, high: 221.0 }, realistic: { low: 181.5, high: 209.0 }, confidence: 0.8 }, timingEligibility: { eligible: true, reason: 'Outside the earnings window' }, outlierFlags: [], sizing: { suggestedWeightPct: 2.5, maxWeightPct: 4.0, basis: 'Book NAV' }, hedge: { recommended: true, objective: 'beta', note: 'Request a Shaffer Hedge package after the fill' } },
    { runId: 'fixture-run-alfa-0001', version: 'sp3e-fixture-2.3', ageDays: 92, cutoffDays: 93, horizon: '12M', efs: 0.55, sectorScore: 64, equityScore: 61, fundamentalFairValue: 192.0, realisticFairValue: 185.3, fairValueCurrency: 'USD', fairValueUnits: 'per share', fundamentalGapPct: 9.1, realisticGapPct: 5.3, gapReference: { price: 176.0, units: 'per share', currency: 'USD', note: 'Gap % as supplied by Analytics Lab against its reference price at calculation time' }, uncertainty: { fundamental: { low: 176.0, high: 207.0 }, realistic: { low: 171.0, high: 199.0 }, confidence: 0.75 }, timingEligibility: { eligible: true, reason: 'Outside the earnings window' }, outlierFlags: ['sector-dispersion'], sizing: { suggestedWeightPct: 2.0, maxWeightPct: 4.0, basis: 'Book NAV' }, hedge: { recommended: false, objective: null, note: null } },
  ],
  BRVO: [
    { runId: 'fixture-run-brvo-0001', version: 'sp3e-fixture-2.4', ageDays: 1, cutoffDays: 2, horizon: '12M', efs: 0.31, sectorScore: 44, equityScore: null, fundamentalFairValue: 51.2, realisticFairValue: null, fairValueCurrency: 'USD', fairValueUnits: 'per share', fundamentalGapPct: 10.4, realisticGapPct: null, gapReference: { price: 46.4, units: 'per share', currency: 'USD', note: 'Gap % as supplied by Analytics Lab' }, uncertainty: { fundamental: { low: 38.0, high: 66.0 }, realistic: null, confidence: 0.45 }, timingEligibility: { eligible: true, reason: 'Outside the earnings window' }, outlierFlags: ['high-volatility', 'negative-earnings'], sizing: null, hedge: null, nulls: { equityScore: 'Equity Score is not produced for pre-revenue issuers', realisticFairValue: 'Realistic model not run for this issuer', realisticGapPct: 'No Realistic Fair Value' } },
  ],
  KAIJ: [
    { runId: 'fixture-run-kaij-0001', version: 'sp3e-fixture-2.4', ageDays: 1, cutoffDays: 2, horizon: '12M', efs: 0.58, sectorScore: 59, equityScore: 63, fundamentalFairValue: 3120, realisticFairValue: 2990, fairValueCurrency: 'JPY', fairValueUnits: 'per share', fundamentalGapPct: 9.5, realisticGapPct: 4.9, gapReference: { price: 2850, units: 'per share', currency: 'JPY', note: 'Gap % as supplied by Analytics Lab' }, uncertainty: { fundamental: { low: 2800, high: 3400 }, realistic: { low: 2700, high: 3250 }, confidence: 0.7 }, timingEligibility: { eligible: false, reason: 'Inside the earnings window' }, outlierFlags: [], sizing: { suggestedWeightPct: 1.5, maxWeightPct: 3.0, basis: 'Book NAV' }, hedge: { recommended: true, objective: 'fx', note: 'JPY exposure' } },
  ],
};

// ---- p1: product-specific fixture records (fictional; literal values as a server would send them) --------------
const RATINGS = {
  SIMGOV31: {
    scope: 'issuer', ratedEntity: { id: 'fixture-iss-simgov', name: 'Sim Government (demo)' },
    ratings: [
      { agency: 'Demo Ratings A', scale: 'long-term issuer, foreign currency', rating: 'AA+', outlook: 'stable', watch: null, action: 'affirmed', daysAgo: 64 },
      { agency: 'Demo Ratings B', scale: 'long-term issuer', rating: 'Aa1', outlook: 'negative', watch: null, action: 'outlook changed', daysAgo: 410 },
    ],
    covenants: [], covenantsNote: 'Sovereign notes carry no financial covenants in their offering terms (demo fixture).',
  },
  SIMCORP29: {
    scope: 'issue', ratedEntity: { id: 'fixture-iss-simcorp', name: 'Sim Corp (demo)' },
    ratings: [
      { agency: 'Demo Ratings A', scale: 'long-term issue', rating: 'BBB+', outlook: 'stable', watch: null, action: 'affirmed', daysAgo: 30 },
      { agency: 'Demo Ratings B', scale: 'long-term issue', rating: 'Baa1', outlook: null, watch: 'review for downgrade', action: 'placed on review', daysAgo: 9 },
      { agency: 'Demo Ratings C', scale: 'long-term issue', rating: 'BBB', outlook: 'positive', watch: null, action: 'upgraded from BBB-', daysAgo: 300 },
    ],
    covenants: [
      { key: 'negative-pledge', label: 'Negative pledge', text: 'No security over assets for other bonds unless these notes share it equally (demo fixture).', threshold: null, status: 'in force' },
      { key: 'change-of-control', label: 'Change of control put', text: 'Holders may require repurchase at 101% of par on a change of control with a downgrade below investment grade.', threshold: '101% of par', status: 'in force' },
      { key: 'max-leverage', label: 'Maximum net leverage', text: 'Net debt to EBITDA tested semi-annually.', threshold: '3.50x', status: 'in compliance (last test 2.8x, as reported by the issuer)' },
    ],
  },
};
const YIELDS = {
  SIMGOV31: { yield: { value: 4.118, type: 'yield to maturity', convention: 'semi-annual bond basis', units: 'percent' }, spread: null, priceUsed: { value: 100.52, units: '% of par (clean)', side: 'mid' }, nulls: { spread: 'A government note is the benchmark: no spread is supplied' } },
  SIMCORP29: { yield: { value: 5.274, type: 'yield to worst', convention: 'semi-annual bond basis', units: 'percent' }, spread: { valueBps: 131, type: 'G-spread', benchmark: { name: 'SIMGOV31 (demo)', symbol: 'SIMGOV31' } }, priceUsed: { value: 98.75, units: '% of par (clean)', side: 'mid' } },
};
const GREEKS = {
  C: { impliedVol: 0.274, delta: 0.54, gamma: 0.031, theta: -0.046, vega: 0.212, rho: null, model: 'Provider model (demo fixture)', underlyingPrice: null, optionPrice: null, units: { delta: 'per unit of underlying', gamma: 'per unit of underlying', theta: 'premium per calendar day', vega: 'premium per 1 volatility point', rho: 'premium per 1 percentage point' } },
  P: { impliedVol: 0.291, delta: -0.47, gamma: 0.029, theta: -0.039, vega: 0.208, rho: null, model: 'Provider model (demo fixture)', underlyingPrice: null, optionPrice: null, units: { delta: 'per unit of underlying', gamma: 'per unit of underlying', theta: 'premium per calendar day', vega: 'premium per 1 volatility point', rho: 'premium per 1 percentage point' } },
};
const MARGINS = {
  S5: { initial: 12650, maintenance: 11500, clearingHouse: 'SIM Clearing (demo fixture)', notes: 'Outright, speculator rate' },
  SKJ: { initial: 980000, maintenance: 890000, clearingHouse: 'SIM Clearing Japan (demo fixture)', notes: 'Outright' },
};
const FUND_HOLDINGS = [
  { name: 'Alfa Industries (demo)', ids: { server: 'fixture-ins-alfa' }, symbol: 'ALFA', assetClass: 'Equity', weightPct: 6.8, quantity: 412000, marketValue: null },
  { name: 'Sim Government 4.25% 2031 (demo)', ids: { server: 'fixture-ins-simgov31' }, symbol: 'SIMGOV31', assetClass: 'Government bond', weightPct: 6.1, quantity: 7200000, marketValue: null },
  { name: 'Charlie Logistics (demo)', ids: { server: 'fixture-ins-chrl' }, symbol: 'CHRL', assetClass: 'Equity', weightPct: 5.2, quantity: 300500, marketValue: null },
  { name: 'Delta Software (demo)', ids: { server: 'fixture-ins-dlta' }, symbol: 'DLTA', assetClass: 'Equity', weightPct: 4.9, quantity: 188000, marketValue: null },
  { name: 'Sim Corp 2029 notes (demo)', ids: { server: 'fixture-ins-simcorp29' }, symbol: 'SIMCORP29', assetClass: 'Corporate bond', weightPct: 4.6, quantity: 5100000, marketValue: null },
  { name: 'Bravo Biotech (demo)', ids: { server: 'fixture-ins-brvo' }, symbol: 'BRVO', assetClass: 'Equity', weightPct: 4.1, quantity: 101000, marketValue: null },
  { name: 'Echo Holdings ADR (demo)', ids: { server: 'fixture-ins-echo' }, symbol: 'ECHO', assetClass: 'Equity', weightPct: 3.9, quantity: 220000, marketValue: null },
  { name: 'Cash and equivalents', ids: null, symbol: null, assetClass: 'Cash', weightPct: 3.7, quantity: null, marketValue: null },
  { name: 'Kaiju Motors (demo)', ids: { server: 'fixture-ins-kaij' }, symbol: 'KAIJ', assetClass: 'Equity', weightPct: 3.6, quantity: 2600000, marketValue: null },
  { name: 'Rose Retail (demo)', ids: { server: 'fixture-ins-rose' }, symbol: 'ROSE', assetClass: 'Equity', weightPct: 3.4, quantity: 1500000, marketValue: null },
];
const FUND_FEES = { ongoingChargePct: 0.62, managementFeePct: 0.5, entryChargePct: 0, exitChargePct: 0, performanceFee: null };
const OTC_MARKS = [
  { daysAgo: 1, value: -0.44, kind: 'dealer', provider: 'Dealer A (demo fixture)', method: 'Dealer valuation statement' },
  { daysAgo: 1, value: -0.47, kind: 'clearing', provider: 'SIM Clearing (demo fixture)', method: 'Clearing-house settlement curve' },
  { daysAgo: 2, value: -0.51, kind: 'dealer', provider: 'Dealer A (demo fixture)', method: 'Dealer valuation statement' },
  { daysAgo: 3, value: -0.38, kind: 'dealer', provider: 'Dealer A (demo fixture)', method: 'Dealer valuation statement' },
  { daysAgo: 4, value: -0.42, kind: 'model', provider: 'Shaffer Analytics Lab (demo fixture)', method: 'Model valuation (not a quote)' },
  { daysAgo: 6, value: -0.35, kind: 'dealer', provider: 'Dealer A (demo fixture)', method: 'Dealer valuation statement' },
];
const FX_CURVES = {
  'EUR/USD': { pointsUnits: 'pips (0.0001 USD)', spotReference: { rate: null, note: 'Spot at the time the curve was struck is not supplied by the demo fixture' }, note: 'Demo fixture forward points.', points: [['1W', 7, 2.1, null], ['1M', 30, 9.2, null], ['3M', 92, 27.6, null], ['6M', 183, 55.4, null], ['1Y', 365, 108.9, null]], nulls: { outright: 'Not supplied by the demo fixture' } },
  'USD/JPY': { pointsUnits: 'pips (0.01 JPY)', spotReference: { rate: null, note: 'Not supplied by the demo fixture' }, note: 'Demo fixture forward points.', points: [['1W', 7, -8.4, null], ['1M', 30, -36.0, null], ['3M', 92, -104.5, null], ['6M', 183, -203.1, null], ['1Y', 365, -398.0, null]], nulls: { outright: 'Not supplied by the demo fixture' } },
};

// ---- statement generation (deterministic fixture series) ---------------------------------------------------

const INCOME_LINES = [
  ['revenue', 'Revenue', 0], ['costOfRevenue', 'Cost of revenue', 1], ['grossProfit', 'Gross profit', 0], ['sga', 'Selling, general and administrative', 1],
  ['rnd', 'Research and development', 1], ['operatingIncome', 'Operating income', 0], ['interestExpense', 'Interest expense', 1], ['pretaxIncome', 'Income before tax', 0],
  ['incomeTax', 'Income tax', 1], ['netIncome', 'Net income', 0], ['epsBasic', 'EPS, basic', 1], ['epsDiluted', 'EPS, diluted', 1], ['sharesDiluted', 'Diluted shares (millions)', 1],
];
const BALANCE_LINES = [
  ['cash', 'Cash and equivalents', 1], ['receivables', 'Receivables', 1], ['inventory', 'Inventory', 1], ['totalCurrentAssets', 'Total current assets', 0], ['ppe', 'Property, plant and equipment', 1],
  ['goodwill', 'Goodwill and intangibles', 1], ['totalAssets', 'Total assets', 0], ['payables', 'Payables', 1], ['shortDebt', 'Short-term debt', 1], ['totalCurrentLiabilities', 'Total current liabilities', 0],
  ['longDebt', 'Long-term debt', 1], ['totalLiabilities', 'Total liabilities', 0], ['equity', 'Shareholders\' equity', 0],
];
const CASHFLOW_LINES = [
  ['netIncome', 'Net income', 1], ['depreciation', 'Depreciation and amortisation', 1], ['workingCapital', 'Change in working capital', 1], ['cfo', 'Cash from operations', 0],
  ['capex', 'Capital expenditure', 1], ['cfi', 'Cash from investing', 0], ['dividendsPaid', 'Dividends paid', 1], ['buybacks', 'Share repurchases', 1], ['cff', 'Cash from financing', 0], ['netChange', 'Net change in cash', 0],
];

/** Fiscal quarters ending before `today`, most recent first: [{ fy, q, start, end }]. Calendar fiscal year. */
function pastQuarters(today, n) {
  const out = [];
  let y = Number(today.slice(0, 4));
  let q = Math.ceil(Number(today.slice(5, 7)) / 3) - 1;
  if (q === 0) { q = 4; y -= 1; }
  // a quarter is reported about 35 days after it ends: skip it if not yet filed
  const endOf = (yy, qq) => `${yy}-${String(qq * 3).padStart(2, '0')}-${[31, 30, 30, 31][qq - 1]}`;
  if (addDays(endOf(y, q), 35) > today) { q -= 1; if (q === 0) { q = 4; y -= 1; } }
  for (let i = 0; i < n; i++) {
    out.push({ fy: y, q, start: `${y}-${String(q * 3 - 2).padStart(2, '0')}-01`, end: endOf(y, q) });
    q -= 1; if (q === 0) { q = 4; y -= 1; }
  }
  return out;
}

function quarterValues(spec, idxFromOldest, seasonal) {
  const rev = spec.base * (1 + spec.growth) ** idxFromOldest * seasonal;
  const cost = rev * 0.58;
  const sga = rev * 0.12;
  const rnd = rev * (spec.margin < 0 ? 0.9 : 0.05);
  const op = rev - cost - sga - rnd;
  const intr = Math.abs(rev) * 0.01;
  const pre = op - intr;
  const tax = pre > 0 ? pre * 0.21 : 0;
  const ni = pre - tax;
  const sh = spec.ccy === 'JPY' ? 1210 : spec.margin < 0 ? 88 : 412.5;
  return { revenue: r1(rev), costOfRevenue: r1(cost), grossProfit: r1(rev - cost), sga: r1(sga), rnd: r1(rnd), operatingIncome: r1(op), interestExpense: r1(intr), pretaxIncome: r1(pre), incomeTax: r1(tax), netIncome: r1(ni), epsBasic: r2(ni / sh), epsDiluted: r2(ni / (sh * 1.01)), sharesDiluted: r1(sh * 1.01) };
}
function balanceValues(spec, idxFromOldest) {
  const s = spec.base * (1 + spec.growth) ** idxFromOldest;
  const cash = s * 0.9, rec = s * 0.6, inv = s * 0.5, tca = cash + rec + inv, ppe = s * 2.2, gw = s * 1.1, ta = tca + ppe + gw;
  const pay = s * 0.4, sd = s * 0.15, tcl = pay + sd, ld = s * 1.3, tl = tcl + ld;
  return { cash: r1(cash), receivables: r1(rec), inventory: r1(inv), totalCurrentAssets: r1(tca), ppe: r1(ppe), goodwill: r1(gw), totalAssets: r1(ta), payables: r1(pay), shortDebt: r1(sd), totalCurrentLiabilities: r1(tcl), longDebt: r1(ld), totalLiabilities: r1(tl), equity: r1(ta - tl) };
}
function cashflowValues(iv) {
  const dep = iv.revenue * 0.04, wc = -iv.revenue * 0.01, cfo = iv.netIncome + dep + wc, capex = -iv.revenue * 0.05, cfi = capex, div = -iv.revenue * 0.02, bb = -iv.revenue * 0.015, cff = div + bb;
  return { netIncome: iv.netIncome, depreciation: r1(dep), workingCapital: r1(wc), cfo: r1(cfo), capex: r1(capex), cfi: r1(cfi), dividendsPaid: r1(div), buybacks: r1(bb), cff: r1(cff), netChange: r1(cfo + cfi + cff) };
}
const sumVals = (list) => { const o = {}; for (const v of list) for (const [k, x] of Object.entries(v)) o[k] = r1((o[k] || 0) + x); return o; };

/** Builds a statement payload for a company spec. asOf: as-filed view (restatements after asOf not applied). */
function buildStatement(sym, spec, { statement, period, periods = 12, today, asOf }) {
  const nQ = spec.years * 4;
  const qs = pastQuarters(today, nQ + 4); // extra for TTM / YTD
  const seasonal = [1.0, 0.97, 1.02, 1.08];
  const byKey = new Map();
  qs.slice().reverse().forEach((q, i) => {
    const iv = quarterValues(spec, i, seasonal[q.q - 1]);
    byKey.set(`${q.fy}Q${q.q}`, { q, iv, bv: balanceValues(spec, i), cv: cashflowValues(iv) });
  });
  const filed = (end, days = 35) => addDays(end, days);
  // The restatement: the quarter five quarters back had revenue and cost restated 120 days after its filing.
  const rq = qs[4];
  const rKey = rq ? `${rq.fy}Q${rq.q}` : null;
  const restatedAt = rq ? filed(rq.end, 155) : null;
  const restatementVisible = rq && (!asOf || asOf >= restatedAt);
  const lines = statement === 'income' ? INCOME_LINES : statement === 'balance' ? BALANCE_LINES : CASHFLOW_LINES;
  const pick = (rec) => (statement === 'income' ? rec.iv : statement === 'balance' ? rec.bv : rec.cv);
  const outPeriods = [];
  const values = {}; // periodKey -> { line: value }
  const originals = {}; // periodKey -> { line: original value }
  const cutoff = asOf || today;
  const quartersOf = (fy) => [1, 2, 3, 4].map((q) => byKey.get(`${fy}Q${q}`)).filter(Boolean);

  if (period === 'quarterly') {
    for (const q of qs.slice(0, Math.min(periods, nQ))) {
      const key = `${q.fy}Q${q.q}`;
      const rec = byKey.get(key);
      if (filed(q.end) > cutoff) continue;
      let v = { ...pick(rec) };
      let basis = 'reported';
      let periodType = statement === 'balance' ? 'instant' : 'quarter';
      let start = statement === 'balance' ? null : q.start;
      // Cash flow is reported year-to-date for Q2 and Q3 (Q1 is both); the fixture keeps it so and says so.
      if (statement === 'cashflow' && q.q > 1) {
        v = sumVals(quartersOf(q.fy).filter((x) => x.q.q <= q.q).map((x) => x.cv));
        periodType = 'ytd';
        start = `${q.fy}-01-01`;
      }
      if (statement === 'cashflow' && q.q === 4) continue; // Q4 is only in the annual report
      if (key === rKey && statement !== 'balance' && statement !== 'cashflow') {
        const orig = { revenue: v.revenue, costOfRevenue: v.costOfRevenue, grossProfit: v.grossProfit };
        if (restatementVisible) {
          v.revenue = r1(v.revenue * 0.985);
          v.costOfRevenue = r1(v.costOfRevenue * 0.99);
          v.grossProfit = r1(v.revenue - v.costOfRevenue);
          basis = 'restated';
          originals[key] = orig;
        }
      }
      values[key] = v;
      outPeriods.push({ key, fiscalYear: q.fy, fiscalPeriod: `Q${q.q}`, periodType, start, end: q.end, months: periodType === 'ytd' ? q.q * 3 : periodType === 'instant' ? null : 3, filingDate: filed(q.end), source: 'Demo fixture filing', basis, restatedAt: basis === 'restated' ? restatedAt : null, original: originals[key] ? { filingDate: filed(q.end), values: originals[key] } : null });
    }
  } else if (period === 'annual') {
    const years = [...new Set(qs.filter((q) => q.q === 4).map((q) => q.fy))].slice(0, spec.years);
    for (const fy of years) {
      const qq = quartersOf(fy);
      if (qq.length < 4) continue;
      const end = `${fy}-12-31`;
      if (filed(end, 60) > cutoff) continue;
      const key = `${fy}FY`;
      values[key] = statement === 'balance' ? { ...qq[3].bv } : sumVals(qq.map(pick));
      if (statement === 'income') { values[key].epsBasic = r2(qq.reduce((s, x) => s + x.iv.epsBasic, 0)); values[key].epsDiluted = r2(qq.reduce((s, x) => s + x.iv.epsDiluted, 0)); values[key].sharesDiluted = qq[3].iv.sharesDiluted; }
      outPeriods.push({ key, fiscalYear: fy, fiscalPeriod: 'FY', periodType: statement === 'balance' ? 'instant' : 'annual', start: statement === 'balance' ? null : `${fy}-01-01`, end, months: statement === 'balance' ? null : 12, filingDate: filed(end, 60), source: 'Demo fixture annual report', basis: 'reported', restatedAt: null, original: null });
    }
  } else if (period === 'ttm') {
    if (statement === 'balance') return { data: null, message: 'Trailing twelve months does not apply to a balance sheet (values at a date).' };
    const last4 = qs.slice(0, 4).filter((q) => filed(q.end) <= cutoff).map((q) => byKey.get(`${q.fy}Q${q.q}`));
    if (last4.length === 4) {
      const key = 'TTM';
      values[key] = sumVals(last4.map(pick));
      outPeriods.push({ key, fiscalYear: null, fiscalPeriod: 'TTM', periodType: 'ttm', start: last4[3].q.start, end: last4[0].q.end, months: 12, filingDate: filed(last4[0].q.end), source: 'Demo fixture (server-supplied TTM)', basis: 'derived', restatedAt: null, original: null });
    }
  }
  if (!outPeriods.length) return { data: null, message: 'No periods available for this request.' };
  return {
    data: {
      statement, period, currency: spec.ccy, units: 'millions', perShareUnits: `${spec.ccy} per share`, issuerId: COMPANIES[sym].issuer.id,
      periods: outPeriods,
      lines: lines.map(([key, label, level]) => ({
        key, label, level, basis: key === 'grossProfit' ? 'derived' : 'reported',
        units: key.startsWith('eps') ? `${spec.ccy} per share` : key === 'sharesDiluted' ? 'millions of shares' : 'millions',
        values: Object.fromEntries(outPeriods.map((p) => [p.key, values[p.key]?.[key] ?? null])),
        original: Object.fromEntries(outPeriods.filter((p) => originals[p.key]?.[key] !== undefined).map((p) => [p.key, originals[p.key][key]])),
      })),
      note: statement === 'cashflow' && period === 'quarterly' ? 'Q2 and Q3 cash flows are year-to-date as filed (periodType "ytd"); they are not standalone quarters.' : null,
    },
    coverage: { from: outPeriods[outPeriods.length - 1].start || outPeriods[outPeriods.length - 1].end, to: outPeriods[0].end, missing: [] },
  };
}

// ---- the fixture set ------------------------------------------------------------------------------------------

export function createServerFixtures(app) {
  const today = () => app.clock.today();
  const nowIso = () => app.clock.now().toISOString();
  const modes = new Map(Object.entries(app.data.getSetting('demo.serverFixtures', {}) || {}));
  const save = () => app.data.setSetting('demo.serverFixtures', Object.fromEntries(modes));
  const symOf = (inst) => inst?.symbol || null;
  const instBySym = (sym) => app.instruments.list({ q: sym, limit: 20 }).find((i) => i.symbol === sym) || null;
  const daysAgo = (n) => addDays(today(), -n);

  function idsOf(inst) {
    if (!inst) return null;
    const sym = inst.symbol || inst.id;
    const slug = String(sym).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const company = COMPANIES[sym];
    const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
    return {
      terminal: inst.id,
      server: `fixture-ins-${slug}`,
      issuer: company?.issuer.id ?? (und && COMPANIES[und.symbol] ? COMPANIES[und.symbol].issuer.id : null),
      contract: ['option', 'future'].includes(inst.family) ? `fixture-ctr-${slug}` : null,
    };
  }
  function resolveServerId(serverId) {
    for (const i of app.instruments.list({ limit: 2000 })) if (idsOf(i).server === serverId) return i;
    return null;
  }
  const underlyingLink = (inst) => {
    const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
    return und ? { underlying: { terminalId: und.id, symbol: und.symbol, ids: idsOf(und), note: `Issuer data belongs to the underlying ${und.symbol}, not to this contract.` } } : null;
  };
  const quoteConvention = (inst) => ({ equity: 'per share', fund: 'per unit', crypto: 'per coin', bond: '% of par (clean)', future: inst.terms?.priceUnits || 'index points', option: 'premium per share', fx: `${inst.terms?.quote} per ${inst.terms?.base}` }[inst.family] || 'per unit');

  function referenceOf(inst) {
    const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
    const company = COMPANIES[inst.symbol];
    return {
      ids: idsOf(inst), symbol: inst.symbol, name: inst.name, productType: inst.product_id, family: inst.family, venue: inst.venue, currency: inst.trading_ccy,
      quoteConvention: quoteConvention(inst), units: quoteConvention(inst), multiplier: inst.multiplier ?? null,
      underlying: und ? { ids: idsOf(und), symbol: und.symbol, name: und.name } : null,
      issuer: company ? { id: company.issuer.id, name: company.issuer.name } : und && COMPANIES[und.symbol] ? { id: COMPANIES[und.symbol].issuer.id, name: COMPANIES[und.symbol].issuer.name, via: 'underlying' } : null,
      listing: company?.listing ? { exchange: company.listing.exchange, symbol: company.listing.symbol, currency: company.listing.currency } : null,
      terms: inst.terms || {}, updatedAt: iso(daysAgo(3)),
    };
  }

  // ---- base providers (built-in behaviour) ----
  const P = {
    async search(c, p) {
      const q = String(p.q || '').trim().toLowerCase();
      const all = app.instruments.list({ limit: 2000 }).filter((i) => i.ref_source === 'demo' || COMPANIES[i.symbol]);
      const hits = all.filter((i) => !q || i.symbol?.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || idsOf(i).server.includes(q));
      const pageSize = Math.min(Number(c.pageSize) || 8, 50);
      const page = Math.max(1, Number(c.page) || 1);
      const totalPages = Math.max(1, Math.ceil(hits.length / pageSize));
      const items = hits.slice((page - 1) * pageSize, page * pageSize).map((i) => ({ ids: idsOf(i), symbol: i.symbol, name: i.name, productType: i.product_id, family: i.family, venue: i.venue, currency: i.trading_ccy, issuerName: COMPANIES[i.symbol]?.issuer.name ?? null, registered: true }));
      return { items, page, pageSize, totalPages, totalItems: hits.length, asOf: nowIso(), source: SRC };
    },
    async reference(c, p) {
      const inst = p.instrument || resolveServerId(p.serverId);
      if (!inst) return { data: null, message: 'No reference record for this ID in the demo fixtures.' };
      return { data: referenceOf(inst), asOf: iso(daysAgo(3)), source: SRC };
    },
    async quotes(c, p) {
      await app.data.refresh({ instruments: p.instruments });
      const items = p.instruments.map((i) => {
        const o = app.data.price(i.id);
        if (!o) return { instrumentId: i.id, ids: idsOf(i), quoteType: null, bid: null, ask: null, last: null, mid: null, currency: i.trading_ccy, units: quoteConvention(i), timestamp: null, status: null, nulls: { last: 'No quote from the demo feed for this instrument' } };
        const mid = o.bid !== null && o.ask !== null ? (o.bid + o.ask) / 2 : null;
        return {
          instrumentId: i.id, ids: idsOf(i), quoteType: o.bid !== null && o.ask !== null ? 'bid-ask' : 'last', bid: o.bid, ask: o.ask, last: o.value, mid,
          bidSize: o.bidSize, askSize: o.askSize, prevClose: o.prevClose, change: null, changePct: null, nulls: { change: 'Not supplied by the demo feed', changePct: 'Not supplied by the demo feed' },
          currency: o.currency || i.trading_ccy, units: o.units || quoteConvention(i), quoteConvention: quoteConvention(i), timestamp: o.asOf, status: o.status === 'simulated' ? 'simulated' : o.status, delayMinutes: o.delayMinutes, source: o.source,
        };
      });
      const stamps = items.map((x) => x.timestamp).filter(Boolean).sort();
      return { items, asOf: stamps[0] || null, source: FEED };
    },
    async history(c, p) {
      const inst = p.instrument;
      if (p.interval && p.interval !== '1d') return { items: [], coverage: { from: p.from || null, to: p.to || null, missing: [`interval ${p.interval}`] }, message: `The demo fixture supplies daily bars only; interval ${p.interval} is unavailable.` };
      if (p.adjusted) return { items: [], coverage: { from: p.from || null, to: p.to || null, missing: ['adjusted series'] }, message: 'The demo feed supplies an unadjusted series only. An adjusted series is not manufactured.', data: { adjusted: true, available: false } };
      const h = await app.data.market.history(inst, { from: p.from, to: p.to, interval: '1d' });
      if (!h.available) return { items: [], message: h.message };
      let bars = h.bars;
      const missing = [];
      // KAIJ: a coverage gap of five business days in the middle of the range, stated, not filled.
      if (inst.symbol === 'KAIJ' && bars.length > 30) {
        const gap = bars.slice(Math.floor(bars.length / 2), Math.floor(bars.length / 2) + 5);
        missing.push(`${gap[0].date}..${gap[gap.length - 1].date} (no bars from the source)`);
        const drop = new Set(gap.map((b) => b.date));
        bars = bars.filter((b) => !drop.has(b.date));
      }
      // A failing corporate-actions source (KAIJ's built-in server error) leaves the bars served, without annotations, and says so.
      let ca = [];
      try { ca = (await P.corporateActions(c, { instrument: inst })).items || []; } catch { missing.push('corporate-action annotations (the corporate-actions source answered with an error)'); }
      const seenEv = new Set();
      const annotations = ca.filter((x) => !seenEv.has(x.eventId) && seenEv.add(x.eventId)).filter((x) => bars.length && x.exDate >= bars[0].date && x.exDate <= bars[bars.length - 1].date).map((x) => ({ date: x.exDate, type: x.type, label: x.type === 'cash_dividend' ? `Dividend ${x.amount} ${x.currency}` : x.type === 'split' ? `Split ${x.ratio.num}:${x.ratio.den}` : x.type, amount: x.amount ?? null, ratio: x.ratio ?? null }));
      return {
        items: bars.map((b) => ({ t: b.t, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
        data: { adjusted: false, adjustmentBasis: 'Unadjusted (as traded). Dividends and splits are annotated, not applied.', currency: h.currency, units: quoteConvention(inst), interval: '1d', annotations },
        coverage: { from: bars[0]?.date ?? null, to: bars[bars.length - 1]?.date ?? null, missing },
        // A range that ends before today is complete as delivered; a range to today is as fresh as its last bar.
        asOf: p.to && p.to < today() ? nowIso() : bars[bars.length - 1]?.t ?? null, source: FEED,
      };
    },
    async fx(c, p) {
      await app.data.refresh({ pairs: p.pairs });
      const items = p.pairs.map((pair) => {
        const [base, quote] = pair.split('/');
        const q = app.data.fx(base, quote);
        return { pair, base, quote, rate: q?.rate ?? null, bid: q?.obs?.bid ?? null, ask: q?.obs?.ask ?? null, direction: `${quote} per 1 ${base}`, timestamp: q?.obs?.asOf ?? null, status: q?.obs?.status ?? null, nulls: q ? {} : { rate: 'No rate from the demo feed for this pair' } };
      });
      return { items, asOf: items.map((x) => x.timestamp).filter(Boolean).sort()[0] || null, source: FEED };
    },
    async rates(c, p) {
      const m = await app.data.market.rates(p.codes, { from: p.from, to: p.to });
      const items = p.codes.flatMap((code) => (m.get(code) || []).map((o) => ({ code, date: o.forDate, value: o.value, units: o.units })));
      return { items, asOf: items.length ? iso(items[items.length - 1].date) : null, source: FEED };
    },
    async profile(c, p) {
      const inst = p.instrument;
      const company = COMPANIES[inst.symbol];
      if (!company) return { data: null, related: underlyingLink(inst), message: inst.underlying_id ? 'This contract has no issuer profile of its own; see the underlying.' : 'No company profile for this instrument in the demo fixtures.' };
      const next = nextEarnings(inst.symbol);
      return {
        data: { issuer: company.issuer, listing: company.listing ? { ...company.listing, sharesOutstandingAsOf: daysAgo(40), marketCapAsOf: daysAgo(1) } : null, highlights: company.highlights, nextEarnings: next ? { date: next.releaseAt.slice(0, 10), dateStatus: next.dateStatus } : null },
        missingFields: company.listing ? [] : ['listing (an issuer with no listed equity)'],
        nulls: company.listing ? {} : { listing: 'A sovereign issuer has no equity listing' },
        asOf: iso(daysAgo(1)), source: SRC,
      };
    },
    async statements(c, p) {
      const inst = p.instrument;
      const company = COMPANIES[inst.symbol];
      if (!company) return { data: null, related: underlyingLink(inst), message: inst.underlying_id ? 'Financial statements belong to the underlying issuer, not to this contract.' : 'No financial statements for this instrument in the demo fixtures.' };
      if (!company.stmt) return { data: null, message: 'The demo fixtures hold no financial statements for this issuer.' };
      const period = p.period || 'quarterly';
      if (period === 'quarterly' && !company.stmt.quarterly) return { data: null, coverage: { from: null, to: null, missing: ['quarterly statements'] }, message: 'Only annual statements are supplied for this issuer.' };
      const asOfDate = c.asOf ? String(c.asOf).slice(0, 10) : null;
      const out = buildStatement(inst.symbol, company.stmt, { statement: p.statement || 'income', period, periods: Number(p.periods) || 12, today: today(), asOf: asOfDate });
      return { ...out, asOf: asOfDate ? iso(asOfDate) : iso(daysAgo(2)), source: SRC, pointInTime: asOfDate ? { supported: true, note: 'As filed on the date: later restatements are not applied.' } : undefined };
    },
    async earnings(c, p) {
      const inst = p.instrument;
      const items = earningsOf(inst.symbol, c.asOf ? String(c.asOf).slice(0, 10) : null);
      if (!items) return { items: [], related: underlyingLink(inst), message: 'No earnings data for this instrument in the demo fixtures.' };
      return { items, asOf: nowIso(), source: SRC };
    },
    async filings(c, p) {
      const inst = p.instrument;
      if (inst.symbol === 'KAIJ') throw new GatewayError('Demo fixture: the gateway refused access to this issuer\'s documents (HTTP 403).', { status: 403 });
      const all = filingsOf(inst.symbol).filter((f) => !c.asOf || f.filedAt.slice(0, 10) <= String(c.asOf).slice(0, 10));
      if (!all.length) return { items: [], related: underlyingLink(inst), message: 'No filings for this instrument in the demo fixtures.' };
      const pageSize = Math.min(Number(c.pageSize) || 10, 50);
      const start = c.cursor ? Number(String(c.cursor).replace('fixture-cursor-', '')) || 0 : 0;
      const items = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? `fixture-cursor-${start + pageSize}` : null;
      return { items, cursor: c.cursor || null, nextCursor: next, pageSize, totalItems: all.length, asOf: nowIso(), source: SRC };
    },
    async document(c, p) {
      const pdf = /^fixture-doc-([a-z0-9]+)-(\d+)-pdf$/.exec(p.docId || '');
      if (pdf) {
        const filing = filingsOf(pdf[1].toUpperCase()).find((x) => x.id === `fixture-fil-${pdf[1]}-${pdf[2]}`);
        if (!filing) return null;
        return { mediaType: 'application/pdf', filename: `${p.docId}.pdf`, body: fixturePdf([`Demo fixture document (PDF). Fictional content; not a real filing and not Shaffer data.`, `${filing.title}, ${pdf[1].toUpperCase()} (demo), filed ${filing.filedAt.slice(0, 10)}.`]) };
      }
      const m = /^fixture-doc-([a-z0-9]+)-(\d+)-(\d+)$/.exec(p.docId || '');
      if (!m) return null;
      const sym = m[1].toUpperCase();
      if (!COMPANIES[sym]) return null;
      const filing = filingsOf(sym).find((x) => x.id === `fixture-fil-${m[1]}-${m[2]}`);
      const f = filing || { title: 'Earnings document (demo fixture)', period: null, filedAt: iso(today()) };
      const d = filing?.documents.find((x) => x.id === p.docId) || { title: m[3] === '1' ? 'Earnings presentation' : 'Earnings release' };
      const body = `<!doctype html><meta charset="utf-8"><title>${d.title} (Demo fixture)</title><body style="font-family:sans-serif;max-width:720px;margin:2rem auto"><p><strong>Demo fixture document.</strong> Fictional content for the demo; not a real filing and not Shaffer data.</p><h1>${f.title}</h1><p>Issuer: ${m[1].toUpperCase()} (demo). Period: ${f.period || 'n/a'}. Filed: ${f.filedAt.slice(0, 10)}.</p><h2>${d.title}</h2><p>This page stands in for a document the Shaffer gateway will stream once the contract is supplied.</p></body>`;
      return { mediaType: 'text/html; charset=utf-8', filename: `${p.docId}.html`, body };
    },
    async corporateActions(c, p) {
      const inst = p.instrument;
      if (inst.symbol === 'KAIJ') throw new GatewayError('Demo fixture: server error (HTTP 500).', { status: 500 });
      const items = corporateActionsOf(inst);
      return { items, asOf: iso(daysAgo(1)), source: SRC, message: items.length ? null : 'No corporate actions for this instrument in the demo fixtures.' };
    },
    async news(c, p) {
      const inst = p.instrument;
      if (inst.symbol === 'BRVO') await sleepFor(1500, c.signal);
      const all = newsOf(inst.symbol).filter((n) => !c.asOf || n.publishedAt <= new Date(c.asOf).toISOString());
      if (!all.length) return { items: [], message: 'No news for this instrument in the demo fixtures.' };
      const pageSize = Math.min(Number(c.pageSize) || 10, 50);
      const page = Math.max(1, Number(c.page) || 1);
      const totalPages = Math.ceil(all.length / pageSize);
      return { items: all.slice((page - 1) * pageSize, page * pageSize), page, pageSize, totalPages, totalItems: all.length, asOf: nowIso(), source: SRC };
    },
    async instrumentAnalytics(c, p) {
      const inst = p.instrument;
      if (p.strategyId && p.strategyId !== SP3E_FIXTURE_STRATEGY.id) return { data: null, message: `No analytics for Strategy ${p.strategyId} in the demo fixtures (fixture Strategy: ${SP3E_FIXTURE_STRATEGY.id}).` };
      const runs = runsOf(inst.symbol, c.asOf);
      if (!runs.length) return { data: null, message: inst.family === 'equity' ? 'No SP3E run for this instrument in the demo fixtures.' : 'SP3E covers equities; no analytics for this instrument.' };
      const chosen = p.runId ? runs.find((r) => r.runId === p.runId) : runs[0];
      if (!chosen) return { data: null, message: `Run ${p.runId} not found.` };
      const latest = runsOf(inst.symbol, null)[0];
      const { nulls, ageDays, cutoffDays, ...rest } = chosen;
      const data = { strategyId: SP3E_FIXTURE_STRATEGY.id, strategyName: SP3E_FIXTURE_STRATEGY.name, ...rest, calculatedAt: chosen.calculatedAt, inputCutoff: chosen.inputCutoff, historical: chosen.runId !== latest.runId, current: chosen.runId === latest.runId, availability: 'completed' };
      return { data, nulls: nulls || {}, missingFields: Object.keys(nulls || {}), asOf: chosen.calculatedAt, version: chosen.version, source: SRC };
    },
    async runs(c, p) {
      const all = runsOf(p.instrument.symbol, null);
      const latest = all[0]?.runId;
      const items = runsOf(p.instrument.symbol, c.asOf).map((r) => ({ runId: r.runId, version: r.version, calculatedAt: r.calculatedAt, inputCutoff: r.inputCutoff, horizon: r.horizon, historical: r.runId !== latest, current: r.runId === latest }));
      return { items, asOf: items[0]?.calculatedAt ?? null, source: SRC };
    },
    async earningsWindow(c, p) {
      const sym = p.instrument.symbol;
      const next = nextEarnings(sym);
      if (!next || !ANALYTICS[sym]) return { data: null, message: 'No earnings-window assessment for this instrument in the demo fixtures.' };
      const d = next.releaseAt.slice(0, 10);
      const from = addDays(d, -10), to = addDays(d, 2);
      const inside = today() >= from && today() <= to;
      const run = runsOf(sym, null)[0];
      return { data: { eligible: sym === 'KAIJ' ? false : !inside, window: { from, to }, reason: sym === 'KAIJ' ? 'Inside the earnings window (Analytics Lab rule, demo fixture)' : inside ? 'Inside the earnings window' : 'Outside the earnings window', basis: `Next earnings ${d} (${next.dateStatus})`, runId: run.runId, calculatedAt: run.calculatedAt }, asOf: run.calculatedAt, source: SRC };
    },
    // ---- p1: product-specific datasets (literal fictional values; nothing here is computed from a price) ----
    async ratingsCovenants(c, p) {
      const inst = p.instrument;
      const rec = RATINGS[inst.symbol];
      if (!rec) return { data: null, message: inst.family === 'bond' ? 'No ratings or covenants for this issue in the demo fixtures.' : 'Ratings and covenants apply to debt instruments and their issuers.' };
      const cut = c.asOf ? String(c.asOf).slice(0, 10) : null;
      const ratings = rec.ratings.map((r) => ({ ...r, ratedAt: daysAgo(r.daysAgo) })).filter((r) => !cut || r.ratedAt <= cut).map(({ daysAgo: _d, ...r }) => r);
      if (!ratings.length) return { data: null, message: `No rating was in force on ${cut} in the demo fixtures.` };
      return { data: { scope: rec.scope, ratedEntity: rec.ratedEntity, ratings, covenants: rec.covenants.map((x) => ({ ...x, asOf: daysAgo(40) })), covenantsNote: rec.covenantsNote || null }, asOf: iso(daysAgo(1)), source: SRC, pointInTime: cut ? { supported: true, note: 'Ratings in force on the date' } : undefined };
    },
    async yieldSpread(c, p) {
      const rec = YIELDS[p.instrument.symbol];
      if (!rec) return { data: null, message: 'No yield or spread for this instrument in the demo fixtures.' };
      const stamp = iso(daysAgo(1), '20:00:00');
      return { data: { ...structuredClone(rec), priceUsed: { ...rec.priceUsed, timestamp: stamp }, calculatedAt: stamp, provider: 'Shaffer MarketData (demo fixture)' }, nulls: rec.nulls || {}, asOf: stamp, source: SRC };
    },
    async optionGreeks(c, p) {
      const inst = p.instrument;
      if (!['option', 'otcoption'].includes(inst.family)) return { data: null, message: 'Greeks apply to option contracts.' };
      const g = GREEKS[inst.terms?.right === 'P' ? 'P' : 'C'];
      const stamp = new Date(app.clock.ms() - 15 * 60e3).toISOString();
      return { data: { ...structuredClone(g), calculatedAt: stamp, provider: 'Shaffer MarketData (demo fixture)', note: 'Illustrative fixture values, the same for every demo call (or put): not calculated for this contract.' }, nulls: { rho: 'Not supplied by the demo fixture' }, asOf: stamp, source: SRC };
    },
    async futuresCurve(c, p) {
      const inst = p.instrument;
      if (inst.family !== 'future' || !inst.underlying_id) return { items: [], message: 'No futures curve for this instrument in the demo fixtures.' };
      const months = app.instruments.list({ underlyingId: inst.underlying_id, family: 'future', limit: 200 }).filter((f) => !f.terms?.perpetual && f.terms?.expiration).sort((a, b) => (a.terms.expiration < b.terms.expiration ? -1 : 1));
      await app.data.refresh({ instruments: months });
      const items = months.map((f) => {
        const o = app.data.price(f.id);
        return { contractMonth: f.terms.expiration.slice(0, 7), expiration: f.terms.expiration, symbol: f.symbol, ids: idsOf(f), price: o?.value ?? null, priceType: 'last', units: f.terms.priceUnits || 'index points', currency: f.trading_ccy, timestamp: o?.asOf ?? null, openInterest: null, volume: null };
      });
      return { items, nulls: { openInterest: 'Not supplied by the demo feed', volume: 'Not supplied by the demo feed' }, asOf: items.map((x) => x.timestamp).filter(Boolean).sort()[0] || null, source: FEED };
    },
    async exchangeMargin(c, p) {
      const inst = p.instrument;
      const m = MARGINS[inst.terms?.root];
      if (inst.family !== 'future' || !m) return { data: null, message: 'No exchange margin for this contract in the demo fixtures.' };
      return { data: { ...m, currency: inst.trading_ccy, effectiveDate: daysAgo(6), perContract: true }, asOf: iso(daysAgo(6), '22:00:00'), source: SRC };
    },
    async fundHoldings(c, p) {
      const inst = p.instrument;
      if (inst.family !== 'fund') return { items: [], message: 'Holdings apply to funds.' };
      const holdingsDate = addDays(`${today().slice(0, 7)}-01`, -1); // last day of the previous month
      const cut = c.asOf ? String(c.asOf).slice(0, 10) : null;
      if (cut && cut < holdingsDate) return { items: [], message: `The demo fixtures hold no holdings report dated on or before ${cut}.`, pointInTime: { supported: true, note: 'Holdings as reported on or before the date' } };
      return { items: FUND_HOLDINGS.map((h) => ({ ...h, holdingsDate, currency: inst.trading_ccy })), data: { holdingsDate, holdingsCount: 214, coveragePct: 46.3, currency: inst.trading_ccy }, asOf: iso(holdingsDate), source: SRC, pointInTime: cut ? { supported: true, note: 'Holdings as reported on or before the date' } : undefined };
    },
    async fundFacts(c, p) {
      const inst = p.instrument;
      if (inst.family !== 'fund') return { data: null, message: 'Fund facts apply to funds.' };
      await app.data.refresh({ instruments: [inst] });
      const o = app.data.price(inst.id);
      return {
        data: { nav: o?.value ?? null, navCurrency: inst.trading_ccy, navDate: o?.forDate || (o?.asOf ? String(o.asOf).slice(0, 10) : null), shareClass: 'Investor class (demo fixture)', fees: { ...FUND_FEES, asOf: daysAgo(120) }, distributionPolicy: 'Income distributed quarterly (demo fixture)', netAssets: null },
        nulls: { netAssets: 'Not supplied by the demo fixture', ...(o ? {} : { nav: 'No NAV from the demo feed for this fund', navDate: 'No NAV from the demo feed for this fund' }) },
        missingFields: o ? [] : ['nav', 'navDate'], asOf: o?.asOf ?? iso(daysAgo(1)), source: SRC,
      };
    },
    async otcMarks(c, p) {
      const inst = p.instrument;
      if (!['swap', 'cds', 'forward', 'otcoption'].includes(inst.family)) return { items: [], message: 'Supplied marks apply to OTC contracts.' };
      const cut = c.asOf ? String(c.asOf).slice(0, 10) : null;
      const items = OTC_MARKS.map((m) => ({ ...m, date: daysAgo(m.daysAgo), timestamp: iso(daysAgo(m.daysAgo), m.kind === 'clearing' ? '22:30:00' : '21:15:00'), units: inst.family === 'otcoption' || inst.family === 'forward' ? 'per unit (as quoted for the contract)' : 'NPV per 100 notional' }))
        .filter((m) => !cut || m.date <= cut).map(({ daysAgo: _d, ...m }) => m);
      return { items, asOf: items[0]?.timestamp ?? null, source: SRC, message: items.length ? null : 'No supplied marks on or before that date.', pointInTime: cut ? { supported: true, note: 'Marks struck on or before the date' } : undefined };
    },
    async fxCurve(c, p) {
      const inst = p.instrument;
      const rec = inst.family === 'fx' ? FX_CURVES[`${inst.terms?.base}/${inst.terms?.quote}`] : null;
      if (!rec) return { items: [], message: 'No forward curve for this instrument in the demo fixtures.' };
      const stamp = iso(today(), '12:00:00');
      return { items: rec.points.map(([tenor, days, pts, outright]) => ({ tenor, valueDate: addDays(today(), days), forwardPoints: pts, pointsUnits: rec.pointsUnits, outright: outright ?? null, timestamp: stamp })), data: { pair: `${inst.terms.base}/${inst.terms.quote}`, spotReference: rec.spotReference, note: rec.note }, nulls: rec.nulls || {}, asOf: stamp, source: SRC };
    },
  };

  // ---- fixture records relative to the clock ----
  function runsOf(sym, asOf) {
    const cut = asOf ? new Date(asOf).toISOString() : null;
    return (ANALYTICS[sym] || []).map((r) => ({ ...r, calculatedAt: iso(daysAgo(r.ageDays), '06:00:00'), inputCutoff: iso(daysAgo(r.cutoffDays), '21:00:00') }))
      .filter((r) => !cut || r.calculatedAt <= cut);
  }
  function earningsOf(sym, asOf) {
    const company = COMPANIES[sym];
    if (!company?.stmt) return null;
    const qs = pastQuarters(today(), 8);
    const seasonal = [1.0, 0.97, 1.02, 1.08];
    const items = qs.map((q, i) => {
      const v = quarterValues(company.stmt, 8 - i, seasonal[q.q - 1]);
      const release = addDays(q.end, 28);
      const consensusEps = r2(v.epsDiluted * 0.97), consensusRev = r1(v.revenue * 1.004);
      const prior = quarterValues(company.stmt, 4 - i, seasonal[q.q - 1]);
      return {
        fiscalPeriod: `${q.fy} Q${q.q}`, periodEnd: q.end, releaseAt: iso(release, '20:05:00'), dateStatus: 'confirmed', reportedAt: iso(release, '20:07:12'),
        metrics: [
          { key: 'revenue', label: 'Revenue', reported: v.revenue, consensus: consensusRev, prior: prior.revenue, surprise: r1(v.revenue - consensusRev), surprisePct: r2(((v.revenue - consensusRev) / Math.abs(consensusRev)) * 100), units: 'millions', currency: company.stmt.ccy },
          { key: 'epsDiluted', label: 'EPS, diluted', reported: v.epsDiluted, consensus: consensusEps, prior: prior.epsDiluted, surprise: r2(v.epsDiluted - consensusEps), surprisePct: consensusEps ? r2(((v.epsDiluted - consensusEps) / Math.abs(consensusEps)) * 100) : null, units: `${company.stmt.ccy} per share`, currency: company.stmt.ccy },
        ],
        revision: i === 2 ? 'revised' : 'original', revisedAt: i === 2 ? iso(addDays(release, 21)) : null, revisionNote: i === 2 ? 'Consensus revised after the release (demo fixture)' : null,
        documents: [{ id: `fixture-doc-${sym.toLowerCase()}-${i}-0`, title: 'Earnings release', kind: 'release' }, { id: `fixture-doc-${sym.toLowerCase()}-${i}-1`, title: 'Earnings presentation', kind: 'presentation' }],
        source: 'Demo fixture',
      };
    }).filter((e) => !asOf || e.releaseAt.slice(0, 10) <= asOf);
    const next = nextEarnings(sym);
    if (next && (!asOf || asOf >= today())) items.unshift(next);
    return items;
  }
  function nextEarnings(sym) {
    const company = COMPANIES[sym];
    if (!company?.stmt) return null;
    const last = pastQuarters(today(), 1)[0];
    let ny = last.fy, nq = last.q + 1;
    if (nq === 5) { nq = 1; ny += 1; }
    const end = `${ny}-${String(nq * 3).padStart(2, '0')}-${[31, 30, 30, 31][nq - 1]}`;
    let release = addDays(end, 28);
    if (release <= today()) release = addDays(today(), 9);
    return {
      fiscalPeriod: `${ny} Q${nq}`, periodEnd: end, releaseAt: iso(release, '20:05:00'), dateStatus: sym === 'BRVO' ? 'confirmed' : 'estimated', reportedAt: null,
      metrics: [{ key: 'revenue', label: 'Revenue', reported: null, consensus: null, prior: null, surprise: null, surprisePct: null, units: 'millions', currency: company.stmt.ccy }, { key: 'epsDiluted', label: 'EPS, diluted', reported: null, consensus: null, prior: null, surprise: null, surprisePct: null, units: `${company.stmt.ccy} per share`, currency: company.stmt.ccy }],
      nulls: { reported: 'Not yet reported', consensus: 'Consensus not supplied by the demo fixture' }, revision: 'original', revisedAt: null, documents: [], source: 'Demo fixture',
    };
  }
  function filingsOf(sym) {
    if (!COMPANIES[sym]?.stmt && sym !== 'SIMGOV31') return [];
    const n = sym === 'ALFA' ? 23 : sym === 'SIMGOV31' ? 2 : 6;
    const kinds = [['annual-report', 'Annual report'], ['interim-report', 'Interim report'], ['earnings-release', 'Earnings release'], ['presentation', 'Investor presentation'], ['interim-report', 'Interim report'], ['earnings-release', 'Earnings release']];
    const slug = sym.toLowerCase();
    return Array.from({ length: n }, (_, i) => {
      const [kind, title] = sym === 'SIMGOV31' ? ['offering-document', 'Offering circular'] : kinds[i % kinds.length];
      const filed = addDays(today(), -(12 + i * 31));
      const documents = [{ id: `fixture-doc-${slug}-${i}-0`, title: `${title} document`, mediaType: 'text/html', pages: 1 + (i % 4) }];
      // One PDF document (ALFA's second filing), for the sandboxed viewer and the new-tab path (i1).
      if (sym === 'ALFA' && i === 1) documents.push({ id: `fixture-doc-${slug}-${i}-pdf`, title: `${title} (PDF) document`, mediaType: 'application/pdf', pages: 1 });
      return { id: `fixture-fil-${slug}-${i}`, kind, title: `${title} (demo fixture)`, filedAt: iso(filed, '13:30:00'), period: `${filed.slice(0, 4)}`, source: 'Demo fixture', documents };
    });
  }
  function corporateActionsOf(inst) {
    const sym = inst.symbol;
    const items = [];
    if (sym === 'ALFA') {
      // Quarterly dividends: 0.55 per share. The most recent past one is delivered twice (same event ID).
      const exDates = [-250, -159, -68, 23].map((d) => addDays(today(), d));
      exDates.forEach((ex, i) => {
        const ev = { eventId: `fixture-ca-alfa-div-${ex}`, type: 'cash_dividend', exDate: ex, recordDate: addDays(ex, 1), payDate: addDays(ex, 14), amount: 0.55, currency: 'USD', ratio: null, terms: 'Regular quarterly cash dividend', status: ex > today() ? 'announced' : 'completed', announcedAt: iso(addDays(ex, -30)), source: 'Demo fixture' };
        items.push(ev);
        if (i === 2) items.push({ ...ev, deliveryNote: 'Duplicate delivery of the same event (demo fixture)' });
      });
      items.push({ eventId: 'fixture-ca-alfa-buyback-1', type: 'buyback', exDate: addDays(today(), -120), recordDate: null, payDate: null, amount: null, currency: 'USD', ratio: null, terms: 'Share repurchase programme up to USD 2.0 billion over 24 months', status: 'active', announcedAt: iso(addDays(today(), -120)), source: 'Demo fixture' });
    }
    if (sym === 'BRVO') items.push({ eventId: 'fixture-ca-brvo-split-1', type: 'split', exDate: addDays(today(), -200), recordDate: null, payDate: null, amount: null, currency: 'USD', ratio: { num: 2, den: 1 }, terms: '2-for-1 stock split', status: 'completed', announcedAt: iso(addDays(today(), -240)), source: 'Demo fixture' });
    return items;
  }
  function newsOf(sym) {
    if (sym !== 'ALFA' && sym !== 'BRVO') return [];
    const n = sym === 'ALFA' ? 25 : 4;
    const scopes = ['company', 'company', 'sector', 'economy', 'company'];
    return Array.from({ length: n }, (_, i) => {
      const scope = scopes[i % scopes.length];
      const at = new Date(app.clock.ms() - (i * 19 + 2) * 3600e3).toISOString();
      return {
        id: `fixture-news-${sym.toLowerCase()}-${i}`, publishedAt: at, receivedAt: at, source: 'Demo fixture newswire', scope,
        headline: scope === 'company' ? `${sym} (demo) ${['announces supplier agreement', 'updates investor calendar', 'opens new plant', 'names new CFO', 'completes acquisition'][i % 5]}` : scope === 'sector' ? 'Demo sector: order volumes reported for the month' : 'Demo economy: monthly inflation figure released',
        summary: 'Fictional item for the demo. Not real news.',
        facts: scope === 'economy' ? [{ label: 'Monthly inflation (demo)', value: 0.2, units: 'percent' }] : [],
        classification: { by: 'Shaffer MarketData (demo fixture)', labels: [scope === 'company' ? 'corporate' : scope, i % 4 === 0 ? 'material' : 'routine'] },
        interpretation: i % 3 === 0 ? { by: 'Shaffer Analytics Lab (demo fixture)', text: 'Interpretation supplied by the server; shown apart from the facts.' } : null,
      };
    });
  }

  // ---- modes ----
  const pointInTimeSets = new Set(['statements', 'earnings', 'filings', 'news', 'analytics', 'analyticsRuns', 'ratingsCovenants', 'fundHoldings', 'otcMarks']);
  const methodOf = (ds) => SERVER_DATASETS[ds].method;

  function applyPartial(ds, res) {
    const def = SERVER_DATASETS[ds];
    if (def.shape === 'items') {
      const items = res.items || [];
      return { ...res, items: items.slice(0, Math.max(1, Math.ceil(items.length / 2))), missingFields: ['items (partial response: some records missing)'], coverage: { ...(res.coverage || {}), missing: [...(res.coverage?.missing || []), 'part of the requested records'] } };
    }
    if (!res.data) return res;
    const data = structuredClone(res.data);
    const nulls = { ...(res.nulls || {}) };
    const missing = [...(res.missingFields || [])];
    for (const f of def.requires.filter((x) => !x.includes('[]')).slice(-2)) {
      const parts = f.split('.');
      let o = data;
      for (const k of parts.slice(0, -1)) o = o && typeof o[k] === 'object' ? o[k] : null;
      if (!o) continue;
      o[parts[parts.length - 1]] = null;
      nulls[f] = 'Not supplied in this (partial) response';
      missing.push(f);
    }
    if (ds === 'statements' && data.lines?.length) {
      const k = data.periods[0].key;
      for (const l of data.lines.slice(-3)) { l.values[k] = null; l.nulls = { ...(l.nulls || {}), [k]: 'Not reported in this (partial) response' }; }
      missing.push(`lines (${data.lines.slice(-3).map((l) => l.key).join(', ')}) for ${k}`);
    }
    return { ...res, data, nulls, missingFields: missing };
  }

  // ---- acceptance modes (i1) ----
  // revised: what a later delivery looks like after the first display. Statements: the latest period restated
  // (revenue and cost up 2 %), the originally reported values kept. Earnings: the upcoming release date moved a week
  // later and now confirmed, marked revised. Corporate actions: the dividend amount revised under the same event ID.
  // Analytics: a newer run of the same Strategy. Other datasets: unchanged.
  function applyRevised(ds, res) {
    const at = nowIso();
    if (ds === 'statements' && res.data?.periods?.length) {
      const data = structuredClone(res.data);
      const p0 = data.periods.find((p) => p.basis === 'reported' && p.periodType !== 'ttm');
      if (!p0) return res;
      const orig = {};
      for (const l of data.lines) {
        if (!['revenue', 'costOfRevenue', 'cogs'].includes(l.key) || typeof l.values[p0.key] !== 'number') continue;
        orig[l.key] = l.values[p0.key];
        l.original = { ...(l.original || {}), [p0.key]: l.values[p0.key] };
        l.values[p0.key] = r1(l.values[p0.key] * 1.02);
      }
      const gp = data.lines.find((l) => l.key === 'grossProfit'), rv = data.lines.find((l) => l.key === 'revenue'), cr = data.lines.find((l) => l.key === 'costOfRevenue');
      if (gp && rv && cr && typeof gp.values[p0.key] === 'number') { orig.grossProfit = gp.values[p0.key]; gp.original = { ...(gp.original || {}), [p0.key]: gp.values[p0.key] }; gp.values[p0.key] = r1(rv.values[p0.key] - cr.values[p0.key]); }
      Object.assign(p0, { basis: 'restated', restatedAt: at, original: { filingDate: p0.filingDate, values: orig } });
      return { ...res, data, asOf: at, message: 'Demo fixture: a restatement delivered after the first display.' };
    }
    if (ds === 'earnings' && res.items?.length) {
      const items = structuredClone(res.items);
      const up = items.find((e) => e.reportedAt === null);
      if (up) Object.assign(up, { releaseAt: new Date(new Date(up.releaseAt).getTime() + 7 * 86400e3).toISOString(), dateStatus: 'confirmed', revision: 'revised', revisedAt: at, revisionNote: 'Release date moved one week later and confirmed (demo fixture revision)' });
      return { ...res, items, asOf: at };
    }
    if (ds === 'corporateActions' && res.items?.length) {
      const items = res.items;
      const target = [...new Set(items.filter((x) => x.type === 'cash_dividend' && x.status === 'completed').map((x) => x.eventId))].slice(-1)[0];
      return { ...res, asOf: at, items: items.map((x) => (x.eventId === target ? { ...x, previous: { amount: x.amount, currency: x.currency, exDate: x.exDate, payDate: x.payDate }, amount: r2(x.amount + 0.05), revision: 'revised', revisedAt: at, revisionNote: 'Amount revised by the issuer (demo fixture revision)' } : x)) };
    }
    if (ds === 'analytics' && res.data) {
      const d = { ...res.data, runId: `${res.data.runId}-r2`, calculatedAt: at, fundamentalFairValue: typeof res.data.fundamentalFairValue === 'number' ? r1(res.data.fundamentalFairValue + 3) : res.data.fundamentalFairValue };
      return { ...res, data: d, asOf: at };
    }
    return res;
  }
  // duplicate: the first record of a list delivered twice in the same answer (same ID). Single-object datasets
  // are unchanged (delivering them twice is a second request, which the cache and the screens must absorb).
  function applyDuplicate(ds, res) {
    if (!Array.isArray(res.items) || !res.items.length) return res;
    return { ...res, items: [res.items[0], structuredClone(res.items[0]), ...res.items.slice(1)], message: 'Demo fixture: one record delivered twice.' };
  }
  // currency-mismatch / unit-mismatch: analytics with the fair value in another currency (EUR, or USD for a non-USD
  // listing) or per 100 shares; statements in another currency or in thousands where the others are in millions.
  // Statements: only the trailing-twelve-month answer is changed, so it is drawn beside quarterly / annual figures
  // that keep the statement's own currency and scale.
  function applyMismatch(ds, res, mode, params = {}) {
    if (ds === 'analytics' && res.data) {
      const d = { ...res.data };
      if (mode === 'currency-mismatch') d.fairValueCurrency = d.fairValueCurrency === 'EUR' ? 'USD' : 'EUR';
      else { d.fairValueUnits = 'per 100 shares'; for (const k of ['fundamentalFairValue', 'realisticFairValue']) if (typeof d[k] === 'number') d[k] = r1(d[k] * 100); }
      return { ...res, data: d };
    }
    if (ds === 'statements' && res.data?.lines && params.period === 'ttm') {
      const data = structuredClone(res.data);
      if (mode === 'currency-mismatch') data.currency = data.currency === 'EUR' ? 'USD' : 'EUR';
      else {
        data.units = 'thousands';
        for (const l of data.lines) {
          if (/per share|eps|shares/i.test(`${l.key} ${l.label} ${l.units || ''}`)) continue;
          l.units = 'thousands';
          for (const k of Object.keys(l.values)) if (typeof l.values[k] === 'number') l.values[k] = Math.round(l.values[k] * 1000);
        }
      }
      return { ...res, data };
    }
    return res;
  }

  function provider(ds) {
    const base = P[methodOf(ds)];
    if (!base) return null;
    return {
      source: SRC,
      pointInTime: pointInTimeSets.has(ds),
      async run(c, params) {
        const m = modes.get(ds) || { mode: 'available' };
        switch (m.mode) {
          case 'slow': await sleepFor(m.delayMs ?? 2500, c.signal); break;
          case 'error': throw new GatewayError('Demo fixture: server error (HTTP 500).', { status: 500 });
          case 'forbidden': throw new GatewayError('Demo fixture: access refused (HTTP 403).', { status: 403 });
          case 'throttled': throw Object.assign(new GatewayError('Demo fixture: too many requests (HTTP 429).', { status: 429 }), { retryAfterMs: 1000 });
          case 'offline': throw new GatewayError('Demo fixture: the Shaffer gateway cannot be reached (connection refused).', { code: 'network', retryable: true });
          case 'unavailable': return { items: [], data: null, source: SRC, message: 'Demo fixture: this dataset is unavailable from the server.' };
          case 'empty': return { items: [], data: null, source: SRC, asOf: nowIso(), message: 'Demo fixture: the server returned an empty response.' };
          default: break;
        }
        let res = await base(c, params);
        if (!res) return res;
        if (m.mode === 'stale') {
          const stale = (SERVER_DATASETS[ds].freshness.staleAfterSec || 600) * 2 + 60;
          res = { ...res, asOf: new Date(app.clock.ms() - stale * 1000).toISOString(), message: 'Demo fixture: stale response.' };
        }
        if (m.mode === 'partial') res = applyPartial(ds, res);
        if (m.mode === 'revised' && !(c.asOf && String(c.asOf).slice(0, 10) < today())) res = applyRevised(ds, res); // an as-of view before today does not see today's revision
        if (m.mode === 'duplicate') res = applyDuplicate(ds, res);
        if (m.mode === 'currency-mismatch' || m.mode === 'unit-mismatch') res = applyMismatch(ds, res, m.mode, params);
        return res;
      },
    };
  }

  return {
    provider,
    pointInTime: (ds) => pointInTimeSets.has(ds),
    pagination: (ds) => ({ search: 'page', filings: 'cursor', news: 'page' }[ds] || null),
    modeOf: (ds) => modes.get(ds) || { mode: 'available' },
    idsOf, resolveServerId, referenceOf,
    setMode(ds, mode, delayMs) {
      const list = ds === 'all' ? Object.keys(SERVER_DATASETS).filter((k) => SERVER_DATASETS[k].interface !== 'ledger') : [ds];
      for (const d of list) {
        if (!SERVER_DATASETS[d] || SERVER_DATASETS[d].interface === 'ledger') throw new AppError(`Unknown fixture dataset "${d}".`, { status: 404 });
        if (!FIXTURE_MODES.includes(mode)) throw new AppError(`Unknown fixture mode "${mode}". Use ${FIXTURE_MODES.join(', ')}.`);
        if (mode === 'available') modes.delete(d); else modes.set(d, { mode, delayMs: mode === 'slow' ? Math.min(Math.max(Number(delayMs) || 2500, 50), 30000) : undefined });
        app.data.server.clearAuthBlocks(d);
        app.data.server.invalidate({ dataset: d });
      }
      save();
      return this.list();
    },
    reset() {
      modes.clear();
      save();
      app.data.server.clearAuthBlocks();
      app.data.server.invalidate();
      return this.list();
    },
    list: () => ({
      source: SRC.label, note: NOTE, modes: Object.fromEntries(Object.keys(SERVER_DATASETS).filter((k) => SERVER_DATASETS[k].interface !== 'ledger').map((k) => [k, modes.get(k) || { mode: 'available' }])),
      availableModes: FIXTURE_MODES, strategy: SP3E_FIXTURE_STRATEGY,
      builtInCases: [
        'ALFA statements: restated quarter (original kept), YTD cash-flow quarters, TTM; as-of view applies restatements only after their date',
        'ALFA earnings: upcoming estimated date, one revised quarter; BRVO upcoming confirmed date',
        'ALFA filings (cursor pages of 10) and news (page shape, pages of 10)',
        'ALFA corporate actions: one dividend delivered twice (same event ID)',
        'ALFA analytics: two SP3E runs, the older one historical; BRVO partial; KAIJ in JPY',
        'BRVO statements: annual only; SIMGOV31: issuer only',
        'KAIJ filings: 403; KAIJ corporate actions: server error; BRVO news: slow (1.5 s); KAIJ news: empty',
        'Options and futures: no issuer data of their own; `related.underlying` links to the underlying',
        'p1: SIMCORP29 / SIMGOV31 ratings (one on review) and covenants (none for the sovereign), yield and spread (SIMGOV31 has no spread: benchmark); options: illustrative Greeks (rho not supplied, shown as missing); futures: curve from the demo feed across registered months, exchange margin for S5 and SKJ; funds: top-10 holdings and fees; OTC contracts: dealer, clearing and model marks; EUR/USD and USD/JPY forward points',
      ],
    }),
    _days: (a, b) => diffDays(a, b),
  };
}
