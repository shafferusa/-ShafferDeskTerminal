// The Terminal's single internal data adapter.
//
// Every screen and every paper-accounting routine that needs an outside fact goes through this
// object. It composes:
//
//   adapter.market      MarketPort    (Shaffer MarketData; "awaiting" until connected; demo feed in demo mode)
//   adapter.analytics   AnalyticsPort (Shaffer Analytics Lab; "awaiting" until connected)
//   manual entries      prices / FX / rates / fixings typed in by the user, always labelled 'manual'
//
// and offers the core a small synchronous read API over what has been fetched or entered
// (price, fx, rate, closeFor, borrowInfo, session). Missing facts are returned as null, never as
// zero. Paper accounting lives elsewhere (server/core); nothing here writes to the ledger, and a
// refresh can only touch the refreshable cache.

import { DEFAULT_CONNECTION, DEFAULT_REFRESH } from '../config.js';
import { dateInTz } from '../core/clock.js';
import { AppError, num } from '../core/util.js';
import { j, pj } from '../db/db.js';
import { createDemoMarketPort } from './demo.js';
import { AWAITING_MESSAGE, makeObservation, midOf, withFreshness } from './observation.js';
import { createAwaitingAnalyticsPort } from './ports.js';
import { createShafferAnalyticsPort, createShafferMarketPort } from './shaffer.js';

const MANUAL_SOURCE = 'Manual entry';
const MANUAL_KINDS = new Set(['price', 'fx', 'rate', 'borrow']);

