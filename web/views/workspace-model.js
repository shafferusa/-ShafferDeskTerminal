// Instrument-detail workspace: the parts that are plain logic, with no screen code, so the engine tests can load them
// (test/core/workspace-model.test.js). The screens are web/views/workspace.js (header, panels, tabs) and
// web/views/instrument-page.js (the full page); the drawer is web/views/instrument.js.
//
//   DATASETS        every dataset the workspace asks the Shaffer server for, with its route from docs/SERVER-CLIENT.md
//   TABS            the tabs, each with the datasets it shows
//   FAMILY_TABS     which tabs a product family gets, and what is "Not covered for this product" and why
//   workspaceTabs() the tab list for one instrument, from its family and what the server reports
//   gapOf()         Gap % beside a market price: passed through when supplied, worked out only when price and fair value
//                   are in the same currency, units and denominator and both present; otherwise the reason it is not shown
//   createSelection() one in-flight request set per selected instrument: a selection token, a requestId per request,
//                   abort on change, and any late or superseded response discarded
//
// Nothing here values an instrument: fair values, scores and supplied gaps come from Analytics Lab through the server.

// ---- datasets (docs/SERVER-CLIENT.md, section 3) -------------------------------------------------------------------------
export const DATASETS = {
  reference: { label: 'Reference data', iface: 'market', path: (id) => `/api/server/reference/${enc(id)}`, asOf: false },
  quotes: { label: 'Quotes', iface: 'market', path: (id) => '/api/server/quotes', query: (id) => ({ ids: id }), asOf: false },
  history: { label: 'Price history', iface: 'market', path: (id) => `/api/server/history/${enc(id)}`, asOf: true },
  fx: { label: 'FX rates', iface: 'market', path: () => '/api/server/fx', asOf: true },
  profile: { label: 'Company and listing profile', iface: 'market', path: (id) => `/api/server/profile/${enc(id)}`, asOf: true },
  statements: { label: 'Financial statements', iface: 'market', path: (id) => `/api/server/statements/${enc(id)}`, asOf: true },
  earnings: { label: 'Earnings calendar and results', iface: 'market', path: (id) => `/api/server/earnings/${enc(id)}`, asOf: true },
  earningsWindow: { label: 'Earnings-window eligibility', iface: 'analytics', path: (id) => `/api/server/earnings-window/${enc(id)}`, asOf: true },
  filings: { label: 'Filings and reports', iface: 'market', path: (id) => `/api/server/filings/${enc(id)}`, asOf: true },
  corporateActions: { label: 'Corporate actions', iface: 'market', path: (id) => `/api/server/corporate-actions/${enc(id)}`, asOf: true },
  news: { label: 'News and events', iface: 'market', path: (id) => `/api/server/news/${enc(id)}`, asOf: true },
  analytics: { label: 'Analytics for the selected Strategy', iface: 'analytics', path: (id) => `/api/server/analytics/${enc(id)}`, asOf: true },
  analyticsRuns: { label: 'Analytics runs', iface: 'analytics', path: (id) => `/api/server/analytics/${enc(id)}/runs`, asOf: false },
  ledger: { label: 'Paper ledger', iface: 'ledger', path: (id) => `/api/server/ledger/${enc(id)}`, asOf: false },
};
const enc = (s) => encodeURIComponent(s);

