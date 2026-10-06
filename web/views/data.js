// Data connection: where the Terminal's market facts and analytics come from, and how ready each
// source is. The Terminal reads only from two Shaffer services through one data adapter with two
// ports (MarketData and Analytics Lab); it never connects to an outside data vendor. Until the
// real service contracts are supplied every dataset is awaiting, and prices, FX and rates can be
// entered by hand. Credentials stay on the server and are never shown here.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.js';
import { bump, fmtNum, fmtTime, get, isNum, post, put, refreshStatus, toast, toastError, useLive } from '../lib/core.js';
import { Button, Check, Empty, ErrorNote, Field, KV, Missing, Notice, Num, Panel, Pill, Price, Prov, Seg, Table, Tabs, Text } from '../lib/ui.js';
import { InstrumentPicker } from '../lib/contracts.js';
import { openInstrument } from './instrument.js';

const CONNECTION = { awaiting: ['', 'awaiting'], configured: ['pen', 'configured, not verified'], connected: ['ok', 'connected'], error: ['bad', 'error'], demo: ['warn', 'demo feed'] };
const DATASET = { awaiting: ['', 'awaiting'], ready: ['ok', 'ready'], partial: ['warn', 'partial'], error: ['bad', 'error'], demo: ['warn', 'demo feed'] };
const PORTS = {
  market: { title: 'Shaffer MarketData', role: 'Facts: reference data, prices, history, FX, rates, calendars, earnings, corporate actions, derivative contract data, borrow and financing data, fundamentals.' },
  analytics: { title: 'Shaffer Analytics Lab', role: 'Model outputs: model runs, signals, scores, fair values and gaps, valuations, timing, sizing, risk, strategies and Shaffer Hedge.' },
};
const ENV = { marketDataUrl: 'SHAFFER_MARKETDATA_URL', analyticsUrl: 'SHAFFER_ANALYTICS_URL', gatewayUrl: 'SHAFFER_GATEWAY_URL' };
const UNIT = { s: [1, 'seconds'], min: [60, 'minutes'], h: [3600, 'hours'], d: [86400, 'days'] };
// [key, label, unit, smallest, largest (both in the unit shown), what it drives]
const INTERVALS = [
  ['quotesMs', 'Prices and quotes', 's', 1, 3600, 'Instruments on screen or with working orders.'],
  ['fxMs', 'FX rates', 's', 1, 3600, 'Currencies held by the Book being viewed.'],
  ['ratesMs', 'Reference and funding rates', 's', 10, 86400, 'Kept for the Shaffer connection. Nothing polls on it yet.'],
  ['referenceMs', 'Reference data', 'min', 1, 10080, 'Kept for the Shaffer connection. Nothing polls on it yet.'],
  ['analyticsMs', 'Analytics Lab outputs', 's', 10, 86400, 'Fair prices, gaps and scores on screen.'],
  ['engineTickMs', 'Engine cycle', 's', 1, 60, 'Order matching, settlement and lifecycle events.'],
  ['uiPollMs', 'Screen polling', 's', 1, 60, 'How often open screens reload. Applies to screens opened after saving.'],
];
// [observation status, unit, built-in limit in seconds when none is saved]
const FRESHNESS = [['real-time', 's'], ['delayed', 'min'], ['indicative', 'min'], ['end-of-day', 'd'], ['model-derived', 'h'], ['reconstructed', 'min', 600], ['simulated', 's']];
const human = (sec) => (!isNum(sec) ? '' : sec < 120 ? `${fmtNum(sec, 0)} s` : sec < 7200 ? `${fmtNum(sec / 60, sec % 60 ? 1 : 0)} min` : sec < 172800 ? `${fmtNum(sec / 3600, sec % 3600 ? 1 : 0)} h` : `${fmtNum(sec / 86400, sec % 86400 ? 1 : 0)} days`);
const notReported = (state) => html`<${Missing} reason=${state === 'awaiting' ? 'Reported by the service once it is connected' : 'Not reported for this dataset'} />`;
const at = (iso, why) => (iso ? fmtTime(iso, { seconds: true }) : html`<${Missing} reason=${why} />`);

