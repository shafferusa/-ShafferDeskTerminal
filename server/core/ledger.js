// Double-entry paper ledger.
//
// post() writes one immutable audit event plus its balanced entries. For every event the amounts
// sum to zero per unit per currency. Each entry also stores its reporting-currency equivalent at
// posting time together with the FX observation used, so later FX refreshes never change history
// and FX effects can be separated without double counting.
//
// Sign convention: debit positive. Assets are positive, liabilities / equity / income negative.

import { j } from '../db/db.js';
import { AppError, ccyDecimals, money, round } from './util.js';

export const ACCOUNTS = {
  cash: { type: 'asset', label: 'Settled cash' },
  'cash.restricted': { type: 'asset', label: 'Restricted cash (short proceeds / borrow collateral)' },
  'cash.margin': { type: 'asset', label: 'Margin and collateral posted' },
  'recv.settle': { type: 'asset', label: 'Receivable for unsettled sales' },
  'accrued.asset': { type: 'asset', label: 'Accrued income receivable' },
  pos: { type: 'asset', label: 'Positions at cost' },
  'loan.asset': { type: 'asset', label: 'Cash lent' },
  'pay.settle': { type: 'liability', label: 'Payable for unsettled purchases' },
  'accrued.liab': { type: 'liability', label: 'Accrued expense payable' },
  'loan.liab': { type: 'liability', label: 'Cash borrowed' },
  'coll.received': { type: 'liability', label: 'Cash collateral received' },
  internal: { type: 'equity', label: 'Funding between Treasury and Accounts' },
  capital: { type: 'equity', label: 'External capital' },
  'pnl.realized': { type: 'pnl', label: 'Realized P&L' },
  'pnl.dividend': { type: 'pnl', label: 'Dividends' },
  'pnl.coupon': { type: 'pnl', label: 'Coupon and interest income' },
  'pnl.interest': { type: 'pnl', label: 'Interest income on cash lent' },
  'pnl.borrow': { type: 'pnl', label: 'Securities-borrow costs' },
  'pnl.funding': { type: 'pnl', label: 'Funding expense' },
  'pnl.lending': { type: 'pnl', label: 'Securities-lending income' },
  'pnl.commission': { type: 'pnl', label: 'Commissions' },
  'pnl.fee': { type: 'pnl', label: 'Fees' },
  'pnl.fx': { type: 'pnl', label: 'FX dealing cost' },
  'fx.clearing': { type: 'clearing', label: 'FX conversion clearing' },
};

export const BALANCE_SHEET_ACCOUNTS = Object.keys(ACCOUNTS).filter((a) => ['asset', 'liability'].includes(ACCOUNTS[a].type));
export const PNL_ACCOUNTS = Object.keys(ACCOUNTS).filter((a) => ACCOUNTS[a].type === 'pnl');
export const CASH_ACCOUNTS = ['cash', 'cash.restricted', 'cash.margin'];

