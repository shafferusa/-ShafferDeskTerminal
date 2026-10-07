// Shaffer service clients (MarketData and Analytics Lab).
//
// This is the skeleton that will carry the real integration. It owns the transport concerns
// (configured address or approved gateway, server-side credentials, timeouts, health tracking) and
// delegates every data operation to shaffer-contract.js. While an operation there is null the
// port reports "awaiting" for it. No endpoint is assumed here.

import { AWAITING_MESSAGE, unavailable } from './observation.js';
import { ANALYTICS_DATASETS, MARKET_DATASETS, datasetStates } from './ports.js';
import { analyticsContract, marketContract } from './shaffer-contract.js';

function createTransport({ getAddress, credentials, timeoutMs, clock }) {
  const health = { lastChecked: null, lastSuccess: null, lastError: null };
  async function request(method, path, { query, body } = {}) {
    const base = getAddress();
    if (!base) throw new Error('No service address configured');
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Accept: 'application/json' };
    // Credentials stay on the application server; they are attached here and never sent to the browser.
    if (credentials.token) headers[credentials.header] = credentials.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    health.lastChecked = clock.now().toISOString();
    try {
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs()) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.host}`);
      health.lastSuccess = health.lastChecked;
      health.lastError = null;
      return text ? JSON.parse(text) : null;
    } catch (err) {
      health.lastError = String(err.message || err);
      throw err;
    }
  }
  return {
    health,
    http: { get: (path, opts) => request('GET', path, opts), post: (path, body, opts) => request('POST', path, { ...opts, body }) },
    /** Reachability only: any HTTP response from the configured address counts as reachable. */
    async probe() {
      const base = getAddress();
      if (!base) return { ok: false, reachable: false, detail: 'No service address configured.' };
      health.lastChecked = clock.now().toISOString();
      try {
        const headers = {};
        if (credentials.token) headers[credentials.header] = credentials.token;
        const res = await fetch(base, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs()) });
        // Reachable is not the same as connected: lastSuccess is only set by a real data request.
        health.lastError = null;
        return { ok: res.ok, reachable: true, httpStatus: res.status, detail: `Reached ${new URL(base).host} (HTTP ${res.status}).` };
      } catch (err) {
        health.lastError = String(err.message || err);
        return { ok: false, reachable: false, detail: `Could not reach the configured address: ${health.lastError}.` };
      }
    },
  };
}

function makeCtx(clock) {
  return {
    now: () => clock.now().toISOString(),
    extId: (instrument) => instrument?.external_ids?.shaffer ?? null,
  };
}

function baseState({ address, contract, names, transport, datasetInfo }) {
  const anyOp = Object.entries(contract).some(([k, v]) => v && k !== 'datasets' && k !== 'health');
  let connection = 'awaiting';
  let message = AWAITING_MESSAGE;
  if (address && !anyOp) message = `${AWAITING_MESSAGE} (address configured; service contract not yet supplied)`;
  else if (address && anyOp) {
    connection = transport.health.lastError && !transport.health.lastSuccess ? 'error' : transport.health.lastSuccess ? 'connected' : 'configured';
    message = connection === 'connected' ? 'Connected' : connection === 'error' ? `Connection error: ${transport.health.lastError}` : 'Configured; not yet verified';
  }
  const datasets = datasetStates(names, 'awaiting');
  for (const [k, v] of Object.entries(datasetInfo || {})) if (datasets[k]) Object.assign(datasets[k], v);
  return { connection, message, address: address ? safeAddress(address) : '', ...transport.health, datasets };
}

function safeAddress(address) {
  try {
    const u = new URL(address);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '(invalid address)';
  }
}

export function createShafferMarketPort({ getConnection, credentials, clock }) {
  const address = () => getConnection().gatewayUrl || getConnection().marketDataUrl || '';
  const transport = createTransport({ getAddress: address, credentials, timeoutMs: () => getConnection().requestTimeoutMs, clock });
  const ctx = makeCtx(clock);
  let datasetInfo = null;
  const C = marketContract;
  const ready = (op) => Boolean(getConnection().marketDataUrl) && typeof C[op] === 'function';
  const none = () => unavailable('awaiting-connection', AWAITING_MESSAGE);
  const emptyMap = (keys) => new Map(keys.map((k) => [k, null]));
  const call = async (op, fallback, ...args) => {
    if (!ready(op)) return fallback();
    try {
      return await C[op]({ http: transport.http, ctx }, ...args);
    } catch {
      return fallback();
    }
  };
  const payload = async (op, key, ...args) => {
    if (!ready(op)) return none();
    try {
      return { available: true, [key]: await C[op]({ http: transport.http, ctx }, ...args) };
    } catch (err) {
      return unavailable('error', `Shaffer MarketData request failed: ${err.message}`);
    }
  };
  return {
    id: 'shaffer-marketdata',
    state: () => baseState({ address: getConnection().marketDataUrl, contract: C, names: MARKET_DATASETS, transport, datasetInfo }),
    async testConnection() {
      const probe = await transport.probe();
      if (probe.reachable && typeof C.health === 'function') {
        try {
          const h = await C.health({ http: transport.http, ctx });
          if (typeof C.datasets === 'function') datasetInfo = await C.datasets({ http: transport.http, ctx });
          return { ...probe, ok: Boolean(h?.ok), detail: h?.detail || probe.detail };
        } catch (err) {
          return { ...probe, ok: false, detail: `Reachable, but the health check failed: ${err.message}` };
        }
      }
      return { ...probe, ok: false, detail: `${probe.detail} No service contract has been supplied yet, so no data operations are enabled.` };
    },
    quotes: (instruments) => call('quotes', () => emptyMap(instruments.map((i) => i.id)), instruments),
    fx: (pairs) => call('fx', () => emptyMap(pairs), pairs),
    rates: (codes, range) => call('rates', () => new Map(codes.map((c) => [c, []])), codes, range),
    closes: (reqs) => call('closes', () => emptyMap(reqs.map((r) => `${r.instrument.id}@${r.date}`)), reqs),
    borrow: (instruments) => call('borrow', () => emptyMap(instruments.map((i) => i.id)), instruments),
    sessions: (instruments) => call('sessions', () => emptyMap(instruments.map((i) => i.id)), instruments),
    history: (instrument, range) => payload('history', 'bars', instrument, range),
    search: (query, opts) => payload('search', 'items', query, opts),
    reference: (externalId) => payload('reference', 'instrument', externalId),
    optionChain: (underlying, opts) => payload('optionChain', 'chain', underlying, opts),
    contracts: (underlying, opts) => payload('contracts', 'items', underlying, opts),
    corporateActions: (instruments, range) => payload('corporateActions', 'items', instruments, range),
    calendar: (range) => payload('calendar', 'items', range),
  };
}

export function createShafferAnalyticsPort({ getConnection, credentials, clock }) {
  const address = () => getConnection().gatewayUrl || getConnection().analyticsUrl || '';
  const transport = createTransport({ getAddress: address, credentials, timeoutMs: () => getConnection().requestTimeoutMs, clock });
  const ctx = makeCtx(clock);
  let datasetInfo = null;
  const C = analyticsContract;
  const ready = (op) => Boolean(getConnection().analyticsUrl) && typeof C[op] === 'function';
  const none = () => unavailable('awaiting-connection', AWAITING_MESSAGE);
  const emptyMap = (keys) => new Map(keys.map((k) => [k, null]));
  return {
    id: 'shaffer-analytics',
    state: () => baseState({ address: getConnection().analyticsUrl, contract: C, names: ANALYTICS_DATASETS, transport, datasetInfo }),
    /** Whether an operation can be called at all: an address is configured and the contract maps it. */
    supports: (op) => ready(op),
    async testConnection() {
      const probe = await transport.probe();
      if (probe.reachable && typeof C.health === 'function') {
        try {
          const h = await C.health({ http: transport.http, ctx });
          if (typeof C.datasets === 'function') datasetInfo = await C.datasets({ http: transport.http, ctx });
          return { ...probe, ok: Boolean(h?.ok), detail: h?.detail || probe.detail };
        } catch (err) {
          return { ...probe, ok: false, detail: `Reachable, but the health check failed: ${err.message}` };
        }
      }
      return { ...probe, ok: false, detail: `${probe.detail} No service contract has been supplied yet, so no analytics operations are enabled.` };
    },
    async instrumentAnalytics(instruments) {
      if (!ready('instrumentAnalytics')) return emptyMap(instruments.map((i) => i.id));
      try {
        return await C.instrumentAnalytics({ http: transport.http, ctx }, instruments);
      } catch {
        return emptyMap(instruments.map((i) => i.id));
      }
    },
    async signals(filter) {
      if (!ready('signals')) return none();
      try {
        return { available: true, items: await C.signals({ http: transport.http, ctx }, filter) };
      } catch (err) {
        return unavailable('error', `Shaffer Analytics Lab request failed: ${err.message}`);
      }
    },
    async valuations(instruments) {
      if (!ready('valuations')) return emptyMap(instruments.map((i) => i.id));
      try {
        return await C.valuations({ http: transport.http, ctx }, instruments);
      } catch {
        return emptyMap(instruments.map((i) => i.id));
      }
    },
    async risk(request) {
      if (!ready('risk')) return none();
      try {
        return { available: true, ...(await C.risk({ http: transport.http, ctx }, request)) };
      } catch (err) {
        return unavailable('error', `Shaffer Analytics Lab request failed: ${err.message}`);
      }
    },
    async strategies() {
      if (!ready('strategies')) return none();
      try {
        return { available: true, items: await C.strategies({ http: transport.http, ctx }) };
      } catch (err) {
        return unavailable('error', `Shaffer Analytics Lab request failed: ${err.message}`);
      }
    },
    async hedge(request) {
      if (!ready('hedge')) return none();
      try {
        return { available: true, response: await C.hedge({ http: transport.http, ctx }, request) };
      } catch (err) {
        return unavailable('error', `Shaffer Hedge request failed: ${err.message}`);
      }
    },
  };
}