// ---- ports and readiness ------------------------------------------------------------------------------------------
function PortPanel({ port, state, demo, reload }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [tone, label] = CONNECTION[state.connection] || ['', state.connection];
  const test = async () => {
    setBusy(true);
    try { const r = await post('/api/data/test', { port }); setResult(r.result); await reload(); refreshStatus().catch(() => {}); } catch (error) { setResult({ error }); }
    setBusy(false);
  };
  const verdict = result && !result.error ? (result.ok ? ['ok', 'Test passed.'] : result.reachable ? ['warn', 'The address answered, but the connection is not verified.'] : state.address ? ['err', 'The address could not be reached.'] : ['', 'Nothing to test yet.']) : null;
  const sets = Object.entries(state.datasets || {}).map(([id, d]) => ({ id, ...d }));
  return html`<div class="stack">
    <${Panel} title=${PORTS[port].title} actions=${html`<${Button} small busy=${busy} onClick=${test}>Test connection<//>`}>
      <div class="stack">
        <div class="row"><${Pill} tone=${tone}>${label}<//><span>${state.message}</span></div>
        <${KV} rows=${[
          ['Configured address', state.address || html`<${Missing} reason=${demo ? 'Demo mode contacts no Shaffer service' : 'No address has been saved or set on the server'} />`],
          ['Last checked', at(state.lastChecked, 'Not tested since the server started')],
          ['Last success', at(state.lastSuccess, 'No data request has succeeded')],
          ['Last error', state.lastError || html`<span class="muted">None recorded</span>`],
        ]} />
        ${result?.error ? html`<${ErrorNote} error=${result.error} />` : null}
        ${verdict ? html`<${Notice} tone=${verdict[0]}><b>${verdict[1]}</b> ${result.detail}${isNum(result.httpStatus) && !result.ok ? ' Any HTTP answer counts as reachable; it says nothing about the data.' : ''}<//>` : null}
        <p class="note" style="margin:0">${PORTS[port].role}</p>
      </div>
    <//>
    <${Panel} title="Dataset readiness" note=${port === 'market' ? 'Market data' : 'Models'} flush>
      <${Table} cls="fit" columns=${[
        { label: 'Dataset', render: (d) => html`<div>${d.label || d.id}</div>${d.note ? html`<div class="sub">${d.note}</div>` : null}` },
        { label: 'State', render: (d) => html`<${Pill} tone=${(DATASET[d.state] || [''])[0]}>${(DATASET[d.state] || ['', d.state])[1]}<//>` },
        { label: 'Coverage', render: (d) => d.coverage || notReported(d.state) },
        { label: 'Last refresh', render: (d) => (d.lastRefresh ? fmtTime(d.lastRefresh) : notReported(d.state)) },
        { label: 'Schedule', title: 'Refresh schedule reported by the service', render: (d) => d.refreshSchedule || notReported(d.state) },
      ]} rows=${sets} rowKey=${(d) => d.id} />
    <//>
  </div>`;
}

function Addresses({ d, demo, reload }) {
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const saved = { marketDataUrl: d.connection.marketDataUrl, analyticsUrl: d.connection.analyticsUrl, gatewayUrl: d.connection.gatewayUrl, timeout: d.connection.requestTimeoutMs / 1000 };
  const v = f || saved;
  const set = (patch) => { setError(null); setF({ ...v, ...patch }); };
  const timeoutBad = !(v.timeout >= 1 && v.timeout <= 120);
  const save = async () => {
    setBusy(true); setError(null);
    const patch = {};
    for (const k of Object.keys(ENV)) if (v[k].trim() !== saved[k]) patch[k] = v[k].trim();
    if (v.timeout !== saved.timeout) patch.requestTimeoutMs = Math.round(v.timeout * 1000);
    try { await put('/api/data/connection', patch); setF(null); await reload(); refreshStatus().catch(() => {}); toast('Service addresses saved.'); } catch (err) { setError(err); }
    setBusy(false);
  };
  const address = (k, label, hint) => html`<${Field} label=${label} span="all" hint=${d.connectionFromEnv?.[k] ? `${ENV[k]} is set on the server. An address saved here takes precedence; clear it to go back to the server's.` : hint}>
    <${Text} value=${v[k]} disabled=${demo} onInput=${(x) => set({ [k]: x })} placeholder="https://" /><//>`;
  return html`<${Panel} title="Service addresses" note="Where the two ports send their requests">
    <div class="cols-2">
      <div class="stack">
        ${demo ? html`<${Notice}>Demo mode runs on the built-in simulated feed and never contacts a Shaffer service, so these addresses are not used here. Set them in the real environment.<//>` : null}
        <${ErrorNote} error=${error} />
        <div class="grid-form">
          ${address('marketDataUrl', 'Shaffer MarketData address', 'Full http(s) address of the MarketData service.')}
          ${address('analyticsUrl', 'Shaffer Analytics Lab address', 'Full http(s) address of the Analytics Lab service.')}
          ${address('gatewayUrl', 'Gateway or proxy address', 'Optional. If set, both ports send their requests here; each port still needs its own address above to be switched on.')}
          <${Field} label="Request timeout (seconds)" error=${timeoutBad ? 'Enter between 1 and 120 seconds.' : null} hint="Between 1 and 120"><${Num} value=${v.timeout} disabled=${demo} onInput=${(x) => set({ timeout: x })} /><//>
        </div>
        <div class="row"><${Button} kind="primary" busy=${busy} disabled=${demo || !f || timeoutBad} onClick=${save}>Save service addresses<//>
          ${f && !demo ? html`<${Button} onClick=${() => { setF(null); setError(null); }}>Discard changes<//>` : null}</div>
      </div>
      <div class="stack">
        <div><h4 style="margin-bottom:4px">Credentials</h4>
          <div class="row" style="margin-bottom:6px"><${Pill} tone=${d.credentialsConfigured ? 'ok' : ''}>${d.credentialsConfigured ? 'credential set on the server' : 'no credential set on the server'}<//></div>
          <p class="small">Credentials are never entered here, never stored in the database and never sent to the browser; only whether one is set is shown. Set them as environment variables on the server and restart it: <b>SHAFFER_API_TOKEN</b> holds the credential, and <b>SHAFFER_AUTH_HEADER</b> names the request header that carries it (Authorization if unset). The addresses can be set the same way with <b>SHAFFER_MARKETDATA_URL</b>, <b>SHAFFER_ANALYTICS_URL</b> and <b>SHAFFER_GATEWAY_URL</b>.</p></div>
        <div><h4 style="margin-bottom:4px">Still needed before either port can work</h4>
          <p class="small">The real API documentation for each service: addresses, authentication, the instrument identifier scheme with payload examples, dataset coverage and refresh schedules. It is then written into <b>server/data/shaffer-contract.js</b>, one operation at a time, and each dataset leaves the waiting state as its operation is filled in.</p>
          <p class="small" style="margin:0">The Terminal does not invent endpoints. Saving an address enables nothing by itself, and until a contract is supplied Test connection can only report whether the address answers.</p></div>
      </div>
    </div>
  <//>`;
}

