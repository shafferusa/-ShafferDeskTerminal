// Protection allocations: what protects what.
//
// A hedge counts as protection for a position only through an ACTIVE allocation:
//
//   explicit_link   the hedge legs were executed from that position's hedge request
//   template        the hedge leg came with the execution template that built the position (a collar's put)
//   service         Analytics Lab looked at the Account's positions and allocated part of a hedge to the position
//
// The Terminal derives the first two from identifiers it stored itself (strategy instance id, hedge
// request id). It never decides that some other hedge in the Account applies to a position: that
// is the service's call, returned as a protection assessment and validated here before it is
// stored. A hedge that nobody has assessed is reported as unassessed and is never counted.
//
// Capacity rule (so one hedge is never counted twice across positions):
//   bought listed or OTC option on an underlying   contracts x deliverable units, in units of the underlying;
//                                                  a put can cover long units, a call can cover short units
//   written option                                 no capacity: it is not protection
//   anything else (future, forward, swap, CDS...)  no unit measure in the Terminal. An explicit link is
//                                                  recorded without units and the whole hedge is treated as
//                                                  committed to that position; a service allocation must state
//                                                  the capacity it is working from, and the units it allocates.

import { j, pj } from '../db/db.js';
import { fmtQty } from '../products/common.js';
import { isZero, newId, num, round } from './util.js';

const ARRANGEMENT = new Set(['loan', 'repo', 'secloan']);
const EPS = 1e-9;

export const CAPACITY_RULES = {
  option: 'Bought options: contracts x deliverable units per contract, in units of the underlying. A put can cover long units, a call can cover short units. A written option is not protection.',
  none: 'Futures, forwards, swaps, credit and other contracts have no unit measure in the Terminal. An explicit link is recorded without units; an allocation from the service must state the hedge capacity it is working from.',
};

