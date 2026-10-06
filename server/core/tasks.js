// Scheduled lifecycle work (coupons, expirations, maturities, resets, payments, recalls) and alerts.
//
// A task that needs an observation the Terminal does not have (a fixing, a closing price) is
// BLOCKED, with the missing input named. It shows on the Pending tab with its dependency status
// and runs as soon as the observation is supplied by the data connection or entered by hand.

import { j, pj } from '../db/db.js';
import { newId } from './util.js';

export function createTasks(app) {
  const { db, clock } = app;
  const parse = (t) => t && { ...t, data: pj(t.data, {}), needs: pj(t.needs, []) };

  function schedule({ bookId, unitId, positionId, instrumentId, strategyId, type, dueDate, data }) {
    // One open task per (position, type, due date, key) so re-scheduling is idempotent.
    const key = data?.key ?? '';
    const dup = db.get(`SELECT id FROM tasks WHERE position_id IS ? AND type = ? AND due_date = ? AND status IN ('pending','blocked','failed') AND json_extract(data, '$.key') IS ?`,
      positionId || null, type, dueDate, key || null);
    if (dup) return dup.id;
    const id = newId('TSK');
    db.run('INSERT INTO tasks (id, book_id, unit_id, position_id, instrument_id, strategy_id, type, due_date, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, bookId, unitId, positionId || null, instrumentId || null, strategyId || null, type, dueDate, j({ ...(data || {}), key: key || undefined }), clock.now().toISOString());
    return id;
  }

  const due = (today) => db.all(`SELECT * FROM tasks WHERE status IN ('pending','blocked','failed') AND due_date <= ? ORDER BY due_date, created_at`, today).map(parse);
  const done = (id, eventId) => db.run(`UPDATE tasks SET status = 'done', done_at = ?, event_id = ?, blocked_reason = NULL, needs = '[]' WHERE id = ?`, clock.now().toISOString(), eventId || null, id);
  const block = (id, reason, needs) => db.run(`UPDATE tasks SET status = 'blocked', blocked_reason = ?, needs = ? WHERE id = ?`, reason, j(needs || []), id);
  const failTask = (id, reason) => db.run(`UPDATE tasks SET status = 'failed', blocked_reason = ? WHERE id = ?`, reason, id);
  const cancelFor = (positionId, types) => {
    if (types?.length) db.run(`UPDATE tasks SET status = 'cancelled', done_at = ? WHERE position_id = ? AND status IN ('pending','blocked','failed') AND type IN (${types.map(() => '?').join(',')})`, clock.now().toISOString(), positionId, ...types);
    else db.run(`UPDATE tasks SET status = 'cancelled', done_at = ? WHERE position_id = ? AND status IN ('pending','blocked','failed')`, clock.now().toISOString(), positionId);
  };
  const open = (unitIds) => (unitIds.length
    ? db.all(`SELECT * FROM tasks WHERE status IN ('pending','blocked','failed') AND unit_id IN (${unitIds.map(() => '?').join(',')}) ORDER BY due_date, created_at`, ...unitIds).map(parse)
    : []);
  const get = (id) => parse(db.get('SELECT * FROM tasks WHERE id = ?', id));
  const setData = (id, data) => db.run('UPDATE tasks SET data = ? WHERE id = ?', j(data), id);

  return { schedule, due, done, block, fail: failTask, cancelFor, open, get, setData };
}

export function createAlerts(app) {
  const { db, clock } = app;
  function raise({ bookId, unitId, level = 'warning', code, message, refType, refId }) {
    const existing = db.get('SELECT id FROM alerts WHERE code = ? AND ref_type IS ? AND ref_id IS ? AND resolved_at IS NULL', code, refType || null, refId || null);
    if (existing) {
      db.run('UPDATE alerts SET message = ?, ts = ? WHERE id = ?', message, clock.now().toISOString(), existing.id);
      return existing.id;
    }
    const res = db.run('INSERT INTO alerts (ts, book_id, unit_id, level, code, message, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      clock.now().toISOString(), bookId || null, unitId || null, level, code, message, refType || null, refId || null);
    return Number(res.lastInsertRowid);
  }
  function resolve({ refType, refId, code }) {
    const params = [clock.now().toISOString(), refType || null, refId || null];
    let sql = 'UPDATE alerts SET resolved_at = ? WHERE ref_type IS ? AND ref_id IS ? AND resolved_at IS NULL';
    if (code) { sql += ' AND code = ?'; params.push(code); }
    db.run(sql, ...params);
  }
  const dismiss = (id) => db.run('UPDATE alerts SET resolved_at = ? WHERE id = ?', clock.now().toISOString(), id);
  const open = (bookId) => db.all('SELECT * FROM alerts WHERE resolved_at IS NULL AND (book_id = ? OR book_id IS NULL) ORDER BY id DESC LIMIT 200', bookId || null);
  return { raise, resolve, dismiss, open };
}
