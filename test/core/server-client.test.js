import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeApp, makeBook, trade, advance } from '../helpers.js';
import { createApi } from '../../server/api.js';
import { ENVELOPE_STATES, createServerClient, paginate } from '../../server/data/server-client.js';
import { SERVER_DATASETS } from '../../server/data/ports.js';
import { createClock } from '../../server/core/clock.js';

// The server client (docs/SERVER-CLIENT.md). Providers set with setProvider() are labelled "Test fixture" and stand
// in for the Shaffer gateway only; the routes, the ledger and the corporate-action module are the real ones.

const START = '2026-03-02T15:00:00.000Z';
const fastRetries = (app) => app.data.setSetting('server.retry', { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });

/** A client on a stated fetch, with no real gateway: for transport-level tests. */
function bareClient({ fetchImpl, contract, demo = false, settings = {} } = {}) {
  const clock = createClock();
  clock.freeze(START);
  const store = new Map(Object.entries(settings));
  const slept = [];
  const client = createServerClient({
    clock, demo, fetchImpl, contract,
    getConnection: () => ({ gatewayUrl: 'https://gateway.example.invalid/api', marketDataUrl: '', analyticsUrl: '', requestTimeoutMs: 5000 }),
    credentials: { header: 'Authorization', token: 'secret-token' },
    getSetting: (k, d) => (store.has(k) ? store.get(k) : d), setSetting: (k, v) => store.set(k, v),
    sleep: async (ms) => { slept.push(ms); },
  });
  return { client, clock, slept, store };
}
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
const route = (api, method, path, { query = {}, body = {} } = {}) => {
  const m = api.match(method, path);
  assert.ok(m && !m.methodNotAllowed, `route ${method} ${path}`);
  return m.handler({ params: m.params, query, body, req: { headers: {} } });
};

// ---- envelope states --------------------------------------------------------------------------------------------

test('every envelope state is produced, with the fields the screens rely on', async () => {
  const { app, clock, inst } = makeApp();
  fastRetries(app);
  const S = app.data.server;
  const alfa = inst.ALFA;
  const seen = new Set();
  const check = (env, want) => {
    assert.equal(env.state, want, `${want}: ${env.message}`);
    for (const k of ['state', 'dataset', 'operation', 'interface', 'source', 'asOf', 'receivedAt', 'freshness', 'version', 'schema', 'coverage', 'missingFields', 'error', 'requestId', 'pointInTime']) assert.ok(k in env, `${want} envelope has ${k}`);
    assert.ok('ageSec' in env.freshness && 'staleAfterSec' in env.freshness);
    assert.ok(Array.isArray(env.coverage.missing));
    seen.add(env.state);
  };
  const now = clock.now().toISOString();
  S.setProvider('profile', { run: async () => ({ data: { issuer: { id: 'I1', name: 'X' }, listing: { exchange: 'E', currency: 'USD' } }, asOf: now }) });
  check(await S.call('profile', { instrument: alfa }, { requestId: 'r-available' }), 'available');
  // stale: asOf older than staleAfterSec (profile: 7 days = 604800 s); 8 days old
  S.setProvider('profile', { run: async () => ({ data: { issuer: { id: 'I1', name: 'X' }, listing: { exchange: 'E', currency: 'USD' } }, asOf: new Date(clock.ms() - 8 * 86400e3).toISOString() }) });
  const stale = await S.call('profile', { instrument: alfa }, { fresh: true });
  check(stale, 'stale');
  assert.equal(stale.freshness.ageSec, 8 * 86400); // 8 days x 86400 s
  assert.equal(stale.freshness.staleAfterSec, 604800);
  // unavailable: the server answers with nothing
  S.setProvider('profile', { run: async () => ({ data: null, asOf: now }) });
  check(await S.call('profile', { instrument: alfa }, { fresh: true }), 'unavailable');
  // incomplete: required fields missing are named, values stay null (never 0)
  S.setProvider('profile', { run: async () => ({ data: { issuer: { id: 'I1', name: 'X' }, listing: { exchange: null, currency: 'USD' } }, asOf: now }) });
  const inc = await S.call('profile', { instrument: alfa }, { fresh: true });
  check(inc, 'incomplete');
  assert.deepEqual(inc.missingFields, ['listing.exchange']);
  assert.equal(inc.data.listing.exchange, null);
  // error
  S.setProvider('profile', { run: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } });
  const err = await S.call('profile', { instrument: alfa }, { fresh: true, cacheKey: 'nocache' });
  check(err, 'error');
  assert.equal(err.error.retryable, true);
  // loading: the server has not answered within waitMs; the answer is joined by the next identical request
  let release;
  S.setProvider('profile', { run: () => new Promise((res) => { release = () => res({ data: { issuer: { id: 'I1', name: 'X' }, listing: { exchange: 'E', currency: 'USD' } }, asOf: now }); }) });
  const loading = await S.call('profile', { instrument: alfa }, { fresh: true, waitMs: 20, cacheKey: 'k-loading' });
  check(loading, 'loading');
  const joined = S.call('profile', { instrument: alfa }, { cacheKey: 'k-loading' });
  release();
  assert.equal((await joined).state, 'available');
  // awaiting: no provider (normal mode, nothing configured)
  const live = makeApp({ demo: false }).app;
  const stock = live.instruments.create({ productId: 'common_stock', name: 'Example Corp', symbol: 'EXMP', marketView: 'US_CASH', venue: 'NYSE', venueCountry: 'US', tradingCcy: 'USD' });
  check(await live.data.server.call('profile', { instrument: stock }), 'awaiting');
  assert.deepEqual([...seen].sort(), [...ENVELOPE_STATES].sort());
});

