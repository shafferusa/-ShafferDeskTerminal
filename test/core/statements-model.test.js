// Financial statements period handling (web/views/tabs/statements-model.js), on hand-made statement answers in the
// shape of docs/SERVER-CLIENT.md (GET /api/server/statements/:id). Expected values are worked out by hand in comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  annualVsTtm, canDeriveQuarter, forQuery, cellBasis, cellValue, columnsOf, comparable, comparisons, kindOf, monthsBetween, restatementPairs, suppliedMetrics, ytdDifferences, ytdNotice,
} from '../../web/views/tabs/statements-model.js';

const P = (key, fy, fp, type, start, end, extra = {}) => ({ key, fiscalYear: fy, fiscalPeriod: fp, periodType: type, start, end, filingDate: '2025-11-01', source: 'Test', basis: 'reported', ...extra });

// A cash-flow answer as many issuers file it: Q1 standalone (also its own year to date), Q2 and Q3 year to date.
const cash = () => ({
  statement: 'cashflow', period: 'quarterly', currency: 'USD', units: 'millions',
  periods: [
    P('2025Q3', 2025, 'Q3', 'ytd', '2025-01-01', '2025-09-30', { months: 9 }),
    P('2025Q2', 2025, 'Q2', 'ytd', '2025-01-01', '2025-06-30', { months: 6 }),
    P('2025Q1', 2025, 'Q1', 'quarter', '2025-01-01', '2025-03-31', { months: 3 }),
    P('2024Q3', 2024, 'Q3', 'ytd', '2024-01-01', '2024-09-30', { months: 9 }),
  ],
  lines: [
    { key: 'cfo', label: 'Cash from operations', values: { '2025Q3': 330.5, '2025Q2': 210.25, '2025Q1': 100, '2024Q3': 300 } },
    { key: 'capex', label: 'Capital expenditure', values: { '2025Q3': -45, '2025Q2': null, '2025Q1': -15, '2024Q3': -40 }, nulls: { '2025Q2': 'Not reported' } },
  ],
});

test('quarter vs year to date: the period type, and a "quarter" longer than three months read as year to date', () => {
  assert.equal(kindOf(P('a', 2025, 'Q1', 'quarter', '2025-01-01', '2025-03-31')).kind, 'quarter');
  assert.deepEqual(kindOf(P('a', 2025, 'Q2', 'ytd', '2025-01-01', '2025-06-30', { months: 6 })), { kind: 'ytd', months: 6 });
  // Labelled a quarter, but 2025-01-01..2025-06-30 is six months: year to date, flagged as relabelled.
  assert.deepEqual(kindOf(P('a', 2025, 'Q2', 'quarter', '2025-01-01', '2025-06-30')), { kind: 'ytd', months: 6, relabelled: true });
  // No period type: from the dates. 2025-04-01..2025-06-30 = 3 months; 2025-01-01..2025-09-30 = 9 months.
  assert.equal(kindOf({ key: 'x', fiscalYear: 2025, fiscalPeriod: 'Q2', start: '2025-04-01', end: '2025-06-30' }).kind, 'quarter');
  assert.deepEqual(kindOf({ key: 'x', fiscalYear: 2025, fiscalPeriod: 'Q3', start: '2025-01-01', end: '2025-09-30' }), { kind: 'ytd', months: 9 });
  assert.equal(kindOf(P('b', 2025, 'Q2', 'instant', null, '2025-06-30'), 'balance').kind, 'instant');
  assert.equal(kindOf({ key: 'b', fiscalPeriod: 'Q2', end: '2025-06-30' }, 'balance').kind, 'instant');
  assert.equal(kindOf(P('t', null, 'TTM', 'ttm', '2024-10-01', '2025-09-30')).kind, 'ttm');
  assert.equal(kindOf(P('f', 2024, 'FY', 'annual', '2024-01-01', '2024-12-31')).kind, 'annual');
  assert.equal(monthsBetween('2024-02-01', '2024-04-30'), 3);
  assert.equal(kindOf({ key: 'u', fiscalPeriod: '?' }).kind, 'unknown');
});

