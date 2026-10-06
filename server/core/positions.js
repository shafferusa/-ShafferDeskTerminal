// Positions. One row per (unit, instrument, strategy instance). Cost basis is average cost,
// kept in the instrument's trading currency and signed (short positions carry negative cost,
// i.e. the proceeds received). Every quantity change is logged so entitlements (dividends,
// coupons) can be computed for a past date.

import { j, pj } from '../db/db.js';
import { isZero, money, newId, qty8, sign } from './util.js';

export function createPositions(app) {
  const { db, clock } = app;
  const parse = (p) => p && { ...p, data: pj(p.data, {}) };

  const get = (id) => parse(db.get('SELECT * FROM positions WHERE id = ?', id));
  const find = (unitId, instrumentId, strategyId = '') =>
    parse(db.get('SELECT * FROM positions WHERE unit_id = ? AND instrument_id = ? AND strategy_id = ?', unitId, instrumentId, strategyId || ''));

  function ensure({ bookId, unitId, instrumentId, strategyId = '' }) {
    const existing = find(unitId, instrumentId, strategyId);
    if (existing) return existing;
    const id = newId('POS');
    const now = clock.now().toISOString();
    db.run('INSERT INTO positions (id, book_id, unit_id, instrument_id, strategy_id, opened_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, bookId, unitId, instrumentId, strategyId || '', now, now);
    return get(id);
  }

  /** Apply deltas to a position. Returns the refreshed row. */
  function change(pos, { dQty = 0, dCost = 0, dPledged = 0, dOnLoan = 0, data } = {}) {
    const qty = qty8(pos.qty + dQty);
    let cost = pos.cost + dCost;
    if (isZero(qty)) cost = Math.abs(cost) < 0.005 ? 0 : cost;
    const pledged = qty8(pos.pledged_qty + dPledged);
    const onloan = qty8(pos.onloan_qty + dOnLoan);
    const newData = data ? { ...pos.data, ...data } : pos.data;
    const now = clock.now().toISOString();
    const reopened = !isZero(qty) && pos.closed_at;
    const closedAt = isZero(qty) ? pos.closed_at || now : null;
    db.run('UPDATE positions SET qty = ?, cost = ?, pledged_qty = ?, onloan_qty = ?, data = ?, updated_at = ?, closed_at = ?, opened_at = ? WHERE id = ?',
      qty, cost, pledged, onloan, j(newData), now, closedAt, reopened ? now : pos.opened_at, pos.id);
    if (!isZero(dQty)) {
      db.run('INSERT INTO position_history (position_id, ts, business_date, qty) VALUES (?, ?, ?, ?)', pos.id, now, clock.today(), qty);
    }
    return get(pos.id);
  }

  const setData = (pos, patch) => change(pos, { data: patch });

  /**
   * Average-cost arithmetic for a trade of signed quantity dq at unitCost (price x multiplier).
   * Returns money-rounded figures that balance exactly:
   *   gross     signed principal (+ when buying)
   *   costDelta change in the position's signed cost
   *   realized  realized gain (+) or loss (-)  = costDelta - gross ... expressed as a gain
   */
  function tradeMath(pos, dq, unitCost, ccy) {
    const gross = money(dq * unitCost, ccy);
    if (isZero(pos.qty) || sign(pos.qty) === sign(dq)) {
      return { gross, costDelta: gross, realized: 0, closedQty: 0, openedQty: dq };
    }
    const closing = Math.min(Math.abs(dq), Math.abs(pos.qty));
    const closedSigned = sign(dq) * closing;
    const full = closing >= Math.abs(pos.qty) - 1e-9;
    const avg = pos.cost / pos.qty;
    const closeCost = full ? -pos.cost : money(avg * closedSigned, ccy);
    const remainder = qty8(dq - closedSigned);
    const openCost = isZero(remainder) ? 0 : money(remainder * unitCost, ccy);
    const costDelta = money(closeCost + openCost, ccy);
    // Proceeds of the closing part versus the cost removed.
    const realized = money(costDelta - gross, ccy);
    return { gross, costDelta, realized, closedQty: closedSigned, openedQty: remainder };
  }

  function list({ unitIds, bookId, instrumentId, strategyId, includeClosed = false } = {}) {
    const where = [];
    const params = [];
    if (unitIds) {
      if (!unitIds.length) return [];
      where.push(`unit_id IN (${unitIds.map(() => '?').join(',')})`);
      params.push(...unitIds);
    }
    if (bookId) { where.push('book_id = ?'); params.push(bookId); }
    if (instrumentId) { where.push('instrument_id = ?'); params.push(instrumentId); }
    if (strategyId !== undefined && strategyId !== null) { where.push('strategy_id = ?'); params.push(strategyId); }
    if (!includeClosed) where.push('(ABS(qty) > 1e-9 OR closed_at IS NULL AND ABS(cost) > 0.004)');
    const sql = `SELECT * FROM positions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_at`;
    return db.all(sql, ...params).map(parse);
  }

  /** Position quantity at the open ('open') or close ('close') of a business date. */
  function qtyAt(positionId, date, when = 'open') {
    const op = when === 'open' ? '<' : '<=';
    const row = db.get(`SELECT qty FROM position_history WHERE position_id = ? AND business_date ${op} ? ORDER BY id DESC LIMIT 1`, positionId, date);
    return row ? row.qty : 0;
  }

  /** Quantity of a long position that is not pledged or out on loan. */
  const freeQty = (pos) => Math.max(0, qty8(pos.qty - pos.pledged_qty - pos.onloan_qty));

  /** Every position that has ever had a quantity on or after `date` for an instrument (entitlement scans). */
  function heldAround(instrumentId) {
    return db.all('SELECT * FROM positions WHERE instrument_id = ?', instrumentId).map(parse);
  }

  return { get, find, ensure, change, setData, tradeMath, list, qtyAt, freeQty, heldAround };
}