// ---- tabs ----------------------------------------------------------------------------------------------------------------
// `datasets` are asked for when the tab is shown. `own: true` marks a tab whose content this framework draws itself
// (Overview fields from the instrument, Price history, My positions and trades); the other contents are filled by
// registerTabContent() in workspace.js and fall back to a plain listing of what the server returned.
export const TABS = {
  overview: { label: 'Overview', datasets: ['reference', 'profile'], own: true },
  terms: { label: 'Overview and terms', datasets: ['reference'], own: true },
  history: { label: 'Price history', datasets: ['history'], own: true },
  marks: { label: 'Marks and history', datasets: ['history'], own: true },
  earnings: { label: 'Earnings', datasets: ['earnings', 'earningsWindow'] },
  statements: { label: 'Financial statements', datasets: ['statements'] },
  filings: { label: 'Filings and reports', datasets: ['filings'] },
  actions: { label: 'Corporate actions', datasets: ['corporateActions'] },
  distributions: { label: 'Distributions', datasets: ['corporateActions'] },
  news: { label: 'News and events', datasets: ['news'] },
  rates: { label: 'Rates', datasets: ['fx'] },
  chain: { label: 'Chain and contract months', datasets: [], own: true },
  analytics: { label: 'Analytics and risk', datasets: ['analytics', 'analyticsRuns'] },
  positions: { label: 'My positions and trades', datasets: ['ledger'], own: true },
};

const ISSUER_ELSEWHERE = 'They belong to the issuer, not to this contract: open the issuer\'s workspace.';
const UNDERLYING_ELSEWHERE = 'They belong to the underlying, not to this contract: open the underlying\'s workspace (Issuer financials).';
const NO_ROUTE = 'The Shaffer server contract has no route for it yet (docs/SERVER-CLIENT.md).';
/**
 * Product family -> tabs, plus what the contract does not cover for this product (listed, never shown as an empty tab).
 * `related`: 'issuer' (a security of an issuer that may have its own equity workspace), 'underlying' (a derivative).
 */
export const FAMILY_TABS = {
  equity: { group: 'Equities and issuer-linked securities', tabs: ['overview', 'history', 'earnings', 'statements', 'filings', 'actions', 'news', 'analytics', 'positions'], notCovered: [] },
  fund: {
    group: 'Funds', tabs: ['overview', 'history', 'distributions', 'filings', 'news', 'analytics', 'positions'],
    notCovered: [['Holdings, weights, NAV history and fees', NO_ROUTE], ['Earnings and financial statements', 'A fund reports its NAV, holdings and distributions, not company earnings or statements.']],
  },
  bond: {
    group: 'Bonds and debt securities', related: 'issuer', tabs: ['terms', 'history', 'filings', 'news', 'analytics', 'positions'],
    notCovered: [['Earnings and financial statements', ISSUER_ELSEWHERE], ['Corporate actions', 'Coupons, calls and redemptions follow the contract schedule (Overview and terms), not corporate actions.'], ['Ratings and covenants', NO_ROUTE]],
  },
  option: {
    group: 'Options', related: 'underlying', tabs: ['terms', 'chain', 'marks', 'analytics', 'positions'],
    notCovered: [['Earnings, financial statements, filings, corporate actions and news', UNDERLYING_ELSEWHERE], ['Greeks and implied volatility per contract', `${NO_ROUTE} The chain shows implied volatility where the feed supplies it.`]],
  },
  otcoption: {
    group: 'OTC options', related: 'underlying', tabs: ['terms', 'marks', 'analytics', 'positions'],
    notCovered: [['Earnings, financial statements, filings, corporate actions and news', UNDERLYING_ELSEWHERE], ['Greeks and volatility', NO_ROUTE]],
  },
  future: {
    group: 'Futures', related: 'underlying', tabs: ['terms', 'chain', 'marks', 'analytics', 'positions'],
    notCovered: [['Forward curve', NO_ROUTE], ['Earnings, financial statements, filings, corporate actions and news', UNDERLYING_ELSEWHERE]],
  },
  forward: { group: 'Forwards', related: 'underlying', tabs: ['terms', 'marks', 'analytics', 'positions'], notCovered: [['Earnings, financial statements, filings and news', 'A forward is a bilateral contract with no issuer of its own.']] },
  swap: {
    group: 'Swaps', related: 'underlying', tabs: ['terms', 'marks', 'analytics', 'positions'],
    notCovered: [['Earnings, financial statements, filings and news', 'A swap is a bilateral contract with no issuer of its own.'], ['Dealer marks history and collateral calls from the server', NO_ROUTE]],
  },
  cds: {
    group: 'Credit derivatives', related: 'underlying', tabs: ['terms', 'marks', 'analytics', 'positions'],
    notCovered: [['Financial statements of the reference entity', `${ISSUER_ELSEWHERE} The reference entity is linked under Related.`], ['Spread curve', NO_ROUTE]],
  },
  fx: { group: 'FX', tabs: ['overview', 'rates', 'history', 'news', 'analytics', 'positions'], notCovered: [['Earnings, financial statements, filings and corporate actions', 'A currency pair has no issuer.'], ['Rate curves and forward points', NO_ROUTE]] },
  spot: { group: 'Spot assets and commodities', tabs: ['overview', 'history', 'news', 'analytics', 'positions'], notCovered: [['Earnings, financial statements, filings and corporate actions', 'A spot asset has no issuer.']] },
  crypto: { group: 'Digital assets', tabs: ['overview', 'history', 'news', 'analytics', 'positions'], notCovered: [['Earnings, financial statements, filings and corporate actions', 'A digital asset has no issuer reporting to the server.']] },
  manual: { group: 'Manually valued holdings', related: 'issuer', tabs: ['terms', 'history', 'positions'], notCovered: [['Server research datasets', 'Valued by hand: the Shaffer server supplies no data for this product.']] },
  loan: { group: 'Financing arrangements', tabs: ['terms', 'positions'], notCovered: [['Market and research data', 'A financing arrangement of this Book: it has no market price or issuer data.']] },
  repo: { group: 'Financing arrangements', tabs: ['terms', 'positions'], notCovered: [['Market and research data', 'A financing arrangement of this Book: it has no market price or issuer data.']] },
  secloan: { group: 'Financing arrangements', tabs: ['terms', 'positions'], notCovered: [['Market and research data', 'A financing arrangement of this Book: it has no market price or issuer data.']] },
  cash: { group: 'Currency balances', tabs: ['terms', 'positions'], notCovered: [['Market and research data', 'A currency balance is ledger cash.']] },
};
const FALLBACK = { group: 'Other products', tabs: ['terms', 'history', 'positions'], notCovered: [] };

