// Plain logic of the equity tabs Overview, Price history and Earnings (web/views/tabs/*.js), with no screen code so the
// engine tests can load it (test/core/e1-tabs-model.test.js).
//
//   hasSeries / seriesChoice   which price series (adjusted, unadjusted) the server actually supplied, and whether the
//                              switch between them is offered (only when both exist)
//   findGaps                   holes in a bar series: the gaps the server states (coverage.missing) and spacing between
//                              consecutive bars wider than the interval allows; never filled in
//   placeAnnotations           where each corporate-action annotation sits on the bars (on its date, on the next bar, or
//                              outside the range shown)
//   rangePerformance           the change between two closes, with its basis (which closes, which series) and the
//                              reason when it would mislead (a split inside an unadjusted range)
//   splitEarnings / surpriseOf / changeVsPrior   earnings calendar facts: upcoming against reported, surprise as supplied
//                              (or worked out from reported and consensus, labelled), change against the prior value
//   profileRows                the Overview's company, listing and highlight fields, each with units and as-of, and
//                              every expected field named even when the server did not supply it
//
// Nothing here values an instrument: fair values, scores, eligibility and consensus come from the server as supplied.

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const DAY_MS = 86400e3;
const dayNum = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / DAY_MS);
export const addDaysIso = (d, n) => new Date((dayNum(d) + n) * DAY_MS).toISOString().slice(0, 10);

// ---- price series --------------------------------------------------------------------------------------------------------
const WITH_DATA = new Set(['available', 'stale', 'incomplete']);
/**
 * True when an envelope carries a usable series of the kind asked for. An answer that says it is the other kind
 * (data.adjusted opposite to what was asked) is not that series, and an answer flagged data.available === false is
 * not a series at all.
 */
export function hasSeries(env, state, wantAdjusted) {
  if (!env || !WITH_DATA.has(state)) return false;
  if (env.data?.available === false) return false;
  if (typeof env.data?.adjusted === 'boolean' && env.data.adjusted !== wantAdjusted) return false;
  return (env.items || []).some((b) => isNum(b.close));
}
/**
 * Which series to show. `un` and `adj` are { env, state } of the unadjusted and adjusted requests; `wanted` is the
 * user's choice ('adjusted' | 'unadjusted'). Returns { show, switchable, why }:
 *   both exist     -> the wanted one, switchable
 *   one exists     -> that one, not switchable, with the reason the other is not offered
 *   neither        -> show the unadjusted request's answer (its own state says why), not switchable
 */
export function seriesChoice({ un, adj, wanted = 'unadjusted' }) {
  const hasU = hasSeries(un?.env, un?.state, false);
  const hasA = hasSeries(adj?.env, adj?.state, true);
  const pending = (x) => !x || x.state === 'loading';
  if (hasU && hasA) return { show: wanted === 'adjusted' ? 'adjusted' : 'unadjusted', switchable: true, why: null };
  if (hasU) return { show: 'unadjusted', switchable: false, why: pending(adj) ? 'Checking whether the server supplies an adjusted series.' : `The server supplies no adjusted series for this range, so only the unadjusted series is shown; none is worked out here.${adj?.env?.message ? ` The server says: ${adj.env.message}` : ''}` };
  if (hasA) return { show: 'adjusted', switchable: false, why: pending(un) ? 'Checking whether the server supplies an unadjusted series.' : 'The server supplies no unadjusted series for this range, so only the adjusted series is shown.' };
  return { show: 'unadjusted', switchable: false, why: null };
}

/** Widest spacing between consecutive bars that is not a hole, in calendar days (weekends and holiday weekends allowed). */
export const MAX_SPACING = { '1d': 4, '1wk': 10, '1mo': 35 };
/**
 * Holes in a bar series (bars sorted by date). Returns [{ from, to, days, stated, label }]: `from`/`to` are the last
 * bar before and the first bar after the hole; `stated` when the server's coverage.missing names it. Gaps the server
 * states that cannot be placed between bars (e.g. "interval 1wk") are returned with from/to null.
 */
