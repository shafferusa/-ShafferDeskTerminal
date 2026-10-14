// Full instrument-detail page: #/instrument/<id>/<tab>[/asof/<YYYY-MM-DD>].
// The same workspace as the quick overview drawer (workspace.js), with every tab the product family has
// (workspace-model.js FAMILY_TABS) and a research-date control. The header (execution quote context, holdings,
// Trade / Build strategy / Hedge) always stays on the paper-trading clock; only the research panels follow the
// research date, and each says which point in time it shows. The Book and trading owner are the ones in use.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { currentUnit, fmtTime, get, isNum, unitLabel, useLive, VIEW_LABEL } from '../lib/core.js';
import { Empty, Missing, Notice, Price, Text } from '../lib/ui.js';
import { Chain, openInstrument } from './instrument.js';
import { TABS, workspaceTabs } from './workspace-model.js';
import {
  buildStrategy, DatasetPanel, hedgeFromWorkspace, MyPositions, pageHref, pageOrigin, PlainListing, PriceHistory, Related, StatePill, tabContent, TermsPanel,
  useDataset, useHeaderData, useRefreshSettings, useSelection, useServerState, useWorkspaceStrategy, WorkspaceHeader,
} from './workspace.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_LABEL = { accounting: 'Accounting', treasury: 'Treasury', account: 'the Account', strategy: 'Strategies', instruments: 'Instruments', data: 'Data connection', settings: 'Settings' };
function originLabel(o) {
  if (!o?.hash) return null;
  const [page, a] = o.hash.replace(/^#\/?/, '').split('/');
  if (page === 'markets') return VIEW_LABEL[a] || 'Marketplaces';
  return PAGE_LABEL[page] || null;
}

export default function InstrumentPage({ args, book, status }) {
  const id = decodeURIComponent(args[0] || '');
  const asOf = args[2] === 'asof' && DAY.test(args[3] || '') ? args[3] : '';
  if (!id) return html`<div><div class="page-head"><div><h1>Instrument</h1><div class="sub">Choose an instrument to open its workspace.</div></div></div><${FindInstrument} tab="" /></div>`;
  return html`<${Workspace} id=${id} tabArg=${args[1] || ''} asOf=${asOf} book=${book} status=${status} />`;
}

function Workspace({ id, tabArg, asOf, book, status }) {
  const headSel = useSelection(id, 'page-head');
  const sel = useSelection(id, 'page', asOf);
  const intervalFor = useRefreshSettings();
  const detail = useDataset(headSel, 'detail', { path: `/api/instruments/${encodeURIComponent(id)}/detail`, query: { bookId: book.id }, live: true, asOf: false, interval: status.data?.refresh?.uiPollMs || 4000 });
  const [strategy, setStrategy] = useWorkspaceStrategy();
  const head = useHeaderData(headSel, strategy, intervalFor);
  const serverState = useServerState();
  const d = detail.env?.instrument?.id === id ? detail.env : null;
  const inst = d?.instrument || null;
  const reg = useMemo(() => (inst ? workspaceTabs(inst, serverState) : null), [inst?.id, inst?.family, serverState]);
  const tab = reg ? reg.tabs.find((t) => t.id === tabArg) || reg.tabs[0] : null;
  // The address always names the tab (Back and reload restore it), completed without adding a step to Back.
  useEffect(() => { if (tab && tabArg !== tab.id) history.replaceState(null, '', `${pageHref(id, tab.id)}${asOf ? `/asof/${asOf}` : ''}`); }, [tab?.id, id]);
  if (detail.state === 'error' && !d) return html`<div><${BackLine} book=${book} /><${Notice} tone="err">${detail.error?.message || 'This instrument could not be loaded.'} Check the address, or find the instrument below.<//><${FindInstrument} tab="" /></div>`;
  if (!d) return html`<div><${BackLine} book=${book} /><div class="ws-loading" aria-busy="true">Loading the instrument…</div></div>`;
  const go = (t, date = asOf) => { location.hash = `${pageHref(id, t)}${date ? `/asof/${date}` : ''}`; };
  const trade = () => openInstrument(id, { tab: 'trade' });
  return html`<div class="ws-page" data-ws-inst=${id}>
    <${BackLine} book=${book} find=${html`<${FindInstrument} tab=${tab.id} compact />`} />
    <div class="ws-mini" aria-hidden="true"><span class="sym">${inst.symbol || inst.name}</span> <${Price} obs=${d.observation} units=${inst.priceUnits} reason="No price available" /> <span class="muted">${inst.tradingCcy}</span></div>
    <div class="ws-sticky page">
      <${WorkspaceHeader} page inst=${inst} detail=${d} analytics=${head.analytics} reference=${head.reference} strategy=${strategy} setStrategy=${setStrategy} book=${book}
        onTrade=${trade} onBuild=${() => buildStrategy(inst, strategy)} onHedge=${() => hedgeFromWorkspace({ inst, detail: d, book, strategy })} />
    </div>
    <${AsOfBar} asOf=${asOf} status=${status} serverState=${serverState} onChange=${(date) => go(tab.id, date)} />
    <div class="tabs ws-tabs" role="tablist" aria-label="Instrument detail">
      ${reg.tabs.map((t) => html`<button role="tab" aria-selected=${t.id === tab.id} class=${t.id === tab.id ? 'on' : ''} onClick=${() => go(t.id)} title=${t.state ? `${t.label}: ${t.state}` : t.label}>${t.label}${t.state && t.state !== 'available' ? html`<span class="n">${t.state}</span>` : null}</button>`)}
    </div>
    <div key=${`${id}:${tab.id}:${asOf}`} data-ws-tab=${tab.id}>
      <${TabBody} tab=${tab} inst=${inst} detail=${d} sel=${sel} headSel=${headSel} asOf=${asOf} book=${book} strategy=${strategy} intervalFor=${intervalFor} reference=${head.reference} related=${reg.related} trade=${trade} />
    </div>
    ${reg.notCovered.length ? html`<section class="panel ws-nc" data-testid="not-covered"><header><h3>Not covered for this product</h3><span class="note">${reg.group}: not shown as tabs</span></header>
      <div class="body"><dl class="kv">${reg.notCovered.map((n) => html`<dt>${n.what}</dt><dd>${n.why}${n.by === 'server' ? html` <span class="muted small">(reported by the server)</span>` : ''}</dd>`)}</dl></div></section>` : null}
  </div>`;
}

/** Back to where the page was opened from; the Book and trading owner in use. */
function BackLine({ book, find }) {
  const o = pageOrigin();
  const label = originLabel(o);
  const owner = currentUnit();
  return html`<div class="ws-back">
    <a href=${o?.hash || '#/markets/US_CASH'} title="Return to the screen this page was opened from (the browser's Back does the same)">${label ? `Back to ${label}` : 'Marketplaces'}</a>
    <span class="muted small">${book.name}, trading owner ${owner ? unitLabel(owner) : html`<${Missing} reason="No owner in use: the ticket asks for one" />`}</span>
    <span class="grow"></span>${find || null}
  </div>`;
}

/** Find another instrument and open its workspace on the same tab. */
function FindInstrument({ tab, compact }) {
  const [q, setQ] = useState('');
  const res = useLive(() => (q.trim().length >= 1 ? get('/api/instruments', { q: q.trim(), limit: 8 }) : null), [q.trim()], { interval: false });
  const hits = res.data?.items || [];
  return html`<div class=${`ws-find ${compact ? 'compact' : ''}`}><${Text} type="search" value=${q} onInput=${setQ} placeholder="Open another instrument: symbol or name" />
    ${q.trim() && hits.length ? html`<ul class="ws-hits" role="listbox">${hits.map((i) => html`<li><a href=${pageHref(i.id, tab)} onClick=${() => setQ('')} data-inst=${i.id}><span class="sym">${i.symbol || i.name}</span> <span class="muted small">${i.symbol ? i.name : i.id}, ${i.support.productName.replace(/ \(.*\)$/, '')}</span></a></li>`)}</ul>` : null}
    ${q.trim() && res.data && !hits.length ? html`<ul class="ws-hits"><li class="muted small" style="padding:6px 10px">No instrument matches "${q.trim()}".</li></ul>` : null}</div>`;
}

/**
 * The research date, apart from the paper-trading clock. Point-in-time support is what the server reports per dataset
 * (GET /api/server/state, datasets[key].pointInTime); each panel also says whether its answer was as of the date.
 */
function AsOfBar({ asOf, status, serverState, onChange }) {
  const pit = serverState ? Object.entries(serverState.datasets || {}).filter(([, v]) => v.pointInTime !== undefined) : [];
  const supported = pit.filter(([, v]) => v.pointInTime === true || v.pointInTime?.supported === true).map(([k]) => k);
  const none = serverState && pit.length > 0 && !supported.length;
  const today = (status.now || '').slice(0, 10);
  return html`<div class=${`ws-asofbar ${asOf ? 'on' : ''}`} data-testid="asof-bar">
    <label class="ws-lbl" for="ws-research-date">Research date</label>
    <input id="ws-research-date" type="date" value=${asOf} max=${today || undefined} disabled=${none} onChange=${(e) => { const v = e.target.value; if (!v || DAY.test(v)) onChange(v); }} />
    ${asOf ? html`<button class="btn small" onClick=${() => onChange('')}>Back to current</button>` : null}
    <span class="ws-clock small">Paper-trading clock: <b>${fmtTime(status.now)}</b></span>
    <div class="note ws-asofnote">${none ? (serverState.gateway && serverState.gateway.configured === false && serverState.mode !== 'demo' ? 'Research dates need the Shaffer server connection, which is awaiting: the panels show current information only.' : 'The server contract does not support research dates for these datasets, so the panels show current information only.')
      : asOf ? html`Research panels show what was known on <b>${asOf}</b>, as it was known then, where the server contract supports it. The header's quote, holdings and every trade stay on the paper-trading clock.`
        : html`Current revised information. Choose a research date to see what was known at that time${serverState ? (supported.length ? ` (supported for ${supported.length} dataset${supported.length > 1 ? 's' : ''})` : '') : '; whether the server supports it is said on each panel'}.`}</div>
  </div>`;
}

function TabBody({ tab, inst, detail, sel, headSel, asOf, book, strategy, intervalFor, reference, related, trade }) {
  const own = tabContent(tab.id);
  const common = { inst, detail, sel, asOf, book, strategy, intervalFor };
  if (tab.id === 'history' || tab.id === 'marks') return html`<div class="stack"><${PriceHistory} inst=${inst} sel=${sel} asOf=${asOf} intervalFor=${intervalFor} title=${tab.label} />
    ${tab.id === 'marks' ? html`<p class="note">Marks are shown with their kind (dealer, model or manual) in the header's price chip. A model mark from Analytics Lab is a valuation, never an executable quote.</p>` : null}</div>`;
  if (tab.id === 'positions') return html`<${MyPositions} inst=${inst} detail=${detail} book=${book} sel=${headSel} asOf=${asOf} intervalFor=${intervalFor} onTrade=${trade} />`;
  if (tab.id === 'chain') return html`<${ChainTab} inst=${inst} />`;
  if (own) return html`<${own} ...${common} />`;
  if (tab.id === 'overview' || tab.id === 'terms') return html`<${OverviewTab} ...${common} tab=${tab} reference=${reference} related=${related} />`;
  return html`<${GenericTab} ...${common} tab=${tab} />`;
}

function OverviewTab({ inst, detail, sel, asOf, tab, reference, related, intervalFor }) {
  const profile = useDataset(sel, 'profile', { enabled: tab.datasets.includes('profile'), interval: intervalFor('profile') });
  return html`<div class="stack">
    ${tab.datasets.includes('profile') ? html`<${DatasetPanel} ds=${profile} title="Company and listing" asOf=${asOf} what="Business description, sector classifications, listing details, market capitalization, shares outstanding, financial highlights and next earnings from Shaffer MarketData">
      ${(env) => html`<${PlainListing} env=${env} />`}<//>` : null}
    <div class="ws-cols"><${TermsPanel} inst=${inst} detail=${detail} />
      <div class="stack"><${Related} inst=${inst} related=${related} reference=${reference} />
        <${DatasetPanel} ds=${reference} title="Server reference record" what="Stable server, issuer and contract IDs, quote convention and units from Shaffer MarketData">${(env) => html`<${PlainListing} env=${env} />`}<//></div></div>
  </div>`;
}

/** A tab whose content a colleague registers: until then each of its datasets is drawn with its state and listed plainly. */
function GenericTab({ tab, sel, asOf, strategy, intervalFor }) {
  const needsStrategy = tab.datasets.some((k) => k === 'analytics' || k === 'analyticsRuns');
  const q = needsStrategy ? { strategyId: strategy?.id || '' } : {};
  // A fixed list of hooks per tab: the tab body is keyed by tab id.
  const list = tab.datasets.map((k) => useDataset(sel, k, { query: k.startsWith('analytics') ? q : {}, enabled: !(needsStrategy && k.startsWith('analytics') && !strategy?.id), interval: intervalFor(k) }));
  return html`<div class="stack">
    ${needsStrategy && !strategy?.id ? html`<${Notice}>Choose an investment Strategy in the header: analytics are asked for that Strategy's ID only, never blended across Strategies.<//>` : null}
    ${needsStrategy && asOf ? html`<${Notice} tone="warn">Analytical outputs as of ${asOf} are historical runs. They are shown for research and are not current recommendations.<//>` : null}
    ${list.map((ds) => (ds.state === 'unavailable' && !ds.env ? null : html`<${DatasetPanel} ds=${ds} asOf=${asOf} title=${ds.label}>${(env) => html`<${PlainListing} env=${env} />`}<//>`))}
  </div>`;
}

function ChainTab({ inst }) {
  const undId = ['option', 'future'].includes(inst.family) ? inst.underlying?.id : inst.id;
  const und = useLive(() => (undId && undId !== inst.id ? get(`/api/instruments/${undId}`) : inst), [undId], { interval: false });
  if (!undId) return html`<${Empty} title="No underlying registered">This contract has no registered underlying, so there is no chain or contract-month list to show.<//>`;
  if (!und.data) return html`<div class="ws-loading">Loading…</div>`;
  return html`<div class="stack">${undId !== inst.id ? html`<p class="note" style="margin:0">Chain and contract months of the underlying, <a href=${pageHref(undId)}>${und.data.symbol || und.data.name}</a>.</p>` : null}<${Chain} inst=${und.data} /></div>`;
}
export { TABS, isNum, StatePill };