test('the requestId and selection are echoed in every response', async () => {
  const { app, inst } = makeApp();
  const env = await app.data.server.call('quotes', { instruments: [inst.ALFA] }, { requestId: 'req-42', selection: 'drawer:ALFA:1', channel: 'drawer' });
  assert.equal(env.requestId, 'req-42');
  assert.equal(env.selection, 'drawer:ALFA:1');
  const gen = await app.data.server.call('quotes', { instruments: [inst.ALFA] });
  assert.match(gen.requestId, /^srv-/);
});

// ---- cancellation and obsolete selections -------------------------------------------------------------------

test('a late response for a previous instrument selection is discarded and never cached', async () => {
  const { app, inst } = makeApp();
  const S = app.data.server;
  const pending = [];
  // This provider ignores the abort signal on purpose: the late answer must still be discarded.
  S.setProvider('profile', { run: (c, p) => new Promise((res) => pending.push(() => res({ data: { issuer: { id: p.instrument.symbol, name: p.instrument.name }, listing: { exchange: 'E', currency: 'USD' } }, asOf: app.clock.now().toISOString() }))) });
  const first = S.call('profile', { instrument: inst.ALFA }, { selection: 'sel-ALFA', channel: 'drawer', requestId: 'a' });
  const second = S.call('profile', { instrument: inst.BRVO }, { selection: 'sel-BRVO', channel: 'drawer', requestId: 'b' });
  pending[1](); // BRVO answers first
  pending[0](); // ALFA answers late
  const [a, b] = await Promise.all([first, second]);
  assert.equal(b.state, 'available');
  assert.equal(b.data.issuer.id, 'BRVO');
  assert.equal(a.state, 'error');
  assert.equal(a.error.code, 'superseded');
  assert.equal(a.error.retryable, false);
  assert.equal(a.data, undefined, 'the obsolete ALFA payload is not returned');
  assert.ok(![...S._cache.values()].some((e) => e.env.data?.issuer?.id === 'ALFA'), 'the obsolete payload is not cached');
});

