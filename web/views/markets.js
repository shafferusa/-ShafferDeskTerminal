// The four Marketplaces: US Based, US Derivatives, Foreign Based, Foreign Derivatives. They are navigation and search
// filters, not accounting Books. Inside each, instruments are split into product-family tabs (catalog.js
// MARKET_TABS: every catalog product has exactly one tab), and each tab shows the columns that fit its products.
// Current market price, Fair price and Gap % sit together on every tab; each price carries its provenance chip
// (observed quote, indicative, model mark, manual or simulated). Fair price and Gap % come from Analytics Lab for the
// chosen investment Strategy and stay awaiting until it supplies them: nothing is valued here.
// Watchlists filter within the current tab or across families; they never replace the tabs.
// URL: #/markets/<view>/<tab>, with /find/<text> (a search) or /show/<instrument id> (a row picked out) after it. A
// Marketplace opened without a tab shows the tab last used in that view (kept in this browser), else the first family
// with instruments. Back and reload restore the tab from the URL. A search also lists the matches in the other three
// Marketplaces, each with its view and tab, linked there.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { del, fmtMoney, fmtNum, fmtPct, fmtPrice, fmtPriceUnits, fmtQty, get, isNum, openOverlay, post, toast, toastError, useLive, VIEW_LABEL } from '../lib/core.js';
import { Awaiting, Button, Empty, Holdings, Missing, Modal, Field, Price, Select, Signed, Support, Table, Text } from '../lib/ui.js';
import { openInstrument } from './instrument.js';

const DESCRIPTION = {
  US_CASH: 'Cash-market instruments listed on a US venue, or with a US jurisdiction when they are not listed.',
  US_DERIV: 'Derivatives listed on a US venue, OTC contracts on a US underlying, and contracts under US jurisdiction.',
  FOREIGN_CASH: 'Cash-market instruments listed outside the US, with a foreign jurisdiction, and global FX and crypto (by convention).',
  FOREIGN_DERIV: 'Derivatives listed outside the US, OTC contracts on a foreign underlying or under foreign jurisdiction, and global OTC contracts (by convention).',
};
const ROUTING_NOTE = 'Placement follows explicit metadata, never the price currency: a listed product by its listing venue\'s country, a derivative by its underlying, an unlisted instrument by its jurisdiction. '
  + 'Global FX, crypto and OTC products with no US listing and no US jurisdiction are routed by convention to the Foreign views, so a US view never implies a US listing. Each row says what placed it; a non-listed instrument can be moved by hand under Instruments.';
const FINANCING_FAMILIES = new Set(['loan', 'repo', 'secloan']);
const LAST_TAB = 'sdt.mk.tab.';
const lastTab = (view) => { try { return localStorage.getItem(LAST_TAB + view) || ''; } catch { return ''; } };
const keepTab = (view, tab) => { try { localStorage.setItem(LAST_TAB + view, tab); } catch { /* per-browser convenience only */ } };
/** The Marketplace address of an instrument: its view and tab, with the row picked out. */
export const marketHref = (i) => `#/markets/${i.marketView}/${i.classification?.tab || ''}/show/${encodeURIComponent(i.id)}`;