export function createDataAdapter({ db, config, clock }) {
  let resolveInstrument = () => null;

  // ---- settings -------------------------------------------------------------------------
  const getSetting = (key, fallback) => pj(db.get('SELECT value FROM settings WHERE key = ?', key)?.value, fallback);
  const setSetting = (key, value) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, j(value));

  function getConnection() {
    const saved = getSetting('connection', {});
    const out = { ...DEFAULT_CONNECTION };
    for (const k of Object.keys(DEFAULT_CONNECTION)) {
      if (config.connectionEnv?.[k]) out[k] = config.connectionEnv[k];
      if (saved[k] !== undefined && saved[k] !== '') out[k] = saved[k];
    }
    return out;
  }
  function getRefresh() {
    const saved = getSetting('refresh', {});
    return { ...DEFAULT_REFRESH, ...saved, freshness: { ...DEFAULT_REFRESH.freshness, ...(saved.freshness || {}) } };
  }
  function saveConnection(patch) {
    const cur = getSetting('connection', {});
    for (const k of ['marketDataUrl', 'analyticsUrl', 'gatewayUrl']) {
      if (patch[k] === undefined) continue;
      const v = String(patch[k] || '').trim();
      if (v) {
        let u;
        try { u = new URL(v); } catch { throw new AppError(`"${v}" is not a valid address. Use a full http(s) URL.`); }
        if (!/^https?:$/.test(u.protocol)) throw new AppError('Service addresses must start with http:// or https://');
        if (u.username || u.password) throw new AppError('Do not put credentials in the address. Set SHAFFER_API_TOKEN on the server instead.');
      }
      cur[k] = v;
    }
    if (patch.requestTimeoutMs !== undefined) {
      const t = num(patch.requestTimeoutMs);
      if (!(t >= 1000 && t <= 120000)) throw new AppError('Request timeout must be between 1 and 120 seconds.');
      cur.requestTimeoutMs = t;
    }
    setSetting('connection', cur);
    return getConnection();
  }
  const REFRESH_MIN = { quotesMs: 1000, fxMs: 1000, ratesMs: 10000, referenceMs: 60000, analyticsMs: 10000, engineTickMs: 1000, uiPollMs: 1000 };
  function saveRefresh(patch) {
    const cur = getSetting('refresh', {});
    for (const [k, min] of Object.entries(REFRESH_MIN)) {
      if (patch[k] === undefined) continue;
      const v = num(patch[k]);
      if (!(v >= min)) throw new AppError(`${k} must be at least ${min} ms.`);
      cur[k] = v;
    }
    if (patch.freshness && typeof patch.freshness === 'object') {
      cur.freshness = { ...(cur.freshness || {}) };
      for (const [k, v] of Object.entries(patch.freshness)) {
        const n = num(v);
        if (!(n > 0)) throw new AppError(`Freshness limit for ${k} must be a positive number of seconds.`);
        cur.freshness[k] = n;
      }
    }
    setSetting('refresh', cur);
    return getRefresh();
  }

  // ---- ports ----------------------------------------------------------------------------
  const market = config.demo
    ? createDemoMarketPort({ clock, resolveInstrument: (id) => resolveInstrument(id) })
    : createShafferMarketPort({ getConnection, credentials: config.credentials, clock });
  const analytics = config.demo
    ? createAwaitingAnalyticsPort({ message: `${AWAITING_MESSAGE} (analytics are not simulated in demo mode)` })
    : createShafferAnalyticsPort({ getConnection, credentials: config.credentials, clock });

  // ---- refreshable cache ------------------------------------------------------------------
  const cache = new Map(); // `${kind}|${subject}` -> value
  const lastRefresh = {};
  for (const row of db.all('SELECT kind, subject, data FROM quote_cache')) {
    const v = pj(row.data);
    if (v) cache.set(`${row.kind}|${row.subject}`, v);
  }
  const putCache = (kind, subject, value, persist = true) => {
    if (value === null || value === undefined) return;
    cache.set(`${kind}|${subject}`, value);
    if (persist) {
      db.run('INSERT INTO quote_cache (kind, subject, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, subject) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', kind, subject, j(value), clock.now().toISOString());
    }
  };

  async function safely(label, fn, fallback) {
    try {
      return await fn();
    } catch (err) {
      lastRefresh[`${label}Error`] = String(err.message || err);
      return fallback;
    }
  }

  /**
   * Pull whatever the ports can supply for the given subjects into the cache.
   * With the Shaffer services not yet connected this returns immediately with nothing.
   */
  async function refresh({ instruments = [], pairs = [], rateCodes = [], closes = [], borrow = [], sessions = [], valuations = [], rateRange } = {}) {
    const now = clock.now().toISOString();
    const jobs = [];
    if (instruments.length) {
      jobs.push(safely('prices', () => market.quotes(instruments), new Map()).then((m) => {
        for (const [id, obs] of m) putCache('price', id, obs);
        lastRefresh.prices = now;
      }));
    }
    if (pairs.length) {
      jobs.push(safely('fx', () => market.fx(pairs), new Map()).then((m) => {
        for (const [pair, obs] of m) putCache('fx', pair, obs);
        lastRefresh.fx = now;
      }));
    }
    if (rateCodes.length) {
      jobs.push(safely('rates', () => market.rates(rateCodes, rateRange || {}), new Map()).then((m) => {
        for (const [code, series] of m) {
          if (!series || !series.length) continue;
          const prior = cache.get(`rate|${code}`) || [];
          const byDate = new Map(prior.map((o) => [o.forDate, o]));
          for (const o of series) byDate.set(o.forDate, o);
          const merged = [...byDate.values()].sort((a, b) => (a.forDate < b.forDate ? -1 : 1)).slice(-800);
          putCache('rate', code, merged);
        }
        lastRefresh.rates = now;
      }));
    }
    if (closes.length) {
      const missing = closes.filter((r) => !cache.has(`close|${r.instrument.id}@${r.date}`));
      if (missing.length) {
        jobs.push(safely('closes', () => market.closes(missing), new Map()).then((m) => {
          for (const [key, obs] of m) putCache('close', key, obs);
        }));
      }
    }
    if (borrow.length) {
      jobs.push(safely('borrow', () => market.borrow(borrow), new Map()).then((m) => {
        for (const [id, info] of m) putCache('borrow', id, info, false);
      }));
    }
    if (sessions.length) {
      jobs.push(safely('sessions', () => market.sessions(sessions), new Map()).then((m) => {
        for (const [id, s] of m) putCache('session', id, s, false);
      }));
    }
    if (valuations.length) {
      jobs.push(safely('valuations', () => analytics.valuations(valuations), new Map()).then((m) => {
        for (const [id, obs] of m) putCache('mark', id, obs);
      }));
    }
    await Promise.all(jobs);
  }

  // ---- manual entries ----------------------------------------------------------------------
  const rowToObs = (r) => r && makeObservation({
    id: r.id, kind: r.kind, subject: r.subject, value: r.value, bid: r.bid, ask: r.ask, bidSize: r.bid_size, askSize: r.ask_size,
    currency: r.currency, units: r.units, source: r.source, providerId: r.provider_id, status: r.status, asOf: r.as_of,
    forDate: r.for_date, receivedAt: r.received_at, assumptions: pj(r.data, {}).assumptions || [], extra: { ...(pj(r.data, {}).extra || {}), note: r.note || undefined },
  });

  /** Store a user-entered observation. Earlier entries are kept and marked superseded. */
  function enterManual({ kind = 'price', subject, value, bid, ask, bidSize, askSize, currency, units, asOf, forDate, note, extra }) {
    if (!MANUAL_KINDS.has(kind)) throw new AppError(`Unsupported manual observation kind "${kind}".`);
    if (!subject) throw new AppError('A manual observation needs a subject (instrument, currency pair or rate code).');
    const v = num(value), b = num(bid), a = num(ask);
    if (v === null && (b === null || a === null) && kind !== 'borrow') throw new AppError('Enter a value, or both a bid and an ask.');
    if (b !== null && a !== null && b > a) throw new AppError('Bid cannot be above ask.');
    if (kind !== 'rate' && kind !== 'borrow' && [v, b, a].some((x) => x !== null && x < 0)) throw new AppError('Prices cannot be negative.');
    const nowIso = clock.now().toISOString();
    const value2 = v !== null ? v : b !== null && a !== null ? (b + a) / 2 : null;
    return db.tx(() => {
      const res = db.run(
        `INSERT INTO observations (kind, subject, value, bid, ask, bid_size, ask_size, currency, units, source, provider_id, status, as_of, for_date, received_at, origin, note, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?, ?, 'manual-entry', ?, ?)`,
        kind, subject, value2, b, a, num(bidSize), num(askSize), currency || null, units || null, MANUAL_SOURCE,
        asOf || nowIso, forDate || null, nowIso, note || null, j({ assumptions: ['Manually entered. Not a market quote.'], extra: extra || {} }),
      );
      const id = Number(res.lastInsertRowid);
      db.run(
        `UPDATE observations SET superseded_by = ? WHERE kind = ? AND subject = ? AND origin = 'manual-entry' AND superseded_by IS NULL AND id <> ?
         AND COALESCE(for_date, '') = COALESCE(?, '')`,
        id, kind, subject, id, forDate || null,
      );
      return rowToObs(db.get('SELECT * FROM observations WHERE id = ?', id));
    });
  }

  function latestManual(kind, subject, { forDate, onOrBefore } = {}) {
    if (forDate) {
      return rowToObs(db.get(
        `SELECT * FROM observations WHERE kind = ? AND subject = ? AND origin = 'manual-entry' AND superseded_by IS NULL AND for_date = ? ORDER BY id DESC LIMIT 1`,
        kind, subject, forDate,
      ));
    }
    if (onOrBefore) {
      return rowToObs(db.get(
        `SELECT * FROM observations WHERE kind = ? AND subject = ? AND origin = 'manual-entry' AND superseded_by IS NULL
         AND COALESCE(for_date, substr(as_of, 1, 10)) <= ? ORDER BY COALESCE(for_date, substr(as_of, 1, 10)) DESC, id DESC LIMIT 1`,
        kind, subject, onOrBefore,
      ));
    }
    return rowToObs(db.get(
      `SELECT * FROM observations WHERE kind = ? AND subject = ? AND origin = 'manual-entry' AND superseded_by IS NULL ORDER BY COALESCE(as_of, received_at) DESC, id DESC LIMIT 1`,
      kind, subject,
    ));
  }

  // ---- used observations ---------------------------------------------------------------------
  const usedIds = new Map();
  /** Persist the exact observation used for a fill, a posting or a valuation; returns its id. */
  function recordUsed(obs) {
    if (!obs) return null;
    if (obs.id) return obs.id;
    const key = [obs.providerId, obs.kind, obs.subject, obs.asOf, obs.forDate, obs.value, obs.bid, obs.ask].join('|');
    const hit = usedIds.get(key);
    if (hit) return hit;
    const res = db.run(
      `INSERT INTO observations (kind, subject, value, bid, ask, bid_size, ask_size, currency, units, source, provider_id, status, as_of, for_date, received_at, origin, note, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'used', NULL, ?)`,
      obs.kind, obs.subject, obs.value, obs.bid, obs.ask, obs.bidSize, obs.askSize, obs.currency, obs.units, obs.source, obs.providerId,
      obs.status, obs.asOf, obs.forDate, obs.receivedAt || clock.now().toISOString(), j({ assumptions: obs.assumptions || [], extra: obs.extra || {}, delayMinutes: obs.delayMinutes ?? null }),
    );
    const id = Number(res.lastInsertRowid);
    if (usedIds.size > 5000) usedIds.clear();
    usedIds.set(key, id);
    return id;
  }
  const getObservation = (id) => rowToObs(db.get('SELECT * FROM observations WHERE id = ?', id));

  // ---- synchronous reads for the core ----------------------------------------------------------
  /** Current price observation for an instrument: connected feed, else model valuation, else manual entry. */
  function price(instrumentId) {
    return cache.get(`price|${instrumentId}`) || cache.get(`mark|${instrumentId}`) || latestManual('price', instrumentId) || null;
  }

  /** Official close / fixing for a business date, or null if none is known yet. */
  function closeFor(instrumentId, date) {
    const c = cache.get(`close|${instrumentId}@${date}`);
    if (c) return c;
    const dated = latestManual('price', instrumentId, { forDate: date });
    if (dated) return dated;
    const live = cache.get(`price|${instrumentId}`);
    if (live && live.asOf && dateInTz(new Date(live.asOf)) === date && dateInTz(clock.now()) > date) return { ...live, forDate: date };
    const m = latestManual('price', instrumentId);
    if (m && m.asOf && dateInTz(new Date(m.asOf)) === date) return { ...m, forDate: date };
    return null;
  }

  function fxDirect(pair) {
    return cache.get(`fx|${pair}`) || latestManual('fx', pair) || null;
  }
  /**
   * Conversion rate: units of `to` per 1 unit of `from`.
   * Returns { rate, obs } or null when no observation (direct, inverse or via USD) exists.
   */
  function fx(from, to) {
    if (from === to) return { rate: 1, obs: null, identity: true };
    const d = fxDirect(`${from}/${to}`);
    if (d && midOf(d) > 0) return { rate: midOf(d), obs: d };
    const inv = fxDirect(`${to}/${from}`);
    if (inv && midOf(inv) > 0) {
      const rate = 1 / midOf(inv);
      return { rate, obs: { ...inv, id: undefined, subject: `${from}/${to}`, value: rate, bid: inv.ask ? 1 / inv.ask : null, ask: inv.bid ? 1 / inv.bid : null, units: `${to} per ${from}`, currency: to, assumptions: [...(inv.assumptions || []), `Inverse of ${to}/${from}`] } };
    }
    if (from !== 'USD' && to !== 'USD') {
      const a = fx(from, 'USD'), b = fx('USD', to);
      if (a && b) {
        const rate = a.rate * b.rate;
        const older = !a.obs ? b.obs : !b.obs ? a.obs : (a.obs.asOf || '') < (b.obs.asOf || '') ? a.obs : b.obs;
        return { rate, obs: { ...older, id: undefined, subject: `${from}/${to}`, value: rate, bid: null, ask: null, units: `${to} per ${from}`, currency: to, assumptions: [`Cross rate via USD (${from}/USD x USD/${to})`] } };
      }
    }
    return null;
  }

  /** Reference-rate observation (percent p.a.) in force on a date: latest observation on or before it. */
  function rate(code, date) {
    const d = date || clock.today();
    const series = cache.get(`rate|${code}`);
    let best = null;
    if (series) {
      for (const o of series) if (o.forDate <= d) best = o;
    }
    const manual = latestManual('rate', code, { onOrBefore: d });
    if (manual && (!best || (manual.forDate || manual.asOf.slice(0, 10)) > best.forDate)) return manual;
    return best || null;
  }

  /** Borrow availability and fee for an instrument, or null when nothing is known. */
  function borrowInfo(instrumentId) {
    const c = cache.get(`borrow|${instrumentId}`);
    if (c) return c;
    const m = latestManual('borrow', instrumentId);
    if (!m) return null;
    return { available: m.extra.available !== false, quantity: m.extra.quantity ?? null, feeRate: (m.value ?? 0) / 100, rebateRate: 0, obs: m };
  }

  const session = (instrumentId) => cache.get(`session|${instrumentId}`) || null;

  // ---- description for the UI --------------------------------------------------------------------
  function describe() {
    const conn = getConnection();
    return {
      mode: config.demo ? 'demo' : 'shaffer',
      awaitingMessage: AWAITING_MESSAGE,
      market: market.state(),
      analytics: analytics.state(),
      connection: conn,
      connectionFromEnv: { marketDataUrl: Boolean(config.connectionEnv?.marketDataUrl), analyticsUrl: Boolean(config.connectionEnv?.analyticsUrl), gatewayUrl: Boolean(config.connectionEnv?.gatewayUrl) },
      credentialsConfigured: Boolean(config.credentials?.hasToken),
      refresh: getRefresh(),
      lastRefresh,
      manualEntries: db.get(`SELECT COUNT(*) AS n FROM observations WHERE origin = 'manual-entry' AND superseded_by IS NULL`).n,
    };
  }

  /** True when a live (non-manual) price feed exists. */
  const marketConnected = () => ['connected', 'demo'].includes(market.state().connection);

  return {
    market, analytics,
    setInstrumentResolver: (fn) => { resolveInstrument = fn; },
    getConnection, getRefresh, saveConnection, saveRefresh,
    refresh, price, closeFor, fx, rate, borrowInfo, session,
    enterManual, latestManual, recordUsed, getObservation,
    present: (obs) => withFreshness(obs, clock.ms(), getRefresh().freshness),
    describe, marketConnected,
    getSetting, setSetting,
    _cache: cache,
  };
}
