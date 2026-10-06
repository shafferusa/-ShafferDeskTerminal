// Instruments: the Terminal's own registry, the form that registers or edits an instrument, and
// the catalog's coverage report. Instruments are identified by Terminal IDs, never by ticker.
// A product appearing in the catalog is not a claim of support. Two separate things are stated for
// every product and instrument, and never merged: lifecycle support (what the paper engine
// simulates, and what is entered by hand) and pricing coverage (where its price comes from, and
// whether one is on hand now). Each instrument also names the settlement calendar it uses and how
// that calendar was chosen; a market with no calendar says it falls back to weekends only.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { bump, fmtNum, get, isNum, openOverlay, post, put, titleCase, toast, useLive, VIEW_LABEL } from '../lib/core.js';
import { Awaiting, Button, Check, Empty, ErrorNote, Field, Holdings, Missing, Modal, Notice, Num, Panel, Pill, Prov, Select, Seg, Support, Table, Tabs, Text } from '../lib/ui.js';
import { ContractFields, draftToContract, newDraft } from '../lib/contracts.js';
import { openInstrument } from './instrument.js';

const ARRANGEMENTS = ['loan', 'repo', 'secloan'];
const LEVELS = [
  ['full', 'Full lifecycle', 'Contract terms, cash flows and lifecycle events are simulated automatically from the registered terms and from prices and fixings that are supplied or entered. The note names anything that is not simulated.'],
  ['partial', 'Partly manual', 'Tradable and fully accounted, but the lifecycle events named in the note are recorded by hand.'],
  ['manual', 'Manual inputs', 'Can be registered and held. Valuation and cash flows are entered by hand; nothing is simulated automatically.'],
];
const short = (name) => String(name || '').replace(/ \(.*\)$/, '');
const pct = (x, dp = 2) => `${fmtNum(x * 100, dp)}%`;
const refSource = (s) => (!s || s === 'manual' ? 'Entered by hand' : s === 'demo' ? 'Demo seed' : /^shaffer/i.test(s) ? 'Shaffer MarketData' : titleCase(s));
const shafferMissing = html`<${Missing} reason="Not linked. The Shaffer MarketData ID is stored here once reference data is connected, or entered by hand." />`;

/** Why a catalog product is not registered through this form, or null when it is. */
function notRegistered(p) {
  if (p.support === 'planned') return `${short(p.name)} is not implemented yet and cannot be registered.`;
  if (p.family === 'cash') return 'Currency balances are held as ledger cash in Treasury and each Account, not as registry instruments. Register a currency pair to convert between currencies.';
  if (ARRANGEMENTS.includes(p.family)) return `${short(p.name)} is opened from Treasury or the Account, where its cash and collateral legs are previewed. The arrangement registers itself when the ticket is confirmed.`;
  if (p.id === 'short_sale') return 'A short sale is placed from the trade ticket of the security itself (Sell short), always with its securities borrow leg. Register the security, not the sale.';
  return null;
}

let catalogPromise = null;
const loadCatalog = () => (catalogPromise ||= get('/api/catalog').catch((err) => { catalogPromise = null; throw err; }));

// ---- pricing coverage: where a price comes from, kept apart from lifecycle support ------------------------------
// [basis, pill, pill tone, what an instrument on this basis needs, the same in two words for a table cell]
const BASES = [
  ['quoted', 'market quote', '', 'A quote from Shaffer MarketData or a price entered by hand is needed.', 'quote awaited'],
  ['model', 'model mark', '', 'A mark from Shaffer Analytics Lab or one entered by hand is needed.', 'mark awaited'],
  ['contractual', 'no price needed', '', 'Carried at principal plus accrued.', ''],
  ['manual', 'valued by hand', 'warn', 'A value entered by hand is needed.', 'enter by hand'],
];
const basisOf = (id) => BASES.find((b) => b[0] === id) || [id, id, '', '', ''];
const Basis = ({ id, title }) => html`<${Pill} tone=${basisOf(id)[2]} title=${title}>${basisOf(id)[1]}<//>`;
const OBS_STATUS = { 'real-time': 'Real-time', delayed: 'Delayed', 'end-of-day': 'End of day', indicative: 'Indicative', 'model-derived': 'Model', reconstructed: 'Reconstructed', manual: 'Manual', simulated: 'Simulated' };
/**
 * Whether a price is on hand now. `quote` is the instrument's entry from /api/quotes when it was
 * asked for (the server only knows a price for instruments it has been asked to quote); without
 * it the state the registry reported is used.
 */
function pricedNow(i, quote) {
  const p = i.pricing || {};
  if (p.state === 'not-needed') return { state: 'not-needed' };
  if (quote) { const o = quote.observation; return o && (isNum(o.value) || isNum(o.bid)) ? { state: 'priced', obs: o, stale: o.freshness === 'stale' } : { state: 'unpriced' }; }
  return { state: p.state, current: p.current };
}
function PricingNow({ inst, quote }) {
  const p = pricedNow(inst, quote);
  const basis = inst.pricing?.basis;
  const tip = `Pricing coverage: ${inst.pricing?.basisLabel || 'not stated'}.`;
  if (p.state === 'not-needed') return html`<${Pill} title=${`${tip}\n${basisOf(basis)[3]}`}>not needed<//>`;
  if (p.state !== 'priced') return html`<div><${Pill} tone="warn" title=${`${tip}\nNo price is on hand for this instrument. ${basisOf(basis)[3]}`}>no price yet<//></div><div class="sub" style="margin-top:2px">${basisOf(basis)[4]}</div>`;
  // The provenance chip carries the status, with the source and time on hover, as it does beside every price.
  const source = p.obs?.source || p.current?.source || '';
  return html`<div><${Pill} tone=${p.stale ? 'warn' : 'ok'} title=${`${tip}\n${p.stale ? 'The price on hand is older than its freshness limit.' : 'A price is on hand for this instrument.'}${source ? `\nSource: ${source}` : ''}`}>${p.stale ? 'stale price' : 'priced now'}<//></div>
    <div class="sub" style="margin-top:2px">${p.obs ? html`<${Prov} obs=${p.obs} />` : html`<span class="clip" style="max-width:100px" title=${source}>${[OBS_STATUS[p.current?.status] || p.current?.status, source].filter(Boolean).join(', ')}</span>`}</div>`;
}

// ---- settlement calendars ---------------------------------------------------------------------------------------
// Mirrors COUNTRY_CALENDAR in server/quant/calendar.js: the built-in calendar a listing-venue country selects.
const EURO_AREA = ['DE', 'FR', 'NL', 'BE', 'IT', 'ES', 'PT', 'IE', 'AT', 'FI', 'LU', 'GR'];
export const COUNTRY_CALENDAR = { US: 'US', GB: 'UK', UK: 'UK', JP: 'JP', CA: 'CA', ...Object.fromEntries(EURO_AREA.map((c) => [c, 'TARGET'])) };
let calendarsPromise = null;
const loadCalendars = () => (calendarsPromise ||= get('/api/calendars').catch((err) => { calendarsPromise = null; throw err; }));
/**
 * The calendar the server will choose for a draft, before it is saved: mirrors calendarInfo in
 * server/products/security.js (and the spot FX rule in server/products/fx.js). `cals` is the
 * /api/calendars payload. Returns null while a currency pair is incomplete.
 */