test('the year-to-date notice names the year-to-date columns and the first quarter that is also its year to date', () => {
  const n = ytdNotice(cash());
  assert.deepEqual(n.ytd, ['FY2025 Q3', 'FY2025 Q2', 'FY2024 Q3']);
  assert.deepEqual(n.quarterAlso, ['FY2025 Q1']);
  assert.equal(ytdNotice({ ...cash(), statement: 'balance' }), null);
  assert.equal(ytdNotice({ statement: 'income', periods: [P('q', 2025, 'Q2', 'quarter', '2025-04-01', '2025-06-30')] }), null);
});

test('YTD differences: consecutive figures of one fiscal year only, labelled as derived in the Terminal', () => {
  const d = ytdDifferences(cash());
  // Q3 = 9m - 6m: cfo 330.5 - 210.25 = 120.25; capex -45 - (missing) = missing.
  // Q2 = 6m - Q1 (3m): cfo 210.25 - 100 = 110.25; capex missing - (-15) = missing.
  assert.deepEqual(d.derived.map((x) => x.key), ['2025Q3:derived', '2025Q2:derived']);
  const q3 = d.derived[0], q2 = d.derived[1];
  assert.equal(q3.values.cfo, 120.25);
  assert.equal(q3.values.capex, null);
  assert.match(q3.why.capex, /missing/);
  assert.equal(q3.start, '2025-07-01');
  assert.equal(q3.end, '2025-09-30');
  assert.equal(q2.values.cfo, 110.25);
  assert.equal(q2.label, 'derived in the Terminal, not a model input');
  assert.equal(q2.name, 'FY2025 Q2 (derived)');
  // FY2024 Q3 has no 6-month figure in this answer: refused, nothing derived across fiscal years.
  assert.deepEqual(d.refused.map((r) => r.later), ['2024Q3']);
  assert.match(d.refused[0].reason, /6-month year-to-date figure of FY2024/);
});

test('the derivation guard refuses another fiscal year, currency, units, basis or a gap between the figures', () => {
  const data = cash();
  const [q3, q2, q1, q3p] = data.periods;
  assert.equal(canDeriveQuarter(q3, q2, data).ok, true);
  assert.equal(canDeriveQuarter(q2, q1, data).ok, true);
  assert.match(canDeriveQuarter(q3, q1, data).reason, /not consecutive/); // 9 - 3 = 6 months apart
  assert.match(canDeriveQuarter(q3p, q2, data).reason, /same fiscal year|same date/);
  assert.match(canDeriveQuarter(q1, q2, data).reason, /not a year-to-date figure/); // Q1 is not the later figure
  assert.match(canDeriveQuarter(q3, { ...q2, currency: 'EUR' }, data).reason, /currencies differ/);
  assert.match(canDeriveQuarter(q3, { ...q2, units: 'thousands' }, data).reason, /units differ/);
  assert.match(canDeriveQuarter(q3, { ...q2, basis: 'restated' }, data).reason, /bases differ/);
  assert.match(canDeriveQuarter(q3, q2, { ...data, currency: null }).reason, /currency is not stated/);
  assert.match(canDeriveQuarter(q3, q2, { ...data, statement: 'balance' }).reason, /balance sheet/);
  // A line restated in one period only is not differenced.
  const line = { key: 'cfo', values: {}, original: { '2025Q3': 1 } };
  assert.match(canDeriveQuarter(q3, q2, data, line).reason, /restated in one period/);
  // Different statement currencies across the answer: nothing derived.
  const mixed = cash();
  mixed.periods[1].currency = 'EUR';
  assert.equal(ytdDifferences(mixed).derived.find((x) => x.key === '2025Q3:derived'), undefined);
});

