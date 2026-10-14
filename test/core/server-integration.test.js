import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, makeBook, trade, advance, START } from '../helpers.js';
import { createApp } from '../../server/app.js';
import { createClock } from '../../server/core/clock.js';
import { seedDemoInstruments } from '../../server/data/demo-seed.js';
import { createApi } from '../../server/api.js';
import { SERVER_DATASETS } from '../../server/data/ports.js';
import { FIXTURE_MODES } from '../../server/data/server-fixtures.js';
import { gapOf } from '../../web/views/workspace-model.js';
import { annualVsTtm } from '../../web/views/tabs/statements-model.js';

// i1: the owner's failure-mode list (OWNER_REQUEST3 section 8) at the level of the real routes, the server client, the
// paper ledger and the corporate-action module. Fixtures stand in for the Shaffer gateway only: the demo fixture
// controls (POST /api/demo/fixtures/server) or a provider set with setProvider() ("Test fixture"). Every result is
// driven by a fixture control or the frozen clock, never by timing.

const route = (api, method, path, { query = {}, body = {} } = {}) => {
  const m = api.match(method, path);
  assert.ok(m && !m.methodNotAllowed, `route ${method} ${path}`);
  return m.handler({ params: m.params, query, body, req: { headers: {} } });
};
const fastRetries = (app) => app.data.setSetting('server.retry', { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });

