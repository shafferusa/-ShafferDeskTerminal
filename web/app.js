// Application shell: top bar, navigation, routing. Each screen is loaded on demand so the first
// paint only needs the shell.
import { html, render, useEffect, useState } from './vendor/preact-htm.js';
import { bump, currentBook, fmtTime, get, getState, openOverlay, post, refreshStatus, setBook, setTheme, toast, toastError, useStore, VIEW_LABEL } from './lib/core.js';
import { Awaiting, Button, Field, Modal, Num, Overlays, Select, Text, Toasts } from './lib/ui.js';

const ROUTES = {
  markets: () => import('./views/markets.js'),
  strategy: () => import('./views/strategy.js'),
  accounting: () => import('./views/accounting.js'),
  books: () => import('./views/books.js'),
  instruments: () => import('./views/registry.js'),
  data: () => import('./views/data.js'),
  settings: () => import('./views/settings.js'),
};
const parseHash = () => {
  const parts = (location.hash || '#/markets/US_CASH').replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: ROUTES[parts[0]] ? parts[0] : 'markets', args: parts.slice(1) };
};

function Conn({ label, state }) {
  if (!state) return null;
  const cls = state.connection === 'connected' ? 'st-connected' : state.connection === 'demo' ? 'st-demo' : state.connection === 'error' ? 'st-error' : 'st-awaiting';
  const text = { connected: 'connected', demo: 'demo feed', error: 'error', configured: 'not verified', awaiting: 'awaiting' }[state.connection] || state.connection;
  return html`<a class=${`conn ${cls}`} href="#/data" title=${state.message}><i></i>${label}: ${text}</a>`;
}

function NewBook({ onClose, first }) {
  const [name, setName] = useState(first ? 'Main Book' : '');
  const [ccy, setCcy] = useState('USD');
  const [cash, setCash] = useState(first ? 1000000 : null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const b = await post('/api/books', { name, reportingCcy: ccy.toUpperCase() });
      if (cash > 0) await post(`/api/books/${b.id}/capital`, { type: 'deposit', ccy: ccy.toUpperCase(), amount: cash, note: 'Starting capital' });
      await refreshStatus();
      setBook(b.id);
      toast(`Book "${b.name}" created with its Treasury.`);
      onClose?.();
    } catch (err) { toastError(err); setBusy(false); }
  };
  const form = html`<div class="grid-form">
    <${Field} label="Book name" span=${2}><${Text} value=${name} onInput=${setName} autofocus /><//>
    <${Field} label="Reporting currency"><${Text} value=${ccy} onInput=${setCcy} /><//>
    <${Field} label="Starting paper capital" hint="Deposited into Treasury. Optional."><${Num} value=${cash} onInput=${setCash} /><//>
  </div>`;
  if (first) return html`<div class="panel" style="max-width:620px"><header><h2>Create your first Book</h2></header><div class="body stack">
    <p>A Book holds one Treasury and any number of Accounts. Treasury keeps the Book's unallocated cash, funding and collateral; Accounts are funded from it and hold their own positions.</p>
    ${form}<div><${Button} kind="primary" busy=${busy} disabled=${!name.trim()} onClick=${save}>Create Book<//></div></div></div>`;
  return html`<${Modal} title="New Book" onClose=${onClose} footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!name.trim()} onClick=${save}>Create Book<//>`}>${form}<//>`;
}

function DemoBand({ status }) {
  const [busy, setBusy] = useState(false);
  const adv = async (body) => {
    setBusy(true);
    try { await post('/api/demo/advance', body); await refreshStatus(); bump(); } catch (err) { toastError(err); }
    setBusy(false);
  };
  return html`<div class="band"><b>Demo mode</b><span>Simulated feed and a separate demo database. Prices are not market quotes, and nothing here touches your real paper books.</span><span class="spacer"></span>
    <span class="small">Move the demo clock:</span>
    <${Button} small busy=${busy} onClick=${() => adv({ ms: 3600e3 })}>+1 hour<//><${Button} small busy=${busy} onClick=${() => adv({ ms: 86400e3 })}>+1 day<//><${Button} small busy=${busy} onClick=${() => adv({ ms: 7 * 86400e3 })}>+1 week<//>
    ${status.clockSimulated ? html`<span class="small muted">clock moved</span>` : null}</div>`;
}