// An income statement with a restated quarter: the original is kept beside the restated value.
const income = () => ({
  statement: 'income', period: 'quarterly', currency: 'USD', units: 'millions',
  periods: [
    P('2025Q2', 2025, 'Q2', 'quarter', '2025-04-01', '2025-06-30', { months: 3 }),
    P('2025Q1', 2025, 'Q1', 'quarter', '2025-01-01', '2025-03-31', { months: 3, basis: 'restated', restatedAt: '2025-09-01', original: { filingDate: '2025-05-05', values: { revenue: 500 } } }),
    P('2024Q2', 2024, 'Q2', 'quarter', '2024-04-01', '2024-06-30', { months: 3 }),
  ],
  lines: [
    { key: 'revenue', label: 'Revenue', basis: 'reported', values: { '2025Q2': 550, '2025Q1': 490, '2024Q2': 500 }, original: { '2025Q1': 500 } },
    { key: 'grossProfit', label: 'Gross profit', basis: 'derived', values: { '2025Q2': 220, '2025Q1': 200, '2024Q2': 0 } },
    { key: 'eps', label: 'EPS', units: 'USD per share', values: { '2025Q2': 1.1, '2025Q1': null, '2024Q2': 1 }, nulls: { '2025Q1': 'Not reported in this response' } },
  ],
});

test('restatement pairing: the restated value and the original side by side, never overwritten', () => {
  const pairs = restatementPairs(income());
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].key, '2025Q1');
  assert.equal(pairs[0].restatedAt, '2025-09-01');
  assert.equal(pairs[0].originalFilingDate, '2025-05-05');
  assert.deepEqual(pairs[0].lines.revenue, { label: 'Revenue', current: 490, original: 500, changed: true });
  assert.equal(pairs[0].lines.grossProfit, undefined); // no original supplied: not restated
  const cols = columnsOf(income());
  assert.deepEqual(cols.map((c) => c.id), ['2025Q2', '2025Q1', '2025Q1:original', '2024Q2']);
  const data = income();
  const rev = data.lines[0];
  assert.deepEqual(cellValue(rev, cols[1], data), { value: 490, has: true });
  assert.deepEqual(cellValue(rev, cols[2], data), { value: 500, has: true });
  assert.equal(cellValue(data.lines[1], cols[2], data).has, false);
  assert.match(cellValue(data.lines[1], cols[2], data).why, /not restated/);
  assert.equal(cellBasis(rev, cols[1]), 'restated');
  assert.equal(cellBasis(rev, cols[2]), 'original');
  assert.equal(cellBasis(data.lines[1], cols[0]), 'derived');
  assert.equal(cellBasis(data.lines[1], cols[1]), 'derived');
  assert.equal(cellBasis(rev, cols[0]), 'reported');
  // A missing value stays missing with the server's reason.
  assert.deepEqual(cellValue(data.lines[2], cols[1], data), { value: null, has: false, why: 'Not reported in this response' });
  // Originals can be hidden; the restated column remains.
  assert.deepEqual(columnsOf(income(), { showOriginals: false }).map((c) => c.id), ['2025Q2', '2025Q1', '2024Q2']);
  assert.deepEqual(columnsOf(income(), { count: 1 }).map((c) => c.id), ['2025Q2']);
  // The original from the period record alone (no per-line map) is paired too.
  const d2 = income(); delete d2.lines[0].original;
  assert.equal(restatementPairs(d2)[0].lines.revenue.original, 500);
});

