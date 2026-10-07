// Settlement of executed transactions.
//
// A fill books its position on trade date and leaves a receivable or payable. The matching cash
// only moves on the settlement date. A payment that cannot be covered FAILS (it is not silently
// funded): it stays on the Failed tab with its reason and is retried on later cycles.

import { j, pj } from '../db/db.js';
import { fmt } from './books.js';
import { ISO_DATE_RE, money, newId, num } from './util.js';
import { calendarInfo, FIXED_SETTLEMENT, MAX_SETTLE_LAG, settleDateFor, settlementConvention } from '../products/security.js';
import { addBusinessDays, businessDaysBetween, closedReason, isBusinessDay, prevBusinessDay } from '../quant/calendar.js';

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayName = (iso) => DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const realDate = (s) => ISO_DATE_RE.test(String(s || '')) && !Number.isNaN(Date.parse(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Order kinds that are matched in a market and so wait for a trading day: trades, securities borrowing and
 * lending, cash loans and repos, and their closing legs. Internal legs (Treasury funding, a cash reservation,
 * linking a position already held) are not market actions and are never held back.
 */
export const TRADING_DAY_KINDS = new Set(['trade', 'borrow_sec', 'lend_sec', 'return_sec', 'recall_sec', 'loan', 'repay', 'repo_open', 'repo_close']);

/**
 * Whether an instrument's market is open on a date, by its trading calendar.
 * Returns { open, calendarId, date, next, reason }: `next` is the date an order placed on `date` is matched
 * (the date itself when open), `reason` the sentence shown on a waiting order when it is closed.
 * An instrument on ALLDAYS is always open; one on the weekends-only fallback is closed at weekends only.
 * Only the matching of orders is held back by this: settlements, lifecycle events and accruals are not.
 */
export function tradingDay(inst, date) {
  const cal = calendarInfo(inst).trading;
  if (isBusinessDay(date, cal.id)) return { open: true, calendarId: cal.id, date, next: date, reason: null };
  const next = addBusinessDays(date, 1, cal.id);
  return { open: false, calendarId: cal.id, date, next, reason: `Market closed today on calendar ${cal.id} (${date} is ${closedReason(date, cal.id)}); will be matched on ${next}.` };
}

/**
 * The settlement date of one trade, and where it came from.
 *
 *   stated: null | { date: 'YYYY-MM-DD' } | { lag: n }   a settlement stated for this transaction
 *
 * Without `stated` the instrument's convention applies (its own lag, else the Book's), counted on
 * the instrument's settlement calendar. A stated date or lag is validated against that calendar;
 * anything that cannot be honoured is a calendar conflict, returned in `conflicts` with a specific
 * message (the preview blocks on it, and an order refuses to fill on it). Nothing is adjusted
 * silently: a stated date on a holiday is refused, not moved.
 *
 * Returns { date, lag, basis, label, calendar: { id, label, fallback, approximate }, stated, conflicts: [{ code, message }] }
 *   basis: transaction-date | transaction-lag | instrument | book | product
 */
export function resolveSettlement(app, { inst, book, tradeDate, stated = null }) {
  const plugin = app.products.get(inst.family);
  const info = calendarInfo(inst);
  const cal = info.settlement;
  const conv = settlementConvention(inst, book);
  const name = inst.symbol || inst.name;
  const calendar = { id: cal.id, label: cal.label, basis: cal.basis, fallback: cal.fallback, approximate: cal.approximate };
  const standard = plugin.settleDate(app, inst, tradeDate, book);
  const out = { date: standard, lag: conv.lag, basis: conv.basis, label: conv.label, calendar, stated: null, conflicts: [], standard: { date: standard, lag: conv.lag, basis: conv.basis, label: conv.label } };
  const has = (v) => v !== null && v !== undefined && v !== '';
  if (!stated || (!has(stated.date) && !has(stated.lag))) return out;
  const conflict = (code, message) => { out.conflicts.push({ code, message }); return out; };
  out.stated = has(stated.date) ? { date: String(stated.date) } : { lag: stated.lag };
  if (!conv.configurable) return conflict('settlement-fixed', `A settlement date or lag cannot be stated for ${name}. ${FIXED_SETTLEMENT[inst.family]}`);
  if (has(stated.date)) {
    const d = String(stated.date);
    out.basis = 'transaction-date';
    if (!realDate(d)) return conflict('settle-date-invalid', `The stated settlement date "${d}" is not a calendar date in the form YYYY-MM-DD.`);
    out.date = d;
    out.label = `Stated date ${d}`;
    if (d < tradeDate) return conflict('settle-before-trade', `Calendar conflict: the stated settlement date ${d} is before the trade date ${tradeDate}. A trade cannot settle before it is done.`);
    if (!isBusinessDay(d, cal.id)) {
      const before = prevBusinessDay(d, cal.id), after = addBusinessDays(d, 1, cal.id);
      return conflict('settle-not-business-day', `Calendar conflict: the stated settlement date ${d} (${dayName(d)}) is ${closedReason(d, cal.id)}, not a business day on the settlement calendar of ${name} (${cal.id}: ${cal.label}). The nearest business days are ${before >= tradeDate ? `${before} and ` : ''}${after}.`);
    }
    out.lag = businessDaysBetween(tradeDate, d, cal.id);
    out.label = out.lag === 0 ? `Stated date ${d} (same day)` : `Stated date ${d} (T+${out.lag})`;
    if (out.lag > MAX_SETTLE_LAG) return conflict('settle-too-far', `The stated settlement date ${d} is ${out.lag} business days after the trade date; the longest a trade may state is ${MAX_SETTLE_LAG}. A later delivery is a forward, with its own contract.`);
    return out;
  }
  const lag = num(stated.lag);
  out.basis = 'transaction-lag';
  if (lag === null || !Number.isInteger(lag) || lag < 0 || lag > MAX_SETTLE_LAG) return conflict('settle-lag-invalid', `The stated settlement lag must be a whole number of business days from 0 (same day) to ${MAX_SETTLE_LAG}.`);
  out.lag = lag;
  out.date = settleDateFor(inst, tradeDate, lag);
  out.label = lag === 0 ? 'Stated: same day' : `Stated: T+${lag}`;
  return out;
}

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
      // Restricted cash is drawn only from what is held against this position (the proceeds and collateral of the
      // short being covered). Other restricted cash in the unit, such as collateral received from a counterparty,
      // belongs to someone else and is never spent on a settlement.
      const bal = accounts[i] === 'cash.restricted' && i < accounts.length - 1 && row.position_id
        ? ledger.positionBalance(row.position_id, 'cash.restricted', row.ccy)
        : ledger.balance(row.unit_id, accounts[i], row.ccy);
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
