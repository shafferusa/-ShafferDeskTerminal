// Futures.
//
// A future is not bought for its notional. Opening a position posts initial margin; profit and
// loss is paid or received in cash as variation margin each day against the settlement price.
// Market value shown for a future is its open trade equity since the last settlement, and the
// contract notional is reported separately.
//
// Final settlement closes the position in cash at the final settlement price. Physical delivery
// is not simulated.

import { fmt } from '../core/books.js';
import { ISO_DATE_RE, isZero, money, num, qty8, sign } from '../core/util.js';
import { dqOf, fmtPx, fmtQty } from './common.js';
import { calendarFor } from './security.js';

function postFees(c, ccy) {
  const commission = money(c.fees?.filter((f) => f.kind === 'commission').reduce((a, f) => a + f.amount, 0) || 0, ccy);
  const other = money(c.fees?.filter((f) => f.kind !== 'commission').reduce((a, f) => a + f.amount, 0) || 0, ccy);
  return { commission, other, total: money(commission + other, ccy) };
}

export const future = {
  family: 'future',
  kind: 'future',
  shortRule: 'write',
  label: 'Future',
  qtyLabel: 'Contracts',
  actions: () => ['buy', 'sell'],
  priceUnits: (inst) => inst.terms?.priceUnits || 'contract price',
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    const multiplier = num(draft.multiplier);
    if (!(multiplier > 0)) errors.push('Contract multiplier (point value) is required.');
    if (t.perpetual) {
      delete t.expiration;
    } else if (!ISO_DATE_RE.test(t.expiration || '')) {
      errors.push('Expiration (last trading day) is required, or mark the contract as perpetual.');
    }
    t.tickSize = num(t.tickSize);
    if (t.tickSize !== null && !(t.tickSize > 0)) errors.push('Tick size must be positive.');
    t.initialMargin = num(t.initialMargin);
    if (t.initialMargin !== null && t.initialMargin < 0) errors.push('Initial margin cannot be negative.');
    t.settlement = ['cash', 'physical'].includes(t.settlement) ? t.settlement : 'cash';
    return { terms: t, multiplier: multiplier > 0 ? multiplier : 1, errors };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Contract multiplier', inst.multiplier], ['Expiration', t.perpetual ? 'Perpetual' : t.expiration], ['Settlement', t.settlement === 'physical' ? 'Physical (closed out in cash by the Terminal)' : 'Cash']];
    if (t.tickSize) rows.push(['Tick size', t.tickSize], ['Tick value', `${money(t.tickSize * inst.multiplier, inst.trading_ccy)} ${inst.trading_ccy}`]);
    rows.push(['Initial margin per contract', t.initialMargin !== null && t.initialMargin !== undefined ? `${t.initialMargin} ${inst.trading_ccy}` : 'Not supplied']);
    if (t.root) rows.push(['Contract root', t.root]);
    return rows;
  },
  qtyStep: () => 1,
  settleDate: (app, inst, tradeDate) => tradeDate,
  economics(app, { inst, action, qty, price, unit, strategyId }) {
    const notional = qty * price * inst.multiplier;
    const pos = unit ? app.positions.find(unit.id, inst.id, strategyId) : null;
    const dq = dqOf(action, qty);
    const newQty = (pos?.qty || 0) + dq;
    const im = inst.terms.initialMargin;
    const marginDelta = im === null || im === undefined ? null : (Math.abs(newQty) - Math.abs(pos?.qty || 0)) * im;
    const notes = ['Futures post initial margin and settle variation daily; the notional is not paid.'];
    if (im === null || im === undefined) notes.push('No initial margin figure has been supplied for this contract, so none is posted.');
    return { ccy: inst.trading_ccy, principal: 0, cash: -(Math.max(marginDelta || 0, 0)), accrued: 0, notional, exposure: sign(dq) * notional, initialMargin: marginDelta, notes };
  },
  fill(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const ccy = inst.trading_ccy;
    const dq = dqOf(c.action, c.qty);
    let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: inst.id, strategyId: c.strategyId });
    const oldQty = pos.qty;
    const mark = pos.data.mark ?? c.price;
    let realized = 0;
    let newMark = mark;
    if (isZero(oldQty) || sign(oldQty) === sign(dq)) {
      newMark = (Math.abs(oldQty) * mark + Math.abs(dq) * c.price) / (Math.abs(oldQty) + Math.abs(dq));
    } else {
      const closing = Math.min(Math.abs(dq), Math.abs(oldQty));
      realized = money(closing * (c.price - mark) * inst.multiplier * sign(oldQty), ccy);
      if (Math.abs(dq) > Math.abs(oldQty) + 1e-9) newMark = c.price; // flipped: the remainder opens at the trade price
    }
    const newQty = qty8(oldQty + dq);
    const fees = postFees(c, ccy);
    const im = inst.terms.initialMargin || 0;
    const marginHeld = ledger.positionBalance(pos.id, 'cash.margin', ccy);
    const marginDelta = money(Math.abs(newQty) * im - marginHeld, ccy);
    const entries = [
      { account: 'pnl.realized', ccy, amount: -realized, positionId: pos.id },
      { account: 'pnl.commission', ccy, amount: fees.commission, positionId: pos.id },
      { account: 'pnl.fee', ccy, amount: fees.other, positionId: pos.id },
      { account: 'cash.margin', ccy, amount: marginDelta, positionId: pos.id },
      { account: 'cash', ccy, amount: money(realized - fees.total - marginDelta, ccy), positionId: pos.id },
    ];
    const notional = money(c.qty * c.price * inst.multiplier, ccy);
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: c.eventType || 'trade.fill', instrumentId: inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: pos.id,
      actor: c.actor || (c.order ? 'user' : 'engine'),
      summary: c.summary || `${c.action === 'buy' ? 'Bought' : 'Sold'} ${fmtQty(c.qty)} ${inst.symbol || inst.name} @ ${fmtPx(c.price)} (notional ${fmt(notional, ccy)}; margin ${marginDelta >= 0 ? 'posted' : 'released'} ${fmt(Math.abs(marginDelta), ccy)}${realized ? `; realized ${fmt(realized, ccy)}` : ''})`,
      data: { action: c.action, qty: c.qty, price: c.price, notional, realized, marginDelta, commission: fees.commission, fees: fees.other, fillId: c.fillId || null, ...(c.data || {}) },
      entries,
    });
    pos = positions.change(pos, { dQty: dq, data: { mark: isZero(newQty) ? null : newMark, lastSettleDate: pos.data.lastSettleDate ?? null } });
    return { eventId, position: pos, realized, cashNet: money(realized - fees.total - marginDelta, ccy), gross: 0 };
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const m = pos.data.mark;
    const known = mark !== null && mark !== undefined && m !== null && m !== undefined;
    const ote = known ? money((mark - m) * inst.multiplier * pos.qty, ccy) : null;
    return {
      price: mark ?? null,
      mv: ote, // open trade equity since the last variation settlement
      cost: 0,
      unrealized: ote,
      accrued: 0,
      notional: mark !== null && mark !== undefined ? money(Math.abs(pos.qty) * mark * inst.multiplier, ccy) : null,
      exposure: mark !== null && mark !== undefined ? money(pos.qty * mark * inst.multiplier, ccy) : null,
      marginPosted: app.ledger.positionBalance(pos.id, 'cash.margin', ccy),
      referencePrice: m ?? null,
    };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    if (inst.terms.expiration) app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'future.expiry', dueDate: inst.terms.expiration });
  },
  dataNeeds(app, { inst, date, task }) {
    if (task?.type === 'future.expiry') return { closes: [{ instrument: inst, date: inst.terms.expiration }] };
    return date ? { closes: [{ instrument: inst, date }] } : {};
  },
  /** Daily variation margin against the settlement price for `date`. Skipped (not guessed) when no price exists. */
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty) || pos.data.lastSettleDate >= date) return;
    const obs = app.data.closeFor(inst.id, date);
    if (!obs || obs.value === null) return;
    variation(app, { book, unit, inst, pos, price: obs.value, obs, date });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (task.type !== 'future.expiry') return { failed: `Unknown task ${task.type}` };
    if (!pos || isZero(pos.qty)) return 'done';
    const obs = app.data.closeFor(inst.id, inst.terms.expiration);
    if (!obs || obs.value === null) {
      return { blocked: `Awaiting the final settlement price for ${inst.symbol || inst.name} (${inst.terms.expiration}). ${app.data.describe().awaitingMessage}, or enter it manually.`, needs: [{ kind: 'price', subject: inst.id, date: inst.terms.expiration }] };
    }
    const fresh = app.positions.get(pos.id);
    const r = future.fill(app, {
      book, unit, inst, action: fresh.qty > 0 ? 'sell' : 'buy', qty: Math.abs(fresh.qty), price: obs.value, fees: [], strategyId: fresh.strategy_id, tradeDate: inst.terms.expiration,
      eventType: 'future.final_settlement', actor: 'engine',
      summary: `Final settlement: ${fmtQty(Math.abs(fresh.qty))} ${inst.symbol || inst.name} closed in cash at ${fmtPx(obs.value)}${inst.terms.settlement === 'physical' ? ' (physical delivery is not simulated)' : ''}`,
      data: { priceObsId: app.data.recordUsed(obs) },
    });
    return { done: true, eventId: r.eventId };
  },
};

