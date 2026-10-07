// Application shell: top bar, navigation, routing. Each screen is loaded on demand so the first
// paint only needs the shell.
import { html, render, useEffect, useState } from './vendor/preact-htm.js';
import { bump, currentBook, fmtTime, get, getState, openOverlay, post, refreshStatus, setBook, setTheme, setUnit, toast, toastError, useStore, VIEW_LABEL } from './lib/core.js';
import { Awaiting, Button, Field, Modal, Num, Overlays, Select, Text, Toasts } from './lib/ui.js';

// Every screen below the top bar belongs to the one Book that is selected. Book selection and
// management (#/books) is a separate layer: it is not part of Treasury and never combines Books.
const ROUTES = {
  accounting: () => import('./views/accounting.js'),
  treasury: () => import('./views/treasury.js'),
  account: () => import('./views/account.js'),
  strategy: () => import('./views/strategy.js'),
  markets: () => import('./views/markets.js'),
  instruments: () => import('./views/registry.js'),
  data: () => import('./views/data.js'),
  settings: () => import('./views/settings.js'),
  books: () => import('./views/books.js'),
};
const HOME = '#/accounting';
const parseHash = () => {
  const parts = (location.hash || HOME).replace(/^#\/?/, '').split('/').filter(Boolean);
  return { page: ROUTES[parts[0]] ? parts[0] : 'accounting', args: ROUTES[parts[0]] ? parts.slice(1) : [] };
};
const flag = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const setFlag = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };

// True while the post-trade hedge prompt is being fetched and opened, so two reloads cannot open two popups.
let promptOpening = false;

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

