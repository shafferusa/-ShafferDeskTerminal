// Hedge integration.
//
// Shaffer Hedge is an analytical engine in Analytics Lab. It evaluates exposures, selects hedge
// structures, sizes their legs and returns trade instructions. The Terminal's part is to
//
//   1. build a complete hedge request (a ticker and a quantity alone are not enough),
//   2. show the proposed packages with the quotes or indicative terms available for their legs,
//   3. run confirmed paper execution through the normal package engine, and
//   4. keep every hedge, financing leg and primary position linked through their lifecycle.
//
// No hedge-selection or sizing logic lives here. Until the service contract is supplied every
// request resolves to "Awaiting Shaffer data connection".

import { j, pj } from '../db/db.js';
import { demoHedgeResponse } from '../data/demo-hedge.js';
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

export function createHedge(app) {
  const { db, clock, books, instruments, positions } = app;
  const parse = (r) => r && { ...r, request: pj(r.request, {}), response: pj(r.response, null) };
  const get = (id) => parse(db.get('SELECT * FROM hedge_requests WHERE id = ?', id));
  const postTradeQueue = new Set();

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
      positionId: p.id, strategyInstanceId: p.strategy_id || null, purpose: p.data.purpose || 'primary', hedgeLinkId: p.data.hedgeLinkId || null,
      instrument: instrumentRef(inst), quantity: p.qty, direction: v.direction, currency: v.ccy,
      // Facts only. Deltas, betas, DV01 and other sensitivities are computed by Analytics Lab.
      marketValue: v.mv, notional: v.notional, marketValueReporting: v.mvRc, priceObservation: v.priceObs ? { value: v.priceObs.value, status: v.priceObs.status, source: v.priceObs.source, asOf: v.priceObs.asOf } : null,
      expiration: inst.terms.expiration || null, maturity: inst.terms.maturity || inst.terms.valueDate || null,
    };
  }

  /**
   * Build the hedge request for Shaffer Hedge.
   * input: { bookId, unitId, scope: {type, id?}, instrumentId, direction, quantity, notional, investmentStrategy, holdingPeriod,
   *          objective: {type, serverDefined, settings}, proposedLegs, strategyId, trigger }
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
      const mine = all.filter((p) => p.strategy_id === strategy.id && (p.data.purpose || 'primary') === 'primary' && !['secloan', 'loan', 'repo'].includes(instruments.get(p.instrument_id).family));
      const main = mine.find((p) => p.instrument_id === inst?.id) || mine[0];
      if (main) {
        const v = app.valuation.position(main);
        const mi = instruments.get(main.instrument_id);
        const o = app.orders.forStrategy(strategy.id).filter((x) => x.instrument_id === mi.id && x.kind === 'trade' && x.filled_qty > 0);
        primary = { instrument: instrumentRef(mi), direction: main.qty > 0 ? 'long' : 'short', quantity: Math.abs(main.qty), notional: v.notional, currency: v.ccy, status: 'filled', averagePrice: v.avgCost, filledQuantity: Math.abs(main.qty), orderedQuantity: o.reduce((a, x) => a + x.qty, 0) || null, priceObservation: v.priceObs ? { value: v.priceObs.value, status: v.priceObs.status, source: v.priceObs.source, asOf: v.priceObs.asOf } : null };
        existingPosition = positionFact(main);
      }
    }
    if (!primary && inst && scopeType !== 'account' && scopeType !== 'book') {
      const obs = app.data.price(inst.id);
      const qty = num(input.quantity);
      primary = { instrument: instrumentRef(inst), direction: input.direction === 'short' ? 'short' : 'long', quantity: qty, notional: num(input.notional) ?? (qty && obs?.value !== null && obs?.value !== undefined ? qty * obs.value * inst.multiplier : null), currency: inst.trading_ccy, status: 'proposed', averagePrice: null, priceObservation: obs ? { value: obs.value, status: obs.status, source: obs.source, asOf: obs.asOf } : null };
      const held = all.filter((p) => p.instrument_id === inst.id);
      if (held.length) existingPosition = positionFact(held[0]);
    }
    const objective = HEDGE_OBJECTIVES.find((o) => o.id === input.objective?.type) || null;
    const hedges = all.filter((p) => (p.data.purpose || 'primary') === 'hedge' && (scopeType === 'account' || scopeType === 'book' || !strategy || p.strategy_id === strategy.id)).map(positionFact);
    return {
      schema: 'shaffer-desk-terminal.hedge-request.draft-1',
      requestId: null, createdAt: clock.now().toISOString(), trigger: input.trigger || 'manual',
      scope: { type: scopeType, bookId: book.id, unitId: unit?.id || null, strategyInstanceId: strategy?.id || null },
      book: { id: book.id, name: book.name, reportingCurrency: book.reporting_ccy },
      account: unit ? { id: unit.id, name: unit.name, kind: unit.kind } : null,
      investmentStrategy: input.investmentStrategy?.name || input.investmentStrategy?.id ? { id: input.investmentStrategy.id || null, name: input.investmentStrategy.name || null } : strategy?.params?.investmentStrategy || null,
      holdingPeriod: input.holdingPeriod && (input.holdingPeriod.days || input.holdingPeriod.until || input.holdingPeriod.label) ? { days: num(input.holdingPeriod.days), until: input.holdingPeriod.until || null, label: input.holdingPeriod.label || null } : strategy?.params?.holdingPeriod || null,
      objective: { type: objective?.id || null, label: objective?.label || null, serverDefined: input.objective?.serverDefined || null, settings: input.objective?.settings || {} },
      primary,
      // Protection already inside the selected execution template is passed as proposed protection.
      proposedLegs: (input.proposedLegs || []).map((l) => ({ role: l.role || null, purpose: l.purpose || 'primary', kind: l.kind || 'trade', action: l.action, quantity: l.qty, isProtection: l.purpose === 'hedge', instrument: l.instrumentId ? instrumentRef(instruments.get(l.instrumentId)) : l.option ? { family: 'option', underlying: instrumentRef(instruments.get(l.option.underlyingId)), terms: l.option } : l.contract ? { family: l.contract.productId, terms: l.contract.terms, name: l.contract.name } : null })),
      existingPosition,
      existingHedges: hedges,
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

  /** Build a request, send it to Shaffer Hedge (when connected) and store both. */
  async function request(input0) {
    let input = input0;
    let packageNote = null;
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
        };
      } catch (err) {
        packageNote = `The execution template could not be resolved into legs yet: ${err.message}`;
      }
    }
    // Drafts made while the Strategy page was being filled in, and never acted on, are replaced.
    if (input.trigger === 'strategy_page' && input.unitId) db.run(`DELETE FROM hedge_requests WHERE trigger = 'strategy_page' AND unit_id = ? AND strategy_id IS NULL AND status IN ('awaiting','received','error')`, input.unitId);
    const req = buildRequest(input);
    if (packageNote) req.templateNote = packageNote;
    const id = newId('HDG');
    req.requestId = id;
    const missing = missingFields(req);
    const now = clock.now().toISOString();
    let status = 'awaiting', message = app.data.describe().awaitingMessage, response = null;
    if (missing.length && input.trigger !== 'post_trade') {
      message = `The hedge request is incomplete: ${missing.join(', ')} still needed. ${message}`;
    }
    const r = app.config.demo && app.data.getSetting('demo.hedgeFixture', true)
      ? { available: true, response: await demoHedgeResponse(app, req) }
      : await app.data.analytics.hedge(req);
    if (r?.available) {
      response = normalizeResponse(r.response);
      status = 'received';
      message = response.packages.length ? null : response.note || 'Shaffer Hedge returned no packages for this request.';
    } else if (r?.reason === 'error') {
      status = 'error';
      message = r.message;
    }
    if (input.strategyId) db.run(`UPDATE hedge_requests SET status = 'superseded', updated_at = ? WHERE strategy_id = ? AND status IN ('awaiting','received','error')`, now, input.strategyId);
    db.run(
      `INSERT INTO hedge_requests (id, book_id, unit_id, scope_type, scope_id, strategy_id, trigger, request, response, status, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, req.scope.bookId, req.scope.unitId, req.scope.type, req.scope.strategyInstanceId || req.scope.unitId || req.scope.bookId, input.strategyId || null, req.trigger, j(req), response ? j(response) : null, status, message, now, now,
    );
    return view(get(id), missing);
  }

  function normalizeResponse(raw) {
    const packages = (raw?.packages || []).map((p, i) => ({
      id: String(p.id ?? `pkg-${i + 1}`), label: p.label || `Package ${i + 1}`, recommended: Boolean(p.recommended), riskAddressed: p.riskAddressed || [], intendedProtection: p.intendedProtection ?? null,
      horizon: p.horizon || null, exposure: p.exposure || [], upsideSurrendered: p.upsideSurrendered ?? null, costs: p.costs || null, scenarios: p.scenarios || [], valuation: p.valuation || null, notes: p.notes || [],
      legs: (p.legs || []).map((l) => ({ ...l, role: l.role === 'financing' ? 'financing' : 'hedge' })),
    }));
    return { source: raw?.source || 'Shaffer Hedge (Analytics Lab)', asOf: raw?.asOf || null, modelRun: raw?.modelRun || null, fixture: Boolean(raw?.fixture), note: raw?.note || null, recommendedId: raw?.recommendedId || packages.find((p) => p.recommended)?.id || null, packages };
  }

  function view(row, missing) {
    if (!row) return null;
    return {
      id: row.id, status: row.status, message: row.message, trigger: row.trigger, scope: { type: row.scope_type, id: row.scope_id }, strategyId: row.strategy_id, bookId: row.book_id, unitId: row.unit_id,
      request: row.request, missing: missing ?? missingFields(row.request), response: row.response, selectedPackage: row.selected_package, executedSubmission: row.executed_submission,
      awaitingMessage: app.data.describe().awaitingMessage, analytics: app.data.analytics.state().connection, createdAt: row.created_at, updatedAt: row.updated_at,
    };
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

  /** Preview a proposed package through the normal package engine (quotes, funding, collateral, per-leg checks). */
  async function previewPackage(requestId, packageId, { legs } = {}) {
    const row = get(requestId);
    need(row, 'Hedge request not found.', { status: 404 });
    const req = row.request;
    const useLegs = legs && legs.length ? legs : packageLegs(requestId, packageId);
    const attach = row.strategy_id && ['trade', 'strategy_package'].includes(row.scope_type) ? row.strategy_id : null;
    const unitId = req.scope.unitId || books.treasuryOf(req.scope.bookId).id;
    const pkg = row.response?.packages?.find((p) => p.id === packageId);
    const pv = await app.packages.preview({
      bookId: req.scope.bookId, unitId, template: 'custom', attachTo: attach, intent: 'hedge', legs: useLegs, hedgeLinkId: requestId, hedgePackageId: packageId || null,
      name: attach ? undefined : `Hedge: ${pkg?.label || 'package'} (${req.account?.name || req.book.name})`,
      underlyingId: req.primary?.instrument?.terminalId || null, investmentStrategy: req.investmentStrategy, holdingPeriod: req.holdingPeriod,
    });
    return { ...pv, hedge: { requestId, packageId, package: pkg || null } };
  }

  function markExecuted(requestId, { packageId, submission, strategyId }) {
    const row = get(requestId);
    if (!row) return;
    const now = clock.now().toISOString();
    db.run(`UPDATE hedge_requests SET status = 'executed', selected_package = ?, executed_submission = ?, strategy_id = COALESCE(strategy_id, ?), prompt_seen = 1, updated_at = ? WHERE id = ?`, packageId || null, submission, strategyId || null, now, requestId);
    const sid = row.strategy_id || strategyId;
    if (sid) clearReview(sid);
  }

  function dismiss(requestId) {
    const row = get(requestId);
    need(row, 'Hedge request not found.', { status: 404 });
    if (row.status !== 'executed') db.run(`UPDATE hedge_requests SET status = CASE WHEN status = 'executed' THEN status ELSE 'dismissed' END, prompt_seen = 1, updated_at = ? WHERE id = ?`, clock.now().toISOString(), requestId);
    return view(get(requestId));
  }

  // ---- linkage and review ----------------------------------------------------------------------------
  function forStrategy(strategyId) {
    const s = app.packages.getStrategyRow(strategyId);
    const rows = db.all('SELECT * FROM hedge_requests WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 20', strategyId).map(parse);
    return {
      review: s?.params?.hedgeReview || null,
      requests: rows.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, message: r.message, createdAt: r.created_at, selectedPackage: r.selected_package, packages: r.response?.packages?.length ?? 0 })),
    };
  }

  function flagReview(strategyId, reason) {
    const s = app.packages.getStrategyRow(strategyId);
    if (!s) return;
    const hasHedges = positions.list({ unitIds: [s.unit_id], strategyId }).some((p) => !isZero(p.qty) && p.data.purpose === 'hedge');
    if (!hasHedges) return;
    db.run('UPDATE strategies SET params = ? WHERE id = ?', j({ ...s.params, hedgeReview: { needed: true, reason, since: clock.now().toISOString() } }), strategyId);
    app.alerts.raise({ bookId: s.book_id, unitId: s.unit_id, level: 'warning', code: 'hedge.review', refType: 'strategy', refId: strategyId, message: `${s.name}: ${reason}. The hedges linked to it may no longer match the exposure. Request updated hedge instructions; nothing is traded until you confirm.` });
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
    if (settled && s.params.origin === 'marketplace' && !db.get('SELECT 1 FROM hedge_requests WHERE strategy_id = ? LIMIT 1', strategyId)) postTradeQueue.add(strategyId);
    if (to === 'closed') clearReview(strategyId);
  }

  /** Workflow 2: after a direct Marketplace trade executes, request a hedge on the filled position. */
  async function processQueue() {
    const ids = [...postTradeQueue];
    postTradeQueue.clear();
    const out = [];
    for (const id of ids) {
      const s = app.packages.getStrategyRow(id);
      if (!s) continue;
      const hasPrimary = positions.list({ unitIds: [s.unit_id], strategyId: id }).some((p) => !isZero(p.qty));
      if (!hasPrimary) continue;
      out.push(await request({ bookId: s.book_id, unitId: s.unit_id, strategyId: id, scope: { type: 'trade' }, trigger: 'post_trade', investmentStrategy: s.params.investmentStrategy, holdingPeriod: s.params.holdingPeriod, objective: s.params.hedgeObjective }));
    }
    return out;
  }

  /** Post-trade hedge prompts the UI has not shown yet. */
  function prompts(bookId) {
    return db.all(`SELECT * FROM hedge_requests WHERE book_id = ? AND trigger = 'post_trade' AND prompt_seen = 0 AND status IN ('awaiting','received','error') ORDER BY created_at`, bookId).map(parse).map((r) => view(r));
  }
  const markSeen = (requestId) => db.run('UPDATE hedge_requests SET prompt_seen = 1 WHERE id = ?', requestId);

  const list = (bookId) => db.all('SELECT * FROM hedge_requests WHERE book_id = ? ORDER BY created_at DESC LIMIT 100', bookId).map(parse).map((r) => view(r));

  return {
    objectives: () => HEDGE_OBJECTIVES, scopes: () => HEDGE_SCOPES, families: () => HEDGE_FAMILIES,
    buildRequest, request, get: (id) => view(get(id)), packageLegs, previewPackage, markExecuted, dismiss, forStrategy, flagReview, clearReview, onStrategyChange, processQueue, prompts, markSeen, list, queueSize: () => postTradeQueue.size,
  };
}