export function createProtection(app) {
  const { db, clock, positions, instruments, books } = app;
  const parse = (r) => r && { ...r, source: pj(r.source, null) };
  const purposeOf = (p) => p.data.purpose || 'primary';
  const nameOf = (inst) => inst?.symbol || inst?.name || 'instrument';
  const instOf = (p) => instruments.get(p.instrument_id);
  const isOption = (inst) => (inst.family === 'option' || inst.family === 'otcoption') && Boolean(inst.underlying_id) && ['P', 'C'].includes(inst.terms?.right);
  const expiryOf = (inst) => inst.terms?.expiration || inst.terms?.maturity || inst.terms?.valueDate || null;
  const sideOf = (p) => (p.qty > 0 ? 'long' : 'short');
  const openIn = (unitId) => positions.list({ unitIds: [unitId] }).filter((p) => !isZero(p.qty));

  /** A position that can be protected: a primary exposure, not a financing arrangement. */
  const isProtectable = (p, inst = instOf(p)) => purposeOf(p) === 'primary' && !ARRANGEMENT.has(inst.family) && inst.family !== 'fx';
  const exposureUnits = (p, inst = instOf(p)) => round(Math.abs(p.qty) * (inst.multiplier || 1), 8);

  /** Plain words for a position, used in every relationship line. */
  function describe(p, inst = instOf(p)) {
    const q = fmtQty(Math.abs(p.qty));
    const und = inst.underlying_id ? instruments.get(inst.underlying_id) : null;
    switch (inst.family) {
      case 'loan': return `${p.qty < 0 ? 'Cash borrowed' : 'Cash lent'}: ${q} ${inst.trading_ccy}`;
      case 'repo': return `${p.qty < 0 ? 'Repo' : 'Reverse repo'}: ${q} ${inst.trading_ccy}`;
      case 'secloan': return `${p.qty > 0 ? 'Securities borrow' : 'Securities lent'}: ${q} ${nameOf(und)}`;
      default: return `${p.qty > 0 ? 'Long' : 'Short'} ${q} ${nameOf(inst)}`;
    }
  }

  /** How much protection a hedge position can give, in units of what it protects. */
  function capacityOf(p, inst = instOf(p)) {
    if (isOption(inst)) {
      if (p.qty <= 0) return { rule: 'option', units: 0, protects: null, underlyingId: inst.underlying_id, note: 'A written option is not protection.' };
      const per = inst.terms.deliverable?.units ?? inst.multiplier ?? 1;
      return { rule: 'option', units: round(p.qty * per, 8), protects: inst.terms.right === 'P' ? 'long' : 'short', underlyingId: inst.underlying_id, note: `${fmtQty(p.qty)} contract${p.qty === 1 ? '' : 's'} x ${fmtQty(per)} units` };
    }
    return { rule: 'none', units: null, protects: null, underlyingId: inst.underlying_id || null, note: 'No unit measure in the Terminal for this kind of hedge.' };
  }

  const activeFor = (unitId) => db.all(`SELECT * FROM protection_allocations WHERE unit_id = ? AND status = 'active' ORDER BY created_at, id`, unitId).map(parse);
  const end = (a, status, reason, now) => db.run('UPDATE protection_allocations SET status = ?, reason = ?, updated_at = ?, ended_at = ? WHERE id = ?', status, reason, now, now, a.id);

  /** The position a hedge leg is explicitly tied to through identifiers the Terminal stored itself. */
  function primaryFor(h, hInst, open) {
    if (!h.strategy_id) return null;
    const cands = open.filter((p) => p.strategy_id === h.strategy_id && p.id !== h.id && isProtectable(p));
    if (!cands.length) return null;
    if (hInst.underlying_id) { const hit = cands.find((p) => p.instrument_id === hInst.underlying_id); if (hit) return hit; }
    if (isOption(hInst)) return null; // an option is tied only to a position in its own underlying
    const req = h.data.hedgeLinkId ? db.get('SELECT request FROM hedge_requests WHERE id = ?', h.data.hedgeLinkId) : null;
    const wanted = pj(req?.request, {})?.primary?.instrument?.terminalId || app.packages.getStrategyRow(h.strategy_id)?.underlying_id || null;
    const hit = wanted ? cands.find((p) => p.instrument_id === wanted) : null;
    return hit || (cands.length === 1 ? cands[0] : null);
  }

  /**
   * Bring the allocations of one Treasury/Account into line with its positions. Idempotent.
   *  - an allocation whose hedge expired, or whose hedge or protected position closed, is ended
   *  - explicit links and template protection get their allocation (and keep its units current)
   *  - a service allocation whose hedge changed size is released: it needs a new assessment
   */
  function sync(unitId) {
    const unit = books.getUnit(unitId);
    if (!unit) return;
    const open = openIn(unitId);
    if (!open.some((p) => purposeOf(p) === 'hedge') && !db.get(`SELECT 1 FROM protection_allocations WHERE unit_id = ? AND status = 'active' LIMIT 1`, unitId)) return;
    const today = clock.today(), now = clock.now().toISOString();
    const byId = new Map(open.map((p) => [p.id, p]));
    db.tx(() => {
      // 1. endings
      for (const a of activeFor(unitId)) {
        const h = byId.get(a.hedge_position_id), p = byId.get(a.protected_position_id);
        const stored = h || positions.get(a.hedge_position_id);
        const exp = stored ? expiryOf(instOf(stored)) : null;
        if (!h) end(a, exp && exp <= today ? 'expired' : 'released', exp && exp <= today ? `The hedge expired on ${exp}.` : 'The hedge position was closed.', now);
        else if (exp && exp < today) end(a, 'expired', `The hedge expired on ${exp}.`, now);
        else if (!p) end(a, 'released', 'The protected position was closed.', now);
        else if (a.basis === 'service' && Math.abs((a.hedge_qty ?? h.qty) - h.qty) > EPS) end(a, 'released', `The hedge position changed (${fmtQty(a.hedge_qty)} when assessed, ${fmtQty(h.qty)} now). It needs a new assessment.`, now);
      }
      db.run(`DELETE FROM protection_verdicts WHERE unit_id = ? AND (hedge_position_id NOT IN (SELECT id FROM positions WHERE ABS(qty) > 1e-9) OR protected_position_id NOT IN (SELECT id FROM positions WHERE ABS(qty) > 1e-9))`, unitId);
      // 2. explicit links and template protection
      const act = activeFor(unitId);
      for (const h of open) {
        if (purposeOf(h) !== 'hedge') continue;
        const hInst = instOf(h);
        const cap = capacityOf(h, hInst);
        const mine = act.filter((a) => a.hedge_position_id === h.id && a.basis !== 'service');
        const exp = expiryOf(hInst);
        const p = cap.units === 0 || (exp && exp < today) ? null : primaryFor(h, hInst, open);
        const fits = p && (!cap.protects || cap.protects === sideOf(p));
        for (const a of mine) if (!fits || a.protected_position_id !== p.id) end(a, 'released', !p ? 'The hedge is no longer tied to an open position.' : !fits ? 'The hedge does not protect exposure in this direction.' : 'The hedge is tied to a different position now.', now);
        if (!fits) continue;
        const others = act.filter((a) => a.hedge_position_id === h.id && a.protected_position_id !== p.id).reduce((s, a) => s + (a.units || 0), 0);
        const units = cap.units === null ? null : round(Math.max(0, Math.min(cap.units - others, exposureUnits(p))), 8);
        const basis = h.data.hedgeLinkId ? 'explicit_link' : 'template';
        const cur = mine.find((a) => a.protected_position_id === p.id);
        if (cur) {
          if (cur.units !== units || cur.capacity !== cap.units || cur.hedge_qty !== h.qty || cur.protected_qty !== p.qty) db.run('UPDATE protection_allocations SET units = ?, capacity = ?, hedge_qty = ?, protected_qty = ?, updated_at = ? WHERE id = ?', units, cap.units, h.qty, p.qty, now, cur.id);
        } else {
          db.run(
            `INSERT INTO protection_allocations (id, book_id, unit_id, hedge_position_id, protected_position_id, strategy_id, units, capacity, basis, source, request_id, status, note, hedge_qty, protected_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
            newId('PAL'), h.book_id, unitId, h.id, p.id, p.strategy_id || null, units, cap.units, basis, j({ kind: 'terminal', label: basis === 'explicit_link' ? 'Explicit link (executed from this position\'s hedge request)' : 'Execution template', version: null, receivedAt: now }),
            h.data.hedgeLinkId || null, cap.units === null ? 'Linked without a unit measure.' : null, h.qty, p.qty, now, now,
          );
        }
      }
    });
  }

  function syncBook(bookId) { for (const u of books.unitsOf(bookId)) sync(u.id); }
  function syncAll() {
    const ids = new Set(db.all(`SELECT DISTINCT unit_id FROM protection_allocations WHERE status = 'active'`).map((r) => r.unit_id));
    for (const r of db.all(`SELECT DISTINCT unit_id FROM positions WHERE ABS(qty) > 1e-9 AND json_extract(data, '$.purpose') = 'hedge'`)) ids.add(r.unit_id);
    for (const id of ids) sync(id);
  }

  /**
   * Store a protection assessment that came back with a hedge response. Every allocation is
   * validated; one that fails is stored as rejected with the reason, and changes nothing else.
   * assessment: { allocations: [{ hedgePositionId, protectedPositionId?, units, capacity?, note? }], unrelated: [{ hedgePositionId, protectedPositionId?, note? }] }
   */
  function applyAssessment({ requestId, bookId, unitId, scopeUnitIds, defaultProtectedId, assessment, source }) {
    const results = [];
    if (!assessment) return results;
    const now = clock.now().toISOString(), today = clock.today();
    const src = { kind: source.kind, label: source.label, version: source.version ?? null, receivedAt: source.receivedAt || now };
    const inScope = new Set(scopeUnitIds);
    db.tx(() => {
      for (const id of scopeUnitIds) sync(id);
      // A newer answer to the same request replaces what that request said before.
      for (const a of db.all(`SELECT * FROM protection_allocations WHERE request_id = ? AND basis = 'service' AND status = 'active'`, requestId)) end(a, 'released', 'Replaced by a newer assessment for the same request.', now);
      db.run(`DELETE FROM protection_allocations WHERE request_id = ? AND status = 'rejected'`, requestId);
      db.run('DELETE FROM protection_verdicts WHERE request_id = ?', requestId);

      const reject = (a, reason, h, p) => {
        db.run(
          `INSERT INTO protection_allocations (id, book_id, unit_id, hedge_position_id, protected_position_id, strategy_id, units, capacity, basis, source, request_id, status, reason, note, hedge_qty, protected_qty, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'service', ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?)`,
          newId('PAL'), bookId, p?.unit_id || h?.unit_id || unitId || '', String(a.hedgePositionId ?? ''), String(a.protectedPositionId ?? defaultProtectedId ?? ''), p?.strategy_id || null, num(a.units), num(a.capacity), j(src), requestId, reason, a.note || null, h?.qty ?? null, p?.qty ?? null, now, now, now,
        );
        results.push({ hedgePositionId: a.hedgePositionId ?? null, protectedPositionId: a.protectedPositionId ?? defaultProtectedId ?? null, units: num(a.units), status: 'rejected', reason });
      };
      /** Checks shared by allocations and "unrelated" verdicts: both positions must be real, open and inside the request's scope. */
      const locate = (a) => {
        const h = a.hedgePositionId ? positions.get(String(a.hedgePositionId)) : null;
        const pid = a.protectedPositionId || defaultProtectedId;
        const p = pid ? positions.get(String(pid)) : null;
        if (!h) return { h, p, problem: `It refers to hedge position ${a.hedgePositionId || '(none given)'}, which the Terminal does not hold.` };
        if (h.book_id !== bookId) return { h, p, problem: `It refers to a hedge position in another Book (${describe(h)}). Nothing is allocated across Books.` };
        if (!pid) return { h, p, problem: 'It does not say which position is protected, and the request has no single position.' };
        if (!p) return { h, p, problem: `It refers to protected position ${pid}, which the Terminal does not hold.` };
        if (p.book_id !== bookId) return { h, p, problem: `It refers to a protected position in another Book (${describe(p)}). Nothing is allocated across Books.` };
        if (!inScope.has(h.unit_id) || !inScope.has(p.unit_id)) return { h, p, problem: 'It refers to a position outside the Account this request was made for; that position was not part of the context sent.' };
        if (h.id === p.id) return { h, p, problem: 'A position cannot protect itself.' };
        const hInst = instOf(h), exp = expiryOf(hInst);
        if (isZero(h.qty)) return { h, p, problem: exp && exp <= today ? `The hedge ${nameOf(hInst)} expired on ${exp}.` : `The hedge position ${nameOf(hInst)} is closed.` };
        if (exp && exp < today) return { h, p, problem: `The hedge ${nameOf(hInst)} expired on ${exp}.` };
        if (ARRANGEMENT.has(hInst.family)) return { h, p, problem: `${describe(h)} is a financing arrangement, not a hedge.` };
        if (isZero(p.qty)) return { h, p, problem: `The protected position ${nameOf(instOf(p))} is closed.` };
        if (!isProtectable(p)) return { h, p, problem: `${describe(p)} is not a primary exposure.` };
        return { h, p, problem: null };
      };

      for (const a of assessment.allocations || []) {
        const { h, p, problem } = locate(a);
        if (problem) { reject(a, problem, h, p); continue; }
        const hInst = instOf(h);
        const units = num(a.units);
        if (!(units > 0)) { reject(a, 'It does not state a positive number of units allocated.', h, p); continue; }
        const cap = capacityOf(h, hInst);
        const act = db.all(`SELECT * FROM protection_allocations WHERE hedge_position_id = ? AND status = 'active'`, h.id).map(parse);
        let capacity = cap.units;
        if (cap.rule === 'option' && capacity === 0) { reject(a, `${describe(h)} is a written option. It has no protection capacity.`, h, p); continue; }
        if (cap.rule === 'none') {
          capacity = num(a.capacity);
          if (!(capacity > 0)) { reject(a, `${describe(h)} has no unit measure in the Terminal, and the allocation does not state the hedge capacity it is working from.`, h, p); continue; }
          const stated = act.find((x) => x.capacity !== null && Math.abs(x.capacity - capacity) > EPS);
          if (stated) { reject(a, `It states a capacity of ${fmtQty(capacity)} units for ${describe(h)}, but an active allocation of the same hedge states ${fmtQty(stated.capacity)}.`, h, p); continue; }
          const unmeasured = act.find((x) => x.units === null);
          if (unmeasured) { reject(a, `${describe(h)} is explicitly linked to ${describe(positions.get(unmeasured.protected_position_id))} without a unit measure, so no capacity can be shown to be left.`, h, p); continue; }
        }
        const same = act.filter((x) => x.protected_position_id === p.id);
        const linked = same.find((x) => x.basis !== 'service');
        if (linked) { reject(a, `${describe(h)} is already linked to ${describe(p)}${linked.units !== null ? ` for ${fmtQty(linked.units)} units` : ''}. An explicit link is not replaced by a service allocation.`, h, p); continue; }
        const used = act.filter((x) => x.protected_position_id !== p.id).reduce((s, x) => s + (x.units || 0), 0);
        if (used + units > capacity + EPS) {
          const where = act.filter((x) => x.protected_position_id !== p.id && x.units).map((x) => `${fmtQty(x.units)} to ${describe(positions.get(x.protected_position_id))}`).join(', ');
          reject(a, `It would allocate ${fmtQty(units)} units of ${describe(h)}, but only ${fmtQty(Math.max(0, capacity - used))} of its ${fmtQty(capacity)} units of capacity are left${where ? ` (${where})` : ''}. Capacity is never counted twice.`, h, p);
          continue;
        }
        for (const x of same) end(x, 'released', 'Replaced by a newer assessment.', now);
        db.run('DELETE FROM protection_verdicts WHERE hedge_position_id = ? AND protected_position_id = ?', h.id, p.id);
        const id = newId('PAL');
        db.run(
          `INSERT INTO protection_allocations (id, book_id, unit_id, hedge_position_id, protected_position_id, strategy_id, units, capacity, basis, source, request_id, status, note, hedge_qty, protected_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'service', ?, ?, 'active', ?, ?, ?, ?, ?)`,
          id, bookId, p.unit_id, h.id, p.id, p.strategy_id || null, units, capacity, j(src), requestId, a.note || null, h.qty, p.qty, now, now,
        );
        results.push({ id, hedgePositionId: h.id, protectedPositionId: p.id, units, status: 'active', reason: null });
      }
      for (const u of assessment.unrelated || []) {
        const { h, p, problem } = locate(u);
        if (problem) { results.push({ hedgePositionId: u.hedgePositionId ?? null, protectedPositionId: u.protectedPositionId ?? defaultProtectedId ?? null, units: null, status: 'rejected', verdict: 'unrelated', reason: problem }); continue; }
        if (db.get(`SELECT 1 FROM protection_allocations WHERE hedge_position_id = ? AND protected_position_id = ? AND status = 'active' AND basis <> 'service'`, h.id, p.id)) {
          results.push({ hedgePositionId: h.id, protectedPositionId: p.id, units: null, status: 'rejected', verdict: 'unrelated', reason: `${describe(h)} is explicitly linked to ${describe(p)}. The link stays until the hedge or the position is closed.` });
          continue;
        }
        for (const x of db.all(`SELECT * FROM protection_allocations WHERE hedge_position_id = ? AND protected_position_id = ? AND status = 'active' AND basis = 'service'`, h.id, p.id)) end(x, 'released', 'A newer assessment judged this hedge unrelated to the position.', now);
        db.run('DELETE FROM protection_verdicts WHERE hedge_position_id = ? AND protected_position_id = ?', h.id, p.id);
        db.run(`INSERT INTO protection_verdicts (book_id, unit_id, hedge_position_id, protected_position_id, verdict, note, source, request_id, hedge_qty, created_at) VALUES (?, ?, ?, ?, 'unrelated', ?, ?, ?, ?, ?)`, bookId, p.unit_id, h.id, p.id, u.note || null, j(src), requestId, h.qty, now);
        results.push({ hedgePositionId: h.id, protectedPositionId: p.id, units: null, status: 'unrelated', verdict: 'unrelated', reason: null });
      }
    });
    return results;
  }

  /**
   * The protection picture of one Treasury/Account, by position.
   * Returns { hedges: [hedgeView], byPosition: Map<positionId, { protection, hedge }> }.
   */
  function forUnit(unitId) {
    sync(unitId);
    const open = openIn(unitId);
    const byId = new Map(open.map((p) => [p.id, p]));
    const act = activeFor(unitId).filter((a) => byId.has(a.hedge_position_id) && byId.has(a.protected_position_id));
    const verdicts = db.all('SELECT * FROM protection_verdicts WHERE unit_id = ?', unitId).map(parse);
    const rejected = db.all(`SELECT * FROM protection_allocations WHERE unit_id = ? AND status = 'rejected' ORDER BY created_at DESC LIMIT 50`, unitId).map(parse);
    const allocView = (a) => {
      const h = byId.get(a.hedge_position_id), p = byId.get(a.protected_position_id);
      return {
        id: a.id, hedgePositionId: h.id, hedge: describe(h), hedgeStrategyId: h.strategy_id || null, protectedPositionId: p.id, protected: describe(p), strategyInstanceId: p.strategy_id || null,
        units: a.units, capacity: a.capacity, basis: a.basis, requestId: a.request_id, source: a.source, note: a.note, since: a.created_at,
        // The position changed after the service allocated: the allocation stands, capped at the exposure, and says so.
        stale: a.basis === 'service' && a.protected_qty !== null && Math.abs(a.protected_qty - p.qty) > EPS,
      };
    };
    const isHedge = (p) => purposeOf(p) === 'hedge' || act.some((a) => a.hedge_position_id === p.id);
    const hedgeView = (h) => {
      const inst = instOf(h), cap = capacityOf(h, inst);
      const mine = act.filter((a) => a.hedge_position_id === h.id);
      const capacity = cap.units ?? mine.find((a) => a.capacity !== null)?.capacity ?? null;
      const allocated = mine.reduce((s, a) => s + (a.units || 0), 0);
      const committed = mine.some((a) => a.units === null); // linked without a unit measure: nothing can be shown to be left
      return {
        positionId: h.id, label: describe(h), instrument: { id: inst.id, symbol: inst.symbol, name: inst.name, family: inst.family }, quantity: h.qty, strategyInstanceId: h.strategy_id || null,
        purpose: purposeOf(h), hedgeRequestId: h.data.hedgeLinkId || null, expiry: expiryOf(inst),
        capacity: { rule: cap.rule, units: capacity, stated: cap.units === null && capacity !== null, note: cap.units === null ? CAPACITY_RULES.none : cap.note, protects: cap.protects },
        allocatedUnits: round(allocated, 8), capacityLeft: committed ? 0 : capacity === null ? null : round(Math.max(0, capacity - allocated), 8),
        allocations: mine.map(allocView),
      };
    };
    const hedges = open.filter(isHedge).map(hedgeView);
    const byPosition = new Map();
    for (const p of open) {
      const inst = instOf(p);
      const hv = hedges.find((h) => h.positionId === p.id) || null;
      let protection = null;
      if (isProtectable(p, inst) && !hv) {
        const mine = act.filter((a) => a.protected_position_id === p.id).map(allocView);
        const exposure = exposureUnits(p, inst);
        const measured = mine.reduce((s, a) => s + (a.units || 0), 0);
        const protectedUnits = round(Math.min(exposure, measured), 8);
        const elsewhere = [], unrelated = [], unassessed = [];
        for (const h of hedges) {
          if (mine.some((a) => a.hedgePositionId === h.positionId)) continue;
          if (h.capacity.rule === 'option' && h.capacity.units === 0) continue; // a written option is not protection for anything
          const v = verdicts.find((x) => x.hedge_position_id === h.positionId && x.protected_position_id === p.id);
          if (v) unrelated.push({ hedgePositionId: h.positionId, hedge: h.label, note: v.note, source: v.source, at: v.created_at, requestId: v.request_id });
          else if (h.allocations.length) elsewhere.push({ hedgePositionId: h.positionId, hedge: h.label, capacity: h.capacity.units, allocatedUnits: h.allocatedUnits, capacityLeft: h.capacityLeft, allocatedTo: h.allocations.map((a) => ({ positionId: a.protectedPositionId, label: a.protected, units: a.units, basis: a.basis })) });
          else unassessed.push({ hedgePositionId: h.positionId, hedge: h.label, capacity: h.capacity.units, hedgeRequestId: h.hedgeRequestId });
        }
        protection = {
          side: sideOf(p), exposureUnits: exposure,
          linked: mine.filter((a) => a.basis !== 'service'), shared: mine.filter((a) => a.basis === 'service'),
          elsewhere, unrelated, unassessed,
          rejected: rejected.filter((r) => r.protected_position_id === p.id).map((r) => ({ id: r.id, hedgePositionId: r.hedge_position_id, hedge: byId.has(r.hedge_position_id) ? describe(byId.get(r.hedge_position_id)) : r.hedge_position_id, units: r.units, reason: r.reason, source: r.source, at: r.created_at, requestId: r.request_id })),
          protectedUnits, remainingUnits: round(exposure - protectedUnits, 8),
          // Linked hedges with no unit measure are named, not counted.
          unmeasured: mine.filter((a) => a.units === null).map((a) => a.hedge),
          assessment: unassessed.length ? 'unavailable' : mine.length || elsewhere.length || unrelated.length ? 'assessed' : 'none',
          assessmentText: unassessed.length ? 'Protection assessment unavailable.' : null,
        };
      }
      byPosition.set(p.id, { protection, hedge: hv });
    }
    return { hedges, byPosition };
  }

  /** Units of a position already covered by active allocations (for the preview's duplicate-protection check). */
  function coverOf(positionId) {
    const p = positions.get(positionId);
    if (!p || isZero(p.qty)) return { exposureUnits: 0, protectedUnits: 0, items: [] };
    sync(p.unit_id);
    const items = db.all(`SELECT * FROM protection_allocations WHERE protected_position_id = ? AND status = 'active'`, positionId).map(parse).map((a) => {
      const h = positions.get(a.hedge_position_id);
      const hInst = h ? instOf(h) : null;
      return { allocationId: a.id, hedgePositionId: a.hedge_position_id, units: a.units, basis: a.basis, kind: hInst && isOption(hInst) ? (hInst.terms.right === 'P' ? 'put' : 'call') : 'other', underlyingId: hInst?.underlying_id || null, label: h ? describe(h) : a.hedge_position_id, source: a.source };
    });
    return { exposureUnits: exposureUnits(p), protectedUnits: items.reduce((s, x) => s + (x.units || 0), 0), items };
  }

  /**
   * Relationship lines for every open position of a unit, built only from stored identifiers:
   * the strategy instance id, the hedge request id on a hedge leg, the legs a financing leg funds.
   */
  function relations(unitId) {
    const { byPosition } = forUnit(unitId);
    const open = openIn(unitId);
    const out = new Map(open.map((p) => [p.id, []]));
    const push = (id, rel) => { if (out.has(id)) out.get(id).push(rel); };
    const ordersOf = new Map();
    const orders = (sid) => { if (!ordersOf.has(sid)) ordersOf.set(sid, app.orders.forStrategy(sid)); return ordersOf.get(sid); };
    for (const p of open) {
      const inst = instOf(p);
      const financing = purposeOf(p) === 'financing' || ARRANGEMENT.has(inst.family);
      if (financing && p.strategy_id) {
        let funded = [];
        if (inst.family === 'secloan' && p.qty > 0) funded = open.filter((x) => x.strategy_id === p.strategy_id && x.instrument_id === inst.underlying_id && x.qty < 0);
        if (!funded.length) {
          const legs = new Set(orders(p.strategy_id).filter((o) => o.instrument_id === p.instrument_id).flatMap((o) => o.data.fundsLegs || []));
          const targets = orders(p.strategy_id).filter((o) => legs.has(o.leg_no) && o.instrument_id);
          funded = open.filter((x) => x.strategy_id === p.strategy_id && x.id !== p.id && targets.some((o) => o.instrument_id === x.instrument_id));
        }
        if (!funded.length && purposeOf(p) === 'financing') funded = open.filter((x) => x.strategy_id === p.strategy_id && isProtectable(x));
        for (const f of funded) {
          push(p.id, { kind: 'finances', text: `${inst.family === 'secloan' ? 'Securities borrow for' : 'Financing for'} ${describe(f)}`, positionId: f.id, strategyInstanceId: p.strategy_id });
          push(f.id, { kind: 'financed_by', text: `${inst.family === 'secloan' ? 'Borrow' : 'Financed by'} ${describe(p).replace(/^Securities borrow: /, 'of ').replace(/^Cash borrowed: /, 'cash borrowing of ')}, borrowing ${p.id}`, positionId: p.id, strategyInstanceId: p.strategy_id });
        }
      }
      const v = byPosition.get(p.id);
      if (v?.hedge) {
        const h = v.hedge;
        for (const a of h.allocations) {
          const what = a.basis === 'explicit_link' ? `Hedge leg of request ${a.requestId || h.hedgeRequestId}` : a.basis === 'template' ? 'Protection from the execution template' : `Shared protection identified by ${a.source?.label || 'the service'}`;
          push(p.id, { kind: 'hedges', text: `${what}, protects ${a.protected}${a.units !== null ? ` (${fmtQty(a.units)} units)` : ''}`, positionId: a.protectedPositionId, requestId: a.requestId || null, strategyInstanceId: a.strategyInstanceId });
          push(a.protectedPositionId, { kind: 'hedged_by', text: `Protected by ${a.hedge}${a.units !== null ? ` (${fmtQty(a.units)} units)` : ', no unit measure'}`, positionId: p.id, requestId: a.requestId || null, strategyInstanceId: h.strategyInstanceId });
        }
        if (!h.allocations.length && h.purpose === 'hedge') {
          const written = h.capacity.rule === 'option' && h.capacity.units === 0;
          push(p.id, { kind: 'hedge_unallocated', text: `${h.hedgeRequestId ? `Hedge leg of request ${h.hedgeRequestId}` : 'Hedge leg'}${written ? ', a written option: not counted as protection' : ', not allocated to a position'}`, requestId: h.hedgeRequestId, strategyInstanceId: h.strategyInstanceId });
        }
      }
    }
    return out;
  }

  return { CAPACITY_RULES, sync, syncBook, syncAll, applyAssessment, forUnit, coverOf, relations, capacityOf, describe, isProtectable, exposureUnits, purposeOf };
}