/** The demo instruments plus an option, a fund and a swap registered as a user would (as test/core/product-datasets.test.js). */
function setup() {
  const { app, clock, inst } = makeApp();
  fastRetries(app);
  const reg = (d) => app.instruments.create(d);
  const option = reg({ productId: 'equity_option', name: 'ALFA 2026-04-17 180 put (test)', symbol: 'ALFA260417P180', marketView: 'US_DERIV', venue: 'SIM Options', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', underlyingId: inst.ALFA.id, multiplier: 100, terms: { right: 'P', strike: 180, expiration: '2026-04-17', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
  const fund = reg({ productId: 'mutual_fund', name: 'Lakemont Balanced Fund (test)', symbol: 'LKBIX', marketView: 'US_CASH', venue: 'Transfer agent', venueType: 'otc', venueCountry: 'US', issuer: 'Lakemont Funds Trust', tradingCcy: 'USD', terms: {} });
  const swap = reg({ productId: 'interest_rate_swap', name: 'USD IRS 4.00% v TSFR3M 5 Mar 2027', symbol: 'IRS-TSFR-0327', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01,
    conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
    terms: { effective: '2026-03-05', maturity: '2027-03-05', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' },
      legs: [{ side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' }, { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } });
  const fut = Object.values(inst).find((i) => i?.family === 'future' && i.terms.root === 'S5');
  const fx = Object.values(inst).find((i) => i?.family === 'fx' && i.terms.base === 'EUR');
  const A = inst.ALFA.id;
  // One route (with its query) per remote dataset: the instrument each is meant for.
  const R = {
    search: ['/api/server/reference/search', { q: 'A' }], reference: [`/api/server/reference/${A}`], quotes: ['/api/server/quotes', { ids: `${A},${inst.BRVO.id}` }],
    history: [`/api/server/history/${A}`], fx: ['/api/server/fx', { pairs: 'EUR/USD,USD/JPY' }], rates: ['/api/server/rates', { codes: 'SIM-ON,SIM-3M' }],
    profile: [`/api/server/profile/${A}`], statements: [`/api/server/statements/${A}`], earnings: [`/api/server/earnings/${A}`], filings: [`/api/server/filings/${A}`],
    corporateActions: [`/api/server/corporate-actions/${A}`], news: [`/api/server/news/${A}`],
    ratingsCovenants: [`/api/server/ratings/${inst.SIMCORP29.id}`], yieldSpread: [`/api/server/yield-spread/${inst.SIMCORP29.id}`], optionGreeks: [`/api/server/option-greeks/${option.id}`],
    futuresCurve: [`/api/server/futures-curve/${fut.id}`], exchangeMargin: [`/api/server/margin/${fut.id}`], fundHoldings: [`/api/server/fund-holdings/${fund.id}`], fundFacts: [`/api/server/fund-facts/${fund.id}`],
    otcMarks: [`/api/server/marks/${swap.id}`], fxCurve: [`/api/server/fx-curve/${fx.id}`],
    analytics: [`/api/server/analytics/${A}`], analyticsRuns: [`/api/server/analytics/${A}/runs`], earningsWindow: [`/api/server/earnings-window/${A}`],
  };
  const api = createApi(app);
  const get = (ds, extra = {}) => route(api, 'GET', R[ds][0], { query: { ...(R[ds][1] || {}), fresh: '1', ...extra } });
  const mode = (dataset, m, extra = {}) => route(api, 'POST', '/api/demo/fixtures/server', { body: { dataset, mode: m, ...extra } });
  const reset = () => route(api, 'POST', '/api/demo/fixtures/server', { body: { reset: true } });
  return { app, clock, inst, api, R, get, mode, reset, option, fund, swap, fut, fx };
}
const REMOTE = Object.keys(SERVER_DATASETS).filter((k) => SERVER_DATASETS[k].interface !== 'ledger' && SERVER_DATASETS[k].shape !== 'stream');

test('the catalogue holds 25 remote datasets plus the ledger interface, and every remote dataset has a route here', () => {
  const remote = Object.keys(SERVER_DATASETS).filter((k) => SERVER_DATASETS[k].interface !== 'ledger');
  assert.equal(remote.length, 25); // 16 of wave 1 (documents included) + 9 product datasets
  assert.equal(Object.keys(SERVER_DATASETS).filter((k) => SERVER_DATASETS[k].interface === 'ledger').length, 1);
  const { R } = setup();
  assert.deepEqual(Object.keys(R).sort(), REMOTE.sort());
  for (const m of ['throttled', 'offline', 'revised', 'duplicate', 'currency-mismatch', 'unit-mismatch']) assert.ok(FIXTURE_MODES.includes(m), m);
});

// ---- empty and partial responses, missing fields ----------------------------------------------------------------

test('empty, unavailable and partial responses on every remote dataset: no record invented, missing fields named and null', async () => {
  const { get, mode, reset } = setup();
  for (const ds of REMOTE) {
    reset();
    const base = await get(ds);
    assert.ok(['available', 'incomplete'].includes(base.state), `${ds} answers with the fixture: ${base.state} ${base.message}`);
    for (const m of ['empty', 'unavailable']) {
      mode(ds, m);
      const e = await get(ds);
      assert.equal(e.state, 'unavailable', `${ds} ${m}`);
      if (SERVER_DATASETS[ds].shape === 'items') assert.deepEqual(e.items, [], `${ds} ${m}: no items`);
      else assert.equal(e.data ?? null, null, `${ds} ${m}: no data`);
    }
    mode(ds, 'partial');
    const p = await get(ds);
    assert.equal(p.state, 'incomplete', `${ds} partial: ${p.state}`);
    assert.ok(p.missingFields.length >= 1, `${ds} partial names what is missing`);
    for (const m of p.missingFields) assert.ok(p.coverage.missing.includes(m), `${ds}: ${m} also in coverage.missing`);
    if (SERVER_DATASETS[ds].shape === 'items') assert.ok(p.items.length >= 1 && p.items.length < base.items.length || base.items.length === 1, `${ds} partial keeps part of the records`);
    // Every value the partial answer withheld is null (never 0) and has its reason
    for (const [field, reason] of Object.entries(p.nulls || {})) {
      if (!SERVER_DATASETS[ds].requires.includes(field)) continue;
      const v = field.split('.').reduce((o, k) => (o == null ? o : o[k]), p.data);
      assert.equal(v, null, `${ds}.${field} is null, not ${v}`);
      assert.ok(reason, `${ds}.${field} has a reason`);
    }
  }
  reset();
});

test('missing fields in a list record are named with a count; in a single record by path; the value stays null', async () => {
  const { app, inst, api } = setup();
  const S = app.data.server;
  const now = app.clock.now().toISOString();
  // A news item without its source and a quote without a timestamp: incomplete, the field named, nothing filled in
  S.setProvider('news', { run: async () => ({ items: [{ id: 'n1', publishedAt: now, source: 'Wire', headline: 'H', scope: 'company' }, { id: 'n2', publishedAt: now, source: null, headline: 'H2', scope: 'company' }], asOf: now }) });
  const n = await route(api, 'GET', `/api/server/news/${inst.ALFA.id}`, { query: { fresh: '1' } });
  assert.equal(n.state, 'incomplete');
  assert.deepEqual(n.missingFields, ['source (missing in 1 of 2 records)']);
  assert.equal(n.items[1].source, null);
  S.setProvider('quotes', { run: async () => ({ items: [{ instrumentId: inst.ALFA.id, quoteType: 'last', last: 10, currency: 'USD', units: 'per share', timestamp: null, status: 'delayed' }], asOf: now }) });
  const q = await route(api, 'GET', '/api/server/quotes', { query: { ids: inst.ALFA.id, fresh: '1' } });
  assert.equal(q.state, 'incomplete');
  assert.deepEqual(q.missingFields, ['timestamp (missing in 1 of 1 record)']);
  // History states adjusted / currency / interval once for the series (in data): not reported as missing per bar
  S.setProvider('history', { run: async () => ({ items: [{ t: now, date: now.slice(0, 10), close: 1 }], data: { adjusted: false, currency: 'USD', interval: '1d' }, asOf: now }) });
  assert.equal((await route(api, 'GET', `/api/server/history/${inst.ALFA.id}`, { query: { fresh: '1' } })).state, 'available');
  // A single record: the analytics record without its units
  S.setProvider('analytics', { run: async () => ({ data: { strategyId: 'S', runId: 'R', version: 'v', calculatedAt: now, inputCutoff: now, horizon: '12M', fairValueCurrency: 'USD', fairValueUnits: null, fundamentalFairValue: 10 }, asOf: now }) });
  const a = await route(api, 'GET', `/api/server/analytics/${inst.ALFA.id}`, { query: { fresh: '1' } });
  assert.equal(a.state, 'incomplete');
  assert.deepEqual(a.missingFields, ['fairValueUnits']);
  assert.equal(a.data.fairValueUnits, null);
});

// ---- stale data ------------------------------------------------------------------------------------------------

test('stale data on every remote dataset: older than its limit, shown as stale with its age, never as current', async () => {
  const { app, get, mode, reset } = setup();
  for (const ds of REMOTE) {
    reset();
    mode(ds, 'stale');
    const e = await get(ds);
    assert.equal(e.state, 'stale', `${ds}: ${e.state} ${e.message}`);
    // The fixture dates the answer 2 x staleAfterSec + 60 s back (server-fixtures.js), so age = that
    const lim = SERVER_DATASETS[ds].freshness.staleAfterSec || 600;
    assert.equal(e.freshness.staleAfterSec, app.data.server.refreshSettings()[ds].staleAfterSec);
    assert.ok(e.freshness.ageSec > e.freshness.staleAfterSec, `${ds}: age ${e.freshness.ageSec} > ${e.freshness.staleAfterSec}`);
    assert.equal(e.freshness.ageSec, lim * 2 + 60, `${ds}: age = 2 x ${lim} + 60`);
  }
  reset();
});

// ---- revisions after the first display -----------------------------------------------------------------------

test('a restated statement arriving after the first display: the new value shown as restated, the original kept', async () => {
  const { get, mode, reset } = setup();
  const first = await get('statements', { statement: 'income', period: 'quarterly' });
  const p0 = first.data.periods.find((p) => p.basis === 'reported' && p.periodType !== 'ttm');
  const rev0 = first.data.lines.find((l) => l.key === 'revenue').values[p0.key];
  const builtIn = first.data.periods.filter((p) => p.basis === 'restated').map((p) => p.key);
  mode('statements', 'revised');
  const later = await get('statements', { statement: 'income', period: 'quarterly' });
  const p1 = later.data.periods.find((p) => p.key === p0.key);
  const rev = later.data.lines.find((l) => l.key === 'revenue');
  assert.equal(p1.basis, 'restated');
  assert.ok(p1.restatedAt);
  assert.equal(rev.original[p0.key], rev0, 'the originally reported value is kept');
  assert.equal(rev.values[p0.key], Math.round(rev0 * 1.02 * 10) / 10, 'restated value: original x 1.02 (fixture rule), one decimal');
  assert.deepEqual(p1.original.values.revenue, rev0);
  for (const k of builtIn) assert.equal(later.data.periods.find((p) => p.key === k).basis, 'restated', 'the earlier restatement is still there');
  // Gross profit stays revenue - cost of revenue in the restated column
  const L = (k) => later.data.lines.find((l) => l.key === k).values[p0.key];
  assert.ok(Math.abs(L('grossProfit') - (L('revenue') - L('costOfRevenue'))) < 0.051);
  // As filed on the date of the first display: no restatement applied
  const asFiled = await get('statements', { statement: 'income', period: 'quarterly', asOf: p0.filingDate });
  assert.equal(asFiled.data.periods.find((p) => p.key === p0.key)?.basis ?? 'reported', 'reported');
  reset();
});

test('a revised earnings date arriving after the first display: moved, confirmed and marked revised', async () => {
  const { get, mode, reset } = setup();
  const first = await get('earnings');
  const up0 = first.items.find((e) => e.reportedAt === null);
  assert.equal(up0.dateStatus, 'estimated');
  mode('earnings', 'revised');
  const later = await get('earnings');
  const up1 = later.items.find((e) => e.reportedAt === null);
  assert.equal(up1.fiscalPeriod, up0.fiscalPeriod);
  assert.equal(Date.parse(up1.releaseAt) - Date.parse(up0.releaseAt), 7 * 86400e3, 'moved one week (7 x 86400 s)');
  assert.equal(up1.dateStatus, 'confirmed');
  assert.equal(up1.revision, 'revised');
  assert.ok(up1.revisedAt && up1.revisionNote);
  assert.ok(up1.metrics.every((m) => m.reported === null), 'still no reported values (null, not 0)');
  reset();
});

test('a revised corporate action after it was recorded: shown as revised, the ledger record is not changed or posted again', async () => {
  const { app, inst, api, get, mode, reset } = setup();
  const id = inst.ALFA.id;
  const listed = await get('corporateActions');
  const dup = listed.items.find((x) => x.deliveries === 2);
  const r1 = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dup.eventId } });
  assert.equal(r1.recorded, true);
  const row0 = app.db.get('SELECT * FROM corporate_actions WHERE id = ?', r1.caId);
  const count0 = app.db.get('SELECT COUNT(*) AS n FROM corporate_actions').n;
  mode('corporateActions', 'revised');
  const later = await get('corporateActions');
  const ev = later.items.find((x) => x.eventId === dup.eventId);
  assert.equal(ev.revision, 'revised');
  assert.equal(ev.amount, Math.round((dup.amount + 0.05) * 100) / 100, 'revised amount: 0.55 + 0.05 = 0.60');
  assert.equal(ev.previous.amount, dup.amount);
  assert.equal(ev.deliveries, 2);
  assert.equal(ev.recorded.caId, r1.caId, 'still matched to the record made before the revision');
  const r2 = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dup.eventId } });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.caId, r1.caId);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM corporate_actions').n, count0);
  assert.deepEqual(app.db.get('SELECT * FROM corporate_actions WHERE id = ?', r1.caId), row0, 'the recorded terms are unchanged');
  reset();
});

