// Instrument-detail workspace framework, shared by the quick overview drawer (instrument.js) and the full detail page
// (instrument-page.js, #/instrument/<id>/<tab>):
//   - WorkspaceHeader: the sticky header (identity, execution quote context, Fair price and Gap % for the chosen
//     investment Strategy, holdings long and short by owner, Trade / Build strategy / Hedge)
//   - useSelection / useDataset: one in-flight request set per selected instrument (workspace-model.js), with the
//     per-dataset state of docs/SERVER-CLIENT.md (awaiting, loading, available, stale, unavailable, incomplete, error)
//   - DatasetPanel: every panel draws its dataset's state, source, timestamps, refresh interval and a Refresh button
//   - the tab contents this framework owns (Overview / terms, Price history, Chain, My positions and trades) and
//     registerTabContent() for the contents colleagues fill in (Earnings, Financial statements, Filings, ...)
// Data comes from the Shaffer server routes; a route the server does not have yet is drawn as awaiting. Nothing here
// values an instrument or fabricates a missing figure.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { currentBook, fmtAge, fmtNum, fmtPrice, fmtPriceUnits, fmtQty, fmtTime, get, getState, isNum, openOverlay, post, setState, toastError, useLive, useStore, VIEW_LABEL } from '../lib/core.js';
import { Awaiting, Button, Empty, Holdings, holdingsFromPositions, KV, LineChart, Missing, Modal, Money, Notice, Pill, Price, Prov, Seg, Select, Signed, Table } from '../lib/ui.js';
import { changeOf, createSelection, DATASETS, familyGroup, gapOf, normalizeAnalytics, refreshMs, STATE_LABEL, STATE_TONE, stateOf } from './workspace-model.js';

// ---- transport ---------------------------------------------------------------------------------------------------------
/**
 * GET with an abort signal. A route the server does not have (404 "Not found") is answered here as an "awaiting"
 * envelope, so the panel says the connection is not there yet instead of failing. A non-2xx envelope is returned as
 * it is (state error, with its error record); anything else throws.
 */
export async function wsFetch(path, query, signal) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const res = await fetch(`${path}${q.toString() ? `?${q}` : ''}`, { signal });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 404 && body?.error === 'Not found') {
    return { state: 'awaiting', notBuilt: true, requestId: query?.requestId, selection: query?.selection, source: null, message: `Awaiting Shaffer data connection (${path.replace(/\/[^/]*$/, '').replace(/^\/api\/server\//, '')} is not served by this Terminal yet)` };
  }
  if (!res.ok) {
    if (body && body.state) return body;
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}
// Discarded responses, for the workspace test (test/w1-workspace.browser.mjs reads window.__sdtWs).
const discards = [];
if (typeof window !== 'undefined') window.__sdtWs = { discards };
const onDiscard = (d) => { discards.push({ ...d, at: Date.now() }); if (discards.length > 200) discards.shift(); };

/** One selection per instrument shown in a screen area; closed (in-flight requests aborted) when the instrument changes. */
export function useSelection(id, channel, asOf = '') {
  const sel = useMemo(() => createSelection({ id, channel, asOf: asOf || null, fetchImpl: wsFetch, onDiscard }), [id, channel, asOf]);
  useEffect(() => () => sel.close(), [sel]);
  return sel;
}

/**
 * One dataset for the current selection: { state, env, error, refresh(fresh), busy, requestId }.
 * `path`/`query` default to the dataset's route; `fallback(sel)` answers when the server route is not built yet with an
 * older route of the same data (e.g. the existing price history route). `live` reloads quietly when the engine reports
 * a change; `interval` (ms) reloads quietly on that interval.
 */
export function useDataset(sel, key, { path, query = {}, enabled = true, fallback, live = false, interval = null, asOf } = {}) {
  const def = DATASETS[key];
  const p = path || def?.path(sel.id);
  const q = { ...(def?.query ? def.query(sel.id) : {}), ...query };
  const qKey = JSON.stringify(q);
  const [box, setBox] = useState({ token: null, env: null, error: null, busy: false });
  const tick = useStore((s) => s.tick);
  const run = (fresh, quiet) => {
    if (!enabled) return;
    setBox((b) => (b.token === sel.token && quiet ? { ...b, busy: !quiet } : { token: sel.token, env: b.token === sel.token ? b.env : null, error: null, busy: true }));
    const wantAsOf = asOf !== undefined ? asOf : def ? def.asOf : false;
    sel.request(key, p, fresh ? { ...q, fresh: 1 } : q, { asOf: wantAsOf }).then(async (r) => {
      if (r.discarded) return;
      let env = r.body;
      if (env?.notBuilt && fallback) {
        const fb = await fallback(sel, q).catch((err) => ({ state: 'error', error: { message: err.message, retryable: true } }));
        if (sel.closed) return;
        env = { ...fb, requestId: r.requestId };
      }
      setBox((b) => (b.token === sel.token ? { token: sel.token, env, error: null, busy: false, at: Date.now() } : b));
    }, (error) => setBox((b) => (b.token === sel.token ? { ...b, error, busy: false } : b)));
  };
  useEffect(() => { run(false, false); }, [sel, qKey, enabled]);
  useEffect(() => { if (live && tick) run(false, true); }, [tick]);
  useEffect(() => {
    if (!interval || !enabled) return undefined;
    const t = setInterval(() => { if (!document.hidden) run(false, true); }, interval);
    return () => clearInterval(t);
  }, [sel, qKey, interval, enabled]);
  // Until this selection's own answer arrives nothing of an earlier selection is shown.
  const mine = box.token === sel.token;
  const env = mine ? box.env : null;
  const error = mine ? box.error : null;
  const state = !enabled ? 'unavailable' : error ? 'error' : env ? stateOf(env) : 'loading';
  return { key, label: def?.label || key, state, env, error, busy: mine && box.busy, at: mine ? box.at : null, interval, refresh: () => run(true, false), sel };
}

/** Per-dataset refresh settings: the server's (GET /api/server/refresh), else the Terminal's settings. */
export function useRefreshSettings() {
  const r = useLive(() => wsFetch('/api/server/refresh', {}).catch(() => null), [], { interval: false });
  const status = useStore((s) => s.status);
  return (key) => refreshMs(key, r.data && !r.data.notBuilt ? (r.data.refresh || r.data.data || r.data) : null, status?.data?.refresh);
}
/** What the server reports per dataset (GET /api/server/state), for tab badges and coverage; null until it answers. */
export function useServerState() {
  const r = useLive(() => wsFetch('/api/server/state', {}).catch(() => null), [], { interval: false });
  return r.data && !r.data.notBuilt ? r.data : null;
}

