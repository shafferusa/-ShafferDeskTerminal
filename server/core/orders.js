// Orders and simulated execution.
//
// One confirmation submits a package, but every leg is its own order with its own status. Legs
// are not assumed to execute together:
//
//   pending    accepted; waiting on another leg (its dependency) or on its turn
//   working    eligible to execute; waiting for an executable price, a limit, a stop or the session
//   partial    partly filled; the remainder keeps working
//   filled     complete
//   rejected   failed a check at execution time (borrow unavailable, insufficient cash or collateral…)
//   cancelled  cancelled by the user or by a recovery action
//   expired    a day order that did not fill
//
// A leg whose dependency fails is rejected with the reason. A leg whose dependency only partly
// fills is scaled to match, so protection follows the exposure actually executed and is never
// larger than what was confirmed.

import { j, pj } from '../db/db.js';
import { fmt } from './books.js';
import { computeFees, estimateFill, FILL_MODEL_LABEL } from './fillmodel.js';
import { optionRequirement } from './payoff.js';
import { AppError, isZero, money, newId, qty8, round } from './util.js';
import { fmtQty } from '../products/common.js';

const ACTIVE = new Set(['pending', 'working', 'partial']);
const DEAD = new Set(['rejected', 'cancelled', 'expired']);
const BUY = new Set(['buy', 'buy_to_cover']);