/**
 * The tab list of one instrument: its family's tabs, each with the state the server reports for its first dataset
 * (`serverState.datasets[key].state`, from GET /api/server/state), plus the "Not covered for this product" list.
 * A dataset the server reports as awaiting or unavailable keeps its tab (the tab then shows that state); the server
 * may also say a dataset is not covered for this product (`covered: false` or `notCovered: [family]`), and then the
 * tab is moved to the not-covered list with the server's reason.
 */
export function workspaceTabs(inst, serverState) {
  const fam = FAMILY_TABS[inst?.family] || FALLBACK;
  const ds = serverState?.datasets || {};
  const tabs = [], notCovered = fam.notCovered.map(([what, why]) => ({ what, why, by: 'terminal' }));
  for (const id of fam.tabs) {
    const t = TABS[id];
    const first = t.datasets[0];
    const s = first ? ds[first] : null;
    const off = s && (s.covered === false || (Array.isArray(s.notCovered) && s.notCovered.includes(inst.family)));
    if (off && !t.own) { notCovered.push({ what: t.label, why: s.coverageNote || s.note || 'The server reports it is not covered for this product.', by: 'server' }); continue; }
    tabs.push({ id, label: t.label, datasets: t.datasets, own: Boolean(t.own), state: first ? serverBadge(s) : null });
  }
  return { group: fam.group, related: fam.related || null, tabs, notCovered };
}
/** What a tab says about its dataset before it is opened: only a state that matters (not connected, refused, failing). */
export function serverBadge(s) {
  if (!s) return null;
  if (s.mapped === false) return 'awaiting';
  if (s.authBlocked) return 'error';
  return ['awaiting', 'error', 'stale', 'unavailable'].includes(s.state) ? s.state : null;
}
export const familyGroup = (family) => (FAMILY_TABS[family] || FALLBACK).group;