// ---- pagination ------------------------------------------------------------------------------------------------

test('pagination: every paginated dataset is read page by page (cursor and page shapes) and collected with all=1', async () => {
  const { app, api, R } = setup();
  const S = app.data.server;
  const paginated = Object.keys(SERVER_DATASETS).filter((k) => SERVER_DATASETS[k].interface !== 'ledger' && !/^none/.test(SERVER_DATASETS[k].pagination));
  assert.deepEqual(paginated.sort(), ['analyticsRuns', 'corporateActions', 'earnings', 'filings', 'fundHoldings', 'history', 'news', 'otcMarks', 'search', 'statements'].sort());
  const now = app.clock.now().toISOString();
  const N = 23;
  const rec = (ds, i) => Object.fromEntries(SERVER_DATASETS[ds].requires.filter((f) => !f.includes('[]')).map((f) => [f.split('.')[0], f === 'ids.server' ? { server: `S${i}` } : f === 'adjusted' ? false : f === 'units' ? 'u' : `${ds}-${i}`]));
  let shape = 0;
  for (const ds of paginated) {
    const cursorShape = shape++ % 2 === 0;
    if (SERVER_DATASETS[ds].shape === 'data') {
      // Statements page by periods: each page brings more periods; collect() is for lists, so pages are read one by one
      S.setProvider(ds, { run: async (c) => { const p = c.page || 1; return { data: { statement: 'income', period: 'quarterly', currency: 'USD', units: 'millions', periods: [{ key: `P${p}`, fiscalYear: 2025, fiscalPeriod: `Q${p}`, periodType: 'quarter', end: '2025-12-31', filingDate: '2026-01-30', source: 's', basis: 'reported' }], lines: [{ key: 'revenue', label: 'Revenue', values: { [`P${p}`]: p } }] }, page: p, totalPages: 3, asOf: now }; } });
      const pages = [];
      for (let p = 1; p <= 3; p++) pages.push(await route(api, 'GET', R[ds][0], { query: { page: String(p), fresh: '1' } }));
      assert.deepEqual(pages.map((e) => e.data.periods[0].key), ['P1', 'P2', 'P3'], ds);
      assert.deepEqual(pages.map((e) => e.pagination.page), [1, 2, 3]);
      assert.equal(pages[2].pagination.totalPages, 3);
      continue;
    }
    const all = Array.from({ length: N }, (_, i) => rec(ds, i));
    S.setProvider(ds, { run: async (c) => {
      if (cursorShape) { const s = c.cursor ? Number(c.cursor) : 0; return { items: all.slice(s, s + 10), cursor: c.cursor, nextCursor: s + 10 < N ? String(s + 10) : null, asOf: now }; }
      const p = c.page || 1;
      return { items: all.slice((p - 1) * 10, p * 10), page: p, pageSize: 10, totalPages: Math.ceil(N / 10), totalItems: N, asOf: now };
    } });
    const first = await route(api, 'GET', R[ds][0], { query: { ...(R[ds][1] || {}), fresh: '1' } });
    assert.equal(first.items.length, 10, `${ds} first page`);
    assert.equal(first.pagination.mode, cursorShape ? 'cursor' : 'page', ds);
    const second = await route(api, 'GET', R[ds][0], { query: { ...(R[ds][1] || {}), fresh: '1', ...(cursorShape ? { cursor: first.pagination.nextCursor } : { page: '2' }) } });
    assert.equal(second.items.length, 10, `${ds} second page`);
    const collected = await route(api, 'GET', R[ds][0], { query: { ...(R[ds][1] || {}), fresh: '1', all: '1' } });
    // 23 records in pages of 10: 10 + 10 + 3, three pages
    assert.equal(collected.items.length, N, `${ds} all pages`);
    assert.equal(collected.pagination.pagesRead, 3, ds);
    assert.equal(collected.pagination.truncated, false);
    assert.equal(new Set(collected.items.map((x) => JSON.stringify(x))).size, N, `${ds}: no record twice across pages`);
    S.setProvider(ds, null);
  }
});