export default function Markets({ args, book, status }) {
  const view = VIEW_LABEL[args[0]] ? args[0] : 'US_CASH';
  const cls = view.endsWith('DERIV') ? 'deriv' : 'cash';
  const [list, setList] = useState('all');
  const [across, setAcross] = useState(false);
  const [q, setQ] = useState(args[2] === 'find' && args[3] ? decodeURIComponent(args[3]) : '');
  const focusId = args[2] === 'show' && args[3] ? decodeURIComponent(args[3]) : '';
  const [asset, setAsset] = useState('all');
  const [strategyId, setStrategyId] = useState('');
  useEffect(() => { setList('all'); setQ(args[2] === 'find' && args[3] ? decodeURIComponent(args[3]) : ''); setAsset('all'); setAcross(false); }, [view, args[2] === 'find' ? args[3] : '']);

  const cat = useLive(() => get('/api/catalog'), [], { interval: false });
  const tabs = (cat.data?.marketTabs || []).filter((t) => t.cls === cls);
  const base = useLive(async () => {
    const [insts, wl] = await Promise.all([get('/api/instruments', { view, limit: 2000, bookId: book?.id, marketplace: 1 }), get('/api/watchlists', { view })]);
    return { instruments: insts.items, watchlists: wl.items };
  }, [view, book?.id]);
  const instruments = base.data?.instruments || [];
  const watchlists = base.data?.watchlists || [];
  const wl = list !== 'all' ? watchlists.find((x) => x.id === list) : null;

  // Watchlist and search narrow the whole view; tab counts show what is left in each family.
  const filtered = useMemo(() => {
    let rows = instruments;
    if (wl) { const ids = new Set(wl.items); rows = rows.filter((i) => ids.has(i.id)); }
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((i) => `${i.symbol || ''} ${i.name} ${i.issuer || ''} ${i.id} ${i.support.productName} ${i.underlying?.symbol || ''}`.toLowerCase().includes(needle));
    return rows;
  }, [instruments, wl, q]);
  const countOf = (tabId) => filtered.filter((i) => i.classification?.tab === tabId).length;
  const firstWithRows = tabs.find((t) => instruments.some((i) => i.classification?.tab === t.id));
  const remembered = tabs.find((t) => t.id === lastTab(view));
  const tab = tabs.find((t) => t.id === args[1]) || remembered || firstWithRows || tabs[0] || null;
  // The tab is in the URL: a Marketplace opened without one shows the tab last used here, else its first family with
  // instruments, and the address is completed without adding a step to Back.
  useEffect(() => { if (tab && args[1] !== tab.id && base.data) history.replaceState(null, '', `#/markets/${view}/${tab.id}`); }, [tab?.id, view, Boolean(base.data)]);
  useEffect(() => { if (tab && args[1] === tab.id) keepTab(view, tab.id); }, [tab?.id, view, args[1]]);
  const goTab = (id) => { setAsset('all'); setAcross(false); setQ(''); location.hash = `#/markets/${view}/${id}`; };
  // A row picked out by the address (from a search, the registry or an instrument page) is marked and scrolled to.
  useEffect(() => {
    if (!focusId || !base.data) return undefined;
    const t = setTimeout(() => { const el = document.querySelector(`[data-inst="${CSS.escape(focusId)}"]`)?.closest('tr'); if (el) { el.classList.add('mk-focus'); el.scrollIntoView({ block: 'center' }); } }, 150);
    return () => clearTimeout(t);
  }, [focusId, Boolean(base.data), tab?.id]);
  // A search also looks in the other three Marketplaces; each match says its view and tab and links there.
  const needle = q.trim();
  const elsewhere = useLive(async () => {
    if (needle.length < 2) return [];
    const r = await get('/api/instruments', { q: needle, limit: 200, bookId: book?.id });
    return r.items.filter((i) => i.marketView !== view);
  }, [needle, view, book?.id], { interval: false });

  const inTab = tab ? filtered.filter((i) => i.classification?.tab === tab.id) : [];
  const assetsHere = cls === 'deriv' ? (cat.data?.assetClasses || []).map((a) => ({ ...a, n: inTab.filter((i) => i.classification?.assetClass === a.id).length })).filter((a) => a.n > 0) : [];
  const shownRows = asset === 'all' ? inTab : inTab.filter((i) => i.classification?.assetClass === asset);
  // A search looks through the whole view and a watchlist can be shown across families: either way the matches are
  // shown family by family, each table with its own family's columns (the current tab first).
  const searching = Boolean(q.trim());
  const ordered = tab ? [tab, ...tabs.filter((t) => t.id !== tab.id)] : tabs;
  const sections = searching || (wl && across) ? ordered.map((t) => ({ tab: t, rows: filtered.filter((i) => i.classification?.tab === t.id) })).filter((s) => s.rows.length) : null;
  const visible = sections ? sections.flatMap((s) => s.rows) : shownRows;

  const ids = visible.slice(0, 250).map((i) => i.id).join(',');
  const quotes = useLive(() => (ids ? get('/api/quotes', { ids, strategyId: strategyId || undefined }) : { quotes: {} }), [ids, strategyId]);
  const qt = quotes.data?.quotes || {};
  const marketAwaiting = status.data.market.connection === 'awaiting';
  const analyticsAwaiting = status.data.analytics.connection !== 'connected';
  const strategies = useLive(() => get('/api/analytics/strategies'), [], { interval: false });
  const underlyings = useLive(async () => (cls === 'deriv' ? (await get('/api/instruments', { view: view.replace('DERIV', 'CASH'), limit: 1000 })).items.filter((i) => ['equity', 'fund'].includes(i.family)) : []), [view], { interval: false });

  const newWatchlist = () => openOverlay((close) => html`<${NameDialog} title="New watchlist" label="Watchlist name" onClose=${close} onSave=${async (name) => { const r = await post('/api/watchlists', { name, marketView: view }); await base.reload(); setList(r.id); toast('Watchlist created.'); }} />`);
  const create = async () => { const m = await import('./registry.js'); m.openCreateInstrument({ view, onDone: () => base.reload() }); };
  const ctx = { qt, status, marketAwaiting, analyticsAwaiting, strategyId };

  const table = (t, rows, { title } = {}) => html`<section class="panel mk-panel">
    ${title ? html`<header><h3>${title}</h3><span class="note">${rows.length === 1 ? '1 instrument' : `${rows.length} instruments`}</span></header>` : null}
    <div class="body flush">
      ${base.loading && !base.data ? html`<${Empty}>Loading instruments…<//>` : html`<${Table} margin columns=${columnsFor(t.id, ctx)} rows=${rows} rowKey=${(i) => i.id} onRowClick=${(i) => openInstrument(i.id)}
        empty=${emptyFor(t, { instruments, filtered, inTab, wl, q, marketAwaiting, view, create })} />`}
    </div></section>`;

  return html`<div>
    <div class="page-head"><div><h1>${VIEW_LABEL[view]}</h1><div class="sub">${DESCRIPTION[view]}</div></div>
      <div class="actions">
        ${cls === 'deriv' && underlyings.data?.length ? html`<${Select} value="" placeholder="Option chain or contract months for…" onChange=${(v) => v && openInstrument(v, { tab: 'chain' })} options=${underlyings.data.map((u) => ({ value: u.id, label: `${u.symbol || u.name}` }))} />` : null}
        <${Button} onClick=${create}>New instrument<//>
      </div></div>
    ${marketAwaiting ? html`<div style="margin-bottom:10px"><${Awaiting} compact what="Prices, reference data and option chains appear here once Shaffer MarketData is connected. Until then you can register instruments and enter prices by hand; they are always labelled as manual." /></div>` : null}
    <div class="tabs mk-tabs" role="tablist" aria-label="Product families">
      ${tabs.map((t) => html`<button role="tab" aria-selected=${t.id === tab?.id} class=${t.id === tab?.id ? 'on' : ''} title=${t.holds} onClick=${() => goTab(t.id)}>${t.label}<span class="n">${countOf(t.id)}</span></button>`)}
    </div>
    <div class="toolbar mk-tools">
      <div class="mk-search"><${Text} type="search" value=${q} onInput=${setQ} placeholder="Filter by symbol, name, issuer or product" /></div>
      <label class="mk-inline"><span class="lbl">Watchlist</span><${Select} value=${list} onChange=${(v) => { setList(v); if (v === 'all') setAcross(false); }} options=${[{ value: 'all', label: 'None (every instrument)' }, ...watchlists.map((w) => ({ value: w.id, label: `${w.name} (${w.items.length})` }))]} /></label>
      ${wl ? html`<div class="seg" role="group" aria-label="Watchlist scope"><button type="button" class=${!across ? 'on' : ''} onClick=${() => setAcross(false)}>In this tab</button><button type="button" class=${across ? 'on' : ''} onClick=${() => setAcross(true)}>Across families</button></div>` : null}
      <${Button} small onClick=${newWatchlist}>New watchlist<//>
      ${wl ? html`<${Button} small kind="danger" onClick=${async () => { try { await del(`/api/watchlists/${list}`); setList('all'); setAcross(false); await base.reload(); toast('Watchlist deleted.'); } catch (e) { toastError(e); } }}>Delete this watchlist<//>` : null}
      <span class="grow"></span>
      <label class="mk-inline" title="Fair price and Gap % are asked for this investment Strategy, by its ID. A typed name is never sent."><span class="lbl">Fair price for</span>
        ${strategies.data?.available ? html`<${Select} value=${strategyId} onChange=${setStrategyId} placeholder="Choose a Strategy" options=${strategies.data.items.map((s) => ({ value: s.id, label: `${s.name} (${s.id})` }))} />`
          : html`<${Select} value="" disabled placeholder=${strategies.data ? 'Strategy list awaiting' : 'Loading…'} options=${[]} />`}</label>
    </div>
    ${!sections && assetsHere.length > 1 ? html`<div class="toolbar"><span class="lbl">Underlying</span><div class="seg" role="group" aria-label="Underlying asset class">
      <button type="button" class=${asset === 'all' ? 'on' : ''} onClick=${() => setAsset('all')}>All <span class="muted">${inTab.length}</span></button>
      ${assetsHere.map((a) => html`<button type="button" class=${asset === a.id ? 'on' : ''} onClick=${() => setAsset(a.id)}>${a.label} <span class="muted">${a.n}</span></button>`)}</div></div>` : null}
    ${tab && !sections ? html`<p class="note mk-holds">${tab.holds}${analyticsAwaiting ? ` Fair price and Gap %: ${status.data.awaitingMessage}.` : ''}</p>` : null}
    ${sections ? html`<p class="note mk-holds">${searching ? `Matches for "${q.trim()}" in every family of ${VIEW_LABEL[view]}${wl ? ` on ${wl.name}` : ''}` : `${wl.name} across every family in ${VIEW_LABEL[view]}`}, one table per family. Choose a tab to see one family.${analyticsAwaiting ? ` Fair price and Gap %: ${status.data.awaitingMessage}.` : ''}</p>
        ${sections.length ? sections.map((s) => table(s.tab, s.rows, { title: s.tab.label })) : html`<div class="panel"><div class="body"><${Empty} title=${searching ? `Nothing in ${VIEW_LABEL[view]}${wl ? ` on ${wl.name}` : ''} matches "${q.trim()}"` : `Nothing on ${wl.name}`}>${searching ? 'Check the symbol, or look in another Marketplace: an instrument sits in the view its listing venue, underlying or jurisdiction gives it.' : 'Open an instrument and choose Add to watchlist.'}<//></div></div>`}`
      : tab ? table(tab, shownRows) : html`<${Empty}>Loading product families…<//>`}
    ${searching ? html`<${Elsewhere} q=${q.trim()} hits=${elsewhere.data} tabsAll=${cat.data?.marketTabs || []} />` : null}
    ${tab?.id === 'money' && !sections ? html`<${FinancingPanel} book=${book} products=${(cat.data?.products || []).filter((p) => p.tab === 'money' && FINANCING_FAMILIES.has(p.family))} />` : null}
    <p class="note" style="margin-top:8px">Choose a row to open its instrument page and trade ticket. Fair price and Gap % show the fundamental value above the realistic one; they are analytical values and never fill an order. ${ROUTING_NOTE}</p>
  </div>`;
}

/** Matches for the search in the other Marketplaces, grouped by view and tab, each group linked to its place. */
function Elsewhere({ q, hits, tabsAll }) {
  if (!hits) return null;
  const groups = new Map();
  for (const i of hits) { const k = `${i.marketView}/${i.classification?.tab || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const label = (k) => { const [v, t] = k.split('/'); return `${VIEW_LABEL[v]}, ${tabsAll.find((x) => x.id === t)?.label || t}`; };
  return html`<div class="panel mk-panel mk-elsewhere"><div class="body">
    <h4 style="margin:0 0 4px">In the other Marketplaces</h4>
    ${groups.size ? html`<ul class="mk-hits">${[...groups].map(([k, list]) => html`<li><a href=${list.length === 1 ? marketHref(list[0]) : `#/markets/${k}/find/${encodeURIComponent(q)}`}>${label(k)}</a>
      <span class="muted">${list.slice(0, 6).map((i) => i.symbol || i.name).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''}</span></li>`)}</ul>`
      : html`<p class="note" style="margin:0">Nothing in US Based, US Derivatives, Foreign Based or Foreign Derivatives other than this view matches "${q}".</p>`}
  </div></div>`;
}

// ---- empty states ---------------------------------------------------------------------------------------------------
function emptyFor(t, { instruments, filtered, inTab, wl, q, marketAwaiting, view }) {
  const elsewhere = filtered.length - inTab.length;
  if (inTab.length) return { title: 'Nothing matches', children: 'Choose All under Underlying.' };
  if (q.trim() || wl) return { title: `Nothing in ${t.label}${wl ? ` on ${wl.name}` : ''}${q.trim() ? ' matches the filter' : ''}`, children: elsewhere ? `${elsewhere === 1 ? 'One instrument in another family matches' : `${elsewhere} instruments in other families match`}: see the counts on the tabs.` : q.trim() ? 'Clear the filter or choose another watchlist.' : 'Open an instrument and choose Add to watchlist.' };
  const how = t.id === 'money' ? ' Commercial paper and bankers\' acceptances are registered with New instrument; deposits, loans, repo and securities lending are arranged on the Treasury and Account pages (below).'
    : t.id === 'fx' ? ' Register a currency pair with New instrument (product Spot FX). Currency balances are ledger cash on the Treasury and Account pages.'
      : marketAwaiting ? ' Reference data arrives with the Shaffer MarketData connection; until then register one with New instrument.' : ' Register one with New instrument.';
  return { title: `Nothing in ${t.label} in ${VIEW_LABEL[view]} yet`, children: `What belongs here is described above.${how}` };
}

// ---- cells -----------------------------------------------------------------------------------------------------------
const sym = (i) => i.symbol || i.name;
const obsOf = (ctx, i) => ctx.qt[i.id]?.observation || null;
const priceReason = (ctx, i) => (['swap', 'cds', 'forward', 'otcoption'].includes(i.family) ? 'No mark yet: a dealer or model mark from Analytics Lab when connected, or a manual mark entered on the instrument page'
  : i.family === 'manual' ? 'Valued by hand: enter a valuation on the instrument page' : ctx.marketAwaiting ? ctx.status.data.awaitingMessage : 'No price available');
const date = (d) => d || html`<${Missing} reason="Not in the contract terms" />`;
const pct = (x, dp = 3) => (isNum(x) ? `${fmtNum(x * 100, dp).replace(/0+$/, '').replace(/\.$/, '')}%` : null);

function instCell(i) {
  return html`<div class="sym" data-inst=${i.id}>${sym(i)}</div><div class="sub clip" style="max-width:190px" title=${i.name}>${i.symbol ? i.name : i.id}</div>
    <div class="sub mk-route" title=${`Market view, ${(i.classification?.routing?.basisLabel || '').toLowerCase()}: ${i.classification?.routing?.text || ''}`}>${i.classification?.routing?.short}</div>
    ${i.calendar?.flag ? html`<div class="calflag" style="max-width:240px" title=${i.calendar.flagText}><span class="pill warn">${i.calendar.flag === 'weekends-only' ? 'weekends-only calendar' : 'approximate calendar'}</span> ${i.calendar.flag === 'weekends-only' ? 'Its dates ignore local holidays.' : 'Some closing days are missing from its dates.'}</div>` : null}`;
}
const productCell = (i) => html`<div class="clip" style="max-width:170px" title=${i.support.productName}>${i.support.productName.replace(/ \(.*\)$/, '')}</div><div class="sub">${[i.venue || (i.venueType === 'otc' ? 'OTC' : i.venueType === 'global' ? 'Global' : ''), i.tradingCcy].filter(Boolean).join(', ')}</div>`;

/** Fair price and gap must be for the same contract, currency, units and Strategy as the market price beside them. */
function fairOf(ctx, i) {
  if (ctx.analyticsAwaiting) return { why: `${ctx.status.data.awaitingMessage}. Fair prices come from Analytics Lab; the Terminal does not value instruments.`, awaiting: true };
  const a = ctx.qt[i.id]?.analytics;
  if (!a) return { why: 'Not supplied by Analytics Lab for this instrument' };
  if (a.fairValueCurrency && a.fairValueCurrency !== i.tradingCcy) return { why: `The fair value is in ${a.fairValueCurrency} but the market price is in ${i.tradingCcy}; not shown side by side` };
  if (a.priceUnits && i.priceUnits && a.priceUnits !== i.priceUnits) return { why: `The fair value is ${a.priceUnits} but the market price is ${i.priceUnits}; not shown side by side` };
  const sid = a.strategyId ?? a.strategy?.id ?? null;
  if (sid && ctx.strategyId && sid !== ctx.strategyId) return { why: `Supplied for Strategy ${sid}, not the one chosen` };
  if (sid && !ctx.strategyId) return { why: `Supplied for Strategy ${sid}: choose it under Fair price for` };
  return { a };
}
function twoCell(ctx, i, f1, f2, draw) {
  const f = fairOf(ctx, i);
  if (!f.a) return f.awaiting ? html`<span class="muted small" title=${f.why}>Awaiting</span>` : html`<${Missing} reason=${f.why} />`;
  const a = f.a;
  if (!isNum(a[f1]) && !isNum(a[f2])) return html`<${Missing} reason="Not supplied by Analytics Lab" />`;
  return html`<div title="Fundamental">${isNum(a[f1]) ? draw(a[f1]) : html`<${Missing} reason="Not supplied" />`}</div><div class="sub" title="Realistic">${isNum(a[f2]) ? draw(a[f2]) : html`<${Missing} reason="Not supplied" />`}</div>`;
}

const C = {
  inst: (label = 'Instrument') => ({ label, render: instCell }),
  product: () => ({ label: 'Product', render: productCell }),
  held: (label = 'Held in this Book') => ({ label, align: 'r', title: 'Gross long and short holdings in this Book, with the net. Hover for the owning Accounts.', render: (i) => html`<${Holdings} h=${i.holdings} />` }),
  price: (ctx, label = 'Current market price', title) => ({ label, align: 'r', title: title || 'The latest price with its provenance: observed quote, indicative, model mark, manual or simulated (hover the chip).', render: (i) => html`<${Price} obs=${obsOf(ctx, i)} units=${i.priceUnits} reason=${priceReason(ctx, i)} />` }),
  bidAsk: (ctx) => ({ label: 'Bid / ask', align: 'r', render: (i) => { const o = obsOf(ctx, i); return isNum(o?.bid) ? `${fmtPriceUnits(o.bid, i.priceUnits)} / ${fmtPriceUnits(o.ask, i.priceUnits)}` : html`<${Missing} reason="No bid or ask in the latest observation" />`; } }),
  change: (ctx) => ({ label: 'Change', align: 'r', title: 'Against the previous close', render: (i) => { const o = obsOf(ctx, i); return o && isNum(o.value) && isNum(o.prevClose) && o.prevClose ? html`<${Signed} value=${(o.value / o.prevClose - 1) * 100} suffix="%" />` : html`<${Missing} reason="No previous close" />`; } }),
  fair: (ctx) => ({ label: 'Fair price', align: 'r', title: 'Fair value from Analytics Lab for the chosen Strategy, in the same currency and units as the market price: fundamental above, realistic below. An analytical value, never an executable quote.', render: (i) => twoCell(ctx, i, 'fundamentalFairValue', 'realisticFairValue', (v) => fmtPriceUnits(v, i.priceUnits)) }),
  gap: (ctx) => ({ label: 'Gap %', align: 'r', title: 'Gap between the current market price and each fair value, as supplied by Analytics Lab: fundamental above, realistic below.', render: (i) => twoCell(ctx, i, 'fundamentalGap', 'realisticGap', (v) => html`<${Signed} value=${v} suffix="%" />`) }),
  life: () => ({ label: 'Lifecycle', title: 'How much of the instrument\'s lifecycle the paper engine simulates. Separate from whether a price is available, which the price column shows.', render: (i) => html`<${Support} level=${i.support.level} note=${i.support.note} />` }),
  und: () => ({ label: 'Underlying', render: (i) => (i.underlying ? html`<span class="sym">${i.underlying.symbol || i.underlying.name}</span>` : i.terms?.base ? `${i.terms.base}/${i.terms.quote}` : i.terms?.referenceEntity || html`<${Missing} reason="No registered underlying" />`) }),
  expiry: (label = 'Expiry') => ({ label, render: (i) => date(i.terms?.expiration || i.terms?.valueDate || i.terms?.maturity) }),
};
const market = (ctx) => [C.price(ctx), C.fair(ctx), C.gap(ctx)];

/** Columns per tab: what fits the products in it, with Current market price, Fair price and Gap % together. */
function columnsFor(tab, ctx) {
  switch (tab) {
    case 'equities': return [C.inst(), C.product(), C.held(), C.price(ctx), C.bidAsk(ctx), C.change(ctx), C.fair(ctx), C.gap(ctx), C.life()];
    case 'funds': return [C.inst(), C.product(), C.held(), C.price(ctx, 'Current market price', 'Exchange price for an exchange-traded fund or note; net asset value per share for a mutual fund, with its date.'),
      { label: 'Price basis', render: (i) => { const o = obsOf(ctx, i); return i.family === 'fund' ? html`NAV<div class="sub">${o?.forDate || (o?.asOf ? o.asOf.slice(0, 10) : 'no NAV yet')}</div>` : 'Exchange price'; } },
      C.change(ctx), C.fair(ctx), C.gap(ctx), C.life()];
    case 'bonds': return [C.inst(), C.product(),
      { label: 'Coupon', align: 'r', render: (i) => { const t = i.terms || {}; return t.couponType === 'float' || t.couponType === 'floating' ? html`${t.referenceRate || 'Floating'}${isNum(t.spread) ? ` + ${fmtNum(t.spread * 1e4, 0)} bp` : ''}` : isNum(t.couponRate) ? html`${pct(t.couponRate)}<div class="sub">${t.frequency ? `${t.frequency}× a year` : ''}</div>` : t.couponType === 'zero' || t.couponType === 'discount' ? 'Zero' : html`<${Missing} reason="Not in the contract terms" />`; } },
      { label: 'Maturity', render: (i) => (i.terms?.maturity ? i.terms.maturity : i.terms?.perpetual ? 'Perpetual' : html`<${Missing} reason="Not in the contract terms" />`) },
      C.held('Face held'), C.price(ctx, 'Current market price', 'Clean price in % of par, shown with every decimal it carries, with its provenance.'),
      { label: 'Accrued', align: 'r', title: 'Accrued interest per 100 face to today, from the coupon schedule (contract arithmetic).', render: (i) => (isNum(i.market?.accruedPer100) ? html`${fmtNum(i.market.accruedPer100, 4)}<div class="sub">per 100</div>` : html`<${Missing} reason="No accrued interest worked out for this contract today" />`) },
      { label: 'Yield', align: 'r', title: 'Only when Shaffer MarketData supplies it with the price. The Terminal does not compute yields.', render: (i) => { const y = obsOf(ctx, i)?.yield; return isNum(y) ? fmtPct(y * (Math.abs(y) < 1 ? 100 : 1), 3) : html`<${Missing} reason="Supplied with the price by Shaffer MarketData; not computed here" />`; } },
      C.fair(ctx), C.gap(ctx), C.life()];
    case 'money': return [C.inst(), C.product(),
      { label: 'Rate or terms', render: (i) => { const t = i.terms || {}; return isNum(t.rate) ? pct(t.rate) : isNum(t.couponRate) ? pct(t.couponRate) : i.family === 'bond' ? 'Discount, redeems at par' : i.family === 'fund' ? 'NAV-priced fund' : html`<${Missing} reason="Not in the contract terms" />`; } },
      { label: 'Maturity or term', render: (i) => i.terms?.maturity || (i.family === 'fund' ? 'Open-ended' : html`<${Missing} reason="Not in the contract terms" />`) },
      C.held(), ...market(ctx), C.life()];
    case 'fx': return [C.inst('Pair'), C.held('Held (base currency)'), C.price(ctx, 'Current market price', 'Rate in quote currency per unit of base currency, with its provenance.'), C.bidAsk(ctx), C.change(ctx),
      { label: 'Value date convention', render: (i) => html`${i.settlement?.label || 'Book default'}<div class="sub">${i.terms?.base && i.terms?.quote ? `${i.terms.base} and ${i.terms.quote} calendars` : ''}</div>` },
      C.fair(ctx), C.gap(ctx), C.life()];
    case 'commodities': return [C.inst(), C.product(), { label: 'Price units', render: (i) => html`${i.priceUnits || ''}<div class="sub">${i.tradingCcy}</div>` }, C.held(), C.price(ctx), C.bidAsk(ctx), C.change(ctx), C.fair(ctx), C.gap(ctx), C.life()];
    case 'crypto': return [C.inst(), C.product(), C.held('Units held'), C.price(ctx), C.bidAsk(ctx), C.change(ctx), { label: 'Trading days', render: () => 'Every calendar day' }, C.fair(ctx), C.gap(ctx), C.life()];
    case 'alternatives': return [C.inst(), C.product(), C.held(), C.price(ctx, 'Current market price', 'A valuation entered by hand, labelled manual.'), C.fair(ctx), C.gap(ctx), C.life()];
    case 'options': return [C.inst('Contract'), C.und(),
      { label: 'Right', render: (i) => (i.terms?.right === 'C' ? 'Call' : i.terms?.right === 'P' ? 'Put' : i.terms?.right || html`<${Missing} />`) },
      { label: 'Strike', align: 'r', render: (i) => (isNum(i.terms?.strike) ? fmtPrice(i.terms.strike) : isNum(i.terms?.capRate ?? i.terms?.strikeRate) ? pct(i.terms.capRate ?? i.terms.strikeRate) : html`<${Missing} reason="See the contract legs" />`) },
      C.expiry(),
      { label: 'Deliverable', align: 'r', render: (i) => (i.terms?.deliverable ? html`${fmtQty(i.terms.deliverable.units)}<div class="sub">${i.terms.settlement === 'cash' ? 'cash-settled' : 'units per contract'}</div>` : i.terms?.settlement ? i.terms.settlement : html`<${Missing} />`) },
      C.held('Contracts held'), C.price(ctx, 'Current market price', 'Premium per underlying unit, with its provenance.'), C.bidAsk(ctx), C.fair(ctx), C.gap(ctx), C.life()];
    case 'futures': return [C.inst('Contract'), C.und(), C.expiry(), C.held('Contracts held'), C.price(ctx), C.change(ctx),
      { label: 'Contract value', align: 'r', title: 'Current market price times the multiplier, in the trading currency.', render: (i) => { const v = obsOf(ctx, i)?.value; return isNum(v) && isNum(i.multiplier) ? html`${fmtMoney(v * i.multiplier, i.tradingCcy)}<div class="sub">× ${fmtNum(i.multiplier, 0)}</div>` : html`<${Missing} reason="Needs a current market price" />`; } },
      { label: 'Initial margin', align: 'r', title: 'Per contract, from the contract terms.', render: (i) => (isNum(i.terms?.initialMargin) ? html`${fmtMoney(i.terms.initialMargin, i.tradingCcy)}<div class="sub">per contract</div>` : html`<${Missing} reason="Not in the contract terms" />`) },
      C.fair(ctx), C.gap(ctx), C.life()];
    case 'forwards': return [C.inst('Contract'), C.und(),
      { label: 'Value date', render: (i) => date(i.terms?.valueDate || i.terms?.periodStart || i.terms?.settlementDate) },
      { label: 'Agreed terms', align: 'r', render: (i) => { const t = i.terms || {}; return isNum(t.forwardRate) ? fmtPrice(t.forwardRate) : isNum(t.forwardPrice) ? fmtPrice(t.forwardPrice) : isNum(t.fixedRate) ? pct(t.fixedRate) : html`<${Missing} reason="Stated on the trade" />`; } },
      C.held('Notional held'), C.price(ctx, 'Current market price', 'A dealer or model mark (Analytics Lab), or a manual mark meanwhile: the chip says which.'), C.fair(ctx), C.gap(ctx), C.life()];
    case 'swaps': return [C.inst('Contract'),
      { label: 'Legs', render: (i) => { const legs = (i.details || []).filter(([k]) => /^Leg /.test(k)); return legs.length ? legs.map(([k, v]) => html`<div class="clip mk-legs" title=${`${k}: ${v}`}><span class="muted">${k.replace('Leg ', '')}</span> ${v}</div>`) : html`<${Missing} reason="No legs in the contract terms" />`; } },
      { label: 'Maturity', render: (i) => date(i.terms?.maturity) }, C.held('Notional held'),
      C.price(ctx, 'Current market price', 'Mark per 100 notional and its kind: dealer or model mark (Analytics Lab), or manual. The chip says which.'), C.fair(ctx), C.gap(ctx), C.life()];
    case 'credit': return [C.inst('Contract'),
      { label: 'Reference', render: (i) => i.terms?.referenceEntity || (i.underlying ? i.underlying.symbol || i.underlying.name : html`<${Missing} />`) },
      { label: 'Running coupon', align: 'r', render: (i) => (isNum(i.terms?.coupon) ? `${fmtNum(i.terms.coupon * 1e4, 0)} bp` : html`<${Missing} reason="Not in the contract terms" />`) },
      { label: 'Maturity', render: (i) => date(i.terms?.maturity) }, C.held('Notional held'),
      C.price(ctx, 'Current market price', 'Upfront per 100 notional and its kind (model or manual mark); the chip says which.'), C.fair(ctx), C.gap(ctx), C.life()];
    default: return [C.inst('Contract'), C.product(),
      { label: 'Terms', render: (i) => { const d = (i.details || []).slice(0, 2); return d.length ? d.map(([k, v]) => html`<div class="clip" style="max-width:300px" title=${`${k}: ${v}`}><span class="muted">${k}</span> ${v}</div>`) : html`<${Missing} />`; } },
      C.held(), ...market(ctx), C.life()];
  }
}

// ---- financing: arranged on Treasury and Account pages ---------------------------------------------------------------
function FinancingPanel({ book, products }) {
  if (!book) return null;
  const accounts = book.units.filter((u) => u.kind === 'account');
  const groups = [['loan', 'Deposits and loans'], ['repo', 'Repo and reverse repo'], ['secloan', 'Securities borrowing and lending']];
  return html`<section class="panel mk-panel"><header><h3>Deposits, loans, repo and securities lending</h3><span class="note">Arranged on the Treasury and Account pages</span></header>
    <div class="body">
      <p class="note" style="margin-top:0">These are arrangements of one Book, not traded instruments, so they are not listed as rows here. Borrow, lend, repo and pledge collateral from Treasury (the Book's own balance sheet) or from an Account. An instrument page links to the same dialogs with the security filled in.</p>
      <div class="mk-fin">${groups.map(([fam, label]) => html`<div><h4>${label}</h4><div class="sub">${products.filter((p) => p.family === fam).map((p) => p.name).join(', ')}</div></div>`)}</div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap"><a class="btn small" href="#/treasury/borrowings">Treasury borrowings and lending</a>${accounts.map((a) => html`<a class="btn small" href=${`#/account/${a.id}`}>${a.name}</a>`)}
        ${accounts.length ? null : html`<span class="note">No Accounts in ${book.name} yet: Treasury arranges its own financing.</span>`}</div>
    </div></section>`;
}

export function NameDialog({ title, label, initial = '', onSave, onClose }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave(name.trim()); onClose(); } catch (e) { toastError(e); setBusy(false); } };
  return html`<${Modal} title=${title} onClose=${onClose} footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!name.trim()} onClick=${save}>Save<//>`}>
    <${Field} label=${label}><${Text} value=${name} onInput=${setName} autofocus /><//><//>`;
}
export { fmtPct };