// ---- the investment Strategy chosen in the workspace -------------------------------------------------------------------
// Chosen by its ID from the Strategy list; shared by the drawer and the page in this browser tab. Outputs of two
// Strategies are never blended: everything analytical is asked for this one ID.
const STRAT_KEY = 'sdt.ws.strategy';
const loadStrategy = () => { try { return JSON.parse(sessionStorage.getItem(STRAT_KEY) || 'null'); } catch { return null; } };
export function useWorkspaceStrategy() {
  const s = useStore((st) => st.wsStrategy);
  const value = s === undefined ? loadStrategy() : s;
  const set = (v) => { try { if (v) sessionStorage.setItem(STRAT_KEY, JSON.stringify(v)); else sessionStorage.removeItem(STRAT_KEY); } catch { /* per-tab convenience */ } setState({ wsStrategy: v || null }); };
  return [value, set];
}
function StrategyChooser({ value, onChange }) {
  const res = useLive(() => get('/api/analytics/strategies'), [], { interval: false });
  const d = res.data;
  if (!d) return html`<span class="muted small">Loading the Strategy list…</span>`;
  if (!d.available) return html`<span class="small" title=${d.awaitingMessage}><${Missing} reason=${`Strategy list: ${d.awaitingMessage}`} /> <span class="muted">Strategy list awaiting</span></span>`;
  return html`<span class="ws-strat" title=${`List supplied by ${d.source?.label || 'Analytics Lab'}. The Strategy's ID is what is asked for.`}><${Select} value=${value?.id || ''} placeholder="Choose a Strategy"
    options=${d.items.map((s) => ({ value: s.id, label: `${s.name} (${s.id})` }))}
    onChange=${(id) => { const s = d.items.find((x) => x.id === id); onChange(s ? { id: s.id, name: s.name, resolved: true, source: d.source?.label, version: s.version } : null); }} />
    ${d.source?.kind && d.source.kind !== 'shaffer-analytics' ? html`<span class="pill warn" title=${d.source.label}>fixture list</span>` : null}</span>`;
}

// ---- state rendering -----------------------------------------------------------------------------------------------------
const shortId = (rid) => (rid ? String(rid).split(':').slice(-1)[0] : '');
export function StatePill({ state }) {
  return html`<${Pill} tone=${STATE_TONE[state] || ''} title=${STATE_LABEL[state] || state}>${(STATE_LABEL[state] || state || '').toLowerCase()}<//>`;
}
/** Source, timestamps, version, refresh interval and the request it came from. */
function DatasetMeta({ ds }) {
  const e = ds.env;
  if (!e || e.notBuilt) return null;
  const src = e.source?.label || (typeof e.source === 'string' ? e.source : null);
  const age = e.freshness?.ageSec;
  const bits = [
    src ? html`<span>Source: ${src}${e.source?.fixture ? html` <span class="pill warn">fixture</span>` : ''}</span>` : null,
    e.asOf ? html`<span>As of ${fmtTime(e.asOf)}${isNum(age) ? ` (${fmtAge(age)})` : ''}</span>` : null,
    e.receivedAt ? html`<span>received ${fmtTime(e.receivedAt, { date: false, seconds: true })}</span>` : null,
    e.version ? html`<span>version ${e.version}</span>` : null,
    e.cached ? html`<span>from the server cache</span>` : null,
    html`<span>${ds.interval ? `refreshes every ${Math.round(ds.interval / 1000)} s` : 'refreshed on demand'}</span>`,
    e.requestId ? html`<span title=${e.requestId}>request ${shortId(e.requestId)}</span>` : null,
  ].filter(Boolean);
  return html`<div class="ws-meta">${bits.map((b, i) => html`${i ? ', ' : ''}${b}`)}</div>`;
}
/** The as-of line every panel carries on the page: what point in time it shows. */
function AsOfLine({ ds, asOf }) {
  if (!asOf) return null;
  const def = DATASETS[ds.key];
  if (def && !def.asOf) return html`<div class="ws-asof cur">Current information: a research date does not apply to ${ds.label.toLowerCase()}.</div>`;
  const pit = ds.env?.pointInTime;
  if (pit && pit.supported === false) return html`<div class="ws-asof no">As of ${asOf} is not supported by the server contract for ${ds.label.toLowerCase()}${pit.note ? ` (${pit.note})` : ''}. Nothing is shown in its place.</div>`;
  if (ds.state === 'available' || ds.state === 'stale' || ds.state === 'incomplete') return html`<div class="ws-asof">As of ${asOf}, as it was known then.</div>`;
  return html`<div class="ws-asof">Asked as of ${asOf}, as it was known then.</div>`;
}
/**
 * The state block of a dataset, or its content. `children(env)` draws the content for available, stale and incomplete
 * answers; the states with no content say why there is none. Never an empty table.
 */
