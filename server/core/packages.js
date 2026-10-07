// Strategy instances (packages): preview, confirmation, submission, lifecycle actions.
//
// Flow:  build legs  ->  preview (estimates, requirements, checks, payoff)  ->  one explicit
// confirmation  ->  every leg becomes its own order under one strategy-instance ID.
//
// The preview is editable: the client may send the legs back changed, and they are re-validated
// from scratch. Nothing is submitted without the confirmation token, and a token can be used
// only once (duplicate submissions return the original result).

import { j, pj } from '../db/db.js';
import { makeObservation, markOf } from '../data/observation.js';
import { fmt } from './books.js';
import { compare, compareLegacyCash, confirmedLeg, refusalMessage, snapshotOf, tolerancesOf } from './confirmation.js';
import { computeFees, estimateFill } from './fillmodel.js';
import { analyzePackage, optionRequirement } from './payoff.js';
import { TEMPLATES, buildLegs, getTemplate } from './templates.js';
import { AppError, isZero, money, need, newId, num, round, uuid } from './util.js';
import { fmtQty } from '../products/common.js';
import { calendarInfo } from '../products/security.js';
import { resolveSettlement, TRADING_DAY_KINDS, tradingDay } from './settlement.js';

const BUY = new Set(['buy', 'buy_to_cover']);
const ARR_OPEN = new Set(['loan', 'repo_open', 'lend_sec']);
const ARR_CLOSE = new Set(['repay', 'repo_close', 'return_sec', 'recall_sec']);
const KIND_LABEL = { trade: 'Trade', borrow_sec: 'Securities borrow', return_sec: 'Return borrowed securities', loan: 'Cash loan', repay: 'Repayment', repo_open: 'Repo', repo_close: 'Repo repurchase', lend_sec: 'Securities lending', recall_sec: 'Recall lent securities', reserve: 'Cash reservation', link: 'Use existing position', funding: 'Treasury funding' };

