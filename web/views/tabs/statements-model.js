// Financial statements: the period handling, with no screen code, so node tests can load it
// (test/core/statements-model.test.js). The screen is web/views/tabs/statements.js.
//
//   kindOf()            what a column covers: a value at a date (balance sheet), a standalone quarter, a year-to-date
//                       figure, a fiscal year or a trailing twelve months. A column the server calls a quarter but that
//                       covers more than three months is read as year-to-date, never shown as a quarter.
//   columnsOf()         the server's periods as display columns, newest first, with the restated column followed by the
//                       originally reported one (restatements never overwrite what was first reported)
//   restatementPairs()  each restated period with its original values, line by line
//   ytdNotice()         which quarterly columns are year-to-date only
//   canDeriveQuarter()  the guard for the one derivation offered: the difference between two consecutive year-to-date
//                       figures of the same fiscal year, currency, units and basis
//   ytdDifferences()    those differences, labelled "derived in the Terminal, not a model input"
//   comparable() / comparisons()  the Terminal's own comparison (change against the same period a year earlier),
//                       only between periods of the same kind, length, currency, units and compatible basis
//   cellBasis()         reported, normalized, restated or derived, per cell where it differs from the column
//
// Nothing here is an investment-model input: growth, margins, ratios and normalized metrics are shown as the server
// supplies them. The arithmetic below is display comparison only and is labelled as such on screen.

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export const STATEMENTS = [['income', 'Income statement'], ['balance', 'Balance sheet'], ['cashflow', 'Cash flow statement']];
export const BASIS_LABEL = { reported: 'reported', normalized: 'normalized', restated: 'restated', derived: 'derived' };
export const BASIS_MARK = { normalized: 'n', restated: 'r', derived: 'd', original: 'o' };
export const DERIVED_LABEL = 'derived in the Terminal, not a model input';

const DAY = 86400e3;
/** Whole months between two ISO dates, start inclusive and end inclusive (2025-01-01..2025-06-30 = 6). */
export function monthsBetween(start, end) {
  if (!start || !end) return null;
  const a = new Date(`${start.slice(0, 10)}T00:00:00Z`), b = new Date(new Date(`${end.slice(0, 10)}T00:00:00Z`).getTime() + DAY);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return null;
  const m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() - a.getUTCDate()) / 30;
  return Math.round(m);
}
/** The number of months a period covers: the server's figure, else from its dates; null for a value at a date. */
export function monthsOf(p) {
  if (!p) return null;
  if (p.periodType === 'instant') return null;
  if (isNum(p.months)) return p.months;
  return monthsBetween(p.start, p.end);
}

/**
 * What one column covers.
 *   'instant'  a value at a date (balance sheet, or periodType 'instant', or no start date on a balance sheet)
 *   'ttm'      trailing twelve months as supplied
 *   'annual'   a fiscal year
 *   'ytd'      year-to-date (from the fiscal year's start), longer than one quarter
 *   'quarter'  a standalone quarter (three months)
 *   'unknown'  the server's answer does not say and the dates do not tell
 * A column labelled 'quarter' that covers more than three months is 'ytd' (with `relabelled: true`): a year-to-date
 * figure is never shown as a quarter.
 */
export function kindOf(p, statement) {
  if (!p) return { kind: 'unknown' };
  const t = p.periodType;
  if (t === 'instant' || (statement === 'balance' && !p.start)) return { kind: 'instant' };
  if (t === 'ttm' || String(p.fiscalPeriod).toUpperCase() === 'TTM') return { kind: 'ttm', months: monthsOf(p) ?? 12 };
  const m = monthsOf(p);
  if (t === 'annual' || String(p.fiscalPeriod).toUpperCase() === 'FY') return { kind: 'annual', months: m ?? 12 };
  if (t === 'ytd') return { kind: 'ytd', months: m };
  if (t === 'quarter') {
    if (isNum(m) && m > 3) return { kind: 'ytd', months: m, relabelled: true };
    return { kind: 'quarter', months: m ?? 3 };
  }
  // No period type from the server: read it from the dates.
  if (m === 3) return { kind: 'quarter', months: 3 };
  if (isNum(m) && m > 3 && m < 12) return { kind: 'ytd', months: m };
  if (m === 12) return { kind: 'annual', months: 12 };
  return { kind: 'unknown', months: m };
}
export const KIND_LABEL = { instant: 'at a date', quarter: 'standalone quarter', ytd: 'year to date', annual: 'fiscal year', ttm: 'trailing twelve months', unknown: 'period not stated' };