// ---- server errors and throttling -----------------------------------------------------------------------------

test('server errors and throttling: retried within the bound (Retry-After honoured), then an error that says so; 403 never retried', async () => {
  const { app, get, mode, reset } = setup();
  for (const [m, code] of [['error', 'server-error'], ['throttled', 'throttled'], ['offline', 'network']]) {
    mode('profile', m);
    const e = await get('profile');
    assert.equal(e.state, 'error', m);
    assert.equal(e.error.code, code, m);
    assert.equal(e.error.retryable, true, m);
    assert.equal(e.error.attempts, 3, `${m}: maxRetries 2 -> 3 attempts`);
  }
  mode('profile', 'forbidden');
  const f = await get('profile');
  assert.equal(f.error.code, 'forbidden');
  assert.equal(f.error.attempts, 1);
  reset();
  // Retry-After from the gateway, bounded by maxDelayMs (transport level, a stated fetch)
  const { createServerClient } = await import('../../server/data/server-client.js');
  const clock = createClock(); clock.freeze(START);
  const slept = [];
  let calls = 0;
  const client = createServerClient({
    clock, fetchImpl: async () => { calls++; return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '2' : null) }, text: async () => '' }; },
    contract: { market: { profile: async ({ http, signal }) => ({ data: await http.get('p', { signal }) }) }, analytics: {} },
    getConnection: () => ({ gatewayUrl: 'https://gateway.example.invalid/api', marketDataUrl: '', analyticsUrl: '', requestTimeoutMs: 5000 }),
    credentials: { header: 'Authorization', token: 't' }, getSetting: (k, d) => (k === 'server.retry' ? { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 4000 } : d), setSetting: () => {},
    sleep: async (ms) => { slept.push(ms); },
  });
  const t = await client.call('profile', { instrument: { id: 'I' } });
  assert.equal(t.error.code, 'throttled');
  assert.equal(calls, 3);
  // Retry-After 2 s outweighs the backoff of 250 and 500 ms: max(250, 2000) = 2000, max(500, 2000) = 2000
  assert.deepEqual(slept, [2000, 2000]);
  void app;
});

