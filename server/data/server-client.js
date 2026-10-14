// The Terminal's internal server client: one integration layer, three interfaces, one gateway.
//
//   client.market.*      market, reference, historical and company data   (Shaffer MarketData, via the gateway)
//   client.analytics.*   analytics, valuations, Strategies, Hedge          (Shaffer Analytics Lab, via the gateway)
//   client.ledger.*      the Terminal's own paper ledger                  (local; never remote; attached by app.js)
//
// Every method resolves to the response Envelope of docs/SERVER-CLIENT.md. This file owns the request plumbing:
//   - one gateway transport with the server-side credential, a timeout and the caller's AbortSignal through to fetch
//   - bounded retries with exponential backoff; 401 and 403 are never retried and block the dataset until the
//     credentials are tested again (the state says so)
//   - a per-operation cache with a TTL per dataset and explicit invalidation
//   - pagination: cursor or page, behind one async iterator
//   - refresh settings per dataset (interval / on-demand) and a subscription hook that is a no-op until the
//     contract says what is supported
//   - selection tokens: a newer selection on a channel aborts the older request, and a late answer for the older
//     selection is discarded (returned as error code 'superseded', never cached, never shown)
//
// The client passes server fields through. It never computes a fair value, a gap, a score or a signal, and it never
// writes to the paper ledger: the ledger interface reads it, and the one write it offers (recording a corporate
// action the user chose to record) goes through core/corpactions.js under an idempotency key.

import { AWAITING_MESSAGE } from './observation.js';
import { SERVER_DATASETS } from './ports.js';
import { marketContract, serverCapabilities, serverOperations } from './shaffer-contract.js';

export const ENVELOPE_STATES = ['awaiting', 'loading', 'available', 'stale', 'unavailable', 'incomplete', 'error'];

export const SOURCES = {
  market: { kind: 'shaffer-marketdata', label: 'Shaffer MarketData', fixture: false },
  analytics: { kind: 'shaffer-analytics', label: 'Shaffer Analytics Lab', fixture: false },
  ledger: { kind: 'terminal-ledger', label: 'Terminal paper ledger', fixture: false },
  demoFixture: { kind: 'demo-fixture', label: 'Demo fixture', fixture: true },
  testFixture: { kind: 'test-fixture', label: 'Test fixture', fixture: true },
  demoFeed: { kind: 'simulated-demo-feed', label: 'Simulated demo feed', fixture: true },
};

export const DEFAULT_RETRY = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 4000 };

export class GatewayError extends Error {
  constructor(message, { status = null, code = null, retryable = null } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    if (code) this.code = code;
    if (retryable !== null) this.retryable = retryable;
  }
}

/** Classify a failure: { code, status, retryable }. 401/403 are never retryable. */
export function classify(err) {
  const status = Number(err?.status) || null;
  if (err?.code === 'superseded') return { code: 'superseded', status: null, retryable: false };
  if (err?.name === 'AbortError' || err?.code === 'cancelled' || err?.code === 'ABORT_ERR') return { code: 'cancelled', status: null, retryable: false };
  if (err?.name === 'TimeoutError' || err?.code === 'timeout') return { code: 'timeout', status: null, retryable: true };
  if (status === 401) return { code: 'unauthorized', status, retryable: false };
  if (status === 403) return { code: 'forbidden', status, retryable: false };
  if (status === 404) return { code: 'not-found', status, retryable: false };
  if (status && [408, 425, 429].includes(status)) return { code: 'throttled', status, retryable: true };
  if (status && status >= 500) return { code: 'server-error', status, retryable: true };
  if (status && status >= 400) return { code: 'bad-request', status, retryable: false };
  if (err?.code && typeof err.retryable === 'boolean') return { code: err.code, status, retryable: err.retryable };
  return { code: 'network', status, retryable: true };
}

/** Deterministic key for cache entries. */
export function stableKey(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
}

const realSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : abortError()); return; }
  const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(signal.reason instanceof Error ? signal.reason : abortError()); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});
function abortError(code = 'cancelled') {
  const e = new Error(code === 'superseded' ? 'A newer selection replaced this request.' : 'Request cancelled.');
  e.name = 'AbortError';
  e.code = code;
  return e;
}

// ---- gateway transport -------------------------------------------------------------------------------------------

/**
 * HTTP helper bound to the ONE configured gateway address and the server-side credential. Contract operations
 * receive it as `http`. The caller's signal is combined with the timeout and passed to fetch.
 */