function expectedCalendar(d, cals) {
  const label = (id) => cals.calendars.find((c) => c.id === id)?.label || id;
  const byCcy = cals.currencyCalendars || {};
  const done = (id, basis, note = null) => ({ id, label: label(id), basis, fallback: id === 'WEEKEND', note });
  if (d.family === 'crypto') return done('ALLDAYS', 'explicit');
  if (d.family === 'fx') {
    const pair = [d.terms?.base, d.terms?.quote].map((c) => String(c || '').toUpperCase());
    if (!pair.every((c) => /^[A-Z]{3}$/.test(c))) return null;
    const missing = pair.filter((c) => !byCcy[c]);
    return { id: [...new Set([...pair.map((c) => byCcy[c] || 'WEEKEND'), 'USD'])].join('+'), label: `Payment calendars of ${pair[0]} and ${pair[1]}`, basis: 'currency', fallback: missing.length > 0,
      note: missing.length ? `No payment calendar is built in for ${missing.join(' and ')}: weekends only are used for ${missing.length > 1 ? 'them' : 'it'}, so local holidays are not recognised.` : null };
  }
  const explicit = d.terms?.calendar;
  if (explicit && (cals.calendars.some((c) => c.id === explicit) || String(explicit).includes('+'))) return done(explicit, 'explicit');
  const us = d.marketView === 'US_CASH' || d.marketView === 'US_DERIV';
  const bond = d.family === 'bond';
  const country = String(d.venueCountry || '').trim().toUpperCase() || (us && d.venueType !== 'otc' ? 'US' : '');
  if (country) {
    const cal = COUNTRY_CALENDAR[country];
    if (cal === 'US') return done(bond ? 'USBOND' : 'US', 'venue');
    if (cal) return done(cal, 'venue', EURO_AREA.includes(country) ? 'TARGET closing days are used for this euro-area venue. Any further closing days of its exchange are not included; add them as extra holidays.' : null);
    return done('WEEKEND', 'fallback', `No holiday calendar is built in for venues in ${country}. Dates use weekends only until Shaffer MarketData supplies the calendar.`);
  }
  if (us) return done(bond ? 'USBOND' : 'US', 'venue');
  const trading = String(d.tradingCcy || '').toUpperCase(), settle = String(d.settleCcy || '').toUpperCase() || trading;
  if (byCcy[settle] || byCcy[trading]) return done(byCcy[settle] || byCcy[trading], 'currency', `No venue country is recorded, so the ${settle} payment calendar is used. Enter the venue country to use its market calendar.`);
  return done('WEEKEND', 'fallback', `No venue country is recorded and no payment calendar is built in for ${trading || 'the trading currency'}. Dates use weekends only.`);
}
/** How a calendar was chosen, in words. `d` carries family, venueCountry and tradingCcy (an instrument view or a draft). */
function calendarBasis(cal, d) {
  if (d.family === 'crypto') return 'Digital assets settle on every calendar day.';
  if (d.family === 'fx') return 'A spot FX value date is a business day for both currencies and a US dollar banking day.';
  if (cal.basis === 'explicit') return 'Set on the instrument itself.';
  if (cal.basis === 'venue') return d.venueCountry ? `Chosen from the venue country, ${d.venueCountry}.` : 'Chosen from its US market view; no venue country is recorded.';
  if (cal.basis === 'currency') return 'Inferred from the trading currency, because no venue country is recorded.';
  return 'Weekends-only fallback: no holiday calendar exists for this market.';
}

/** Expiration, maturity and strike, where the product has them. */
function keyTerms(i) {
  const t = i.terms || {};
  const mult = i.multiplier !== 1 ? `multiplier ${i.multiplier}` : '';
  const two = (a, b) => html`<div>${a}</div>${b ? html`<div class="sub">${b}</div>` : null}`;
  switch (i.family) {
    case 'option': case 'otcoption': return two(`${t.right === 'P' ? 'Put' : 'Call'} ${t.strike}${mult ? `, ${mult}` : ''}`, `expires ${t.expiration}`);
    case 'future': return two(t.perpetual ? 'Perpetual' : `Expires ${t.expiration}`, mult);
    case 'bond': return two(t.perpetual ? 'Perpetual' : `Matures ${t.maturity}`, t.couponType === 'zero' ? 'zero coupon' : t.couponType === 'float' ? `floating, ${t.referenceRate}` : isNum(t.couponRate) ? `${pct(t.couponRate, 3)} fixed` : '');
    case 'forward': return two(t.forwardType === 'fra' ? `Period ${t.periodStart} to ${t.periodEnd}` : `Value date ${t.valueDate}`, t.base ? `${t.base}/${t.quote}` : '');
    case 'swap': return two(`Matures ${t.maturity}`, `${(t.legs || []).length} leg${(t.legs || []).length === 1 ? '' : 's'}, from ${t.effective}`);
    case 'cds': return two(`Matures ${t.maturity}`, isNum(t.coupon) ? `${fmtNum(t.coupon * 1e4, 0)} bp running` : '');
    case 'loan': return two(t.maturity ? `Matures ${t.maturity}` : 'Open-ended', '');
    case 'repo': return two(t.endDate ? `Ends ${t.endDate}` : t.term === 'overnight' ? 'Overnight' : 'Open', '');
    case 'fx': return two(`${t.base}/${t.quote}`, '');
    default: return mult ? html`<span class="sub">${mult}</span>` : '';
  }
}

// ---- reference-data search ------------------------------------------------------------------------------------
function ReferenceSearch({ onRegister }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const seq = useRef(0);
  useEffect(() => {
    const s = q.trim();
    const n = ++seq.current;
    if (s.length < 2) { setRes(null); return undefined; }
    const t = setTimeout(() => get('/api/search', { q: s }).then((r) => { if (n === seq.current) setRes(r); }, (error) => { if (n === seq.current) setRes({ error }); }), 250);
    return () => clearTimeout(t);
  }, [q]);
  const ref = res?.reference;
  const hitName = (h) => h.symbol || h.name || h.id || h.externalId || 'Unnamed result';
  return html`<${Panel} title="Search Shaffer reference data" note="Looks in Shaffer MarketData and in this registry">
    <div class="row"><div style="width:380px"><${Text} type="search" value=${q} onInput=${setQ} placeholder="Symbol, name, issuer or identifier (two characters or more)" /></div>
      ${!res ? html`<span class="note">Reference data comes from Shaffer MarketData. Until it is connected, instruments are registered by hand.</span>` : null}</div>
    ${res?.error ? html`<div style="margin-top:10px"><${ErrorNote} error=${res.error} /></div>` : null}
    ${res && !res.error ? html`<div class="cols-2" style="margin-top:10px">
      <div class="stack"><h4>From Shaffer MarketData</h4>
        ${ref.available ? (ref.items?.length ? html`<${Table} columns=${[
            { label: 'Result', render: (h) => html`<div class="sym">${hitName(h)}</div><div class="sub clip">${h.symbol && h.name ? h.name : ''}</div>` },
            { label: 'Shaffer MarketData ID', render: (h) => h.externalId || h.id || shafferMissing },
            { label: '', align: 'r', render: (h) => html`<${Button} small onClick=${() => onRegister({ name: h.name || '', symbol: h.symbol || '', externalIds: h.externalId || h.id ? { shaffer: String(h.externalId || h.id) } : {} })}>Register from this<//>` },
          ]} rows=${ref.items} />` : html`<p class="note">Shaffer MarketData has no match for "${q.trim()}".</p>`)
          : ref.reason === 'error' ? html`<${Notice} tone="err">${ref.message}<//>`
            : html`<${Awaiting} compact what=${ref.message && ref.message !== res.awaitingMessage ? ref.message : 'Reference-data search returns instruments here once Shaffer MarketData is connected. Nothing is looked up from any other source.'} />`}
      </div>
      <div class="stack"><h4>Already in the registry (${res.registry.length})</h4>
        ${res.registry.length ? html`<${Table} onRowClick=${(i) => openInstrument(i.id, { tab: 'overview' })} rowKey=${(i) => i.id} columns=${[
            { label: 'Instrument', render: (i) => html`<span class="sym">${i.symbol || i.name}</span> <span class="sub">${i.symbol ? i.name : ''}</span>` },
            { label: 'Product', render: (i) => short(i.support.productName) }, { label: 'Market view', render: (i) => VIEW_LABEL[i.marketView] }, { label: 'Terminal ID', render: (i) => i.id },
          ]} rows=${res.registry.slice(0, 8)} />${res.registry.length > 8 ? html`<p class="note">Showing 8 of ${res.registry.length}. Use the filter below to see them all.</p>` : null}`
          : html`<p class="note">Nothing registered matches "${q.trim()}". Register it by hand with New instrument.</p>`}
      </div></div>` : null}
  <//>`;
}