export function createOrders(app) {
  const { db, clock, ledger, positions } = app;
  const parse = (o) => o && { ...o, depends_on: pj(o.depends_on, []), data: pj(o.data, {}), required: Boolean(o.required) };
  let filledThisCycle = new Set();

  function insert(o) {
    const id = newId('ORD');
    const now = clock.now().toISOString();
    db.run(
      `INSERT INTO orders (id, strategy_id, submission, leg_no, book_id, unit_id, instrument_id, kind, action, role, qty, order_type, limit_price, stop_price, tif, status, depends_on, required, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id, o.strategyId, o.submission, o.legNo, o.bookId, o.unitId, o.instrumentId || null, o.kind, o.action, o.role || null, o.qty, o.orderType || 'market',
      o.limitPrice ?? null, o.stopPrice ?? null, o.tif || 'day', j(o.dependsOn || []), o.required === false ? 0 : 1, j(o.data || {}), now, now,
    );
    return get(id);
  }
  const get = (id) => parse(db.get('SELECT * FROM orders WHERE id = ?', id));
  const forStrategy = (strategyId) => db.all('SELECT * FROM orders WHERE strategy_id = ? ORDER BY created_at, leg_no', strategyId).map(parse);
  const fillsFor = (orderId) => db.all('SELECT * FROM fills WHERE order_id = ? ORDER BY ts', orderId).map((f) => ({ ...f, fees: pj(f.fees, []) }));
  const active = (strategyId) => (strategyId
    ? db.all(`SELECT * FROM orders WHERE strategy_id = ? AND status IN ('pending','working','partial') ORDER BY created_at, leg_no`, strategyId)
    : db.all(`SELECT * FROM orders WHERE status IN ('pending','working','partial') ORDER BY created_at, leg_no`)).map(parse);

  function setStatus(o, status, reason) {
    if (o.status === status && (o.status_reason || null) === (reason || null)) return o;
    db.run('UPDATE orders SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', status, reason || null, clock.now().toISOString(), o.id);
    const dead = DEAD.has(status) && !DEAD.has(o.status);
    if (dead) {
      ledger.post({
        bookId: o.book_id, unitId: o.unit_id, type: `order.${status}`, instrumentId: o.instrument_id, strategyId: o.strategy_id, orderId: o.id, actor: status === 'cancelled' ? 'user' : 'engine',
        summary: `Leg ${o.leg_no} ${status}: ${describe(o)}${reason ? `. ${reason}` : ''}${o.filled_qty > 0 ? ` (${fmtQty(o.filled_qty)} of ${fmtQty(o.qty)} had filled and remains in place)` : ''}`,
        data: { status, reason: reason || null, filledQty: o.filled_qty, qty: o.qty },
      });
      ledger.releaseHolds({ refType: 'order', refId: o.id });
    }
    return get(o.id);
  }

  function describe(o) {
    const inst = o.instrument_id ? app.instruments.get(o.instrument_id) : null;
    const what = inst ? (inst.symbol || inst.name) : o.kind;
    return `${String(o.action).replace(/_/g, ' ')} ${fmtQty(o.qty)} ${what}`;
  }

  function cancel(id, { reason = 'Cancelled by user' } = {}) {
    const o = get(id);
    if (!o) throw new AppError('Order not found.', { status: 404 });
    if (!ACTIVE.has(o.status)) throw new AppError(`This leg is already ${o.status} and cannot be cancelled.`, { status: 409 });
    const r = db.tx(() => setStatus(o, 'cancelled', reason));
    app.packages.refreshStrategy(o.strategy_id);
    return r;
  }

  /** Day orders that did not complete expire at the end of the business day. */
  function expireDayOrders(date) {
    const rows = db.all(`SELECT * FROM orders WHERE status IN ('pending','working','partial') AND tif = 'day' AND substr(created_at, 1, 10) <= ?`, date).map(parse);
    const touched = new Set();
    for (const o of rows) {
      db.tx(() => setStatus(o, 'expired', 'Day order did not fill before the end of the business day'));
      touched.add(o.strategy_id);
    }
    for (const s of touched) app.packages.refreshStrategy(s);
    return rows.length;
  }

  // ---- dependencies ------------------------------------------------------------------------
  function dependencyState(o) {
    if (!o.depends_on.length) return { ratio: 1, anyActive: false };
    const deps = db.all(`SELECT * FROM orders WHERE submission = ? AND leg_no IN (${o.depends_on.map(() => '?').join(',')})`, o.submission, ...o.depends_on).map(parse);
    let ratio = 1, anyActive = false;
    for (const d of deps) {
      const dead = DEAD.has(d.status);
      if (dead && d.filled_qty <= 0) return { fail: `Leg ${d.leg_no} (${String(d.role || d.kind).replace(/_/g, ' ')}) did not execute${d.status_reason ? `: ${d.status_reason}` : ''}` };
      ratio = Math.min(ratio, d.qty > 0 ? d.filled_qty / d.qty : 1);
      if (!dead && d.status !== 'filled') anyActive = true;
    }
    return { ratio, anyActive, waitingOn: deps.filter((d) => ACTIVE.has(d.status)).map((d) => d.leg_no) };
  }

  const floorStep = (x, step) => qty8(Math.floor(x / step + 1e-9) * step);

  // ---- recording a fill --------------------------------------------------------------------
  function recordFill(o, { qty, price, gross, ccy, fees = [], model, note, obs, settleDate, eventId }) {
    const id = newId('FIL');
    const priceObsId = obs ? app.data.recordUsed(obs) : null;
    let fxObsId = null;
    if (ccy) {
      const fx = app.data.fx(ccy, ledger.rcOf(o.book_id));
      fxObsId = fx?.obs ? app.data.recordUsed(fx.obs) : null;
    }
    db.run(
      `INSERT INTO fills (id, order_id, ts, business_date, qty, price, gross, ccy, fees, fill_model, fill_note, price_obs_id, fx_obs_id, settle_date, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, o.id, clock.now().toISOString(), clock.today(), qty, price ?? null, gross ?? null, ccy || null, j(fees), model, note || null, priceObsId, fxObsId, settleDate || null, eventId || null,
    );
    const filled = qty8(o.filled_qty + qty);
    const avg = price !== null && price !== undefined ? ((o.avg_price || 0) * o.filled_qty + price * qty) / filled : o.avg_price;
    const status = filled >= o.qty - 1e-9 ? 'filled' : 'partial';
    db.run('UPDATE orders SET filled_qty = ?, avg_price = ?, status = ?, status_reason = ?, updated_at = ? WHERE id = ?', filled, avg ?? null, status,
      status === 'partial' ? `${fmtQty(filled)} of ${fmtQty(o.qty)} filled; the remainder is working` : null, clock.now().toISOString(), o.id);
    if (status === 'filled') ledger.releaseHolds({ refType: 'order', refId: o.id });
    return id;
  }

  // ---- one order -----------------------------------------------------------------------------
  /** Try to move one order forward. Returns true if anything changed. */
  function tryOrder(o0) {
    let o = o0;
    if (!ACTIVE.has(o.status)) return false;
    const dep = dependencyState(o);
    if (dep.fail) { setStatus(o, 'rejected', `Dependency failed. ${dep.fail}`); return true; }
    const book = app.books.getBook(o.book_id);
    const unit = app.books.getUnit(o.unit_id);
    const inst = o.instrument_id ? app.instruments.get(o.instrument_id) : null;
    const plugin = inst ? app.products.get(inst.family) : null;
    const step = o.kind === 'trade' && plugin?.qtyStep ? plugin.qtyStep(inst) : 1e-8;

    let target = o.qty;
    if (dep.ratio < 1 - 1e-12) {
      const allowed = floorStep(o.qty * dep.ratio, step);
      if (!dep.anyActive) {
        // The leg this one depends on ended short of its quantity: scale this leg down to match.
        if (allowed <= o.filled_qty + 1e-9) {
          if (o.filled_qty > 0) {
            db.run('UPDATE orders SET qty = ?, status = ?, status_reason = ?, updated_at = ? WHERE id = ?', o.filled_qty, 'filled', 'Reduced to match the quantity its dependency actually filled', clock.now().toISOString(), o.id);
          } else setStatus(o, 'rejected', 'Dependency filled nothing, so this leg has nothing to execute against');
          return true;
        }
        db.run('UPDATE orders SET qty = ?, data = ?, updated_at = ? WHERE id = ?', allowed, j({ ...o.data, resizedFrom: o.data.resizedFrom ?? o.qty }), clock.now().toISOString(), o.id);
        o = get(o.id);
        target = allowed;
      } else {
        target = allowed;
        if (target <= o.filled_qty + 1e-9) {
          const reason = `Waiting on leg ${dep.waitingOn.join(', ')}`;
          if (o.status_reason !== reason) { setStatus(o, o.filled_qty > 0 ? 'partial' : 'pending', reason); return true; }
          return false;
        }
      }
    }
    const remaining = qty8(target - o.filled_qty);
    if (remaining <= 1e-9) return false;
    const c = { o, book, unit, inst, plugin, remaining };
    switch (o.kind) {
      case 'trade': return tryTrade(c);
      case 'borrow_sec': return tryBorrow(c);
      case 'loan': case 'repo_open': case 'lend_sec': return tryOpenArrangement(c);
      case 'repay': case 'repo_close': case 'return_sec': case 'recall_sec': return tryCloseArrangement(c);
      case 'reserve': return tryReserve(c);
      case 'link': return tryLink(c);
      case 'funding': return tryFunding(c);
      default: setStatus(o, 'rejected', `Unknown leg kind ${o.kind}`); return true;
    }
  }

  const wait = (o, reason) => {
    const status = o.filled_qty > 0 ? 'partial' : 'working';
    if (o.status === status && o.status_reason === reason) return false;
    setStatus(o, status, reason);
    return true;
  };
  const reject = (o, reason) => { setStatus(o, 'rejected', reason); return true; };

  function tryTrade({ o, book, unit, inst, plugin, remaining }) {
    if (filledThisCycle.has(o.id)) return false;
    const today = clock.today();
    const obs = app.data.price(inst.id);
    const stopTriggered = Boolean(o.data.stopTriggered);
    const est = estimateFill(app, { inst, action: o.action, obs, book, statedPrice: o.data.statedPrice ?? null, limitPrice: o.limit_price, stopPrice: o.stop_price, orderType: o.order_type, stopTriggered });
    if (est.stopHit && !stopTriggered) db.run('UPDATE orders SET data = ? WHERE id = ?', j({ ...o.data, stopTriggered: true }), o.id);
    if (!est.executable) return wait(o, est.reason);
    let qty = remaining;
    if (est.maxQty !== null && est.maxQty < qty) qty = Math.max(0, Math.floor(est.maxQty / (plugin.qtyStep(inst) || 1)) * (plugin.qtyStep(inst) || 1));
    if (qty <= 0) return wait(o, 'No size is displayed at the executable price right now.');
    const price = est.price;
    const ccy = inst.trading_ccy;
    const buy = BUY.has(o.action);
    const pos = positions.find(unit.id, inst.id, o.strategy_id);
    const held = pos?.qty || 0;
    const rule = plugin.shortRule || 'none';

    // ---- position checks ------------------------------------------------------------------
    if (o.action === 'sell' && rule !== 'write' && rule !== 'cash') {
      const free = pos ? positions.freeQty(pos) : 0;
      if (held < qty - 1e-9) return reject(o, `This strategy holds ${fmtQty(Math.max(held, 0))} ${inst.symbol || inst.name}; cannot sell ${fmtQty(qty)}. Use a short sale with a securities borrow to go short.`);
      if (free < qty - 1e-9) return reject(o, `Only ${fmtQty(free)} is unencumbered; the rest is pledged or out on loan.`);
    }
    if (o.action === 'buy_to_cover' && held > -qty + 1e-9) return reject(o, `This strategy is short ${fmtQty(Math.max(-held, 0))} ${inst.symbol || inst.name}; cannot buy ${fmtQty(qty)} to cover.`);
    if (o.action === 'sell_short') {
      const borrowed = borrowedQty(unit.id, inst.id, o.strategy_id);
      const shortNow = Math.max(0, -held);
      if (borrowed - shortNow < qty - 1e-9) return reject(o, `No securities borrow covers this short sale (${fmtQty(Math.max(0, borrowed - shortNow))} borrowed and unused; ${fmtQty(qty)} needed).`);
      if (held > 1e-9) return reject(o, 'This strategy still holds a long position in the same security. Sell it before selling short.');
    }

    // ---- cash, margin and collateral checks -------------------------------------------------
    const settleDate = plugin.settleDate(app, inst, today, book);
    const fees = computeFees(book, inst, qty, price);
    const feeTotal = fees.reduce((a, f) => a + f.amount, 0);
    const econ = plugin.economics(app, { inst, action: o.action, qty, price, unit, strategyId: o.strategy_id, tradeDate: today, settleDate, book });
    const cashNow = ledger.cash(unit.id, ccy);
    if (inst.family === 'future') {
      const need = Math.max(econ.initialMargin || 0, 0) + feeTotal;
      if (need > 0 && cashNow.availableToWithdraw < need - 0.004) return reject(o, `Insufficient settled ${ccy} cash for initial margin and fees: ${fmt(need, ccy)} needed, ${fmt(cashNow.availableToWithdraw, ccy)} available.`);
    } else if (inst.family === 'fx') {
      const payCcy = buy ? inst.terms.quote : inst.terms.base;
      const payAmt = buy ? qty * price + feeTotal : qty;
      const have = ledger.cash(unit.id, payCcy).availableToTrade;
      if (have < payAmt - 0.004) return reject(o, `Insufficient ${payCcy}: ${fmt(payAmt, payCcy)} needed for the conversion, ${fmt(have, payCcy)} available.`);
    } else if (econ.cash < 0 || (buy && feeTotal > 0) || econ.initialMargin > 0) {
      const need = Math.max(0, -econ.cash) + feeTotal + Math.max(0, econ.initialMargin || 0);
      let have = settleDate <= today ? cashNow.availableToWithdraw : cashNow.availableToTrade;
      if (o.action === 'buy_to_cover' && pos) have += ledger.positionBalance(pos.id, 'cash.restricted', ccy) + pendingRestricted(pos.id, ccy);
      if (have < need - 0.004) return reject(o, `Insufficient ${ccy} cash: ${fmt(need, ccy)} needed, ${fmt(have, ccy)} available. Add Treasury funding or a financing leg, or reduce the size.`);
    }
    if (o.action === 'sell_short') {
      const s = book.settings.short;
      const proceeds = qty * price * inst.multiplier;
      const need = (s.collateralPct - 1 + s.marginPct) * proceeds + feeTotal;
      if (cashNow.availableToTrade < need - 0.004) return reject(o, `Insufficient ${ccy} cash to collateralise the short: ${fmt(need, ccy)} needed beyond the sale proceeds (${((s.collateralPct - 1) * 100).toFixed(0)}% collateral top-up plus ${(s.marginPct * 100).toFixed(0)}% margin), ${fmt(cashNow.availableToTrade, ccy)} available.`);
    }
    if (inst.family === 'option' && o.action === 'sell') {
      const extra = marginIncrease(o, inst, -qty, book);
      const after = cashNow.availableToTrade + qty * price * inst.multiplier - feeTotal;
      if (extra > after + 0.004) return reject(o, `Insufficient ${ccy} cash to secure the short option: ${fmt(extra, ccy)} must be reserved, ${fmt(Math.max(after, 0), ccy)} is available after the premium.`);
    }
    if (o.action === 'sell' && rule === 'borrow' && inst.family !== 'bond') {
      const extra = marginIncrease(o, inst, -qty, book);
      if (extra > cashNow.availableToTrade + 0.004) return reject(o, `Selling these shares would leave short calls uncovered, and ${fmt(extra, ccy)} of margin cash is not available. Close the calls first.`);
    }

    // ---- book it ----------------------------------------------------------------------------
    const fillId = newId('F');
    const r = plugin.fill(app, { book, unit, inst, order: o, action: o.action, qty, price, fees, strategyId: o.strategy_id, tradeDate: today, settleDate, fillId, data: { fillModel: est.model, priceObsId: obs ? app.data.recordUsed(obs) : null, purpose: o.data.purpose || 'primary' } });
    recordFill(o, { qty, price, gross: r.gross ?? null, ccy, fees, model: est.model, note: `${est.label}. ${est.note}`, obs: est.model === 'stated-price' ? null : obs, settleDate, eventId: r.eventId });
    filledThisCycle.add(o.id);
    afterPositionChange({ book, unit, inst, plugin, o, position: r.position });
    return true;
  }

  function borrowedQty(unitId, instrumentId, strategyId) {
    return db.all(
      `SELECT p.qty FROM positions p JOIN instruments i ON i.id = p.instrument_id WHERE p.unit_id = ? AND p.strategy_id = ? AND i.family = 'secloan' AND i.underlying_id = ? AND p.qty > 0`,
      unitId, strategyId || '', instrumentId,
    ).reduce((a, r) => a + r.qty, 0);
  }
  function pendingRestricted(positionId, ccy) {
    return money(db.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM settlements WHERE position_id = ? AND ccy = ? AND status = 'pending' AND amount > 0 AND accounts LIKE '["cash.restricted"%'`, positionId, ccy).s, ccy);
  }

  /** Extra option margin a strategy would need if `dq` of `inst` were added to it. */
  function marginIncrease(o, inst, dq, book) {
    const bucket = positions.list({ unitIds: [o.unit_id], strategyId: o.strategy_id }).map((p) => ({ inst: app.instruments.get(p.instrument_id), qty: p.qty, id: p.id }));
    const before = optionRequirement(app, bucket, book.settings.margin).reduce((a, r) => a + r.amount, 0);
    const hyp = bucket.map((p) => ({ ...p }));
    const hit = hyp.find((p) => p.inst.id === inst.id);
    if (hit) hit.qty += dq; else hyp.push({ inst, qty: dq });
    const after = optionRequirement(app, hyp, book.settings.margin).reduce((a, r) => a + r.amount, 0);
    return Math.max(0, round(after - before, 2));
  }

  function afterPositionChange({ book, unit, inst, plugin, o, position }) {
    if (position) {
      const fresh = positions.get(position.id);
      if (o && !fresh.data.purpose) positions.setData(fresh, { purpose: o.data.purpose || 'primary', hedgeLinkId: o.data.hedgeLinkId || null });
      if (plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst: app.instruments.get(inst.id), pos: positions.get(position.id) });
    }
    app.packages.recomputeHolds(o.strategy_id);
    // A change to the primary exposure after hedges are on means the hedges may no longer fit.
    if (app.hedge && (o.data.purpose || 'primary') === 'primary' && ['resize', 'adjust', 'close', 'roll', 'retry', 'forced_buy_in', 'unwind'].includes(o.data.intent)) {
      app.hedge.flagReview(o.strategy_id, 'The primary position changed');
    }
  }

  // ---- arrangement legs ----------------------------------------------------------------------
  function tryBorrow({ o, book, unit, inst, remaining }) {
    const info = app.data.borrowInfo(inst.id);
    const stated = o.data.borrow;
    const awaiting = app.data.describe().awaitingMessage;
    let feeRate, source, obs = null;
    if (info) {
      if (!info.available) return reject(o, `Borrow unavailable for ${inst.symbol || inst.name} (${info.obs?.source || 'supplied data'}). The dependent short sale cannot execute.`);
      if (info.quantity !== null && info.quantity !== undefined && info.quantity < remaining - 1e-9) return reject(o, `Only ${fmtQty(info.quantity)} ${inst.symbol || inst.name} is available to borrow (${info.obs?.source || 'supplied data'}); ${fmtQty(remaining)} requested.`);
      feeRate = info.feeRate;
      source = info.obs?.source || 'Supplied data';
      obs = info.obs || null;
    } else if (stated && stated.feeRate !== null && stated.feeRate !== undefined && stated.available !== false) {
      if (stated.quantity !== null && stated.quantity !== undefined && stated.quantity < remaining - 1e-9) return reject(o, `Your stated borrow assumption covers ${fmtQty(stated.quantity)}; ${fmtQty(remaining)} requested.`);
      feeRate = Number(stated.feeRate);
      source = 'Stated assumption (manually entered)';
    } else if (stated && stated.available === false) {
      return reject(o, 'Borrow marked unavailable in your stated assumption. The dependent short sale cannot execute.');
    } else {
      return reject(o, `No borrow availability data for ${inst.symbol || inst.name}. ${awaiting}. State a borrow assumption (availability and fee) on this leg to proceed.`);
    }
    const strategy = app.packages.getStrategyRow(o.strategy_id);
    const loanInst = app.instruments.create({
      productId: inst.family === 'bond' ? 'bond_loan' : 'stock_loan', name: `Borrow of ${inst.symbol || inst.name} (${strategy.name})`, marketView: inst.market_view.replace('_DERIV', '_CASH'),
      venueType: 'otc', underlyingId: inst.id, tradingCcy: inst.trading_ccy,
      terms: { feeRate, collateralPct: book.settings.short.collateralPct, availabilitySource: source, counterparty: 'Simulated lender' },
    }, { actor: 'engine' });
    const plugin = app.products.get('secloan');
    const r = plugin.open(app, { book, unit, inst: loanInst, order: o, action: 'borrow_sec', qty: remaining, strategyId: o.strategy_id, tradeDate: clock.today(), data: { availabilitySource: source, borrowObsId: obs ? app.data.recordUsed(obs) : null } });
    recordFill(o, { qty: remaining, price: null, model: 'borrow', note: `Securities borrow arranged at ${(feeRate * 100).toFixed(3)}% p.a. Availability and fee: ${source}.`, obs, eventId: r.eventId });
    positions.setData(positions.get(r.position.id), { purpose: 'financing' });
    plugin.onPositionChange(app, { book, unit, inst: loanInst, pos: positions.get(r.position.id) });
    return true;
  }

  function tryOpenArrangement({ o, book, unit, inst, plugin, remaining }) {
    const args = { unit, inst, action: o.action, qty: remaining, collateralPositionId: o.data.collateralPositionId, sourcePositionId: o.data.sourcePositionId };
    const problems = plugin.checkOpen ? plugin.checkOpen(app, args) : [];
    if (problems.length) return reject(o, problems[0]);
    const r = plugin.open(app, { book, unit, inst, order: o, action: o.action, qty: remaining, strategyId: o.strategy_id, tradeDate: clock.today(), collateralPositionId: o.data.collateralPositionId, sourcePositionId: o.data.sourcePositionId });
    recordFill(o, { qty: remaining, price: null, ccy: inst.trading_ccy, model: 'arrangement', note: 'Simulated financing arrangement opened on the stated terms.', eventId: r.eventId });
    positions.setData(positions.get(r.position.id), { purpose: o.data.purpose || 'financing', hedgeLinkId: o.data.hedgeLinkId || null });
    if (plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst: app.instruments.get(inst.id), pos: positions.get(r.position.id) });
    app.packages.recomputeHolds(o.strategy_id);
    return true;
  }

  function tryCloseArrangement({ o, book, unit, remaining }) {
    const pos = positions.get(o.data.targetPositionId);
    if (!pos || isZero(pos.qty)) return reject(o, 'The arrangement this leg closes is no longer open.');
    const inst = app.instruments.get(pos.instrument_id);
    const plugin = app.products.get(inst.family);
    const qty = Math.min(remaining, Math.abs(pos.qty));
    const problems = plugin.checkClose ? plugin.checkClose(app, { unit, inst, pos, qty }) : [];
    if (problems.length) return wait(o, problems[0]);
    const r = plugin.close(app, { book, unit, inst, pos, order: o, qty, tradeDate: clock.today() });
    recordFill(o, { qty: remaining, price: null, ccy: inst.trading_ccy, model: 'arrangement', note: 'Simulated financing arrangement closed.', eventId: r.eventId });
    if (plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst, pos: positions.get(pos.id) });
    app.packages.recomputeHolds(o.strategy_id);
    return true;
  }

  function tryReserve({ o, book, unit, remaining }) {
    const { ccy, amount } = o.data.reserve || {};
    const share = money((amount * remaining) / o.qty, ccy);
    const have = ledger.cash(unit.id, ccy).availableToTrade;
    if (have < share - 0.004) return reject(o, `Cannot reserve ${fmt(share, ccy)} of exercise cash: ${fmt(Math.max(have, 0), ccy)} is available in ${unit.name}.`);
    ledger.placeHold({ bookId: book.id, unitId: unit.id, ccy, amount: share, kind: 'exercise_cash', refType: 'strategy', refId: o.strategy_id, note: 'Cash reserved for put exercise' });
    const eventId = ledger.post({ bookId: book.id, unitId: unit.id, type: 'cash.reserved', strategyId: o.strategy_id, orderId: o.id, summary: `Reserved ${fmt(share, ccy)} for possible put exercise`, data: { ccy, amount: share } });
    recordFill(o, { qty: remaining, price: null, ccy, model: 'reservation', note: 'Cash reserved; it stays in the account but is not available for other trades.', eventId });
    return true;
  }

  function tryLink({ o, book, unit, inst, plugin, remaining }) {
    const src = positions.get(o.data.sourcePositionId);
    if (!src || src.unit_id !== unit.id || src.instrument_id !== inst.id) return reject(o, 'The existing position to use was not found in this Treasury/Account.');
    if (Math.abs(src.qty) < remaining - 1e-9) return reject(o, `The existing position is ${fmtQty(Math.abs(src.qty))}; ${fmtQty(remaining)} was to be used.`);
    if (src.qty > 0 && positions.freeQty(src) < remaining - 1e-9) return reject(o, `Only ${fmtQty(positions.freeQty(src))} of the existing position is unencumbered.`);
    const eventId = relink({ book, unit, inst, src, qty: remaining, toStrategyId: o.strategy_id, orderId: o.id });
    recordFill(o, { qty: remaining, price: null, ccy: inst.trading_ccy, model: 'link', note: 'Existing position linked to this strategy. Nothing was bought or sold.', eventId });
    const tgt = positions.find(unit.id, inst.id, o.strategy_id);
    if (tgt && !tgt.data.purpose) positions.setData(tgt, { purpose: o.data.purpose || 'primary' });
    if (plugin.onPositionChange) {
      plugin.onPositionChange(app, { book, unit, inst, pos: positions.get(src.id) });
      if (tgt) plugin.onPositionChange(app, { book, unit, inst, pos: positions.get(tgt.id) });
    }
    app.packages.recomputeHolds(o.strategy_id);
    if (src.strategy_id) { app.packages.recomputeHolds(src.strategy_id); app.packages.refreshStrategy(src.strategy_id); }
    return true;
  }

  /**
   * Move `qty` of a position (and the balances attached to it) into another strategy instance of
   * the same unit. A short position takes its securities borrow with it.
   */
  function relink({ book, unit, inst, src, qty, toStrategyId, orderId }) {
    const ccy = inst.trading_ccy;
    const frac = Math.min(1, qty / Math.abs(src.qty));
    const signed = Math.sign(src.qty) * qty;
    const tgt = positions.ensure({ bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: toStrategyId });
    const entries = [];
    const moveBal = (account, total, fromId, toId) => {
      const amt = frac >= 1 ? total : money(total * frac, ccy);
      if (amt === 0) return;
      entries.push({ account, ccy, amount: -amt, positionId: fromId, strategyId: src.strategy_id }, { account, ccy, amount: amt, positionId: toId, strategyId: toStrategyId });
    };
    const costMove = frac >= 1 ? src.cost : money(src.cost * frac, ccy);
    moveBal('pos', src.cost, src.id, tgt.id);
    for (const acct of ['accrued.asset', 'cash.restricted', 'cash.margin']) moveBal(acct, ledger.positionBalance(src.id, acct, ccy), src.id, tgt.id);
    const eventId = ledger.post({
      bookId: book.id, unitId: unit.id, type: 'position.linked', instrumentId: inst.id, strategyId: toStrategyId, orderId, positionId: tgt.id,
      summary: `Linked existing ${src.qty > 0 ? 'long' : 'short'} position of ${fmtQty(qty)} ${inst.symbol || inst.name} to this strategy (no trade)`,
      data: { fromPositionId: src.id, fromStrategyId: src.strategy_id, qty: signed, cost: costMove },
      entries,
    });
    positions.change(src, { dQty: -signed, dCost: -costMove });
    positions.change(tgt, { dQty: signed, dCost: costMove, data: src.data.mark !== undefined ? { mark: src.data.mark } : {} });
    if (src.qty < 0) {
      // Take the matching share of the securities borrow along.
      const loans = db.all(`SELECT p.* FROM positions p JOIN instruments i ON i.id = p.instrument_id WHERE p.unit_id = ? AND p.strategy_id = ? AND i.family = 'secloan' AND i.underlying_id = ? AND p.qty > 0`, unit.id, src.strategy_id, inst.id);
      let left = qty;
      for (const row of loans) {
        if (left <= 1e-9) break;
        const lp = positions.get(row.id);
        const take = Math.min(left, lp.qty);
        const lf = take / lp.qty;
        const ltgt = positions.ensure({ bookId: book.id, unitId: unit.id, instrumentId: lp.instrument_id, strategyId: toStrategyId });
        const acc = ledger.positionBalance(lp.id, 'accrued.liab', ccy);
        const accMove = lf >= 1 ? acc : money(acc * lf, ccy);
        if (accMove !== 0) {
          ledger.post({ bookId: book.id, unitId: unit.id, type: 'position.linked', instrumentId: lp.instrument_id, strategyId: toStrategyId, positionId: ltgt.id, summary: 'Moved accrued borrow fee with the linked securities borrow', entries: [{ account: 'accrued.liab', ccy, amount: -accMove, positionId: lp.id }, { account: 'accrued.liab', ccy, amount: accMove, positionId: ltgt.id }] });
        }
        const d = { accrued: (lp.data.accrued || 0) * lf, accruedThrough: lp.data.accruedThrough, side: 'borrow', lastPrice: lp.data.lastPrice ?? null, purpose: 'financing' };
        positions.change(lp, { dQty: -take, data: { accrued: (lp.data.accrued || 0) * (1 - lf) } });
        positions.change(ltgt, { dQty: take, data: d });
        const li = app.instruments.get(lp.instrument_id);
        app.products.get('secloan').onPositionChange(app, { book, unit, inst: li, pos: positions.get(ltgt.id) });
        app.products.get('secloan').onPositionChange(app, { book, unit, inst: li, pos: positions.get(lp.id) });
        left -= take;
      }
    }
    return eventId;
  }

  function tryFunding({ o, book, unit, remaining }) {
    const f = o.data.funding || {};
    const amount = money((f.amount * remaining) / o.qty, f.ccy);
    try {
      const r = app.books.transfer({ bookId: book.id, fromUnitId: f.fromUnitId, toUnitId: unit.id, ccy: f.ccy, amount, purpose: `Funding for ${app.packages.getStrategyRow(o.strategy_id).name}`, strategyId: o.strategy_id, orderId: o.id });
      recordFill(o, { qty: remaining, price: null, ccy: f.ccy, model: 'funding', note: 'Internal transfer from Treasury. No currency conversion.', eventId: r.eventId });
      return true;
    } catch (err) {
      if (err instanceof AppError) return reject(o, err.message);
      throw err;
    }
  }

  // ---- net debit / credit limit for a package's option legs -------------------------------------
  function netLimitBlocks(strategy, submission, legs) {
    const lim = strategy.params?.netLimits?.[submission];
    if (lim === null || lim === undefined) return null;
    const book = app.books.getBook(strategy.book_id);
    let net = 0, fullNet = 0;
    for (const o of legs) {
      if (o.kind !== 'trade' || o.data.group !== 'options' || !ACTIVE.has(o.status)) continue;
      const inst = app.instruments.get(o.instrument_id);
      const est = estimateFill(app, { inst, action: o.action, obs: app.data.price(inst.id), book, statedPrice: o.data.statedPrice ?? null });
      if (!est.executable) return `Net limit: waiting for an executable price on leg ${o.leg_no}. ${est.reason || ''}`.trim();
      const s = BUY.has(o.action) ? 1 : -1;
      net += s * (o.qty - o.filled_qty) * est.price * inst.multiplier;
      fullNet += s * o.qty * est.price * inst.multiplier;
    }
    void net;
    if (fullNet > lim + 0.005) {
      const f = (x) => (x >= 0 ? `debit ${round(x, 2)}` : `credit ${round(-x, 2)}`);
      return `Net limit not reached: package would execute at a net ${f(fullNet)} against a limit of net ${f(lim)}.`;
    }
    return null;
  }

  /** One matching pass over the active orders (all, or one strategy's). Returns the number of changes. */
  function process(strategyId) {
    let changes = 0;
    // A trade leg takes displayed size at most once per matching cycle; later passes in the same
    // cycle only let dependent legs follow.
    filledThisCycle = new Set();
    for (let pass = 0; pass < 6; pass++) {
      let progressed = 0;
      const rows = active(strategyId);
      const bySubmission = new Map();
      for (const o of rows) {
        if (!bySubmission.has(o.submission)) bySubmission.set(o.submission, []);
        bySubmission.get(o.submission).push(o);
      }
      const touched = new Set();
      for (const [submission, legs] of bySubmission) {
        const strategy = app.packages.getStrategyRow(legs[0].strategy_id);
        const block = db.tx(() => netLimitBlocks(strategy, submission, legs));
        for (const o of legs) {
          const did = db.tx(() => {
            const fresh = get(o.id);
            if (block && fresh.kind === 'trade' && fresh.data.group === 'options') return wait(fresh, block);
            return tryOrder(fresh);
          });
          if (did) { progressed++; touched.add(o.strategy_id); }
        }
      }
      for (const s of touched) app.packages.refreshStrategy(s);
      changes += progressed;
      if (!progressed) break;
    }
    return changes;
  }

  /** Subjects the data adapter should refresh before a matching pass. */
  function dataNeeds(strategyId) {
    const instruments = new Map(), borrow = new Map();
    for (const o of active(strategyId)) {
      const inst = o.instrument_id ? app.instruments.get(o.instrument_id) : null;
      if (!inst) continue;
      if (o.kind === 'trade') {
        instruments.set(inst.id, inst);
        if (inst.underlying_id) { const u = app.instruments.get(inst.underlying_id); if (u) instruments.set(u.id, u); }
      }
      if (o.kind === 'borrow_sec') { borrow.set(inst.id, inst); instruments.set(inst.id, inst); }
    }
    return { instruments: [...instruments.values()], borrow: [...borrow.values()] };
  }

  return { insert, get, forStrategy, fillsFor, active, cancel, setStatus, expireDayOrders, process, dataNeeds, relink, borrowedQty, describe, FILL_MODEL_LABEL, ACTIVE, DEAD };
}