// ---- disconnection and reconnection ----------------------------------------------------------------------------

test('disconnection and reconnection of the gateway: every dataset errors or keeps its last copy as stale, then recovers', async () => {
  const { get, mode, reset, api } = setup();
  const cached = {};
  for (const ds of REMOTE) cached[ds] = await get(ds); // first display (cached server side)
  mode('all', 'offline');
  for (const ds of REMOTE) {
    const e = await get(ds);
    assert.equal(e.state, 'error', `${ds} while the gateway is unreachable: ${e.state}`); // setMode invalidates the cache, so nothing stale is left
    assert.equal(e.error.code, 'network');
    assert.equal(e.error.retryable, true, `${ds}: reconnection will be tried`);
    assert.equal(e.data ?? null, null);
  }
  const st = await route(api, 'GET', '/api/server/state');
  for (const ds of REMOTE) assert.equal(st.datasets[ds].lastError?.code, 'network', ds);
  reset();
  for (const ds of REMOTE) {
    const e = await get(ds);
    assert.equal(e.state, cached[ds].state, `${ds} back to ${cached[ds].state} after reconnection`);
  }
  // A cached copy outlives a failed refresh while disconnected: stale with the error, never current
  const { app, inst } = setup();
  let down = false;
  app.data.server.setProvider('profile', { run: async () => { if (down) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'network', retryable: true }); return { data: { issuer: { id: 'I', name: 'N' }, listing: { exchange: 'E', currency: 'USD' } }, asOf: app.clock.now().toISOString() }; } });
  const a2 = createApi(app);
  await route(a2, 'GET', `/api/server/profile/${inst.ALFA.id}`);
  down = true;
  const s = await route(a2, 'GET', `/api/server/profile/${inst.ALFA.id}`, { query: { fresh: '1' } });
  assert.equal(s.state, 'stale');
  assert.equal(s.error.code, 'network');
  down = false;
  assert.equal((await route(a2, 'GET', `/api/server/profile/${inst.ALFA.id}`, { query: { fresh: '1' } })).state, 'available');
});

// ---- rapid instrument switching --------------------------------------------------------------------------------

test('ten instrument switches on one channel with slowed answers: only the last selection is answered, nothing cached for the others', async () => {
  const { app, inst } = setup();
  const S = app.data.server;
  const equities = ['ALFA', 'BRVO', 'CHRL', 'DLTA', 'KAIJ', 'ROSE', 'ALPN', 'ECHO', 'ALFA', 'BRVO'].map((s) => inst[s]);
  const pending = [];
  // Answers are released in reverse order (the oldest last), and ignore the abort signal on purpose
  S.setProvider('profile', { run: (c, p) => new Promise((res) => pending.push(() => res({ data: { issuer: { id: p.instrument.symbol, name: p.instrument.name }, listing: { exchange: 'E', currency: 'USD' } }, asOf: app.clock.now().toISOString() }))) });
  const calls = equities.map((i, n) => S.call('profile', { instrument: i }, { selection: `page:${i.symbol}:${n}`, channel: 'page', requestId: `r${n}` }));
  for (const release of [...pending].reverse()) release();
  const out = await Promise.all(calls);
  out.slice(0, 9).forEach((e, n) => { assert.equal(e.state, 'error', `switch ${n}`); assert.equal(e.error.code, 'superseded'); assert.equal(e.data, undefined); });
  assert.equal(out[9].state, 'available');
  assert.equal(out[9].data.issuer.id, 'BRVO');
  assert.equal(out[9].selection, 'page:BRVO:9');
  assert.equal(out[9].requestId, 'r9');
  assert.equal([...S._cache.values()].filter((e) => e.dataset === 'profile').length, 1, 'only the last answer is cached');
});