/** "FY2025 Q2", "FY2025", "TTM to 2026-06-30". */
export function periodName(p) {
  if (!p) return '';
  const fp = String(p.fiscalPeriod || '');
  if (fp.toUpperCase() === 'TTM' || p.periodType === 'ttm') return `TTM to ${p.end || '?'}`;
  if (fp.toUpperCase() === 'FY') return `FY${p.fiscalYear ?? ''}`;
  return `${isNum(p.fiscalYear) ? `FY${p.fiscalYear} ` : ''}${fp || p.key}`.trim();
}
/** What the column covers in words: "at 2025-06-30", "3 months, 2025-04-01 to 2025-06-30", "6 months year to date ...". */
export function coverText(p, statement) {
  const k = kindOf(p, statement);
  if (k.kind === 'instant') return `at ${p.end || '?'}`;
  const span = `${p.start || '?'} to ${p.end || '?'}`;
  const m = isNum(k.months) ? `${k.months} months` : 'length not stated';
  if (k.kind === 'ytd') return `${m} year to date, ${span}`;
  if (k.kind === 'ttm') return `trailing ${m}, ${span}`;
  return `${m}, ${span}`;
}

const ccyOf = (p, data) => p?.currency || data?.currency || null;
const unitsOf = (p, data) => p?.units || data?.units || null;
/** The line's units: its own, else the statement's. */
export const lineUnits = (line, data) => line?.units || data?.units || null;

/**
 * The display columns, in the server's order (newest first). A restated period is followed by an 'original' column with
 * the values as first reported (`showOriginals`), so both are seen side by side.
 */
export function columnsOf(data, { count, showOriginals = true } = {}) {
  const periods = (data?.periods || []).slice(0, isNum(count) && count > 0 ? count : undefined);
  const cols = [];
  for (const p of periods) {
    const k = kindOf(p, data.statement);
    cols.push({ id: p.key, key: p.key, role: 'current', period: p, kind: k.kind, months: k.months ?? null, relabelled: Boolean(k.relabelled), currency: ccyOf(p, data), units: unitsOf(p, data), basis: p.basis || 'reported' });
    const pair = restatementOf(p, data);
    if (pair && showOriginals) cols.push({ id: `${p.key}:original`, key: p.key, role: 'original', period: p, kind: k.kind, months: k.months ?? null, currency: ccyOf(p, data), units: unitsOf(p, data), basis: 'original', filingDate: pair.originalFilingDate });
  }
  return cols;
}

/** One period's restatement, or null: { key, restatedAt, originalFilingDate, values: { line: original } }. */
function restatementOf(p, data) {
  const fromLines = {};
  for (const l of data?.lines || []) if (l.original && Object.prototype.hasOwnProperty.call(l.original, p.key)) fromLines[l.key] = l.original[p.key];
  const fromPeriod = p.original?.values || {};
  const values = { ...fromPeriod, ...fromLines };
  if (p.basis !== 'restated' && !Object.keys(values).length) return null;
  return { key: p.key, restatedAt: p.restatedAt || null, originalFilingDate: p.original?.filingDate || p.filingDate || null, values };
}

/**
 * Every restated period with, per line, the current (restated) and the originally reported value. A line the server
 * gives no original for has `original: undefined` (it was not restated); a restated period with no originals at all is
 * listed with `originalsMissing: true`, never filled in.
 */
export function restatementPairs(data) {
  const out = [];
  for (const p of data?.periods || []) {
    const r = restatementOf(p, data);
    if (!r) continue;
    const lines = {};
    for (const l of data.lines || []) {
      if (!Object.prototype.hasOwnProperty.call(r.values, l.key)) continue;
      const cur = l.values?.[p.key] ?? null, orig = r.values[l.key];
      lines[l.key] = { label: l.label, current: cur, original: orig, changed: isNum(cur) && isNum(orig) ? cur !== orig : cur !== orig };
    }
    out.push({ key: p.key, name: periodName(p), restatedAt: r.restatedAt, originalFilingDate: r.originalFilingDate, lines, originalsMissing: !Object.keys(r.values).length });
  }
  return out;
}