test('TTM vs annual: the supplied TTM is kept apart from the fiscal years, even when it ends on a year end', () => {
  const annual = { statement: 'income', currency: 'USD', units: 'millions', periods: [P('2024FY', 2024, 'FY', 'annual', '2024-01-01', '2024-12-31', { months: 12 }), P('2023FY', 2023, 'FY', 'annual', '2023-01-01', '2023-12-31', { months: 12 })] };
  const ttm = { statement: 'income', currency: 'USD', units: 'millions', periods: [P('TTM', null, 'TTM', 'ttm', '2025-07-01', '2026-06-30', { months: 12, basis: 'derived' })] };
  const r = annualVsTtm(annual, ttm);
  assert.deepEqual(r.annual.map((p) => p.key), ['2024FY', '2023FY']);
  assert.equal(r.ttm.key, 'TTM');
  assert.equal(r.ttmIsFiscalYear, false);
  assert.equal(r.note, null);
  const ttm2 = { ...ttm, periods: [P('TTM', null, 'TTM', 'ttm', '2024-01-01', '2024-12-31', { months: 12 })] };
  const r2 = annualVsTtm(annual, ttm2);
  assert.equal(r2.ttmIsFiscalYear, true);
  assert.match(r2.note, /same day as FY2024.*apart from the annual report/);
  assert.match(annualVsTtm(annual, { ...ttm, currency: 'EUR' }).note, /TTM is in EUR/);
  assert.equal(annualVsTtm(annual, null).ttm, null);
  // A TTM is never compared with a fiscal year by the Terminal.
  assert.match(comparable(ttm.periods[0], annual.periods[0], annual).reason, /trailing twelve months.*fiscal year/);
});

test('Terminal comparison: same period a year earlier, compatible only, missing when an input is', () => {
  const c = comparisons(income());
  const q2 = c.rows.find((r) => r.key === '2025Q2');
  // revenue (550 - 500) / 500 x 100 = 10; gross profit earlier value 0: missing; EPS (1.1 - 1) / 1 x 100 = 10.
  assert.equal(q2.ok, true);
  assert.equal(q2.against, '2024Q2');
  assert.ok(Math.abs(q2.values.revenue - 10) < 1e-9);
  assert.equal(q2.values.grossProfit, null);
  assert.match(q2.why.grossProfit, /zero/);
  assert.ok(Math.abs(q2.values.eps - 10) < 1e-9);
  assert.equal(c.rows.find((r) => r.key === '2025Q1').ok, false);
  // A year-to-date figure is not compared with a standalone quarter; normalized is not compared with reported.
  const ytd = P('y', 2025, 'Q2', 'ytd', '2025-01-01', '2025-06-30', { months: 6 });
  assert.match(comparable(ytd, income().periods[2], income()).reason, /year to date.*standalone quarter/);
  assert.match(comparable({ ...income().periods[0], basis: 'normalized' }, income().periods[2], income()).reason, /bases differ/);
  assert.equal(comparable(income().periods[0], { ...income().periods[2], basis: 'restated' }, income()).ok, true);
});

test('server-supplied growth, margins and ratios are read as supplied, in either shape', () => {
  const m = suppliedMetrics({ margins: [{ key: 'gm', label: 'Gross margin', units: 'percent', values: { '2025Q2': 40 } }], ratios: { currentRatio: { label: 'Current ratio', value: 1.4 } } });
  assert.deepEqual(m.map((x) => [x.group, x.label]), [['Margins', 'Gross margin'], ['Ratios', 'Current ratio']]);
  assert.equal(m[0].values['2025Q2'], 40);
  assert.equal(m[1].value, 1.4);
  assert.deepEqual(suppliedMetrics({}), []);
});

test('an answer to an earlier choice (another statement, period or page) is drawn as loading, not under the new choice', () => {
  const ds = { key: 'statements', state: 'available', env: { data: { statement: 'income' } }, at: 1000 };
  assert.equal(forQuery(ds, 900), ds); // answered after it was asked: drawn
  assert.deepEqual(forQuery(ds, 1500), { ...ds, env: null, state: 'loading' }); // the choice changed at 1500: loading
  assert.equal(forQuery({ ...ds, error: new Error('x') }, 1500).state, 'error');
  const none = { key: 'statements', state: 'loading', env: null };
  assert.equal(forQuery(none, 1500), none);
});