test('the caller\'s AbortSignal reaches fetch, and a superseded selection aborts the gateway request', async () => {
  const signals = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    signals.push(init.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const contract = { market: { profile: async ({ http, signal }, p) => ({ data: await http.get(`profile/${p.id}`, { signal }) }) }, analytics: {} };
  const { client } = bareClient({ fetchImpl, contract });
  const a = client.call('profile', { id: 'A' }, { selection: 'A', channel: 'x' });
  await new Promise((r) => setTimeout(r, 5));
  const b = client.call('profile', { id: 'B' }, { selection: 'B', channel: 'x' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, 'the older request was aborted at fetch');
  assert.equal(signals[1].aborted, false);
  assert.equal((await a).error.code, 'superseded');
  const ctl = new AbortController();
  const c = client.call('profile', { id: 'C' }, { signal: ctl.signal, cacheKey: 'c' });
  await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  const envC = await c;
  assert.equal(envC.state, 'error');
  assert.equal(envC.error.code, 'cancelled');
  void b;
});

// ---- retries ----------------------------------------------------------------------------------------------------

test('retries are bounded with exponential backoff; 401 and 403 are never retried and say so', async () => {
  let calls = 0;
  let status = 503;
  const fetchImpl = async (url, init) => { calls++; assert.equal(init.headers.Authorization, 'secret-token'); return resp(status, { x: 1 }); };
  const contract = { market: { profile: async ({ http, signal }, p) => ({ data: await http.get('p', { signal }) }), news: async ({ http, signal }, p) => ({ items: [await http.get('n', { signal })] }) }, analytics: { instrumentAnalytics: async ({ http, signal }) => ({ data: await http.get('a', { signal }) }) } };
  const { client, slept } = bareClient({ fetchImpl, contract });
  const e503 = await client.call('profile', { instrument: { id: 'I1' } });
  // maxRetries 2 -> 3 attempts; backoff 250 ms then 500 ms (250 x 2^0, 250 x 2^1)
  assert.equal(calls, 3);
  assert.deepEqual(slept, [250, 500]);
  assert.equal(e503.error.attempts, 3);
  assert.equal(e503.error.retryable, true);

  calls = 0; status = 403;
  const e403 = await client.call('profile', { instrument: { id: 'I1' } }, { fresh: true });
  assert.equal(calls, 1, '403 is not retried');
  assert.equal(e403.error.code, 'forbidden');
  assert.equal(e403.error.retryable, false);
  assert.match(e403.error.message, /Not retried/);
  const again = await client.call('profile', { instrument: { id: 'I1' } }, { fresh: true });
  assert.equal(calls, 1, 'a refused subject is not asked again');
  assert.equal(again.error.attempts, 0);
  assert.match(again.error.message, /not retried/);
  assert.ok(client.state().datasets.profile.authBlocked, 'the state route shows the block');
  assert.equal(client.state().datasets.profile.authBlocked.retrying, false);
  // A 403 for one subject leaves other subjects alone
  status = 200;
  assert.notEqual((await client.call('profile', { instrument: { id: 'I2' } })).state, 'error');

  calls = 0; status = 401;
  const e401 = await client.call('news', { instrument: { id: 'I3' } });
  assert.equal(calls, 1, '401 is not retried');
  assert.equal(e401.error.code, 'unauthorized');
  // A refused credential blocks every market dataset (not analytics, which may use another permission set)
  status = 200;
  assert.equal((await client.call('profile', { instrument: { id: 'I9' } })).error.code, 'unauthorized');
  assert.equal(calls, 1);
  client.clearAuthBlocks();
  assert.notEqual((await client.call('profile', { instrument: { id: 'I9' } })).state, 'error');
});

// ---- cache ------------------------------------------------------------------------------------------------------

test('the cache honours each dataset\'s TTL and explicit invalidation', async () => {
  const { app, clock, inst } = makeApp();
  const S = app.data.server;
  let runs = 0;
  S.setProvider('profile', { run: async () => { runs++; return { data: { issuer: { id: 'I', name: 'N' }, listing: { exchange: 'E', currency: 'USD' } }, asOf: clock.now().toISOString() }; } });
  await S.call('profile', { instrument: inst.ALFA });
  const hit = await S.call('profile', { instrument: inst.ALFA });
  assert.equal(runs, 1);
  assert.equal(hit.cached, true);
  // profile TTL is 3600 s: 3599 s later still cached, 3601 s later fetched again
  clock.advance(3599e3);
  await S.call('profile', { instrument: inst.ALFA });
  assert.equal(runs, 1);
  clock.advance(2e3);
  await S.call('profile', { instrument: inst.ALFA });
  assert.equal(runs, 2);
  assert.equal(S.invalidate({ dataset: 'profile', instrumentId: inst.ALFA.id }), 1);
  await S.call('profile', { instrument: inst.ALFA });
  assert.equal(runs, 3);
  await S.call('profile', { instrument: inst.ALFA }, { fresh: true });
  assert.equal(runs, 4, 'fresh=1 bypasses the cache');
  // A TTL changed in the refresh settings applies
  S.saveRefresh({ profile: { ttlSec: 0 } });
  await S.call('profile', { instrument: inst.ALFA });
  await S.call('profile', { instrument: inst.ALFA });
  assert.equal(runs, 6);
  assert.throws(() => S.saveRefresh({ profile: { mode: 'subscription' } }), /Not supported by the contract/);
  assert.equal(S.subscribe('quotes', {}, () => {}).supported, false);
});

test('a failed refresh shows the cached copy as stale with the error, never as current', async () => {
  const { app, clock, inst } = makeApp();
  fastRetries(app);
  const S = app.data.server;
  let fail = false;
  S.setProvider('profile', { run: async () => { if (fail) throw Object.assign(new Error('down'), { status: 502 }); return { data: { issuer: { id: 'I', name: 'N' }, listing: { exchange: 'E', currency: 'USD' } }, asOf: clock.now().toISOString() }; } });
  await S.call('profile', { instrument: inst.ALFA });
  fail = true;
  const env = await S.call('profile', { instrument: inst.ALFA }, { fresh: true });
  assert.equal(env.state, 'stale');
  assert.equal(env.error.code, 'server-error');
  assert.equal(env.data.issuer.id, 'I');
});

// ---- pagination -------------------------------------------------------------------------------------------------

test('cursor and page pagination run behind one iterator', async () => {
  const { app, inst } = makeApp();
  const S = app.data.server;
  const all = Array.from({ length: 23 }, (_, i) => ({ id: i }));
  S.setProvider('news', { run: async (c) => { const s = c.cursor ? Number(c.cursor) : 0; return { items: all.slice(s, s + 10), cursor: c.cursor, nextCursor: s + 10 < 23 ? String(s + 10) : null, asOf: app.clock.now().toISOString() }; } });
  const cur = await S.collect('news', { instrument: inst.ALFA });
  assert.equal(cur.items.length, 23);
  assert.equal(cur.pagination.pagesRead, 3); // 10 + 10 + 3
  assert.equal(cur.pagination.truncated, false);
  S.setProvider('filings', { run: async (c) => { const p = c.page || 1; return { items: all.slice((p - 1) * 5, p * 5), page: p, totalPages: 5, asOf: app.clock.now().toISOString() }; } });
  const pg = await S.collect('filings', { instrument: inst.ALFA });
  assert.equal(pg.items.length, 23);
  assert.equal(pg.pagination.pagesRead, 5); // ceil(23 / 5)
  const one = await S.call('filings', { instrument: inst.ALFA }, { page: 2 });
  assert.deepEqual(one.items.map((x) => x.id), [5, 6, 7, 8, 9]);
  assert.equal(one.pagination.mode, 'page');
  // The bare iterator, with a bound
  let n = 0;
  for await (const p of paginate(async ({ page }) => ({ page, totalPages: 100 }), { maxPages: 4 })) { n++; void p; }
  assert.equal(n, 4);
});

// ---- demo fixtures --------------------------------------------------------------------------------------------

test('demo fixtures drive every dataset for the demo instruments, labelled as fixtures', async () => {
  const { app, inst } = makeApp();
  const S = app.data.server;
  const alfa = inst.ALFA;
  const want = {
    reference: ['reference', { instrument: alfa }], quotes: ['quotes', { instruments: [alfa] }], history: ['history', { instrument: alfa, from: '2026-01-05', to: '2026-02-27', interval: '1d' }],
    fx: ['fx', { pairs: ['EUR/USD', 'USD/JPY'] }], profile: ['profile', { instrument: alfa }], statements: ['statements', { instrument: alfa, statement: 'income', period: 'quarterly' }],
    earnings: ['earnings', { instrument: alfa }], filings: ['filings', { instrument: alfa }], corporateActions: ['corporateActions', { instrument: alfa }], news: ['news', { instrument: alfa }],
    analytics: ['analytics', { instrument: alfa }], analyticsRuns: ['analyticsRuns', { instrument: alfa }], earningsWindow: ['earningsWindow', { instrument: alfa }], search: ['search', { q: 'ALFA' }],
  };
  for (const [name, [ds, params]] of Object.entries(want)) {
    const env = await S.call(ds, params);
    assert.equal(env.state, 'available', `${name}: ${env.message} ${JSON.stringify(env.freshness)} ${env.asOf}`);
    assert.equal(env.source.fixture, true, `${name} is labelled as a fixture`);
    assert.match(env.source.label, /Demo fixture|Simulated demo feed/);
  }
  // Statements: a restated quarter keeps its original; YTD cash flows are flagged, never standalone quarters
  const inc = await S.call('statements', { instrument: alfa, statement: 'income', period: 'quarterly' });
  const restated = inc.data.periods.find((p) => p.basis === 'restated');
  assert.ok(restated, 'one restated quarter');
  const rev = inc.data.lines.find((l) => l.key === 'revenue');
  assert.ok(rev.original[restated.key] > rev.values[restated.key], 'the original value is kept beside the restated one');
  const asFiled = await S.call('statements', { instrument: alfa, statement: 'income', period: 'quarterly' }, { asOf: restated.filingDate });
  assert.equal(asFiled.pointInTime.supported, true);
  assert.equal(asFiled.data.periods.find((p) => p.key === restated.key).basis, 'reported', 'as filed then: no restatement yet');
  const cf = await S.call('statements', { instrument: alfa, statement: 'cashflow', period: 'quarterly' });
  const ytd = cf.data.periods.filter((p) => p.periodType === 'ytd');
  assert.ok(ytd.length >= 2 && ytd.every((p) => p.months === 6 || p.months === 9));
  const bs = await S.call('statements', { instrument: alfa, statement: 'balance', period: 'quarterly' });
  assert.ok(bs.data.periods.every((p) => p.periodType === 'instant' && p.start === null), 'balance sheet values are at a date');
  assert.equal((await S.call('statements', { instrument: alfa, statement: 'balance', period: 'ttm' })).state, 'unavailable');
  const annual = await S.call('statements', { instrument: alfa, statement: 'income', period: 'annual' });
  assert.equal(annual.data.periods.length, 3);
  // Earnings: an upcoming estimated date with no reported values (null, not 0)
  const earn = await S.call('earnings', { instrument: alfa });
  const upcoming = earn.items.find((e) => e.reportedAt === null);
  assert.equal(upcoming.dateStatus, 'estimated');
  assert.ok(upcoming.metrics.every((m) => m.reported === null));
  assert.ok(earn.items.some((e) => e.revision === 'revised'));
  // Analytics: two runs, the older one historical
  const runs = await S.call('analyticsRuns', { instrument: alfa });
  assert.equal(runs.items.length, 2);
  assert.deepEqual(runs.items.map((r) => r.historical), [false, true]);
  const old = await S.call('analytics', { instrument: alfa, runId: runs.items[1].runId });
  assert.equal(old.data.historical, true);
  assert.equal(old.data.current, false);
  // BRVO analytics are partial: incomplete, with reasons
  const brvo = await S.call('analytics', { instrument: inst.BRVO });
  assert.equal(brvo.state, 'incomplete');
  assert.equal(brvo.data.realisticFairValue, null);
  assert.ok(brvo.nulls.realisticFairValue);
  // A futures contract has no issuer statements of its own; the envelope links to the underlying
  const fut = Object.values(inst).find((i) => i?.family === 'future');
  const fs = await S.call('statements', { instrument: fut, statement: 'income', period: 'quarterly' });
  assert.equal(fs.state, 'unavailable');
  assert.ok(fs.related.underlying.terminalId);
  // Quotes have no point-in-time support in the fixture contract: stated, current data not substituted
  const pit = await S.call('quotes', { instruments: [alfa] }, { asOf: '2026-01-02' });
  assert.equal(pit.state, 'unavailable');
  assert.equal(pit.pointInTime.supported, false);
  assert.equal(pit.items, undefined);
});

test('fixture controls switch a dataset between available, stale, unavailable, empty, error, slow, partial and forbidden', async () => {
  const { app, inst } = makeApp();
  fastRetries(app);
  const api = createApi(app);
  const id = inst.ALFA.id;
  const get = (q = {}) => route(api, 'GET', `/api/server/profile/${id}`, { query: { fresh: '1', ...q } });
  const set = (mode, extra = {}) => route(api, 'POST', '/api/demo/fixtures/server', { body: { dataset: 'profile', mode, ...extra } });
  set('stale');
  assert.equal((await get()).state, 'stale');
  set('unavailable');
  assert.equal((await get()).state, 'unavailable');
  set('empty');
  const empty = await get();
  assert.equal(empty.state, 'unavailable');
  assert.equal(empty.data, null);
  set('error');
  const e = await get();
  assert.equal(e.state, 'error');
  assert.equal(e.error.attempts, 3, 'a server error is retried (bounded) before it is reported');
  set('partial');
  const p = await get();
  assert.equal(p.state, 'incomplete');
  assert.ok(p.missingFields.length >= 1);
  set('forbidden');
  const f = await get();
  assert.equal(f.error.code, 'forbidden');
  assert.equal(f.error.attempts, 1);
  set('slow', { delayMs: 60 });
  const t0 = Date.now();
  const slow = await get({ waitMs: '10' });
  assert.equal(slow.state, 'loading');
  const after = await get();
  assert.equal(after.state, 'available');
  assert.ok(Date.now() - t0 >= 50);
  route(api, 'POST', '/api/demo/fixtures/server', { body: { reset: true } });
  assert.equal((await get()).state, 'available');
  // Built-in cases: a 403 for KAIJ filings (not retried), a server error for KAIJ corporate actions, a paginated list
  const k = await route(api, 'GET', `/api/server/filings/${inst.KAIJ.id}`);
  assert.equal(k.error.code, 'forbidden');
  const kc = await route(api, 'GET', `/api/server/corporate-actions/${inst.KAIJ.id}`);
  assert.equal(kc.error.code, 'server-error');
  const page1 = await route(api, 'GET', `/api/server/filings/${id}`);
  assert.equal(page1.pagination.mode, 'cursor');
  assert.equal(page1.items.length, 10);
  const allPages = await route(api, 'GET', `/api/server/filings/${id}`, { query: { all: '1' } });
  assert.equal(allPages.items.length, 23);
  // Fixtures do not exist in the normal Terminal
  const live = createApi(makeApp({ demo: false }).app);
  assert.throws(() => route(live, 'POST', '/api/demo/fixtures/server', { body: { dataset: 'profile', mode: 'stale' } }), (err) => err.status === 403);
});

test('the document proxy streams the fixture document with a restrictive policy, and never fetches anything else', async () => {
  const { app } = makeApp();
  const api = createApi(app);
  const out = await route(api, 'GET', '/api/server/documents/fixture-doc-alfa-0-0');
  const raw = out[Symbol.for('sdt.rawResponse')];
  assert.equal(raw.status, 200);
  assert.match(raw.headers['Content-Type'], /text\/html/);
  assert.match(raw.headers['Content-Security-Policy'], /sandbox/);
  assert.match(String(raw.body), /Demo fixture document/);
  const missing = await route(api, 'GET', '/api/server/documents/https%3A%2F%2Fexample.com%2Fx.pdf');
  assert.equal(missing.state, 'unavailable');
});

// ---- corporate actions: delivered twice, recorded once ------------------------------------------------------

test('a corporate action delivered twice is shown once and recorded once', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const id = inst.ALFA.id;
  const raw = await app.data.server.call('corporateActions', { instrument: inst.ALFA });
  const ids = raw.items.map((x) => x.eventId);
  const dupId = ids.find((x, i) => ids.indexOf(x) !== i);
  assert.ok(dupId, 'the fixture delivers one event twice');
  const listed = await route(api, 'GET', `/api/server/corporate-actions/${id}`);
  const row = listed.items.filter((x) => x.eventId === dupId);
  assert.equal(row.length, 1);
  assert.equal(row[0].deliveries, 2);
  const before = app.db.get('SELECT COUNT(*) AS n FROM corporate_actions WHERE instrument_id = ?', id).n;
  // Record each delivery as delivered (both items), and the same request again
  const dups = raw.items.filter((x) => x.eventId === dupId);
  const r1 = app.serverLedger.recordCorporateAction(id, dups[0], raw.source);
  const r2 = app.serverLedger.recordCorporateAction(id, dups[1], raw.source);
  const r3 = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dupId } });
  assert.equal(r1.recorded, true);
  assert.equal(r2.duplicate, true);
  assert.equal(r3.duplicate, true);
  assert.equal(r1.caId, r2.caId);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM corporate_actions WHERE instrument_id = ?', id).n, before + 1);
  const relisted = await route(api, 'GET', `/api/server/corporate-actions/${id}`, { query: { fresh: '1' } });
  assert.equal(relisted.items.find((x) => x.eventId === dupId).recorded.caId, r1.caId);
  // An informational event (a buyback) cannot be posted
  const buyback = raw.items.find((x) => x.type === 'buyback');
  await assert.rejects(route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: buyback.eventId } }), /informational/);
});

