// HTTP routes of the server client (docs/SERVER-CLIENT.md). Registered from api.js; additive to the existing routes.
//
// Every data route answers the response envelope built by data/server-client.js. Instruments are resolved here
// (the Terminal's ID or a server ID); everything else is passed through as the server (or the labelled demo
// fixture) supplied it. No route here computes a fair value, a gap, a score or a signal, and none writes to the
// paper ledger except POST /api/server/corporate-actions/record, which records a user-chosen event once.

import { Readable } from 'node:stream';
import { AppError, need } from './core/util.js';
import { SERVER_DATASETS } from './data/ports.js';

export const RAW_RESPONSE = Symbol.for('sdt.rawResponse');
const DOC_TYPES = /^(application\/pdf|text\/html|text\/plain|application\/xhtml\+xml)/i;

export function registerServerRoutes(r, app, { requireVisible }) {
  const S = app.data.server;
  const { instruments } = app;

  /** Terminal ID first, then a server ID (external_ids.shaffer, or the demo fixture IDs). */
  function resolve(id, bookId) {
    const direct = instruments.get(id);
    if (direct) return requireVisible(direct.id, bookId);
    const byExt = instruments.list({ limit: 5000 }).find((i) => i.external_ids?.shaffer === id);
    if (byExt) return requireVisible(byExt.id, bookId);
    const byFixture = S.fixtures?.resolveServerId?.(id);
    if (byFixture) return requireVisible(byFixture.id, bookId);
    return null;
  }
  const requireInst = (id, bookId) => {
    const inst = resolve(id, bookId);
    need(inst, `No instrument with ID "${id}" in the Terminal's registry.`, { status: 404 });
    return inst;
  };
  const opts = (q, extra = {}) => ({
    requestId: q.requestId || undefined, selection: q.selection || undefined, channel: q.channel || undefined,
    asOf: q.asOf || undefined, fresh: q.fresh === '1' || q.fresh === 'true', cursor: q.cursor || undefined,
    page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    waitMs: q.waitMs ? Math.min(Math.max(Number(q.waitMs) || 0, 0), 30000) : undefined, ...extra,
  });
  const all = (q) => q.all === '1' || q.all === 'true';
  const run = (ds, params, q, extra) => (all(q) ? S.collect(ds, params, opts(q, extra)) : S.call(ds, params, opts(q, extra)));
  const withIds = (env, inst) => ({ ...env, instrument: inst ? { terminalId: inst.id, symbol: inst.symbol, name: inst.name, family: inst.family, ids: S.fixtures?.idsOf?.(inst) || { terminal: inst.id, server: inst.external_ids?.shaffer ?? null, issuer: null, contract: null } } : null });

  // ---- connection state, refresh, cache ----
  r.get('/api/server/state', () => S.state());
  r.get('/api/server/datasets', () => ({ datasets: SERVER_DATASETS }));
  r.get('/api/server/refresh', () => ({ refresh: S.refreshSettings() }));
  r.put('/api/server/refresh', ({ body }) => {
    try { return { refresh: S.saveRefresh(body || {}) }; } catch (err) { throw new AppError(err.message, { status: err.status || 400 }); }
  });
  r.post('/api/server/cache/invalidate', ({ body }) => {
    if (body?.dataset) need(SERVER_DATASETS[body.dataset], `Unknown dataset "${body.dataset}".`, { status: 404 });
    return { invalidated: S.invalidate({ dataset: body?.dataset, instrumentId: body?.instrumentId }) };
  });
  // Testing the connection is the moment a refused (401/403) dataset may be tried again.
  r.post('/api/server/test', async () => {
    S.clearAuthBlocks();
    const [market, analytics] = await Promise.all([app.data.market.testConnection(), app.data.analytics.testConnection()]);
    return { market, analytics, state: S.state() };
  });

  // ---- market interface ----
  r.get('/api/server/reference/search', async ({ query }) => {
    const q = String(query.q || '').trim();
    return run('search', { q, limit: Number(query.limit) || 20, marketView: query.view || undefined }, query);
  });
  r.get('/api/server/reference/:id', async ({ params, query }) => {
    const inst = resolve(params.id, query.bookId);
    const serverId = inst ? inst.external_ids?.shaffer ?? S.fixtures?.idsOf?.(inst)?.server ?? null : params.id;
    const env = await S.call('reference', { instrument: inst || undefined, serverId }, opts(query, { instrumentId: inst?.id }));
    // The Terminal's own registry facts stay alongside, marked as such: the mapping between the two IDs.
    return { ...withIds(env, inst), registered: Boolean(inst), terminal: inst ? instruments.toView(inst) : null };
  });
  r.get('/api/server/quotes', async ({ query }) => {
    const ids = String(query.ids || '').split(',').filter(Boolean).slice(0, 300);
    const insts = ids.map((id) => resolve(id, query.bookId)).filter(Boolean);
    const env = await S.call('quotes', { instruments: insts }, opts(query));
    const unknown = ids.filter((id) => !resolve(id, query.bookId));
    if (unknown.length) env.coverage = { ...env.coverage, missing: [...env.coverage.missing, ...unknown.map((u) => `unknown instrument ${u}`)] };
    return env;
  });
  r.get('/api/server/history/:id', async ({ params, query }) => {
    const inst = requireInst(params.id, query.bookId);
    return withIds(await run('history', { instrument: inst, from: query.from || undefined, to: query.to || undefined, interval: query.interval || '1d', adjusted: query.adjusted === '1' || query.adjusted === 'true' }, query, { instrumentId: inst.id }), inst);
  });
  r.get('/api/server/fx', async ({ query }) => {
    const pairs = String(query.pairs || '').split(',').filter((p) => /^[A-Z]{3}\/[A-Z]{3}$/.test(p)).slice(0, 60);
    return S.call('fx', { pairs }, opts(query));
  });
  r.get('/api/server/rates', async ({ query }) => {
    const codes = String(query.codes || '').split(',').filter(Boolean).slice(0, 40);
    return S.call('rates', { codes, from: query.from || undefined, to: query.to || undefined }, opts(query));
  });
  const perInstrument = (path, ds, paramsOf = () => ({})) => r.get(path, async ({ params, query }) => {
    const inst = requireInst(params.id, query.bookId);
    return withIds(await run(ds, { instrument: inst, ...paramsOf(query) }, query, { instrumentId: inst.id }), inst);
  });
  perInstrument('/api/server/profile/:id', 'profile');
  perInstrument('/api/server/statements/:id', 'statements', (q) => ({ statement: ['income', 'balance', 'cashflow'].includes(q.statement) ? q.statement : 'income', period: ['quarterly', 'annual', 'ttm'].includes(q.period) ? q.period : 'quarterly', periods: Math.min(Number(q.periods) || 12, 40) }));
  perInstrument('/api/server/earnings/:id', 'earnings', (q) => ({ from: q.from || undefined, to: q.to || undefined }));
  perInstrument('/api/server/filings/:id', 'filings', (q) => ({ kind: q.kind || undefined }));
  perInstrument('/api/server/news/:id', 'news', (q) => ({ from: q.from || undefined }));
  // p1: product-specific detail pages (docs/SERVER-CLIENT.md, section 3); supplied values passed through as received.
  perInstrument('/api/server/ratings/:id', 'ratingsCovenants');
  perInstrument('/api/server/yield-spread/:id', 'yieldSpread');
  perInstrument('/api/server/option-greeks/:id', 'optionGreeks');
  perInstrument('/api/server/futures-curve/:id', 'futuresCurve');
  perInstrument('/api/server/margin/:id', 'exchangeMargin');
  perInstrument('/api/server/fund-holdings/:id', 'fundHoldings');
  perInstrument('/api/server/fund-facts/:id', 'fundFacts');
  perInstrument('/api/server/marks/:id', 'otcMarks', (q) => ({ from: q.from || undefined, to: q.to || undefined }));
  perInstrument('/api/server/fx-curve/:id', 'fxCurve');

  r.get('/api/server/corporate-actions/:id', async ({ params, query }) => {
    const inst = requireInst(params.id, query.bookId);
    const env = await run('corporateActions', { instrument: inst, from: query.from || undefined, to: query.to || undefined }, query, { instrumentId: inst.id });
    if (Array.isArray(env.items)) {
      // One row per event: a second delivery of the same event (same idempotency key) is counted, not listed twice.
      const byKey = new Map();
      for (const ev of env.items) {
        const key = app.serverLedger.corporateActionKey(inst.id, ev);
        const seen = byKey.get(key);
        if (seen) { seen.deliveries++; continue; }
        byKey.set(key, { ...ev, idempotencyKey: key, deliveries: 1, recordable: ['cash_dividend', 'split'].includes(ev.type), recorded: app.serverLedger.recordedFor(inst.id, ev) });
      }
      env.items = [...byKey.values()];
      env.note = 'Informational events from the server. Recording one in the paper ledger is a separate, explicit action; the same event is never posted twice.';
    }
    return withIds(env, inst);
  });
  r.post('/api/server/corporate-actions/record', async ({ body }) => {
    need(body.instrumentId && (body.eventId || body.event), 'instrumentId and eventId are required.');
    const inst = requireInst(body.instrumentId, body.bookId);
    let ev = null;
    let source = null;
    if (body.eventId) {
      const env = await S.call('corporateActions', { instrument: inst }, { instrumentId: inst.id });
      need(Array.isArray(env.items) && env.state !== 'error' && env.state !== 'awaiting', `The corporate-action list is not available (${env.state}): ${env.message || ''}`, { status: 409 });
      ev = env.items.find((x) => x.eventId === body.eventId) || null;
      source = env.source;
    }
    need(ev, 'That event is not in the server\'s corporate-action list for this instrument.', { status: 404 });
    const out = app.serverLedger.recordCorporateAction(inst.id, ev, source);
    if (out.recorded) app.engine.emit({ type: 'changed', summary: { corporateActionRecorded: 1 } });
    return out;
  });

  r.get('/api/server/documents/:docId', async ({ params, query }) => {
    const out = await S.document(params.docId, { requestId: query.requestId });
    if (out.envelope) return out.envelope;
    const doc = out.document;
    const type = String(doc.mediaType || '');
    if (!DOC_TYPES.test(type)) return { state: 'error', dataset: 'documents', operation: 'market.document', error: { code: 'unsupported-media', message: `Documents of type ${type || 'unknown'} are not displayed.`, retryable: false }, requestId: query.requestId || null };
    const headers = {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      // A proxied document is shown as a document: no scripts, no navigation away, no forms.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'Content-Disposition': `inline; filename="${String(doc.filename || params.docId).replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'X-SDT-Source': out.source?.label || '',
    };
    let body = doc.body;
    if (body && typeof body.getReader === 'function') body = Readable.fromWeb(body);
    return { [RAW_RESPONSE]: { status: 200, headers, body } };
  });

  // ---- analytics interface ----
  perInstrument('/api/server/analytics/:id', 'analytics', (q) => ({ strategyId: q.strategyId || undefined, runId: q.runId || undefined }));
  perInstrument('/api/server/analytics/:id/runs', 'analyticsRuns', (q) => ({ strategyId: q.strategyId || undefined }));
  perInstrument('/api/server/earnings-window/:id', 'earningsWindow', (q) => ({ strategyId: q.strategyId || undefined }));

  // ---- ledger interface (local) ----
  r.get('/api/server/ledger/:id', async ({ params, query }) => {
    need(query.bookId, 'bookId is required.');
    const inst = requireInst(params.id, query.bookId);
    return withIds(await S.call('ledger', { instrument: inst, bookId: query.bookId }, opts(query, { fresh: true, instrumentId: inst.id })), inst);
  });

  // ---- demo fixture controls (demo only) ----
  const fx = () => {
    need(app.config.demo && S.fixtures, 'Server fixtures exist only in demo mode.', { status: 403 });
    return S.fixtures;
  };
  r.get('/api/demo/fixtures/server', () => fx().list());
  r.post('/api/demo/fixtures/server', ({ body }) => {
    const f = fx();
    const out = body?.reset ? f.reset() : f.setMode(body?.dataset || 'all', body?.mode || 'available', body?.delayMs);
    app.engine.emit({ type: 'changed', summary: { serverFixture: body?.reset ? 'reset' : `${body?.dataset}:${body?.mode}` } });
    return out;
  });
}