// ---- duplicate events ------------------------------------------------------------------------------------------

test('duplicates: a corporate action delivered twice, the same analytics run twice, the same news item twice', async () => {
  const { app, inst, api, get, mode, reset } = setup();
  // News: the same item twice in one answer -> listed once, the repeat reported
  mode('news', 'duplicate');
  const n = await get('news');
  assert.equal(n.items.length, 10, 'page of 10, the repeat dropped');
  assert.equal(new Set(n.items.map((x) => x.id)).size, n.items.length);
  assert.deepEqual(n.duplicates.dropped, [n.items[0].id]);
  // Analytics runs: the same run twice -> once; the analytics record delivered twice (two requests) -> one run, same values
  mode('analyticsRuns', 'duplicate');
  const runs = await get('analyticsRuns');
  assert.equal(runs.items.length, 2);
  assert.equal(runs.duplicates.dropped.length, 1);
  reset();
  const a1 = await get('analytics');
  const a2 = await get('analytics');
  assert.deepEqual(a2.data, a1.data, 'the same run delivered again is the same record');
  // Corporate action: the same event twice (built in) and once more by the duplicate mode -> one row, deliveries counted, one ledger record
  mode('corporateActions', 'duplicate');
  const ca = await get('corporateActions');
  const ids = ca.items.map((x) => x.eventId);
  assert.equal(new Set(ids).size, ids.length, 'each event listed once');
  assert.ok(ca.items.every((x) => x.deliveries >= 1) && ca.items.filter((x) => x.deliveries === 2).length === 2, 'two events delivered twice (built-in and duplicate mode)');
  const before = app.db.get('SELECT COUNT(*) AS n FROM corporate_actions').n;
  for (const ev of ca.items.filter((x) => x.recordable)) {
    const r = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: inst.ALFA.id, eventId: ev.eventId } });
    const again = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: inst.ALFA.id, eventId: ev.eventId } });
    assert.equal(again.duplicate, true);
    assert.equal(again.caId, r.caId);
  }
  const recordable = ca.items.filter((x) => x.recordable).length;
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM corporate_actions').n, before + recordable, 'one ledger record per event');
  reset();
});

// ---- unit and currency mismatches ------------------------------------------------------------------------------

test('unit and currency mismatches: Gap % withheld with the reason; a TTM in thousands beside annual figures in millions is said so', async () => {
  const { get, mode, reset } = setup();
  const price = { price: 171.48, priceCcy: 'USD', priceUnits: 'per unit', family: 'equity' };
  // As supplied: same currency and units -> passed through
  const ok = await get('analytics');
  assert.deepEqual(gapOf({ ...price, fair: ok.data.fundamentalFairValue, fairCcy: ok.data.fairValueCurrency, fairUnits: ok.data.fairValueUnits, supplied: ok.data.fundamentalGapPct }), { value: ok.data.fundamentalGapPct, basis: 'supplied' });
  mode('analytics', 'currency-mismatch');
  const c = await get('analytics');
  assert.equal(c.data.fairValueCurrency, 'EUR');
  assert.equal(c.data.fundamentalGapPct, ok.data.fundamentalGapPct, 'the server still supplies its gap');
  const gc = gapOf({ ...price, fair: c.data.fundamentalFairValue, fairCcy: c.data.fairValueCurrency, fairUnits: c.data.fairValueUnits, supplied: c.data.fundamentalGapPct });
  assert.equal(gc.value, null);
  assert.match(gc.why, /withheld: the fair price is in EUR and the market price in USD/);
  mode('analytics', 'unit-mismatch');
  const u = await get('analytics');
  assert.equal(u.data.fairValueUnits, 'per 100 shares');
  assert.equal(u.data.fundamentalFairValue, Math.round(ok.data.fundamentalFairValue * 100 * 10) / 10, '205.4 per share = 20540 per 100 shares');
  const gu = gapOf({ ...price, fair: u.data.fundamentalFairValue, fairCcy: u.data.fairValueCurrency, fairUnits: u.data.fairValueUnits, supplied: u.data.fundamentalGapPct });
  assert.equal(gu.value, null);
  assert.match(gu.why, /quoted per 100 shares and the market price per unit/);
  // Without a supplied gap, mismatched inputs are never worked out either
  assert.equal(gapOf({ ...price, fair: 20540, fairCcy: 'USD', fairUnits: 'per 100 shares' }).value, null);
  // Statements: the TTM answer in thousands, the annual answer in millions
  mode('statements', 'unit-mismatch');
  const annual = await get('statements', { statement: 'income', period: 'annual' });
  const ttm = await get('statements', { statement: 'income', period: 'ttm' });
  assert.equal(annual.data.units, 'millions');
  assert.equal(ttm.data.units, 'thousands');
  const r = annualVsTtm(annual.data, ttm.data);
  assert.match(r.note, /The TTM is in thousands and the annual figures in millions: different scales, shown as supplied and not compared/);
  mode('statements', 'currency-mismatch');
  const ttmC = await get('statements', { statement: 'income', period: 'ttm' });
  assert.match(annualVsTtm(annual.data, ttmC.data).note, /The TTM is in EUR and the annual figures in USD/);
  reset();
});