export function createLedger(app) {
  const { db, clock } = app;
  const bookCcy = new Map();
  const rcOf = (bookId) => {
    let c = bookCcy.get(bookId);
    if (!c) {
      c = db.get('SELECT reporting_ccy FROM books WHERE id = ?', bookId)?.reporting_ccy;
      if (!c) throw new AppError(`Unknown Book ${bookId}`, { status: 404 });
      bookCcy.set(bookId, c);
    }
    return c;
  };

  /**
   * Write an audit event with balanced entries.
   * @param {Object} e
   * @param {string} e.bookId
   * @param {string} [e.unitId]       default unit for entries and the event's owner
   * @param {string} e.type           e.g. 'trade.fill', 'transfer.funding', 'coupon'
   * @param {string} e.summary        one-line description for the audit trail
   * @param {Array}  [e.entries]      [{unitId?, account, ccy, amount, instrumentId?, strategyId?, positionId?}]
   * @returns {number} event id
   */
  function post(e) {
    const ts = clock.now().toISOString();
    const businessDate = e.businessDate || clock.today();
    const rc = rcOf(e.bookId);
    const rows = [];
    const sums = new Map();
    for (const en of e.entries || []) {
      if (!ACCOUNTS[en.account]) throw new Error(`Unknown ledger account ${en.account}`);
      const amount = money(en.amount, en.ccy);
      if (!Number.isFinite(amount)) throw new Error(`Non-finite ledger amount for ${en.account}`);
      if (amount === 0) continue;
      const unitId = en.unitId || e.unitId;
      if (!unitId) throw new Error('Ledger entry without a unit');
      rows.push({ ...en, unitId, amount });
      const k = `${unitId}|${en.ccy}`;
      sums.set(k, (sums.get(k) || 0) + amount);
    }
    for (const [k, s] of sums) {
      const ccy = k.split('|')[1];
      if (Math.abs(s) > 0.5 * 10 ** -ccyDecimals(ccy)) {
        throw new Error(`Unbalanced ledger event "${e.type}" (${k}: ${round(s, 6)})`);
      }
    }
    return db.tx(() => {
      const res = db.run(
        `INSERT INTO events (ts, business_date, book_id, unit_id, type, instrument_id, strategy_id, order_id, position_id, summary, data, corrects_event_id, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ts, businessDate, e.bookId, e.unitId || null, e.type, e.instrumentId || null, e.strategyId || null, e.orderId || null,
        e.positionId || null, e.summary, j(e.data || {}), e.correctsEventId || null, e.actor || 'user',
      );
      const eventId = Number(res.lastInsertRowid);
      const fxCache = new Map();
      for (const r of rows) {
        let fx = fxCache.get(r.ccy);
        if (fx === undefined) {
          const q = app.data.fx(r.ccy, rc);
          fx = q ? { rate: q.rate, obsId: q.obs ? app.data.recordUsed(q.obs) : null } : null;
          fxCache.set(r.ccy, fx);
        }
        db.run(
          `INSERT INTO entries (event_id, book_id, unit_id, account, ccy, amount, amount_rc, fx_rate, fx_obs_id, instrument_id, strategy_id, position_id, business_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          eventId, e.bookId, r.unitId, r.account, r.ccy, r.amount, fx ? money(r.amount * fx.rate, rc) : null, fx ? fx.rate : null, fx ? fx.obsId : null,
          r.instrumentId ?? e.instrumentId ?? null, r.strategyId ?? e.strategyId ?? null, r.positionId ?? e.positionId ?? null, businessDate,
        );
      }
      return eventId;
    });
  }

  /** Sum of one account for a set of units in one currency. */
  function balance(unitIds, account, ccy) {
    const ids = Array.isArray(unitIds) ? unitIds : [unitIds];
    if (!ids.length) return 0;
    const row = db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM entries WHERE unit_id IN (${ids.map(() => '?').join(',')}) AND account = ? AND ccy = ?`,
      ...ids, account, ccy,
    );
    return money(row.s, ccy);
  }

  /** All non-zero balances for a set of units, grouped by unit, account and currency. */
  function balances(unitIds, { asOfDate } = {}) {
    const ids = Array.isArray(unitIds) ? unitIds : [unitIds];
    if (!ids.length) return [];
    const params = [...ids];
    let where = `unit_id IN (${ids.map(() => '?').join(',')})`;
    if (asOfDate) {
      where += ' AND business_date <= ?';
      params.push(asOfDate);
    }
    return db.all(
      `SELECT unit_id, account, ccy, SUM(amount) AS amount, SUM(amount_rc) AS amount_rc, SUM(CASE WHEN amount_rc IS NULL THEN 1 ELSE 0 END) AS rc_missing
       FROM entries WHERE ${where} GROUP BY unit_id, account, ccy`,
      ...params,
    ).map((r) => ({ ...r, amount: money(r.amount, r.ccy) })).filter((r) => r.amount !== 0 || Math.abs(r.amount_rc || 0) > 0.005);
  }

  /** Balance of one account attributable to one position. */
  function positionBalance(positionId, account, ccy) {
    const row = db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM entries WHERE position_id = ? AND account = ? AND ccy = ?', positionId, account, ccy);
    return money(row.s, ccy);
  }

  function reserved(unitId, ccy) {
    return money(db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM holds WHERE unit_id = ? AND ccy = ? AND released_at IS NULL', unitId, ccy).s, ccy);
  }

  /** Cash picture of one unit in one currency. */
  function cash(unitId, ccy) {
    const settled = balance(unitId, 'cash', ccy);
    const restricted = balance(unitId, 'cash.restricted', ccy);
    const margin = balance(unitId, 'cash.margin', ccy);
    const receivable = balance(unitId, 'recv.settle', ccy);
    const payable = money(-balance(unitId, 'pay.settle', ccy), ccy);
    const held = reserved(unitId, ccy);
    // Short-sale proceeds awaiting settlement will arrive as restricted collateral, not buying power.
    const restrictedPending = money(db.get(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM settlements WHERE unit_id = ? AND ccy = ? AND status = 'pending' AND amount > 0 AND accounts LIKE '["cash.restricted"%'`,
      unitId, ccy,
    ).s, ccy);
    return {
      ccy, settled, restricted, margin, receivable, payable, reserved: held, restrictedPending,
      unsettled: money(receivable - payable, ccy),
      // Cash that new purchases may commit: settled cash plus what is owed to us, less what we owe and what is reserved.
      availableToTrade: money(settled + receivable - restrictedPending - payable - held, ccy),
      // Cash that may leave the unit today: settled cash less committed payables and reservations.
      availableToWithdraw: money(Math.min(settled, settled - payable - held), ccy),
    };
  }

  /** Currencies in which a unit has any cash-related balance or hold. */
  function currencies(unitIds) {
    const ids = Array.isArray(unitIds) ? unitIds : [unitIds];
    if (!ids.length) return [];
    const q = ids.map(() => '?').join(',');
    const a = db.all(`SELECT DISTINCT ccy FROM entries WHERE unit_id IN (${q})`, ...ids).map((r) => r.ccy);
    const b = db.all(`SELECT DISTINCT ccy FROM holds WHERE unit_id IN (${q}) AND released_at IS NULL`, ...ids).map((r) => r.ccy);
    return [...new Set([...a, ...b])].sort();
  }

  // ---- holds (reserved cash) --------------------------------------------------------------
  function placeHold({ bookId, unitId, ccy, amount, kind, refType, refId, note }) {
    const amt = money(amount, ccy);
    if (!(amt > 0)) return null;
    const id = `HLD-${Math.random().toString(16).slice(2, 12).toUpperCase()}`;
    db.run('INSERT INTO holds (id, book_id, unit_id, ccy, amount, kind, ref_type, ref_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, bookId, unitId, ccy, amt, kind, refType || null, refId || null, note || null, clock.now().toISOString());
    return id;
  }
  function releaseHolds({ refType, refId, kind }) {
    const params = [clock.now().toISOString(), refType, refId];
    let sql = 'UPDATE holds SET released_at = ? WHERE ref_type = ? AND ref_id = ? AND released_at IS NULL';
    if (kind) {
      sql += ' AND kind = ?';
      params.push(kind);
    }
    db.run(sql, ...params);
  }
  /** Replace the open hold of a kind for a reference with a new amount (0 releases it). */
  function setHold({ bookId, unitId, ccy, amount, kind, refType, refId, note }) {
    const cur = db.get('SELECT id, amount FROM holds WHERE ref_type = ? AND ref_id = ? AND kind = ? AND ccy = ? AND unit_id = ? AND released_at IS NULL', refType, refId, kind, ccy, unitId);
    const amt = money(Math.max(0, amount || 0), ccy);
    if (cur && cur.amount === amt) return cur.id;
    if (cur) db.run('UPDATE holds SET released_at = ? WHERE id = ?', clock.now().toISOString(), cur.id);
    return placeHold({ bookId, unitId, ccy, amount: amt, kind, refType, refId, note });
  }
  const listHolds = (unitIds) => {
    const ids = Array.isArray(unitIds) ? unitIds : [unitIds];
    if (!ids.length) return [];
    return db.all(`SELECT * FROM holds WHERE unit_id IN (${ids.map(() => '?').join(',')}) AND released_at IS NULL ORDER BY created_at`, ...ids);
  };

  return { post, balance, balances, positionBalance, cash, currencies, reserved, placeHold, releaseHolds, setHold, listHolds, rcOf, invalidateBook: (id) => bookCcy.delete(id) };
}