export function DatasetBody({ ds, asOf, children, what }) {
  const e = ds.env;
  // The server's sentence, without a leading state word the pill and the bold label already say.
  const msg = e?.message ? String(e.message).replace(/^(stale|incomplete|unavailable|error)\s*[:.]\s*/i, '').replace(/^./, (c) => c.toUpperCase()) : null;
  const body = () => (typeof children === 'function' ? children(e) : children);
  switch (ds.state) {
    case 'loading': return html`<div class="ws-loading" aria-busy="true">Loading ${ds.label.toLowerCase()}…</div>`;
    case 'awaiting': return html`<${Awaiting} compact what=${`${what || ds.label}. ${msg && msg !== 'Awaiting Shaffer data connection' ? msg.replace(/^Awaiting Shaffer data connection\s*/, '').replace(/^\((.*)\)$/, '$1') : 'Not connected yet.'}`} />`;
    case 'unavailable': return html`<${Empty} title=${e?.pointInTime?.supported === false ? `Not available as of ${asOf || e.pointInTime.requested || 'that date'}` : `No ${ds.label.toLowerCase()} for this instrument`}>${msg || 'The server answered with no data for this instrument. Nothing is shown in its place.'}<//>`;
    case 'error': {
      const er = e?.error || { message: ds.error?.message, retryable: true };
      const blocked = er.retryable === false || er.status === 401 || er.status === 403;
      return html`<${Notice} tone="err"><b>${ds.label} could not be loaded.</b> ${er.message || msg || ''}${er.attempts > 1 ? ` (${er.attempts} attempts)` : ''} ${blocked ? 'The server refused access, so it is not asked again until the connection settings change.' : 'Choose Refresh to ask again.'}<//>`;
    }
    case 'stale': return html`<div class="stack"><${Notice} tone="warn"><b>Stale.</b> ${msg || `This data is older than its freshness limit${isNum(e?.freshness?.staleAfterSec) ? ` (${fmtAge(e.freshness.staleAfterSec).replace(' ago', '')})` : ''}.`}${e?.error ? ` The last refresh failed: ${e.error.message}` : ''}<//>${body()}</div>`;
    case 'incomplete': return html`<div class="stack"><${Notice} tone="warn"><b>Incomplete.</b> ${msg || `Some fields are missing from the server's answer${e?.missingFields?.length ? `: ${e.missingFields.join(', ')}` : ''}.`} Missing values are shown as missing.<//>${body()}</div>`;
    default: return body();
  }
}
/** A panel for one dataset: its state pill, Refresh, the as-of line, the content or the state, and where it came from. */
export function DatasetPanel({ ds, title, note, asOf, children, what, actions, flush }) {
  return html`<section class="panel ws-panel" data-ws-dataset=${ds.key} data-ws-state=${ds.state} data-ws-inst=${ds.sel?.id}>
    <header><h3>${title || ds.label}</h3>${note ? html`<span class="note">${note}</span>` : null}<span class="grow"></span>
      <${StatePill} state=${ds.state} />${actions}
      <${Button} small busy=${ds.busy && ds.state !== 'loading'} onClick=${() => ds.refresh()} title=${`Ask the server again for ${ds.label.toLowerCase()} (bypasses the cache)`}>Refresh<//></header>
    <div class=${`body ${flush && ['available', 'stale', 'incomplete'].includes(ds.state) ? 'flush' : ''}`}><${AsOfLine} ds=${ds} asOf=${asOf} /><${DatasetBody} ds=${ds} asOf=${asOf} what=${what}>${children}<//><${DatasetMeta} ds=${ds} /></div>
  </section>`;
}

// ---- header -------------------------------------------------------------------------------------------------------------
/** Fair price and Gap % for one basis (Fundamental or Realistic). */
function fairCell(a, kind, inst, obs) {
  const fair = a ? a[`${kind}FairValue`] : null;
  const g = gapOf({ price: obs?.value, priceCcy: obs?.currency || inst.tradingCcy, priceUnits: obs?.units || inst.priceUnits, family: inst.family, fair, fairCcy: a?.fairValueCurrency, fairUnits: a?.fairValueUnits, supplied: a ? a[`${kind}GapPct`] : null });
  return { fair, g };
}
/**
 * The sticky header. `detail` is GET /api/instruments/:id/detail (the Terminal's execution quote context and holdings);
 * `analytics` the dataset for the chosen Strategy; `reference` the server reference record (stable server ID).
 */
