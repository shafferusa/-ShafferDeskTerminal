// Hedge integration.
//
// Shaffer Hedge is an analytical engine in Analytics Lab. It evaluates exposures, selects hedge
// structures, sizes their legs, decides which existing hedges apply to an exposure, and returns
// trade instructions. The Terminal's part is to
//
//   1. build a complete hedge request (a ticker and a quantity alone are not enough) and say
//      truthfully where it stands: incomplete, awaiting connection, ready for analysis,
//      recommendation ready, executing, executed, dismissed, closed or failed,
//   2. show what came back with its source, the time it was received, its version and whether the
//      exposure it was computed against is still the exposure held,
//   3. store and validate the protection allocations the service returns (core/protection.js),
//   4. run confirmed paper execution through the normal package engine, and
//   5. keep every hedge, financing leg and primary position linked through stored identifiers.
//
// No hedge-selection or sizing logic lives here, and nothing is ever executed because a
// recommendation arrived. Until the service contract is supplied every complete request waits as
// "Awaiting Shaffer data connection"; in demo mode a labelled fixture can stand in for the service.

import { j, pj } from '../db/db.js';
import { demoHedgeResponse } from '../data/demo-hedge.js';
import { fmtQty } from '../products/common.js';
import { contractBasis, normalizeBasis, OTC_FAMILIES } from './agreements.js';
import { getProduct } from './catalog.js';
import { createProtection } from './protection.js';
import { isZero, need, newId, num } from './util.js';

export const HEDGE_OBJECTIVES = [
  { id: 'downside_protection', label: 'Downside protection' },
  { id: 'upside_protection_short', label: 'Upside protection for shorts' },
  { id: 'market_sector_reduction', label: 'Market / sector exposure reduction' },
  { id: 'currency_protection', label: 'Currency protection' },
  { id: 'rate_protection', label: 'Rate protection' },
  { id: 'credit_protection', label: 'Credit protection' },
  { id: 'volatility_protection', label: 'Volatility protection' },
  { id: 'server_defined', label: 'Other (defined by the Strategy on the server)' },
];
export const HEDGE_SCOPES = [
  { id: 'trade', label: 'This trade' },
  { id: 'strategy_package', label: 'Strategy package' },
  { id: 'account', label: 'Account' },
  { id: 'book', label: 'Book' },
];
export const HEDGE_FAMILIES = ['Options', 'Futures and forwards', 'Total-return and equity swaps', 'Interest-rate derivatives', 'Currency derivatives', 'Credit derivatives', 'Commodity and inflation derivatives', 'Volatility derivatives', 'Cash instruments', 'Financing'];

/** The one state every hedge request is in. Completeness and connection are reported beside it. */
export const HEDGE_STATES = {
  incomplete: 'Incomplete request',
  awaiting_connection: 'Awaiting connection',
  ready_for_analysis: 'Ready for analysis',
  recommendation_ready: 'Recommendation ready',
  executing: 'Executing',
  executed: 'Executed',
  dismissed: 'Dismissed',
  closed: 'Closed',
  error: 'Failed',
  superseded: 'Replaced by a newer request',
};
const OPEN = ['awaiting', 'received', 'error'];
const OPEN_SQL = `('awaiting','received','error')`;
const ARRANGEMENT = new Set(['secloan', 'loan', 'repo']);
const SERVICE_LABEL = 'Shaffer Hedge (Analytics Lab)';

