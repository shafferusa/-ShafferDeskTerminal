// Engine-level Terminal client: the real application modules, in this process.
//
// Like test/helpers.js, but on a file-backed database inside a sandbox (so a restart can be tested by
// closing the database and building the application again from the file) and with a frozen clock
// that only moves when a scenario says so. No HTTP: core modules are called directly. The few
// operations whose logic lives in an API route handler (lifecycle events recorded by hand) go
// through that same handler, called in-process.
//
// Every method returns plain JSON data, shaped exactly as the API returns it, so the same
// normalisation and comparison code serves the engine and API levels.

import { createApi } from '../../../server/api.js';
import { createApp } from '../../../server/app.js';
import { createClock } from '../../../server/core/clock.js';
import { createIntegrity } from '../../../server/core/integrity.js';
import { isZero } from '../../../server/core/util.js';
import { createFixtureControls } from '../../../server/data/demo.js';
import { assertSandbox } from '../lib/sandbox.mjs';

const plain = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v))));

export async function openEngineTerminal({ sandbox, at, demo = true }) {
  let app, clock, fixtures, integrity, api;
  let instant = at;

  function boot() {
    assertSandbox(sandbox);
    clock = createClock();
    clock.freeze(instant);
    const config = {
      demo, host: '127.0.0.1', port: 0, dataDir: sandbox.dir, dbFile: sandbox.dbFile, password: '',
      connectionEnv: {}, credentials: { header: 'Authorization', token: '', hasToken: false }, engine: { autoStart: false },
    };
    app = createApp({ config, clock });
    fixtures = createFixtureControls(app);
    fixtures.restore();
    integrity = createIntegrity(app);
    api = null;
  }
  boot();

  /** What the API does before an accounting read: current prices for everything held, current FX. */
  async function refreshBook(bookId) {
    const book = app.books.requireBook(bookId);
    const ids = book.units.map((u) => u.id);
    const held = new Map();
    for (const p of app.positions.list({ unitIds: ids })) {
      if (isZero(p.qty)) continue;
      const i = app.instruments.get(p.instrument_id);
      held.set(i.id, i);
      if (i.underlying_id) { const u = app.instruments.get(i.underlying_id); if (u) held.set(u.id, u); }
    }
    const insts = [...held.values()];
    const pairs = app.ledger.currencies(ids).filter((c) => c !== book.reporting_ccy).map((c) => `${c}/${book.reporting_ccy}`);
    await app.data.refresh({ instruments: insts, sessions: insts, valuations: insts.filter((i) => ['swap', 'cds', 'forward', 'otcoption', 'bond'].includes(i.family)), pairs });
  }

  /** Call an API route handler in-process (for logic that lives in the handler itself). */
  async function route(method, path, body = {}, query = {}) {
    api ||= createApi(app);
    const m = api.match(method, path);
    if (!m || m.methodNotAllowed) throw new Error(`No route ${method} ${path}`);
    return plain(await m.handler({ params: m.params, query, body }));
  }

  const bookView = (b) => ({ id: b.id, name: b.name, reportingCcy: b.reporting_ccy, settings: b.settings, units: b.units.map((u) => ({ id: u.id, name: u.name, kind: u.kind })) });

  return {
    level: 'engine',
    // For the system suite (test/system): the application itself (to read stored rows), and any API route handler
    // called in-process with the same method names as the API client's `http`.
    get app() { return app; },
    http: { get: (path, query) => route('GET', path, {}, query || {}), post: (path, body = {}) => route('POST', path, body), put: (path, body = {}) => route('PUT', path, body), del: (path) => route('DELETE', path) },
    describe: () => ({ level: 'engine', database: sandbox.dbFile, clock: 'frozen, moved only by the scenario', engine: 'explicit cycles (app.engine.tick)' }),
    status: async () => ({ demo: app.config.demo, now: app.clock.now().toISOString(), today: app.clock.today() }),
    createBook: async (body) => bookView(app.books.createBook(body)),
    getBook: async (id) => bookView(app.books.requireBook(id)),
    listBooks: async () => app.books.listBooks().map(bookView),
    createAccount: async (bookId, body) => plain(app.books.createAccount(bookId, body)),
    capital: async (bookId, body) => plain(app.books.capital({ ...body, bookId })),
    transfer: async (bookId, body) => plain(app.books.transfer({ ...body, bookId })),
    updateSettings: async (bookId, settings) => bookView(app.books.updateSettings(bookId, settings)),
    createInstrument: async (draft) => plain(app.instruments.toView(app.instruments.create(draft))),
    getInstrument: async (id) => plain(app.instruments.toView(app.instruments.require(id))),
    fixture: async (kind, body) => plain(await fixtures.apply(kind, body)),
    fixtures: async () => plain(fixtures.list()),
    async setClock(iso) {
      instant = new Date(iso).toISOString();
      clock.freeze(instant);
      return plain(await app.engine.tick());
    },
    tick: async () => plain(await app.engine.tick()),
    preview: async (input) => plain(await app.packages.preview(input)),
    submit: async (body) => plain(await app.packages.submit(body)),
    previewAction: async (strategyId, action, args) => plain(await app.packages.previewAction(strategyId, action, args)),
    strategy: async (id) => plain(app.packages.strategyView(id)),
    positionLifecycle: (positionId, body) => route('POST', `/api/positions/${positionId}/lifecycle`, body),
    instrumentLifecycle: (instrumentId, body) => route('POST', `/api/instruments/${instrumentId}/lifecycle`, body),
    corporateAction: async (body) => plain(app.corpactions.record(body)),
    manualPrice: async (body) => plain(app.data.present(app.data.enterManual(body))),
    adjustment: async (bookId, body) => plain(app.accounting.manualAdjustment({ ...body, bookId })),
    async accounting(bookId, tab, query = {}) {
      await refreshBook(bookId);
      const scope = query.scope || 'book';
      const a = app.accounting;
      switch (tab) {
        case 'pnl': return plain(a.pnl(bookId, scope, { from: query.from, to: query.to }));
        case 'positions': return plain(a.openPositions(bookId, scope));
        case 'balance': return plain(a.balanceSheet(bookId, scope));
        case 'borrowings': return plain({ scope, items: a.borrowings(bookId, scope) });
        case 'pending': return plain(a.pending(bookId, scope));
        case 'failed': return plain(a.failed(bookId, scope));
        case 'history': return plain(a.history(bookId, scope, { limit: query.limit, includeAccruals: query.accruals === '1', before: query.before }));
        default: throw new Error(`Unknown accounting tab ${tab}`);
      }
    },
    overview: async (bookId) => { await refreshBook(bookId); return plain(app.accounting.overview(bookId)); },
    hedgeRequests: async (bookId) => plain(app.hedge.list(bookId)),
    integrity: async (bookId) => { await refreshBook(bookId); return plain(integrity.check(bookId)); },
    /** Close the database and build the application again from the file, at the same instant. */
    async restart() {
      app.db.close();
      boot();
    },
    async close() {
      try { app.db.close(); } catch { /* already closed */ }
    },
  };
}