/** The value of one line in one column: the current value, or the originally reported one in an 'original' column. */
export function cellValue(line, col, data) {
  if (col.role === 'original') {
    const r = restatementOf(col.period, data);
    if (r && Object.prototype.hasOwnProperty.call(r.values, line.key)) return { value: r.values[line.key], has: true };
    return { value: null, has: false, why: 'The server lists no original for this line in this period: it was not restated.' };
  }
  const v = line.values?.[col.key];
  if (isNum(v)) return { value: v, has: true };
  const why = line.nulls?.[col.key] || data?.nulls?.[`lines.${line.key}.${col.key}`] || (v === undefined ? 'Not supplied for this period' : 'Not reported for this period');
  return { value: null, has: false, why };
}

/**
 * The basis of one cell where it differs from its column: 'restated' (the line has an original for this period),
 * the server's own per-cell basis (`line.bases[periodKey]`), or the line's basis ('derived' gross profit, 'normalized').
 */
export function cellBasis(line, col) {
  if (col.role === 'original') return 'original';
  if (line.bases?.[col.key]) return line.bases[col.key];
  if (line.original && Object.prototype.hasOwnProperty.call(line.original, col.key)) return 'restated';
  if (line.basis && line.basis !== 'reported') return line.basis;
  return col.basis === 'restated' ? 'reported' : col.basis || 'reported';
}

/** Quarterly columns that are year-to-date: { ytd: [names], quarterAlso: [names] } or null when none. */
export function ytdNotice(data) {
  if (!data || data.statement === 'balance') return null;
  const ytd = [], q1 = [];
  for (const p of data.periods || []) {
    const k = kindOf(p, data.statement);
    if (k.kind === 'ytd') ytd.push(periodName(p));
    else if (k.kind === 'quarter' && isFiscalYearStart(p, data)) q1.push(periodName(p));
  }
  return ytd.length ? { ytd, quarterAlso: q1 } : null;
}
/** A three-month period that starts the fiscal year (a first quarter is also its own year to date). */
function isFiscalYearStart(p, data) {
  if (!p.start) return false;
  if (String(p.fiscalPeriod).toUpperCase() === 'Q1') return true;
  return (data.periods || []).some((x) => x !== p && x.fiscalYear === p.fiscalYear && kindOf(x, data.statement).kind === 'ytd' && x.start === p.start);
}
const ytdMonths = (p, data) => {
  const k = kindOf(p, data.statement);
  if (k.kind === 'ytd') return k.months;
  if (k.kind === 'quarter' && isFiscalYearStart(p, data)) return 3;
  return null;
};

/**
 * Whether "later minus earlier" may be shown as the standalone period between two year-to-date figures.
 * Both must be year-to-date figures (a first quarter counts as three months year to date) of the same fiscal year,
 * from the same start, consecutive (the earlier ends where the later's last quarter begins: three months apart), in the
 * same currency and units, and on the same basis. Returns { ok: true, months: 3 } or { ok: false, reason }.
 */
export function canDeriveQuarter(later, earlier, data, line = null) {
  if (!later || !earlier) return { ok: false, reason: 'Two year-to-date figures are needed.' };
  if (data?.statement === 'balance') return { ok: false, reason: 'A balance sheet holds values at a date, not over a period.' };
  const ml = ytdMonths(later, data), me = ytdMonths(earlier, data);
  if (!isNum(ml) || kindOf(later, data.statement).kind !== 'ytd') return { ok: false, reason: `${periodName(later)} is not a year-to-date figure.` };
  if (!isNum(me)) return { ok: false, reason: `${periodName(earlier)} is not a year-to-date figure.` };
  if (later.fiscalYear !== earlier.fiscalYear || !isNum(later.fiscalYear)) return { ok: false, reason: `${periodName(later)} and ${periodName(earlier)} are not in the same fiscal year.` };
  if ((later.start || null) !== (earlier.start || null)) return { ok: false, reason: 'The two figures do not start on the same date.' };
  if (ml - me !== 3) return { ok: false, reason: `${periodName(earlier)} (${me} months) and ${periodName(later)} (${ml} months) are not consecutive quarters.` };
  if (earlier.end && later.end && earlier.end >= later.end) return { ok: false, reason: 'The earlier figure does not end before the later one.' };
  if ((ccyOf(later, data) || null) !== (ccyOf(earlier, data) || null)) return { ok: false, reason: `The currencies differ (${ccyOf(earlier, data) || 'not stated'} and ${ccyOf(later, data) || 'not stated'}).` };
  if (!ccyOf(later, data)) return { ok: false, reason: 'The statement currency is not stated.' };
  if ((unitsOf(later, data) || null) !== (unitsOf(earlier, data) || null)) return { ok: false, reason: `The units differ (${unitsOf(earlier, data) || 'not stated'} and ${unitsOf(later, data) || 'not stated'}).` };
  if (!unitsOf(later, data)) return { ok: false, reason: 'The statement units are not stated.' };
  const bl = later.basis || 'reported', be = earlier.basis || 'reported';
  if (bl !== be) return { ok: false, reason: `The bases differ (${be} and ${bl}).` };
  if (line) {
    const lb = (k) => (line.bases?.[k]) || (line.original && Object.prototype.hasOwnProperty.call(line.original, k) ? 'restated' : null);
    if (lb(later.key) !== lb(earlier.key)) return { ok: false, reason: 'This line is restated in one period and not in the other.' };
  }
  return { ok: true, months: 3 };
}

