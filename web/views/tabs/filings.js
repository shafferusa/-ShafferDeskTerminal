// Filings and reports tab of the instrument-detail workspace (#/instrument/<id>/filings).
// The filings, earnings releases, annual and interim reports, presentations and supporting documents the Shaffer server
// supplies (GET /api/server/filings/:id), with type, period, filing date and source; pages through the server's cursor (or
// page numbers, whichever the answer uses); search and a type filter over the whole list (all pages, collected by the
// server). Documents open in a sandboxed frame (no scripts, no forms, no navigation) or in a new tab, both through the
// Terminal's document proxy (GET /api/server/documents/:docId), which streams them from the gateway: the Terminal never
// fetches or scrapes a document from its original source.
import { html, useEffect, useMemo, useState } from '../../vendor/preact-htm.js';
import { fmtTime, openOverlay } from '../../lib/core.js';
import { Button, Empty, Missing, Modal, Notice, Pill, Select, Text } from '../../lib/ui.js';
import { DatasetPanel, pageHref, registerTabContent, useDataset } from '../workspace.js';
import { forQuery } from './statements-model.js';

const KIND_LABEL = {
  'annual-report': 'Annual report', 'interim-report': 'Interim report', 'earnings-release': 'Earnings release', presentation: 'Presentation',
  'offering-document': 'Offering document', 'supporting-document': 'Supporting document', filing: 'Filing', prospectus: 'Prospectus', 'fund-report': 'Fund report',
};
export const kindLabel = (k) => KIND_LABEL[k] || (k ? String(k).replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Type not stated');
const docUrl = (id) => `/api/server/documents/${encodeURIComponent(id)}`;

/** The rows that match the search text and type, in the server's order. */
export function filterFilings(items, { q = '', kind = '' } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  return (items || []).filter((f) => {
    if (kind && f.kind !== kind) return false;
    if (!words.length) return true;
    const hay = [f.title, kindLabel(f.kind), f.kind, f.period, f.source, f.filedAt?.slice(0, 10), ...(f.documents || []).map((d) => d.title)].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function FilingsTab({ inst, sel, asOf, intervalFor }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [pages, setPages] = useState([{ cursor: null, page: 1 }]);
  const searching = Boolean(q.trim() || kind);
  const at = pages[pages.length - 1];
  const query = searching ? { all: 1 } : at.cursor ? { cursor: at.cursor } : at.page > 1 ? { page: at.page } : {};
  // An answer for another page or for the unsearched list is never drawn as the one asked for.
  const askedAt = useMemo(() => Date.now(), [sel, JSON.stringify(query)]);
  const ds = forQuery(useDataset(sel, 'filings', { query, interval: intervalFor?.('filings') }), askedAt);
  const env = ds.env;
  const related = env?.related?.underlying;
  return html`<div class="stack fl-tab" data-ws-inst=${inst.id}>
    ${related ? html`<${Notice}>Filings belong to the issuer: see <a href=${pageHref(related.terminalId, 'filings')}>${related.symbol}</a>. ${related.note || ''}<//>` : null}
    <${DatasetPanel} ds=${ds} asOf=${asOf} flush title="Filings and reports" note="Filings, releases, reports, presentations and supporting documents the server supplies"
      what="Filings and reports from Shaffer MarketData">
      ${(e) => html`<${FilingsBody} env=${e} q=${q} setQ=${setQ} kind=${kind} setKind=${setKind} searching=${searching} pages=${pages} setPages=${setPages} asOf=${asOf} inst=${inst} />`}<//>
  </div>`;
}

function FilingsBody({ env, q, setQ, kind, setKind, searching, pages, setPages, asOf, inst }) {
  const items = env.items || [];
  const pg = env.pagination || null;
  const rows = filterFilings(items, { q, kind });
  const kinds = [...new Set(items.map((f) => f.kind).filter(Boolean))];
  const total = pg?.totalItems ?? null;
  const at = pages[pages.length - 1];
  const hasNext = !searching && (pg?.nextCursor || (pg?.mode === 'page' && pg.totalPages && at.page < pg.totalPages));
  const next = () => setPages([...pages, pg?.nextCursor ? { cursor: pg.nextCursor, page: at.page + 1 } : { cursor: null, page: at.page + 1 }]);
  const prev = () => setPages(pages.slice(0, -1));
  const pageSize = pg?.pageSize || items.length;
  const from = (at.page - 1) * (pageSize || 0) + 1;
  return html`<div>
    <div class="toolbar fl-tools">
      <div class="fl-search"><${Text} type="search" value=${q} onInput=${setQ} placeholder="Search filings: title, type, period, source" /></div>
      <${Select} value=${kind} onChange=${setKind} options=${[{ value: '', label: 'All types' }, ...(kind && !kinds.includes(kind) ? [kind] : []).concat(kinds).map((k) => ({ value: k, label: kindLabel(k) }))]} />
      <span class="grow"></span>
      ${searching ? html`<span class="small muted" data-testid="fl-count">${rows.length} of ${items.length} filing${items.length === 1 ? '' : 's'} match, all pages searched${pg?.truncated ? ' (the server list was cut short: some filings were not searched)' : ''}</span>`
        : html`<span class="small muted" data-testid="fl-count">${items.length ? `${from} to ${from + items.length - 1}` : 'None'}${total !== null ? ` of ${total}` : ''}${pg?.mode ? `, page ${at.page}${pg.totalPages ? ` of ${pg.totalPages}` : ''}` : ''}</span>
          <${Button} small disabled=${pages.length < 2} onClick=${prev}>Previous page<//><${Button} small disabled=${!hasNext} onClick=${next}>Next page<//>`}
    </div>
    ${!items.length ? html`<${Empty} title="No filings listed">${env.message || `The server lists no filings for ${inst.symbol || inst.name}${asOf ? ` filed on or before ${asOf}` : ''}.`}<//>`
      : !rows.length ? html`<${Empty} title="No filing matches">Nothing in the list matches${q.trim() ? ` "${q.trim()}"` : ''}${kind ? ` of type ${kindLabel(kind)}` : ''}. Clear the search or choose All types.<//>`
        : html`<div class="tablewrap"><table class="ledger fl-table" data-testid="fl-table"><thead><tr><th>Filed</th><th>Type</th><th>Title</th><th>Period</th><th>Source</th><th>Documents</th></tr></thead>
          <tbody>${rows.map((f) => html`<tr key=${f.id} data-filing=${f.id}>
            <td data-label="Filed">${f.filedAt ? html`<span title=${f.filedAt}>${f.filedAt.slice(0, 10)}</span> <span class="sub">${fmtTime(f.filedAt, { date: false })}</span>` : html`<${Missing} reason="No filing date supplied" />`}</td>
            <td data-label="Type"><${Pill}>${kindLabel(f.kind)}<//></td>
            <td data-label="Title" class="fl-tcell"><span class="fl-title">${f.title || html`<${Missing} reason="No title supplied" />`}</span></td>
            <td data-label="Period">${f.period || html`<${Missing} reason="No period supplied" />`}</td>
            <td data-label="Source">${f.source || html`<${Missing} reason="No source supplied" />`}</td>
            <td data-label="Documents" class="fl-dcell">${f.documents?.length ? html`<div class="fl-docs">${f.documents.map((d) => html`<${Button} small onClick=${() => openDocument(d, f, inst)} title=${`${d.title || 'Document'}${d.mediaType ? `, ${d.mediaType}` : ''}${d.pages ? `, ${d.pages} page${d.pages > 1 ? 's' : ''}` : ''}`}>View ${docName(d)}<//>`)}</div>` : html`<span class="muted small">No document supplied</span>`}</td>
          </tr>`)}</tbody></table></div>`}
    <p class="note fl-note">Documents are streamed through the Terminal's server from the Shaffer gateway and shown in a sandboxed frame (no scripts, forms or links that leave it). The Terminal does not fetch documents from their original source.</p>
  </div>`;
}
const docName = (d) => (d.title ? d.title.replace(/ document$/i, '').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'document');

/** The document viewer: the proxy route in a sandboxed frame, after checking the server answered with a document. */
export function openDocument(doc, filing, inst) {
  openOverlay((close) => html`<${DocumentViewer} doc=${doc} filing=${filing} inst=${inst} onClose=${close} />`);
}
function DocumentViewer({ doc, filing, inst, onClose }) {
  const url = docUrl(doc.id);
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    const ctrl = new AbortController();
    // A document is returned as itself; a failure as a JSON envelope. Ask once to tell which, then frame the route.
    fetch(url, { signal: ctrl.signal }).then(async (res) => {
      const type = res.headers.get('content-type') || '';
      if (/json/i.test(type) || !res.ok) {
        const env = await res.json().catch(() => null);
        setSt({ state: env?.state || 'error', env, status: res.status });
        return;
      }
      res.body?.cancel?.().catch(() => {});
      setSt({ state: 'ready', type, source: res.headers.get('x-sdt-source') || null });
    }, (err) => { if (err?.name !== 'AbortError') setSt({ state: 'error', env: { error: { message: err.message } } }); });
    return () => ctrl.abort();
  }, [url]);
  const title = doc.title || 'Document';
  const pdf = /pdf/i.test(st.type || doc.mediaType || '');
  return html`<${Modal} size="wide" title=${title} onClose=${onClose}
    sub=${`${filing.title || kindLabel(filing.kind)}, ${inst.symbol || inst.name}. ${kindLabel(filing.kind)}${filing.period ? `, period ${filing.period}` : ''}${filing.filedAt ? `, filed ${filing.filedAt.slice(0, 10)}` : ''}${filing.source ? `, source ${filing.source}` : ''}.`}
    footer=${html`<span class="small muted grow">${st.state === 'ready' ? `Served by the Terminal's document proxy${st.source ? ` (${st.source})` : ''}${doc.pages ? `, ${doc.pages} page${doc.pages > 1 ? 's' : ''}` : ''}.` : ''}</span>
      ${st.state === 'ready' ? html`<a class="btn small" href=${url} target="_blank" rel="noopener noreferrer" data-testid="doc-newtab">Open in a new tab</a>` : null}
      <${Button} small onClick=${onClose}>Close<//>`}>
    <div class="doc-view" data-testid="doc-viewer" data-doc-state=${st.state}>
      ${st.state === 'loading' ? html`<div class="ws-loading" aria-busy="true">Loading the document…</div>`
        : st.state === 'ready' ? html`${pdf ? html`<p class="note" style="margin:0 0 6px">If the PDF does not display in the frame, open it in a new tab.</p>` : null}
          <iframe class="doc-frame" src=${url} title=${title} sandbox="" referrerpolicy="no-referrer"></iframe>`
          : st.state === 'awaiting' ? html`<${Notice}><b>Awaiting Shaffer data connection.</b> ${st.env?.message?.replace(/^Awaiting Shaffer data connection\s*/, '') || 'Documents are streamed from the Shaffer gateway once it is connected.'}<//>`
            : st.state === 'unavailable' ? html`<${Empty} title="Document not available">${st.env?.message || 'The server has no document with this ID.'} Nothing is shown in its place.<//>`
              : html`<${Notice} tone="err"><b>The document could not be loaded.</b> ${st.env?.error?.message || st.env?.message || `The server answered ${st.status || 'with an error'}.`} ${st.env?.error?.retryable === false ? 'The server refused access, so it is not asked again until the connection settings change.' : 'Close and choose View again to retry.'}<//>`}
    </div>
  <//>`;
}

registerTabContent('filings', FilingsTab);