export function WorkspaceHeader({ inst, detail, analytics, reference, strategy, setStrategy, book, onTrade, onBuild, onHedge, onOpenPage, page }) {
  const obs = detail?.observation || null;
  const ch = changeOf(obs);
  const aRaw = analytics?.env?.data || analytics?.env?.analytics || null;
  const a0 = normalizeAnalytics(aRaw);
  // Outputs for another Strategy than the one chosen are never shown under it.
  const wrongStrategy = a0 && strategy?.id && a0.strategyId && a0.strategyId !== strategy.id;
  const a = wrongStrategy ? null : a0;
  const f = fairCell(a, 'fundamental', inst, obs), r = fairCell(a, 'realistic', inst, obs);
  const serverId = reference?.env?.data?.ids?.server || inst.externalIds?.shaffer || null;
  const held = holdingsFromPositions(detail?.positions);
  const aState = !strategy ? null : analytics?.state;
  const fairWhy = !strategy ? 'Choose a Strategy to see its fair price and Gap %.' : wrongStrategy ? `Supplied for Strategy ${a0.strategyId}, not ${strategy.id}: not shown.`
    : aState === 'awaiting' ? `Fair price: ${analytics.env?.message || 'Awaiting Shaffer data connection'}` : aState === 'loading' ? 'Loading' : aState === 'error' ? 'Analytics could not be loaded' : 'Not supplied by Analytics Lab for this instrument';
  const fv = (x) => (isNum(x.fair) ? html`${fmtPriceUnits(x.fair, a?.fairValueUnits || inst.priceUnits)}${a?.fairValueCurrency && a.fairValueCurrency !== (obs?.currency || inst.tradingCcy) ? html` <span class="muted">${a.fairValueCurrency}</span>` : ''}` : html`<${Missing} reason=${a ? 'Not supplied for this basis' : fairWhy} />`);
  const gv = (x) => (isNum(x.g.value) ? html`<span title=${x.g.basis === 'supplied' ? `As supplied by Analytics Lab${a?.raw?.gapReference && isNum(a.raw.gapReference.price) ? `, against its reference price ${fmtPrice(a.raw.gapReference.price)} ${a.raw.gapReference.units || ''} at calculation time, not the current market price` : ''}` : 'Worked out here: (fair price − current market price) ÷ current market price, same currency and units'}><${Signed} value=${x.g.value} suffix="%" />${x.g.basis === 'computed' ? html`<sup class="muted">c</sup>` : ''}</span>` : html`<${Missing} reason=${a ? x.g.why : fairWhy} />`);
  return html`<div class=${`ws-head ${page ? 'page' : ''}`} data-ws-inst=${inst.id} data-testid="ws-header">
    <div class="ws-idline">
      ${page ? html`<h1 class="ws-title">${inst.symbol ? html`<span class="sym">${inst.symbol}</span> ` : null}${inst.name}</h1>` : null}
      <span class="ws-facts">${inst.support.productName.replace(/ \(.*\)$/, '')}, ${inst.venue || (inst.venueType === 'otc' ? 'OTC' : inst.venueType === 'global' ? 'global' : 'no venue')}, ${inst.tradingCcy}</span>
      <span class="ws-ids muted small">Terminal ID ${inst.id}, server ID ${serverId ? html`<span class="mono">${serverId}</span>` : html`<${Missing} reason=${reference?.state === 'awaiting' ? 'Linked when Shaffer reference data is connected' : 'No server ID in the reference record'} />`}</span>
    </div>
    <div class="ws-quote">
      <div class="ws-q"><span class="k">Current market price</span><span class="v"><${Price} obs=${obs} units=${inst.priceUnits} reason=${detail?.marketState?.connection === 'awaiting' ? detail.marketState.message : 'No price available'} /></span>
        <span class="s">${obs ? html`${obs.source}, ${fmtTime(obs.asOf, { seconds: true })}` : inst.priceUnits}</span></div>
      <div class="ws-q"><span class="k">Bid / ask</span><span class="v sm">${obs && isNum(obs.bid) ? `${fmtPriceUnits(obs.bid, inst.priceUnits)} / ${fmtPriceUnits(obs.ask, inst.priceUnits)}` : html`<${Missing} reason="No bid or ask in the latest observation" />`}</span>
        <span class="s">${obs && isNum(obs.bidSize) ? `${fmtQty(obs.bidSize)} x ${fmtQty(obs.askSize)}` : ''}</span></div>
      <div class="ws-q"><span class="k">Change</span><span class="v sm">${ch ? html`<${Signed} value=${ch.pct} suffix="%" />` : html`<${Missing} reason="No previous close in the latest observation" />`}</span>
        <span class="s">${ch ? `${fmtNum(ch.abs, 2, { sign: true })} since the previous close` : ''}</span></div>
      <div class="ws-q"><span class="k">Fair price</span><span class="v sm" title="Fundamental, then realistic">${fv(f)}<span class="muted"> / </span>${fv(r)}</span><span class="s">fundamental / realistic</span></div>
      <div class="ws-q"><span class="k">Gap %</span><span class="v sm">${gv(f)}<span class="muted"> / </span>${gv(r)}</span><span class="s">fundamental / realistic</span></div>
    </div>
    <div class="ws-ctx">
      <span class="ws-lbl">Investment Strategy</span><${StrategyChooser} value=${strategy} onChange=${setStrategy} />
      <span class="small muted">${a ? html`horizon ${a.horizon || html`<${Missing} reason="Not supplied" />`}, calculated ${a.calculatedAt ? fmtTime(a.calculatedAt) : html`<${Missing} reason="Not supplied" />`}${a.runId ? `, run ${a.runId}` : ''}${a.historical ? html` <span class="pill warn">historical run</span>` : ''}`
        : strategy ? html`horizon and analytical time: ${aState === 'awaiting' ? 'awaiting' : 'not supplied'}` : 'Fair price and Gap % follow the Strategy chosen here; outputs are never blended.'}</span>
    </div>
    <div class="ws-held small"><${Holdings} h=${held} detail label=${`${book?.name || 'This Book'} holds`} /></div>
    <div class="ws-acts">
      <${Button} small kind="primary" onClick=${onTrade} title="Open the trade ticket with this instrument, the Book's trading owner and the Strategy chosen here">Trade<//>
      <${Button} small onClick=${onBuild} title="Open the Strategies page with this instrument, owner and Strategy">Build strategy<//>
      <${Button} small onClick=${onHedge} title="Ask for hedge instructions on a position held in this instrument">Hedge<//>
      ${onOpenPage ? html`<${Button} small onClick=${onOpenPage} title="Open the full detail page with every tab">Open full page<//>` : null}
    </div>
  </div>`;
}

// ---- actions ------------------------------------------------------------------------------------------------------------
const HANDOFF_KEY = 'sdt.ws.handoff';
/** Build strategy: the Strategies page opens with this instrument; the owner is the one in use; the Strategy is handed over. */
export function buildStrategy(inst, strategy) {
  const b = currentBook();
  try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ instrumentId: inst.id, bookId: b?.id, unitId: getState().unitId, strategy: strategy || null, at: Date.now() })); } catch { /* the page still opens with the instrument */ }
  location.hash = `#/strategy/for/${encodeURIComponent(inst.id)}`;
}
/** The Strategy handed over by Build strategy, once, for the Strategies page (strategy.js). */
export function takeStrategyHandoff(instrumentId, bookId) {
  try {
    const h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
    if (!h || h.instrumentId !== instrumentId || (bookId && h.bookId !== bookId) || Date.now() - h.at > 10 * 60e3) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    return h.strategy || null;
  } catch { return null; }
}
/**
 * Hedge: a hedge request on a position held in this instrument (the owner in use first), with the Strategy chosen in
 * the workspace when there is one; the popup then shows the request and what Analytics Lab proposes. Nothing is traded
 * without the package preview's confirmation. With no position, a hedge is asked with a package on the Strategies page.
 */