// ---- persistence ----------------------------------------------------------------------------------------------

test('persistence across a restart: refresh settings, fixture modes and corporate-action links kept; no server payload, cache or auth block persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdt-i1-'));
  const open = () => {
    const clock = createClock(); clock.freeze(START);
    const app = createApp({ clock, config: { demo: true, host: '127.0.0.1', port: 0, dataDir: dir, dbFile: join(dir, 'i1.db'), password: '', connectionEnv: {}, credentials: { header: 'Authorization', token: '', hasToken: false }, engine: { autoStart: false } } });
    return { app, inst: seedDemoInstruments(app), api: createApi(app) };
  };
  try {
    let { app, inst, api } = open();
    fastRetries(app);
    const id = inst.ALFA.id;
    for (const p of [`/api/server/profile/${id}`, `/api/server/statements/${id}`, `/api/server/analytics/${id}`, `/api/server/news/${id}`, `/api/server/corporate-actions/${id}`]) await route(api, 'GET', p);
    route(api, 'PUT', '/api/server/refresh', { body: { news: { intervalSec: 300 } } });
    route(api, 'POST', '/api/demo/fixtures/server', { body: { dataset: 'filings', mode: 'stale' } });
    route(api, 'POST', '/api/demo/fixtures/server', { body: { dataset: 'profile', mode: 'forbidden' } });
    assert.equal((await route(api, 'GET', `/api/server/profile/${id}`, { query: { fresh: '1' } })).error.code, 'forbidden');
    const ca = await route(api, 'GET', `/api/server/corporate-actions/${id}`);
    const dup = ca.items.find((x) => x.deliveries === 2);
    const rec = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dup.eventId } });
    // What the database holds: no server payload (the fixture's company, news, analytics and statement records)
    const dump = (a) => JSON.stringify(a.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => a.db.all(`SELECT * FROM "${t.name}"`)));
    const db1 = dump(app);
    for (const s of ['fixture-news-alfa', 'fixture-run-alfa', 'sp3e-fixture', 'Fictional diversified industrial', 'fixture-fil-alfa', 'Demo fixture newswire']) assert.ok(!db1.includes(s), `nothing server-supplied is stored: found "${s}"`);
    const keys = app.db.all('SELECT key FROM settings').map((r) => r.key).filter((k) => /server|fixture|ca|corporate/i.test(k));
    for (const k of keys) assert.match(k, /^(server\.refresh|server\.retry|demo\.serverFixtures|.*corporate.*|.*ca[.:].*)$/i, `only settings meant to persist: ${k}`);
    app.db.close?.();
    ({ app, inst, api } = open()); // restart on the same database
    fastRetries(app);
    assert.equal(app.data.server.refreshSettings().news.intervalSec, 300, 'refresh settings survive');
    assert.equal(app.data.server.fixtures.modeOf('filings').mode, 'stale', 'fixture modes survive (demo test controls, a setting)');
    assert.equal(app.data.server._cache.size, 0, 'the response cache does not survive');
    assert.equal(app.data.server.state().datasets.profile.authBlocked, null, 'a 403 block does not survive (it is asked once more, then blocked again)');
    const again = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dup.eventId } });
    assert.equal(again.duplicate, true, 'the corporate-action link survives: no second posting after a restart');
    assert.equal(again.caId, rec.caId);
    app.db.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- regression against the paper engine and ledger ------------------------------------------------------------

const LEDGER_TABLES = ['events', 'entries', 'fills', 'orders', 'positions', 'position_history', 'settlements', 'corporate_actions', 'snapshots', 'holds', 'protection_allocations', 'collateral_movements'];
const hashRows = (app, t) => createHash('sha256').update(JSON.stringify(app.db.all(`SELECT * FROM ${t} ORDER BY rowid`))).digest('hex');