function variation(app, { book, unit, inst, pos, price, obs, date }) {
  const ccy = inst.trading_ccy;
  const mark = pos.data.mark;
  const vm = money((price - mark) * inst.multiplier * pos.qty, ccy);
  if (vm !== 0) {
    app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'future.variation', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine', businessDate: date,
      summary: `Variation margin ${vm >= 0 ? 'received' : 'paid'} on ${fmtQty(pos.qty)} ${inst.symbol || inst.name}: ${fmt(Math.abs(vm), ccy)} (settlement ${fmtPx(price)} vs ${fmtPx(mark)})`,
      data: { settlementPrice: price, previousMark: mark, priceObsId: app.data.recordUsed(obs), date },
      entries: [
        { account: 'cash', ccy, amount: vm, positionId: pos.id },
        { account: 'pnl.realized', ccy, amount: -vm, positionId: pos.id },
      ],
    });
    const cash = app.ledger.balance(unit.id, 'cash', ccy);
    if (cash < 0) {
      app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'margin.deficit', refType: 'unit-ccy', refId: `${unit.id}|${ccy}`, message: `${unit.name} has a ${ccy} cash deficit of ${fmt(-cash, ccy)} after variation margin. Fund it from Treasury, convert currency or arrange borrowing.` });
    }
  }
  app.positions.change(pos, { data: { mark: price, lastSettleDate: date } });
}
