// A World: one disposable Terminal (in-process at engine level, a server process at API and browser
// level) in its own sandbox, with the helpers the cases share. Built only from the product
// matrix's harness: createSandbox / assertSandbox, the engine and API drivers and startServer.
// Nothing here can open a database outside a sandbox this process created.
//
// The same case body runs at engine and API level because both drivers expose `http` (every API
// route; in-process handlers at engine level, real HTTP at API level) with the same answers.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openApiTerminal } from '../../matrix/drivers/api.mjs';
import { openEngineTerminal } from '../../matrix/drivers/engine.mjs';
import { assertSandbox, createSandbox, destroySandbox } from '../../matrix/lib/sandbox.mjs';

// Calendar used by the cases (checked by hand): Monday 2 March 2026 to Tuesday 10 March 2026 has no US, UK,
// TARGET or Japanese holiday. US clocks move to daylight time on Sunday 8 March, so 10:00 New York is
// 15:00 UTC up to 6 March and 14:00 UTC from 9 March. Good Friday is 3 April 2026 (NYSE closed).
export const MON = '2026-03-02T15:00:00.000Z';
export const TUE = '2026-03-03T15:00:00.000Z';
export const WED = '2026-03-04T15:00:00.000Z';
export const THU = '2026-03-05T15:00:00.000Z';
export const FRI = '2026-03-06T15:00:00.000Z';
export const SAT = '2026-03-07T15:00:00.000Z';
export const MON2 = '2026-03-09T14:00:00.000Z';
export const TUE2 = '2026-03-10T14:00:00.000Z';
/** 17:30 New York on a March weekday before the 8th: after the end-of-day cutoff (17:00). */
export const evening = (date) => `${date}T${date < '2026-03-08' || date >= '2026-11-01' ? '22' : '21'}:30:00.000Z`;

/** Paper-desk assumptions every case starts from, stated in full so no figure rests on a default. */
export const SETTINGS = {
  fees: { equity: { perUnit: 0.005, minimum: 1, bps: 0 }, option: { perUnit: 0.65, minimum: 0, bps: 0 }, future: { perUnit: 2.25, minimum: 0, bps: 0 }, fx: { perUnit: 0, minimum: 0, bps: 0 }, bond: { perUnit: 0, minimum: 0, bps: 0 }, swap: { perUnit: 0, minimum: 0, bps: 0 } },
  fill: { halfSpreadBps: { equity: 2 }, slippageBps: 0, participation: 1, maxQuoteAgeSec: 120, allowEndOfDayFills: false },
  settlement: { equity: 1, foreignCash: 2, fx: 2, option: 1, bond: 1 },
  short: { collateralPct: 1.02, marginPct: 0.3 },
  dividends: { withholdingPct: 0 },
};

const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