export function createGatewayHttp({ getAddress, credentials, timeoutMs, fetchImpl = (...a) => fetch(...a), health = {} }) {
  async function send(method, path, { query, body, signal, raw = false } = {}) {
    const base = getAddress();
    if (!base) throw new GatewayError('No gateway address is configured.', { code: 'no-address', retryable: false });
    const url = new URL(String(path).replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Accept: raw ? '*/*' : 'application/json' };
    if (credentials?.token) headers[credentials.header || 'Authorization'] = credentials.token; // never sent to the browser
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const signals = [AbortSignal.timeout(timeoutMs())];
    if (signal) signals.push(signal);
    health.lastChecked = new Date().toISOString();
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals) });
    } catch (err) {
      health.lastError = String(err?.message || err);
      throw err;
    }
    if (!res.ok) {
      health.lastError = `HTTP ${res.status}`;
      throw new GatewayError(`HTTP ${res.status} from the gateway`, { status: res.status });
    }
    health.lastSuccess = health.lastChecked;
    health.lastError = null;
    if (raw) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    get: (path, opts) => send('GET', path, opts),
    post: (path, body, opts) => send('POST', path, { ...opts, body }),
    raw: (path, opts) => send('GET', path, { ...opts, raw: true }),
  };
}

// ---- selection tokens --------------------------------------------------------------------------------------------

/**
 * One current selection per channel (a screen area such as the instrument drawer). Starting a request for a
 * different selection aborts every in-flight request of the previous one; their answers are discarded.
 */
export function createSelectionTracker() {
  const channels = new Map(); // channel -> { selection, controllers: Set }
  return {
    begin(channel, selection) {
      const ch = channel || 'default';
      let cur = channels.get(ch);
      if (!cur || cur.selection !== selection) {
        if (cur) for (const c of cur.controllers) c.abort(abortError('superseded'));
        cur = { selection, controllers: new Set() };
        channels.set(ch, cur);
      }
      const controller = new AbortController();
      cur.controllers.add(controller);
      const entry = cur;
      return {
        signal: controller.signal,
        current: () => channels.get(ch) === entry,
        done: () => entry.controllers.delete(controller),
      };
    },
    current: (channel) => channels.get(channel || 'default')?.selection ?? null,
  };
}

// ---- pagination --------------------------------------------------------------------------------------------------

/**
 * One iterator over both pagination shapes: `nextCursor` (cursor) or `page` + `totalPages` (page). Stops when the
 * server gives no next cursor / no further page, or after maxPages (a bound, reported by the caller).
 */
export async function* paginate(fetchPage, { maxPages = 50, pageSize } = {}) {
  let cursor = null;
  let page = 1;
  for (let n = 0; n < maxPages; n++) {
    const res = await fetchPage({ cursor, page, pageSize });
    yield res;
    if (res?.nextCursor) cursor = res.nextCursor;
    else if (res?.totalPages && (res.page ?? page) < res.totalPages) page = (res.page ?? page) + 1;
    else return;
  }
}

// ---- helpers -----------------------------------------------------------------------------------------------------

const get = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);

/** Required top-level fields (no `[]` paths) absent from a single-object payload. */
function missingRequired(def, data) {
  if (!data || def.shape !== 'data') return [];
  return def.requires.filter((p) => !p.includes('[]')).filter((p) => { const v = get(data, p); return v === null || v === undefined; });
}

// ---- the client --------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.clock               Terminal clock (ms(), now())
 * @param {boolean} o.demo               demo mode: datasets are answered by the labelled fixtures
 * @param {Function} o.getConnection     { gatewayUrl, marketDataUrl, analyticsUrl, requestTimeoutMs }
 * @param {object} o.credentials         { header, token } (server-side only)
 * @param {Function} o.getSetting / o.setSetting   settings store (refresh and retry settings)
 * @param {Function} [o.fetchImpl]       fetch (tests inject one)
 * @param {Function} [o.sleep]           backoff sleep (tests inject one)
 */