export function findGaps(bars, interval = '1d', missing = []) {
  const out = [];
  const max = MAX_SPACING[interval] ?? 4;
  const stated = (missing || []).map((m) => {
    const r = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(String(m));
    return { text: String(m), from: r?.[1] || null, to: r?.[2] || null };
  });
  const used = new Set();
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].date, b = bars[i].date;
    const days = dayNum(b) - dayNum(a);
    const s = stated.find((x) => x.from && x.from > a && x.to < b);
    if (days > max || s) {
      if (s) used.add(s.text);
      out.push({ from: a, to: b, days, stated: Boolean(s), label: s ? `No bars from ${s.from} to ${s.to}, stated by the server` : `No bars between ${a} and ${b} (${days} days apart)` });
    }
  }
  for (const s of stated) if (!used.has(s.text)) out.push({ from: null, to: null, days: null, stated: true, label: s.text });
  return out;
}

/** Corporate-action kinds that change the price scale (an unadjusted series is not comparable across them). */
export const SCALE_TYPES = new Set(['split', 'reverse_split', 'stock_dividend', 'bonus', 'spin_off', 'spinoff', 'rights', 'consolidation']);
export const isScaleEvent = (a) => SCALE_TYPES.has(String(a?.type || '').toLowerCase()) || Boolean(a?.ratio && (a.ratio.num !== a.ratio.den));
/**
 * Where each annotation sits on the bars. Returns the annotations with { index, barDate, placement }:
 *   'on'       a bar exists on its date
 *   'next'     no bar on its date (a non-trading day or a hole): drawn on the next bar, and said so
 *   'before' / 'after'   outside the bars shown: listed, not drawn
 */