export async function hedgeFromWorkspace({ inst, detail, book, strategy }) {
  const unitId = getState().unitId;
  const withStrat = (detail?.positions || []).filter((p) => p.strategy?.id);
  const mine = withStrat.filter((p) => p.unitId === unitId);
  const pool = mine.length ? mine : withStrat;
  const go = async (p) => {
    try {
      const s = await get(`/api/strategies/${p.strategy.id}`, { bookId: book.id });
      const { strategyInput, HedgePopup } = await import('./hedge.js');
      const r = await post('/api/hedge/requests', {
        bookId: book.id, unitId: s.unit.id, strategyId: s.id, scope: { type: 'trade' }, trigger: 'manual',
        investmentStrategy: strategy ? strategyInput(strategy) : strategyInput(s.hedge?.investmentStrategy || s.investmentStrategy), holdingPeriod: s.holdingPeriod, objective: s.params?.hedgeObjective || null,
      });
      openOverlay((close) => html`<${HedgePopup} request=${r} onClose=${close} />`);
    } catch (err) { toastError(err); }
  };
  if (pool.length === 1) return go(pool[0]);
  openOverlay((close) => html`<${Modal} title=${`Hedge ${inst.symbol || inst.name}`} size="mid" onClose=${close}
    sub=${pool.length ? 'Choose the position to protect. The request is sized against that position and the protection it already has.' : null}>
    ${pool.length ? html`<${Table} rows=${pool} rowKey=${(p) => p.positionId} columns=${[
      { label: 'Held in', render: (p) => p.owner }, { label: 'Strategy instance', render: (p) => p.strategy?.name },
      { label: 'Quantity', align: 'r', render: (p) => fmtQty(p.qty) },
      { label: '', align: 'r', render: (p) => html`<${Button} small onClick=${() => { close(); go(p); }}>Ask for a hedge<//>` }]} />`
      : html`<div class="stack"><p>${book.name} holds no position in ${inst.symbol || inst.name}, so there is no exposure to hedge yet.</p>
        <p class="note">To trade it with protection, build it on the Strategies page: the package preview includes the hedge instructions Analytics Lab supplies.</p>
        <div><${Button} kind="primary" onClick=${() => { close(); buildStrategy(inst, strategy); }}>Build strategy with this instrument<//></div></div>`}
  <//>`);
  return null;
}

// ---- tab contents registry ----------------------------------------------------------------------------------------------
const CONTENT = new Map();
/** A colleague's tab content: Comp receives { inst, ds: { [datasetKey]: dataset }, asOf, sel, book, detail }. */
export function registerTabContent(tabId, Comp) { CONTENT.set(tabId, Comp); }
export const tabContent = (tabId) => CONTENT.get(tabId) || null;

/** What the server returned, listed plainly, until the tab's own view is registered. */
export function PlainListing({ env }) {
  const items = env?.items || (Array.isArray(env?.data) ? env.data : null);
  if (items) {
    if (!items.length) return html`<${Empty} title="Nothing listed">The server answered with an empty list.<//>`;
    const keys = Object.keys(items[0]).filter((k) => items.slice(0, 10).every((x) => x[k] === null || ['string', 'number', 'boolean'].includes(typeof x[k]))).slice(0, 7);
    return html`<${Table} rows=${items.slice(0, 100)} columns=${keys.map((k) => ({ label: k, align: typeof items[0][k] === 'number' ? 'r' : '', render: (x) => (x[k] === null || x[k] === undefined ? html`<${Missing} reason="Not supplied" />` : typeof x[k] === 'number' ? fmtNum(x[k], 2) : String(x[k])) }))} />
      ${env.pagination?.nextCursor || (env.pagination?.totalPages > 1) ? html`<p class="note">More pages are available on the server (${env.pagination.totalItems ?? 'more'} items in all).</p>` : null}`;
  }
  if (env?.data && typeof env.data === 'object') return html`<${PlainObject} o=${env.data} nulls=${env.nulls} />`;
  return html`<${Empty}>The server answered with nothing to show.<//>`;
}

const words = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (m, c) => ` ${c.toLowerCase()}`);
const scalar = (v, reason) => (v === null || v === undefined ? html`<${Missing} reason=${reason || 'Not supplied'} />` : typeof v === 'number' ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
/** A data object as labelled values, one heading per nested object; arrays of records as small lists. */
function PlainObject({ o, nulls = {} }) {
  const flat = Object.entries(o).filter(([, v]) => v === null || typeof v !== 'object');
  const nested = Object.entries(o).filter(([, v]) => v && typeof v === 'object');
  const val = (v) => (Array.isArray(v) ? (v.every((x) => x === null || typeof x !== 'object') ? v.join(', ') : v.map((x) => Object.values(x).filter((y) => y !== null && typeof y !== 'object').join(', ')).join('; ')) : v && typeof v === 'object' ? Object.entries(v).filter(([, y]) => y === null || typeof y !== 'object').map(([k, y]) => `${words(k)} ${y ?? '—'}`).join(', ') : scalar(v));
  return html`<div class="ws-plain">${flat.length ? html`<${KV} rows=${flat.map(([k, v]) => [words(k), scalar(v, nulls[k])])} />` : null}
    ${nested.map(([k, v]) => html`<h4>${words(k)}</h4>${Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? html`<${RecordTable} rows=${v} />` : Array.isArray(v) ? html`<div class="small">${val(v) || html`<span class="muted">None listed</span>`}</div>` : html`<${KV} rows=${Object.entries(v).map(([k2, v2]) => [words(k2), v2 && typeof v2 === 'object' ? val(v2) : scalar(v2)])} />`}`)}</div>`;
}

/** Records as a small table: their plain fields as columns, a nested object as "key value" text. */
function RecordTable({ rows }) {
  const keys = [...new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))].slice(0, 9);
  const cell = (v) => (v === null || v === undefined ? html`<${Missing} reason="Not supplied" />` : typeof v === 'object' ? html`<span class="small">${Object.entries(v).slice(0, 6).map(([a, b]) => `${a} ${b === null ? '—' : typeof b === 'object' ? '…' : b}`).join(', ')}</span>` : scalar(v));
  return html`<div class="tablewrap"><table class="ledger tight"><thead><tr>${keys.map((k) => html`<th>${words(k)}</th>`)}</tr></thead>
    <tbody>${rows.slice(0, 40).map((r) => html`<tr>${keys.map((k) => html`<td class=${typeof r[k] === 'number' ? 'r' : ''}>${cell(r[k])}</td>`)}</tr>`)}</tbody></table></div>${rows.length > 40 ? html`<p class="note">${rows.length - 40} more not listed.</p>` : null}`;
}