test('regression: with a populated Book, every server route, fixture flip, reconnection, Strategy and research date leaves the paper books unchanged except the one deliberate corporate-action record', async () => {
  const { app, clock, inst, api, R, mode, reset } = setup();
  const { book, acct } = makeBook(app);
  // Populate: two long equities, a short equity (borrow), a bond, a future (margin), held three days of engine cycles
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 50 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.DLTA.id, quantity: 40 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.SIMCORP29.id, quantity: 10 });
  const fut = Object.values(inst).find((i) => i?.family === 'future');
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: fut.id, quantity: 1 });
  await advance(app, clock, 3 * 86400e3, { ticks: 3 });
  assert.ok(app.db.get('SELECT COUNT(*) AS n FROM fills').n >= 5, 'fills exist (five packages)');
  assert.ok(app.db.get('SELECT COUNT(*) AS n FROM holds').n >= 1, 'a borrow hold exists for the short');
  assert.ok(app.db.get('SELECT COUNT(*) AS n FROM settlements').n >= 1, 'settlements exist');
  assert.ok(app.db.get('SELECT COUNT(*) AS n FROM entries').n > 0, 'ledger entries exist');
  const before = Object.fromEntries(LEDGER_TABLES.map((t) => [t, hashRows(app, t)]));
  const accounting = async () => JSON.stringify((await route(api, 'GET', `/api/books/${book.id}/accounting/history`, { query: { limit: '500' } })).events);
  const acc0 = await accounting();

  // Every route, fresh and cached, for every remote dataset; documents; the ledger interface
  for (const ds of REMOTE) for (const fresh of ['0', '1']) await route(api, 'GET', R[ds][0], { query: { ...(R[ds][1] || {}), fresh, bookId: book.id } });
  await route(api, 'GET', '/api/server/documents/fixture-doc-alfa-0-0');
  await route(api, 'GET', `/api/server/ledger/${inst.ALFA.id}`, { query: { bookId: book.id } });
  // Every fixture mode on every dataset, then reconnection
  for (const m of FIXTURE_MODES.filter((x) => x !== 'slow')) {
    mode('all', m);
    for (const ds of ['quotes', 'statements', 'analytics', 'corporateActions', 'news', 'history']) await route(api, 'GET', R[ds][0], { query: { ...(R[ds][1] || {}), fresh: '1' } });
  }
  mode('all', 'offline');
  await route(api, 'GET', R.quotes[0], { query: { ...R.quotes[1], fresh: '1' } });
  reset();
  // Strategies (fixture SP3E and an unknown one) and research dates
  for (const strategyId of ['fixture-strat-sp3e', 'other-strategy', '']) for (const asOf of ['', '2025-06-30', '2026-01-15']) {
    await route(api, 'GET', `/api/server/analytics/${inst.ALFA.id}`, { query: { strategyId, asOf, fresh: '1' } });
    await route(api, 'GET', `/api/server/statements/${inst.ALFA.id}`, { query: { asOf } });
  }
  // Interval refresh, cache invalidation and a connection test
  app.data.server.watch('quotes', { instruments: [inst.ALFA] });
  clock.advance(10_000);
  await app.data.server.tick();
  route(api, 'POST', '/api/server/cache/invalidate', { body: {} });
  await route(api, 'POST', '/api/server/test');
  const mid = Object.fromEntries(LEDGER_TABLES.map((t) => [t, hashRows(app, t)]));
  assert.deepEqual(mid, before, 'nothing changed before the deliberate record');
  assert.equal(await accounting(), acc0);

  // The one deliberate change: record the duplicated corporate action (twice, and once more after a revision)
  const ca = await route(api, 'GET', R.corporateActions[0], { query: { bookId: book.id } });
  const dup = ca.items.find((x) => x.deliveries === 2);
  await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: inst.ALFA.id, eventId: dup.eventId } });
  await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: inst.ALFA.id, eventId: dup.eventId } });
  mode('corporateActions', 'revised');
  await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: inst.ALFA.id, eventId: dup.eventId } });
  reset();
  const after = Object.fromEntries(LEDGER_TABLES.map((t) => [t, hashRows(app, t)]));
  const changed = LEDGER_TABLES.filter((t) => after[t] !== before[t]);
  assert.deepEqual(changed, ['corporate_actions'], `only the corporate-action record changed: ${changed}`);
  assert.equal(app.db.all('SELECT * FROM corporate_actions').length, 1);
  const integ = await route(api, 'GET', `/api/books/${book.id}/integrity`);
  assert.equal(integ.ok, true, JSON.stringify(integ.checks?.filter((c) => !c.ok)));
});

// ---- trading from the detail page -------------------------------------------------------------------------------

test('a trade placed from the instrument-detail page records that origin and, like a Marketplace trade, opens the hedge workflow after the fill', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const CTX = { investmentStrategy: { id: 'fixture-strat-sp3e', name: 'SP3E (demo fixture)' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };
  // A stated quote with depth, so the fill is complete and does not depend on the demo feed's moment (as hedge.test.js)
  for (const i of [inst.ALFA, inst.BRVO]) app.data.market.set(i.id, { bid: 100, ask: 100, value: 100, bidSize: 1e6, askSize: 1e6 });
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'instrument-detail', ...CTX });
  assert.equal(s.status, 'open', 'filled');
  assert.equal(app.packages.getStrategyRow(s.id).params.origin, 'instrument-detail');
  await advance(app, clock, 1000);
  await app.hedge.processQueue();
  const prompts = app.hedge.prompts(book.id).filter((p) => p.strategyId === s.id || p.strategy_id === s.id || JSON.stringify(p).includes(s.id));
  assert.equal(prompts.length, 1, 'one hedge prompt after the fill');
  // A Strategy-page package (origin 'strategy') does not ask by itself
  const t = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 100, origin: 'strategy', ...CTX });
  assert.equal(t.status, 'open');
  await advance(app, clock, 1000);
  await app.hedge.processQueue();
  assert.equal(app.hedge.prompts(book.id).filter((p) => JSON.stringify(p).includes(t.id)).length, 0);
});