/**
 * The standalone quarters that follow from consecutive year-to-date figures in this answer.
 *   { derived: [{ key, name, fiscalYear, fiscalPeriod, start, end, later, earlier, values: { line: number|null }, why: { line: reason } }],
 *     refused: [{ later, earlier, reason }] }
 * Each value is later minus earlier for one line, rounded to the precision of its inputs; a missing input leaves it missing.
 */
export function ytdDifferences(data) {
  const out = { derived: [], refused: [] };
  if (!data || data.statement === 'balance') return out;
  const ytd = (data.periods || []).filter((p) => kindOf(p, data.statement).kind === 'ytd');
  for (const later of ytd) {
    const ml = ytdMonths(later, data);
    const earlier = (data.periods || []).find((p) => p !== later && p.fiscalYear === later.fiscalYear && ytdMonths(p, data) === ml - 3);
    if (!earlier) { out.refused.push({ later: later.key, earlier: null, reason: `The ${ml - 3}-month year-to-date figure of FY${later.fiscalYear} is not in this answer.` }); continue; }
    const g = canDeriveQuarter(later, earlier, data);
    if (!g.ok) { out.refused.push({ later: later.key, earlier: earlier.key, reason: g.reason }); continue; }
    const values = {}, why = {};
    for (const l of data.lines || []) {
      const a = l.values?.[later.key], b = l.values?.[earlier.key];
      const lg = canDeriveQuarter(later, earlier, data, l);
      if (!lg.ok) { values[l.key] = null; why[l.key] = lg.reason; continue; }
      if (!isNum(a) || !isNum(b)) { values[l.key] = null; why[l.key] = 'One of the two year-to-date figures is missing.'; continue; }
      const dp = Math.max(decimals(a), decimals(b));
      values[l.key] = Number((a - b).toFixed(dp));
    }
    const q = Math.round(ml / 3);
    out.derived.push({ key: `${later.key}:derived`, name: `FY${later.fiscalYear} Q${q} (derived)`, fiscalYear: later.fiscalYear, fiscalPeriod: `Q${q}`, start: earlier.end ? nextDay(earlier.end) : null, end: later.end, later: later.key, earlier: earlier.key, values, why, label: DERIVED_LABEL });
  }
  return out;
}
const decimals = (x) => { const s = String(x); const i = s.indexOf('.'); return i < 0 || /e/i.test(s) ? 0 : s.length - i - 1; };
const nextDay = (d) => new Date(new Date(`${d.slice(0, 10)}T00:00:00Z`).getTime() + DAY).toISOString().slice(0, 10);

/**
 * Annual figures and the server's TTM kept apart: { annual: [periods], ttm: period|null, ttmIsFiscalYear, note }.
 * A TTM that happens to end on a fiscal year end is still the server's TTM figure, not the annual report.
 */
export function annualVsTtm(annualData, ttmData) {
  const annual = (annualData?.periods || []).filter((p) => kindOf(p, annualData.statement).kind === 'annual');
  const ttm = (ttmData?.periods || []).find((p) => kindOf(p, ttmData.statement).kind === 'ttm') || null;
  const sameEnd = ttm ? annual.find((p) => p.end === ttm.end) || null : null;
  let note = null;
  if (ttm && sameEnd) note = `The TTM ends on ${ttm.end}, the same day as ${periodName(sameEnd)}: it is the server's trailing figure, shown apart from the annual report.`;
  if (ttm && annualData && ttmData && (annualData.currency || null) !== (ttmData.currency || null)) note = `The TTM is in ${ttmData.currency || 'an unstated currency'} and the annual figures in ${annualData.currency || 'an unstated currency'}.`;
  return { annual, ttm, ttmIsFiscalYear: Boolean(sameEnd), note };
}

/**
 * Whether the Terminal may compare two columns (b is the earlier): same kind and length, a year apart in the same
 * fiscal period, same currency and units, and bases that are both as filed (reported or restated) or the same.
 */