export async function openWorld(level, { label = 'case', at = MON, demo = true, engine = 'off', dbByMode = false, browser = null } = {}) {
  const sandboxes = [];
  const terminals = [];
  const serverErrors = [];
  const cleanups = [];

  async function openTerminal({ at: at2 = at, demo: demo2 = demo, engine: engine2 = engine, dbByMode: byMode = dbByMode, sandbox = null, tag = label } = {}) {
    const sb = sandbox || createSandbox(`sys-${level}-${tag}`);
    if (!sandbox) sandboxes.push(sb);
    const t = level === 'engine'
      ? await openEngineTerminal({ sandbox: sb, at: at2, demo: demo2 })
      : await openApiTerminal({ sandbox: byMode ? { ...sb, dbFile: `${sb.dir}/${demo2 ? 'demo.db' : 'terminal.db'}` } : sb, at: at2, demo: demo2, engine: engine2, dbByMode: byMode });
    terminals.push(t);
    return wrap(t, sb, { demo: demo2 });
  }

  /** The helpers around one terminal. */
  function wrap(t, sandbox, { demo: isDemo }) {
    const w = {
      level, t, sandbox, demo: isDemo, serverErrors,
      /** Any API route. Never throws for a refusal: returns { ok, status, code, error, details, body }. A 5xx is recorded and fails the case. */
      async req(method, path, body, query) {
        const m = method.toUpperCase();
        try {
          const out = m === 'GET' ? await t.http.get(path, query) : m === 'POST' ? await t.http.post(path, body ?? {}) : m === 'PUT' ? await t.http.put(path, body ?? {}) : await t.http.del(path);
          return { ok: true, status: 200, body: out };
        } catch (err) {
          if (typeof err.status === 'number') {
            if (err.status >= 500) serverErrors.push(`${m} ${path} -> ${err.status} ${err.message}`);
            return { ok: false, status: err.status, code: err.code ?? null, error: err.message, details: err.details ?? null, body: null };
          }
          // Engine level: an error that is not an AppError is what the HTTP layer answers with a 500.
          if (level === 'engine' && !/^No route /.test(err.message || '')) { serverErrors.push(`${m} ${path} -> unhandled ${err.stack || err.message}`); return { ok: false, status: 500, code: null, error: String(err.message || err), details: null, body: null }; }
          if (level === 'engine') return { ok: false, status: 404, code: null, error: 'Not found', details: null, body: null };
          throw err;
        }
      },
      /** A route that must succeed. */
      async must(method, path, body, query) {
        const r = await w.req(method, path, body, query);
        if (!r.ok) throw new Error(`${method} ${path} was refused (${r.status} ${r.code || ''}): ${r.error}`);
        return r.body;
      },
      get: (path, query) => w.must('GET', path, undefined, query),
      post: (path, body) => w.must('POST', path, body),
      put: (path, body) => w.must('PUT', path, body),

      // ---- setting up ---------------------------------------------------------------------------------
      /** A Book with capital in Treasury and one funded Account. Returns { id, treasuryId, accountId, name }. */
      async book(name, { capital = 1_000_000, funding = 500_000, ccy = 'USD', reportingCcy = 'USD', account = 'Alpha', settings = SETTINGS } = {}) {
        const b = await w.post('/api/books', { name, reportingCcy });
        const treasuryId = b.units.find((u) => u.kind === 'treasury').id;
        if (settings) await w.put(`/api/books/${b.id}`, { settings });
        if (capital) await w.post(`/api/books/${b.id}/capital`, { type: 'deposit', ccy, amount: capital, note: 'System suite starting capital' });
        let accountId = null;
        if (account) {
          accountId = (await w.post(`/api/books/${b.id}/accounts`, { name: account })).id;
          if (funding) await w.post(`/api/books/${b.id}/transfers`, { fromUnitId: treasuryId, toUnitId: accountId, ccy, amount: funding, purpose: 'System suite funding' });
        }
        return { id: b.id, name, treasuryId, accountId };
      },
      instrument: (draft) => w.post('/api/instruments', draft),
      /** A fictional NYSE common stock with a quote fixture. */
      async stock(symbol, quote = { bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000 }, draft = {}) {
        const inst = await w.instrument({ productId: 'common_stock', name: `${symbol} Test Works Inc.`, symbol, marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', issuer: `${symbol} Test Works Inc.`, domicile: 'US', underlyingGeo: 'US', tradingCcy: 'USD', terms: {}, ...draft });
        if (quote) await w.fixture('quote', { instrumentId: inst.id, ...quote });
        return inst;
      },
      fixture: (kind, body) => w.post(`/api/demo/fixtures/${kind}`, body),
      clock: (iso) => t.setClock(iso),
      tick: () => t.tick(),
      /**
       * Stop the Terminal and start it again on the same database. Nothing else happens: no engine cycle runs and
       * the clock is not touched (the demo clock persists by itself), so what is read after is what was stored.
       */
      async restart() {
        if (level === 'engine') return t.restart();
        await t.server.stop();
        await t.start();
        return undefined;
      },

      // ---- trading, the way the screens do it --------------------------------------------------------------
      preview: (input) => w.req('POST', '/api/strategies/preview', input),
      /** The confirmation the preview dialog sends: the previewed legs, the token, and the figures that were displayed. */
      confirmBody: (pv, extra = {}) => ({ ...pv.input, ...extra, legs: pv.legs, clientToken: pv.token, confirm: true, expected: { ...(pv.confirmation || {}), cash: Object.fromEntries(Object.values(pv.totals.cash || {}).map((r) => [r.ccy, r.required])) } }),
      confirm: (pv, extra) => w.req('POST', '/api/strategies', w.confirmBody(pv, extra)),
      /** The request a security ticket builds for a buy or (with a borrow leg) a short sale. */
      ticketInput(book, inst, side, qty, { unitId = book.accountId, order = {}, borrow = null, financing = null } = {}) {
        const o = { orderType: order.orderType || 'market', limitPrice: order.limitPrice ?? null, stopPrice: order.stopPrice ?? null, tif: order.tif || 'day', statedPrice: order.statedPrice ?? null, ...(order.settle ? { settle: order.settle } : {}) };
        const legs = side === 'sell_short'
          ? [{ kind: 'borrow_sec', action: 'borrow_sec', instrumentId: inst.id, qty, purpose: 'financing', role: 'borrow', borrow, note: 'Simulated securities borrow. The short sale cannot execute without it.' },
            { kind: 'trade', action: 'sell_short', instrumentId: inst.id, qty, role: 'underlying', dependsOn: [1], ...o }]
          : [{ kind: 'trade', action: side, instrumentId: inst.id, qty, role: 'underlying', ...o }];
        return { bookId: book.id, unitId, template: side === 'buy' ? 'long' : side === 'sell_short' ? 'short' : 'custom', underlyingId: inst.id, legs, origin: 'marketplace', financing, investmentStrategy: null, holdingPeriod: null, hedgeObjective: null };
      },
      /** Preview and confirm; throws unless both go through. Returns the strategy view. */
      async trade(input) {
        const pv = await w.post('/api/strategies/preview', input);
        if (pv.blocking) throw new Error(`Preview blocked: ${pv.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | ')}`);
        const out = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        return out.strategy;
      },
      buy: (book, inst, qty, opts) => w.trade(w.ticketInput(book, inst, 'buy', qty, opts)),
      short: (book, inst, qty, opts) => w.trade(w.ticketInput(book, inst, 'sell_short', qty, opts)),
      /** Close (part of) a strategy instance: preview-action then confirm. */
      async closeOut(strategyId, args = {}) {
        const pv = await w.post(`/api/strategies/${strategyId}/preview-action`, { action: 'close', ...args });
        if (pv.blocking) throw new Error(`Close preview blocked: ${pv.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | ')}`);
        return (await w.must('POST', '/api/strategies', w.confirmBody(pv))).strategy;
      },
      strategy: (id) => w.get(`/api/strategies/${id}`),

      // ---- reading the books ----------------------------------------------------------------------------------
      integrity: (bookId) => w.get(`/api/books/${bookId}/integrity`),
      /** Must be clean; reports each problem. Returns the report. */
      async clean(c, bookId, label = 'integrity') {
        const r = await w.integrity(bookId);
        c.ok(r.ok, `${label}: the integrity check is clean`, r.problems.join(' | '));
        return r;
      },
      /**
       * What "the books" are for a Book: ledger balances by owner, account and currency, positions, cash, pending
       * settlements and open orders; plus the stored row counts. Two of these compare with sameBooks / sameRows.
       */
      async books(bookId) {
        const [integ, pos, pend] = await Promise.all([w.integrity(bookId), w.get(`/api/books/${bookId}/accounting/positions`, { scope: 'book' }), w.get(`/api/books/${bookId}/accounting/pending`, { scope: 'book' })]);
        return {
          ok: integ.ok, problems: integ.problems, counts: integ.counts,
          ledger: {
            trial: integ.trialBalance,
            positions: pos.positions.map((p) => ({ id: p.positionId, qty: p.qty, cost: p.cost })).sort((a, b) => (a.id < b.id ? -1 : 1)),
            cash: pos.cash.map((x) => ({ owner: x.owner.id, ccy: x.ccy, settled: x.settled, restricted: x.restricted, margin: x.margin, reserved: x.reserved, receivable: x.receivable, payable: x.payable })).sort((a, b) => (`${a.owner}${a.ccy}` < `${b.owner}${b.ccy}` ? -1 : 1)),
          },
          pending: pend,
        };
      },
      /** One owner's cash in one currency (zeros when the owner holds none). */
      async cash(bookId, unitId, ccy = 'USD') {
        const pos = await w.get(`/api/books/${bookId}/accounting/positions`, { scope: 'book' });
        return pos.cash.find((x) => x.owner.id === unitId && x.ccy === ccy) || { ccy, settled: 0, restricted: 0, margin: 0, receivable: 0, payable: 0, reserved: 0, unsettled: 0, availableToTrade: 0, availableToWithdraw: 0, borrowed: 0, lent: 0 };
      },
      /** A ledger balance of one owner (debit positive), from the integrity report's trial balance. */
      async balance(bookId, unitId, account, ccy = 'USD') {
        return (await w.integrity(bookId)).trialBalance[unitId]?.accounts?.[account]?.[ccy] ?? 0;
      },
      /** The ledger, positions and cash are exactly as before (an audit event without entries may have been added). */
      sameBooks(c, before, after, label) { return c.eq(after.ledger, before.ledger, `${label}: ledger balances, positions and cash are unchanged`); },
      /** Not one stored row was added: events, entries, orders, fills, settlements, positions, strategies, hedge requests, tasks. */
      sameRows(c, before, after, label) { return c.eq(after.counts, before.counts, `${label}: no stored row was added`); },

      // ---- reading the database itself ---------------------------------------------------------------------------
      /** Read rows straight from the sandbox database (read-only at API level). */
      sql(query, ...params) {
        if (level === 'engine') return t.app.db.all(query, ...params);
        assertSandbox(sandbox);
        const file = t.server?.database || sandbox.dbFile;
        const db = new DatabaseSync(file, { readOnly: true });
        try { return db.prepare(query).all(...params); } finally { db.close(); }
      },
      /**
       * A fingerprint of everything stored (every table of the paper books, the registry and the settings), with
       * time stamps left out so that only content counts. Two fingerprints compare with c.eq: any added, removed or
       * changed row shows up by table.
       */
      fingerprint() {
        const skip = new Set(['quote_cache', 'request_tokens', 'engine_state', 'schema_migrations', 'snapshots', 'sqlite_sequence']);
        const stamps = new Set(['ts', 'updated_at', 'created_at', 'received_at', 'applied_at', 'done_at', 'settled_at', 'released_at', 'resolved_at', 'closed_at', 'opened_at', 'ended_at']);
        const out = {};
        for (const { name } of w.sql(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)) {
          if (skip.has(name)) continue;
          let rows = w.sql(`SELECT * FROM ${name} ORDER BY rowid`);
          if (name === 'settings') rows = rows.filter((r) => r.key !== 'demo.clockOffsetMs');
          if (name === 'observations') rows = rows.filter((r) => r.origin === 'manual-entry');
          // The demo environment tops up its own fictional futures chain from the clock each time it starts; those
          // registry rows are its fixtures, not paper history. Everything a case registers itself is compared.
          if (name === 'instruments') rows = rows.filter((r) => r.ref_source !== 'demo');
          // A hedge request's stored request and response carry observation times; its identity and status are what count here.
          const drop = name === 'hedge_requests' ? new Set([...stamps, 'request', 'response', 'message']) : stamps;
          const slim = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k))));
          out[name] = `${rows.length} rows ${sha(slim).slice(0, 12)}`;
        }
        return out;
      },
      /** Two fingerprints must be equal; a difference is reported by table. */
      sameStored(c, before, after, label) {
        const diff = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]).map((k) => `${k}: ${before[k]} -> ${after[k]}`);
        return c.ok(diff.length === 0, label, diff.join('; '));
      },
      /** One hash per table over all its rows (or the rows `where` selects), in primary-key order. */
      hashTables(tables, { where = {} } = {}) {
        const out = {};
        for (const tb of tables) {
          const rows = w.sql(`SELECT * FROM ${tb} ${where[tb] ? `WHERE ${where[tb]}` : ''} ORDER BY rowid`);
          out[tb] = { rows: rows.length, hash: sha(rows) };
        }
        return out;
      },
    };
    return w;
  }

  const main = await openTerminal();
  Object.assign(main, {
    /** Another Terminal in its own sandbox (or on a given sandbox), closed with this world. */
    open: openTerminal,
    browser,
    defer: (fn) => cleanups.push(fn),
    async close() {
      for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } }
      for (const t of terminals) { try { await t.close(); } catch { /* already stopped */ } }
      for (const sb of sandboxes) destroySandbox(sb);
    },
  });
  return main;
}
