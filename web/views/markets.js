// The four marketplaces: US Based, US Derivatives, Foreign Based, Foreign Derivatives.
// They are navigation and search filters, not accounting Books. Each row shows Current market
// price, Fair price and Gap % together; prices and analytics that are not available are blank.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { del, fmtPct, fmtPrice, get, isNum, openOverlay, post, toast, toastError, useLive, VIEW_LABEL } from '../lib/core.js';
import { Awaiting, Button, Empty, Holdings, Missing, Modal, Field, Price, Select, Signed, Support, Table, Tabs, Text } from '../lib/ui.js';
import { openInstrument } from './instrument.js';

const DESCRIPTION = {
  US_CASH: 'US-listed cash securities, US government and corporate debt, and other US cash-market instruments.',
  US_DERIV: 'US-listed derivatives and OTC contracts assigned to US market exposure.',
  FOREIGN_CASH: 'Foreign-listed cash securities, foreign government and corporate debt, and other foreign cash-market instruments.',
  FOREIGN_DERIV: 'Foreign-listed derivatives and OTC contracts assigned to foreign market exposure.',
};

function Fair({ a, field }) {
  if (!a || !isNum(a[field])) return html`<${Missing} reason="Supplied by Analytics Lab when connected" />`;
  return fmtPrice(a[field]);
}
function Gap({ a, field }) {
  if (!a || !isNum(a[field])) return html`<${Missing} reason="Supplied by Analytics Lab when connected" />`;
  return html`<${Signed} value=${a[field]} suffix="%" />`;
}