export function placeAnnotations(bars, annotations) {
  return (annotations || []).map((a) => {
    if (!bars.length || !a?.date) return { ...a, index: null, barDate: null, placement: 'after' };
    if (a.date < bars[0].date) return { ...a, index: null, barDate: null, placement: 'before' };
    if (a.date > bars[bars.length - 1].date) return { ...a, index: null, barDate: null, placement: 'after' };
    const i = bars.findIndex((b) => b.date >= a.date);
    return { ...a, index: i, barDate: bars[i].date, placement: bars[i].date === a.date ? 'on' : 'next' };
  }).sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

/**
 * The change over the bars shown, from the first close to the last close: (last / first - 1) x 100.
 * `adjusted`: true, false or null (the source did not say). Returns
 *   { value, from: { date, close }, to: { date, close }, series, priceOnly, why }
 * value is null (with `why`) when there are fewer than two closes, the first close is not positive, or a scale-changing
 * corporate action falls inside an unadjusted (or unstated) range.
 */
export function rangePerformance(bars, { adjusted = null, annotations = [] } = {}) {
  const closes = (bars || []).filter((b) => isNum(b.close));
  const series = adjusted === true ? 'adjusted' : adjusted === false ? 'unadjusted' : 'unstated';
  if (closes.length < 2) return { value: null, from: null, to: null, series, priceOnly: adjusted !== true, why: 'Needs at least two closes in the range.' };
  const first = closes[0], last = closes[closes.length - 1];
  const base = { from: { date: first.date, close: first.close }, to: { date: last.date, close: last.close }, series, priceOnly: adjusted !== true };
  if (!(first.close > 0)) return { ...base, value: null, why: 'The first close is not positive, so a percent change would mislead.' };
  if (adjusted !== true) {
    const scale = (annotations || []).find((a) => isScaleEvent(a) && a.date > first.date && a.date <= last.date);
    if (scale) return { ...base, value: null, why: `${scale.label || scale.type} on ${scale.date} changes the price scale inside this range; on ${adjusted === false ? 'an unadjusted' : 'a series of unstated adjustment'} the change across it is not comparable, so it is not shown.` };
  }
  return { ...base, value: (last.close / first.close - 1) * 100, why: null };
}

/** Coverage of a range: whether the bars start later than the range asked for (insufficient history). */
export function coverageOf(bars, fromAsked, toAsked) {
  if (!bars.length) return { short: Boolean(fromAsked), firstDate: null, lastDate: null, missingDays: null };
  const firstDate = bars[0].date, lastDate = bars[bars.length - 1].date;
  const missingDays = fromAsked ? dayNum(firstDate) - dayNum(fromAsked) : 0;
  return { short: Boolean(fromAsked) && missingDays > MAX_SPACING['1d'], firstDate, lastDate, missingDays, endShort: toAsked ? dayNum(toAsked) - dayNum(lastDate) > MAX_SPACING['1d'] : false };
}

// ---- earnings ---------------------------------------------------------------------------------------------------------------
const reportedAny = (e) => (e.metrics || []).some((m) => isNum(m.reported));
/** Upcoming (not yet reported, soonest first) and past (reported, latest first) earnings releases. */
export function splitEarnings(items) {
  const upcoming = [], past = [];
  for (const e of items || []) (e.reportedAt || reportedAny(e) ? past : upcoming).push(e);
  upcoming.sort((a, b) => String(a.releaseAt || '').localeCompare(String(b.releaseAt || '')));
  past.sort((a, b) => String(b.releaseAt || b.reportedAt || '').localeCompare(String(a.releaseAt || a.reportedAt || '')));
  return { upcoming, past };
}
/**
 * Surprise of one metric: the server's figure when supplied; otherwise reported - consensus (and its percent of
 * |consensus|) worked out here, labelled 'computed'; otherwise null with the reason.
 */
export function surpriseOf(m) {
  if (isNum(m?.surprise) || isNum(m?.surprisePct)) return { value: isNum(m.surprise) ? m.surprise : null, pct: isNum(m.surprisePct) ? m.surprisePct : null, basis: 'supplied', why: null };
  if (!isNum(m?.reported)) return { value: null, pct: null, basis: null, why: 'Not reported yet.' };
  if (!isNum(m?.consensus)) return { value: null, pct: null, basis: null, why: 'No consensus supplied, so there is no surprise.' };
  const value = m.reported - m.consensus;
  return { value, pct: m.consensus !== 0 ? (value / Math.abs(m.consensus)) * 100 : null, basis: 'computed', why: null };
}
/** Change of the reported value against the server's prior value: (reported - prior) / |prior| x 100, worked out here. */
export function changeVsPrior(m) {
  if (!isNum(m?.reported)) return { pct: null, why: 'Not reported yet.' };
  if (!isNum(m?.prior)) return { pct: null, why: 'No prior value supplied.' };
  if (m.prior === 0) return { pct: null, why: 'The prior value is zero: a percent change would mislead.' };
  if (m.prior < 0 || m.reported < 0) return { pct: null, why: 'A percent change across negative values would mislead.' };
  return { pct: ((m.reported - m.prior) / Math.abs(m.prior)) * 100, why: null };
}

// ---- overview --------------------------------------------------------------------------------------------------------------
const HIGHLIGHT_LABEL = { revenueTTM: 'Revenue, trailing twelve months', netIncomeTTM: 'Net income, trailing twelve months', epsTTM: 'EPS, trailing twelve months', dividendPerShareAnnual: 'Dividend per share, annual', dividendYield: 'Dividend yield', peRatio: 'Price to earnings', grossMargin: 'Gross margin', operatingMargin: 'Operating margin', netMargin: 'Net margin', revenueGrowthYoY: 'Revenue growth, year on year' };
export const words = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (m, c) => ` ${c.toLowerCase()}`);
const NOT_SUPPLIED = 'Not supplied by the server.';
/**
 * The Overview's fields from a profile payload. Each row: { key, label, value, units, asOf, kind, why }. Every field
 * the Terminal expects is listed, with `value: null` and the reason (env.nulls, else "not supplied") when absent.
 * `asOf` is the field's own date when the server gives one (sharesOutstandingAsOf, marketCapAsOf), else the envelope's.
 */
