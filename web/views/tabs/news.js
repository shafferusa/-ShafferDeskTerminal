// News and events tab of the instrument workspace: timestamped company, sector and economic items from Shaffer
// MarketData, with their source and publication time kept exactly as supplied. Each item keeps three things apart:
// the facts it reports, the classification the server supplied (and who supplied it), and any analytical
// interpretation (and who made it). Pages follow the server's pagination (page or cursor); the kind filter works on
// the items of the page shown, because the contract has no kind filter yet. Nothing here classifies or interprets.
import { html, useState } from '../../vendor/preact-htm.js';
import { fmtNum, fmtTime, isNum } from '../../lib/core.js';
import { Button, Empty, Missing, Pill, Seg } from '../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../workspace.js';

const PAGE_SIZE = 10;
const KINDS = [['all', 'All'], ['company', 'Company'], ['sector', 'Sector'], ['economy', 'Economic']];
const KIND_LABEL = { company: 'company', sector: 'sector', economy: 'economic' };

function NewsTab({ inst, sel, asOf, intervalFor }) {
  // Pagination as the server answers it: `page` (page shape) or a stack of cursors (cursor shape).
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState([null]);
  const [kind, setKind] = useState('all');
  const cursor = cursors[cursors.length - 1];
  const ds = useDataset(sel, 'news', { query: { pageSize: PAGE_SIZE, page: cursor ? undefined : page, cursor: cursor || undefined }, interval: intervalFor?.('news') });
  const pg = ds.env?.pagination || null;
  const nav = {
    page, depth: cursors.length, cursorMode: pg?.mode === 'cursor' || Boolean(pg?.nextCursor) || cursors.length > 1,
    prev: () => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); else setPage(Math.max(1, page - 1)); },
    next: () => { if (pg?.nextCursor) setCursors([...cursors, pg.nextCursor]); else setPage(page + 1); },
  };
  return html`<div class="stack" data-ws-inst=${inst.id} data-testid="news-tab">
    <p class="note" style="margin:0">Items as Shaffer MarketData supplies them, newest first, with their source and publication time. Facts, the server's classification and any analytical interpretation are shown apart; the Terminal adds none of them.</p>
    <${DatasetPanel} ds=${ds} asOf=${asOf} title="News and events" what="Company, sector and economic news and events from Shaffer MarketData"
      actions=${html`<span class="ws-hctl" data-testid="news-kind"><${Seg} value=${kind} onChange=${setKind} options=${KINDS.map(([value, label]) => ({ value, label }))} /></span>`}>
      ${(env) => html`<${NewsBody} env=${env} kind=${kind} nav=${nav} asOf=${asOf} />`}<//>
  </div>`;
}

function NewsBody({ env, kind, nav, asOf }) {
  const items = env.items || [];
  const shown = kind === 'all' ? items : items.filter((n) => n.scope === kind);
  const pg = env.pagination || {};
  const counts = Object.fromEntries(KINDS.slice(1).map(([k]) => [k, items.filter((n) => n.scope === k).length]));
  const hasNext = Boolean(pg.nextCursor) || (isNum(pg.totalPages) && nav.page < pg.totalPages);
  const hasPrev = nav.cursorMode ? nav.depth > 1 : nav.page > 1;
  return html`<div>
    <div class="nw-tools small muted">${items.length} item${items.length === 1 ? '' : 's'} on this page: ${counts.company} company, ${counts.sector} sector, ${counts.economy} economic${kind !== 'all' ? html`; showing ${KIND_LABEL[kind]} items only (the filter applies to this page)` : ''}.${asOf ? ` Published on or before ${asOf}.` : ''}</div>
    ${!items.length ? html`<${Empty} title="No news on this page">${env.message || 'The server returned no items.'}<//>`
      : !shown.length ? html`<${Empty} title=${`No ${KIND_LABEL[kind]} items on this page`}>Choose All, or another page.<//>`
        : html`<ul class="nw-list">${shown.map((n) => html`<${Item} n=${n} />`)}</ul>`}
    <div class="nw-pager" data-testid="news-pager">
      <span class="small muted">${isNum(pg.totalPages) ? `Page ${pg.page || nav.page} of ${pg.totalPages}` : `Page ${nav.cursorMode ? nav.depth : nav.page}`}${isNum(pg.totalItems) ? `, ${pg.totalItems} items in all` : ''}</span>
      <${Button} small disabled=${!hasPrev} onClick=${nav.prev}>Previous page<//><${Button} small disabled=${!hasNext} onClick=${nav.next}>Next page<//>
    </div>
  </div>`;
}

const factValue = (f) => (f.value === null || f.value === undefined ? html`<${Missing} reason=${f.reason || 'Not supplied'} />` : typeof f.value === 'number' ? `${fmtNum(f.value, Number.isInteger(f.value) ? 0 : 2)}${f.units ? ` ${f.units}` : ''}` : `${f.value}${f.units ? ` ${f.units}` : ''}`);

function Item({ n }) {
  const facts = Array.isArray(n.facts) ? n.facts : [];
  const cls = n.classification;
  return html`<li class="nw-item" data-news=${n.id} data-scope=${n.scope}>
    <div class="nw-head"><${Pill} tone=${n.scope === 'company' ? 'pen' : ''}>${KIND_LABEL[n.scope] || n.scope || 'unclassified'}<//>
      <span title=${`Published ${n.publishedAt} (as supplied)`} data-testid="news-published">Published ${n.publishedAt ? fmtTime(n.publishedAt, { seconds: true }) : html`<${Missing} reason="No publication time supplied" />`}</span>
      <span>Source: ${n.source || html`<${Missing} reason="No source supplied" />`}</span>
      ${n.receivedAt && n.receivedAt !== n.publishedAt ? html`<span title=${n.receivedAt}>received ${fmtTime(n.receivedAt, { seconds: true })}</span>` : null}
      ${n.url ? html`<a href=${n.url} target="_blank" rel="noopener noreferrer">Open at the source</a>` : null}</div>
    <div class="nw-title">${n.headline || html`<span class="muted">No headline supplied</span>`}</div>
    ${n.summary ? html`<div class="small">${n.summary}</div>` : null}
    <div class="nw-part" data-part="facts"><span class="k">Facts</span><span>${facts.length ? facts.map((f, i) => html`${i ? '; ' : ''}${f.label}: ${factValue(f)}`) : html`<span class="muted">No structured facts supplied with this item</span>`}</span></div>
    <div class="nw-part" data-part="classification"><span class="k">Classification</span><span>${cls?.labels?.length ? html`${cls.labels.join(', ')}<span class="muted">; classified by ${cls.by || 'the server (classifier not stated)'}</span>` : html`<span class="muted">None supplied</span>`}</span></div>
    ${n.interpretation ? html`<div class="nw-part" data-part="interpretation"><span class="k">Interpretation</span><span class="nw-interp">${n.interpretation.text}<span class="muted small" style="display:block;font-style:normal">Analytical interpretation by ${n.interpretation.by || 'an unstated source'}: a view, not a reported fact.</span></span></div>` : null}
  </li>`;
}

registerTabContent('news', (p) => html`<${NewsTab} ...${p} />`);
export { NewsTab };