function NewAccount({ book, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const a = await post(`/api/books/${book.id}/accounts`, { name });
      await refreshStatus();
      setUnit(a.id);
      bump();
      toast(`Account "${a.name}" created. Fund it from Treasury to start trading in it.`);
      location.hash = `#/account/${a.id}`;
      onClose();
    } catch (err) { toastError(err); setBusy(false); }
  };
  return html`<${Modal} title="New Account" sub=${`In ${book.name}. An Account is funded from this Book's Treasury and holds its own positions and borrowings.`} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!name.trim()} onClick=${save}>Create Account<//>`}>
    <${Field} label="Account name"><${Text} value=${name} onInput=${setName} autofocus /><//><//>`;
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
  // Who answers hedge requests right now. Stated apart from the Analytics Lab connection, which it must never contradict.
  const [hedgeSvc, setHedgeSvc] = useState(null);
  const [acctOpen, setAcctOpen] = useState(flag('sdt.accts', true));
  const unitId = useStore((s) => s.unitId);
  const tick = useStore((s) => s.tick);
  const overlayCount = useStore((s) => s.overlay.length);
  // Set while the server cannot be reached (lib/core.js): the screen then says it is not current.
  const offline = useStore((s) => s.offline);
  useEffect(() => { get('/api/hedge/service').then(setHedgeSvc, () => {}); }, [tick]);

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
    // Workflow 2: after a direct Marketplace fill the hedge request is made automatically and its popup
    // opens, with the recommended package or, while Analytics Lab is away, the waiting state. It never
    // opens on top of a dialog that is in use; it waits for that dialog to close.
    if (document.querySelector('.modal')) return;
    // One popup at a time: when several positions are waiting to be shown, the next opens after this one closes.
    if (promptOpening) return;
    promptOpening = true;
    get('/api/hedge/prompts', { bookId }).then(async (r) => {
      const h = r.items[0];
      if (h && !document.querySelector('.modal')) {
        await post(`/api/hedge/requests/${h.id}/seen`);
        const { HedgePopup } = await import('./views/hedge.js');
        openOverlay((close) => html`<${HedgePopup} request=${h} onClose=${close} />`);
      }
    }).catch(() => {}).finally(() => { promptOpening = false; });
  }, [bookId, tick, overlayCount]);

  if (!status) return html`<div class="boot">Shaffer Desk Terminal</div>`;
  const book = currentBook();
  // With no saved choice the Terminal follows the system setting.
  const dark = theme ? theme === 'dark' : Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const errors = alerts.filter((a) => a.level === 'error').length;
  const here = location.hash || HOME;
  const nav = (href, label, extra) => html`<a href=${href} class=${`${here.startsWith(href) ? 'on' : ''} ${extra?.sub ? 'sub' : ''}`}>${label}${extra?.count ? html`<span class="count">${extra.count}</span>` : null}</a>`;
  const accounts = book ? book.units.filter((u) => u.kind === 'account') : [];
  const toggleAccounts = () => { setFlag('sdt.accts', !acctOpen); setAcctOpen(!acctOpen); };
  const showAlerts = () => openOverlay((close) => html`<${Modal} title="Items needing attention" size="mid" onClose=${close}>
    <div class="stack">${alerts.length ? alerts.map((a) => html`<div class=${`notice ${a.level === 'error' ? 'err' : 'warn'}`}>${a.message}<div class="sub muted">${fmtTime(a.ts)}</div></div>`) : html`<p class="note">Nothing needs attention.</p>`}</div><//>`);

  return html`<div class="shell">
    <div class="topbar">
      <div class="brand">Shaffer Desk Terminal<small>paper trading</small></div>
      ${books.length ? html`<span class="small muted">Book</span><${Select} value=${bookId} onChange=${(v) => (v === '__new' ? openOverlay((close) => html`<${NewBook} onClose=${close} />`) : setBook(v))}
        options=${[...books.map((b) => ({ value: b.id, label: b.name })), { value: '__new', label: '+ New Book…' }]} />
        <a class="btn small" href="#/books" title="Books are separate workspaces. Open, rename or create one.">Manage Books</a>` : null}
      ${alerts.length ? html`<button class=${`conn ${errors ? 'st-error' : 'st-awaiting'}`} onClick=${showAlerts}><i></i>${alerts.length} to review</button>` : null}
      <span class="grow"></span>
      <${Conn} label="MarketData" state=${status.data.market} />
      <${Conn} label="Analytics Lab" state=${status.data.analytics} />
      ${hedgeSvc?.fixture ? html`<a class="conn st-fixture" href="#/data" data-testid="hedge-service-chip" title=${`Analytics Lab is not connected. ${hedgeSvc.kind === 'demo-fixture' ? 'The labelled demo fixture' : 'A scripted test fixture'} answers complete hedge requests${hedgeSvc.reachable ? '' : ' (it is switched off for now)'} and supplies a fictional Strategy list. It is not Shaffer Hedge.`}><i></i>Hedge: ${hedgeSvc.kind === 'demo-fixture' ? 'demo fixture' : 'test fixture'}${hedgeSvc.reachable ? '' : ', off'}</a>` : null}
      <span class="clock" title="Business date and time, New York">${fmtTime(status.now)}</span>
      <${Button} small onClick=${() => setTheme(dark ? 'light' : 'dark')} title="Switch between light and dark mode">${dark ? 'Light mode' : 'Dark mode'}<//>
    </div>
    ${status.demo ? html`<${DemoBand} status=${status} />` : html`<div class="band-none"></div>`}
    <nav class="rail">
      ${book ? html`
        <div class="group" title="Everything below belongs to this Book only">${book.name}</div>
        ${nav('#/accounting', 'Accounting')}
        ${nav('#/treasury', 'Treasury')}
        <button class="rail-toggle sub" aria-expanded=${acctOpen} onClick=${toggleAccounts} title="Accounts funded from this Treasury"><span class=${`caret ${acctOpen ? 'open' : ''}`} aria-hidden="true"></span>Accounts<span class="n">${accounts.length}</span></button>
        ${acctOpen ? html`
          ${accounts.map((a) => html`<a key=${a.id} href=${`#/account/${a.id}`} onClick=${() => setUnit(a.id)} class=${`sub acct ${here.startsWith(`#/account/${a.id}`) ? 'on' : ''}`}
            title=${a.id === unitId ? 'This Account is in use on trade tickets and the Strategy page' : 'Open this Account and use it on trade tickets and the Strategy page'}><span class="nm">${a.name}</span>${a.id === unitId ? html`<span class="inuse">in use</span>` : null}</a>`)}
          <button class="rail-toggle sub acct add" onClick=${() => openOverlay((close) => html`<${NewAccount} book=${book} onClose=${close} />`)}>New Account</button>` : null}
        ${nav('#/strategy', 'Strategies')}
        <div class="group">Marketplaces</div>
        ${Object.entries(VIEW_LABEL).map(([id, label]) => nav(`#/markets/${id}`, label, { sub: true }))}` : null}
      <div class="group">Reference</div>
      ${nav('#/instruments', 'Instruments')}
      ${nav('#/data', 'Data connection')}
      ${nav('#/settings', 'Settings')}
      <div class="foot">All orders, borrowing, lending, funding, collateral and settlement are simulated.</div>
    </nav>
    <main class="main">
      ${!books.length ? html`<${NewBook} first />`
        : View ? html`<${View} args=${route.args} book=${book} status=${status} key=${`${route.page}:${book?.id}${route.page === 'account' ? `:${route.args[0]}` : ''}`} />` : html`<div class="note">Loading…</div>`}
    </main>
    ${offline ? html`<div class="offline-bar" role="alert"><b>The Terminal server is not reachable.</b> What is on screen may be out of date, and nothing can be recorded until the server is back. Trying again every few seconds.</div>` : null}
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