// ---- states --------------------------------------------------------------------------------------------------------------
export const STATES = ['awaiting', 'loading', 'available', 'stale', 'unavailable', 'incomplete', 'error'];
export const STATE_LABEL = { awaiting: 'Awaiting connection', loading: 'Loading', available: 'Available', stale: 'Stale', unavailable: 'Unavailable', incomplete: 'Incomplete', error: 'Error' };
export const STATE_TONE = { awaiting: '', loading: 'pen', available: 'ok', stale: 'warn', unavailable: '', incomplete: 'warn', error: 'bad' };
/** A server answer that is not an envelope (an older route) is read as available when it has data, else unavailable. */
export function stateOf(env) {
  if (!env) return 'loading';
  if (STATES.includes(env.state)) return env.state;
  if (env.available === false) return 'unavailable';
  return 'available';
}

// ---- Gap % -------------------------------------------------------------------------------------------------------------
const normUnits = (u) => String(u || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^per unit$/, 'per share');
/** Families whose price is a mark (NPV or upfront per 100 notional), which can be zero or negative: a percent gap against it misleads. */
const MARK_FAMILIES = new Set(['swap', 'cds', 'forward']);
/**
 * Gap % for one fair value beside the current market price.
 *   { price, priceCcy, priceUnits, family, fair, fairCcy, fairUnits, supplied }
 * Returns { value, basis: 'supplied'|'computed' } or { value: null, why }.
 * A supplied gap (Analytics Lab's own figure) is passed through as stated. A gap is worked out here only when both
 * numbers are present and in the same currency, the same quotation units and on a positive denominator; the formula is
 * (fair price - current market price) / current market price x 100.
 */
export function gapOf({ price, priceCcy, priceUnits, family, fair, fairCcy, fairUnits, supplied }) {
  if (isNum(supplied)) return { value: supplied, basis: 'supplied' };
  if (!isNum(fair)) return { value: null, why: 'No fair price supplied for this Strategy, so there is no gap.' };
  if (!isNum(price)) return { value: null, why: 'No current market price, so the gap is not shown.' };
  if (!fairCcy) return { value: null, why: 'The fair price does not state its currency, so it is not compared with the market price.' };
  if (priceCcy && fairCcy !== priceCcy) return { value: null, why: `The fair price is in ${fairCcy} and the market price in ${priceCcy}: not compared.` };
  if (!fairUnits) return { value: null, why: 'The fair price does not state its quotation units, so it is not compared with the market price.' };
  if (normUnits(fairUnits) !== normUnits(priceUnits)) return { value: null, why: `The fair price is quoted ${fairUnits} and the market price ${priceUnits}: not compared.` };
  if (MARK_FAMILIES.has(family)) return { value: null, why: 'This price is a mark per 100 notional that can be zero or negative: a percent gap against it would mislead.' };
  if (!(price > 0)) return { value: null, why: 'A percent gap needs a positive market price.' };
  return { value: ((fair - price) / price) * 100, basis: 'computed' };
}
/** The analytics record in one shape, whichever route supplied it (the server envelope's data, or the older quotes route). */
export function normalizeAnalytics(a) {
  if (!a) return null;
  return {
    strategyId: a.strategyId ?? a.strategy?.id ?? null, runId: a.runId ?? a.modelRun ?? null, version: a.version ?? null,
    calculatedAt: a.calculatedAt ?? a.asOf ?? null, inputCutoff: a.inputCutoff ?? null, horizon: a.horizon ?? null, historical: Boolean(a.historical),
    fundamentalFairValue: num(a.fundamentalFairValue), realisticFairValue: num(a.realisticFairValue),
    fairValueCurrency: a.fairValueCurrency ?? null, fairValueUnits: a.fairValueUnits ?? a.priceUnits ?? null,
    fundamentalGapPct: num(a.fundamentalGapPct ?? a.fundamentalGap), realisticGapPct: num(a.realisticGapPct ?? a.realisticGap),
    raw: a,
  };
}
const num = (x) => (isNum(x) ? x : null);
/** Change against the previous close, when the observation carries one. */
export function changeOf(obs) {
  if (!obs || !isNum(obs.value) || !isNum(obs.prevClose) || !obs.prevClose) return null;
  return { abs: obs.value - obs.prevClose, pct: (obs.value / obs.prevClose - 1) * 100 };
}

