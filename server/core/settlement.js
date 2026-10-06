// Settlement of executed transactions.
//
// A fill books its position on trade date and leaves a receivable or payable. The matching cash
// only moves on the settlement date. A payment that cannot be covered FAILS (it is not silently
// funded): it stays on the Failed tab with its reason and is retried on later cycles.

import { j, pj } from '../db/db.js';
import { fmt } from './books.js';
import { money, newId } from './util.js';

export function createSettlement(app) {
  const { db, clock, ledger } = app;

  /** Register the cash movement that follows an execution. Settles immediately when already due. */
  function create(s) {
    const amount = money(s.amount, s.ccy);
    if (amount === 0) return null;
    const id = newId('STL');
    db.run(
      `INSERT INTO settlements (id, book_id, unit_id, fill_id, order_id, instrument_id, strategy_id, position_id, kind, due_date, ccy, amount, accounts, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id, s.bookId, s.unitId, s.fillId || null, s.orderId || null, s.instrumentId || null, s.strategyId || null, s.positionId || null,
      s.kind || 'trade', s.dueDate, s.ccy, amount, j(s.accounts || ['cash']), clock.now().toISOString(),
    );
    if (s.dueDate <= clock.today()) settleOne(db.get('SELECT * FROM settlements WHERE id = ?', id));
    return id;
  }

  function settleOne(row) {
    const accounts = pj(row.accounts, ['cash']);
    const base = { bookId: row.book_id, unitId: row.unit_id, instrumentId: row.instrument_id, strategyId: row.strategy_id, orderId: row.order_id, positionId: row.position_id, actor: 'engine' };
    const now = clock.now().toISOString();
    if (row.amount > 0) {
      const eventId = ledger.post({
        ...base, type: 'settlement.receive',
        summary: `Settlement: received ${fmt(row.amount, row.ccy)} into ${label(accounts[0])}`,
        data: { settlementId: row.id, fillId: row.fill_id, dueDate: row.due_date },
        entries: [
          { account: accounts[0], ccy: row.ccy, amount: row.amount },
          { account: 'recv.settle', ccy: row.ccy, amount: -row.amount },
        ],
      });
      db.run(`UPDATE settlements SET status = 'settled', settled_at = ?, event_id = ?, last_error = NULL WHERE id = ?`, now, eventId, row.id);
      return true;
    }
    // Payment: draw from the listed cash buckets in order; the last one must cover the remainder.
    let need = -row.amount;
    const draws = [];
    for (let i = 0; i < accounts.length && need > 0; i++) {
      const bal = ledger.balance(row.unit_id, accounts[i], row.ccy);
      const take = i === accounts.length - 1 ? need : Math.min(need, Math.max(0, bal));
      if (take <= 0) continue;
      if (i === accounts.length - 1 && bal < take - 0.004) {
        const msg = `Insufficient settled ${row.ccy} cash: ${fmt(Math.max(bal, 0), row.ccy)} available, ${fmt(take, row.ccy)} due.`;
        const first = row.status !== 'failed';
        db.run(`UPDATE settlements SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?`, msg, row.id);
        if (first) {
          ledger.post({ ...base, type: 'settlement.failed', summary: `Settlement failed: ${msg}`, data: { settlementId: row.id, fillId: row.fill_id, dueDate: row.due_date, amount: row.amount, ccy: row.ccy } });
          app.alerts.raise({ bookId: row.book_id, unitId: row.unit_id, level: 'error', code: 'settlement.failed', message: `Settlement due ${row.due_date} failed. ${msg}`, refType: 'settlement', refId: row.id });
        }
        return false;
      }
      draws.push({ account: accounts[i], amount: money(take, row.ccy) });
      need = money(need - take, row.ccy);
    }
    const eventId = ledger.post({
      ...base, type: 'settlement.pay',
      summary: `Settlement: paid ${fmt(-row.amount, row.ccy)} from ${draws.map((d) => label(d.account)).join(' and ')}`,
      data: { settlementId: row.id, fillId: row.fill_id, dueDate: row.due_date },
      entries: [
        { account: 'pay.settle', ccy: row.ccy, amount: -row.amount },
        ...draws.map((d) => ({ account: d.account, ccy: row.ccy, amount: -d.amount })),
      ],
    });
    db.run(`UPDATE settlements SET status = 'settled', settled_at = ?, event_id = ?, last_error = NULL WHERE id = ?`, now, eventId, row.id);
    app.alerts.resolve({ refType: 'settlement', refId: row.id });
    return true;
  }

  /** Settle everything due on or before `today`. Receipts first so same-day proceeds can fund same-day payments. */
  function settleDue(today = clock.today()) {
    const rows = db.all(`SELECT * FROM settlements WHERE status IN ('pending','failed') AND due_date <= ? ORDER BY due_date, CASE WHEN amount > 0 THEN 0 ELSE 1 END, created_at`, today);
    let done = 0;
    for (const row of rows) db.tx(() => { if (settleOne(row)) done++; });
    return done;
  }

  const pending = (unitIds) => (unitIds.length
    ? db.all(`SELECT * FROM settlements WHERE status = 'pending' AND unit_id IN (${unitIds.map(() => '?').join(',')}) ORDER BY due_date`, ...unitIds)
    : []);
  const failed = (unitIds) => (unitIds.length
    ? db.all(`SELECT * FROM settlements WHERE status = 'failed' AND unit_id IN (${unitIds.map(() => '?').join(',')}) ORDER BY due_date`, ...unitIds)
    : []);

  return { create, settleDue, pending, failed };
}

const LABELS = { cash: 'settled cash', 'cash.restricted': 'restricted cash', 'cash.margin': 'margin' };
const label = (a) => LABELS[a] || a;
