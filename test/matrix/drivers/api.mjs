// API-level Terminal client: HTTP against a disposable server process.
//
// The same method set as drivers/engine.mjs, each one a real API route. A restart stops the
// server process and starts a new one on the same sandbox database. The demo clock is a fixture:
// after a restart the client sets it again to where the scenario left it, before anything else runs.

import { startServer } from '../lib/server.mjs';

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}

export function httpClient(baseUrl) {
  return async function call(method, path, body, query) {
    let url = `${baseUrl}${path}`;
    if (query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
      if ([...q].length) url += `?${q}`;
    }
    const res = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(data?.error || `${method} ${path} failed (${res.status})`, { status: res.status, code: data?.code, details: data?.details });
    return data;
  };
}

export async function openApiTerminal({ sandbox, at, demo = true, engine = 'off', dbByMode = false }) {
  let server = await startServer(sandbox, { demo, engine, dbByMode });
  let call = httpClient(server.url);
  let instant = at;
  const get = (path, query) => call('GET', path, undefined, query);
  const post = (path, body = {}) => call('POST', path, body);
  const put = (path, body = {}) => call('PUT', path, body);
  // Nothing has run yet (the engine timer is off): put the clock at the scenario's start.
  if (demo && at) await post('/api/demo/advance', { to: at });

  return {
    level: 'api',
    get url() { return server.url; },
    describe: () => ({ level: 'api', url: server.url, pid: server.pid, database: server.database, clock: 'demo clock, set by the scenario', engine: 'timer off; explicit cycles (POST /api/engine/tick)' }),
    http: { get, post, put, del: (path) => call('DELETE', path) },
    // For the system suite (test/system): the server process (pid, logs), and an interrupted run: kill() ends the
    // process at once; start() brings a new one up on the same database and port without touching the clock.
    get server() { return server; },
    kill: () => server.kill(),
    async start({ setClock = false } = {}) {
      server = await startServer(sandbox, { demo, engine, dbByMode, port: server.port });
      call = httpClient(server.url);
      if (setClock && demo && instant) await call('POST', '/api/demo/advance', { to: instant });
    },
    status: () => get('/api/status'),
    createBook: (body) => post('/api/books', body),
    getBook: async (id) => (await get(`/api/books/${id}`)).book,
    listBooks: async () => (await get('/api/books')).items,
    createAccount: (bookId, body) => post(`/api/books/${bookId}/accounts`, body),
    capital: (bookId, body) => post(`/api/books/${bookId}/capital`, body),
    transfer: (bookId, body) => post(`/api/books/${bookId}/transfers`, body),
    updateSettings: (bookId, settings) => put(`/api/books/${bookId}`, { settings }),
    createInstrument: (draft) => post('/api/instruments', draft),
    getInstrument: (id) => get(`/api/instruments/${id}`),
    fixture: (kind, body) => post(`/api/demo/fixtures/${kind}`, body),
    fixtures: () => get('/api/demo/fixtures'),
    async setClock(iso) {
      instant = new Date(iso).toISOString();
      return (await post('/api/demo/advance', { to: instant })).summary;
    },
    tick: () => post('/api/engine/tick'),
    preview: (input) => post('/api/strategies/preview', input),
    submit: (body) => post('/api/strategies', body),
    previewAction: (strategyId, action, args) => post(`/api/strategies/${strategyId}/preview-action`, { action, ...args }),
    strategy: (id) => get(`/api/strategies/${id}`),
    positionLifecycle: (positionId, body) => post(`/api/positions/${positionId}/lifecycle`, body),
    instrumentLifecycle: (instrumentId, body) => post(`/api/instruments/${instrumentId}/lifecycle`, body),
    corporateAction: (body) => post('/api/corporate-actions', body),
    manualPrice: (body) => post('/api/observations', body),
    adjustment: (bookId, body) => post(`/api/books/${bookId}/adjustments`, body),
    accounting: (bookId, tab, query = {}) => get(`/api/books/${bookId}/accounting/${tab}`, query),
    overview: async (bookId) => (await get(`/api/books/${bookId}`)).overview,
    hedgeRequests: async (bookId) => (await get('/api/hedge/requests', { bookId })).items,
    hedgePrompts: async (bookId) => (await get('/api/hedge/prompts', { bookId })).items,
    integrity: (bookId) => get(`/api/books/${bookId}/integrity`),
    /** Stop the server process and start a new one on the same database. */
    async restart() {
      await server.stop();
      server = await startServer(sandbox, { demo, engine, dbByMode, port: server.port });
      call = httpClient(server.url);
      if (demo && instant) await call('POST', '/api/demo/advance', { to: instant });
    },
    async close() { await server.stop(); },
  };
}