function DemoPanel({ d, reload }) {
  const [busy, setBusy] = useState(false);
  const on = d.demoHedgeFixture;
  const flip = async (enabled) => {
    setBusy(true);
    try { await post('/api/demo/hedge-fixture', { enabled }); await reload(); toast(enabled ? 'Demo hedge fixture turned on.' : 'Demo hedge fixture turned off.'); } catch (err) { toastError(err); }
    setBusy(false);
  };
  return html`<${Panel} title="Demo mode" note="Isolated demo environment">
    <div class="cols-2">
      <p style="margin:0">This is the demo environment: a simulated price feed, a separate demo database and fictional instruments. Its prices are not market quotes, nothing here touches your real paper Books, and no Shaffer service is contacted. Analytics are not simulated, so fair prices, gaps and scores stay in the waiting state.</p>
      <div class="stack" style="gap:6px">
        <h4>Demo hedge fixture</h4>
        ${on === undefined || on === null ? html`<span class="note">The fixture setting is not reported by this server.</span>`
          : html`<${Check} checked=${on} disabled=${busy} onChange=${flip}>Answer hedge requests with the canned demo packages<//>`}
        <p class="note" style="margin:0"><b>Canned demo data, not Shaffer Hedge output.</b> The fixture returns a few fixed, illustrative packages for the fictional equities so the hedge screens can be exercised before Analytics Lab is connected. Turn it off to see the waiting state those screens show in real use. It applies to hedge requests made from now on.</p>
      </div>
    </div>
  <//>`;
}