// ---- refreshing server data never touches the paper books ---------------------------------------------------

const LEDGER_TABLES = ['events', 'entries', 'fills', 'orders', 'positions', 'position_history', 'settlements', 'corporate_actions', 'snapshots', 'holds', 'protection_allocations', 'collateral_movements'];
function ledgerHash(app) {
  const h = createHash('sha256');
  for (const t of LEDGER_TABLES) h.update(`${t}:${JSON.stringify(app.db.all(`SELECT * FROM ${t} ORDER BY rowid`))}\n`);
  return h.digest('hex');
}

test('refreshing quotes, statements and analytics changes no fill, no ledger entry and no booked accounting', async () => {
  const { app, clock, inst } = makeApp();
  fastRetries(app);
  const { book, acct } = makeBook(app);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  await advance(app, clock, 60_000, { ticks: 2 });
  assert.ok(app.db.get('SELECT COUNT(*) AS n FROM fills').n >= 1, 'a real fill exists before the refresh');
  const before = ledgerHash(app);
  const api = createApi(app);
  const id = inst.ALFA.id;
  for (const path of [`/api/server/quotes`, `/api/server/statements/${id}`, `/api/server/analytics/${id}`, `/api/server/earnings/${id}`, `/api/server/corporate-actions/${id}`, `/api/server/news/${id}`, `/api/server/history/${id}`, `/api/server/profile/${id}`, `/api/server/ledger/${id}`]) {
    for (const fresh of ['0', '1']) await route(api, 'GET', path, { query: { ids: id, fresh, bookId: book.id, statement: 'cashflow' } });
  }
  route(api, 'POST', '/api/demo/fixtures/server', { body: { dataset: 'all', mode: 'stale' } });
  await route(api, 'GET', `/api/server/analytics/${id}`, { query: { fresh: '1' } });
  route(api, 'POST', '/api/demo/fixtures/server', { body: { reset: true } });
  app.data.server.watch('quotes', { instruments: [inst.ALFA] });
  clock.advance(10_000);
  await app.data.server.tick();
  route(api, 'POST', '/api/server/cache/invalidate', { body: {} });
  assert.equal(ledgerHash(app), before, 'fills, entries, positions and accounting are unchanged');
  // (Marks may move with the demo feed's price; that is valuation, not booked accounting, and is not compared here.)
});