// ---- related issuer / underlying ----------------------------------------------------------------------------------------
export const pageHref = (id, tab) => `#/instrument/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;
/** The workspace of the underlying, or of the issuer's equity, linked as such; its statements are never shown as this contract's. */
export function Related({ inst, related, reference }) {
  const und = inst.underlying;
  const issuerRef = reference?.env?.data?.issuer || null;
  const iss = useLive(async () => {
    if (related !== 'issuer' || !inst.issuer) return null;
    const r = await get('/api/instruments', { q: inst.issuer, family: 'equity', limit: 20 });
    return r.items.find((i) => i.issuer === inst.issuer && i.id !== inst.id) || null;
  }, [inst.id, related], { interval: false });
  const rows = [];
  if (und) {
    rows.push(['Underlying', html`<a href=${pageHref(und.id)}><span class="sym">${und.symbol || und.name}</span></a> <span class="muted">${und.symbol ? und.name : ''}</span>`]);
    rows.push(['Issuer financials', html`<a href=${pageHref(und.id, 'statements')}>Financial statements of ${und.symbol || und.name}</a><div class="sub">The underlying's own statements, on its workspace. They are not this contract's.</div>`]);
  } else if (inst.terms?.referenceEntity) {
    rows.push(['Reference entity', html`${inst.terms.referenceEntity} <span class="muted small">(no workspace linked: the reference entity is not registered as an instrument)</span>`]);
  }
  if (related === 'issuer' && inst.issuer) {
    const eq = iss.data;
    rows.push(['Issuer', html`${issuerRef?.name || inst.issuer}${issuerRef?.id ? html` <span class="muted small">${issuerRef.id}</span>` : ''}`]);
    rows.push(['Issuer financials', eq ? html`<a href=${pageHref(eq.id, 'statements')}>Financial statements on ${eq.symbol || eq.name}'s workspace</a><div class="sub">Matched by issuer name in the Terminal's instrument registry. They are the issuer's statements, not this security's.</div>`
      : iss.data === null && !iss.loading ? html`<${Missing} reason="No equity of this issuer is registered in the Terminal" /> <span class="muted small">No equity of ${inst.issuer} is registered.</span>` : html`<span class="muted">Looking…</span>`]);
  }
  if (!rows.length) return null;
  return html`<section class="panel"><header><h3>Related</h3><span class="note">Linked workspaces; their data stays theirs</span></header><div class="body"><${KV} rows=${rows} /></div></section>`;
}

// ---- Overview and terms (product-specific fields from the instrument and its contract terms) ----------------------------
const FIELDS_NOTE = {
  bond: 'Issuer, coupon, maturity, quote convention, accrued interest and schedules come from the contract terms. Yield and spread only when the server supplies them with the price.',
  option: 'Underlying, strike, expiry, exercise and settlement terms and multiplier come from the contract terms. Greeks and volatility only when the server supplies them.',
  future: 'Contract month, multiplier, tick, settlement and delivery terms and margin come from the contract terms.',
  swap: 'Reference exposure, pay and receive legs, schedules, financing and collateral terms come from the contract terms. Marks are dealer, model or manual: the chip says which.',
  cds: 'Reference entity, running coupon, schedule and collateral terms come from the contract terms.',
  fx: 'Base and quote currencies, quotation direction and calendars.',
  fund: 'Fund facts registered on the instrument. Holdings, weights, NAV history and fees are not in the server contract yet.',
};
export function TermsPanel({ inst, detail }) {
  const obs = detail?.observation;
  const t = inst.terms || {};
  const rows = [
    ['Product', inst.support.productName], ['Family', familyGroup(inst.family)],
    inst.issuer ? ['Issuer', inst.issuer] : null,
    inst.family === 'fx' && t.base ? ['Quotation', `${t.quote} per 1 ${t.base} (base ${t.base}, quote ${t.quote})`] : null,
    ['Price quoted', `${inst.priceUnits}, ${inst.tradingCcy}`], inst.settleCcy && inst.settleCcy !== inst.tradingCcy ? ['Settlement currency', inst.settleCcy] : null,
    ['Quantity in', inst.qtyLabel], isNum(inst.multiplier) && inst.multiplier !== 1 ? ['Multiplier', fmtQty(inst.multiplier)] : null,
    inst.family === 'bond' && obs && isNum(obs.yield) ? ['Yield (supplied with the price)', `${fmtNum(obs.yield * (Math.abs(obs.yield) < 1 ? 100 : 1), 3)}%`] : null,
    ...(inst.details || []),
    ['Settlement convention', inst.settlement?.label || html`<${Missing} />`],
    ['Trading calendar', `${inst.calendar?.trading?.label || ''} (${inst.calendar?.trading?.id || ''})`],
    ['Venue', inst.venue || (inst.venueType === 'otc' ? 'OTC' : inst.venueType === 'global' ? 'Global, no listing venue' : html`<${Missing} reason="Not recorded" />`)],
    ['Market view', inst.arrangement ? 'Financing arrangement (Treasury and Account pages)' : `${VIEW_LABEL[inst.marketView]}${inst.classification?.tabLabel ? `, ${inst.classification.tabLabel}` : ''}`],
    ['Terminal ID', html`<span class="mono">${inst.id}</span>`], ['Reference source', inst.refSource === 'manual' ? 'Entered by hand in the Terminal' : inst.refSource],
  ];
  const given = new Set((inst.details || []).map(([k]) => String(k).toLowerCase()));
  const shown = rows.filter((r) => !r || !inst.details?.includes(r) ? !(r && given.has(String(r[0]).toLowerCase()) && !inst.details.includes(r)) : true);
  return html`<section class="panel"><header><h3>Contract and reference terms</h3><span class="note">From the Terminal's instrument registry</span></header>
    <div class="body">${FIELDS_NOTE[inst.family] ? html`<p class="note" style="margin-top:0">${FIELDS_NOTE[inst.family]}</p>` : null}<${KV} rows=${shown} /></div></section>`;
}

// ---- Price history ---------------------------------------------------------------------------------------------------------
const RANGES = [['1m', '1 month', 31], ['3m', '3 months', 92], ['6m', '6 months', 183], ['1y', '1 year', 366], ['5y', '5 years', 1827], ['max', 'All', null]];
const INTERVALS = [['1d', 'Daily'], ['1wk', 'Weekly'], ['1mo', 'Monthly']];
const isoDay = (d) => d.toISOString().slice(0, 10);
/** The existing price-history route, wrapped as an envelope, while /api/server/history is not served. */
const historyFallback = (sel, q) => get(`/api/instruments/${sel.id}/history`, { from: q.from, to: q.to, interval: q.interval }).then((h) => ({
  state: h.available ? (h.bars?.length ? 'available' : 'unavailable') : 'awaiting', items: h.available ? h.bars : undefined,
  data: { adjusted: null, adjustmentBasis: null, currency: h.currency || null, interval: q.interval, annotations: [] },
  source: h.source ? { label: h.source, fixture: false } : null, message: h.available ? null : 'Historical prices come from Shaffer MarketData.', olderRoute: true,
}));
export function PriceHistory({ inst, sel, asOf, intervalFor, title = 'Price history' }) {
  const [range, setRange] = useState('6m');
  const [interval, setInterval] = useState('1d');
  const [adjusted, setAdjusted] = useState('1');
  const status = useStore((s) => s.status);
  const end = asOf ? new Date(`${asOf}T23:59:59Z`) : new Date(status?.now || Date.now());
  const days = RANGES.find((r) => r[0] === range)?.[2];
  const q = { from: days ? isoDay(new Date(end.getTime() - days * 86400e3)) : undefined, to: isoDay(end), interval, adjusted };
  const ds = useDataset(sel, 'history', { query: q, fallback: historyFallback, interval: intervalFor?.('history') });
  return html`<${DatasetPanel} ds=${ds} title=${title} asOf=${asOf}
    actions=${html`<span class="ws-hctl"><${Select} value=${range} onChange=${setRange} options=${RANGES.map(([v, l]) => ({ value: v, label: l }))} />
      <${Select} value=${interval} onChange=${setInterval} options=${INTERVALS.map(([v, l]) => ({ value: v, label: l }))} />
      <${Seg} value=${adjusted} onChange=${setAdjusted} options=${[{ value: '1', label: 'Adjusted' }, { value: '0', label: 'Unadjusted' }]} /></span>`}>
    ${(env) => html`<${HistoryBody} env=${env} inst=${inst} q=${q} />`}<//>`;
}
function HistoryBody({ env, inst, q }) {
  const bars = (env.items || []).filter((b) => isNum(b.close));
  const meta = env.data || {};
  if (!bars.length) return html`<${Empty} title="No prices in this range">The server has no ${q.interval} prices for ${q.from ? `${q.from} to ${q.to}` : `up to ${q.to}`}. Choose a longer range or another interval.<//>`;
  const first = bars[0], last = bars[bars.length - 1];
  const adjText = meta.adjusted === true ? `Adjusted series${meta.adjustmentBasis ? ` (${meta.adjustmentBasis})` : ''}` : meta.adjusted === false ? 'Unadjusted series: prices as traded, not adjusted for splits or dividends' : 'Adjustment basis not stated by the source: treat the series as of unknown adjustment';
  const wanted = q.adjusted === '1' ? 'adjusted' : 'unadjusted';
  const mismatch = (meta.adjusted === true && wanted === 'unadjusted') || (meta.adjusted === false && wanted === 'adjusted');
  const startGap = q.from && first.date > q.from;
  const perf = isNum(first.close) && first.close > 0 ? (last.close / first.close - 1) * 100 : null;
  const recent = bars.slice(-12).reverse();
  return html`<div class="stack">
    <${LineChart} bars=${bars} height=${170} />
    <div class="small">${adjText}.${mismatch ? html` <b>The server returned an ${meta.adjusted ? 'adjusted' : 'unadjusted'} series although ${wanted} was asked for.</b>` : ''}${env.olderRoute ? ' Served by the Terminal\'s existing history route until the server client route is available.' : ''}</div>
    ${startGap ? html`<${Notice}>No prices before ${first.date} in this range: the history starts there. Nothing is filled in before it.<//>` : null}
    ${env.coverage?.missing?.length ? html`<${Notice} tone="warn"><b>Gaps in the history:</b> ${env.coverage.missing.join(', ')}. They are left empty, not interpolated.<//>` : null}
    <div class="small">Change over the range shown: ${perf === null ? html`<${Missing} reason="Needs a positive first close" />` : html`<${Signed} value=${perf} suffix="%" />`} <span class="muted">(first close ${first.date} to last close ${last.date}, on this ${meta.adjusted === true ? 'adjusted' : meta.adjusted === false ? 'unadjusted' : 'series'}; worked out here from the closes shown${meta.adjusted === false ? ', so splits and dividends are not accounted for' : ''})</span></div>
    ${meta.annotations?.length ? html`<div><h4 style="margin:4px 0">Corporate actions on the chart</h4><ul class="ws-ann">${meta.annotations.map((x) => html`<li>${x.date}: ${x.label || x.type}${x.ratio ? ` (${x.ratio})` : ''}${isNum(x.amount) ? ` ${fmtNum(x.amount, 4)}` : ''}</li>`)}</ul></div>` : null}
    <details><summary class="note">Latest ${recent.length} ${q.interval === '1d' ? 'days' : 'periods'}: open, high, low, close and volume</summary>
      <${Table} cls="tight" rows=${recent} rowKey=${(b) => b.date} columns=${[{ label: 'Date', key: 'date' },
        ...['open', 'high', 'low', 'close'].map((k) => ({ label: k[0].toUpperCase() + k.slice(1), align: 'r', render: (b) => (isNum(b[k]) ? fmtPriceUnits(b[k], inst.priceUnits) : html`<${Missing} reason="Not supplied" />`) })),
        { label: 'Volume', align: 'r', render: (b) => (isNum(b.volume) ? fmtQty(b.volume) : html`<${Missing} reason="Not supplied" />`) }]} /></details>
    <p class="note" style="margin:0">${meta.currency || inst.tradingCcy}, ${inst.priceUnits}. Server market history, kept apart from the paper ledger: refreshing it never changes a fill or booked accounting.</p>
  </div>`;
}

// ---- My positions and trades (local paper records) ---------------------------------------------------------------------
export function MyPositions({ inst, detail, book, sel, intervalFor, onTrade }) {
  const positions = detail?.positions || [];
  const ids = [...new Set(positions.map((p) => p.strategy?.id).filter(Boolean))].slice(0, 12);
  const strats = useLive(async () => Promise.all(ids.map((sid) => get(`/api/strategies/${sid}`, { bookId: book.id }).catch(() => null))), [ids.join(), book.id]);
  const ledger = useDataset(sel, 'ledger', { query: { bookId: book.id }, live: true, interval: intervalFor?.('ledger') });
  const openStrategy = async (sid) => { const m = await import('./strategy-detail.js'); m.openStrategy(sid); };
  const list = (strats.data || []).filter(Boolean);
  const orders = list.flatMap((s) => (s.orders || []).filter((o) => o.instrument?.id === inst.id).map((o) => ({ ...o, strategy: s })));
  const fills = orders.flatMap((o) => (o.fills || []).map((f) => ({ ...f, order: o })));
  return html`<div class="stack" data-ws-inst=${inst.id}>
    <p class="note" style="margin:0">Local paper records of ${book.name}: kept apart from the server's market history, and never changed by it.</p>
    <section class="panel"><header><h3>Holdings by Account</h3><span class="note">Long and short shown apart</span></header><div class="body flush">
      <${Table} rows=${positions} rowKey=${(p) => p.positionId} empty=${{ title: `${book.name} holds no position in ${inst.symbol || inst.name}`, children: html`Use Trade to open one. <button class="btn link small" onClick=${onTrade}>Trade</button>` }} columns=${[
        { label: 'Held in', render: (p) => p.owner }, { label: 'Strategy instance', render: (p) => (p.strategy ? html`<a href="javascript:void 0" onClick=${() => openStrategy(p.strategy.id)}>${p.strategy.name}</a>` : '') },
        { label: 'Long', align: 'r', render: (p) => (p.qty > 0 ? fmtQty(p.qty) : '') }, { label: 'Short', align: 'r', render: (p) => (p.qty < 0 ? fmtQty(-p.qty) : '') },
        { label: 'Average cost', align: 'r', render: (p) => fmtPriceUnits(p.avgCost, inst.priceUnits) },
        { label: 'Market value', align: 'r', render: (p) => html`<${Money} value=${p.mv} ccy=${p.ccy} reason=${p.missingReason} />` },
        { label: 'Unrealized', align: 'r', render: (p) => html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} />` }]} /></div></section>
    <section class="panel"><header><h3>Strategy packages, hedges and financing</h3></header><div class="body flush">
      ${strats.loading && !strats.data && ids.length ? html`<div class="ws-loading">Loading…</div>` : html`<${Table} rows=${list} rowKey=${(s) => s.id} empty=${{ title: 'No strategy package holds this instrument', children: 'A package bought from the Strategies page or a ticket is listed here with its hedges and financing.' }} columns=${[
        { label: 'Package', render: (s) => html`<a href="javascript:void 0" onClick=${() => openStrategy(s.id)}>${s.name}</a><div class="sub">${s.unit?.name}</div>` },
        { label: 'Status', render: (s) => s.status },
        { label: 'Hedges', render: (s) => { const n = s.hedge?.requests?.length || 0; return n ? `${n} hedge request${n > 1 ? 's' : ''}${s.hedge?.links?.length ? `, ${s.hedge.links.length} linked hedge${s.hedge.links.length > 1 ? 's' : ''}` : ''}` : html`<span class="muted">none requested</span>`; } },
        { label: 'Financing legs', render: (s) => { const f = (s.positions || []).filter((p) => p.purpose === 'financing'); return f.length ? f.map((p) => p.instrument?.symbol || p.instrument?.name || p.kind).join(', ') : html`<span class="muted">none</span>`; } }]} />`}</div></section>
    <section class="panel"><header><h3>Orders and fills</h3><span class="note">Paper orders on this instrument in those packages</span></header><div class="body flush">
      <${Table} rows=${orders} rowKey=${(o) => o.id} empty=${{ title: 'No orders on this instrument', children: 'Working and filled paper orders appear here.' }} columns=${[
        { label: 'Order', render: (o) => html`${o.label || o.kindLabel}<div class="sub">${o.strategy.name}</div>` }, { label: 'Status', render: (o) => o.status },
        { label: 'Quantity', align: 'r', render: (o) => fmtQty(o.qty) }, { label: 'Filled', align: 'r', render: (o) => fmtQty(o.filledQty) },
        { label: 'Average price', align: 'r', render: (o) => (isNum(o.avgPrice) ? fmtPriceUnits(o.avgPrice, inst.priceUnits) : html`<${Missing} reason="No fill yet" />`) }]} />
      ${fills.length ? html`<${Table} rows=${fills} rowKey=${(f) => f.id} columns=${[{ label: 'Fill', render: (f) => fmtTime(f.ts) }, { label: 'Quantity', align: 'r', render: (f) => fmtQty(f.qty) },
        { label: 'Price', align: 'r', render: (f) => fmtPriceUnits(f.price, inst.priceUnits) }, { label: 'Gross', align: 'r', render: (f) => html`<${Money} value=${f.gross} ccy=${f.ccy} />` }, { label: 'How filled', render: (f) => html`<span class="small">${f.model}</span>` }]} />` : null}</div></section>
    <${DatasetPanel} ds=${ledger} title="Accounting history and open orders (server ledger interface)" what="The paper ledger's own record of this instrument through the server client"><${PlainListing} env=${ledger.env} /><//>
    <p class="note">The full accounting history is under <a href="#/accounting/history">Accounting, History</a>.</p>
  </div>`;
}
/** The analytics of the existing quotes route, wrapped as an envelope, while /api/server/analytics is not served. */
export const analyticsFallback = (sel, q) => get('/api/quotes', { ids: sel.id, strategyId: q.strategyId }).then((r) => {
  const a = r.quotes?.[sel.id]?.analytics || null;
  return { state: a ? 'available' : r.analytics === 'connected' ? 'unavailable' : 'awaiting', data: a, message: a ? null : r.analytics === 'connected' ? 'Not supplied by Analytics Lab for this instrument.' : `${r.awaitingMessage} (Analytics Lab)`, olderRoute: true };
});
/** The header's datasets for one selection: analytics for the chosen Strategy (never as of a research date) and the reference record. */
export function useHeaderData(sel, strategy, intervalFor) {
  const analytics = useDataset(sel, 'analytics', { query: { strategyId: strategy?.id || '' }, enabled: Boolean(strategy?.id), fallback: analyticsFallback, asOf: false, interval: intervalFor?.('analytics') });
  const reference = useDataset(sel, 'reference', { asOf: false });
  return { analytics, reference };
}
// Where the full page was opened from, so its Back link can say where it returns (per browser tab).
const ORIGIN_KEY = 'sdt.ws.origin';
export function openFullPage(id, tab) {
  try { if (!location.hash.startsWith('#/instrument/')) sessionStorage.setItem(ORIGIN_KEY, JSON.stringify({ hash: location.hash || '#/accounting', bookId: getState().bookId, unitId: getState().unitId })); } catch { /* the browser's Back still works */ }
  location.hash = pageHref(id, tab);
}
export function pageOrigin() { try { return JSON.parse(sessionStorage.getItem(ORIGIN_KEY) || 'null'); } catch { return null; } }
export { historyFallback, Prov };