function ConnectionTab({ d, demo, reload }) {
  return html`<div class="stack">
    <div class="cols-2">
      <${PortPanel} port="market" state=${d.market} demo=${demo} reload=${reload} />
      <${PortPanel} port="analytics" state=${d.analytics} demo=${demo} reload=${reload} />
    </div>
    <${Notice} tone="warn"><b>Each dataset is ready or not by itself.</b> Market-data readiness and model readiness are tracked separately. Historical coverage alone does not mean live prices are available. Supported equities do not imply foreign-bond prices, repo rates, borrow availability, OTC marks or options-on-futures data.<//>
    ${demo ? html`<${DemoPanel} d=${d} reload=${reload} />` : null}
    <${Addresses} d=${d} demo=${demo} reload=${reload} />
  </div>`;
}

// ---- refresh settings -------------------------------------------------------------------------------------------------
function RefreshTab({ d, reload }) {
  const r = d.refresh;
  const initial = () => ({ ...Object.fromEntries(INTERVALS.map(([k, , u]) => [k, r[k] / 1000 / UNIT[u][0]])), ...Object.fromEntries(FRESHNESS.map(([k, u]) => [`f:${k}`, isNum(r.freshness[k]) ? r.freshness[k] / UNIT[u][0] : null])) });
  const [f, setF] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, x) => { setF({ ...f, [k]: x }); setDirty(true); setError(null); };
  const bad = (k, min, max) => (isNum(f[k]) && f[k] >= min && f[k] <= max ? null : `Enter between ${fmtNum(min, 0)} and ${fmtNum(max, 0)}.`);
  const freshBad = (k, fallback) => (f[`f:${k}`] === null && fallback ? null : f[`f:${k}`] > 0 ? null : 'Enter a number above zero.');
  const invalid = INTERVALS.some(([k, , , min, max]) => bad(k, min, max)) || FRESHNESS.some(([k, , fallback]) => freshBad(k, fallback));
  const save = async () => {
    setBusy(true); setError(null);
    const body = { freshness: {} };
    for (const [k, , u] of INTERVALS) body[k] = Math.round(f[k] * UNIT[u][0] * 1000);
    for (const [k, u] of FRESHNESS) if (f[`f:${k}`] !== null) body.freshness[k] = f[`f:${k}`] * UNIT[u][0];
    try { await put('/api/data/refresh', body); await reload(); await refreshStatus(); setDirty(false); toast('Refresh settings saved.'); } catch (err) { setError(err); }
    setBusy(false);
  };
  return html`<div class="stack">
    <${ErrorNote} error=${error} />
    <${Panel} title="Refresh intervals" note="How often the Terminal asks for each kind of data">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">
        ${INTERVALS.map(([k, label, u, min, max, what]) => html`<${Field} label=${`${label} (${UNIT[u][1]})`} error=${bad(k, min, max)} hint=${`${what}${isNum(f[k]) ? ` Every ${human(f[k] * UNIT[u][0])}.` : ''}`}><${Num} value=${f[k]} onInput=${(x) => set(k, x)} /><//>`)}
      </div>
      <p class="note" style="margin:10px 0 0">An interval is the shortest time between two requests for the same data; nothing is fetched for instruments nobody is looking at or holding. While a port is awaiting its connection there is nothing to fetch on any interval.</p>
    <//>
    <${Panel} title="Freshness limits" note="When an observation is flagged stale">
      <div class="grid-form" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">
        ${FRESHNESS.map(([k, u, fallback]) => html`<${Field} label=${`${(d.statusLabels || {})[k] || STATUS[k]} (${UNIT[u][1]})`} error=${freshBad(k, fallback)}
          hint=${f[`f:${k}`] === null ? `No limit saved. The built-in limit of ${human(fallback)} applies.` : `Stale when older than ${human(f[`f:${k}`] * UNIT[u][0])}${k === 'delayed' ? ', on top of the feed\'s stated delay' : ''}.`}>
          <${Num} value=${f[`f:${k}`]} onInput=${(x) => set(`f:${k}`, x)} placeholder=${fallback ? String(fallback / UNIT[u][0]) : ''} /><//>`)}
      </div>
      <p class="note" style="margin:10px 0 0">A stale price keeps its provenance chip, struck through. Manual entries have no limit: they are labelled manual and are never called fresh or stale.</p>
    <//>
    <div class="row"><${Button} kind="primary" busy=${busy} disabled=${!dirty || invalid} onClick=${save}>Save refresh settings<//>
      ${dirty ? html`<${Button} onClick=${() => { setF(initial()); setDirty(false); setError(null); }}>Discard changes<//>` : null}</div>
  </div>`;
}
const STATUS = { 'real-time': 'Real-time', delayed: 'Delayed', indicative: 'Indicative', 'end-of-day': 'End-of-day', 'model-derived': 'Model-derived', reconstructed: 'Reconstructed', simulated: 'Simulated (demo feed)' };

// ---- manual entries ---------------------------------------------------------------------------------------------------
const CCY = /^[A-Z]{3}$/;
function ManualForms({ rateCodes, onSaved }) {
  const [fx, setFx] = useState({ base: '', quote: '', rate: null, note: '' });
  const [rate, setRate] = useState({ code: '', value: null, forDate: '', note: '' });
  const [px, setPx] = useState({ inst: null, value: null, bid: null, ask: null, forDate: '', note: '' });
  const [round, setRound] = useState(0); // a fresh picker after each saved price
  const [busy, setBusy] = useState('');
  const [error, setError] = useState({});
  const send = async (which, body, done, reset) => {
    setBusy(which); setError({});
    try { await post('/api/observations', body); toast(done); reset(); bump(); onSaved(); } catch (err) { setError({ [which]: err }); }
    setBusy('');
  };
  const pairOk = CCY.test(fx.base) && CCY.test(fx.quote) && fx.base !== fx.quote;
  const saveFx = () => send('fx', { kind: 'fx', subject: `${fx.base}/${fx.quote}`, value: fx.rate, currency: fx.quote, units: `${fx.quote} per ${fx.base}`, note: fx.note.trim() || null }, 'FX rate saved.', () => setFx({ base: '', quote: '', rate: null, note: '' }));
  const saveRate = () => send('rate', { kind: 'rate', subject: rate.code.trim(), value: rate.value, units: 'percent p.a.', forDate: rate.forDate || null, note: rate.note.trim() || null }, 'Rate saved.', () => setRate({ code: '', value: null, forDate: '', note: '' }));
  const savePx = () => send('px', { kind: 'price', subject: px.inst.id, value: px.value, bid: px.bid, ask: px.ask, currency: px.inst.tradingCcy, units: px.inst.priceUnits, forDate: px.forDate || null, note: px.note.trim() || null }, 'Price saved.', () => { setPx({ inst: null, value: null, bid: null, ask: null, forDate: '', note: '' }); setRound(round + 1); });
  const pxOk = px.inst && (isNum(px.value) || (isNum(px.bid) && isNum(px.ask)));
  const two = 'grid-template-columns:repeat(2,minmax(0,1fr))';
  return html`<div class="cols-3">
    <${Panel} title="FX rate">
      <div class="stack"><${ErrorNote} error=${error.fx} />
        <div class="grid-form" style=${two}>
          <${Field} label="Base currency"><${Text} value=${fx.base} onInput=${(x) => setFx({ ...fx, base: x.toUpperCase() })} placeholder="EUR" /><//>
          <${Field} label="Quote currency" error=${fx.base && fx.base === fx.quote ? 'Must differ from the base.' : null}><${Text} value=${fx.quote} onInput=${(x) => setFx({ ...fx, quote: x.toUpperCase() })} placeholder="USD" /><//>
          <${Field} label=${pairOk ? `Rate (${fx.quote} per 1 ${fx.base})` : 'Rate (quote per 1 base)'} span="all"><${Num} value=${fx.rate} onInput=${(x) => setFx({ ...fx, rate: x })} /><//>
          <${Field} label="Note" span="all" hint="Where the rate came from"><${Text} value=${fx.note} onInput=${(x) => setFx({ ...fx, note: x })} /><//>
        </div>
        <div><${Button} busy=${busy === 'fx'} disabled=${!pairOk || !(fx.rate > 0)} onClick=${saveFx}>Save FX rate<//></div>
        <p class="note" style="margin:0">Used for valuation in the reporting currency and for conversions, in either direction and across USD. A transfer never converts currency.</p></div>
    <//>
    <${Panel} title="Reference or funding rate">
      <div class="stack"><${ErrorNote} error=${error.rate} />
        <div class="grid-form" style=${two}>
          <${Field} label="Rate code" span="all" hint="The code used on floating legs, loans, repos and fixings"><${Text} value=${rate.code} list="sdt-rate-codes" onInput=${(x) => setRate({ ...rate, code: x })} />
            <datalist id="sdt-rate-codes">${rateCodes.map((c) => html`<option value=${c}></option>`)}</datalist><//>
          <${Field} label="Value (percent a year)" hint="4.5 means 4.5%"><${Num} value=${rate.value} onInput=${(x) => setRate({ ...rate, value: x })} /><//>
          <${Field} label="Fixing date" hint="Optional. Empty means from today."><${Text} type="date" value=${rate.forDate} onInput=${(x) => setRate({ ...rate, forDate: x })} /><//>
          <${Field} label="Note" span="all" hint="Where the rate came from"><${Text} value=${rate.note} onInput=${(x) => setRate({ ...rate, note: x })} /><//>
        </div>
        <div><${Button} busy=${busy === 'rate'} disabled=${!rate.code.trim() || !isNum(rate.value)} onClick=${saveRate}>Save rate<//></div>
        <p class="note" style="margin:0">A rate is in force from its date until a later one is entered or supplied. Floating coupons and swap payments wait, visibly, for the fixing they need.</p></div>
    <//>
    <${Panel} title="Instrument price">
      <div class="stack"><${ErrorNote} error=${error.px} />
        <div class="grid-form" style=${two}>
          <${Field} label="Instrument" span="all"><${InstrumentPicker} key=${round} value=${px.inst?.id || ''} onChange=${(id, i) => setPx({ ...px, inst: i })} /><//>
          <${Field} label=${px.inst ? `Price (${px.inst.priceUnits}, ${px.inst.tradingCcy})` : 'Price'} span="all"><${Num} value=${px.value} onInput=${(x) => setPx({ ...px, value: x })} /><//>
          <${Field} label="Bid" hint="Optional"><${Num} value=${px.bid} onInput=${(x) => setPx({ ...px, bid: x })} /><//>
          <${Field} label="Ask" hint="Optional"><${Num} value=${px.ask} onInput=${(x) => setPx({ ...px, ask: x })} /><//>
          <${Field} label="Close or fixing for date" span="all" hint="Leave empty for a current price"><${Text} type="date" value=${px.forDate} onInput=${(x) => setPx({ ...px, forDate: x })} /><//>
          <${Field} label="Note" span="all" hint="Where the price came from"><${Text} value=${px.note} onInput=${(x) => setPx({ ...px, note: x })} /><//>
        </div>
        <div><${Button} busy=${busy === 'px'} disabled=${!pxOk} onClick=${savePx}>Save price<//></div></div>
    <//>
  </div>`;
}

function ManualTab({ book }) {
  const [show, setShow] = useState('current');
  const [kind, setKind] = useState('');
  const res = useLive(async () => {
    const [obs, insts] = await Promise.all([get('/api/observations'), get('/api/instruments', { limit: 2000, arrangements: '1' })]);
    return { items: obs.items, names: new Map(insts.items.map((i) => [i.id, i])) };
  }, [book?.id]);
  const items = res.data?.items || [];
  const names = res.data?.names || new Map();
  const rows = items.filter((r) => (show === 'all' || (show === 'current') === !r.superseded_by) && (!kind || r.kind === kind));
  const rateCodes = useMemo(() => [...new Set(items.filter((r) => r.kind === 'rate').map((r) => r.subject))], [items]);
  // The stored row, in the shape the provenance chip reads.
  const obs = (r) => ({ kind: r.kind, value: r.value, status: r.status, statusLabel: 'Manually entered', source: r.source, asOf: r.as_of, forDate: r.for_date, currency: r.currency, units: r.units, assumptions: ['Manually entered. Not a market quote.'] });
  const subject = (r) => { const i = r.kind === 'price' || r.kind === 'borrow' ? names.get(r.subject) : null; return i ? html`<a href="javascript:void 0" onClick=${() => openInstrument(i.id, { tab: 'overview' })}><span class="sym">${i.symbol || i.name}</span></a> <span class="sub">${i.symbol ? i.name : ''}</span>` : html`<span class="sym">${r.subject}</span>`; };
  const value = (r) => (r.kind === 'price' ? html`<${Price} obs=${obs(r)} />` : !isNum(r.value) ? html`<${Missing} reason="No value in this entry" />`
    : html`<span class="price"><span class="v">${r.kind === 'fx' ? fmtNum(r.value, r.value >= 100 ? 3 : 5) : `${fmtNum(r.value, 3)}%`}</span> <${Prov} obs=${obs(r)} /></span>`);
  const columns = [
    { label: 'Entered', render: (r) => fmtTime(r.received_at) },
    { label: 'Kind', render: (r) => ({ price: 'Price', fx: 'FX rate', rate: 'Rate', borrow: 'Borrow fee' }[r.kind] || r.kind) },
    { label: 'Subject', render: subject },
    { label: 'Value', align: 'r', render: value },
    { label: 'Bid / ask', align: 'r', render: (r) => (isNum(r.bid) && isNum(r.ask) ? `${fmtNum(r.bid, 4)} / ${fmtNum(r.ask, 4)}` : '') },
    { label: 'Units', render: (r) => [r.units, r.kind === 'price' ? r.currency : ''].filter(Boolean).join(', ') },
    { label: 'Applies to', render: (r) => (r.for_date ? `${r.kind === 'rate' ? 'from' : 'close or fixing for'} ${r.for_date}` : 'current, from entry') },
    { label: 'Status', render: (r) => (r.superseded_by ? html`<span class="muted" title=${`Replaced by a later entry (number ${r.superseded_by}). Kept for the record.`}>superseded</span>` : html`<${Pill} tone="ok" title="The latest manual entry for this subject and date. It is used wherever no connected feed supplies the value.">in use<//>`) },
    { label: 'Note', render: (r) => html`<span class="clip" title=${r.note || ''}>${r.note || ''}</span>` },
  ];
  const current = items.filter((r) => !r.superseded_by).length;
  return html`<div class="stack">
    <${Notice}>Manual entries are always labelled as manually entered wherever they appear, with the time they were entered, and are never presented as live quotes. They fill gaps: where a connected feed supplies the same price or FX rate, the feed's value is used and the entry stays on file.<//>
    <${ManualForms} rateCodes=${rateCodes} onSaved=${res.reload} />
    <div>
      <div class="toolbar">
        <h3>Manual entries on file</h3>
        <${Seg} value=${show} onChange=${setShow} options=${[{ value: 'current', label: `In use (${current})` }, { value: 'superseded', label: `Superseded (${items.length - current})` }, { value: 'all', label: 'All' }]} />
        <${Seg} value=${kind} onChange=${setKind} options=${[{ value: '', label: 'All kinds' }, { value: 'price', label: 'Prices' }, { value: 'fx', label: 'FX rates' }, { value: 'rate', label: 'Rates' }]} />
        <span class="grow"></span>${items.length >= 200 ? html`<span class="note">Showing the latest 200 entries.</span>` : null}
      </div>
      <div class="panel"><div class="body flush">
        ${!res.data ? (res.error ? html`<div style="padding:12px"><${ErrorNote} error=${res.error} /></div>` : html`<${Empty}>Loading manual entries…<//>`) : html`<${Table} margin columns=${columns} rows=${rows} rowKey=${(r) => r.id}
          empty=${{ title: items.length ? 'No entry matches these filters' : 'No manual entries yet', children: items.length ? 'Choose another filter above.' : 'Prices, FX rates and reference rates entered with the forms above are listed here. An entry is never deleted: a newer one supersedes it.' }} />`}
      </div></div>
    </div>
  </div>`;
}