// ---- the Terminal computes no fair value, gap, score or signal --------------------------------------------

test('the client layer passes analytics through; it computes no fair value, gap, score or signal', async () => {
  const files = ['server/data/server-client.js', 'server/server-api.js', 'server/data/server-integration.js'];
  const forbidden = /(fairValue|gap|score|signal|efs|sizing)\w*\s*[:=]\s*[^,;\n]*[\w)\]]\s*[-+*/]\s*[\w(]/i;
  for (const f of files) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').split('\n');
    src.forEach((line, i) => { if (!/^\s*(\/\/|\*)/.test(line)) assert.doesNotMatch(line, forbidden, `${f}:${i + 1} computes an analytics field: ${line.trim()}`); });
    assert.doesNotMatch(src.join('\n'), /fairValue\s*[-*/]|\/\s*fairValue|price\s*[-/]\s*\w*fairValue/i, `${f} does no fair-value arithmetic`);
  }
  // Pass-through: the analytics record reaches the route exactly as the server sent it
  const { app, inst } = makeApp();
  const record = { strategyId: 'S1', runId: 'R1', version: 'v', calculatedAt: '2026-03-01T06:00:00.000Z', inputCutoff: '2026-02-28T21:00:00.000Z', horizon: '12M', fairValueCurrency: 'USD', fairValueUnits: 'per share', fundamentalFairValue: 123.45, realisticFairValue: 120.5, fundamentalGapPct: 7.77, realisticGapPct: null, efs: 0.5, sectorScore: 50, equityScore: 49 };
  app.data.server.setProvider('analytics', { run: async () => ({ data: structuredClone(record), asOf: record.calculatedAt }) });
  const env = await route(createApi(app), 'GET', `/api/server/analytics/${inst.ALFA.id}`);
  assert.deepEqual(env.data, record);
  assert.equal(env.data.realisticGapPct, null, 'a missing gap stays missing');
});

test('the data requirements are documented for every dataset', () => {
  const doc = readFileSync(new URL('../../docs/SERVER-CLIENT.md', import.meta.url), 'utf8');
  for (const [k, d] of Object.entries(SERVER_DATASETS)) {
    for (const f of ['label', 'interface', 'operation', 'inputs', 'requires', 'freshness', 'pagination', 'pointInTime', 'errors']) assert.ok(d[f] !== undefined, `${k}.${f}`);
    assert.ok(doc.includes(d.operation), `docs/SERVER-CLIENT.md names ${d.operation}`);
  }
});