export function createHedge(app) {
  const { db, clock, books, instruments, positions } = app;
  const protection = createProtection(app);
  app.protection = protection;
  const parse = (r) => r && { ...r, request: pj(r.request, {}), response: pj(r.response, null) };
  const get = (id) => parse(db.get('SELECT * FROM hedge_requests WHERE id = ?', id));
  // The automatic post-trade requests that wait for the next engine cycle. Kept in the database (engine_state), not
  // only in memory: a Terminal that stops or is killed between a fill and the next cycle still owes the request
  // when it starts again. An id leaves the queue when it has been dealt with.
  const QUEUE_KEY = 'hedge.postTradeQueue';
  const storedQueue = () => pj(db.get('SELECT value FROM engine_state WHERE key = ?', QUEUE_KEY)?.value, []) || [];
  const storeQueue = (ids) => db.run('INSERT INTO engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', QUEUE_KEY, j(ids));
  const postTradeQueue = {
    add(id) { const ids = storedQueue(); if (!ids.includes(id)) storeQueue([...ids, id]); },
    delete(id) { const ids = storedQueue(); if (ids.includes(id)) storeQueue(ids.filter((x) => x !== id)); },
    get size() { return storedQueue().length; },
    [Symbol.iterator]() { return storedQueue()[Symbol.iterator](); },
  };
  const purposeOf = (p) => p.data.purpose || 'primary';

  // ---- who answers hedge requests ------------------------------------------------------------------------
  const scriptOf = () => (app.config.demo ? app.data.getSetting('demo.hedgeScript', null) : null);

  /**
   * The service that would answer a hedge request right now. `kind` is what every stored response
   * is stamped with: 'shaffer-hedge', or in demo mode 'demo-fixture' / 'test-fixture'.
   */
  function service() {
    if (app.config.demo) {
      const script = scriptOf();
      if (script) return { kind: 'test-fixture', label: 'Test fixture (scripted, not Shaffer Hedge)', fixture: true, reachable: script.available !== false };
      if (app.data.getSetting('demo.hedgeFixture', true)) return { kind: 'demo-fixture', label: 'Demo fixture, not Shaffer Hedge', fixture: true, reachable: true };
      return { kind: 'shaffer-hedge', label: SERVICE_LABEL, fixture: false, reachable: false };
    }
    const st = app.data.analytics.state();
    const reachable = Boolean(app.data.analytics.supports?.('hedge')) && ['connected', 'configured'].includes(st.connection);
    return { kind: 'shaffer-hedge', label: SERVICE_LABEL, fixture: false, reachable };
  }
  const canAnswer = () => service().reachable;

  /** Demo only: load a scripted "service" (responses and, optionally, a Strategy list). Labelled test-fixture everywhere. */
  function setScript(script) {
    need(app.config.demo, 'A scripted hedge service can only be loaded in demo mode.', { status: 403 });
    if (!script || script.clear) { app.data.setSetting('demo.hedgeScript', null); return null; }
    need(Array.isArray(script.responses), 'A script needs a "responses" array (it may be empty).');
    const stored = { available: script.available !== false, responses: script.responses, strategies: Array.isArray(script.strategies) ? script.strategies : null, cursor: 0, repeat: script.repeat !== false, loadedAt: clock.now().toISOString() };
    app.data.setSetting('demo.hedgeScript', stored);
    return scriptView();
  }
  function scriptView() {
    const s = scriptOf();
    return s ? { loaded: true, available: s.available !== false, responses: s.responses.length, used: s.cursor, strategies: s.strategies?.length ?? null, loadedAt: s.loadedAt } : { loaded: false };
  }
  function nextScripted() {
    const s = scriptOf();
    if (!s.responses.length) return { available: true, response: { packages: [], note: 'The test fixture has no scripted response for this request.' } };
    const i = s.cursor < s.responses.length ? s.cursor : s.repeat ? s.responses.length - 1 : -1;
    app.data.setSetting('demo.hedgeScript', { ...s, cursor: s.cursor + 1 });
    if (i < 0) return { available: true, response: { packages: [], note: 'The test fixture has no further scripted response.' } };
    const r = s.responses[i];
    if (r?.error) return { available: false, reason: 'error', message: String(r.error) };
    return { available: true, response: r };
  }

  async function askService(req) {
    const svc = service();
    if (!svc.reachable) return { available: false, reason: 'awaiting-connection', svc };
    if (svc.kind === 'test-fixture') return { ...nextScripted(), svc };
    if (svc.kind === 'demo-fixture') return { available: true, response: await demoHedgeResponse(app, req), svc };
    return { ...(await app.data.analytics.hedge(req)), svc };
  }

  // ---- investment Strategies: stable IDs from Analytics Lab, typed names stay unresolved ---------------------
  async function strategyList() {
    const r = await app.data.analytics.strategies();
    if (!r?.available) return { available: false, items: [], source: null, reason: r?.reason || 'awaiting-connection' };
    const kind = r.fixture || 'analytics-lab';
    const label = kind === 'demo-fixture' ? 'Demo fixture, not Analytics Lab' : kind === 'test-fixture' ? 'Test fixture (scripted, not Analytics Lab)' : 'Analytics Lab';
    return { available: true, source: { kind, label }, items: (r.items || []).filter((s) => s && s.id !== undefined && s.id !== null && s.name).map((s) => ({ id: String(s.id), name: String(s.name), version: s.version ?? null, hedgeObjective: s.hedgeObjective ?? null })) };
  }

  /**
   * Normalise an investment Strategy reference. An ID is accepted only when it is in the list the
   * service supplies (or was resolved earlier and cannot be re-checked now). A typed name is kept
   * as typed, marked unresolved, and never turned into an ID here.
   */
  function strategyRefWith(list, input) {
    if (!input || (!input.id && !input.name)) return null;
    const name = input.name ? String(input.name).trim() : null;
    if (input.id) {
      if (list.available) {
        const hit = list.items.find((s) => s.id === String(input.id));
        if (hit) return { id: hit.id, name: hit.name, resolved: true, source: list.source.label, sourceKind: list.source.kind, version: hit.version ?? null };
        return { id: null, name: name || String(input.id), resolved: false, note: `ID ${input.id} is not in the Strategy list supplied by ${list.source.label}.` };
      }
      if (input.resolved === true && name) return { id: String(input.id), name, resolved: true, source: input.source || null, sourceKind: input.sourceKind || null, version: input.version ?? null };
      return { id: null, name: name || String(input.id), resolved: false };
    }
    return name ? { id: null, name, resolved: false } : null;
  }
  const strategyRef = async (input) => strategyRefWith(await strategyList(), input);
  /** How a stored reference reads on a screen, whatever its age: legacy `{ name }` objects are unresolved. */
  const refView = (x) => (x && (x.name || x.id) ? { id: x.resolved === true && x.id ? x.id : null, name: x.name || String(x.id), resolved: x.resolved === true && Boolean(x.id), source: x.source || null, version: x.version ?? null, note: x.note || null } : null);

  /** The Strategy list plus every Strategy reference in use in a Book, with a suggested match for unresolved names. */
  async function strategiesView(bookId) {
    const list = await strategyList();
    const inUse = new Map();
    const add = (x, where) => {
      const v = refView(x);
      if (!v) return;
      const key = v.resolved ? `id:${v.id}` : `name:${v.name.toLowerCase()}`;
      const e = inUse.get(key) || { ...v, strategyInstances: 0, hedgeRequests: 0 };
      e[where]++;
      inUse.set(key, e);
    };
    if (bookId) {
      for (const s of db.all(`SELECT params FROM strategies WHERE book_id = ?`, bookId)) add(pj(s.params, {}).investmentStrategy, 'strategyInstances');
      for (const r of db.all(`SELECT request FROM hedge_requests WHERE book_id = ? AND status IN ${OPEN_SQL}`, bookId)) add(pj(r.request, {}).investmentStrategy, 'hedgeRequests');
    }
    const items = [...inUse.values()].map((e) => {
      // An exact name match is offered, never applied: the user confirms it.
      const match = !e.resolved && list.available ? list.items.find((s) => s.name.toLowerCase() === e.name.toLowerCase()) : null;
      return { ...e, suggestion: match ? { id: match.id, name: match.name } : null };
    });
    return {
      available: list.available, items: list.items, source: list.source, inUse: items,
      // Names already typed in this Terminal (kept for the ticket's suggestions).
      known: db.all(`SELECT DISTINCT json_extract(params, '$.investmentStrategy.name') AS name FROM strategies WHERE json_extract(params, '$.investmentStrategy.name') IS NOT NULL`).map((x) => x.name),
      state: app.data.analytics.state(), awaitingMessage: app.data.describe().awaitingMessage,
      note: 'Investment Strategies come from Analytics Lab and are identified by its IDs. Execution templates (collar, spread and so on) are the Terminal\'s own and are a separate thing.',
    };
  }

  /** The user confirms that a typed name is a listed Strategy. Every use of that name in the Book takes the ID. */
  async function resolveStrategyName({ bookId, name, id }) {
    books.requireBook(bookId);
    need(name && id, 'Give the typed name and the ID of the Strategy it should resolve to.');
    const list = await strategyList();
    need(list.available, `The Strategy list is not available: ${app.data.describe().awaitingMessage}. The name stays unresolved.`, { status: 409 });
    const ref = strategyRefWith(list, { id });
    need(ref?.resolved, `Strategy ${id} is not in the list supplied by ${list.source.label}.`, { status: 404 });
    const now = clock.now().toISOString();
    const resolved = { ...ref, resolvedFrom: String(name), resolvedAt: now };
    const same = (x) => x && x.resolved !== true && String(x.name || '').trim().toLowerCase() === String(name).trim().toLowerCase();
    let strategies = 0, requests = 0;
    db.tx(() => {
      for (const s of db.all('SELECT id, params FROM strategies WHERE book_id = ?', bookId)) {
        const p = pj(s.params, {});
        if (!same(p.investmentStrategy)) continue;
        db.run('UPDATE strategies SET params = ?, updated_at = ? WHERE id = ?', j({ ...p, investmentStrategy: resolved }), now, s.id);
        strategies++;
      }
      for (const r of db.all(`SELECT id, request FROM hedge_requests WHERE book_id = ? AND status IN ${OPEN_SQL}`, bookId)) {
        const q = pj(r.request, {});
        if (!same(q.investmentStrategy)) continue;
        db.run('UPDATE hedge_requests SET request = ?, updated_at = ? WHERE id = ?', j({ ...q, investmentStrategy: resolved }), now, r.id);
        requests++;
      }
    });
    return { resolved, strategies, requests };
  }

  // ---- building the request ----------------------------------------------------------------------------------
  function instrumentRef(inst) {
    if (!inst) return null;
    const und = inst.underlying_id ? instruments.get(inst.underlying_id) : null;
    return {
      terminalId: inst.id, shafferId: inst.external_ids?.shaffer ?? null, symbol: inst.symbol, name: inst.name, productId: inst.product_id, family: inst.family, marketView: inst.market_view,
      currency: inst.trading_ccy, settlementCurrency: inst.settle_ccy, multiplier: inst.multiplier, issuer: inst.issuer, domicile: inst.domicile, venue: inst.venue, underlyingGeography: inst.underlying_geo,
      underlying: und ? { terminalId: und.id, shafferId: und.external_ids?.shaffer ?? null, symbol: und.symbol, name: und.name } : null, terms: inst.terms,
    };
  }

  function positionFact(p) {
    const v = app.valuation.position(p);
    const inst = instruments.get(p.instrument_id);
    return {
      positionId: p.id, strategyInstanceId: p.strategy_id || null, purpose: purposeOf(p), hedgeLinkId: p.data.hedgeLinkId || null,
      instrument: instrumentRef(inst), quantity: p.qty, direction: v.direction, currency: v.ccy,
      // Facts only. Deltas, betas, DV01 and other sensitivities are computed by Analytics Lab.
      marketValue: v.mv, notional: v.notional, marketValueReporting: v.mvRc, priceObservation: v.priceObs ? { value: v.priceObs.value, status: v.priceObs.status, source: v.priceObs.source, asOf: v.priceObs.asOf } : null,
      expiration: inst.terms.expiration || null, maturity: inst.terms.maturity || inst.terms.valueDate || null,
    };
  }

  /** The primary exposure position of a strategy instance: never a hedge leg, never a financing arrangement. */
  function mainPosition(strategy, all, inst) {
    const mine = all.filter((p) => p.strategy_id === strategy.id && purposeOf(p) === 'primary' && !ARRANGEMENT.has(instruments.get(p.instrument_id).family));
    return mine.find((p) => p.instrument_id === inst?.id) || mine[0] || null;
  }
  const scopeUnitIds = (bookId, unitId, scopeType) => (scopeType === 'book' ? books.unitsOf(bookId).map((u) => u.id) : unitId ? [unitId] : []);

  /**
   * Build the hedge request for Shaffer Hedge.
   * input: { bookId, unitId, scope: {type, id?}, instrumentId, direction, quantity, notional, investmentStrategy, holdingPeriod,
   *          objective: {type, serverDefined, settings}, proposedLegs, strategyId, trigger }
   *
   * The Account's positions and hedges go as context. A hedge is asserted to protect this exposure
   * only when the Terminal holds an identifier that says so (relation "linked"), or when it is
   * protection inside the execution template being built (proposedLegs, relation "template").
   * Every other hedge is sent with what is known about it ("allocated_elsewhere" with the capacity
   * left, "shared" where the service allocated it before, or "unassessed") and nothing more.
   */
  function buildRequest(input) {
    const book = books.requireBook(input.bookId);
    const unit = input.unitId ? books.requireUnit(input.unitId, book.id) : null;
    const scopeType = HEDGE_SCOPES.some((s) => s.id === input.scope?.type) ? input.scope.type : input.strategyId ? 'strategy_package' : 'trade';
    need(scopeType === 'book' || unit, 'Choose the Account (or Treasury) the hedge is for.');
    const strategy = input.strategyId ? app.packages.requireStrategy(input.strategyId) : null;
    const scopeUnits = scopeType === 'book' ? books.unitsOf(book.id) : [unit];
    const scopeIds = scopeUnits.map((u) => u.id);
    const all = positions.list({ unitIds: scopeIds }).filter((p) => !isZero(p.qty));

    let primary = null;
    let existingPosition = null;
    const inst = input.instrumentId ? instruments.get(input.instrumentId) : strategy?.underlying_id ? instruments.get(strategy.underlying_id) : null;
    if (strategy) {
      const main = mainPosition(strategy, all, inst);
      if (main) {
        const v = app.valuation.position(main);
        const mi = instruments.get(main.instrument_id);
        const o = app.orders.forStrategy(strategy.id).filter((x) => x.instrument_id === mi.id && x.kind === 'trade' && x.filled_qty > 0);
        primary = { positionId: main.id, instrument: instrumentRef(mi), direction: main.qty > 0 ? 'long' : 'short', quantity: Math.abs(main.qty), notional: v.notional, currency: v.ccy, status: 'filled', averagePrice: v.avgCost, filledQuantity: Math.abs(main.qty), orderedQuantity: o.reduce((a, x) => a + x.qty, 0) || null, priceObservation: v.priceObs ? { value: v.priceObs.value, status: v.priceObs.status, source: v.priceObs.source, asOf: v.priceObs.asOf } : null };
        existingPosition = positionFact(main);
      }
    }
    if (!primary && inst && scopeType !== 'account' && scopeType !== 'book') {
      const obs = app.data.price(inst.id);
      const qty = num(input.quantity);
      primary = { positionId: null, instrument: instrumentRef(inst), direction: input.direction === 'short' ? 'short' : 'long', quantity: qty, notional: num(input.notional) ?? (qty && obs?.value !== null && obs?.value !== undefined ? qty * obs.value * inst.multiplier : null), currency: inst.trading_ccy, status: 'proposed', averagePrice: null, priceObservation: obs ? { value: obs.value, status: obs.status, source: obs.source, asOf: obs.asOf } : null };
      // "Hedge an existing position": the position chosen on the Strategy page is the one being protected.
      const chosen = input.existingPositionId ? all.find((p) => p.id === input.existingPositionId && p.instrument_id === inst.id) : null;
      const held = all.filter((p) => p.instrument_id === inst.id);
      if (chosen) { existingPosition = positionFact(chosen); primary.positionId = chosen.id; primary.direction = chosen.qty > 0 ? 'long' : 'short'; }
      else if (held.length) existingPosition = positionFact(held[0]);
    }
    // The objective chosen for the position travels with its strategy instance when a call does not restate it.
    const objective = HEDGE_OBJECTIVES.find((o) => o.id === (input.objective?.type || strategy?.params?.hedgeObjective?.type)) || null;

    // Hedges held in scope, each tagged with what the Terminal actually knows about it.
    const views = scopeIds.map((id) => protection.forUnit(id));
    const hedgesHeld = views.flatMap((v) => v.hedges).map((h) => {
      const p = all.find((x) => x.id === h.positionId);
      const toPrimary = primary?.positionId ? h.allocations.filter((a) => a.protectedPositionId === primary.positionId) : [];
      const relation = toPrimary.some((a) => a.basis !== 'service') || (strategy && h.strategyInstanceId === strategy.id && h.purpose === 'hedge') ? 'linked'
        : toPrimary.length ? 'shared'
          : h.allocations.length ? 'allocated_elsewhere' : 'unassessed';
      return {
        ...positionFact(p), relation,
        capacity: { units: h.capacity.units, rule: h.capacity.rule, note: h.capacity.note }, allocatedUnits: h.allocatedUnits, capacityLeft: h.capacityLeft,
        allocations: h.allocations.map((a) => ({ protectedPositionId: a.protectedPositionId, protected: a.protected, units: a.units, basis: a.basis, requestId: a.requestId || null })),
      };
    });
    return {
      schema: 'shaffer-desk-terminal.hedge-request.draft-2',
      requestId: null, createdAt: clock.now().toISOString(), trigger: input.trigger || 'manual',
      scope: { type: scopeType, bookId: book.id, unitId: unit?.id || null, strategyInstanceId: strategy?.id || null },
      book: { id: book.id, name: book.name, reportingCurrency: book.reporting_ccy },
      account: unit ? { id: unit.id, name: unit.name, kind: unit.kind } : null,
      investmentStrategy: refView(input.investmentStrategy) ? input.investmentStrategy : strategy?.params?.investmentStrategy || null,
      holdingPeriod: input.holdingPeriod && (input.holdingPeriod.days || input.holdingPeriod.until || input.holdingPeriod.label) ? { days: num(input.holdingPeriod.days), until: input.holdingPeriod.until || null, label: input.holdingPeriod.label || null } : strategy?.params?.holdingPeriod || null,
      objective: { type: objective?.id || null, label: objective?.label || null, serverDefined: input.objective?.serverDefined || null, settings: input.objective?.settings || {} },
      primary,
      // Protection inside the selected execution template: proposed, relation "template".
      proposedLegs: input.builtProposedLegs || (input.proposedLegs || []).map((l) => ({ role: l.role || null, purpose: l.purpose || 'primary', kind: l.kind || 'trade', action: l.action, quantity: l.qty, isProtection: l.purpose === 'hedge', relation: l.purpose === 'hedge' ? 'template' : null, instrument: l.instrumentId ? instrumentRef(instruments.get(l.instrumentId)) : l.option ? { family: 'option', underlying: instrumentRef(instruments.get(l.option.underlyingId)), terms: l.option } : l.contract ? { family: l.contract.productId, terms: l.contract.terms, name: l.contract.name } : null })),
      existingPosition,
      // Only these are known to protect this exposure. Everything else in hedgesHeld is context.
      linkedProtection: hedgesHeld.filter((h) => h.relation === 'linked'),
      hedgesHeld,
      protectionNote: 'A hedge is stated to protect this exposure only when it is tagged "linked" (or is template protection in proposedLegs). Hedges tagged "allocated_elsewhere", "shared" or "unassessed" are context: whether and how far they apply is for Analytics Lab to decide and return as a protection assessment.',
      exposures: {
        asOf: clock.now().toISOString(), scope: scopeType === 'book' ? 'book' : 'account',
        positions: all.map(positionFact),
        cash: scopeIds.flatMap((id) => app.ledger.currencies([id]).map((ccy) => ({ unitId: id, currency: ccy, settled: app.ledger.balance(id, 'cash', ccy), borrowed: -app.ledger.balance(id, 'loan.liab', ccy) }))).filter((c) => c.settled !== 0 || c.borrowed !== 0),
        note: 'Position facts only. Sensitivities and exposure measures are computed by Analytics Lab.',
      },
    };
  }

  /** Validate what a complete request must contain; returns a list of what is missing. */
  function missingFields(req) {
    const out = [];
    if (['trade', 'strategy_package'].includes(req.scope.type)) {
      if (!req.primary?.instrument) out.push('instrument or contract');
      else if (!(req.primary.quantity > 0) && !(req.primary.notional > 0)) out.push('amount');
    }
    if (!req.investmentStrategy?.name && !req.investmentStrategy?.id) out.push('investment Strategy');
    if (!req.objective?.type) out.push('hedge objective');
    if (!req.holdingPeriod) out.push('intended holding period');
    return out;
  }

  // ---- source and freshness ----------------------------------------------------------------------------------
  /**
   * The hedges a recommendation for one exposure rests on, as [positionId, quantity]: hedges linked
   * or allocated to it, and hedges that could still be allocated to it. A hedge fully committed to
   * other positions, or a written option of another strategy instance, cannot protect this exposure,
   * so putting one on elsewhere in the Account does not make this recommendation stale.
   */
  function hedgeFacts(row, primaryPositionId) {
    const out = [];
    for (const h of scopeUnitIds(row.book_id, row.unit_id, row.scope_type).flatMap((id) => protection.forUnit(id).hedges)) {
      const mine = Boolean(primaryPositionId) && h.allocations.some((a) => a.protectedPositionId === primaryPositionId);
      const sameStrategy = Boolean(row.strategy_id) && h.strategyInstanceId === row.strategy_id;
      if (primaryPositionId && !mine && !sameStrategy) {
        if (h.allocations.length && h.capacityLeft === 0) continue;
        if (h.capacity.rule === 'option' && h.capacity.units === 0) continue;
      }
      out.push([h.positionId, h.quantity]);
    }
    return out.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  }

  /** The exposure a stored request describes, as it stands now: scope, primary amount, relevant hedges. Compared, never trusted as a claim. */
  function exposureNow(row) {
    const q = row.request;
    const ids = scopeUnitIds(row.book_id, row.unit_id, row.scope_type);
    let primary = q.primary ? { instrumentId: q.primary.instrument?.terminalId || null, direction: q.primary.direction, quantity: q.primary.quantity, status: q.primary.status } : null;
    let positionId = q.primary?.positionId || null;
    if (row.strategy_id && q.primary?.status === 'filled') {
      const s = app.packages.getStrategyRow(row.strategy_id);
      const all = positions.list({ unitIds: ids }).filter((p) => !isZero(p.qty));
      const main = s ? mainPosition(s, all, instruments.get(q.primary.instrument?.terminalId)) : null;
      primary = main ? { instrumentId: main.instrument_id, direction: main.qty > 0 ? 'long' : 'short', quantity: Math.abs(main.qty), status: 'filled' } : null;
      positionId = main?.id || positionId;
    }
    return { scope: `${row.scope_type}:${row.unit_id || ''}:${row.strategy_id || ''}`, primary, hedges: hedgeFacts(row, positionId) };
  }

  function exposureChanges(then, now) {
    if (!then) return ['This recommendation was stored before the exposure it was computed against was recorded. Refresh it against current exposure.'];
    const out = [];
    const sym = (id) => { const i = id ? instruments.get(id) : null; return i ? i.symbol || i.name : 'the position'; };
    if (then.primary && !now.primary) out.push(`The position (${then.primary.direction} ${fmtQty(then.primary.quantity)} ${sym(then.primary.instrumentId)}) is no longer held.`);
    else if (then.primary && now.primary) {
      if (then.primary.direction !== now.primary.direction) out.push(`The position is now ${now.primary.direction}; the recommendation was computed for a ${then.primary.direction} position.`);
      else if (Math.abs((then.primary.quantity || 0) - (now.primary.quantity || 0)) > 1e-9) out.push(`The position is now ${now.primary.direction} ${fmtQty(now.primary.quantity)} ${sym(now.primary.instrumentId)}; the recommendation was computed for ${fmtQty(then.primary.quantity)}.`);
    }
    // Hedge positions are compared by id and quantity, so a fully closed strategy (scope id unchanged) still shows.
    const a = new Map(then.hedges || []), b = new Map(now.hedges || []);
    const added = [...b.keys()].filter((k) => !a.has(k)).length, removed = [...a.keys()].filter((k) => !b.has(k)).length, resized = [...a.keys()].filter((k) => b.has(k) && Math.abs(a.get(k) - b.get(k)) > 1e-9).length;
    if (added || removed || resized) out.push(`Hedges held in scope changed: ${[added ? `${added} added` : '', removed ? `${removed} closed or expired` : '', resized ? `${resized} resized` : ''].filter(Boolean).join(', ')}.`);
    if (then.scope !== now.scope) out.push('The scope of the request changed.');
    return out;
  }

  /** A stored response's source, whatever its age (older rows stored a plain string). */
  function sourceOf(row) {
    const r = row.response;
    if (!r) return null;
    if (r.source && typeof r.source === 'object') return r.source;
    return { kind: r.fixture ? 'demo-fixture' : 'shaffer-hedge', label: r.fixture ? 'Demo fixture, not Shaffer Hedge' : SERVICE_LABEL, version: r.modelRun || null, receivedAt: r.asOf || row.updated_at, exposureAsOf: row.request?.exposures?.asOf || null, fingerprint: null };
  }

  /** Freshness is derived each time it is asked for, from positions as they are now. */
  function freshnessOf(row) {
    const src = sourceOf(row);
    if (!src) return null;
    const svc = service();
    const changes = exposureChanges(src.fingerprint, exposureNow(row));
    const reachable = svc.reachable && svc.kind === src.kind;
    return {
      status: changes.length ? 'stale' : 'current', changes,
      sourceReachable: reachable,
      // A recommendation whose source cannot be asked again right now is a cached copy, and says so.
      cached: !reachable, cachedNote: reachable ? null : `Cached: ${src.kind === 'shaffer-hedge' ? 'Shaffer Hedge' : src.kind === 'demo-fixture' ? 'the demo fixture' : 'the test fixture'} is not reachable now.`,
    };
  }

  // ---- state ---------------------------------------------------------------------------------------------------
  function stateOf(row, missing = missingFields(row.request)) {
    switch (row.status) {
      case 'received': return 'recommendation_ready';
      case 'error': return 'error';
      case 'dismissed': return 'dismissed';
      case 'closed': return 'closed';
      case 'superseded': return 'superseded';
      case 'executed': {
        const legs = row.strategy_id && row.executed_submission ? app.orders.forStrategy(row.strategy_id).filter((o) => o.submission === row.executed_submission) : [];
        if (legs.some((o) => app.orders.ACTIVE.has(o.status))) return 'executing';
        // Confirmed, but no leg executed: that is a failure, not an executed hedge.
        if (legs.length && !legs.some((o) => o.filled_qty > 0)) return 'error';
        return 'executed';
      }
      default: return missing.length ? 'incomplete' : canAnswer() ? 'ready_for_analysis' : 'awaiting_connection';
    }
  }

  function stateMessage(row, state, missing) {
    const awaiting = app.data.describe().awaitingMessage;
    switch (state) {
      case 'incomplete': return `The hedge request is incomplete: ${missing.join(', ')} still needed. It is stored and has not been sent.${canAnswer() ? '' : ` ${awaiting}.`}`;
      case 'awaiting_connection': return `${awaiting}. The request is complete and stored; it is sent when Shaffer Hedge can be reached.`;
      case 'ready_for_analysis': return `The request is complete and ${service().label} can be reached. It has not been answered yet.`;
      case 'error': return row.status === 'executed' ? 'The hedge was confirmed, but none of its legs executed. Open the strategy to see why.' : row.message;
      default: return row.message || null;
    }
  }

  function view(row) {
    if (!row) return null;
    const missing = missingFields(row.request);
    const state = stateOf(row, missing);
    const svc = service();
    const src = sourceOf(row);
    const freshness = row.status === 'received' ? freshnessOf(row) : null;
    return {
      id: row.id, status: row.status, state, stateLabel: HEDGE_STATES[state], message: stateMessage(row, state, missing), trigger: row.trigger, scope: { type: row.scope_type, id: row.scope_id }, strategyId: row.strategy_id, bookId: row.book_id, unitId: row.unit_id,
      // Two separate facts: is the request complete, and can the service be reached.
      complete: missing.length === 0, missing,
      connection: { reachable: svc.reachable, kind: svc.kind, label: svc.label, fixture: svc.fixture, analytics: app.data.analytics.state().connection },
      request: { ...row.request, investmentStrategy: refView(row.request.investmentStrategy) }, response: row.response,
      source: src ? { kind: src.kind, label: src.label, version: src.version ?? null, receivedAt: src.receivedAt, exposureAsOf: src.exposureAsOf } : null,
      freshness, canExecute: row.status === 'received' && freshness?.status === 'current',
      protection: row.response?.protection || null,
      selectedPackage: row.selected_package, executedSubmission: row.executed_submission,
      awaitingMessage: app.data.describe().awaitingMessage, analytics: app.data.analytics.state().connection, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  /** The short form used on a queue row, a position pill and a strategy page. */
  function brief(row) {
    const v = view(row);
    const p = v.request.primary;
    return {
      id: v.id, status: v.status, state: v.state, stateLabel: v.stateLabel, message: v.message, complete: v.complete, missing: v.missing, connection: v.connection,
      source: v.source, freshness: v.freshness, canExecute: v.canExecute, packages: row.response?.packages?.length ?? 0, trigger: v.trigger, scope: v.scope, strategyId: v.strategyId, bookId: v.bookId, unitId: v.unitId,
      investmentStrategy: v.request.investmentStrategy, selectedPackage: v.selectedPackage,
      primary: p ? { positionId: p.positionId || null, symbol: p.instrument?.symbol, name: p.instrument?.name, direction: p.direction, quantity: p.quantity, status: p.status } : null,
      refreshedAt: v.request.refreshedAt || null, createdAt: v.createdAt, updatedAt: v.updatedAt,
    };
  }

  // ---- asking, storing, refreshing ------------------------------------------------------------------------------
  function normalizeResponse(raw, { svc, req, now }) {
    const packages = (raw?.packages || []).map((p, i) => ({
      id: String(p.id ?? `pkg-${i + 1}`), label: p.label || `Package ${i + 1}`, recommended: Boolean(p.recommended), riskAddressed: p.riskAddressed || [], intendedProtection: p.intendedProtection ?? null,
      horizon: p.horizon || null, exposure: p.exposure || [], upsideSurrendered: p.upsideSurrendered ?? null, costs: p.costs || null, scenarios: p.scenarios || [], valuation: p.valuation || null, notes: p.notes || [],
      legs: (p.legs || []).map((l) => ({ ...l, role: l.role === 'financing' ? 'financing' : 'hedge' })),
    }));
    const prot = raw?.protection;
    return {
      // Stamped by the Terminal from the channel the answer came through, never from what the payload claims.
      source: { kind: svc.kind, label: svc.label, version: raw?.version ?? raw?.modelRun ?? null, statedSource: typeof raw?.source === 'string' ? raw.source : null, receivedAt: now, exposureAsOf: req.exposures?.asOf || null, fingerprint: null },
      asOf: raw?.asOf || null, modelRun: raw?.modelRun || null, fixture: svc.fixture, note: raw?.note || null, recommendedId: raw?.recommendedId || packages.find((p) => p.recommended)?.id || null, packages,
      protection: prot ? { allocations: Array.isArray(prot.allocations) ? prot.allocations : [], unrelated: Array.isArray(prot.unrelated) ? prot.unrelated : [], note: prot.note || null, illustrative: Boolean(prot.illustrative), results: [] } : null,
    };
  }

  /** Send a stored request if it is complete and the service can be reached; store whatever comes back. Never trades. */
  async function ask(id, { announce = false } = {}) {
    const row = get(id);
    const req = row.request;
    const now = clock.now().toISOString();
    if (missingFields(req).length) {
      db.run(`UPDATE hedge_requests SET status = 'awaiting', response = NULL, message = NULL, updated_at = ? WHERE id = ?`, now, id);
      return 'incomplete';
    }
    const r = await askService(req);
    if (r?.available) {
      const response = normalizeResponse(r.response, { svc: r.svc, req, now });
      if (response.protection) {
        response.protection.results = protection.applyAssessment({
          requestId: id, bookId: row.book_id, unitId: row.unit_id, scopeUnitIds: scopeUnitIds(row.book_id, row.unit_id, row.scope_type),
          defaultProtectedId: req.primary?.positionId || null, assessment: response.protection, source: response.source,
        });
      }
      // What this answer was computed against, recorded after any allocations it carried were stored.
      response.source.fingerprint = exposureNow({ ...row, request: req });
      db.run(`UPDATE hedge_requests SET response = ?, status = 'received', message = ?, updated_at = ? WHERE id = ?`, j(response), response.packages.length ? null : response.note || `${r.svc.label} returned no packages for this request.`, now, id);
      if (announce && response.packages.length) {
        const what = req.primary?.instrument ? `${req.primary.direction} ${req.primary.instrument.symbol || req.primary.instrument.name}` : req.account?.name || req.book.name;
        app.alerts.raise({ bookId: row.book_id, unitId: row.unit_id, level: 'warning', code: 'hedge.ready', refType: 'hedge', refId: id, message: `Hedge recommendations arrived for ${what} (${r.svc.label}). They are in the hedge review queue; nothing is traded until you confirm.` });
      }
      return 'received';
    }
    if (r?.reason === 'error') { db.run(`UPDATE hedge_requests SET status = 'error', response = NULL, message = ?, updated_at = ? WHERE id = ?`, r.message, now, id); return 'error'; }
    db.run(`UPDATE hedge_requests SET status = 'awaiting', response = NULL, message = NULL, updated_at = ? WHERE id = ?`, now, id);
    return 'awaiting';
  }

  const hasOpenPrimary = (strategyId) => {
    const s = app.packages.getStrategyRow(strategyId);
    if (!s) return false;
    const all = positions.list({ unitIds: [s.unit_id], strategyId: s.id }).filter((p) => !isZero(p.qty));
    return Boolean(mainPosition(s, all, null));
  };

  function close(row, reason) {
    db.run(`UPDATE hedge_requests SET status = 'closed', message = ?, prompt_seen = 1, updated_at = ? WHERE id = ?`, reason, clock.now().toISOString(), row.id);
    app.alerts.resolve({ refType: 'hedge', refId: row.id, code: 'hedge.ready' });
  }

  /** Requests whose position no longer exists are closed, with the reason. Nothing is sent for them. */
  function closeOrphans() {
    const closed = [];
    for (const row of db.all(`SELECT * FROM hedge_requests WHERE status IN ${OPEN_SQL} AND strategy_id IS NOT NULL`).map(parse)) {
      if (hasOpenPrimary(row.strategy_id) || app.orders.active(row.strategy_id).length) continue;
      close(row, row.status === 'received'
        ? `The position this recommendation was for was closed on ${clock.today()}. It can no longer be executed.`
        : `The position this request was for was closed on ${clock.today()} before a recommendation arrived. Nothing was sent after that.`);
      closed.push(row.id);
    }
    return closed;
  }

  /**
   * Rebuild a stored request against the exposure as it is now, in place (same id), optionally with
   * changed context. A proposed primary (no strategy instance yet) keeps the amount it was asked for.
   */
  async function rebuild(row, patch = {}) {
    const q = row.request;
    const proposed = q.primary?.status === 'proposed';
    const scopeType = patch.scope?.type || row.scope_type;
    const req = buildRequest({
      bookId: row.book_id, unitId: row.unit_id, strategyId: row.strategy_id, scope: { type: scopeType }, trigger: row.trigger,
      investmentStrategy: await strategyRef(patch.investmentStrategy !== undefined ? patch.investmentStrategy : q.investmentStrategy),
      holdingPeriod: patch.holdingPeriod !== undefined ? patch.holdingPeriod : q.holdingPeriod,
      objective: patch.objective !== undefined ? patch.objective : { type: q.objective?.type, serverDefined: q.objective?.serverDefined, settings: q.objective?.settings },
      instrumentId: q.primary?.instrument?.terminalId || undefined, direction: q.primary?.direction, quantity: proposed ? q.primary.quantity : undefined, notional: proposed ? q.primary.notional : undefined,
      builtProposedLegs: row.strategy_id ? null : q.proposedLegs, existingPositionId: proposed ? q.primary.positionId || undefined : undefined,
    });
    req.requestId = row.id;
    req.createdAt = q.createdAt;
    req.refreshedAt = clock.now().toISOString();
    if (q.templateNote) req.templateNote = q.templateNote;
    return req;
  }

  /** Rebuild in place and ask again. Returns the stored view. */
  async function reask(row, patch, opts) {
    const req = await rebuild(row, patch);
    db.run('UPDATE hedge_requests SET request = ?, scope_type = ?, scope_id = ?, updated_at = ? WHERE id = ?', j(req), req.scope.type, req.scope.strategyInstanceId || req.scope.unitId || req.scope.bookId, clock.now().toISOString(), row.id);
    await ask(row.id, opts);
    return view(get(row.id));
  }

  const openRowFor = (strategyId) => parse(db.get(`SELECT * FROM hedge_requests WHERE strategy_id = ? AND status IN ${OPEN_SQL} ORDER BY created_at DESC LIMIT 1`, strategyId));

  /** Build a request, store it, and send it when it is complete and the service can be reached. */
  async function request(input0) {
    let input = input0;
    let packageNote = null;
    // A request is made inside one Book. A strategy instance or a position of another Book is refused before
    // anything is looked up for it (its open request would otherwise be found and returned to the caller).
    const book0 = books.requireBook(input.bookId);
    if (input.strategyId) need(app.packages.requireStrategy(input.strategyId).book_id === book0.id, 'That strategy instance belongs to a different Book.', { status: 400 });
    for (const pid of [input.existingPositionId, input.package?.existingPositionId].filter(Boolean)) need(positions.get(pid)?.book_id === book0.id, 'That position was not found in this Book.', { status: 404 });
    // Workflow 1 (Strategy page): the selected execution template is resolved into its legs so the
    // request carries the proposed primary trade and any protection the template already contains.
    if (input.package && !input.proposedLegs) {
      try {
        const pv = await app.packages.preview({ ...input.package, bookId: input.bookId, unitId: input.unitId, hedgeLinkId: null, hedgePackageId: null, financing: null, clientToken: undefined });
        const main = pv.legs.find((l) => l.purpose === 'primary' && ['trade', 'link'].includes(l.kind));
        const short = main && (main.action === 'sell_short' || (main.kind === 'link' && main.existing?.qty < 0) || (main.action === 'sell' && main.instrument?.family !== 'option'));
        input = {
          ...input,
          proposedLegs: pv.legs.map((l) => ({ role: l.role, purpose: l.purpose, kind: l.kind, action: l.action, qty: l.qty, instrumentId: l.instrumentId, option: l.option, contract: l.contract })),
          instrumentId: input.instrumentId || main?.instrumentId || pv.underlying?.id || null,
          quantity: num(input.quantity) ?? (main && main.instrumentId === (input.instrumentId || main.instrumentId) ? main.qty : null),
          direction: input.direction || (short ? 'short' : 'long'),
          existingPositionId: input.package.mode === 'existing' ? input.package.existingPositionId || undefined : undefined,
        };
      } catch (err) {
        packageNote = `The execution template could not be resolved into legs yet: ${err.message}`;
      }
    }
    // One request per primary. A position that already has an open request keeps it: the request
    // is rebuilt in place with whatever context came with this call, and asked again.
    if (input.strategyId) {
      const open = openRowFor(input.strategyId);
      if (open) {
        const patch = {};
        if (refView(input.investmentStrategy)) patch.investmentStrategy = input.investmentStrategy;
        if (input.holdingPeriod && (input.holdingPeriod.days || input.holdingPeriod.until || input.holdingPeriod.label)) patch.holdingPeriod = input.holdingPeriod;
        if (input.objective?.type) patch.objective = input.objective;
        if (input.scope?.type) patch.scope = input.scope;
        return reask(open, patch);
      }
      // The automatic post-trade request is made once per position, whatever happened to it since.
      if (input.trigger === 'post_trade') {
        const any = parse(db.get('SELECT * FROM hedge_requests WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1', input.strategyId));
        if (any) return view(any);
      }
    }
    // Drafts made while the Strategy page was being filled in, and never acted on, are replaced.
    if (input.trigger === 'strategy_page' && input.unitId) db.run(`DELETE FROM hedge_requests WHERE trigger = 'strategy_page' AND unit_id = ? AND strategy_id IS NULL AND status IN ${OPEN_SQL}`, input.unitId);
    const req = buildRequest({ ...input, investmentStrategy: await strategyRef(input.investmentStrategy ?? (input.strategyId ? app.packages.getStrategyRow(input.strategyId)?.params?.investmentStrategy : null)) });
    if (packageNote) req.templateNote = packageNote;
    const id = newId('HDG');
    req.requestId = id;
    const now = clock.now().toISOString();
    db.run(
      `INSERT INTO hedge_requests (id, book_id, unit_id, scope_type, scope_id, strategy_id, trigger, request, response, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'awaiting', NULL, ?, ?)`,
      id, req.scope.bookId, req.scope.unitId, req.scope.type, req.scope.strategyInstanceId || req.scope.unitId || req.scope.bookId, input.strategyId || null, req.trigger, j(req), now, now,
    );
    await ask(id);
    return view(get(id));
  }

  /**
   * Complete (or change) the context of a stored request and save it. The request keeps its id;
   * when it is complete and the service can be reached it is sent, otherwise it waits.
   * patch: { investmentStrategy: {id}|{name}, holdingPeriod: {days}|{until}, objective: {type}, scope: {type} }
   */
  async function complete(id, patch = {}) {
    const row = get(id);
    need(row, 'Hedge request not found.', { status: 404 });
    need(OPEN.includes(row.status), `This hedge request is ${HEDGE_STATES[stateOf(row)].toLowerCase()}; its context can no longer be changed. Request the hedge again.`, { status: 409 });
    if (patch.scope?.type) need(HEDGE_SCOPES.some((s) => s.id === patch.scope.type), 'Unknown hedge scope.');
    if (patch.objective?.type) need(HEDGE_OBJECTIVES.some((o) => o.id === patch.objective.type), 'Unknown hedge objective.');
    if (patch.holdingPeriod?.days !== undefined && patch.holdingPeriod?.days !== null) need(num(patch.holdingPeriod.days) > 0, 'The holding period must be a positive number of days.');
    const out = await reask(row, patch);
    // The position's strategy instance carries the same context, so every screen shows one answer.
    if (row.strategy_id) {
      const s = app.packages.getStrategyRow(row.strategy_id);
      const q = get(id).request;
      if (s) db.run('UPDATE strategies SET params = ?, updated_at = ? WHERE id = ?', j({ ...s.params, investmentStrategy: q.investmentStrategy || s.params.investmentStrategy || null, holdingPeriod: q.holdingPeriod || s.params.holdingPeriod || null, hedgeObjective: q.objective?.type ? { type: q.objective.type } : s.params.hedgeObjective || null }), clock.now().toISOString(), s.id);
    }
    return out;
  }

  /** Ask again for one open request, against the exposure as it is at this moment. */
  async function refresh(id) {
    const row = get(id);
    need(row, 'Hedge request not found.', { status: 404 });
    need(OPEN.includes(row.status), `This hedge request is ${HEDGE_STATES[stateOf(row)].toLowerCase()} and cannot be refreshed. Request the hedge again.`, { status: 409 });
    if (row.strategy_id && !hasOpenPrimary(row.strategy_id) && !app.orders.active(row.strategy_id).length) { closeOrphans(); return view(get(id)); }
    return reask(row, {});
  }

  /** Convert a proposed package's instructions into package legs for the normal preview. */
  function packageLegs(requestId, packageId) {
    const row = get(requestId);
    need(row, 'Hedge request not found.', { status: 404 });
    const pkg = row.response?.packages?.find((p) => p.id === packageId);
    need(pkg, 'That hedge package is not part of this response.', { status: 404 });
    return pkg.legs.map((l) => {
      const leg = {
        purpose: l.role === 'financing' ? 'financing' : 'hedge', role: l.label || l.hedgeFamily || 'hedge', kind: l.kind || 'trade', action: l.action, qty: l.quantity, orderType: l.orderType || 'market', limitPrice: l.limitPrice ?? null,
        hedgeLinkId: requestId, hedgeFamily: l.hedgeFamily || null, sizingBasis: l.sizingBasis || null, hedgeRatio: l.hedgeRatio ?? null, riskAddressed: l.riskAddressed || null,
        dependsOn: (l.dependsOn || []).map((d) => d + 1), indicative: l.indicative || null, group: l.option ? 'options' : null,
      };
      if (l.instrumentId) leg.instrumentId = l.instrumentId;
      else if (l.externalId) {
        const hit = db.all(`SELECT id FROM instruments WHERE json_extract(external_ids, '$.shaffer') = ?`, l.externalId)[0];
        need(hit, `The hedge leg refers to instrument ${l.externalId}, which is not in the Terminal's registry yet.`);
        leg.instrumentId = hit.id;
      } else if (l.option) leg.option = l.option;
      else if (l.contract) leg.contract = l.contract;
      for (const k of ['borrow', 'reserve', 'funding', 'sourcePositionId', 'targetPositionId', 'collateralPositionId']) if (l[k] !== undefined) leg[k] = l[k];
      return leg;
    });
  }

  // ---- what a recommendation leaves to the desk ---------------------------------------------------------------
  // A hedge leg can arrive without two things only the desk can supply: the collateral basis of an
  // OTC contract (the desk's own paper terms: an agreement of the Book, position-level terms, or
  // the explicit choice of no collateral) and a fill price where the service gave indicative terms
  // and no executable quote exists. Both are completed on the preview, leg by leg, and travel with
  // the legs into the confirmation. Nothing is assumed for either.

  /** Whether a package leg is an OTC contract, and the collateral basis its terms state (null when none). */
  function otcOf(leg) {
    if (!leg || (leg.kind || 'trade') !== 'trade') return null;
    if (leg.contract) {
      const product = getProduct(leg.contract.productId);
      if (!product || !OTC_FAMILIES.includes(product.family)) return null;
      return { registered: false, basis: contractBasis({ terms: leg.contract.terms || {} }) };
    }
    const inst = leg.instrumentId ? instruments.get(leg.instrumentId) : null;
    if (!inst || !OTC_FAMILIES.includes(inst.family)) return null;
    return { registered: true, basis: contractBasis(inst) };
  }

  const CHOICE_FIXES = new Set(['collateral-basis', 'collateral-other-book', 'collateral-closed', 'collateral-not-covered']);

  /**
   * Preview a proposed package through the normal package engine (quotes, funding, collateral, per-leg checks).
   * opts:
   *   legs             edited legs to preview instead of the package's own (leg numbers are theirs)
   *   extraProtection  true when protection beyond the remaining exposure is added deliberately
   *   collateral       { [legNo]: basis }: the collateral basis chosen for an OTC leg. basis is
   *                    { type: 'agreement', agreementId } | { type: 'position', independentAmount, variationMargin,
   *                    threshold, minimumTransfer } | { type: 'uncollateralized' }. It is written onto the leg's
   *                    contract and validated like any contract's basis (core/agreements.js).
   *   statedPrices     { [legNo]: price | null }: a fill price stated for a leg that has no executable quote
   * The result's `hedge.completion` says, leg by leg, where the collateral basis came from (the
   * recommendation, or chosen here), whether it can be used, and what is still missing before the
   * package can be executed.
   */
  async function previewPackage(requestId, packageId, { legs, extraProtection, collateral, statedPrices } = {}) {
    const row = get(requestId);
    need(row, 'Hedge request not found.', { status: 404 });
    const req = row.request;
    const pkg = row.response?.packages?.find((p) => p.id === packageId);
    const fromService = pkg ? packageLegs(requestId, packageId) : [];
    const useLegs = (legs && legs.length ? legs : fromService).map((l) => ({ ...l }));
    const legAt = (key, what) => {
      const n = Number(key);
      const leg = Number.isInteger(n) && n >= 1 ? useLegs[n - 1] : null;
      need(leg, `${what}: this package has no leg ${key}.`);
      return { n, leg };
    };
    for (const [key, raw] of Object.entries(collateral && typeof collateral === 'object' ? collateral : {})) {
      if (raw === null || raw === undefined) continue;
      const { n, leg } = legAt(key, 'Collateral basis');
      const otc = otcOf(leg);
      need(otc, `Leg ${n} is not an OTC contract (swap, credit default swap, forward or OTC option), so it has no collateral basis to choose.`);
      need(!otc.registered, `Leg ${n} trades a contract that is already registered. Its collateral terms are on the contract and are changed there, not on this package.`);
      const errors = [];
      const basis = normalizeBasis(raw, errors);
      need(!errors.length && basis, `Leg ${n}: ${errors[0] || 'Choose the collateral basis: an agreement, position-level terms, or uncollateralized.'}`);
      // The older single field is superseded by an explicit basis, so the contract states one thing only.
      const { initialMarginPct: _superseded, ...terms } = leg.contract.terms || {};
      leg.contract = { ...leg.contract, terms: { ...terms, collateralBasis: basis } };
    }
    for (const [key, raw] of Object.entries(statedPrices && typeof statedPrices === 'object' ? statedPrices : {})) {
      const { n, leg } = legAt(key, 'Stated fill price');
      need((leg.kind || 'trade') === 'trade', `Leg ${n} is not a trade leg, so it has no fill price to state.`);
      if (raw === null || raw === undefined || raw === '') { leg.statedPrice = null; continue; }
      const price = num(raw);
      need(price !== null && price >= 0, `Leg ${n}: a stated fill price is a number, zero or more.`);
      leg.statedPrice = price;
    }
    const attach = row.strategy_id && ['trade', 'strategy_package'].includes(row.scope_type) ? row.strategy_id : null;
    const unitId = req.scope.unitId || books.treasuryOf(req.scope.bookId).id;
    const pv = await app.packages.preview({
      bookId: req.scope.bookId, unitId, template: 'custom', attachTo: attach, intent: 'hedge', legs: useLegs, hedgeLinkId: requestId, hedgePackageId: packageId || null,
      name: attach ? undefined : `Hedge: ${pkg?.label || 'package'} (${req.account?.name || req.book.name})`,
      underlyingId: req.primary?.instrument?.terminalId || null, investmentStrategy: req.investmentStrategy, holdingPeriod: req.holdingPeriod,
      extraProtection: extraProtection === true ? true : undefined,
    });
    const v = view(get(requestId));
    return { ...pv, hedge: { requestId, packageId, package: pkg || null, state: v.state, source: v.source, freshness: v.freshness, canExecute: v.canExecute, completion: completionOf(pv, useLegs, fromService) } };
  }

  /**
   * What the desk has completed on a priced package and what is still missing, leg by leg.
   * `sent` are the legs that were priced, `fromService` the same package as the recommendation gave it.
   */
  function completionOf(pv, sent, fromService) {
    const out = { legs: [], missing: [] };
    for (const r of pv.legs) {
      const leg = sent[r.n - 1];
      const otc = otcOf(leg);
      const entry = { n: r.n, label: r.label, collateral: null, price: null };
      if (otc) {
        // The leg in the same place of the recommendation, when it is the same contract.
        const first = fromService[r.n - 1];
        const same = first && ((first.contract && leg.contract && first.contract.productId === leg.contract.productId && first.contract.name === leg.contract.name) || (first.instrumentId && first.instrumentId === leg.instrumentId));
        const stated = same ? otcOf(first)?.basis || null : null;
        const inForce = otc.basis;
        const plain = (b) => { const { source: _where, ...rest } = b; return rest; };
        const sameBasis = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));
        const origin = !inForce ? 'none' : otc.registered ? 'contract' : stated && sameBasis(stated, inForce) ? 'recommendation' : 'chosen';
        const problems = pv.checks.filter((c) => c.leg === r.n && c.level === 'error' && /^collateral-/.test(c.code));
        const fixable = problems.find((c) => CHOICE_FIXES.has(c.code));
        entry.collateral = {
          // origin: 'recommendation' (the service stated it), 'chosen' (chosen on this package), 'contract' (a registered contract's own terms), 'none'
          origin, statedByService: Boolean(stated), replacesStated: origin === 'chosen' && Boolean(stated),
          basis: inForce ? plain(inForce) : null, label: r.collateral?.basis?.label || null,
          independent: r.collateral?.independent ? { required: r.collateral.independent.required, delta: r.collateral.independent.delta, ccy: r.collateral.independent.ccy, holder: r.collateral.independent.holder || null } : null,
          variationMargin: r.collateral?.variation ? Boolean(r.collateral.variation.on) : null,
          canChoose: !otc.registered, needsChoice: !otc.registered && (origin === 'none' || Boolean(fixable)),
          problem: problems[0]?.message.replace(/^Leg \d+: /, '') || null,
        };
        if (entry.collateral.needsChoice) out.missing.push({ leg: r.n, what: 'collateral', text: `the collateral basis of leg ${r.n}` });
      }
      if (r.kind === 'trade' && r.price) {
        entry.price = {
          statedPrice: r.statedPrice ?? null, executable: Boolean(r.price.executable),
          // No price of any kind: the leg can only execute at a price the desk states.
          needsStatedPrice: Boolean(r.price.missing),
          canState: !(r.price.waitingOnLimit || r.price.waitingOnStop), indicative: r.indicative || null, reason: r.price.reason || null,
        };
        if (entry.price.needsStatedPrice) out.missing.push({ leg: r.n, what: 'price', text: `a fill price for leg ${r.n}` });
      }
      out.legs.push(entry);
    }
    return out;
  }

  /**
   * Called by the package preview for anything that carries a hedge request id. Returns the reason
   * the recommendation cannot be executed as it stands, or null. A stale recommendation has to be
   * refreshed first; one already executed, dismissed or closed cannot be executed again.
   */
  function executionGuard(requestId, { legs = [] } = {}) {
    const row = get(requestId);
    if (!row) return null;
    if (row.status === 'executed') return `Hedge request ${row.id} was already executed. Request the hedge again for current instructions.`;
    if (row.status === 'dismissed' || row.status === 'closed' || row.status === 'superseded') return `Hedge request ${row.id} is ${HEDGE_STATES[stateOf(row)].toLowerCase()}${row.status === 'closed' && row.message ? `: ${row.message}` : '.'} Its packages cannot be executed.`;
    if (row.status !== 'received') return `Hedge request ${row.id} has no recommendation to execute (${HEDGE_STATES[stateOf(row)].toLowerCase()}).`;
    const f = freshnessOf(row);
    if (f.status === 'stale') return `This recommendation is stale and cannot be executed until it is refreshed against current exposure. ${f.changes.join(' ')}`;
    // Strategy page: the primary is still a proposal. The package being confirmed must trade the amount the recommendation was computed for.
    const p = row.request.primary;
    if (p?.status === 'proposed' && p.instrument?.terminalId && p.quantity > 0) {
      const mine = legs.filter((l) => (l.purpose || 'primary') === 'primary' && ['trade', 'link'].includes(l.kind || 'trade') && (l.instrumentId || l.inst?.id) === p.instrument.terminalId);
      const qty = mine.reduce((a, l) => a + (num(l.qty) || 0), 0);
      if (mine.length && Math.abs(qty - p.quantity) > 1e-9) return `This recommendation was computed for ${p.direction} ${fmtQty(p.quantity)} ${p.instrument.symbol || p.instrument.name}, but the package trades ${fmtQty(qty)}. Request the hedge again for this amount.`;
    }
    return null;
  }

  // ---- waiting requests: refreshed when the service can answer -----------------------------------------
  let couldAnswer = false, lastRefresh = 0;

  /**
   * Requests still waiting for Shaffer Hedge are sent again once it can answer: when the
   * connection comes up, and then at the analytics refresh interval. Each one is rebuilt against
   * the exposure as it stands now and written back to the SAME request, so nothing is duplicated.
   * A request whose position was closed in the meantime is closed, not sent. An incomplete request
   * is not sent. Nothing is ever executed from here; the result waits in the review queue.
   */
  async function refreshWaiting({ force = false } = {}) {
    closeOrphans();
    const can = canAnswer();
    const cameUp = can && !couldAnswer;
    couldAnswer = can;
    if (!can) return [];
    const nowMs = clock.ms();
    if (!force && !cameUp && nowMs - lastRefresh < app.data.getRefresh().analyticsMs) return [];
    lastRefresh = nowMs;
    const rows = db.all(`SELECT * FROM hedge_requests WHERE status IN ('awaiting','error') AND (strategy_id IS NOT NULL OR scope_type IN ('account','book')) ORDER BY created_at`).map(parse);
    const out = [];
    for (const row of rows) {
      if (missingFields(row.request).length) continue;
      let req;
      try { req = await rebuild(row); } catch { continue; }
      if (missingFields(req).length) continue;
      db.run('UPDATE hedge_requests SET request = ?, updated_at = ? WHERE id = ?', j(req), clock.now().toISOString(), row.id);
      if ((await ask(row.id, { announce: true })) === 'received') out.push(row.id);
    }
    return out;
  }

  // Read-side memo for the position screens: valid until anything is written to the database.
  let memo = { stamp: -1, open: new Map(), links: new Map() };
  const stampNow = () => db.get('SELECT total_changes() AS n').n;
  function memoized(kind, key, compute) {
    if (memo.stamp !== stampNow()) memo = { stamp: stampNow(), open: new Map(), links: new Map() };
    if (memo[kind].has(key)) return memo[kind].get(key);
    const value = compute();
    // Computing may itself have brought allocations up to date; what was computed is current as of now.
    if (memo.stamp !== stampNow()) memo = { stamp: stampNow(), open: new Map(), links: new Map() };
    memo[kind].set(key, value);
    return value;
  }

  /** The request currently open for a strategy's position (waiting, or answered and not yet acted on). */
  function openForStrategy(strategyId) {
    return memoized('open', strategyId, () => { const r = openRowFor(strategyId); return r ? brief(r) : null; });
  }

  /**
   * Relationship fields for one position row: what it finances, hedges or is protected by (from
   * stored identifiers), its protection picture, and its part as a hedge.
   */
  function positionLinks(unitId, positionId) {
    const unit = memoized('links', unitId, () => ({ rel: protection.relations(unitId), view: protection.forUnit(unitId).byPosition }));
    const v = unit.view.get(positionId) || {};
    return { relationships: unit.rel.get(positionId) || [], protection: v.protection || null, hedgeOf: v.hedge || null };
  }

  /** Review queue of one Book: hedge requests that still need a decision, hedges being executed, and hedges whose exposure changed. */
  function queue(bookId) {
    const rows = db.all(`SELECT * FROM hedge_requests WHERE book_id = ? AND status IN ('awaiting','received','error','executed') AND (strategy_id IS NOT NULL OR scope_type IN ('account','book')) ORDER BY created_at DESC`, bookId).map(parse);
    const unitName = new Map(books.unitsOf(bookId).map((u) => [u.id, u.kind === 'treasury' ? 'Treasury' : u.name]));
    const items = rows.map((r) => ({ row: r, b: brief(r) })).filter(({ row, b }) => row.status !== 'executed' || b.state === 'executing').map(({ b }) => {
      const s = b.strategyId ? app.packages.getStrategyRow(b.strategyId) : null;
      return { ...b, owner: unitName.get(b.unitId) || null, strategy: s ? { id: s.id, name: s.name, status: s.status } : null };
    });
    const reviews = db.all(`SELECT id, name, unit_id, params FROM strategies WHERE book_id = ? AND status IN ('open','attention','partial') AND json_extract(params, '$.hedgeReview.needed') = 1`, bookId)
      .map((s) => ({ strategy: { id: s.id, name: s.name }, owner: unitName.get(s.unit_id), ...pj(s.params, {}).hedgeReview }));
    const svc = service();
    return { items, reviews, canAnswer: svc.reachable, service: svc, analytics: app.data.analytics.state().connection, awaitingMessage: app.data.describe().awaitingMessage };
  }

  function markExecuted(requestId, { packageId, submission, strategyId }) {
    const row = get(requestId);
    if (!row) return;
    const now = clock.now().toISOString();
    db.run(`UPDATE hedge_requests SET status = 'executed', selected_package = ?, executed_submission = ?, strategy_id = COALESCE(strategy_id, ?), prompt_seen = 1, updated_at = ? WHERE id = ?`, packageId || null, submission, strategyId || null, now, requestId);
    const sid = row.strategy_id || strategyId;
    if (sid) clearReview(sid);
    app.alerts.resolve({ refType: 'hedge', refId: requestId, code: 'hedge.ready' });
  }

  function dismiss(requestId) {
    const row = get(requestId);
    need(row, 'Hedge request not found.', { status: 404 });
    if (OPEN.includes(row.status)) db.run(`UPDATE hedge_requests SET status = 'dismissed', prompt_seen = 1, updated_at = ? WHERE id = ?`, clock.now().toISOString(), requestId);
    app.alerts.resolve({ refType: 'hedge', refId: requestId, code: 'hedge.ready' });
    return view(get(requestId));
  }

  // ---- linkage and review ----------------------------------------------------------------------------
  /**
   * Everything a strategy instance is linked to, from stored identifiers: its hedge requests, the
   * protection picture of its positions, and what each financing or hedge leg belongs to.
   */
  function forStrategy(strategyId) {
    const s = app.packages.getStrategyRow(strategyId);
    const rows = db.all('SELECT * FROM hedge_requests WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 20', strategyId).map(parse);
    let links = null, prot = [];
    if (s) {
      const rel = protection.relations(s.unit_id);
      const { byPosition } = protection.forUnit(s.unit_id);
      const open = positions.list({ unitIds: [s.unit_id], strategyId }).filter((p) => !isZero(p.qty));
      const orders = app.orders.forStrategy(strategyId);
      const legLabel = (n) => { const o = orders.find((x) => x.leg_no === n); const i = o?.instrument_id ? instruments.get(o.instrument_id) : null; return o ? `leg ${n}${i ? ` (${o.action.replace(/_/g, ' ')} ${fmtQty(o.qty)} ${i.symbol || i.name})` : ''}` : `leg ${n}`; };
      links = {
        strategyInstanceId: strategyId,
        positions: open.map((p) => ({ positionId: p.id, label: protection.describe(p), purpose: purposeOf(p), relations: rel.get(p.id) || [] })),
        legs: orders.filter((o) => (o.data.purpose || 'primary') !== 'primary' && ((o.data.fundsLegs || []).length || o.data.hedgeLinkId || (o.data.protectsLegs || []).length)).map((o) => ({
          legNo: o.leg_no, orderId: o.id, purpose: o.data.purpose || 'primary', hedgeRequestId: o.data.hedgeLinkId || null, fundsLegs: o.data.fundsLegs || [], protectsLegs: o.data.protectsLegs || [],
          text: (o.data.purpose === 'financing' && (o.data.fundsLegs || []).length ? `Financing for ${o.data.fundsLegs.map(legLabel).join(', ')}` : '')
            || (o.data.hedgeLinkId ? `Hedge leg of request ${o.data.hedgeLinkId}${(o.data.protectsLegs || []).length ? `, protects ${o.data.protectsLegs.map(legLabel).join(', ')}` : ''}` : '')
            || ((o.data.protectsLegs || []).length ? `Protection from the execution template, protects ${o.data.protectsLegs.map(legLabel).join(', ')}` : ''),
        })),
      };
      prot = open.map((p) => ({ positionId: p.id, label: protection.describe(p), ...byPosition.get(p.id) })).filter((x) => x.protection || x.hedge);
    }
    return {
      review: s?.params?.hedgeReview || null,
      investmentStrategy: refView(s?.params?.investmentStrategy),
      requests: rows.map((r) => brief(r)),
      links, protection: prot,
    };
  }

  function flagReview(strategyId, reason) {
    const s = app.packages.getStrategyRow(strategyId);
    if (!s) return;
    const hasHedges = positions.list({ unitIds: [s.unit_id], strategyId }).some((p) => !isZero(p.qty) && p.data.purpose === 'hedge');
    // A change to the primary matters only while hedges are on. A hedge that expired, matured or was exercised
    // matters even when it was the last one: the position it protected is still there, unprotected.
    const hedgeEnded = /^A hedge /.test(String(reason || '')) && hasOpenPrimary(strategyId);
    if (!hasHedges && !hedgeEnded) return;
    db.run('UPDATE strategies SET params = ? WHERE id = ?', j({ ...s.params, hedgeReview: { needed: true, reason, since: clock.now().toISOString() } }), strategyId);
    app.alerts.raise({ bookId: s.book_id, unitId: s.unit_id, level: 'warning', code: 'hedge.review', refType: 'strategy', refId: strategyId, message: `${s.name}: ${reason}. ${hasHedges ? 'The hedges linked to it may no longer match the exposure' : 'The position no longer has that protection'}. Request updated hedge instructions; nothing is traded until you confirm.` });
  }
  function clearReview(strategyId) {
    const s = app.packages.getStrategyRow(strategyId);
    if (!s?.params?.hedgeReview) return;
    db.run('UPDATE strategies SET params = ? WHERE id = ?', j({ ...s.params, hedgeReview: null }), strategyId);
    app.alerts.resolve({ refType: 'strategy', refId: strategyId, code: 'hedge.review' });
  }

  /** Called when a strategy's status changes. Queues the automatic post-trade hedge request. */
  function onStrategyChange(strategyId, from, to) {
    const s = app.packages.getStrategyRow(strategyId);
    if (!s) return;
    const settled = ['open', 'attention'].includes(to) && ['working', 'partial'].includes(from);
    // Only a direct Marketplace trade asks for a hedge by itself, and only once per position.
    if (settled && s.params.origin === 'marketplace' && s.params.intent !== 'hedge' && !db.get('SELECT 1 FROM hedge_requests WHERE strategy_id = ? LIMIT 1', strategyId)) postTradeQueue.add(strategyId);
    if (to === 'closed') clearReview(strategyId);
  }

  /**
   * Workflow 2: after a direct Marketplace trade executes, request a hedge on the filled position.
   * A strategy instance that holds only hedge legs or financing (a borrowing, a repo, a securities
   * borrow) has no primary exposure and never gets a request of its own.
   */
  async function processQueue() {
    protection.syncAll();
    closeOrphans();
    const ids = [...postTradeQueue];
    const out = [];
    for (const id of ids) {
      // Taken off the queue once dealt with, whatever the outcome; an interrupted cycle finds it again, and the
      // check for an existing request keeps a second pass from asking twice.
      try {
        const s = app.packages.getStrategyRow(id);
        if (!s || !hasOpenPrimary(id)) continue;
        if (db.get('SELECT 1 FROM hedge_requests WHERE strategy_id = ? LIMIT 1', id)) continue;
        out.push(await request({ bookId: s.book_id, unitId: s.unit_id, strategyId: id, scope: { type: 'trade' }, trigger: 'post_trade', investmentStrategy: s.params.investmentStrategy, holdingPeriod: s.params.holdingPeriod, objective: s.params.hedgeObjective }));
      } finally {
        postTradeQueue.delete(id);
      }
    }
    return out;
  }

  /** Post-trade hedge prompts the UI has not shown yet. */
  function prompts(bookId) {
    return db.all(`SELECT * FROM hedge_requests WHERE book_id = ? AND trigger = 'post_trade' AND prompt_seen = 0 AND status IN ${OPEN_SQL} ORDER BY created_at`, bookId).map(parse).map((r) => view(r));
  }
  const markSeen = (requestId) => db.run('UPDATE hedge_requests SET prompt_seen = 1 WHERE id = ?', requestId);

  const list = (bookId) => db.all('SELECT * FROM hedge_requests WHERE book_id = ? ORDER BY created_at DESC LIMIT 100', bookId).map(parse).map((r) => view(r));

  /** What the top bar and the Data connection page say about who answers hedge requests. */
  function serviceStatus() {
    const svc = service();
    return { ...svc, analytics: app.data.analytics.state().connection, script: app.config.demo ? scriptView() : null, demoFixtureEnabled: app.config.demo ? Boolean(app.data.getSetting('demo.hedgeFixture', true)) : null, states: HEDGE_STATES, capacityRules: protection.CAPACITY_RULES };
  }

  return {
    objectives: () => HEDGE_OBJECTIVES, scopes: () => HEDGE_SCOPES, families: () => HEDGE_FAMILIES, states: () => HEDGE_STATES,
    buildRequest, request, complete, refresh, get: (id) => view(get(id)), packageLegs, previewPackage, executionGuard, markExecuted, dismiss, forStrategy, flagReview, clearReview, onStrategyChange, processQueue, prompts, markSeen, list, queueSize: () => postTradeQueue.size,
    refreshWaiting, closeOrphans, openForStrategy, positionLinks, queue, canAnswer, service, serviceStatus, setScript, scriptView,
    strategyList, strategyRef, strategiesView, resolveStrategyName, refView,
  };
}