export function createPackages(app) {
  const { db, clock, ledger, positions, instruments, books } = app;

  const parseStrategy = (s) => s && { ...s, params: pj(s.params, {}), preview: pj(s.preview, {}) };
  const getStrategyRow = (id) => parseStrategy(db.get('SELECT * FROM strategies WHERE id = ?', id));
  function requireStrategy(id) {
    const s = getStrategyRow(id);
    if (!s) throw new AppError('Strategy instance not found.', { status: 404 });
    return s;
  }

  // =============================================================================================
  // Leg resolution
  // =============================================================================================

  async function loadChains(und, expirations) {
    const out = new Map();
    for (const exp of [...new Set(expirations.filter(Boolean))]) {
      const r = await app.data.market.optionChain(und, { expiration: exp });
      if (r?.available && r.chain?.expiration === exp) out.set(exp, r.chain);
    }
    return out;
  }

  function chainContract(chains, { expiration, strike, right }) {
    const chain = chains.get(expiration);
    if (!chain) return null;
    const c = (right === 'C' ? chain.calls : chain.puts).find((x) => Math.abs(x.strike - strike) < 1e-9);
    return c ? { chain, c } : null;
  }

  /** Turn a leg spec into a leg with an instrument (registered or draft) attached. */
  function resolveLeg(leg, n, { unit, chains }) {
    const out = { ...leg, n };
    out.kind = leg.kind || 'trade';
    out.purpose = leg.purpose || 'primary';
    out.qty = num(leg.qty);
    need(out.qty > 0, `Leg ${n}: quantity must be positive.`);
    if (ARR_CLOSE.has(out.kind)) {
      const p = positions.get(leg.targetPositionId);
      need(p && p.unit_id === unit.id, `Leg ${n}: the arrangement to close was not found in this Treasury/Account.`);
      out.inst = instruments.get(p.instrument_id);
      out.targetPosition = p;
      return out;
    }
    if (out.kind === 'reserve') { out.inst = null; return out; }
    if (out.kind === 'funding') { out.inst = null; return out; }
    if (leg.option) {
      const spec = leg.option;
      const existing = instruments.findOption(spec);
      if (existing) { out.inst = existing; out.instrumentId = existing.id; } else {
        const id = `draft:opt:${spec.underlyingId}:${spec.expiration}:${spec.right}:${spec.strike}`;
        out.inst = instruments.draft(instruments.optionDraft(spec), id);
      }
      const hit = chains ? chainContract(chains, spec) : null;
      if (hit) {
        out.chainObs = makeObservation({
          kind: 'price', subject: out.inst.id, value: hit.c.last, bid: hit.c.bid, ask: hit.c.ask, bidSize: hit.c.bidSize, askSize: hit.c.askSize, currency: hit.c.currency || out.inst.trading_ccy,
          units: 'premium per underlying unit', source: hit.chain.source, providerId: hit.chain.providerId, status: hit.chain.status, asOf: hit.chain.asOf, receivedAt: clock.now().toISOString(),
          delayMinutes: hit.chain.delayMinutes ?? null, extra: { iv: hit.c.iv, openInterest: hit.c.openInterest },
        });
      }
      return out;
    }
    if (leg.contract) {
      out.inst = instruments.draft(leg.contract, `draft:${n}`);
      return out;
    }
    need(leg.instrumentId, `Leg ${n}: choose an instrument.`);
    out.inst = instruments.require(leg.instrumentId);
    return out;
  }

  // =============================================================================================
  // Preview
  // =============================================================================================

  /**
   * Build and validate a package without submitting anything.
   * input: { bookId, unitId, template, underlyingId, quantity | targetNotional, mode, existingPositionId, hedgeRatio,
   *          orderType, limitPrice, netLimit, tif, options, futures, pair, borrow, financing, legs?, attachTo?, name?,
   *          investmentStrategy?, holdingPeriod?, hedge?, intent?, assumedVol? }
   */
  async function preview(input) {
    const book = books.requireBook(input.bookId);
    const unit = books.requireUnit(input.unitId, book.id);
    need(!unit.closed_at, 'That Account is closed.');
    const tpl = getTemplate(input.template || 'custom');
    need(tpl, 'Unknown strategy template.');
    const attach = input.attachTo ? requireStrategy(input.attachTo) : null;
    if (attach) need(attach.unit_id === unit.id, 'Legs can only be added to a strategy in the same Treasury/Account.');
    const und = input.underlyingId ? instruments.require(input.underlyingId) : null;

    // ---- facts the template needs --------------------------------------------------------------
    const o = input.options || {};
    const chains = und && (o.expiration || o.farExpiration || (input.legs || []).some((l) => l.option)) ? await loadChains(und, [o.expiration, o.farExpiration, ...(input.legs || []).filter((l) => l.option).map((l) => l.option.expiration)]) : new Map();
    const preNeed = new Map();
    if (und) preNeed.set(und.id, und);
    for (const id of [input.pair?.instrumentId, input.futures?.instrumentId, input.futures?.farInstrumentId]) { const i = id ? instruments.get(id) : null; if (i) preNeed.set(i.id, i); }
    await app.data.refresh({ instruments: [...preNeed.values()] });

    const ctx = {
      underlying: und,
      instrument: (id) => (id ? instruments.get(id) : null),
      price: (id) => markOf(app.data.price(id)),
      position: (id) => { const p = id ? positions.get(id) : null; return p && p.unit_id === unit.id ? p : null; },
      optionMeta: (spec) => {
        const reg = und ? db.all(`SELECT id FROM instruments WHERE family = 'option' AND underlying_id = ? AND status = 'active'`, und.id).map((r) => instruments.get(r.id)).find((i) => i.terms.expiration === spec.expiration && i.terms.right === spec.right && Math.abs(i.terms.strike - spec.strike) < 1e-9) : null;
        if (reg) return { multiplier: reg.multiplier, deliverableUnits: reg.terms.deliverable.units, exercise: reg.terms.exercise, settlement: reg.terms.settlement };
        const hit = chainContract(chains, spec);
        if (hit) return { multiplier: hit.c.multiplier, deliverableUnits: hit.c.deliverable?.shares ?? hit.c.deliverable?.units ?? hit.c.multiplier, exercise: hit.c.exercise || 'american', settlement: hit.c.settlement || 'physical' };
        return null;
      },
    };

    // ---- legs --------------------------------------------------------------------------------------
    const edited = Array.isArray(input.legs) && input.legs.length > 0;
    let specs = edited ? input.legs.map((l) => ({ ...l })) : buildLegs(input, ctx);
    if (!edited) {
      // Role names -> leg numbers, and single-leg order instructions.
      const roleToN = new Map(specs.map((l, i) => [l.role, i + 1]));
      specs = specs.map((l) => ({ ...l, dependsOn: (l.dependsOn || []).map((d) => (typeof d === 'number' ? d : roleToN.get(d))).filter(Boolean) }));
      const tradeLegs = specs.filter((l) => l.kind === 'trade');
      for (const l of tradeLegs) {
        l.tif = input.tif || 'day';
        if (tradeLegs.length === 1 || !tpl.net) {
          l.orderType = l.orderType || input.orderType || 'market';
          if (tradeLegs.length === 1) { l.limitPrice = num(input.limitPrice); l.stopPrice = num(input.stopPrice); }
        }
      }
      if (tradeLegs.length > 1 && ['limit', 'stop', 'stop_limit'].includes(input.orderType) && !tpl.net) for (const l of tradeLegs) l.orderType = 'market';
    }

    // ---- hedge package chosen on the Strategy page -----------------------------------------------
    // The legs come from Shaffer Hedge's instructions. Each hedge trade depends on the primary
    // exposure leg, so protection is scaled to what actually fills and never exceeds it.
    if (input.appendHedge === true && input.hedgeLinkId && input.hedgePackageId && app.hedge) {
      const base = specs.length;
      const primaryN = specs.findIndex((l) => (l.purpose || 'primary') === 'primary' && ['trade', 'link'].includes(l.kind || 'trade')) + 1;
      const extra = app.hedge.packageLegs(input.hedgeLinkId, input.hedgePackageId).map((l) => ({
        ...l, tif: l.tif || input.tif || 'day',
        dependsOn: [...(l.dependsOn || []).map((d) => d + base), ...(primaryN && l.kind === 'trade' && l.purpose === 'hedge' ? [primaryN] : [])],
      }));
      specs = [...specs, ...extra];
      for (const l of extra) if (l.option && und && l.option.underlyingId === und.id && !chains.has(l.option.expiration)) for (const [k, v] of await loadChains(und, [l.option.expiration])) chains.set(k, v);
    }

    let legs = specs.map((l, i) => resolveLeg(l, i + 1, { unit, chains }));
    let est = await estimateLegs({ book, unit, legs, attach, input });

    // ---- optional financing sized to the shortfall ----------------------------------------------------
    const fin = input.financing;
    // Auto-sized financing applies when the package does not already carry a financing leg.
    if (fin && fin.mode && fin.mode !== 'none' && !specs.some((l) => ['funding', 'loan'].includes(l.kind))) {
      const add = [];
      for (const [ccy, t] of Object.entries(est.totals.cash)) {
        if (!(t.shortfall > 0)) continue;
        const amount = Math.ceil(t.shortfall * 100) / 100;
        if (fin.mode === 'treasury') {
          const tr = books.treasuryOf(book.id);
          need(unit.kind !== 'treasury', 'Treasury cannot fund itself. Choose borrowing, or deposit capital.');
          add.push({ purpose: 'financing', role: `funding_${ccy}`, kind: 'funding', action: 'treasury_funding', qty: amount, funding: { fromUnitId: tr.id, ccy, amount }, note: 'Internal transfer from Treasury sized to the package\'s cash shortfall.' });
        } else if (fin.mode === 'loan') {
          add.push({
            purpose: 'financing', role: `loan_${ccy}`, kind: 'loan', action: 'borrow_cash', qty: amount,
            contract: {
              productId: 'margin_loan', name: `Margin loan ${ccy} (${tpl.name}${und ? ` ${und.symbol || und.name}` : ''})`, marketView: 'US_CASH', venueType: 'otc', tradingCcy: ccy,
              terms: { loanType: 'margin', rateType: fin.rateType || 'fixed', rate: fin.rate, referenceRate: fin.referenceRate, spread: fin.spread, maturity: fin.maturity || null, counterparty: 'Simulated lender' },
            },
            note: 'Simulated borrowing sized to the package\'s cash shortfall. Borrowed cash is a liability.',
          });
        }
      }
      if (add.length) {
        const k = add.length;
        const shifted = specs.map((l) => ({ ...l, dependsOn: [...(l.dependsOn || []).map((d) => d + k), ...(needsCash(l) ? add.map((_, i) => i + 1) : [])] }));
        specs = [...add, ...shifted];
        legs = specs.map((l, i) => resolveLeg(l, i + 1, { unit, chains }));
        est = await estimateLegs({ book, unit, legs, attach, input });
      }
    }

    const token = input.clientToken || uuid();
    const name = input.name || attach?.name || defaultName(tpl, und, legs);
    const result = {
      token,
      bookId: book.id, unitId: unit.id, unit: { id: unit.id, name: unit.name, kind: unit.kind }, book: { id: book.id, name: book.name, reportingCcy: book.reporting_ccy },
      template: tpl.id, templateName: tpl.name, name, edited, attachTo: attach?.id || null, intent: input.intent || (attach ? 'adjust' : 'open'),
      underlying: und ? app.valuation.lite(und) : null,
      legs: est.legs,
      totals: est.totals,
      checks: est.checks,
      blocking: est.checks.filter((c) => c.level === 'error').length,
      payoff: est.payoff,
      protection: est.protection,
      netLimit: num(input.netLimit),
      generatedAt: clock.now().toISOString(),
      data: { market: app.data.market.state().connection, message: app.data.market.state().message },
      input: sanitizeInput(input),
    };
    // What a confirmation of this preview confirms: the displayed figures of every leg and of the
    // package, with the Book's tolerances. The confirmation sends it back as `expected`.
    result.confirmation = snapshotOf(result, book);
    return result;
  }

  const needsCash = (l) => l.kind === 'trade' && (BUY.has(l.action) || l.action === 'sell_short' || l.action === 'sell');

  function sanitizeInput(input) {
    // appendHedge is a one-time instruction: once the hedge legs are in the package they travel
    // with the legs, so a re-check or the confirmation must not add them again.
    const { legs, clientToken, confirm, appendHedge, expected, ...rest } = input;
    return rest;
  }

  function defaultName(tpl, und, legs) {
    const first = legs.find((l) => l.inst);
    const what = und ? (und.symbol || und.name) : first ? (first.inst.symbol || first.inst.name) : '';
    return `${tpl.id === 'custom' ? 'Custom' : tpl.name.split(' / ')[0]} ${what}`.trim();
  }

  /** Estimates, requirements and checks for resolved legs. */
  async function estimateLegs({ book, unit, legs, attach, input }) {
    const today = clock.today();
    const rc = book.reporting_ccy;
    const checks = [];
    const check = (level, code, message, leg) => checks.push({ level, code, message, leg: leg ?? null });
    const awaiting = app.data.describe().awaitingMessage;
    const connected = app.data.marketConnected();

    // ---- refresh what the estimates need ------------------------------------------------------------
    const insts = new Map(), borrow = new Map(), pairs = new Set();
    for (const l of legs) {
      if (!l.inst) continue;
      if (!l.inst.draft) insts.set(l.inst.id, l.inst);
      if (l.inst.underlying_id) { const u = instruments.get(l.inst.underlying_id); if (u) insts.set(u.id, u); }
      if (l.kind === 'borrow_sec') borrow.set(l.inst.id, l.inst);
      if (l.inst.trading_ccy !== rc) pairs.add(`${l.inst.trading_ccy}/${rc}`);
    }
    await app.data.refresh({ instruments: [...insts.values()], borrow: [...borrow.values()], pairs: [...pairs], sessions: [...insts.values()] });

    const out = [];
    const cashEffect = {}; // ccy -> signed cash the package nets to (excluding restricted proceeds)
    const needs = {}; // ccy -> components
    const collateralCalls = new Map(); // posting unit and currency -> independent amount this package calls for at once
    const bump = (ccy, key, x) => { needs[ccy] = needs[ccy] || { purchases: 0, proceeds: 0, restrictedProceeds: 0, fees: 0, margin: 0, collateral: 0, reserved: 0, financingIn: 0, financingOut: 0 }; needs[ccy][key] += x; };
    let anyUnknownCash = false;
    const payoffLegs = [];

    for (const l of legs) {
      const row = baseLegView(l);
      const inst = l.inst;
      const plugin = inst ? app.products.get(inst.family) : null;
      // Trading calendar: a leg that is matched in a market is held as a working order on a day that market is
      // closed. The preview says so (a warning, not a block) and counts the trade date from the day it will be matched.
      const gate = inst && TRADING_DAY_KINDS.has(l.kind) ? tradingDay(inst, today) : null;
      if (gate) row.trading = { open: gate.open, calendarId: gate.calendarId, tradeDate: gate.next, reason: gate.reason };
      if (gate && !gate.open) check('warning', 'not-trading-day', `Leg ${l.n}: ${gate.reason.replace(/^Market closed/, `the market of ${inst.symbol || inst.name} is closed`).replace('; will be matched on', '. The order stays working and will be matched on')}${l.kind === 'trade' ? ` Its trade date and settlement are counted from that day; a Day order placed today is good for ${gate.next}.` : ''}`, l.n);
      const tradeDate = gate ? gate.next : today;

      if (l.kind === 'trade') {
        if (!plugin.actions(inst).includes(l.action)) check('error', 'action', `Leg ${l.n}: ${inst.symbol || inst.name} cannot be traded with "${String(l.action).replace(/_/g, ' ')}".`, l.n);
        const step = plugin.qtyStep ? plugin.qtyStep(inst) : 1;
        if (step >= 1 && Math.abs(l.qty / step - Math.round(l.qty / step)) > 1e-9) check('error', 'qty-step', `Leg ${l.n}: quantity must be a multiple of ${step}.`, l.n);
        const sup = inst.draft ? null : instruments.support(inst);
        if (sup && sup.level !== 'full') check('info', 'support', `Leg ${l.n}: ${sup.productName} has ${sup.level} paper support. ${sup.note}`, l.n);
        if (inst.terms?.expiration && inst.terms.expiration < today) check('error', 'expired', `Leg ${l.n}: ${inst.symbol || inst.name} expired on ${inst.terms.expiration}.`, l.n);
        const obs = inst.draft ? l.chainObs || null : app.data.price(inst.id) || l.chainObs || null;
        const stated = num(l.statedPrice);
        const fe = estimateFill(app, { inst, action: l.action, obs, book, statedPrice: stated, limitPrice: num(l.limitPrice), stopPrice: num(l.stopPrice), orderType: l.orderType || 'market' });
        const refPrice = fe.price ?? (num(l.limitPrice) || null) ?? markOf(obs);
        row.price = {
          estimate: fe.price, reference: markOf(obs), model: fe.model, label: fe.label, note: fe.note, executable: fe.executable, reason: fe.reason || null,
          waitingOnLimit: Boolean(fe.waitingOnLimit), waitingOnStop: Boolean(fe.waitingOnStop), observation: obs ? app.data.present(obs) : null,
          missing: refPrice === null,
        };
        // On a closed day the estimate is the price now; the leg cannot fill until the market's next trading day.
        if (gate && !gate.open) Object.assign(row.price, { executable: false, waitingOnCalendar: true, reason: gate.reason });
        // Settlement: the instrument's convention, or the date / lag stated for this trade (l.settle),
        // validated against the instrument's settlement calendar. A calendar conflict blocks the preview.
        // Counted from the day the leg will be matched (today, unless its market is closed today).
        const stl = resolveSettlement(app, { inst, book, tradeDate, stated: l.settle || null });
        const settleDate = stl.date;
        row.settleDate = settleDate;
        row.settle = stl.stated;
        row.settlement = { date: stl.date, lag: stl.lag, basis: stl.basis, label: stl.label, stated: stl.stated, standard: stl.standard, calendarId: stl.calendar.id, conflict: stl.conflicts[0]?.message || null, tradeDate };
        for (const cf of stl.conflicts) check('error', cf.code, `Leg ${l.n}: ${cf.message}`, l.n);
        row.currency = inst.trading_ccy;
        const cal = calendarInfo(inst);
        row.calendar = cal;
        if (cal.settlement.fallback) check('warning', 'calendar-fallback', `Leg ${l.n}: the settlement date ${settleDate} for ${inst.symbol || inst.name} was worked out on weekends only. ${cal.settlement.note || 'No holiday calendar exists for its market.'}`, l.n);
        else if (cal.settlement.note) check('info', 'calendar-approximate', `Leg ${l.n}: settlement calendar for ${inst.symbol || inst.name}: ${cal.settlement.label}. ${cal.settlement.note}`, l.n);
        if (refPrice === null) {
          // Notional of a swap, CDS or forward does not depend on a price, so it can still be shown.
          if (['swap', 'cds', 'forward'].includes(inst.family)) {
            const e0 = plugin.economics(app, { inst, action: l.action, qty: l.qty, price: 0, unit, strategyId: attach?.id || '', tradeDate, settleDate, book });
            row.notional = inst.family === 'forward' && inst.terms.forwardType !== 'fra' ? l.qty : e0.notional;
            row.econNotes = e0.notes || [];
            // Collateral is a share of notional, so it is known without a price.
            if (e0.initialMargin > 0) { row.initialMargin = e0.initialMargin; bump(inst.trading_ccy, 'margin', e0.initialMargin); }
            // The collateral basis the contract states, and what it calls for, do not wait for a price either.
            app.agreements.addToPreview(e0.collateral, { row, leg: l.n, check, bump, calls: collateralCalls });
          } else if (inst.family === 'otcoption') {
            const e0 = plugin.economics(app, { inst, action: l.action, qty: l.qty, price: 0, unit, strategyId: attach?.id || '', tradeDate, settleDate, book });
            if (e0.initialMargin > 0) { row.initialMargin = e0.initialMargin; bump(inst.trading_ccy, 'margin', e0.initialMargin); }
            app.agreements.addToPreview(e0.collateral, { row, leg: l.n, check, bump, calls: collateralCalls });
          }
          anyUnknownCash = true;
          check('warning', 'no-price', `Leg ${l.n}: no price for ${inst.symbol || inst.name}. ${connected ? 'No observation is available.' : `${awaiting}.`} The leg would wait as a working order; enter a manual price or state a fill price to execute it.`, l.n);
        } else {
          if (!fe.executable && !fe.waitingOnLimit && !fe.waitingOnStop) check('warning', 'not-executable', `Leg ${l.n}: ${fe.reason}`, l.n);
          const econ = plugin.economics(app, { inst, action: l.action, qty: l.qty, price: refPrice, unit, strategyId: attach?.id || '', tradeDate, settleDate, book });
          const fees = computeFees(book, inst, l.qty, refPrice);
          const feeTotal = fees.reduce((a, f) => a + f.amount, 0);
          Object.assign(row, { gross: money(econ.principal, econ.ccy), cash: money(econ.cash, econ.ccy), accrued: money(econ.accrued || 0, econ.ccy), notional: econ.notional !== null && econ.notional !== undefined ? money(econ.notional, econ.ccy) : null, notionalBasis: econ.notionalBasis || null, exposure: econ.exposure ?? null, initialMargin: econ.initialMargin ?? 0, fees, feeTotal: money(feeTotal, econ.ccy), econNotes: econ.notes || [], otherCash: econ.otherCash || [] });
          const ccy = econ.ccy;
          bump(ccy, 'fees', feeTotal);
          // OTC collateral: the basis that applies, its requirement, and any check that blocks (no basis stated, agreement of another Book, independent amount not covered).
          app.agreements.addToPreview(econ.collateral, { row, leg: l.n, check, bump, calls: collateralCalls });
          if (inst.family === 'future') bump(ccy, 'margin', Math.max(econ.initialMargin || 0, 0));
          else if (econ.initialMargin > 0) { bump(ccy, 'margin', econ.initialMargin); if (econ.cash < 0) bump(ccy, 'purchases', -econ.cash); else if (econ.cash > 0) bump(ccy, 'proceeds', econ.cash); }
          else if (l.action === 'sell_short') {
            bump(ccy, 'restrictedProceeds', econ.cash);
            const s = book.settings.short;
            bump(ccy, 'collateral', (s.collateralPct - 1) * econ.cash);
            bump(ccy, 'margin', s.marginPct * econ.cash);
            row.shortCollateral = { topUp: money((s.collateralPct - 1) * econ.cash, ccy), marginHold: money(s.marginPct * econ.cash, ccy), collateralPct: s.collateralPct, marginPct: s.marginPct };
          } else if (econ.cash < 0) bump(ccy, 'purchases', -econ.cash);
          else bump(ccy, 'proceeds', econ.cash);
          for (const oc of econ.otherCash || []) { if (oc.amount < 0) bump(oc.ccy, 'purchases', -oc.amount); else bump(oc.ccy, 'proceeds', oc.amount); }
          if (inst.family === 'future' && (inst.terms.initialMargin === null || inst.terms.initialMargin === undefined)) check('warning', 'no-margin', `Leg ${l.n}: no initial margin figure has been supplied for ${inst.symbol || inst.name}, so none will be posted.`, l.n);
        }
        // Position checks that do not need a price.
        const pos = attach ? positions.find(unit.id, inst.id, attach.id) : null;
        const rule = plugin.shortRule || 'none';
        if (l.action === 'sell' && rule !== 'write' && rule !== 'cash') {
          const held = pos?.qty || 0;
          const linked = legs.filter((x) => x.kind === 'link' && x.inst?.id === inst.id).reduce((a, x) => a + x.qty, 0);
          const bought = legs.filter((x) => x.kind === 'trade' && x.action === 'buy' && x.inst?.id === inst.id && x.n < l.n).reduce((a, x) => a + x.qty, 0);
          if (held + linked + bought < l.qty - 1e-9) check('error', 'no-position', `Leg ${l.n}: this strategy holds ${fmtQty(Math.max(held, 0))} ${inst.symbol || inst.name}; it cannot sell ${fmtQty(l.qty)}. To go short, use a short sale with a securities borrow.`, l.n);
        }
        if (l.action === 'buy_to_cover') {
          const short = Math.max(0, -(pos?.qty || 0));
          if (short < l.qty - 1e-9) check('error', 'no-short', `Leg ${l.n}: this strategy is short ${fmtQty(short)} ${inst.symbol || inst.name}; it cannot buy ${fmtQty(l.qty)} to cover.`, l.n);
        }
        if (l.action === 'sell_short') {
          const borrowLeg = legs.find((x) => x.kind === 'borrow_sec' && x.inst?.id === inst.id);
          const existing = attach ? app.orders.borrowedQty(unit.id, inst.id, attach.id) - Math.max(0, -(pos?.qty || 0)) : 0;
          const linkedShort = legs.some((x) => x.kind === 'link' && x.inst?.id === inst.id);
          if (!borrowLeg && existing < l.qty - 1e-9 && !linkedShort) check('error', 'no-borrow', `Leg ${l.n}: a short sale needs a securities borrow. Add a borrow leg for ${inst.symbol || inst.name}.`, l.n);
          if (borrowLeg && !(l.dependsOn || []).includes(borrowLeg.n)) l.dependsOn = [...(l.dependsOn || []), borrowLeg.n];
        }
        if (BUY.has(l.action) || l.action === 'sell' || l.action === 'sell_short') {
          payoffLegs.push({ inst, signedQty: (BUY.has(l.action) ? 1 : -1) * l.qty, price: refPrice, iv: obs?.extra?.iv ?? null, n: l.n });
        }
      } else if (l.kind === 'borrow_sec') {
        const info = app.data.borrowInfo(inst.id);
        const stated = l.borrow;
        const px = markOf(app.data.price(inst.id));
        const b = { needed: l.qty, available: null, quantityAvailable: null, feeRate: null, source: null, dailyCost: null, observation: null };
        if (info) {
          Object.assign(b, { available: info.available, quantityAvailable: info.quantity ?? null, feeRate: info.feeRate, source: info.obs?.source || 'Supplied data', observation: info.obs ? app.data.present(info.obs) : null });
          if (!info.available) check('error', 'borrow-unavailable', `Leg ${l.n}: ${inst.symbol || inst.name} is not available to borrow (${b.source}). The dependent short sale cannot execute.`, l.n);
          else if (info.quantity !== null && info.quantity !== undefined && info.quantity < l.qty) check('error', 'borrow-short', `Leg ${l.n}: only ${fmtQty(info.quantity)} ${inst.symbol || inst.name} is available to borrow (${b.source}); ${fmtQty(l.qty)} is needed.`, l.n);
        } else if (stated && stated.feeRate !== null && stated.feeRate !== undefined && stated.feeRate !== '') {
          const fr = num(stated.feeRate);
          Object.assign(b, { available: stated.available !== false, quantityAvailable: num(stated.quantity), feeRate: fr, source: 'Stated assumption (manually entered)' });
          if (!(fr >= 0 && fr < 5)) check('error', 'borrow-fee', `Leg ${l.n}: enter the borrow fee as a decimal per annum (0.005 = 0.5%).`, l.n);
          if (stated.available === false) check('error', 'borrow-unavailable', `Leg ${l.n}: your stated assumption marks the borrow as unavailable.`, l.n);
          else check('info', 'borrow-assumed', `Leg ${l.n}: borrow availability and fee are your stated assumption, not market data.`, l.n);
        } else {
          check('error', 'borrow-unknown', `Leg ${l.n}: no borrow availability data for ${inst.symbol || inst.name}. ${connected ? 'None is supplied for this instrument.' : `${awaiting}.`} State a borrow assumption (availability and fee) to proceed.`, l.n);
        }
        if (b.feeRate !== null && px !== null) b.dailyCost = money((l.qty * px * inst.multiplier * b.feeRate) / 360, inst.trading_ccy);
        row.borrowInfo = b;
        row.currency = inst.trading_ccy;
      } else if (ARR_OPEN.has(l.kind)) {
        const problems = plugin.checkOpen ? plugin.checkOpen(app, { unit, inst, action: l.action, qty: l.qty, collateralPositionId: l.collateralPositionId, sourcePositionId: l.sourcePositionId }) : [];
        for (const p of problems) check('error', 'arrangement', `Leg ${l.n}: ${p}`, l.n);
        const ccy = inst.trading_ccy;
        row.currency = ccy;
        row.terms = plugin.describe(inst, app);
        if (l.action === 'borrow_cash' || l.action === 'repo') { bump(ccy, 'financingIn', l.qty); row.cash = l.qty; }
        if (l.action === 'lend_cash' || l.action === 'reverse_repo') { bump(ccy, 'financingOut', l.qty); row.cash = -l.qty; }
        if (inst.terms.rateType === 'fixed' && inst.terms.rate !== null && inst.terms.rate !== undefined && l.kind !== 'lend_sec') row.dailyCost = money((l.qty * inst.terms.rate) / 360, ccy);
        if (inst.terms.rateType === 'floating') {
          const ro = app.data.rate(inst.terms.referenceRate);
          if (!ro) check('warning', 'no-rate', `Leg ${l.n}: no fixing for ${inst.terms.referenceRate}. ${connected ? '' : `${awaiting}. `}Interest will not accrue until a rate is supplied or entered.`, l.n);
          else row.dailyCost = money((l.qty * (ro.value / 100 + (inst.terms.spread || 0))) / 360, ccy);
        }
        // The financing terms as displayed and confirmed: amount, rate and maturity of this leg.
        if (l.kind !== 'lend_sec') {
          const fx0 = inst.terms.rateType === 'floating' ? app.data.rate(inst.terms.referenceRate) : null;
          row.financing = { amount: row.cash ?? null, ccy, rateType: inst.terms.rateType || null, rate: inst.terms.rateType === 'fixed' ? inst.terms.rate ?? null : null, referenceRate: inst.terms.rateType === 'floating' ? inst.terms.referenceRate || null : null, spread: inst.terms.rateType === 'floating' ? inst.terms.spread ?? 0 : null, fixing: fx0 ? fx0.value : null, maturity: inst.terms.maturity || inst.terms.endDate || null, dailyCost: row.dailyCost ?? null, interestFrom: inst.terms.startDate || tradeDate };
        }
      } else if (ARR_CLOSE.has(l.kind)) {
        const p = l.targetPosition;
        const problems = plugin.checkClose ? plugin.checkClose(app, { unit, inst, pos: p, qty: Math.min(l.qty, Math.abs(p.qty)) }) : [];
        // A return that waits for a cover leg in the same package is expected, not an error.
        const coveredHere = l.kind === 'return_sec' && legs.some((x) => x.kind === 'trade' && x.action === 'buy_to_cover' && x.inst?.id === inst.underlying_id);
        for (const msg of problems) check(coveredHere ? 'info' : l.required === false ? 'warning' : 'error', 'arrangement', `Leg ${l.n}: ${msg}`, l.n);
        row.currency = inst.trading_ccy;
        if (l.kind === 'repay' || l.kind === 'repo_close') {
          // The cash a repayment moves is principal plus the interest that is settled with it, so that
          // what is displayed and confirmed is what leaves (or reaches) the unit when the leg executes.
          const amt = plugin.closeAmounts ? plugin.closeAmounts(app, { inst, pos: p, qty: l.qty }) : { principal: Math.min(l.qty, Math.abs(p.qty)), interest: 0, full: false };
          const total = money(amt.principal + amt.interest, inst.trading_ccy);
          if (p.qty < 0) { bump(inst.trading_ccy, 'financingOut', total); row.cash = -total; } else { bump(inst.trading_ccy, 'financingIn', total); row.cash = total; }
          row.financing = { amount: row.cash, ccy: inst.trading_ccy, principal: amt.principal, interest: amt.interest, full: amt.full, interestThrough: amt.accruedThrough || null, rateType: inst.terms.rateType || null, rate: inst.terms.rateType === 'fixed' ? inst.terms.rate ?? null : null, referenceRate: inst.terms.rateType === 'floating' ? inst.terms.referenceRate || null : null, spread: inst.terms.rateType === 'floating' ? inst.terms.spread ?? 0 : null, maturity: inst.terms.maturity || inst.terms.endDate || null };
          if (amt.rateMissing) check('warning', 'no-rate', `Leg ${l.n}: interest on ${inst.name} has not accrued since ${amt.rateMissing} because no ${inst.terms.referenceRate} fixing is available. The interest shown is what has accrued so far.`, l.n);
        }
      } else if (l.kind === 'reserve') {
        const r = l.reserve || {};
        need(r.ccy && r.amount > 0, `Leg ${l.n}: the cash reservation needs a currency and an amount.`);
        row.currency = r.ccy;
        row.reserve = { ccy: r.ccy, amount: money(r.amount, r.ccy) };
      } else if (l.kind === 'link') {
        const src = positions.get(l.sourcePositionId);
        if (!src || src.unit_id !== unit.id || src.instrument_id !== inst.id) check('error', 'link', `Leg ${l.n}: the existing position to use was not found in this Treasury/Account.`, l.n);
        else {
          if (Math.abs(src.qty) < l.qty - 1e-9) check('error', 'link', `Leg ${l.n}: the existing position is ${fmtQty(Math.abs(src.qty))}; ${fmtQty(l.qty)} was requested.`, l.n);
          if (src.qty > 0 && positions.freeQty(src) < l.qty - 1e-9) check('error', 'link', `Leg ${l.n}: only ${fmtQty(positions.freeQty(src))} of the existing position is unencumbered.`, l.n);
          const px = markOf(app.data.price(inst.id));
          row.existing = { positionId: src.id, qty: src.qty, strategyId: src.strategy_id || null, avgCost: isZero(src.qty) ? null : round(src.cost / (src.qty * inst.multiplier), 6), price: px };
          row.currency = inst.trading_ccy;
          payoffLegs.push({ inst, signedQty: Math.sign(src.qty) * l.qty, price: px, existing: true, n: l.n });
        }
      } else if (l.kind === 'funding') {
        const f = l.funding || {};
        need(f.fromUnitId && f.ccy && f.amount > 0, `Leg ${l.n}: Treasury funding needs a source, currency and amount.`);
        const from = books.getUnit(f.fromUnitId);
        const have = from ? ledger.cash(from.id, f.ccy).availableToWithdraw : 0;
        if (!from || from.book_id !== book.id) check('error', 'funding', `Leg ${l.n}: the funding source is not in this Book.`, l.n);
        else if (have < f.amount - 0.004) check('error', 'funding', `Leg ${l.n}: ${from.name} has ${fmt(have, f.ccy)} of settled ${f.ccy} available; ${fmt(f.amount, f.ccy)} is needed. A transfer does not convert currency.`, l.n);
        bump(f.ccy, 'financingIn', f.amount);
        row.currency = f.ccy;
        row.cash = f.amount;
        row.fundingInfo = { from: from ? { id: from.id, name: from.name } : null, available: have };
        row.financing = { amount: f.amount, ccy: f.ccy, from: from ? from.name : null };
      }
      row.dependsOn = l.dependsOn || [];
      out.push(row);
    }

    // ---- short-option cash requirement of the resulting position ---------------------------------------
    const bucket = (attach ? positions.list({ unitIds: [unit.id], strategyId: attach.id }) : []).map((p) => ({ inst: instruments.get(p.instrument_id), qty: p.qty }));
    for (const pl of payoffLegs) {
      const hit = bucket.find((b) => b.inst.id === pl.inst.id);
      if (hit) hit.qty += pl.existing ? 0 : pl.signedQty; else bucket.push({ inst: pl.inst, qty: pl.signedQty });
    }
    const optReq = optionRequirement(app, bucket.filter((b) => !isZero(b.qty)), book.settings.margin);
    const heldNow = attach ? ledger.listHolds([unit.id]).filter((h) => h.ref_type === 'strategy' && h.ref_id === attach.id) : [];
    for (const r of optReq) {
      const already = heldNow.filter((h) => h.ccy === r.ccy).reduce((a, h) => a + h.amount, 0);
      bump(r.ccy, 'reserved', Math.max(0, r.amount - already));
      if (r.uncoveredCallUnits > 0) check('warning', 'naked-call', `Uncovered short calls on ${fmtQty(r.uncoveredCallUnits)} units: loss is unbounded as the underlying rises. ${fmt(r.naked, r.ccy)} is reserved (${(book.settings.margin.nakedCallPct * 100).toFixed(0)}% of ${r.priceBasis}).`);
    }

    // ---- cash by currency -------------------------------------------------------------------------------
    const cash = {};
    for (const [ccy, n] of Object.entries(needs)) {
      const have = ledger.cash(unit.id, ccy);
      const required = n.purchases + n.fees + n.margin + n.collateral + n.reserved + n.financingOut;
      const sources = n.proceeds + n.financingIn;
      const shortfall = Math.max(0, required - sources - have.availableToTrade);
      cash[ccy] = {
        ccy, purchases: money(n.purchases, ccy), proceeds: money(n.proceeds, ccy), restrictedProceeds: money(n.restrictedProceeds, ccy), fees: money(n.fees, ccy), margin: money(n.margin, ccy),
        collateral: money(n.collateral, ccy), reserved: money(n.reserved, ccy), financingIn: money(n.financingIn, ccy), financingOut: money(n.financingOut, ccy),
        required: money(required, ccy), available: have.availableToTrade, settled: have.settled, shortfall: money(shortfall, ccy),
        netCash: money(n.proceeds + n.financingIn - n.purchases - n.fees - n.financingOut, ccy),
      };
      cashEffect[ccy] = cash[ccy].netCash;
      if (shortfall > 0.004) {
        check('error', 'cash', `${unit.name} is short ${fmt(shortfall, ccy)}: the package needs ${fmt(required, ccy)} (purchases ${fmt(n.purchases, ccy)}, fees ${fmt(n.fees, ccy)}, margin and collateral ${fmt(n.margin + n.collateral, ccy)}, reserved ${fmt(n.reserved, ccy)}) and ${fmt(have.availableToTrade + sources, ccy)} is available. Add Treasury funding or a borrowing leg, convert currency, or reduce the size.`);
      }
    }
    if (anyUnknownCash) check('warning', 'cash-unknown', 'Cash, margin and collateral requirements cannot be fully computed while a leg has no price.');

    // ---- settlement timing ------------------------------------------------------------------------------
    // Cash owed to the unit (an unsettled sale, a spot FX conversion still inside its T+2) counts as
    // buying power at once. If a purchase here settles before that cash arrives, say so up front.
    const flows = []; // { ccy, date, amount } for the trade legs of this package
    for (const r of out) {
      if (r.kind !== 'trade' || !r.settleDate || r.instrument?.family === 'future' || r.action === 'sell_short') continue;
      if (typeof r.cash === 'number' && r.cash !== 0) flows.push({ ccy: r.currency, date: r.settleDate, amount: r.cash });
      for (const oc of r.otherCash || []) if (oc.amount) flows.push({ ccy: oc.ccy, date: r.settleDate, amount: oc.amount });
    }
    const queued = app.settle.pending([unit.id]).filter((p) => !String(p.accounts).startsWith('["cash.restricted"'));
    for (const ccy of new Set(flows.filter((f) => f.amount < 0).map((f) => f.ccy))) {
      if (cash[ccy]?.shortfall > 0.004) continue; // already blocked for a plain shortage
      const immediate = (needs[ccy]?.financingIn || 0) - (needs[ccy]?.financingOut || 0);
      for (const date of [...new Set(flows.filter((f) => f.ccy === ccy && f.amount < 0).map((f) => f.date))].sort()) {
        const by = (list, key) => list.filter((x) => x.ccy === ccy && x[key] <= date).reduce((a, x) => a + x.amount, 0);
        const have = ledger.balance(unit.id, 'cash', ccy) + immediate + by(queued, 'due_date') + by(flows, 'date');
        if (have < -0.004) {
          const later = queued.filter((x) => x.ccy === ccy && x.due_date > date && x.amount > 0).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
          check('warning', 'settle-timing', `${fmt(-have, ccy)} of this package falls due on ${date}, before cash already owed to ${unit.name} settles${later.length ? ` (${fmt(later.reduce((a, x) => a + x.amount, 0), ccy)} arrives ${later[0].due_date}${later.length > 1 ? ' and later' : ''})` : ''}. That settlement would fail and be retried until the cash arrives. Bridge it with Treasury funding or a short-dated borrowing, or accept the delay.`);
          break;
        }
      }
    }

    // ---- guard against buying the underlying twice ------------------------------------------------------
    for (const l of legs) {
      if (l.kind !== 'trade' || l.action !== 'buy' || !l.inst || l.inst.draft) continue;
      if (!['equity', 'fund', 'spot', 'crypto', 'bond', 'manual'].includes(l.inst.family)) continue;
      const others = positions.list({ unitIds: [unit.id], instrumentId: l.inst.id }).filter((p) => p.qty > 0 && p.strategy_id !== (attach?.id || '~'));
      if (others.length && input.mode !== 'existing' && input.intent !== 'resize' && l.role === 'underlying') {
        const total = others.reduce((a, p) => a + p.qty, 0);
        check('warning', 'already-held', `${unit.name} already holds ${fmtQty(total)} ${l.inst.symbol || l.inst.name}. This package buys a new position. Choose "hedge an existing position" if you meant to use what is already held.`, l.n);
      }
    }

    // ---- protection already in place ------------------------------------------------------------------------
    // A hedge package from Shaffer Hedge must not silently double protection that the template or
    // the position already carries. Extra protection has to be asked for on purpose. Protection
    // "already carried" means allocated to the position (explicit link, template, or the service's
    // allocation): a hedge that merely sits in the same Account is not counted.
    const protection = analyzeProtection({ legs, attach, unit });
    protection.acknowledged = input.extraProtection === true;
    // A recommendation computed against exposure that has since changed cannot be executed until it is refreshed.
    if (input.hedgeLinkId && app.hedge?.executionGuard) {
      const blocked = app.hedge.executionGuard(input.hedgeLinkId, { legs });
      if (blocked) check('error', 'hedge-stale', blocked);
    }
    if (protection.topUp) check('info', 'protection-topup', `Protection is added to what is already in place, within the exposure still unprotected. ${protection.explain}`);
    if (protection.needsAcknowledgement) {
      const what = `Protection is already in place: ${protection.prior.map((x) => x.label).join('; ')}. The hedge package adds ${protection.added.map((x) => x.label).join('; ')}. ${protection.explain}`;
      if (protection.acknowledged) check('warning', 'extra-protection', `Additional protection, added deliberately. ${what}`);
      else check('error', 'extra-protection', `${what} Remove the hedge package, or confirm that the additional protection is deliberate.`);
    } else if (protection.oversized) check('warning', 'over-protection', protection.oversized);

    // ---- net premium and payoff ---------------------------------------------------------------------------
    let netPremium = null, premiumCcy = null, premiumKnown = true;
    for (const r of out) {
      if (r.kind !== 'trade' || !['option', 'otcoption'].includes(r.instrument?.family)) continue;
      if (r.cash === undefined || r.cash === null) { premiumKnown = false; continue; }
      netPremium = (netPremium || 0) - r.cash;
      premiumCcy = r.currency;
    }
    const netLimit = num(input.netLimit);
    if (netLimit !== null && netPremium !== null && premiumKnown && netPremium > netLimit + 0.005) check('info', 'net-limit', `The option legs would currently execute at a net ${netPremium >= 0 ? 'debit' : 'credit'} of ${fmt(Math.abs(netPremium), premiumCcy)}, outside your limit. They will work until the limit is reached.`);
    let payoff = null;
    if (input.reducing) {
      // Legs that only reduce what is already held carry no exposure of their own to analyse.
      payoff = { type: 'none', note: 'This package reduces positions already held, so it has no payoff of its own. Realized profit or loss is booked as each leg fills.', assumptions: [] };
    } else {
      try {
        payoff = analyzePackage(app, payoffLegs, { today, assumedVol: num(input.assumedVol) });
      } catch (err) {
        payoff = { type: 'none', note: `Payoff could not be computed: ${err.message}`, assumptions: [] };
      }
    }
    if (payoff?.maxLoss?.unbounded) {
      const note = payoff.maxLoss.note || '';
      check('warning', 'unbounded', /^Unbounded/.test(note) ? `Maximum loss is ${note[0].toLowerCase()}${note.slice(1)}` : `Maximum loss is not limited. ${note}`.trim());
    }

    // Financing obligations are shown apart from the legs that provide price or risk protection.
    const totals = {
      cash,
      netCashByCcy: cashEffect,
      netPremium: netPremium !== null ? { amount: money(netPremium, premiumCcy), ccy: premiumCcy, type: netPremium >= 0 ? 'debit' : 'credit', complete: premiumKnown } : null,
      optionRequirement: optReq,
      financing: out.filter((r) => r.purpose === 'financing').map((r) => ({ n: r.n, kind: r.kind, label: r.label, dailyCost: r.dailyCost ?? r.borrowInfo?.dailyCost ?? null, ccy: r.currency })),
      feeModel: 'Fees come from the Book\'s fee schedule. Fill prices use the fill model named on each leg.',
    };
    return { legs: out, totals, checks, payoff, protection };
  }

  /**
   * What protects what in a package. Exposure is the underlying held or bought (in underlying
   * units). Protection already in place ("prior") is
   *   - the template's own hedge legs (bought puts for a long, bought calls for a short, or another
   *     leg marked as a hedge), and
   *   - what is ALLOCATED to the positions of the strategy instance being added to: an explicit
   *     link, template protection, or an allocation returned by the service (core/protection.js).
   * A hedge that only sits in the same Account, unassessed, is not protection and is not counted.
   * `added` are the legs that came from a hedge package. Adding more than the exposure still
   * unprotected has to be acknowledged; a top-up within it is explained and allowed.
   * This measures overlap only. It does not choose or size a hedge.
   */
  function analyzeProtection({ legs, attach, unit }) {
    const SEC = new Set(['equity', 'fund', 'spot', 'crypto', 'bond', 'manual']);
    const exposure = new Map();
    const items = [];
    const expose = (inst, units) => exposure.set(inst.id, (exposure.get(inst.id) || 0) + units);
    const name = (inst) => inst.symbol || inst.name;
    const protect = (inst, signedQty, label, added) => {
      if (inst.family === 'option' || inst.family === 'otcoption') {
        if (signedQty <= 0) return; // a written option is not protection
        const per = inst.terms.deliverable?.units ?? inst.multiplier ?? 1;
        items.push({ underlyingId: inst.underlying_id || null, kind: inst.terms.right === 'P' ? 'put' : 'call', units: signedQty * per, label, added });
      } else items.push({ underlyingId: inst.underlying_id || null, kind: 'other', units: null, label, added });
    };
    if (attach) {
      for (const p of positions.list({ unitIds: [unit.id], strategyId: attach.id })) {
        if (isZero(p.qty)) continue;
        const inst = instruments.get(p.instrument_id);
        if (!SEC.has(inst.family)) continue;
        expose(inst, p.qty * inst.multiplier);
        if (!app.protection || (p.data.purpose || 'primary') !== 'primary') continue;
        for (const c of app.protection.coverOf(p.id).items) {
          const how = c.basis === 'service' ? `shared protection identified by ${c.source?.label || 'the service'}` : c.basis === 'template' ? 'from the execution template' : 'linked to this position';
          items.push({ underlyingId: c.kind === 'other' ? c.underlyingId : inst.id, kind: c.kind, units: c.units, label: `${c.label}, ${how}${c.units !== null ? ` (${fmtQty(c.units)} units)` : ''}`, added: false, basis: c.basis });
        }
      }
    }
    for (const l of legs) {
      const inst = l.inst;
      if (!inst) continue;
      if (l.kind === 'link') { const src = positions.get(l.sourcePositionId); if (src && SEC.has(inst.family)) expose(inst, Math.sign(src.qty) * l.qty * inst.multiplier); continue; }
      if (l.kind !== 'trade') continue;
      const signed = (BUY.has(l.action) ? 1 : -1) * l.qty;
      if (SEC.has(inst.family) && l.purpose !== 'hedge') expose(inst, signed * inst.multiplier);
      else if (l.purpose === 'hedge') protect(inst, signed, legLabel(l), Boolean(l.hedgeLinkId));
    }
    const prior = items.filter((x) => !x.added), added = items.filter((x) => x.added);
    const parts = [];
    let oversized = null, beyond = false, within = false;
    for (const kind of ['put', 'call']) {
      for (const und of new Set(added.filter((x) => x.kind === kind).map((x) => x.underlyingId))) {
        const u = und ? instruments.get(und) : null;
        const exp = exposure.get(und) || 0;
        const side = kind === 'put' ? Math.max(0, exp) : Math.max(0, -exp);
        const covered = prior.filter((x) => x.kind === kind && x.underlyingId === und).reduce((a, x) => a + x.units, 0);
        const adding = added.filter((x) => x.kind === kind && x.underlyingId === und).reduce((a, x) => a + x.units, 0);
        const remaining = Math.max(0, side - covered);
        parts.push(`The ${kind === 'put' ? 'long' : 'short'} exposure in ${u ? name(u) : 'the underlying'} is ${fmtQty(side)} units, of which ${fmtQty(Math.min(covered, side))} ${covered ? 'are' : 'is'} already protected, leaving ${fmtQty(remaining)}; the package adds ${kind}s on ${fmtQty(adding)}.`);
        if (covered > 0 && adding > remaining + 1e-9) beyond = true;
        else if (covered > 0) within = true;
        if (!prior.length && adding > side + 1e-9) oversized = `The hedge package buys ${kind}s on ${fmtQty(adding)} units of ${u ? name(u) : 'the underlying'}, more than the ${fmtQty(side)} units of exposure. Hedge legs are scaled to what the primary leg fills, but not below that.`;
      }
    }
    // Where either side has no unit measure, the overlap cannot be shown to fit: it has to be deliberate.
    const unmeasured = prior.length > 0 && added.length > 0 && (added.some((x) => x.kind === 'other') || prior.some((x) => x.kind === 'other'));
    if (unmeasured) parts.push('Part of the protection has no unit measure in the Terminal, so the overlap cannot be measured in units here.');
    const needsAcknowledgement = prior.length > 0 && added.length > 0 && (beyond || unmeasured);
    return {
      exposure: [...exposure].map(([id, units]) => ({ instrumentId: id, symbol: name(instruments.get(id) || { name: id }), units })),
      prior, added, explain: parts.join(' '), needsAcknowledgement, topUp: prior.length > 0 && added.length > 0 && within && !needsAcknowledgement, oversized,
    };
  }

  function baseLegView(l) {
    const inst = l.inst;
    const t = inst?.terms || {};
    return {
      n: l.n, purpose: l.purpose, role: l.role || null, kind: l.kind, kindLabel: KIND_LABEL[l.kind] || l.kind, action: l.action, group: l.group || null,
      instrumentId: inst && !inst.draft ? inst.id : null,
      option: l.option || null, contract: l.contract || null,
      instrument: inst ? { id: inst.id, draft: Boolean(inst.draft), symbol: inst.symbol, name: inst.name, family: inst.family, productId: inst.product_id, ccy: inst.trading_ccy, multiplier: inst.multiplier, marketView: inst.market_view, details: app.products.get(inst.family).describe?.(inst, app) || [] } : null,
      label: legLabel(l),
      qty: l.qty, qtyLabel: inst ? app.products.get(inst.family).qtyLabel : l.kind === 'reserve' ? 'Contracts secured' : 'Amount',
      strike: t.strike ?? null, expiration: t.expiration ?? null, right: t.right ?? null, multiplier: inst?.multiplier ?? null, deliverableUnits: t.deliverable?.units ?? null,
      orderType: l.orderType || 'market', limitPrice: num(l.limitPrice), stopPrice: num(l.stopPrice), tif: l.tif || 'day', statedPrice: num(l.statedPrice),
      settle: l.settle && (l.settle.date || (l.settle.lag !== null && l.settle.lag !== undefined && l.settle.lag !== '')) ? l.settle : null,
      required: l.required !== false, note: l.note || null,
      borrow: l.borrow || null, reserve: l.reserve || null, funding: l.funding ? { fromUnitId: l.funding.fromUnitId, ccy: l.funding.ccy, amount: l.funding.amount } : null,
      sourcePositionId: l.sourcePositionId || null, targetPositionId: l.targetPositionId || null, collateralPositionId: l.collateralPositionId || null,
      hedgeLinkId: l.hedgeLinkId || null, indicative: l.indicative || null, hedgeFamily: l.hedgeFamily || null, sizingBasis: l.sizingBasis || null, hedgeRatio: l.hedgeRatio ?? null, riskAddressed: l.riskAddressed || null,
    };
  }

  function legLabel(l) {
    const inst = l.inst;
    const what = inst ? (inst.symbol || inst.name) : '';
    switch (l.kind) {
      case 'trade': return `${{ buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' }[l.action] || l.action} ${fmtQty(l.qty)} ${what}`;
      case 'borrow_sec': return `Borrow ${fmtQty(l.qty)} ${what}`;
      case 'return_sec': return `Return ${fmtQty(l.qty)} borrowed ${app.instruments.get(inst.underlying_id)?.symbol || ''}`.trim();
      case 'loan': return `${l.action === 'borrow_cash' ? 'Borrow' : 'Lend'} ${fmt(l.qty, inst.trading_ccy)}`;
      case 'repay': return `${l.targetPosition?.qty < 0 ? 'Repay' : 'Withdraw'} ${fmt(l.qty, inst.trading_ccy)} (${inst.name})`;
      case 'repo_open': return `${l.action === 'repo' ? 'Repo' : 'Reverse repo'} ${fmt(l.qty, inst.trading_ccy)}`;
      case 'repo_close': return `Repurchase / terminate ${inst.name}`;
      case 'lend_sec': return `Lend ${fmtQty(l.qty)} ${app.instruments.get(inst.underlying_id)?.symbol || ''}`.trim();
      case 'recall_sec': return `Take back ${fmtQty(l.qty)} lent ${app.instruments.get(inst.underlying_id)?.symbol || ''}`.trim();
      case 'reserve': return `Reserve ${fmt(l.reserve?.amount || 0, l.reserve?.ccy || 'USD')} exercise cash`;
      case 'link': return `Use existing ${fmtQty(l.qty)} ${what}`;
      case 'funding': return `Fund ${fmt(l.funding?.amount || 0, l.funding?.ccy || 'USD')} from Treasury`;
      default: return l.kind;
    }
  }

  // =============================================================================================
  // Submission
  // =============================================================================================

  /** Confirmed submission of a previewed package. One confirmation, one token, used once. */
  async function submit(input) {
    need(input.confirm === true, 'Explicit confirmation is required to submit a paper-trade package.');
    need(input.clientToken, 'Missing confirmation token. Preview the package first.');
    // Duplicate submission: return what the first one created.
    const dupe = db.get('SELECT strategy_id FROM orders WHERE submission = ? LIMIT 1', input.clientToken) || db.get('SELECT id AS strategy_id FROM strategies WHERE client_token = ?', input.clientToken);
    if (dupe) return { duplicate: true, strategy: strategyView(dupe.strategy_id) };

    const pv = await preview(input);
    // Preview-to-execution reconciliation. The confirmation carries the figures that were on
    // screen (`expected`: the preview's `confirmation` snapshot). The same legs have just been
    // priced again as one snapshot; every leg and every package total is compared with what was
    // displayed, under the Book's tolerances. A figure beyond its tolerance, or a changed
    // non-numeric term, refuses the confirmation: nothing is submitted, and the new preview goes
    // back with the list of changes (was / now) for a new confirmation.
    const tol = tolerancesOf(books.requireBook(input.bookId));
    const shown = input.expected && Array.isArray(input.expected.legs) && input.expected.totals ? input.expected : null;
    // Displayed figures that cannot be read are refused outright: they must never count as "nothing to check".
    need(!input.expected || shown || (input.expected.cash && typeof input.expected.cash === 'object'), 'The confirmation carried displayed figures in a form the Terminal cannot read. Preview the package again and confirm from that preview.', { status: 400, code: 'expected_invalid' });
    const diffs = shown ? compare(shown, pv.confirmation, tol, { nowMs: clock.ms(), all: true }) : [];
    const changes = [...diffs.filter((c) => !c.within), ...(!shown && input.expected?.cash ? compareLegacyCash(input.expected.cash, pv, tol) : [])];
    if (pv.blocking) throw new AppError(pv.checks.find((c) => c.level === 'error').message, { status: 422, code: 'preview_failed', details: { preview: pv, changes, tolerances: tol } });
    if (changes.length) throw new AppError(refusalMessage(changes), { status: 409, code: 'preview_changed', details: { preview: pv, changes, tolerances: tol } });

    const book = books.requireBook(input.bookId);
    const unit = books.requireUnit(input.unitId, book.id);
    const now = clock.now().toISOString();
    const submission = input.clientToken;

    const strategyId = db.tx(() => {
      const again = db.get('SELECT strategy_id FROM orders WHERE submission = ? LIMIT 1', submission);
      if (again) return again.strategy_id;
      let sid = input.attachTo;
      const params = { ...pv.input, legs: undefined };
      if (!sid) {
        sid = newId('STR');
        db.run(
          `INSERT INTO strategies (id, book_id, unit_id, template, name, underlying_id, status, params, preview, client_token, signal_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'working', ?, ?, ?, ?, ?, ?)`,
          sid, book.id, unit.id, pv.template, pv.name, input.underlyingId || null, j({ ...params, edited: pv.edited, netLimits: {} }), j(snapshotPreview(pv)), submission, input.signalRef || null, now, now,
        );
      }
      const strat = getStrategyRow(sid);
      if (pv.netLimit !== null) {
        const p = { ...strat.params, netLimits: { ...(strat.params.netLimits || {}), [submission]: pv.netLimit } };
        db.run('UPDATE strategies SET params = ? WHERE id = ?', j(p), sid);
      }
      const baseLeg = db.get('SELECT COALESCE(MAX(leg_no), 0) AS m FROM orders WHERE strategy_id = ?', sid).m;
      const eventId = ledger.post({
        bookId: book.id, unitId: unit.id, type: input.attachTo ? 'strategy.legs_added' : 'strategy.submitted', strategyId: sid, instrumentId: input.underlyingId || null,
        summary: `${input.attachTo ? 'Legs added to' : 'Package submitted:'} ${pv.name} (${pv.legs.length} leg${pv.legs.length > 1 ? 's' : ''}; ${pv.intent})`,
        data: { template: pv.template, submission, intent: pv.intent, legs: pv.legs.map((l) => ({ n: l.n, label: l.label, purpose: l.purpose, estimate: l.price?.estimate ?? null, model: l.price?.model ?? null })), totals: pv.totals.cash, checks: pv.checks,
          // What was confirmed: the displayed snapshot when the confirmation carried one, the pricing at confirmation,
          // and every difference between the two that the Book's tolerances allowed.
          confirmation: { basis: shown ? 'displayed' : 'priced-at-confirmation', displayedAt: shown ? shown.snapshotAt : null, pricedAt: pv.generatedAt, tolerances: tol, displayedTotals: shown ? shown.totals : null, pricedTotals: pv.confirmation.totals, permitted: diffs.filter((c) => c.within) } },
      });
      for (const l of pv.legs) {
        let instrumentId = l.instrumentId;
        if (!instrumentId && l.option) instrumentId = instruments.ensureOption({ ...l.option, refSource: app.config.demo ? 'demo' : 'manual' }).id;
        else if (!instrumentId && l.contract) instrumentId = instruments.create(l.contract).id;
        else if (!instrumentId && l.instrument && !l.instrument.draft) instrumentId = l.instrument.id;
        app.orders.insert({
          strategyId: sid, submission, legNo: baseLeg + l.n, bookId: book.id, unitId: unit.id, instrumentId, kind: l.kind, action: l.action, role: l.role, qty: l.qty,
          orderType: l.orderType, limitPrice: l.limitPrice, stopPrice: l.stopPrice, tif: l.tif, dependsOn: (l.dependsOn || []).map((d) => baseLeg + d), required: l.required,
          data: {
            purpose: l.purpose, group: l.group, statedPrice: l.statedPrice, borrow: l.borrow, reserve: l.reserve, funding: l.funding,
            sourcePositionId: l.sourcePositionId, targetPositionId: l.targetPositionId, collateralPositionId: l.collateralPositionId,
            // The hedge request id belongs to the legs that came from that request. A primary or financing leg of the same
            // confirmation (the Strategy page adds a hedge package to a primary trade) never carries it.
            hedgeLinkId: l.hedgeLinkId || (pv.intent === 'hedge' && l.purpose !== 'primary' ? input.hedgeLinkId : null) || null,
            // Stored identifiers: the legs a financing leg funds and the legs a hedge leg protects (leg numbers within this strategy instance).
            fundsLegs: l.purpose === 'financing' ? linkedLegs(pv.legs, l, baseLeg) : undefined, protectsLegs: l.purpose === 'hedge' ? linkedLegs(pv.legs, l, baseLeg) : undefined,
            intent: pv.intent, estimate: l.price ? { price: l.price.estimate, model: l.price.model, reference: l.price.reference } : null, note: l.note, submitEventId: eventId,
            // The figures this leg was confirmed on (displayed, when the confirmation carried them), kept for
            // reconciliation with its fills. `settle` is a settlement date or lag stated for this trade.
            confirmed: confirmedLeg({
              shown: shown ? shown.legs.find((x) => x.n === l.n) || null : null, priced: pv.confirmation.legs.find((x) => x.n === l.n), tol,
              snapshotAt: shown ? shown.snapshotAt : null, confirmedAt: now, permitted: diffs.filter((c) => c.scope === 'leg' && c.n === l.n && c.within),
              feeSchedule: l.kind === 'trade' && l.instrument ? book.settings.fees[l.instrument.family] || null : null,
            }),
            settle: l.settle || null,
          },
        });
      }
      if (['retry', 'unwind', 'close'].includes(pv.intent)) resolveDeadLegs(sid, pv.intent);
      if (input.hedgeLinkId && app.hedge) app.hedge.markExecuted(input.hedgeLinkId, { packageId: input.hedgePackageId || null, submission, strategyId: sid });
      return sid;
    });

    await runMatching(strategyId);
    return { duplicate: false, strategy: strategyView(strategyId) };
  }

  /**
   * The legs of a package that a financing leg funds, or that a hedge leg protects: the primary legs
   * that wait on the financing leg, the primary leg a hedge leg waits on, and otherwise the
   * package's primary trade legs. Returned as leg numbers of the strategy instance.
   */
  function linkedLegs(all, l, baseLeg) {
    const primary = all.filter((x) => x.purpose === 'primary' && ['trade', 'link'].includes(x.kind));
    const tied = l.purpose === 'financing' ? primary.filter((x) => (x.dependsOn || []).includes(l.n)) : primary.filter((x) => (l.dependsOn || []).includes(x.n));
    return (tied.length ? tied : primary).map((x) => baseLeg + x.n);
  }

  function snapshotPreview(pv) {
    return { generatedAt: pv.generatedAt, totals: pv.totals, checks: pv.checks, payoff: pv.payoff ? { type: pv.payoff.type, breakevens: pv.payoff.breakevens, maxGain: pv.payoff.maxGain, maxLoss: pv.payoff.maxLoss, asOfExpiry: pv.payoff.asOfExpiry, assumptions: pv.payoff.assumptions } : null };
  }

  /** Refresh the data the working orders need, then run the matching pass. */
  async function runMatching(strategyId) {
    const n = app.orders.dataNeeds(strategyId);
    const rcPairs = new Set();
    for (const i of n.instruments) {
      const b = strategyId ? getStrategyRow(strategyId) : null;
      const rc = b ? ledger.rcOf(b.book_id) : 'USD';
      if (i.trading_ccy !== rc) rcPairs.add(`${i.trading_ccy}/${rc}`);
    }
    await app.data.refresh({ instruments: n.instruments, borrow: n.borrow, sessions: n.instruments, pairs: [...rcPairs] });
    return app.orders.process(strategyId);
  }

  // =============================================================================================
  // Strategy state
  // =============================================================================================

  /** Recompute the holds a strategy's positions require (short options, short stock margin). */
  function recomputeHolds(strategyId) {
    if (!strategyId) return;
    const s = getStrategyRow(strategyId);
    if (!s) return;
    const book = books.getBook(s.book_id);
    const all = positions.list({ unitIds: [s.unit_id], strategyId, includeClosed: true });
    const bucket = all.filter((p) => !isZero(p.qty)).map((p) => ({ inst: instruments.get(p.instrument_id), qty: p.qty, id: p.id }));
    const reqs = optionRequirement(app, bucket, book.settings.margin);
    const holds = ledger.listHolds([s.unit_id]).filter((h) => h.ref_type === 'strategy' && h.ref_id === strategyId);
    const shortPuts = bucket.some((p) => p.inst.family === 'option' && p.inst.terms.right === 'P' && p.qty < 0);
    const putSaleWorking = app.orders.active(strategyId).some((o) => o.kind === 'trade' && o.action === 'sell' && instruments.get(o.instrument_id)?.terms?.right === 'P');
    if (!shortPuts && !putSaleWorking) ledger.releaseHolds({ refType: 'strategy', refId: strategyId, kind: 'exercise_cash' });
    const exercise = {};
    for (const h of holds) if (h.kind === 'exercise_cash' && (shortPuts || putSaleWorking)) exercise[h.ccy] = (exercise[h.ccy] || 0) + h.amount;
    const byCcy = {};
    for (const r of reqs) byCcy[r.ccy] = (byCcy[r.ccy] || 0) + r.amount;
    const ccys = new Set([...Object.keys(byCcy), ...holds.filter((h) => h.kind === 'option_margin').map((h) => h.ccy)]);
    for (const ccy of ccys) {
      ledger.setHold({ bookId: s.book_id, unitId: s.unit_id, ccy, amount: Math.max(0, (byCcy[ccy] || 0) - (exercise[ccy] || 0)), kind: 'option_margin', refType: 'strategy', refId: strategyId, note: 'Cash reserved against short options' });
    }
    // Short securities: additional margin hold on current value.
    for (const p of all) {
      const inst = instruments.get(p.instrument_id);
      if (!['equity', 'bond'].includes(inst.family)) continue;
      let amount = 0;
      if (p.qty < 0) {
        const px = markOf(app.data.price(inst.id)) ?? Math.abs(p.cost / (p.qty * inst.multiplier));
        amount = book.settings.short.marginPct * Math.abs(p.qty) * px * inst.multiplier * (inst.family === 'bond' ? (inst.terms.factor ?? 1) : 1);
      }
      const has = ledger.listHolds([s.unit_id]).some((h) => h.ref_type === 'position' && h.ref_id === p.id && h.kind === 'short_margin');
      if (amount > 0 || has) ledger.setHold({ bookId: s.book_id, unitId: s.unit_id, ccy: inst.trading_ccy, amount, kind: 'short_margin', refType: 'position', refId: p.id, note: 'Margin held against a short position' });
    }
  }

  /** Derive a strategy's status from its legs and positions. */
  function refreshStrategy(strategyId) {
    const s = getStrategyRow(strategyId);
    if (!s) return null;
    const orders = app.orders.forStrategy(strategyId);
    const act = orders.filter((o) => app.orders.ACTIVE.has(o.status));
    const open = positions.list({ unitIds: [s.unit_id], strategyId }).filter((p) => !isZero(p.qty));
    const filledAny = orders.some((o) => o.filled_qty > 0);
    const dead = orders.filter((o) => app.orders.DEAD.has(o.status) && o.required && !o.data.resolved && o.filled_qty < o.qty - 1e-9);
    let status;
    if (act.length) status = filledAny || open.length ? 'partial' : 'working';
    else if (dead.length) status = open.length ? 'attention' : filledAny ? 'closed' : 'failed';
    else status = open.length ? 'open' : filledAny ? 'closed' : 'failed';
    const now = clock.now().toISOString();
    if (status !== s.status) {
      db.run('UPDATE strategies SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?', status, now, status === 'closed' ? now : null, strategyId);
      if (status === 'closed' || status === 'failed') {
        ledger.releaseHolds({ refType: 'strategy', refId: strategyId });
        app.alerts.resolve({ refType: 'strategy', refId: strategyId });
      }
      if (status === 'attention') {
        app.alerts.raise({ bookId: s.book_id, unitId: s.unit_id, level: 'error', code: 'strategy.attention', refType: 'strategy', refId: strategyId, message: `${s.name}: ${dead.length} required leg${dead.length > 1 ? 's' : ''} did not execute while other legs did. Residual exposure remains. Retry, unwind or accept the position as it stands.` });
      } else app.alerts.resolve({ refType: 'strategy', refId: strategyId, code: 'strategy.attention' });
      if (app.hedge) app.hedge.onStrategyChange(strategyId, s.status, status);
    }
    return status;
  }

  // =============================================================================================
  // Views
  // =============================================================================================

  function orderView(o) {
    const inst = o.instrument_id ? instruments.get(o.instrument_id) : null;
    const target = o.data.targetPositionId ? positions.get(o.data.targetPositionId) : null;
    const tinst = target ? instruments.get(target.instrument_id) : null;
    const fills = app.orders.fillsFor(o.id).map((f) => ({
      id: f.id, ts: f.ts, businessDate: f.business_date, qty: f.qty, price: f.price, gross: f.gross, ccy: f.ccy, fees: f.fees, model: f.fill_model, note: f.fill_note, settleDate: f.settle_date,
      priceObservation: f.price_obs_id ? app.data.getObservation(f.price_obs_id) : null, fxObservation: f.fx_obs_id ? app.data.getObservation(f.fx_obs_id) : null,
      // Reconciliation with the confirmed figures: { confirmed, actual, variance, exact, within, reason } or null.
      confirm: f.confirm || null,
    }));
    const pending = db.all(`SELECT * FROM settlements WHERE order_id = ? AND status <> 'settled' ORDER BY due_date`, o.id);
    return {
      id: o.id, strategyId: o.strategy_id, submission: o.submission, legNo: o.leg_no, kind: o.kind, kindLabel: KIND_LABEL[o.kind] || o.kind, action: o.action, role: o.role, purpose: o.data.purpose || 'primary',
      instrument: app.valuation.lite(inst || tinst), label: describeOrder(o, inst || tinst),
      qty: o.qty, filledQty: o.filled_qty, remainingQty: Math.max(0, round(o.qty - o.filled_qty, 8)), avgPrice: o.avg_price,
      orderType: o.order_type, limitPrice: o.limit_price, stopPrice: o.stop_price, tif: o.tif, statedPrice: o.data.statedPrice ?? null,
      status: o.status, statusReason: o.status_reason, dependsOn: o.depends_on, required: o.required, resolved: Boolean(o.data.resolved), intent: o.data.intent || null,
      resizedFrom: o.data.resizedFrom ?? null, estimate: o.data.estimate || null, confirmed: o.data.confirmed || null, settle: o.data.settle || null, fills,
      settlements: pending.map((p) => ({ id: p.id, dueDate: p.due_date, ccy: p.ccy, amount: p.amount, status: p.status, error: p.last_error })),
      reserved: ledger.listHolds([o.unit_id]).filter((h) => h.ref_type === 'order' && h.ref_id === o.id).map((h) => ({ ccy: h.ccy, amount: h.amount, kind: h.kind })),
      createdAt: o.created_at, updatedAt: o.updated_at, unitId: o.unit_id, bookId: o.book_id,
    };
  }

  function describeOrder(o, inst) {
    const what = inst ? (inst.symbol || inst.name) : '';
    const act = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover', borrow_sec: 'Borrow', return_sec: 'Return borrowed', borrow_cash: 'Borrow cash', lend_cash: 'Lend cash', repay_cash: 'Repay', repo: 'Repo', reverse_repo: 'Reverse repo', close_repo: 'Close repo', lend_sec: 'Lend', recall_sec: 'Take back lent', reserve_cash: 'Reserve exercise cash', use_existing: 'Use existing', treasury_funding: 'Treasury funding' }[o.action] || o.action;
    if (o.kind === 'reserve') return `${act}: ${fmt(o.data.reserve?.amount || 0, o.data.reserve?.ccy || 'USD')}`;
    if (o.kind === 'funding') return `${act}: ${fmt(o.data.funding?.amount || 0, o.data.funding?.ccy || 'USD')}`;
    if (['loan', 'repay', 'repo_open'].includes(o.kind)) return `${act} ${fmt(o.qty, inst?.trading_ccy || 'USD')}${inst ? ` (${inst.name})` : ''}`;
    return `${act} ${fmtQty(o.qty)} ${what}`.trim();
  }

  function strategyView(id) {
    const s = requireStrategy(id);
    const unit = books.getUnit(s.unit_id);
    const orders = app.orders.forStrategy(id).map(orderView);
    const pos = app.valuation.positionsOf([s.unit_id], { strategyId: id });
    const holds = ledger.listHolds([s.unit_id]).filter((h) => (h.ref_type === 'strategy' && h.ref_id === id) || (h.ref_type === 'position' && pos.some((p) => p.positionId === h.ref_id)));
    const tpl = getTemplate(s.template);
    const dead = orders.filter((o) => app.orders.DEAD.has(o.status) && o.required && !o.resolved && o.filledQty < o.qty - 1e-9);
    const active = orders.filter((o) => app.orders.ACTIVE.has(o.status));
    const actions = [];
    if (active.length) actions.push('cancel_working');
    if (s.status === 'attention') actions.push('retry', 'unwind', 'accept');
    if (['open', 'attention', 'partial'].includes(s.status) && pos.length) actions.push('close', 'resize', 'hedge', 'add_legs');
    if (pos.some((p) => ['option', 'future'].includes(p.family))) actions.push('roll');
    return {
      id: s.id, name: s.name, template: s.template, templateName: tpl?.name || s.template, status: s.status, bookId: s.book_id, unit: { id: unit.id, name: unit.name, kind: unit.kind },
      underlying: s.underlying_id ? app.valuation.lite(instruments.get(s.underlying_id)) : null, params: s.params, previewAtSubmit: s.preview, note: s.note,
      investmentStrategy: s.params.investmentStrategy || null, holdingPeriod: s.params.holdingPeriod || null, signalRef: s.signal_ref,
      createdAt: s.created_at, updatedAt: s.updated_at, closedAt: s.closed_at,
      orders, positions: pos,
      holds: holds.map((h) => ({ id: h.id, kind: h.kind, ccy: h.ccy, amount: h.amount, note: h.note })),
      residual: dead.map((o) => ({ legNo: o.legNo, label: o.label, status: o.status, reason: o.statusReason, filledQty: o.filledQty, qty: o.qty })),
      complete: !active.length && !dead.length && s.status !== 'failed',
      actions,
      hedge: app.hedge ? app.hedge.forStrategy(id) : null,
    };
  }

  function listStrategies({ bookId, unitIds, status, limit = 300 } = {}) {
    const where = ['book_id = ?'];
    const params = [bookId];
    if (unitIds?.length) { where.push(`unit_id IN (${unitIds.map(() => '?').join(',')})`); params.push(...unitIds); }
    if (status === 'active') where.push(`status IN ('working','partial','open','attention')`);
    else if (status) { where.push('status = ?'); params.push(status); }
    params.push(limit);
    return db.all(`SELECT * FROM strategies WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...params).map(parseStrategy).map((s) => {
      const unit = books.getUnit(s.unit_id);
      const orders = app.orders.forStrategy(s.id);
      const pos = positions.list({ unitIds: [s.unit_id], strategyId: s.id }).filter((p) => !isZero(p.qty));
      return {
        id: s.id, name: s.name, template: s.template, templateName: getTemplate(s.template)?.name || s.template, status: s.status, unit: { id: unit.id, name: unit.name, kind: unit.kind },
        underlying: s.underlying_id ? app.valuation.lite(instruments.get(s.underlying_id)) : null, createdAt: s.created_at, closedAt: s.closed_at,
        legs: orders.length, working: orders.filter((o) => app.orders.ACTIVE.has(o.status)).length, failedLegs: orders.filter((o) => app.orders.DEAD.has(o.status) && o.required && !o.data.resolved && o.filled_qty < o.qty - 1e-9).length,
        positions: pos.length, hedgeReview: Boolean(s.params.hedgeReview?.needed), investmentStrategy: s.params.investmentStrategy || null,
      };
    });
  }

  // =============================================================================================
  // Lifecycle actions on an existing strategy instance
  // =============================================================================================

  /** Legs that close (a fraction of) every open position of a strategy. */
  function closingLegs(strategyId, { fraction = 1, positionIds, qty } = {}) {
    const s = requireStrategy(strategyId);
    need(fraction > 0 && fraction <= 1, 'Fraction to close must be between 0 and 1.');
    const open = positions.list({ unitIds: [s.unit_id], strategyId }).filter((p) => !isZero(p.qty) && (!positionIds || positionIds.includes(p.id)));
    need(open.length, 'This strategy has no open positions to close.');
    // An exact quantity (a plain "sell 100" or "buy 100 to cover" from a ticket) applies to one position.
    const exact = num(qty);
    if (exact !== null) {
      need(open.length === 1, 'Choose one position to reduce by an exact quantity.');
      need(exact > 0, 'Enter the quantity to close.');
      need(exact <= Math.abs(open[0].qty) + 1e-9, `That position is ${fmtQty(Math.abs(open[0].qty))}; ${fmtQty(exact)} is more than it holds.`);
    }
    const trades = [], after = [];
    for (const p of open) {
      const inst = instruments.get(p.instrument_id);
      const plugin = app.products.get(inst.family);
      const step = plugin.qtyStep ? plugin.qtyStep(inst) : 1;
      let q = exact !== null ? exact : Math.abs(p.qty) * fraction;
      if (exact === null && fraction < 1 && step >= 1) q = Math.floor(q / step) * step;
      if (!(q > 0)) continue;
      const purpose = p.data.purpose || 'primary';
      if (inst.family === 'secloan') {
        after.push({ purpose: 'financing', role: `return_${p.id}`, kind: p.qty > 0 ? 'return_sec' : 'recall_sec', action: p.qty > 0 ? 'return_sec' : 'recall_sec', targetPositionId: p.id, qty: q, underlyingId: inst.underlying_id, note: p.qty > 0 ? 'Borrowed securities go back once the short is covered.' : 'Lent securities are taken back and the cash collateral is returned.' });
      } else if (inst.family === 'loan') {
        after.push({ purpose: 'financing', role: `repay_${p.id}`, kind: 'repay', action: 'repay_cash', targetPositionId: p.id, qty: q, required: false, note: 'Optional: needs settled cash. Sale proceeds may not have settled yet.' });
      } else if (inst.family === 'repo') {
        after.push({ purpose: 'financing', role: `repo_${p.id}`, kind: 'repo_close', action: 'close_repo', targetPositionId: p.id, qty: Math.abs(p.qty), required: false, note: 'Optional: repurchase needs settled cash for principal and interest.' });
      } else {
        const rule = plugin.shortRule || 'none';
        const action = p.qty > 0 ? 'sell' : rule === 'borrow' ? 'buy_to_cover' : 'buy';
        trades.push({ purpose, role: `close_${p.id}`, kind: 'trade', action, instrumentId: inst.id, qty: q, group: inst.family === 'option' ? 'options' : null });
      }
    }
    // A return of borrowed securities waits for the cover of the matching short.
    const legs = [...trades, ...after];
    const roleN = new Map(legs.map((l, i) => [l.role, i + 1]));
    for (const l of legs) {
      l.dependsOn = [];
      if (l.kind === 'return_sec') {
        const cover = trades.find((t) => t.action === 'buy_to_cover' && t.instrumentId === l.underlyingId);
        if (cover) l.dependsOn.push(roleN.get(cover.role));
      }
      delete l.underlyingId;
    }
    return legs;
  }

  /** Legs that scale a strategy up by `factor` (> 1), repeating each position in the same direction. */
  function growLegs(strategyId, factor) {
    const s = requireStrategy(strategyId);
    const extra = factor - 1;
    const open = positions.list({ unitIds: [s.unit_id], strategyId }).filter((p) => !isZero(p.qty));
    const legs = [];
    for (const p of open) {
      const inst = instruments.get(p.instrument_id);
      const plugin = app.products.get(inst.family);
      if (['secloan', 'loan', 'repo'].includes(inst.family)) continue;
      const step = plugin.qtyStep ? plugin.qtyStep(inst) : 1;
      let q = Math.abs(p.qty) * extra;
      if (step >= 1) q = Math.round(q / step) * step;
      if (!(q > 0)) continue;
      const purpose = p.data.purpose || 'primary';
      if (p.qty < 0 && (plugin.shortRule || 'none') === 'borrow') {
        legs.push({ purpose: 'financing', role: `borrow_${inst.id}`, kind: 'borrow_sec', action: 'borrow_sec', instrumentId: inst.id, qty: q });
        legs.push({ purpose, role: `add_${inst.id}`, kind: 'trade', action: 'sell_short', instrumentId: inst.id, qty: q, dependsOnRole: `borrow_${inst.id}` });
      } else legs.push({ purpose, role: `add_${inst.id}`, kind: 'trade', action: p.qty > 0 ? 'buy' : 'sell', instrumentId: inst.id, qty: q, group: inst.family === 'option' ? 'options' : null });
    }
    need(legs.length, 'The resize is too small to change any leg by a whole unit.');
    const roleN = new Map(legs.map((l, i) => [l.role, i + 1]));
    return legs.map((l) => { const { dependsOnRole, ...rest } = l; return { ...rest, dependsOn: dependsOnRole ? [roleN.get(dependsOnRole)] : [] }; });
  }

  /** Legs that roll option or futures positions to a new contract. */
  function rollLegs(strategyId, { positionIds, newExpiration, newStrike, newInstrumentId }, chains) {
    const s = requireStrategy(strategyId);
    const open = positions.list({ unitIds: [s.unit_id], strategyId }).filter((p) => !isZero(p.qty) && (positionIds?.length ? positionIds.includes(p.id) : true));
    const legs = [];
    for (const p of open) {
      const inst = instruments.get(p.instrument_id);
      const purpose = p.data.purpose || 'primary';
      if (inst.family === 'option') {
        need(newExpiration, 'Choose the expiration to roll to.');
        const strike = num(newStrike) ?? inst.terms.strike;
        const spec = { underlyingId: inst.underlying_id, expiration: newExpiration, strike, right: inst.terms.right };
        const reg = instruments.findOption({ ...spec, multiplier: inst.multiplier, deliverableUnits: inst.terms.deliverable.units });
        const hit = chains ? chainContract(chains, spec) : null;
        const meta = reg ? { multiplier: reg.multiplier, deliverableUnits: reg.terms.deliverable.units, exercise: reg.terms.exercise, settlement: reg.terms.settlement }
          : hit ? { multiplier: hit.c.multiplier, deliverableUnits: hit.c.deliverable?.shares ?? hit.c.multiplier, exercise: hit.c.exercise || inst.terms.exercise, settlement: hit.c.settlement || inst.terms.settlement }
            : { multiplier: inst.multiplier, deliverableUnits: inst.terms.deliverable.units, exercise: inst.terms.exercise, settlement: inst.terms.settlement };
        need(!(newExpiration === inst.terms.expiration && strike === inst.terms.strike), 'The roll target is the same contract.');
        legs.push({ purpose, role: `close_${p.id}`, kind: 'trade', action: p.qty > 0 ? 'sell' : 'buy', instrumentId: inst.id, qty: Math.abs(p.qty), group: 'options' });
        legs.push({ purpose, role: `open_${p.id}`, kind: 'trade', action: p.qty > 0 ? 'buy' : 'sell', qty: Math.abs(p.qty), option: { ...spec, ...meta }, group: 'options' });
      } else if (inst.family === 'future') {
        const target = instruments.get(newInstrumentId);
        need(target && target.family === 'future' && target.id !== inst.id, 'Choose the contract month to roll into.');
        legs.push({ purpose, role: `close_${p.id}`, kind: 'trade', action: p.qty > 0 ? 'sell' : 'buy', instrumentId: inst.id, qty: Math.abs(p.qty) });
        legs.push({ purpose, role: `open_${p.id}`, kind: 'trade', action: p.qty > 0 ? 'buy' : 'sell', instrumentId: target.id, qty: Math.abs(p.qty) });
      }
    }
    need(legs.length, 'Choose option or futures positions to roll.');
    return legs.map((l) => ({ ...l, dependsOn: [] }));
  }

  /** Preview a lifecycle action. The result is confirmed through submit() like any other package. */
  async function previewAction(strategyId, action, args = {}) {
    const s = requireStrategy(strategyId);
    const base = { bookId: s.book_id, unitId: s.unit_id, template: 'custom', attachTo: s.id, underlyingId: s.underlying_id, name: s.name, orderType: args.orderType, tif: args.tif, netLimit: args.netLimit };
    if (action === 'close' || action === 'unwind') {
      let legs = closingLegs(strategyId, { fraction: num(args.fraction) ?? 1, positionIds: args.positionIds, qty: args.qty });
      // Covering one chosen short (by an exact quantity, or with that position's own Close button) also returns that
      // much of its borrow. Without this the cover leaves the borrowed securities out, still accruing their fee.
      if (args.positionIds?.length) {
        const returns = [];
        legs.forEach((l, i) => {
          if (l.kind !== 'trade' || l.action !== 'buy_to_cover') return;
          const loan = positions.list({ unitIds: [s.unit_id], strategyId }).find((p) => p.qty > 0 && instruments.get(p.instrument_id).family === 'secloan' && instruments.get(p.instrument_id).underlying_id === l.instrumentId);
          if (loan && ![...legs, ...returns].some((x) => x.kind === 'return_sec' && x.targetPositionId === loan.id)) returns.push({ purpose: 'financing', role: `return_${loan.id}`, kind: 'return_sec', action: 'return_sec', targetPositionId: loan.id, qty: Math.min(l.qty, loan.qty), dependsOn: [i + 1], note: 'Borrowed securities go back once the short is covered.' });
        });
        legs = [...legs, ...returns];
      }
      // Order instructions from a ticket apply to the trade legs; the preview still lets each be edited.
      const o = args.order;
      if (o) legs = legs.map((l) => (l.kind === 'trade' ? { ...l, orderType: o.orderType || 'market', limitPrice: num(o.limitPrice), stopPrice: num(o.stopPrice), tif: o.tif || 'day', statedPrice: num(o.statedPrice), settle: o.settle || null } : l));
      return preview({ ...base, intent: action, reducing: true, legs });
    }
    if (action === 'resize') {
      const f = num(args.factor);
      need(f > 0 && f !== 1, 'Enter the new size as a multiple of the current size (0.5 halves it, 2 doubles it).');
      return preview({ ...base, intent: 'resize', reducing: f < 1, legs: f < 1 ? closingLegs(strategyId, { fraction: 1 - f }) : growLegs(strategyId, f) });
    }
    if (action === 'roll') {
      const und = s.underlying_id ? instruments.get(s.underlying_id) : null;
      const chains = und && args.newExpiration ? await loadChains(und, [args.newExpiration]) : new Map();
      return preview({ ...base, intent: 'roll', legs: rollLegs(strategyId, args, chains) });
    }
    if (action === 'retry') {
      const dead = app.orders.forStrategy(strategyId).filter((o) => app.orders.DEAD.has(o.status) && o.required && !o.data.resolved && o.filled_qty < o.qty - 1e-9);
      need(dead.length, 'There are no failed legs to retry.');
      const legs = dead.map((o) => retryLeg(o));
      return preview({ ...base, intent: 'retry', retryOf: dead.map((o) => o.id), legs });
    }
    throw new AppError(`Unknown action "${action}".`);
  }

  function retryLeg(o) {
    const leg = { purpose: o.data.purpose || 'primary', role: o.role, kind: o.kind, action: o.action, qty: round(o.qty - o.filled_qty, 8), orderType: o.order_type, limitPrice: o.limit_price, stopPrice: o.stop_price, tif: o.tif, group: o.data.group || null, dependsOn: [], hedgeLinkId: o.data.hedgeLinkId || undefined };
    if (o.kind === 'trade' || o.kind === 'borrow_sec' || o.kind === 'link') leg.instrumentId = o.instrument_id;
    if (o.kind === 'borrow_sec') leg.borrow = o.data.borrow || null;
    if (o.kind === 'reserve') leg.reserve = o.data.reserve;
    if (o.kind === 'funding') leg.funding = o.data.funding;
    if (o.kind === 'link') leg.sourcePositionId = o.data.sourcePositionId;
    if (ARR_CLOSE.has(o.kind)) leg.targetPositionId = o.data.targetPositionId;
    if (ARR_OPEN.has(o.kind)) leg.instrumentId = o.instrument_id;
    return leg;
  }

  /** Mark failed legs as dealt with after a retry, unwind or acceptance. */
  function resolveDeadLegs(strategyId, note) {
    const dead = app.orders.forStrategy(strategyId).filter((o) => app.orders.DEAD.has(o.status) && !o.data.resolved);
    for (const o of dead) db.run('UPDATE orders SET data = ? WHERE id = ?', j({ ...o.data, resolved: true, resolution: note }), o.id);
    return dead.length;
  }

  /** Actions that take effect immediately (they submit no new trades). */
  function applyAction(strategyId, action) {
    const s = requireStrategy(strategyId);
    if (action === 'cancel_working') {
      const act = app.orders.active(strategyId);
      need(act.length, 'There are no working legs to cancel.');
      db.tx(() => { for (const o of act) app.orders.setStatus(o, 'cancelled', 'Cancelled by user'); });
      refreshStrategy(strategyId);
      return strategyView(strategyId);
    }
    if (action === 'accept') {
      need(s.status === 'attention', 'Only a package with failed legs can be accepted as it stands.');
      db.tx(() => {
        const n = resolveDeadLegs(strategyId, 'accepted');
        ledger.post({ bookId: s.book_id, unitId: s.unit_id, type: 'strategy.accepted', strategyId, summary: `${s.name}: accepted as it stands with ${n} leg${n > 1 ? 's' : ''} unexecuted. The position no longer matches its template.`, data: { legs: n } });
        db.run('UPDATE strategies SET params = ?, note = ? WHERE id = ?', j({ ...s.params, modified: true }), 'Accepted with unexecuted legs: the position no longer matches its template.', strategyId);
      });
      refreshStrategy(strategyId);
      return strategyView(strategyId);
    }
    throw new AppError(`Unknown action "${action}".`);
  }

  /** Forced buy-in when a recalled borrow has not been returned by its deadline. */
  function forceBuyIn({ book, unit, loanPos, inst, qty }) {
    const und = instruments.get(inst.underlying_id);
    const short = positions.find(unit.id, und.id, loanPos.strategy_id);
    const shortQty = short && short.qty < 0 ? -short.qty : 0;
    const freeBorrow = Math.max(0, loanPos.qty - shortQty);
    const cover = Math.max(0, Math.min(qty - freeBorrow, shortQty));
    const submission = uuid();
    db.tx(() => {
      const baseLeg = db.get('SELECT COALESCE(MAX(leg_no), 0) AS m FROM orders WHERE strategy_id = ?', loanPos.strategy_id).m;
      ledger.post({ bookId: book.id, unitId: unit.id, type: 'secloan.buy_in', instrumentId: und.id, strategyId: loanPos.strategy_id, positionId: loanPos.id, actor: 'engine', summary: `Recall deadline reached: forced buy-in of ${fmtQty(cover)} ${und.symbol || und.name} and return of ${fmtQty(qty)} borrowed securities`, data: { qty, cover } });
      let n = baseLeg;
      const deps = [];
      if (cover > 0) {
        n += 1;
        app.orders.insert({ strategyId: loanPos.strategy_id, submission, legNo: n, bookId: book.id, unitId: unit.id, instrumentId: und.id, kind: 'trade', action: 'buy_to_cover', role: 'forced_buy_in', qty: cover, orderType: 'market', tif: 'gtc', data: { purpose: 'primary', intent: 'forced_buy_in' } });
        deps.push(n);
      }
      n += 1;
      app.orders.insert({ strategyId: loanPos.strategy_id, submission, legNo: n, bookId: book.id, unitId: unit.id, instrumentId: null, kind: 'return_sec', action: 'return_sec', role: 'recall_return', qty, tif: 'gtc', dependsOn: deps, data: { purpose: 'financing', targetPositionId: loanPos.id, intent: 'forced_buy_in' } });
    });
    refreshStrategy(loanPos.strategy_id);
    return { done: true };
  }

  return {
    templates: () => TEMPLATES,
    preview, submit, runMatching, previewAction, applyAction, resolveDeadLegs,
    getStrategyRow, requireStrategy, refreshStrategy, recomputeHolds, strategyView, listStrategies, orderView, closingLegs, forceBuyIn,
  };
}