// ---- registry tab -----------------------------------------------------------------------------------------------
function RegistryTab({ book, status, create }) {
  const [view, setView] = useState('');
  const [family, setFamily] = useState('');
  const [q, setQ] = useState('');
  const [arr, setArr] = useState(false);
  const res = useLive(async () => {
    const list = await get('/api/instruments', { view, family, q: q.trim(), limit: 2000, bookId: book?.id, arrangements: arr ? '1' : undefined });
    // The server knows a price only for instruments it has been asked to quote, so the listed ones are asked for
    // (the first 300; past that, and if the request fails, the state the registry reports is shown).
    const ids = list.items.filter((i) => i.pricing?.state !== 'not-needed').slice(0, 300).map((i) => i.id);
    const quotes = {};
    const asks = [];
    for (let n = 0; n < ids.length; n += 100) asks.push(get('/api/quotes', { ids: ids.slice(n, n + 100).join(',') }).then((r) => Object.assign(quotes, r.quotes), () => {}));
    await Promise.all(asks);
    return { items: list.items, quotes };
  }, [view, family, q, arr, book?.id]);
  const items = res.data?.items || [];
  const quotes = res.data?.quotes || {};
  const rows = useMemo(() => {
    const out = [];
    let last = null;
    for (const i of items) {
      if (i.family !== last) { out.push({ _group: `${i.familyLabel} (${items.filter((x) => x.family === i.family).length})` }); last = i.family; }
      out.push(i);
    }
    return out;
  }, [items]);
  const filtered = Boolean(view || family || q.trim());
  const marketAwaiting = status.data.market.connection === 'awaiting';
  const edit = (i, e) => { e.stopPropagation(); openEditInstrument(i, { onDone: res.reload }); };
  const venue = (i) => {
    const cc = i.venueCountry ? ` (${i.venueCountry})` : '';
    const where = i.venue ? `${i.venue}${cc}${i.venueType === 'otc' ? ', OTC' : ''}` : i.venueType === 'otc' ? `OTC${cc}` : `exchange-listed${cc}, venue not recorded`;
    return [where, i.domicile ? `issuer ${i.domicile}` : ''].filter(Boolean).join(', ');
  };
  const calendar = (i) => {
    const c = i.calendar;
    if (!c) return null;
    const tip = [`Settlement calendar: ${c.label}`, c.basis === 'currency' && c.note && i.family !== 'fx' ? '' : calendarBasis(c, i), c.note, c.fallback ? 'Add local holidays under Settings, Market calendars.' : ''].filter(Boolean).join('\n');
    return html`<div class="sub" title=${tip}>${c.fallback ? html`<${Pill} tone="warn">weekends only<//>` : c.id}</div>`;
  };
  const columns = [
    { label: 'Instrument', title: 'Symbol and Terminal ID, then the name', render: (i) => (i.symbol
      ? html`<div><span class="sym">${i.symbol}</span> <span class="sub">${i.id}</span></div><div class="sub clip" style="max-width:175px" title=${i.name}>${i.name}</div>`
      : html`<div class="sym clip" style="max-width:175px" title=${i.name}>${i.name}</div><div class="sub">${i.id}</div>`) },
    { label: 'Product and venue', render: (i) => html`<div class="clip" style="max-width:150px" title=${i.support.productName}>${short(i.support.productName)}</div><div class="sub clip" style="max-width:150px" title=${venue(i)}>${venue(i)}</div>` },
    { label: 'Market view', title: 'The primary view, then any cross-market tags', render: (i) => html`<div>${VIEW_LABEL[i.marketView]}</div>${i.tags.length ? html`<div class="sub clip" style="max-width:150px" title=${`Cross-market tags: ${i.tags.map((t) => VIEW_LABEL[t] || t).join(', ')}`}>also ${i.tags.map((t) => VIEW_LABEL[t] || t).join(', ')}</div>` : null}` },
    { label: 'Ccy, calendar', title: 'Trading currency (and the settlement currency where it differs), then the settlement calendar. Hover the calendar for how it was chosen. "Weekends only" means no holiday calendar exists for the market.',
      render: (i) => html`<div>${i.tradingCcy}${i.settleCcy && i.settleCcy !== i.tradingCcy ? html` <span class="sub">settles ${i.settleCcy}</span>` : null}</div>${calendar(i)}` },
    // Key terms and the holding share one column, terms on the left and the holding on the right, so a gross
    // "Long | Short | Net" holding has room beside the (usually empty) terms of a security and wraps under longer terms.
    { label: html`<span style="display:flex;justify-content:space-between;gap:12px"><span>Key terms</span><span title="What this Book already holds, long and short shown gross. Hover a holding for the Accounts.">Held</span></span>`,
      render: (i) => html`<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:2px 12px"><div>${keyTerms(i)}</div><div style="margin-left:auto"><${Holdings} h=${i.holdings} /></div></div>` },
    { label: 'Lifecycle', title: 'Lifecycle support: what the paper engine simulates for this product once it is registered and priced. Hover the level for what is entered by hand. Separate from pricing.', render: (i) => html`<${Support} level=${i.support.level} note=${i.support.note || LEVELS.find((l) => l[0] === i.support.level)?.[2]} />` },
    { label: 'Pricing', title: 'Pricing coverage: whether a price is on hand now, with its status and source. Hover the state for where this product\'s price comes from. Separate from lifecycle support.', render: (i) => html`<${PricingNow} inst=${i} quote=${quotes[i.id]} />` },
    { label: 'Reference', title: 'Where the reference data came from, then the Shaffer MarketData ID if one is linked', render: (i) => html`<div class="clip" style="max-width:88px" title=${`Reference data: ${refSource(i.refSource)}`}>${refSource(i.refSource).replace('Entered by hand', 'By hand')}</div><div class="sub clip" style="max-width:88px" title=${i.externalIds?.shaffer ? `Shaffer MarketData ID ${i.externalIds.shaffer}` : ''}>Shaffer ID ${i.externalIds?.shaffer || shafferMissing}</div>` },
    { label: '', align: 'r', render: (i) => html`<${Button} small onClick=${(e) => edit(i, e)}>Edit<//>` },
  ];
  return html`<div class="stack">
    <${ReferenceSearch} onRegister=${(preset) => create({ preset })} />
    <div>
      <div class="toolbar">
        <div style="width:180px"><${Select} value=${view} onChange=${setView} placeholder="All market views" options=${Object.entries(VIEW_LABEL).map(([value, label]) => ({ value, label }))} /></div>
        <div style="width:210px"><${Select} value=${family} onChange=${setFamily} placeholder="All families" options=${Object.entries(status.families).filter(([id]) => id !== 'cash').map(([value, f]) => ({ value, label: f.label }))} /></div>
        <div style="width:280px"><${Text} type="search" value=${q} onInput=${setQ} placeholder="Filter by symbol, name, issuer or Terminal ID" /></div>
        <${Check} checked=${arr} onChange=${setArr}>Include loans, repos and securities loans<//>
        <span class="grow"></span><span class="note">${res.data ? `${items.length} instrument${items.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div class="panel"><div class="body flush">
        ${res.error && !res.data ? html`<div style="padding:12px"><${ErrorNote} error=${res.error} /></div>` : !res.data ? html`<${Empty}>Loading the registry…<//>` : html`<${Table} margin cls="tight" columns=${columns} rows=${rows} rowKey=${(i) => i.id} onRowClick=${(i) => openInstrument(i.id, { tab: 'overview' })}
          empty=${{ title: filtered ? 'Nothing matches these filters' : 'No instruments registered yet', children: filtered ? 'Clear a filter, or register the instrument with New instrument.' : marketAwaiting ? 'Reference data arrives with the Shaffer MarketData connection. Until then, register instruments by hand with New instrument.' : 'Register one with New instrument.' }} />`}
      </div></div>
      <p class="note" style="margin-top:8px">Lifecycle and Pricing are separate: Lifecycle is what the paper engine simulates for the product, Pricing is whether a price is on hand for the instrument now. Each is explained on the <a href="#/instruments/coverage">Coverage</a> tab. The calendar under the currency is the one settlement dates are worked out on; the built-in calendars are listed under <a href="#/settings">Settings</a>.</p>
      <p class="note" style="margin-top:4px">A row opens the instrument. Financing arrangements are left out unless included above or chosen as a family: each loan, repo or securities loan registers itself when its ticket is confirmed in Treasury or on the Account.</p>
    </div>
  </div>`;
}

// ---- coverage tab -----------------------------------------------------------------------------------------------
// Two independent dimensions per product: lifecycle support and pricing coverage.
function CoverageTab({ create }) {
  const cat = useLive(loadCatalog, [], { interval: false });
  const [level, setLevel] = useState('');
  const [basis, setBasis] = useState('');
  const [cls, setCls] = useState('');
  const [q, setQ] = useState('');
  const c = cat.data;
  const rows = useMemo(() => {
    if (!c) return [];
    const needle = q.trim().toLowerCase();
    const hit = c.products.filter((p) => (!level || p.support === level) && (!basis || p.pricing === basis) && (!cls || p.cls === cls)
      && (!needle || `${p.name} ${p.group} ${c.families[p.family]?.label || ''} ${p.note} ${basisOf(p.pricing)[1]} ${c.pricingLabels?.[p.pricing] || ''}`.toLowerCase().includes(needle)));
    const out = [];
    for (const g of [...new Set(hit.map((p) => p.group))]) {
      const list = hit.filter((p) => p.group === g);
      out.push({ _group: `${g} (${list.length})` }, ...list);
    }
    return out;
  }, [c, level, basis, cls, q]);
  if (!c) return cat.error ? html`<${ErrorNote} error=${cat.error} />` : html`<${Empty}>Loading the catalog…<//>`;
  const shown = rows.filter((r) => r._group === undefined).length;
  const count = (n) => html`<td class="r nowrap"><b>${n}</b> <span class="muted small">${fmtNum((n / c.total) * 100, 0)}%</span></td>`;
  const priced = c.pricing || {};
  const bases = BASES.filter(([id]) => priced[id] !== undefined);
  const columns = [
    { label: 'Product', render: (p) => html`<div class="strong" style="min-width:215px">${p.name}</div><div class="sub">${c.families[p.family]?.label || p.family}, ${p.cls === 'deriv' ? 'derivative' : 'cash market'}</div>` },
    { label: 'Lifecycle support', cls: 'nowrap', title: 'What the paper engine simulates once an instrument of this product is registered and priced', render: (p) => html`<${Support} level=${p.support} />` },
    { label: 'Lifecycle: what is simulated, and what is entered by hand', render: (p) => p.note || html`<span class="muted">${p.support === 'full' ? 'No manual steps are noted for this product.' : 'No note recorded.'}</span>` },
    { label: 'Pricing coverage', title: 'Where the price of this product comes from. Separate from lifecycle support.', render: (p) => html`<div style="min-width:255px"><${Basis} id=${p.pricing} /> <span class="sub">${c.pricingLabels?.[p.pricing] || ''}</span></div>` },
    { label: '', align: 'r', cls: 'nowrap', render: (p) => { const why = notRegistered(p); return why ? html`<span class="missing" title=${why}>${p.family === 'cash' ? 'ledger cash' : p.id === 'short_sale' ? 'from the trade ticket' : p.support === 'planned' ? 'not yet' : 'opened in Treasury'}</span>` : html`<${Button} small onClick=${() => create({ preset: { productId: p.id } })}>Register<//>`; } },
  ];
  return html`<div class="stack">
    <${Notice}><b>Two separate questions are answered for each of the ${c.total} products.</b> Lifecycle support is what the paper engine simulates once an instrument is registered and priced. Pricing coverage is where its price comes from. Neither implies the other: a product can have a fully simulated lifecycle and no price source yet, or a price source and a lifecycle that is partly recorded by hand. Whether prices are flowing now is shown dataset by dataset on the <a href="#/data">Data connection</a> page, and instrument by instrument in the Pricing column of the <a href="#/instruments">Registry</a> tab.<//>
    <div class="cols-2" style="align-items:start">
      <${Panel} title="Lifecycle support" note="What the paper engine simulates" flush>
        <table class="ledger fit"><thead><tr><th>Level</th><th class="r">Products</th><th>What it means</th></tr></thead><tbody>
          ${LEVELS.map(([id, , text]) => html`<tr><td class="nowrap"><${Support} level=${id} /></td>${count(c.counts[id])}<td>${text}</td></tr>`)}
          ${c.counts.planned ? html`<tr><td class="nowrap"><${Support} level="planned" /></td>${count(c.counts.planned)}<td>Listed for completeness. Cannot be registered or traded.</td></tr>` : null}
        </tbody></table>
        <p class="note" style="margin:0;padding:8px 12px">A product being listed is not a claim of support: its level and note say what the Terminal does.</p>
      <//>
      <${Panel} title="Pricing coverage" note="Where the price comes from" flush>
        <table class="ledger fit"><thead><tr><th>Price source</th><th class="r">Products</th><th>What it means</th></tr></thead><tbody>
          ${bases.map(([id]) => html`<tr><td class="nowrap"><${Basis} id=${id} /></td>${count(priced[id])}<td>${c.pricingLabels?.[id] || ''}.</td></tr>`)}
        </tbody></table>
        <p class="note" style="margin:0;padding:8px 12px">This is the source a product's price is expected from, not a statement that prices are arriving. Until the Shaffer services are connected, prices and marks are entered by hand and labelled manual.</p>
      <//>
    </div>
    <div>
      <div class="toolbar">
        <span class="small strong" style="width:60px">Lifecycle</span>
        <${Seg} value=${level} onChange=${setLevel} options=${[{ value: '', label: 'All' }, ...LEVELS.map(([id, label]) => ({ value: id, label: `${label} (${c.counts[id]})` }))]} />
        <span class="grow"></span>
        <div style="width:150px"><${Select} value=${cls} onChange=${setCls} placeholder="All classes" options=${[{ value: 'cash', label: 'Cash market' }, { value: 'deriv', label: 'Derivatives' }]} /></div>
        <div style="width:250px"><${Text} type="search" value=${q} onInput=${setQ} placeholder="Filter by product, family or note" /></div>
      </div>
      <div class="toolbar">
        <span class="small strong" style="width:60px">Pricing</span>
        <${Seg} value=${basis} onChange=${setBasis} options=${[{ value: '', label: 'All' }, ...bases.map(([id, label]) => ({ value: id, label: `${titleCase(label)} (${priced[id]})` }))]} />
        <span class="grow"></span><span class="note">${shown} of ${c.total} products</span>
      </div>
      <div class="panel"><div class="body flush">
        <${Table} margin cls="fit" columns=${columns} rows=${rows} empty=${{ title: 'No product matches these filters', children: 'The lifecycle and pricing filters apply together. Set one of them back to All, or clear the text filter.' }} />
      </div></div>
    </div>
  </div>`;
}

export default function Registry({ args, book, status }) {
  const tab = args[0] === 'coverage' ? 'coverage' : 'registry';
  const create = (opts = {}) => openCreateInstrument({ ...opts, onDone: () => bump() });
  return html`<div>
    <div class="page-head"><div><h1>Instruments</h1><div class="sub">Everything the Terminal can hold or trade is registered here under its own Terminal ID; a ticker is optional. Reference data will come from Shaffer MarketData. Until then instruments are registered by hand.</div></div>
      <div class="actions"><${Button} kind="primary" onClick=${() => create()}>New instrument<//></div></div>
    <${Tabs} value=${tab} onChange=${(t) => { location.hash = t === 'coverage' ? '#/instruments/coverage' : '#/instruments'; }} tabs=${[{ id: 'registry', label: 'Registry' }, { id: 'coverage', label: 'Coverage' }]} />
    ${tab === 'registry' ? html`<${RegistryTab} book=${book} status=${status} create=${create} />` : html`<${CoverageTab} create=${create} />`}
  </div>`;
}

// ---- register / edit form -----------------------------------------------------------------------------------------
const GRID = 'grid-template-columns:repeat(auto-fill,minmax(200px,1fr))';
const pairOf = (cls) => (cls === 'deriv' ? ['US_DERIV', 'FOREIGN_DERIV'] : ['US_CASH', 'FOREIGN_CASH']);
/** The view a listing venue decides, or null when nothing decides it (OTC, or no venue country yet). */
function viewByVenue(d, cls) {
  const country = String(d.venueCountry || '').trim().toUpperCase();
  if (d.venueType !== 'exchange' || !country) return null;
  return pairOf(cls)[country === 'US' ? 0 : 1];
}
const fromInst = (i) => ({
  productId: i.productId, family: i.family, name: i.name, symbol: i.symbol || '', marketView: i.marketView, tags: [...(i.tags || [])], issuer: i.issuer || '', domicile: i.domicile || '',
  underlyingGeo: i.underlyingGeo || '', venue: i.venue || '', venueType: i.venueType, venueCountry: i.venueCountry || '', tradingCcy: i.tradingCcy, settleCcy: i.settleCcy && i.settleCcy !== i.tradingCcy ? i.settleCcy : '',
  underlyingId: i.underlyingId || '', multiplier: i.multiplier, terms: JSON.parse(JSON.stringify(i.terms || {})),
});
const otherIds = (i) => Object.entries(i?.externalIds || {}).filter(([k, v]) => k !== 'shaffer' && v).map(([k, v]) => ({ k, v: String(v) }));

/**
 * Which settlement calendar the venue and currency fields select, shown under them. For a saved
 * instrument whose fields are unchanged this is the calendar the server reports; otherwise it is
 * worked out here the way the server will on saving.
 */
function CalendarHint({ draft, saved, cals, countryOk }) {
  const same = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
  const unchanged = saved?.calendar && same(draft.venueCountry, saved.venueCountry) && draft.venueType === saved.venueType && draft.marketView === saved.marketView
    && same(draft.tradingCcy, saved.tradingCcy) && same(draft.settleCcy || draft.tradingCcy, saved.settleCcy || saved.tradingCcy) && (draft.family !== 'fx' || (same(draft.terms?.base, saved.terms?.base) && same(draft.terms?.quote, saved.terms?.quote)));
  const cal = unchanged ? saved.calendar : cals && countryOk ? expectedCalendar(draft, cals) : null;
  const row = (body) => html`<div class="field" style="grid-column:1 / -1"><span class="lbl">Settlement calendar${saved && !unchanged && cal ? ' after saving' : ''}</span>${body}</div>`;
  if (!cal) return row(html`<div class="small muted">${cals === false && !unchanged ? 'The calendar list could not be loaded, so the calendar these fields select cannot be shown here. It is stated on the instrument once saved.' : !countryOk ? 'Enter a two-letter venue country to see the calendar it selects.' : draft.family === 'fx' ? 'Enter both currencies of the pair to see the calendars its value dates use.' : 'Loading the calendars…'}</div>`);
  // The note of a calendar inferred from the currency already says how it was chosen.
  const how = cal.basis === 'currency' && cal.note && draft.family !== 'fx' ? '' : calendarBasis(cal, draft);
  // The server's note ends by pointing at Settings; the exact place is named here instead.
  if (cal.fallback) return row(html`<${Notice} tone="warn"><b>${draft.family === 'fx' ? 'Weekends only for part of this pair.' : 'Weekends only: local holidays are not recognised.'}</b> ${String(cal.note || '').replace(/; local holidays can be added by hand in Settings\.$/, '.')} Add local holidays under Settings, Market calendars. Every date worked out this way is flagged in the trade preview.<//>`);
  return row(html`<div class="small"><b>${cal.label}</b> <span class="muted">(${cal.id})</span>. ${how}${cal.note ? html` <span class="muted">${cal.note}</span>` : null}${saved?.locked && !unchanged ? ' It is used for dates worked out from then on.' : ''}</div>`);
}

function InstrumentForm({ inst: given, view, preset, onDone, onClose }) {
  const editing = Boolean(given);
  const [inst, setInst] = useState(given || null);
  const [catalog, setCatalog] = useState(null);
  const [cals, setCals] = useState(null); // the /api/calendars payload, or false when it could not be loaded
  const [draft, setDraft] = useState(given ? fromInst(given) : null);
  const [shafferId, setShafferId] = useState(given?.externalIds?.shaffer || preset?.externalIds?.shaffer || '');
  const [ids, setIds] = useState(otherIds(given));
  const [error, setError] = useState(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const top = useRef(null);
  const locked = Boolean(inst?.locked);
  const product = catalog?.products.find((p) => p.id === draft?.productId) || null;
  const blocked = product && !editing ? notRegistered(product) : null;

  const pick = (id, cat = catalog) => {
    const p = cat?.products.find((x) => x.id === id);
    if (!p) { setDraft(null); return; }
    setDraft((d) => {
      const wanted = d?.marketView || view || '';
      const base = newDraft(p, { ...(preset || {}), productId: p.id, tradingCcy: d?.tradingCcy || preset?.tradingCcy || 'USD' });
      // Keep what has been typed; the view keeps its geography and takes the product's class.
      const next = { ...base, tags: [], issuer: '', domicile: '', underlyingGeo: '', venue: '', venueCountry: '', settleCcy: '', ...(d ? { name: d.name, symbol: d.symbol, issuer: d.issuer, domicile: d.domicile, underlyingGeo: d.underlyingGeo, venue: d.venue, venueCountry: d.venueCountry, tags: d.tags } : {}) };
      next.name = next.name || '';
      next.symbol = next.symbol || '';
      next.marketView = viewByVenue(next, p.cls) || (wanted ? wanted.replace(/CASH|DERIV/, p.cls === 'deriv' ? 'DERIV' : 'CASH') : '');
      next.tags = next.tags.filter((t) => t !== next.marketView);
      return next;
    });
    setError(null);
  };
  useEffect(() => {
    loadCatalog().then((c) => { setCatalog(c); if (!editing && preset?.productId) pick(preset.productId, c); }, setError);
    loadCalendars().then(setCals, () => setCals(false));
    if (given) get(`/api/instruments/${given.id}`).then(setInst, () => {});
  }, []);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  /** Venue edits re-place a listed product by its listing venue. */
  const setVenue = (patch) => setDraft((d) => {
    const next = { ...d, ...patch };
    const v = product ? viewByVenue(next, product.cls) : null;
    if (v) { next.marketView = v; next.tags = next.tags.filter((t) => t !== v); }
    return next;
  });
  const reloadTerms = async () => { const fresh = await get(`/api/instruments/${inst.id}`); setInst(fresh); set({ terms: JSON.parse(JSON.stringify(fresh.terms || {})), multiplier: fresh.multiplier }); onDone?.(fresh); };

  const externalIds = () => {
    const out = {};
    // The server merges external IDs, so one removed while editing is blanked rather than dropped.
    if (editing) for (const k of Object.keys(inst.externalIds || {})) out[k] = '';
    if (shafferId.trim() || editing) out.shaffer = shafferId.trim();
    for (const { k, v } of ids) if (k.trim() && k.trim() !== 'shaffer' && (v.trim() || editing)) out[k.trim()] = v.trim();
    return out;
  };
  const pairCcy = draft && (draft.family === 'fx' || (draft.family === 'forward' && ['fx', 'ndf'].includes(draft.terms.forwardType)));
  const nameError = tried && draft && !draft.name.trim() ? 'Give the instrument a name.' : null;
  const viewError = tried && draft && !draft.marketView ? 'Choose the primary market view.' : null;
  const country = draft?.family === 'fx' ? '' : String(draft?.venueCountry || '').trim().toUpperCase();
  const countryError = country && !/^[A-Z]{2}$/.test(country) && (tried || country.length > 2) ? 'Enter a two-letter country code, such as US, GB or JP.' : null;
  const save = async () => {
    setTried(true); setError(null);
    if (!draft || !draft.name.trim() || !draft.marketView || (country && !/^[A-Z]{2}$/.test(country))) { top.current?.scrollIntoView({ block: 'start' }); return; }
    setBusy(true);
    const d = { ...draft, name: draft.name.trim(), symbol: draft.symbol.trim(), venueCountry: country, tradingCcy: pairCcy ? draft.terms.quote || draft.tradingCcy : draft.tradingCcy, externalIds: externalIds() };
    try {
      let out;
      if (editing) {
        // The venue country is a descriptive field: it stays editable after trading, and an empty value clears it.
        const patch = { name: d.name, symbol: d.symbol, marketView: d.marketView, tags: d.tags, issuer: d.issuer.trim(), domicile: d.domicile.trim(), venue: d.venue.trim(), venueCountry: d.venueCountry, underlyingGeo: d.underlyingGeo.trim(), externalIds: d.externalIds };
        // Once traded, the server accepts descriptive fields only.
        if (!locked) Object.assign(patch, { venueType: d.venueType, underlyingId: d.underlyingId || '', tradingCcy: d.tradingCcy, settleCcy: pairCcy ? undefined : d.settleCcy.trim().toUpperCase(), multiplier: d.multiplier ?? undefined, terms: d.terms });
        out = await put(`/api/instruments/${inst.id}`, patch);
      } else out = await post('/api/instruments', draftToContract({ ...d, settleCcy: pairCcy ? '' : d.settleCcy }));
      toast(editing ? 'Changes saved.' : `Instrument registered: ${out.symbol || out.name}.`);
      bump(); onDone?.(out); onClose();
    } catch (err) { setError(err); setBusy(false); requestAnimationFrame(() => top.current?.scrollIntoView({ block: 'start' })); }
  };

  const problems = error?.details?.errors?.length ? error.details.errors : error ? [error.message] : [];
  const options = (catalog?.products || []).map((p) => ({ value: p.id, label: p.name, group: p.group }));
  const pair = product ? pairOf(product.cls) : [];
  const decided = product && draft ? viewByVenue(draft, product.cls) : null;
  // A currency pair has no venue country: its value dates use the payment calendars of its two currencies.
  const noCountry = draft?.family === 'fx';
  const countryHint = noCountry ? 'Not used for a currency pair.'
    : draft?.family === 'crypto' ? (draft.venueType === 'exchange' ? 'Two-letter code. Sets the market view.' : 'Optional for OTC. Two-letter code.')
      : draft?.venueType === 'exchange' ? 'Two-letter code. Sets the market view and selects the settlement calendar.' : 'Optional for OTC. Two-letter code; selects the settlement calendar only.';
  const lockHint = locked ? 'Locked: this instrument has been traded' : undefined;
  const title = editing ? `Edit ${given.symbol || given.name}` : 'New instrument';
  const sub = editing ? `Terminal ID ${given.id}. ${given.support.productName}.` : 'Registers an instrument under a new Terminal ID. Nothing is traded.';
  const footer = html`${problems.length || nameError || viewError || (tried && countryError) ? html`<span class="loss small">Not saved. ${problems.length > 1 ? `${problems.length} problems are listed at the top of the form.` : 'See the message in the form.'}</span>` : null}<span class="grow"></span>
    <${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!draft || Boolean(blocked)} onClick=${save}>${editing ? 'Save changes' : 'Register instrument'}<//>`;

  return html`<${Modal} size="wide" title=${title} sub=${sub} onClose=${onClose} footer=${footer}>
    <div class="stack">
      <div ref=${top} style="margin-bottom:-12px"></div>
      ${problems.length ? html`<${Notice} tone="err"><b>The instrument was not saved.</b> ${problems.length === 1 ? problems[0] : html`Correct these and save again:<ul style="margin:4px 0 0;padding-left:18px">${problems.map((p) => html`<li>${p}</li>`)}</ul>`}<//>` : null}
      ${locked ? html`<${Notice} tone="warn"><b>Contract terms are locked.</b> This instrument has been traded, so its venue type, currencies, underlying, multiplier and contract terms can no longer change: positions and past cash flows were booked on them. Name, symbol, issuer, issuer domicile, underlying geography, venue name, venue country (which selects the settlement calendar), market view, cross-market tags and external IDs can still be edited. For different terms, register a new instrument.<//>` : null}

      <div><h4 style="margin-bottom:6px">Product</h4>
        <div class="grid-form" style=${GRID}>
          <${Field} label="Product type" span=${2} hint=${editing ? 'The product of a registered instrument cannot be changed.' : undefined}>${catalog ? html`<${Select} value=${draft?.productId || ''} onChange=${(v) => pick(v)} disabled=${editing} placeholder="Choose the product…" options=${options} />` : html`<${Select} value="" onChange=${() => {}} disabled placeholder="Loading the catalog…" options=${[]} />`}<//>
          ${product ? html`<div class="field" style="grid-column:3 / -1"><span class="lbl">Lifecycle support for ${short(product.name)}</span>
            <div><${Support} level=${product.support} /> <span class="small">${LEVELS.find((l) => l[0] === product.support)?.[2] || ''}${product.note ? html` <b>${product.note}</b>` : ''}</span></div>
            <span class="lbl" style="margin-top:4px">Pricing coverage (separate from lifecycle support)</span>
            <div><${Basis} id=${product.pricing} /> <span class="small">${catalog.pricingLabels?.[product.pricing] || ''}.${editing && inst?.pricing ? (inst.pricing.state === 'priced' ? ' A price is on hand for this instrument now.' : inst.pricing.state === 'unpriced' ? ' No price is on hand for this instrument yet.' : '') : ''}</span></div></div>` : null}
        </div>
        ${blocked ? html`<div style="margin-top:10px"><${Notice}>${blocked}<//></div>` : null}
        ${!draft && !editing ? html`<p class="note" style="margin-top:8px">The product decides the contract fields below and which pair of market views the instrument can sit in. Each product states how much of its paper lifecycle is simulated and, separately, where its price comes from.</p>` : null}
      </div>

      ${draft && product && !blocked ? html`
      <div><h4 style="margin-bottom:6px">Identity</h4>
        <div class="grid-form" style=${GRID}>
          <${Field} label=${html`Name <span class="muted">(required)</span>`} span=${2} error=${nameError}><${Text} value=${draft.name} onInput=${(v) => set({ name: v })} autofocus=${!editing} /><//>
          <${Field} label="Symbol" hint="Optional. The Terminal ID identifies the instrument."><${Text} value=${draft.symbol} onInput=${(v) => set({ symbol: v })} /><//>
          <${Field} label="Issuer" span=${2}><${Text} value=${draft.issuer} onInput=${(v) => set({ issuer: v })} /><//>
        </div>
      </div>
      <div><h4 style="margin-bottom:6px">Venue and currency</h4>
        <div class="grid-form" style=${GRID}>
          <${Field} label="Traded on" hint=${lockHint}><div><${Seg} value=${draft.venueType} onChange=${(v) => setVenue({ venueType: v })} options=${[{ value: 'exchange', label: 'Exchange', disabled: locked }, { value: 'otc', label: 'OTC', disabled: locked }]} /></div><//>
          <${Field} label=${draft.venueType === 'exchange' ? 'Listing venue' : 'Venue or platform'} hint="Optional"><${Text} value=${draft.venue} onInput=${(v) => set({ venue: v })} /><//>
          <${Field} label="Venue country" error=${countryError} hint=${countryHint}><${Text} value=${noCountry ? '' : draft.venueCountry} disabled=${noCountry} onInput=${(v) => setVenue({ venueCountry: v.toUpperCase().trim() })} placeholder=${noCountry ? '' : 'US, JP, GB…'} /><//>
          <${Field} label="Trading currency" hint=${locked ? lockHint : pairCcy ? 'The quote currency of the pair' : 'Three-letter code'}><${Text} value=${pairCcy ? draft.terms.quote || '' : draft.tradingCcy} disabled=${locked || pairCcy} onInput=${(v) => set({ tradingCcy: v.toUpperCase() })} /><//>
          ${pairCcy ? null : html`<${Field} label="Settlement currency" hint=${locked ? lockHint : 'Only if it differs'}><${Text} value=${draft.settleCcy} disabled=${locked} onInput=${(v) => set({ settleCcy: v.toUpperCase() })} placeholder=${draft.tradingCcy ? `Same (${draft.tradingCcy})` : 'Same as trading'} /><//>`}
          <${CalendarHint} draft=${{ ...draft, venueCountry: country, tradingCcy: pairCcy ? draft.terms.quote || '' : draft.tradingCcy }} saved=${editing ? inst : null} cals=${cals} countryOk=${!country || /^[A-Z]{2}$/.test(country)} />
        </div>
      </div>
      <div><h4 style="margin-bottom:6px">Market view</h4>
        <div class="grid-form" style=${GRID}>
          <${Field} label=${html`Primary view <span class="muted">(required)</span>`} span=${2} error=${viewError}><div><${Seg} value=${draft.marketView} onChange=${(v) => set({ marketView: v, tags: draft.tags.filter((t) => t !== v) })} options=${pair.map((v) => ({ value: v, label: VIEW_LABEL[v], disabled: Boolean(decided && decided !== v), title: decided && decided !== v ? 'The listing venue decides the view' : undefined }))} /></div><//>
          <div class="field" style="grid-column:span 3"><span class="lbl">Cross-market tags</span>
            <div class="row" style="min-height:30px;gap:16px">${Object.keys(VIEW_LABEL).filter((v) => v !== draft.marketView).map((v) => html`<${Check} checked=${draft.tags.includes(v)} onChange=${(on) => set({ tags: on ? [...draft.tags, v] : draft.tags.filter((t) => t !== v) })}>${VIEW_LABEL[v]}<//>`)}</div>
            <div class="hint">Optional. The instrument also appears in these views; its primary view does not change.</div></div>
          <${Field} label="Issuer domicile" hint="Country code, such as US or JP. Stored for reference."><${Text} value=${draft.domicile} onInput=${(v) => set({ domicile: v.toUpperCase() })} /><//>
          <${Field} label="Underlying geography" hint="Where the exposure is. Stored for reference."><${Text} value=${draft.underlyingGeo} onInput=${(v) => set({ underlyingGeo: v })} /><//>
        </div>
        <div style="margin-top:8px"><${Notice}>
          ${decided ? html`<b>Placed by its listing venue.</b> Listed on a ${country === 'US' ? 'US' : `non-US (${country})`} venue, so it belongs in ${VIEW_LABEL[decided]}.${draft.domicile && draft.domicile !== country ? ` The issuer's domicile (${draft.domicile}) is stored separately and does not move it.` : ''}`
            : draft.venueType === 'exchange' ? html`<b>A listed product is placed by its listing venue.</b> Enter the venue country and the view is set from it. An ADR listed in the US is US Based even though its issuer is foreign.`
              : html`<b>Assign the primary view yourself.</b> An OTC, FX or global product has no listing venue to decide it. Choose the view that holds its main market exposure and add cross-market tags for any other view it belongs in.`}
          ${' '}Issuer domicile and underlying geography are stored separately and never decide the view. Neither does the currency. ${short(product.name)} is a ${product.cls === 'deriv' ? 'derivative' : 'cash-market'} product, so it sits in ${VIEW_LABEL[pair[0]]} or ${VIEW_LABEL[pair[1]]}.
        <//></div>
      </div>
      <div><h4 style="margin-bottom:6px">Contract terms${locked ? ' (locked)' : ''}</h4>
        <fieldset disabled=${locked} style="border:0;padding:0;margin:0;min-width:0"><div class="grid-form" style=${GRID}><${ContractFields} draft=${draft} onChange=${setDraft} /></div></fieldset>
        <p class="note" style="margin:8px 0 0">Rates, prices and multipliers are never assumed. Quantity is in ${(catalog.families[product.family]?.qty || 'units').toLowerCase()}${catalog.families[product.family]?.price ? `, price is ${catalog.families[product.family].price}` : ''}.</p>
      </div>
      <div><h4 style="margin-bottom:6px">External IDs</h4>
        <div class="grid-form" style=${GRID}>
          <${Field} label="Shaffer MarketData ID" span=${2} hint="Links this instrument to Shaffer reference data and prices once the service is connected. Leave empty until known."><${Text} value=${shafferId} onInput=${setShafferId} /><//>
          ${ids.map((row, n) => html`<${Field} label=${n === 0 ? 'Other identifier' : `Other identifier ${n + 1}`} span=${2}><div class="row" style="flex-wrap:nowrap">
            <div style="width:110px;flex:none"><${Text} value=${row.k} list="sdt-id-schemes" placeholder="Scheme" onInput=${(v) => setIds(ids.map((r, k) => (k === n ? { ...r, k: v } : r)))} /></div>
            <${Text} value=${row.v} placeholder="Value" onInput=${(v) => setIds(ids.map((r, k) => (k === n ? { ...r, v } : r)))} />
            <${Button} small onClick=${() => setIds(ids.filter((_, k) => k !== n))}>Remove<//></div><//>`)}
          <div class="field" style="justify-content:flex-start;padding-top:19px"><div><${Button} onClick=${() => setIds([...ids, { k: '', v: '' }])}>Add another identifier<//></div></div>
          <datalist id="sdt-id-schemes">${['isin', 'cusip', 'sedol', 'figi', 'ric', 'exchange-code'].map((s) => html`<option value=${s}></option>`)}</datalist>
        </div>
      </div>
      ${editing && inst && ['bond', 'cds', 'loan', 'repo'].includes(inst.family) ? html`<${LifecycleAdmin} inst=${inst} onChanged=${reloadTerms} />` : null}` : null}
    </div>
  <//>`;
}

// ---- lifecycle events recorded by hand on the instrument itself -----------------------------------------------------
function LifecycleAdmin({ inst, onChanged }) {
  const t = inst.terms || {};
  const name = inst.symbol || inst.name;
  const [v, setV] = useState({ recovery: null, weight: 1, newFactor: null, rate: null });
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const factor = isNum(t.factor) ? t.factor : 1;
  const indexFactor = isNum(t.indexFactor) ? t.indexFactor : 1;
  const review = (s) => { setError(null); if (s.invalid) { setStep(null); setError(new Error(s.invalid)); } else setStep(s); };
  const run = async () => {
    setBusy(true); setError(null);
    try {
      await post(`/api/instruments/${inst.id}/lifecycle`, { action: step.action, ...step.body });
      toast(step.done); setStep(null); setV({ recovery: null, weight: 1, newFactor: null, rate: null });
      bump(); await onChanged();
    } catch (err) { setError(err); }
    setBusy(false);
  };
  const button = (label, make) => html`<div class="field" style="justify-content:flex-start;padding-top:19px"><div><${Button} disabled=${busy} onClick=${() => review(make())}>${label}<//></div></div>`;
  const creditEvent = () => {
    const R = v.recovery, w = v.weight ?? 1;
    if (!isNum(R) || R < 0 || R > 1) return { invalid: 'Enter the recovery rate as a decimal between 0 and 1 (0.4 = 40%).' };
    if (!(w > 0 && w <= 1)) return { invalid: 'The weight must be above 0 and at most 1.' };
    const whole = w >= 1;
    return { action: 'credit_event', body: { recovery: R, weight: w }, confirm: 'Record credit event', done: 'Credit event recorded.',
      text: whole ? `Every holder of ${name}, in every Book, settles now. Protection buyers receive ${pct(1 - R, 1)} of their notional${indexFactor !== 1 ? ` (at index factor ${indexFactor})` : ''}, less the premium accrued to today; protection sellers pay the same amount. The contract is then terminated for every holder and its remaining premium payments are cancelled.`
        : `Every holder of ${name}, in every Book, settles protection on ${pct(w, 2)} of their notional: buyers receive ${pct(1 - R, 1)} of that part, less the premium accrued on it; sellers pay the same amount. The index factor then falls from ${indexFactor} to ${fmtNum(indexFactor * (1 - w), 6)} and the contract continues on the reduced notional.` };
  };
  const paydown = () => {
    const nf = v.newFactor;
    if (!(nf > 0 && nf < factor)) return { invalid: `The new factor must be above 0 and below the current factor ${factor}.` };
    return { action: 'paydown', body: { newFactor: nf }, confirm: 'Record paydown', done: 'Paydown recorded.',
      text: `The pool factor of ${name} falls from ${factor} to ${nf}. Every holder, in every Book, is paid down: a long holder receives ${Number((factor - nf).toFixed(8))} of its face amount at the redemption price (${t.redemption ?? 100}% of par) in cash, and a short holder pays it. Each position's cost falls in proportion and the difference is booked as realized profit or loss. Later coupons follow the reduced face.` };
  };
  const suspend = (on) => ({ action: 'suspend_coupon', body: { suspended: on }, confirm: on ? 'Suspend coupons' : 'Resume coupons', done: on ? 'Coupons suspended.' : 'Coupons resumed.',
    text: on ? `No coupon accrues or is paid on ${name} for any holder, in any Book, until coupons are resumed. Coupon dates that pass while suspended are skipped and are not paid later. Interest already accrued stays on the books.`
      : `Coupon accrual and payment restart on ${name} for every holder, in every Book. Coupon dates that passed while suspended are not paid afterwards; record any catch-up payment by hand.` });
  const setRate = () => {
    const r = v.rate;
    if (!isNum(r) || Math.abs(r) > 1) return { invalid: 'Enter the new rate as a decimal a year (0.045 = 4.5%).' };
    const cur = t.rateType === 'floating' ? `${t.referenceRate}${t.spread ? ` + ${pct(t.spread, 3)}` : ''}, floating` : isNum(t.rate) ? `${pct(t.rate, 3)} fixed` : 'not set';
    return { action: 'set_rate', body: { rate: r }, confirm: 'Reset rate', done: 'Rate reset.',
      text: `For every holder of ${inst.name}, in every Book, interest is accrued to today at the current rate (${cur}), a rate reset is recorded in the history, and the arrangement accrues at ${pct(r, 3)} fixed from today.${t.rateType === 'floating' ? ' Its floating rate is replaced by this fixed rate.' : ''}` };
  };
  return html`<div><h4 style="margin-bottom:6px">Lifecycle events recorded by hand</h4>
    <p class="note" style="margin-bottom:8px">These act at once on every holder of the instrument, in every Book. They are separate from Save changes and each one asks for confirmation first.${inst.locked ? '' : ' This instrument has not been traded, so there is no holder to affect yet; an event only changes its terms.'}</p>
    ${inst.family === 'cds' ? html`<div class="grid-form" style=${GRID}>
      <${Field} label="Recovery rate (decimal)" hint="0.4 = 40%. From the settlement, not assumed."><${Num} value=${v.recovery} onInput=${(x) => { setV({ ...v, recovery: x }); setStep(null); }} /><//>
      <${Field} label="Share of notional affected" hint="1 for a single name. For an index, the weight of the defaulted name."><${Num} value=${v.weight} onInput=${(x) => { setV({ ...v, weight: x }); setStep(null); }} /><//>
      ${button('Review credit event', creditEvent)}</div>` : null}
    ${inst.family === 'bond' ? html`<div class="grid-form" style=${GRID}>
      <${Field} label="New pool factor" hint=${`Current factor ${factor}`}><${Num} value=${v.newFactor} onInput=${(x) => { setV({ ...v, newFactor: x }); setStep(null); }} /><//>
      ${button('Review paydown', paydown)}
      <${Field} label="Coupons" span=${2}><div class="row" style="min-height:30px"><${Pill} tone=${t.couponSuspended ? 'warn' : 'ok'}>${t.couponSuspended ? 'suspended' : 'paying'}<//>
        <${Button} disabled=${busy} onClick=${() => review(suspend(!t.couponSuspended))}>${t.couponSuspended ? 'Review resuming coupons' : 'Review coupon suspension'}<//></div><//>
    </div>` : null}
    ${['loan', 'repo'].includes(inst.family) ? html`<div class="grid-form" style=${GRID}>
      <${Field} label="New rate (decimal a year)" hint="0.045 = 4.5%. Not assumed."><${Num} value=${v.rate} onInput=${(x) => { setV({ ...v, rate: x }); setStep(null); }} /><//>
      ${button('Review rate reset', setRate)}</div>` : null}
    ${error ? html`<div style="margin-top:8px"><${ErrorNote} error=${error} /></div>` : null}
    ${step ? html`<div style="margin-top:8px"><${Notice} tone="warn"><b>Confirm before this is recorded.</b> ${step.text}
      <div class="row" style="margin-top:8px"><${Button} kind="primary" busy=${busy} onClick=${run}>${step.confirm}<//><${Button} disabled=${busy} onClick=${() => setStep(null)}>Cancel<//></div><//></div>` : null}
  </div>`;
}

/** Register a new instrument. `view` is the default market view; `preset` may carry productId, underlyingId, tradingCcy. */
export function openCreateInstrument({ view, preset, onDone } = {}) {
  openOverlay((close) => html`<${InstrumentForm} view=${view} preset=${preset} onDone=${onDone} onClose=${close} />`);
}
/** Edit a registered instrument (an API view object). Economic terms are locked once it has been traded. */
export function openEditInstrument(inst, { onDone } = {}) {
  openOverlay((close) => html`<${InstrumentForm} inst=${inst} onDone=${onDone} onClose=${close} />`);
}