export function createServerClient({ clock, demo = false, getConnection, credentials = {}, getSetting = () => null, setSetting = () => {}, fetchImpl, sleep = realSleep, contract = serverOperations, legacy = marketContract, capabilities = serverCapabilities }) {
  const health = { market: {}, analytics: {} };
  const addressOf = (iface) => {
    const c = getConnection();
    return c.gatewayUrl || (iface === 'analytics' ? c.analyticsUrl : c.marketDataUrl) || '';
  };
  const http = {
    market: createGatewayHttp({ getAddress: () => addressOf('market'), credentials, timeoutMs: () => getConnection().requestTimeoutMs || 8000, fetchImpl, health: health.market }),
    analytics: createGatewayHttp({ getAddress: () => addressOf('analytics'), credentials, timeoutMs: () => getConnection().requestTimeoutMs || 8000, fetchImpl, health: health.analytics }),
  };
  const ctx = { now: () => clock.now().toISOString(), extId: (inst) => inst?.external_ids?.shaffer ?? null };
  const tracker = createSelectionTracker();
  const cache = new Map(); // key -> { env, storedMs, ttlMs, dataset, instrumentId }
  const stats = {}; // dataset -> { lastSuccess, lastError, lastState, requests, retries }
  const authBlocked = new Map(); // dataset -> { status, code, at, message }
  const overrides = new Map(); // dataset -> provider (tests; labelled test-fixture)
  let fixtures = null; // demo fixture provider set (attached by app.js in demo mode)
  let ledgerProvider = null; // local ledger interface (attached by app.js)
  const watched = new Map(); // key -> { dataset, params, lastMs }
  const inflight = new Map(); // cache key -> promise of the envelope
  let seq = 0;

  // ---- settings: refresh per dataset and retry ----
  function refreshSettings() {
    const saved = getSetting('server.refresh', {}) || {};
    const out = {};
    for (const [k, d] of Object.entries(SERVER_DATASETS)) {
      out[k] = { ...d.freshness, ...(saved[k] || {}), subscription: subscriptionSupport(k) };
    }
    return out;
  }
  function saveRefresh(patch = {}) {
    const saved = { ...(getSetting('server.refresh', {}) || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (!SERVER_DATASETS[k]) throw Object.assign(new Error(`Unknown dataset "${k}".`), { status: 400 });
      const cur = { ...(saved[k] || {}) };
      for (const f of ['intervalSec', 'ttlSec', 'staleAfterSec']) {
        if (v[f] === undefined) continue;
        const n = v[f] === null ? null : Number(v[f]);
        if (n !== null && !(n >= 0 && Number.isFinite(n))) throw Object.assign(new Error(`${k}.${f} must be a number of seconds (0 or more), or null.`), { status: 400 });
        if (f === 'intervalSec' && n !== null && n > 0 && n < 1) throw Object.assign(new Error(`${k}.intervalSec must be at least 1 second.`), { status: 400 });
        cur[f] = n;
      }
      if (v.mode !== undefined) {
        if (!['interval', 'on-demand'].includes(v.mode)) throw Object.assign(new Error(`${k}.mode must be "interval" or "on-demand" (subscriptions: ${subscriptionSupport(k).note}).`), { status: 400 });
        cur.mode = v.mode;
      }
      saved[k] = cur;
    }
    setSetting('server.refresh', saved);
    for (const k of Object.keys(patch)) invalidate({ dataset: k }); // a changed TTL applies from now
    return refreshSettings();
  }
  const retrySettings = () => ({ ...DEFAULT_RETRY, ...(getSetting('server.retry', {}) || {}) });

  function subscriptionSupport(dataset) {
    const fn = capabilities.subscriptions?.[dataset];
    return typeof fn === 'function' ? { supported: true, note: 'Supported by the contract' } : { supported: false, note: 'Not supported by the contract' };
  }

  // ---- providers ----
  function legacyProvider(ds, def) {
    const L = legacy || {};
    const op = L[def.method];
    if (typeof op !== 'function') return null;
    const src = SOURCES.market;
    const lctx = (c) => ({ http: http.market, ctx });
    switch (ds) {
      case 'search': return { source: src, run: async (c, p) => ({ items: await op(lctx(c), p.q, { limit: p.limit, marketView: p.marketView }) }) };
      case 'reference': return { source: src, run: async (c, p) => ({ data: await op(lctx(c), p.serverId) }) };
      case 'quotes': return { source: src, run: async (c, p) => { const m = await op(lctx(c), p.instruments); return { items: p.instruments.map((i) => ({ instrumentId: i.id, observation: m.get(i.id) ?? null })) }; } };
      case 'history': return { source: src, run: async (c, p) => ({ items: await op(lctx(c), p.instrument, { from: p.from, to: p.to, interval: p.interval }) }) };
      case 'fx': return { source: src, run: async (c, p) => { const m = await op(lctx(c), p.pairs); return { items: p.pairs.map((pair) => ({ pair, observation: m.get(pair) ?? null })) }; } };
      case 'rates': return { source: src, run: async (c, p) => { const m = await op(lctx(c), p.codes, { from: p.from, to: p.to }); return { items: p.codes.flatMap((code) => (m.get(code) || []).map((o) => ({ code, date: o.forDate, value: o.value, units: o.units }))) }; } };
      case 'corporateActions': return { source: src, run: async (c, p) => ({ items: await op(lctx(c), [p.instrument], { from: p.from, to: p.to }) }) };
      default: return null;
    }
  }

  function providerFor(ds) {
    const def = SERVER_DATASETS[ds];
    if (overrides.has(ds)) return overrides.get(ds);
    if (def.interface === 'ledger') return ledgerProvider;
    if (demo) return fixtures ? fixtures.provider(ds) : null;
    if (!addressOf(def.interface)) return null;
    const op = contract?.[def.interface]?.[def.method];
    if (typeof op === 'function') return { source: SOURCES[def.interface], run: (c, p) => op({ ...c, http: http[def.interface], ctx }, p) };
    return def.interface === 'market' ? legacyProvider(ds, def) : null;
  }

  function pointInTimeSupported(ds) {
    if (overrides.has(ds)) return overrides.get(ds).pointInTime ?? false;
    if (demo) return fixtures?.pointInTime?.(ds) ?? false;
    return capabilities.pointInTime?.[ds] === true;
  }

  // ---- envelope ----
  function base(ds, { requestId, selection, asOf }) {
    const def = SERVER_DATASETS[ds];
    return {
      state: 'awaiting', dataset: ds, operation: def.operation, interface: def.interface, source: null,
      asOf: null, receivedAt: null, freshness: { ageSec: null, staleAfterSec: refreshSettings()[ds].staleAfterSec ?? null },
      version: null, schema: null, coverage: { from: null, to: null, missing: [] }, missingFields: [], nulls: {},
      error: null, requestId, selection: selection ?? null, pagination: null,
      pointInTime: { requested: asOf || null, supported: asOf ? pointInTimeSupported(ds) : null, note: null },
      cached: false, message: null,
    };
  }

  function awaitingEnvelope(ds, opts) {
    const env = base(ds, opts);
    const def = SERVER_DATASETS[ds];
    const why = demo ? 'no demo fixture for this dataset' : !addressOf(def.interface) ? 'no gateway address configured' : 'not yet mapped in shaffer-contract.js';
    env.message = `${AWAITING_MESSAGE} (${def.operation}: ${why})`;
    return env;
  }

  function finish(env, ds, result, source, receivedMs) {
    const def = SERVER_DATASETS[ds];
    env.source = result?.source || source || null;
    env.receivedAt = new Date(receivedMs).toISOString();
    env.asOf = result?.asOf ?? null;
    env.version = result?.version ?? capabilities.versions?.api ?? null;
    env.schema = result?.schema ?? capabilities.versions?.schema ?? null;
    if (result?.coverage) env.coverage = { from: result.coverage.from ?? null, to: result.coverage.to ?? null, missing: [...(result.coverage.missing || [])] };
    if (result?.nulls) env.nulls = { ...result.nulls };
    if (result?.related) env.related = result.related;
    if (result?.pointInTime) env.pointInTime = { ...env.pointInTime, ...result.pointInTime };
    if (def.shape === 'items') env.items = Array.isArray(result?.items) ? result.items : [];
    if (result?.data !== undefined || def.shape === 'data') env.data = result?.data ?? null;
    if (result && ['nextCursor', 'cursor', 'page', 'totalPages'].some((k) => result[k] !== undefined)) {
      env.pagination = {
        mode: result.nextCursor !== undefined || result.cursor !== undefined ? 'cursor' : 'page',
        cursor: result.cursor ?? null, nextCursor: result.nextCursor ?? null,
        page: result.page ?? null, pageSize: result.pageSize ?? null, totalPages: result.totalPages ?? null, totalItems: result.totalItems ?? null,
      };
    }
    const empty = def.shape === 'items' ? env.items.length === 0 : env.data === null || env.data === undefined;
    const missing = [...new Set([...(result?.missingFields || []), ...missingRequired(def, env.data)])];
    env.missingFields = missing;
    for (const m of missing) if (!env.coverage.missing.includes(m)) env.coverage.missing.push(m);
    applyFreshness(env, receivedMs);
    if (empty) {
      env.state = 'unavailable';
      env.message = result?.message || 'The server has no data for this request.';
    } else if (!env.pointInTime.requested && env.freshness.ageSec !== null && env.freshness.staleAfterSec !== null && env.freshness.ageSec > env.freshness.staleAfterSec) {
      // (A point-in-time answer is dated by design: it is not "stale" against today's clock.)
      env.state = 'stale';
      env.message = `Data is ${fmtAge(env.freshness.ageSec)} old (stale after ${fmtAge(env.freshness.staleAfterSec)}).`;
    } else if (missing.length) {
      env.state = 'incomplete';
      env.message = `Incomplete: missing ${missing.join(', ')}.`;
    } else {
      env.state = 'available';
      env.message = result?.message || null;
    }
    return env;
  }

  function applyFreshness(env, nowMs) {
    const t = env.asOf ? Date.parse(env.asOf) : NaN;
    env.freshness = { ...env.freshness, ageSec: Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null };
  }

  function errorEnvelope(env, ds, err, attempts) {
    const cls = classify(err);
    env.state = 'error';
    env.error = { code: cls.code, status: cls.status, message: errorMessage(cls, err), retryable: cls.retryable, attempts };
    env.message = env.error.message;
    if (env.source === null) env.source = providerFor(ds)?.source ?? null;
    return env;
  }

  function errorMessage(cls, err) {
    switch (cls.code) {
      case 'unauthorized': return 'The gateway refused the credential (HTTP 401). Not retried. Check SHAFFER_API_TOKEN on the server, then test the connection again.';
      case 'forbidden': return 'The gateway refused access to this dataset (HTTP 403). Not retried. Check the credential\'s permissions, then test the connection again.';
      case 'superseded': return 'A newer instrument selection replaced this request. Discard this response.';
      case 'cancelled': return 'The request was cancelled.';
      case 'timeout': return 'The gateway did not answer in time.';
      case 'not-found': return 'The server has no record for this subject (HTTP 404).';
      default: return String(err?.message || err || 'Request failed.');
    }
  }

  // ---- the call ----
  /**
   * Run one dataset request and return its envelope.
   * @param {string} ds        dataset key (SERVER_DATASETS)
   * @param {object} params    dataset inputs (instrument objects resolved by the caller)
   * @param {object} opts      { requestId, selection, channel, asOf, fresh, signal, cursor, page, pageSize, cacheKey, instrumentId }
   */
  async function call(ds, params = {}, opts = {}) {
    const def = SERVER_DATASETS[ds];
    if (!def) throw Object.assign(new Error(`Unknown dataset "${ds}".`), { status: 404 });
    const requestId = opts.requestId || `srv-${Date.now().toString(36)}-${(++seq).toString(36)}`;
    const o = { requestId, selection: opts.selection, asOf: opts.asOf };
    const st = (stats[ds] ||= { lastSuccess: null, lastError: null, lastState: null, requests: 0, retries: 0 });
    st.requests++;
    const done = (env) => { st.lastState = env.state; if (env.state === 'error') st.lastError = { at: clock.now().toISOString(), code: env.error.code, message: env.error.message }; else if (env.state !== 'awaiting') st.lastSuccess = clock.now().toISOString(); return env; };

    const provider = providerFor(ds);
    if (!provider) return done(awaitingEnvelope(ds, o));
    if (opts.asOf && !pointInTimeSupported(ds)) {
      const env = base(ds, o);
      env.source = provider.source;
      env.state = 'unavailable';
      env.pointInTime = { requested: opts.asOf, supported: false, note: 'Not supported by the contract' };
      env.message = `An "as of" view is not supported by the contract for ${def.label.toLowerCase()}. Current data is not substituted.`;
      return done(env);
    }
    const subject = opts.instrumentId || params.instrument?.id || null;
    const blocked = blockOf(ds, subject);
    if (blocked) {
      const env = base(ds, o);
      env.source = provider.source;
      env.state = 'error';
      env.error = { code: blocked.code, status: blocked.status, message: `${blocked.message} (blocked since ${blocked.at}; not retried)`, retryable: false, attempts: 0 };
      env.message = env.error.message;
      return done(env);
    }

    const key = opts.cacheKey || `${ds}|${stableKey({ ...params, instruments: undefined, instrument: undefined, _ids: params.instruments?.map((i) => i.id), _id: params.instrument?.id, asOf: opts.asOf || null, cursor: opts.cursor || null, page: opts.page || null, pageSize: opts.pageSize || null })}`;
    const ttlSec = refreshSettings()[ds].ttlSec ?? 0;
    const hit = cache.get(key);
    if (hit && !opts.fresh && clock.ms() - hit.storedMs < hit.ttlMs) {
      const env = structuredClone(hit.env);
      env.requestId = requestId;
      env.selection = opts.selection ?? null;
      env.cached = true;
      applyFreshness(env, clock.ms());
      if (env.state === 'available' && !env.pointInTime.requested && env.freshness.ageSec !== null && env.freshness.staleAfterSec !== null && env.freshness.ageSec > env.freshness.staleAfterSec) env.state = 'stale';
      return done(env);
    }

    // Concurrent identical requests (no selection) share one gateway call.
    const shareable = !opts.selection && !opts.signal;
    if (shareable && inflight.has(key)) {
      const env = structuredClone(await inflight.get(key));
      env.requestId = requestId;
      return env;
    }
    const exec = async () => {
      const sel = opts.selection ? tracker.begin(opts.channel, opts.selection) : null;
      const signals = [sel?.signal, opts.signal].filter(Boolean);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const env = base(ds, o);
      const retry = retrySettings();
      let attempts = 0;
      try {
        let result;
        for (;;) {
          attempts++;
          try {
            result = await provider.run({ signal, cursor: opts.cursor || null, page: opts.page || null, pageSize: opts.pageSize || null, asOf: opts.asOf || null }, params);
            break;
          } catch (err) {
            const cls = classify(signal?.aborted ? (signal.reason || err) : err);
            if (cls.code === 'unauthorized' || cls.code === 'forbidden') block(ds, subject, cls);
            if (!cls.retryable || attempts > retry.maxRetries || signal?.aborted) throw signal?.aborted ? (signal.reason || err) : err;
            st.retries++;
            await sleep(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempts - 1)), signal);
          }
        }
        // A late answer for a selection that is no longer current is discarded, whatever the provider did with the signal.
        if (sel && !sel.current()) return done(errorEnvelope(env, ds, abortError('superseded'), attempts));
        finish(env, ds, result, provider.source, clock.ms());
        env.attempts = attempts;
        if (ttlSec > 0 && def.shape !== 'stream') cache.set(key, { env: structuredClone(env), storedMs: clock.ms(), ttlMs: ttlSec * 1000, dataset: ds, instrumentId: opts.instrumentId || params.instrument?.id || null });
        return done(env);
      } catch (err) {
        if (sel && !sel.current()) return done(errorEnvelope(env, ds, abortError('superseded'), attempts));
        const cls = classify(err);
        // A cached copy outlives a failed refresh: shown as stale, with the error, never as current.
        if (hit && cls.code !== 'cancelled' && cls.code !== 'unauthorized' && cls.code !== 'forbidden') {
          const old = structuredClone(hit.env);
          old.requestId = requestId;
          old.selection = opts.selection ?? null;
          old.cached = true;
          applyFreshness(old, clock.ms());
          old.state = 'stale';
          old.error = { code: cls.code, status: cls.status, message: errorMessage(cls, err), retryable: cls.retryable, attempts };
          old.message = `Showing the last copy received; the refresh failed: ${old.error.message}`;
          return done(old);
        }
        return done(errorEnvelope(env, ds, err, attempts));
      } finally {
        sel?.done();
      }
    };
    const pending = exec();
    if (shareable) { inflight.set(key, pending); pending.finally(() => inflight.delete(key)); }
    if (opts.waitMs > 0) {
      // Answer "loading" when the server has not answered within waitMs; the request carries on and its answer is
      // cached (or joined) for the next identical request.
      const LOADING = Symbol('loading');
      const first = await Promise.race([pending, realSleep(opts.waitMs).then(() => LOADING)]);
      if (first === LOADING) {
        const env = base(ds, o);
        env.state = 'loading';
        env.source = provider.source;
        env.message = 'Loading: the server has not answered yet. Ask again with the same parameters for the answer.';
        return env;
      }
      return first;
    }
    return pending;
  }

  /** Every page of a paginated dataset, as one envelope (bounded by maxPages; a truncated result says so). */
  async function collect(ds, params, opts = {}) {
    const maxPages = opts.maxPages || 20;
    const items = [];
    let last = null;
    let pages = 0;
    for await (const env of paginateSafe(ds, params, opts, maxPages)) {
      last = env;
      pages++;
      items.push(...(env.items || []));
    }
    if (!last) return call(ds, params, opts);
    if (last.state === 'error' || last.state === 'awaiting') return last;
    const out = { ...last, items, cached: false };
    out.pagination = { ...(last.pagination || {}), mode: last.pagination?.mode || null, pagesRead: pages, totalItems: last.pagination?.totalItems ?? items.length, truncated: Boolean(last.pagination?.nextCursor || (last.pagination?.totalPages && last.pagination.page < last.pagination.totalPages)) };
    if (out.state === 'unavailable' && items.length) out.state = 'available';
    return out;
  }

  // The paginate() generator throws on an error page; this wrapper yields the error envelope instead so collect() can return it.
  async function* paginateSafe(ds, params, opts, maxPages) {
    let cursor = null;
    let page = 1;
    for (let n = 0; n < maxPages; n++) {
      const e = await call(ds, params, { ...opts, cursor, page: cursor ? null : page });
      yield e;
      if (e.state === 'error' || e.state === 'awaiting') return;
      if (e.pagination?.nextCursor) cursor = e.pagination.nextCursor;
      else if (e.pagination?.totalPages && (e.pagination.page ?? page) < e.pagination.totalPages) page = (e.pagination.page ?? page) + 1;
      else return;
    }
  }

  function invalidate({ dataset, instrumentId } = {}) {
    let n = 0;
    for (const [k, v] of cache) {
      if (dataset && v.dataset !== dataset) continue;
      if (instrumentId && v.instrumentId !== instrumentId) continue;
      cache.delete(k);
      n++;
    }
    return n;
  }

  // 401 (the credential itself is refused) blocks every dataset of the interface; 403 (no permission) blocks the
  // dataset for that subject (or the whole dataset when the request has no subject). Neither is retried.
  function block(ds, subject, cls) {
    const iface = SERVER_DATASETS[ds].interface;
    const key = cls.code === 'unauthorized' ? `${iface}|*` : `${ds}|${subject || '*'}`;
    authBlocked.set(key, { status: cls.status, code: cls.code, at: clock.now().toISOString(), message: errorMessage(cls), scope: cls.code === 'unauthorized' ? `all ${iface} datasets` : subject ? `${ds} for ${subject}` : ds });
  }
  function blockOf(ds, subject) {
    const iface = SERVER_DATASETS[ds].interface;
    return authBlocked.get(`${iface}|*`) || authBlocked.get(`${ds}|*`) || (subject ? authBlocked.get(`${ds}|${subject}`) : null) || null;
  }
  const blocksOf = (ds) => [...authBlocked.entries()].filter(([k]) => k.startsWith(`${ds}|`) || k === `${SERVER_DATASETS[ds].interface}|*`).map(([, v]) => v);

  /** Clears 401/403 blocks: called when the connection is tested or changed (and by fixture resets in demo). */
  function clearAuthBlocks(dataset) {
    if (!dataset) { authBlocked.clear(); return; }
    for (const k of [...authBlocked.keys()]) if (k.startsWith(`${dataset}|`)) authBlocked.delete(k);
  }

  /** Subscription hook: a no-op until the contract says which datasets support push updates. */
  function subscribe(ds, params, onData, onError) {
    const support = subscriptionSupport(ds);
    const fn = capabilities.subscriptions?.[ds];
    if (!support.supported || demo) return { ...support, supported: support.supported && !demo, unsubscribe: () => {} };
    const off = fn({ ctx, http: http[SERVER_DATASETS[ds].interface], params, onData, onError });
    return { ...support, unsubscribe: typeof off === 'function' ? off : () => {} };
  }

  /** Datasets refreshed on an interval: register a subject; tick() refreshes those that are due (fresh fetch). */
  function watch(ds, params, opts = {}) {
    const key = `${ds}|${opts.instrumentId || stableKey(params)}`;
    watched.set(key, { ds, params, opts, lastMs: clock.ms() });
    if (watched.size > 500) watched.delete(watched.keys().next().value);
    return key;
  }
  async function tick() {
    const cfg = refreshSettings();
    const now = clock.ms();
    const due = [...watched.values()].filter((w) => cfg[w.ds].mode === 'interval' && cfg[w.ds].intervalSec > 0 && now - w.lastMs >= cfg[w.ds].intervalSec * 1000);
    for (const w of due) {
      w.lastMs = now;
      await call(w.ds, w.params, { ...w.opts, fresh: true, selection: undefined });
    }
    return due.length;
  }

  function datasetState(ds) {
    const def = SERVER_DATASETS[ds];
    const provider = providerFor(ds);
    const st = stats[ds] || {};
    const blocks = blocksOf(ds);
    const blocked = blocks[0] || null;
    const mapped = def.interface === 'ledger' ? true : demo ? Boolean(provider) : typeof contract?.[def.interface]?.[def.method] === 'function' || Boolean(def.interface === 'market' && legacyProvider(ds, def));
    const state = !provider ? 'awaiting' : blocked && blocked.scope !== undefined && !blocked.scope.includes(' for ') ? 'error' : st.lastState || (def.interface === 'ledger' ? 'available' : 'not-requested');
    return {
      label: def.label, interface: def.interface, operation: def.operation, mapped,
      addressConfigured: def.interface === 'ledger' ? null : Boolean(addressOf(def.interface)),
      state, source: provider?.source ?? null, lastSuccess: st.lastSuccess ?? null, lastError: st.lastError ?? null,
      requests: st.requests || 0, retries: st.retries || 0,
      authBlocked: blocked ? { ...blocked, count: blocks.length, retrying: false, note: 'Not retried: fix the credential or permission, then test the connection again.' } : null,
      refresh: refreshSettings()[ds], pointInTime: { supported: pointInTimeSupported(ds) }, pagination: demo ? fixtures?.pagination?.(ds) ?? null : capabilities.pagination?.[ds] ?? null,
      fixture: demo ? fixtures?.modeOf?.(ds) ?? null : null,
      message: !provider ? awaitingEnvelope(ds, {}).message : null,
    };
  }

  function state() {
    const datasets = {};
    for (const ds of Object.keys(SERVER_DATASETS)) datasets[ds] = datasetState(ds);
    const c = getConnection();
    return {
      mode: demo ? 'demo' : 'shaffer',
      gateway: { configured: Boolean(c.gatewayUrl || c.marketDataUrl || c.analyticsUrl), shared: Boolean(c.gatewayUrl), timeoutMs: c.requestTimeoutMs },
      health,
      retry: retrySettings(),
      versions: capabilities.versions,
      awaitingMessage: AWAITING_MESSAGE,
      datasets,
    };
  }

  const bind = (iface) => {
    const out = {};
    for (const [ds, def] of Object.entries(SERVER_DATASETS)) if (def.interface === iface) out[def.method] = (params, opts) => call(ds, params, opts);
    return out;
  };

  return {
    market: bind('market'),
    analytics: bind('analytics'),
    ledger: bind('ledger'),
    call, collect, invalidate, subscribe, watch, tick, state, datasetState,
    refreshSettings, saveRefresh, clearAuthBlocks,
    /** Raw document stream from the gateway (contract `market.document`), or from the demo fixtures. */
    async document(docId, opts = {}) {
      const ds = 'documents';
      const provider = providerFor(ds);
      if (!provider) return { envelope: awaitingEnvelope(ds, { requestId: opts.requestId }) };
      if (blockOf(ds, docId)) return { envelope: await call(ds, { docId }, { ...opts, instrumentId: docId }) };
      try {
        const doc = await provider.run({ signal: opts.signal }, { docId });
        if (!doc) return { envelope: finish(base(ds, { requestId: opts.requestId || 'doc' }), ds, { data: null }, provider.source, clock.ms()) };
        return { document: doc, source: provider.source };
      } catch (err) {
        const cls = classify(err);
        if (cls.code === 'unauthorized' || cls.code === 'forbidden') block(ds, docId, cls);
        return { envelope: errorEnvelope(base(ds, { requestId: opts.requestId || 'doc' }), ds, err, 1) };
      }
    },
    attach({ ledger, fixtures: f } = {}) { if (ledger) ledgerProvider = ledger; if (f !== undefined) fixtures = f; },
    get fixtures() { return fixtures; },
    /** Tests: answer a dataset with a stated provider ({ run, source?, pointInTime? }); labelled Test fixture. null removes it. */
    setProvider(ds, p) { if (p) overrides.set(ds, { source: SOURCES.testFixture, ...p }); else overrides.delete(ds); },
    tracker,
    _cache: cache,
  };
}

function fmtAge(sec) {
  if (sec < 120) return `${sec} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} days`;
}