function Shell() {
  const status = useStore((s) => s.status);
  const books = useStore((s) => s.books);
  const bookId = useStore((s) => s.bookId);
  const theme = useStore((s) => s.theme);
  const [route, setRoute] = useState(parseHash());
  const [View, setView] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const tick = useStore((s) => s.tick);
  const overlayCount = useStore((s) => s.overlay.length);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    let live = true;
    setView(null);
    ROUTES[route.page]().then((m) => { if (live) setView(() => m.default); }, (err) => toastError(err));
    return () => { live = false; };
  }, [route.page]);
  useEffect(() => {
    if (!bookId) return;
    get(`/api/books/${bookId}/alerts`).then((r) => setAlerts(r.items), () => {});
    // Workflow 2: a hedge request made automatically after a direct Marketplace fill. The popup opens
    // when Shaffer Hedge returned packages to choose from. While Analytics Lab is not connected there
    // is nothing to choose, so the request is announced without interrupting; it stays on the
    // position's strategy. A prompt never opens on top of a dialog that is already in use.
    if (document.querySelector('.modal')) return;
    get('/api/hedge/prompts', { bookId }).then(async (r) => {
      for (const h of r.items) {
        await post(`/api/hedge/requests/${h.id}/seen`);
        const p = h.request.primary;
        const what = p?.instrument ? `${p.direction === 'short' ? 'short' : 'long'} ${p.instrument.symbol || p.instrument.name}` : 'the filled position';
        if (h.response?.packages?.length) {
          const { HedgePopup } = await import('./views/hedge.js');
          openOverlay((close) => html`<${HedgePopup} request=${h} onClose=${close} />`);
        } else if (h.status === 'error') toast(`Hedge request for ${what} failed: ${h.message}`, 'err', 9000);
        else toast(`Hedge requested for ${what}. ${h.status === 'awaiting' ? `${h.awaitingMessage}.` : h.message || ''} The request is kept on the position's strategy.`, 'warn', 9000);
      }
    }, () => {});
  }, [bookId, tick, overlayCount]);

  if (!status) return html`<div class="boot">Shaffer Desk Terminal</div>`;
  const book = currentBook();
  // With no saved choice the Terminal follows the system setting.
  const dark = theme ? theme === 'dark' : Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const errors = alerts.filter((a) => a.level === 'error').length;
  const nav = (href, label, extra) => html`<a href=${href} class=${`${location.hash.startsWith(href) || (href === '#/markets/US_CASH' && !location.hash) ? 'on' : ''} ${extra?.sub ? 'sub' : ''}`}>${label}${extra?.count ? html`<span class="count">${extra.count}</span>` : null}</a>`;
  const showAlerts = () => openOverlay((close) => html`<${Modal} title="Items needing attention" size="mid" onClose=${close}>
    <div class="stack">${alerts.length ? alerts.map((a) => html`<div class=${`notice ${a.level === 'error' ? 'err' : 'warn'}`}>${a.message}<div class="sub muted">${fmtTime(a.ts)}</div></div>`) : html`<p class="note">Nothing needs attention.</p>`}</div><//>`);

  return html`<div class="shell">
    <div class="topbar">
      <div class="brand">Shaffer Desk Terminal<small>paper trading</small></div>
      ${books.length ? html`<${Select} value=${bookId} onChange=${(v) => (v === '__new' ? openOverlay((close) => html`<${NewBook} onClose=${close} />`) : setBook(v))}
        options=${[...books.map((b) => ({ value: b.id, label: b.name })), { value: '__new', label: '+ New Book…' }]} />` : null}
      ${alerts.length ? html`<button class=${`conn ${errors ? 'st-error' : 'st-awaiting'}`} onClick=${showAlerts}><i></i>${alerts.length} to review</button>` : null}
      <span class="grow"></span>
      <${Conn} label="MarketData" state=${status.data.market} />
      <${Conn} label="Analytics Lab" state=${status.data.analytics} />
      <span class="clock" title="Business date and time, New York">${fmtTime(status.now)}</span>
      <${Button} small onClick=${() => setTheme(dark ? 'light' : 'dark')} title="Switch between light and dark mode">${dark ? 'Light mode' : 'Dark mode'}<//>
    </div>
    ${status.demo ? html`<${DemoBand} status=${status} />` : html`<div class="band-none"></div>`}
    <nav class="rail">
      <div class="group">Markets</div>
      ${Object.entries(VIEW_LABEL).map(([id, label]) => nav(`#/markets/${id}`, label, { sub: true }))}
      <div class="group">Desk</div>
      ${nav('#/strategy', 'Strategy')}
      ${nav('#/accounting', 'Accounting')}
      ${nav('#/books', 'Books and Treasury')}
      <div class="group">Reference</div>
      ${nav('#/instruments', 'Instruments')}
      ${nav('#/data', 'Data connection')}
      ${nav('#/settings', 'Settings')}
      <div class="foot">All orders, borrowing, lending, funding, collateral and settlement are simulated.</div>
    </nav>
    <main class="main">
      ${!books.length ? html`<${NewBook} first />`
        : View ? html`<${View} args=${route.args} book=${book} status=${status} key=${`${route.page}:${book?.id}`} />` : html`<div class="note">Loading…</div>`}
    </main>
    <${Overlays} /><${Toasts} />
  </div>`;
}

async function boot() {
  try { await refreshStatus(); } catch (err) { document.getElementById('app').innerHTML = `<div class="boot">The Terminal server is not responding. ${err.message}</div>`; return; }
  render(html`<${Shell} />`, document.getElementById('app'));
  setInterval(() => { if (!document.hidden) refreshStatus().catch(() => {}); }, 20000);
  // The engine announces changes (fills, settlements, lifecycle events) so screens reload at once.
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = () => bump();
  } catch { /* polling still works */ }
  void getState; void Awaiting;
}
boot();