export default function DataConnection({ args, book, status }) {
  const tab = ['refresh', 'manual'].includes(args[0]) ? args[0] : 'connection';
  const live = useLive(() => get('/api/data'), []);
  const d = live.data ? { ...live.data, statusLabels: status.statusLabels } : null;
  const demo = Boolean(status.demo);
  useEffect(() => { if (live.data && live.data.manualEntries !== status.data.manualEntries) refreshStatus().catch(() => {}); }, [live.data?.manualEntries]);
  const steps = [['External sources', 'The Terminal never connects to them.'], ['Shaffer MarketData Database', 'Collects and stores the external data.'],
    ['Analytics Lab / approved service API', 'The only services the Terminal calls.'], ['Desk Terminal', 'One data adapter, two ports.']];
  return html`<div>
    <div class="page-head"><div><h1>Data connection</h1><div class="sub">Where market facts and analytics come from, and how ready each source is. Paper accounting is kept in the Terminal and never depends on a connection.</div></div></div>
    <div class="panel" style="margin-bottom:12px"><div class="body flow">
      ${steps.map(([name, what], n) => html`<div class="step"><span class="k">${n === 0 ? 'Data starts at' : n === 3 ? 'and reaches the' : 'then'}</span><span class="v">${name}</span><span class="s">${what}</span></div>`)}
    </div></div>
    ${!d ? (live.error ? html`<${ErrorNote} error=${live.error} />` : html`<${Empty}>Loading the data connection…<//>`) : html`
      <${Tabs} value=${tab} onChange=${(t) => { location.hash = t === 'connection' ? '#/data' : `#/data/${t}`; }} tabs=${[{ id: 'connection', label: 'Connection and readiness' }, { id: 'refresh', label: 'Refresh and freshness' }, { id: 'manual', label: 'Manual entries', count: d.manualEntries }]} />
      ${tab === 'connection' ? html`<${ConnectionTab} d=${d} demo=${demo} reload=${live.reload} />` : null}
      ${tab === 'refresh' ? html`<${RefreshTab} d=${d} reload=${live.reload} />` : null}
      ${tab === 'manual' ? html`<${ManualTab} book=${book} />` : null}
      ${!demo ? html`<p class="note" style="margin-top:14px">To try the Terminal on a simulated feed with fictional instruments, stop the server and start it with <b>npm run demo</b>. Demo mode keeps its own database, so it never mixes with these Books.</p>` : null}`}
  </div>`;
}