export default function Markets({ args, book, status }) {
  const view = VIEW_LABEL[args[0]] ? args[0] : 'US_CASH';
  const [list, setList] = useState('all');
  const [q, setQ] = useState('');
  useEffect(() => { setList('all'); setQ(''); }, [view]);

  const base = useLive(async () => {
    const [insts, wl] = await Promise.all([get('/api/instruments', { tagView: view, limit: 1000, bookId: book?.id }), get('/api/watchlists', { view })]);
    return { instruments: insts.items, watchlists: wl.items };
  }, [view, book?.id]);
  const instruments = base.data?.instruments || [];
  const watchlists = base.data?.watchlists || [];
  const shown = useMemo(() => {
    let rows = instruments;
    if (list !== 'all') {
      const w = watchlists.find((x) => x.id === list);
      rows = w ? w.items.map((id) => instruments.find((i) => i.id === id)).filter(Boolean) : [];
    }
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((i) => `${i.symbol || ''} ${i.name} ${i.issuer || ''} ${i.id} ${i.support.productName}`.toLowerCase().includes(needle));
    return rows;
  }, [instruments, watchlists, list, q]);

  const ids = shown.slice(0, 200).map((i) => i.id).join(',');
  const quotes = useLive(() => (ids ? get('/api/quotes', { ids }) : { quotes: {} }), [ids]);
  const qt = quotes.data?.quotes || {};
  const marketAwaiting = status.data.market.connection === 'awaiting';
  const analyticsAwaiting = status.data.analytics.connection !== 'connected';
  const deriv = view.endsWith('DERIV');
  const underlyings = useLive(async () => (deriv ? (await get('/api/instruments', { view: view.replace('DERIV', 'CASH'), limit: 1000 })).items.filter((i) => ['equity', 'fund'].includes(i.family)) : []), [view], { interval: false });

  const newWatchlist = () => openOverlay((close) => html`<${NameDialog} title="New watchlist" label="Watchlist name" onClose=${close} onSave=${async (name) => { const r = await post('/api/watchlists', { name, marketView: view }); await base.reload(); setList(r.id); }} />`);
  const create = async () => { const m = await import('./registry.js'); m.openCreateInstrument({ view, onDone: () => base.reload() }); };

  const columns = [
    { label: 'Instrument', render: (i) => html`<div class="sym">${i.symbol || i.name}</div><div class="sub clip" title=${i.name}>${i.symbol ? i.name : i.id}</div>` },
    { label: 'Product', render: (i) => html`<div>${i.support.productName.replace(/ \(.*\)$/, '')}</div><div class="sub">${i.venue || (i.venueType === 'otc' ? 'OTC' : '')}${i.domicile ? `, issuer ${i.domicile}` : ''}</div>` },
    { label: 'Current market price', align: 'r', render: (i) => html`<${Price} obs=${qt[i.id]?.observation} reason=${marketAwaiting ? status.data.awaitingMessage : 'No price available'} />` },
    { label: 'Bid / ask', align: 'r', render: (i) => (isNum(qt[i.id]?.observation?.bid) ? `${fmtPrice(qt[i.id].observation.bid)} / ${fmtPrice(qt[i.id].observation.ask)}` : html`<${Missing} />`) },
    { label: 'Change', align: 'r', render: (i) => { const o = qt[i.id]?.observation; return o && isNum(o.value) && isNum(o.prevClose) && o.prevClose ? html`<${Signed} value=${(o.value / o.prevClose - 1) * 100} suffix="%" />` : html`<${Missing} />`; } },
    { label: 'Fundamental fair price', align: 'r', title: 'Fundamental Fair Value from Analytics Lab. An analytical value, never an executable quote.', render: (i) => html`<${Fair} a=${qt[i.id]?.analytics} field="fundamentalFairValue" />` },
    { label: 'Gap %', align: 'r', title: 'Fundamental Gap', render: (i) => html`<${Gap} a=${qt[i.id]?.analytics} field="fundamentalGap" />` },
    { label: 'Realistic fair price', align: 'r', title: 'Realistic Fair Value from Analytics Lab. An analytical value, never an executable quote.', render: (i) => html`<${Fair} a=${qt[i.id]?.analytics} field="realisticFairValue" />` },
    { label: 'Gap %', align: 'r', title: 'Realistic Gap', render: (i) => html`<${Gap} a=${qt[i.id]?.analytics} field="realisticGap" />` },
    { label: 'Held in this Book', align: 'r', title: 'What this Book already holds, long or short. Hover for the Accounts.', render: (i) => html`<${Holdings} h=${i.holdings} />` },
    { label: 'Ccy', render: (i) => i.tradingCcy },
    { label: 'Paper support', render: (i) => html`<${Support} level=${i.support.level} note=${i.support.note} />` },
    { label: '', align: 'r', render: (i) => html`<${Button} small onClick=${(e) => { e.stopPropagation(); openInstrument(i.id, { tab: 'trade' }); }}>Trade<//>` },
  ];

  return html`<div>
    <div class="page-head"><div><h1>${VIEW_LABEL[view]}</h1><div class="sub">${DESCRIPTION[view]}</div></div>
      <div class="actions">
        ${deriv && underlyings.data?.length ? html`<${Select} value="" placeholder="Option chain or contract months for…" onChange=${(v) => v && openInstrument(v, { tab: 'chain' })} options=${underlyings.data.map((u) => ({ value: u.id, label: `${u.symbol || u.name}` }))} />` : null}
        <${Button} onClick=${create}>New instrument<//>
      </div></div>
    ${marketAwaiting ? html`<div style="margin-bottom:10px"><${Awaiting} compact what="Prices, reference data and option chains appear here once Shaffer MarketData is connected. Until then you can register instruments and enter prices by hand; they are always labelled as manual." /></div>` : null}
    <div class="toolbar">
      <div style="flex:1;min-width:0"><${Tabs} value=${list} onChange=${setList} tabs=${[{ id: 'all', label: 'All in this view', count: instruments.length }, ...watchlists.map((w) => ({ id: w.id, label: w.name, count: w.items.length }))]} /></div>
    </div>
    <div class="toolbar">
      <div style="width:300px"><${Text} type="search" value=${q} onInput=${setQ} placeholder="Filter by symbol, name, issuer or product" /></div>
      <${Button} small onClick=${newWatchlist}>New watchlist<//>
      ${list !== 'all' ? html`<${Button} small kind="danger" onClick=${async () => { try { await del(`/api/watchlists/${list}`); setList('all'); await base.reload(); toast('Watchlist deleted.'); } catch (e) { toastError(e); } }}>Delete this watchlist<//>` : null}
      <span class="grow"></span>
      ${analyticsAwaiting ? html`<span class="note">Fair prices and gaps: ${status.data.awaitingMessage}</span>` : null}
    </div>
    <div class="panel"><div class="body flush">
      ${base.loading && !base.data ? html`<${Empty}>Loading instruments…<//>` : html`<${Table} margin columns=${columns} rows=${shown} rowKey=${(i) => i.id} onRowClick=${(i) => openInstrument(i.id)}
        empty=${{ title: instruments.length ? 'Nothing matches' : `No instruments in ${VIEW_LABEL[view]} yet`, children: instruments.length ? 'Clear the filter or choose another list.' : marketAwaiting ? 'Reference data arrives with the Shaffer MarketData connection. You can also register an instrument by hand with New instrument.' : 'Register one with New instrument.' }} />`}
    </div></div>
    <p class="note" style="margin-top:8px">Market views are filters. A listed product is placed by its listing venue; issuer domicile and underlying geography are stored separately. Fair prices are analytical values and are never used to fill an order.</p>
  </div>`;
}

export function NameDialog({ title, label, initial = '', onSave, onClose }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave(name.trim()); onClose(); } catch (e) { toastError(e); setBusy(false); } };
  return html`<${Modal} title=${title} onClose=${onClose} footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!name.trim()} onClick=${save}>Save<//>`}>
    <${Field} label=${label}><${Text} value=${name} onInput=${setName} autofocus /><//><//>`;
}
export { fmtPct };