export function profileRows(data, { nulls = {}, asOf = null } = {}) {
  const iss = data?.issuer || null, lst = data?.listing || null, hi = data?.highlights || null;
  const why = (path, parentNull) => nulls[path] || (parentNull ? nulls[path.split('.')[0]] || `No ${path.split('.')[0]} record supplied.` : NOT_SUPPLIED);
  const row = (group, key, label, value, extra = {}) => ({ group, key: `${group}.${key}`, label, value: value === undefined ? null : value, units: extra.units ?? null, asOf: extra.asOf ?? asOf, kind: extra.kind || (isNum(value) ? 'number' : 'text'), why: value === null || value === undefined ? why(`${group}.${key}`, !(group === 'issuer' ? iss : group === 'listing' ? lst : hi)) : null });
  const ccy = lst?.currency || hi?.units || null;
  const issuer = [
    row('issuer', 'name', 'Issuer name', iss?.name), row('issuer', 'id', 'Issuer ID (server)', iss?.id, { kind: 'id' }),
    row('issuer', 'sector', 'Sector', iss?.sector), row('issuer', 'industry', 'Industry', iss?.industry),
    row('issuer', 'classifications', 'Sector classifications', iss?.classifications?.length ? iss.classifications : null, { kind: 'classifications' }),
    row('issuer', 'country', 'Country', iss?.country), row('issuer', 'employees', 'Employees', iss?.employees, { units: 'people' }),
    row('issuer', 'fiscalYearEnd', 'Fiscal year end', iss?.fiscalYearEnd, { units: 'month-day' }),
  ];
  if (iss && Array.isArray(iss.classifications) && !iss.classifications.length) issuer[4].why = nulls['issuer.classifications'] || 'The server supplied no sector classification for this issuer.';
  if (iss?.website !== undefined) issuer.push(row('issuer', 'website', 'Website', iss.website, { kind: 'link' }));
  const listing = [
    row('listing', 'exchange', 'Exchange', lst?.exchange), row('listing', 'symbol', 'Symbol on the exchange', lst?.symbol),
    row('listing', 'currency', 'Listing currency', lst?.currency),
    row('listing', 'marketCap', 'Market capitalization', lst?.marketCap, { units: lst?.currency || null, asOf: lst?.marketCapAsOf || asOf, kind: 'money' }),
    row('listing', 'sharesOutstanding', 'Shares outstanding', lst?.sharesOutstanding, { units: 'shares', asOf: lst?.sharesOutstandingAsOf || asOf, kind: 'count' }),
    row('listing', 'floatShares', 'Free-float shares', lst?.floatShares, { units: 'shares', asOf: lst?.floatSharesAsOf || lst?.sharesOutstandingAsOf || asOf, kind: 'count' }),
    row('listing', 'listedSince', 'Listed since', lst?.listedSince, { kind: 'date' }),
  ];
  if (lst?.marketCapBasis) listing[3].note = lst.marketCapBasis === 'server' ? 'as supplied by the server' : lst.marketCapBasis;
  const highlights = hi ? Object.keys(hi).filter((k) => k !== 'units' && k !== 'asOf' && (hi[k] === null || typeof hi[k] !== 'object')).map((k) => row('highlights', k, HIGHLIGHT_LABEL[k] || words(k), hi[k], {
    units: /PerShare|eps/i.test(k) ? `${hi.units || ccy || ''} per share`.trim() : /margin|yield|growth|pct/i.test(k) ? 'percent' : /ratio|^pe/i.test(k) ? 'times' : /TTM|revenue|income/i.test(k) ? hi.units || ccy : hi.units || null,
    asOf: hi.asOf || asOf, kind: 'number',
  })) : [];
  return { issuer, listing, highlights, nextEarnings: data?.nextEarnings || null };
}