// ---- request discipline -------------------------------------------------------------------------------------------------
let selSeq = 0, reqSeq = 0;
/**
 * One selection = one instrument shown in one screen area (`channel`: 'drawer' or 'page'). Every request made for it
 * carries `requestId` and `selection`; `close()` aborts what is in flight. A response is used only if it is the latest
 * request for its dataset in a selection that is still open, and the server's echo of requestId / selection matches.
 * Anything else is discarded and reported to `onDiscard`, never drawn.
 *   fetchImpl(path, query, signal) -> Promise<response body>
 */
export function createSelection({ id, channel = 'default', asOf = null, fetchImpl, onDiscard = () => {} }) {
  const token = `${channel}:${id}:${++selSeq}`;
  const ctrl = new AbortController();
  const latest = new Map();
  let closed = false;
  const discard = (key, requestId, reason) => { onDiscard({ id, key, requestId, reason, selection: token }); return { discarded: true, reason }; };
  return {
    id, token, channel, asOf,
    get closed() { return closed; },
    close() { if (!closed) { closed = true; ctrl.abort(); } },
    /** `opts.asOf: false` asks for current data even in as-of mode (the execution quote context). */
    async request(key, path, query = {}, opts = {}) {
      const requestId = `${token}:${key}:${++reqSeq}`;
      latest.set(key, requestId);
      const q = { ...query, requestId, selection: token, channel };
      if (asOf && opts.asOf !== false) q.asOf = asOf;
      let body;
      try {
        body = await fetchImpl(path, q, ctrl.signal);
      } catch (err) {
        if (closed || ctrl.signal.aborted || err?.name === 'AbortError') return discard(key, requestId, 'aborted');
        if (latest.get(key) !== requestId) return discard(key, requestId, 'superseded by a newer request');
        throw err;
      }
      if (closed) return discard(key, requestId, 'the selection changed');
      if (latest.get(key) !== requestId) return discard(key, requestId, 'superseded by a newer request');
      if (body && typeof body === 'object' && body.requestId && body.requestId !== requestId) return discard(key, requestId, 'the response is for another request');
      if (body && typeof body === 'object' && body.selection && body.selection !== token) return discard(key, requestId, 'the response is for another selection');
      if (body?.error?.code === 'superseded') return discard(key, requestId, 'superseded on the server');
      const subject = body?.instrument?.terminalId ?? body?.data?.instrumentId ?? body?.instrumentId ?? null;
      const alias = [body?.instrument?.ids?.terminal, body?.instrument?.ids?.server, body?.data?.ids?.terminal, body?.data?.ids?.server];
      if (subject && subject !== id && !alias.includes(id)) return discard(key, requestId, `the response is for instrument ${subject}`);
      return { body, requestId };
    },
  };
}

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** The refresh interval of a dataset in ms: the server's per-dataset setting, else the Terminal's settings, else none. */
export function refreshMs(key, serverRefresh, terminalRefresh) {
  const s = serverRefresh?.[key] || serverRefresh?.datasets?.[key];
  if (s) return s.mode === 'on-demand' ? null : isNum(s.intervalSec) && s.intervalSec > 0 ? s.intervalSec * 1000 : null;
  const t = terminalRefresh || {};
  if (key === 'quotes') return t.quotesMs || null;
  if (key === 'fx') return t.fxMs || null;
  if (key === 'analytics' || key === 'analyticsRuns' || key === 'earningsWindow') return t.analyticsMs || null;
  if (key === 'ledger') return t.uiPollMs || null;
  return t.referenceMs || null;
}