export function comparable(a, b, data) {
  if (!a || !b) return { ok: false, reason: 'No earlier period to compare with.' };
  const ka = kindOf(a, data?.statement), kb = kindOf(b, data?.statement);
  if (ka.kind !== kb.kind) return { ok: false, reason: `A ${KIND_LABEL[ka.kind]} is not compared with a ${KIND_LABEL[kb.kind]}.` };
  if (ka.kind === 'unknown' || ka.kind === 'ttm') return { ok: false, reason: ka.kind === 'ttm' ? 'Only one TTM figure is supplied.' : 'The period is not stated.' };
  if ((ka.months ?? null) !== (kb.months ?? null)) return { ok: false, reason: 'The two periods are not the same length.' };
  if (String(a.fiscalPeriod) !== String(b.fiscalPeriod) || !isNum(a.fiscalYear) || a.fiscalYear - b.fiscalYear !== 1) return { ok: false, reason: 'Not the same period a year earlier.' };
  if ((ccyOf(a, data) || null) !== (ccyOf(b, data) || null) || !ccyOf(a, data)) return { ok: false, reason: 'The currencies differ or are not stated.' };
  if ((unitsOf(a, data) || null) !== (unitsOf(b, data) || null) || !unitsOf(a, data)) return { ok: false, reason: 'The units differ or are not stated.' };
  const asFiled = (x) => ['reported', 'restated', undefined, null].includes(x);
  if (!(asFiled(a.basis) && asFiled(b.basis)) && a.basis !== b.basis) return { ok: false, reason: `The bases differ (${b.basis} and ${a.basis}).` };
  return { ok: true };
}
/**
 * The Terminal's comparison: for each period, the change of each line against the same period a year earlier in this
 * answer, as (current − earlier) ÷ |earlier| × 100. Missing inputs, a zero earlier value or incompatible periods leave it
 * missing with the reason. { rows: [{ key, name, against, ok, reason, values: { line: pct|null }, why: { line: reason } }] }
 */
export function comparisons(data) {
  const rows = [];
  for (const a of data?.periods || []) {
    const b = (data.periods || []).find((x) => x !== a && String(x.fiscalPeriod) === String(a.fiscalPeriod) && x.fiscalYear === a.fiscalYear - 1);
    const g = comparable(a, b, data);
    const values = {}, why = {};
    if (g.ok) {
      for (const l of data.lines || []) {
        const x = l.values?.[a.key], y = l.values?.[b.key];
        if (!isNum(x) || !isNum(y)) { values[l.key] = null; why[l.key] = 'A value is missing.'; continue; }
        if (y === 0) { values[l.key] = null; why[l.key] = 'The earlier value is zero.'; continue; }
        values[l.key] = ((x - y) / Math.abs(y)) * 100;
      }
    }
    rows.push({ key: a.key, name: periodName(a), against: b ? b.key : null, againstName: b ? periodName(b) : null, ok: g.ok, reason: g.ok ? null : g.reason, values, why });
  }
  return { rows };
}

/** Growth, margins, ratios and normalized metrics as the server supplies them (any of these shapes), else []. */
export function suppliedMetrics(data) {
  const out = [];
  for (const [group, label] of [['growth', 'Growth'], ['margins', 'Margins'], ['ratios', 'Ratios'], ['normalized', 'Normalized metrics'], ['metrics', 'Metrics']]) {
    const v = data?.[group];
    if (!v) continue;
    const list = Array.isArray(v) ? v : Object.entries(v).map(([key, x]) => (x && typeof x === 'object' ? { key, ...x } : { key, label: key, value: x }));
    for (const m of list) if (m && (m.values || m.value !== undefined)) out.push({ group: label, key: m.key, label: m.label || m.key, units: m.units || null, values: m.values || null, value: m.value ?? null, basis: m.basis || null, nulls: m.nulls || {} });
  }
  return out;
}

/**
 * A workspace dataset as it should be drawn when its query can change (another statement, period or page): an answer
 * received before the current query was asked (`askedAt`, ms) is not drawn under it; the panel shows loading instead
 * (or the error of the current request). A refresh of the same query keeps the answer on screen while it runs.
 */
export function forQuery(ds, askedAt) {
  if (!ds || !ds.env) return ds;
  if (isNum(ds.at) && ds.at >= askedAt) return ds;
  return { ...ds, env: null, state: ds.error ? 'error' : 'loading' };
}
