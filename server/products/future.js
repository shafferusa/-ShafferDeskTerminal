// Futures.
//
// A future is not bought for its notional. Opening a position posts initial margin; profit and
// loss is paid or received in cash as variation margin each day against the settlement price.
// Market value shown for a future is its open trade equity since the last settlement, and the
// contract notional is reported separately.
//
// Final settlement closes the position at the final settlement price. A physically delivered
// contract whose deliverable is configured (its Underlying is the deliverable asset, with the units a
// contract delivers) is then delivered on paper: the long receives the goods into a position at the
// invoice amount (final settlement price x multiplier x contracts) and owes that invoice on the
// deliverable's own settlement date; the short gives up goods it holds and is owed the invoice. The
// entries are labelled simulated: no goods move. A cash-settled contract, a bond future (whose
// deliverable basket, conversion factors and accrued interest are not modelled) and a physical contract
// without a configured deliverable are closed in cash, and a delivery request on them is refused with
// that reason. During the delivery window the short may give notice early (`deliver`).

import { fmt } from '../core/books.js';
import { AppError, ISO_DATE_RE, isZero, money, num, qty8, sign } from '../core/util.js';
import { isBusinessDay } from '../quant/calendar.js';
import { dqOf, fmtPx, fmtQty } from './common.js';
import { calendarFor, tradingCalendarFor } from './security.js';

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
    // Delivery terms of a physically delivered contract: units of the deliverable per contract, grade,
    // delivery location, and the first day a delivery notice is accepted (the delivery window opens).
    if (t.delivery && typeof t.delivery === 'object' && t.settlement === 'physical' && !t.perpetual) {
      const d = {};
      const units = num(t.delivery.units);
      if (units !== null) { if (!(units > 0)) errors.push('Deliverable units per contract must be positive.'); d.units = units; }
      for (const k of ['grade', 'location']) { const v = String(t.delivery[k] ?? '').trim(); if (v) d[k] = v; }
      if (t.delivery.firstNotice) {
        if (!ISO_DATE_RE.test(t.delivery.firstNotice)) errors.push('First notice day must be a date.');
        else if (t.expiration && t.delivery.firstNotice > t.expiration) errors.push('The first notice day cannot be after the last trading day.');
        d.firstNotice = t.delivery.firstNotice;
      }
      if (Object.keys(d).length) t.delivery = d; else delete t.delivery;
    } else delete t.delivery;
    return { terms: t, multiplier: multiplier > 0 ? multiplier : 1, errors };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Contract multiplier', inst.multiplier], ['Expiration', t.perpetual ? 'Perpetual' : t.expiration], ['Settlement', t.perpetual || t.settlement !== 'physical' ? 'Cash' : inst.underlying_id && !BOND_FUTURES.includes(inst.product_id) ? 'Physical delivery (simulated on paper at final settlement)' : 'Physical (closed out in cash by the Terminal: delivery is not simulated)']];
    if (t.delivery) {
      if (t.delivery.units) rows.push(['Deliverable units per contract', t.delivery.units]);
      if (t.delivery.grade) rows.push(['Deliverable grade', t.delivery.grade]);
      if (t.delivery.location) rows.push(['Delivery location', t.delivery.location]);
      if (t.delivery.firstNotice) rows.push(['First notice day', t.delivery.firstNotice]);
    }
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
  /**
   * Daily variation margin against the settlement price for `date`. Skipped (not guessed) when no price exists,
   * and on a day the contract's own market is closed: an exchange publishes no settlement price on its holiday,
   * so nothing is exchanged that day whatever a standing quote says. The next trading day settles against the
   * last settlement price.
   */
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty) || pos.data.lastSettleDate >= date) return;
    if (!isBusinessDay(date, tradingCalendarFor(inst))) return;
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
    const dt = deliveryTerms(app, inst);
    if (dt.simulated) {
      const d = simulateDelivery(app, { book, unit, inst, pos: fresh, contracts: Math.abs(fresh.qty), price: obs.value, obs, date: inst.terms.expiration, mode: 'expiry', dt });
      if (d.shortOf) return { blocked: d.shortOf, needs: [] };
      return { done: true, eventId: d.eventId };
    }
    const r = future.fill(app, {
      book, unit, inst, action: fresh.qty > 0 ? 'sell' : 'buy', qty: Math.abs(fresh.qty), price: obs.value, fees: [], strategyId: fresh.strategy_id, tradeDate: inst.terms.expiration,
      eventType: 'future.final_settlement', actor: 'engine',
      summary: `Final settlement: ${fmtQty(Math.abs(fresh.qty))} ${inst.symbol || inst.name} closed in cash at ${fmtPx(obs.value)}${inst.terms.settlement === 'physical' ? ' (physical delivery is not simulated)' : ''}`,
      data: { priceObsId: app.data.recordUsed(obs) },
    });
    return { done: true, eventId: r.eventId };
  },
  /**
   * A delivery notice given by hand (lifecycle action `deliver`): only the short gives notice, only during the
   * delivery window, for no more contracts than it holds, invoiced at the settlement price of the day. Each
   * request the contract's terms do not allow is refused with its own reason.
   */
  deliver(app, { book, unit, inst, pos, contracts }) {
    const sym = inst.symbol || inst.name;
    if (!pos || isZero(pos.qty)) throw new AppError(`This ${sym} position is closed: it holds no contracts, so there is nothing to deliver.`, { code: 'delivery_position_closed' });
    const dt = deliveryTerms(app, inst);
    if (!dt.simulated) throw new AppError(dt.reason, { code: dt.code });
    const held = Math.abs(pos.qty);
    const n = contracts === undefined || contracts === null || contracts === '' ? held : num(contracts);
    if (!(n > 0) || Math.abs(n - Math.round(n)) > 1e-9) throw new AppError('Enter the number of contracts to deliver as a positive whole number.', { code: 'delivery_contracts' });
    if (n > held + 1e-9) throw new AppError(`Delivery of ${fmtQty(n)} contracts was requested, but this ${sym} position holds only ${fmtQty(held)}.`, { code: 'delivery_more_than_held' });
    const today = app.clock.today();
    if (today < dt.firstNotice) throw new AppError(`The delivery window of ${sym} has not opened: delivery notices are accepted from ${dt.firstNotice} (first notice day) until the last trading day ${inst.terms.expiration}. Today is ${today}.`, { code: 'delivery_before_window' });
    if (today > inst.terms.expiration) throw new AppError(`The last trading day of ${sym} (${inst.terms.expiration}) has passed: its delivery is handled by the contract's expiry item.`, { code: 'delivery_after_window' });
    if (pos.qty > 0) throw new AppError(`Only the short side gives notice of delivery. This long ${sym} position takes delivery when the short delivers, or when it is held at the end of the last trading day (${inst.terms.expiration}), when the Terminal simulates the delivery at the final settlement price.`, { code: 'delivery_wrong_side' });
    const obs = app.data.closeFor(inst.id, today);
    if (!obs || obs.value === null) throw new AppError(`Awaiting the settlement price of ${sym} for ${today}: a delivery notice is invoiced at the settlement price of the day it is given. Give it once that price is published, or enter it by hand.`, { code: 'delivery_awaiting_price' });
    const d = simulateDelivery(app, { book, unit, inst, pos, contracts: n, price: obs.value, obs, date: today, mode: 'notice', dt });
    if (d.shortOf) throw new AppError(d.shortOf, { code: 'delivery_goods_short' });
    return d;
  },
};

const BOND_FUTURES = ['gov_bond_future', 'treasury_future'];
/** Families whose instruments the Terminal holds as positions and can therefore receive or give up on delivery. */
const DELIVERABLE_FAMILIES = ['spot', 'equity', 'fund', 'crypto'];

/** Whether this contract's own terms let the Terminal simulate its delivery, and with what; otherwise the reason it does not. */
export function deliveryTerms(app, inst) {
  const t = inst.terms || {};
  const sym = inst.symbol || inst.name;
  if (t.perpetual || t.settlement !== 'physical') {
    return { simulated: false, code: 'delivery_cash_settled', reason: `${sym} is cash-settled under its contract terms: ${t.perpetual ? 'a perpetual contract has no expiry and is settled in cash through funding and variation margin' : 'it is closed in cash at the final settlement price'}, so there is no delivery to give or take.` };
  }
  if (BOND_FUTURES.includes(inst.product_id)) {
    return { simulated: false, code: 'delivery_bond_future', reason: `Delivery against ${sym} is not simulated. A bond future is delivered with a bond of the short's choosing from the deliverable basket, invoiced at the final settlement price times that bond's conversion factor plus its accrued interest; the Terminal does not model the basket, so it closes the contract in cash at the final settlement price (physical delivery is not simulated). A delivery made outside would be recorded by hand on the bond's own ticket.` };
  }
  const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
  if (!und || !DELIVERABLE_FAMILIES.includes(und.family)) {
    return { simulated: false, code: 'delivery_not_configured', reason: `No deliverable is configured for ${sym}: ${und ? `its Underlying ${und.symbol || und.name} is not an asset the Terminal holds as a position` : 'the contract has no Underlying'}. Physical delivery is not simulated for it; it is closed in cash at the final settlement price. To simulate delivery, register the deliverable and set it as the contract's Underlying.` };
  }
  const d = t.delivery || {};
  return { simulated: true, und, units: d.units ?? inst.multiplier, grade: d.grade || null, location: d.location || null, firstNotice: d.firstNotice || t.expiration };
}

/**
 * Simulated physical delivery of `contracts` at settlement price `price`: the contracts are closed at that price
 * (variation since the last settlement realized, margin released), then the deliverable changes hands at the
 * invoice amount, payable or receivable on the deliverable's own settlement date. A short that does not hold the
 * goods cannot deliver: nothing is booked and the reason is returned as `shortOf`.
 */
function simulateDelivery(app, { book, unit, inst, pos, contracts, price, obs, date, mode, dt }) {
  const sym = inst.symbol || inst.name;
  const ccy = inst.trading_ccy;
  const und = dt.und;
  const undSym = und.symbol || und.name;
  const undPlugin = app.products.get(und.family);
  const long = pos.qty > 0;
  const units = qty8(contracts * dt.units);
  const invoice = money(contracts * inst.multiplier * price, ccy);
  const unitPrice = Math.round((price * inst.multiplier / (dt.units * (und.multiplier || 1))) * 1e8) / 1e8;
  const unitWord = und.terms?.quantityUnit ? ` ${und.terms.quantityUnit}` : '';
  let sources = [];
  if (!long) {
    sources = app.positions.list({ unitIds: [unit.id] }).filter((p) => p.instrument_id === und.id && p.qty > 1e-9)
      .sort((a, b) => (a.strategy_id === pos.strategy_id ? -1 : b.strategy_id === pos.strategy_id ? 1 : 0));
    const have = qty8(sources.reduce((a, p) => a + p.qty, 0));
    if (have < units - 1e-9) return { shortOf: `Delivery due on ${fmtQty(contracts)} short ${sym}: ${fmtQty(units)}${unitWord} of ${undSym} must be delivered, but ${unit.name} holds ${fmtQty(have)}. Buy the deliverable; until then nothing is delivered and the contracts stay open with their margin posted.` };
  }
  const actor = mode === 'notice' ? 'user' : 'engine';
  const where = [dt.grade, dt.location].filter(Boolean).join(', ');
  const r = future.fill(app, {
    book, unit, inst, action: long ? 'sell' : 'buy', qty: contracts, price, fees: [], strategyId: pos.strategy_id, tradeDate: date,
    eventType: mode === 'expiry' ? 'future.final_settlement' : 'future.delivery_notice', actor,
    summary: `${mode === 'expiry' ? 'Final settlement' : 'Delivery notice'}: ${fmtQty(contracts)} ${sym} closed at ${fmtPx(price)} for simulated physical delivery`,
    data: { priceObsId: obs ? app.data.recordUsed(obs) : null, delivery: true, simulated: true },
  });
  const settleDate = undPlugin.settleDate(app, und, date, book);
  const deliveryEvents = [];
  const base = { book, unit, inst: und, price: unitPrice, fees: [], tradeDate: date, settleDate, actor, eventType: 'future.delivery', data: { fromFuture: inst.id, simulated: true, contracts, invoice, settlementPrice: price } };
  if (long) {
    const d = undPlugin.fill(app, { ...base, action: 'buy', qty: units, strategyId: pos.strategy_id,
      summary: `Simulated delivery (paper entry, no goods move): received ${fmtQty(units)}${unitWord} ${undSym} on ${fmtQty(contracts)} ${sym} at ${fmtPx(price)}; invoice ${fmt(invoice, ccy)} payable ${settleDate}${where ? `. ${where}` : ''}` });
    deliveryEvents.push(d.eventId);
  } else {
    let left = units;
    for (const src of sources) {
      if (left <= 1e-9) break;
      const q = Math.min(src.qty, left);
      const d = undPlugin.fill(app, { ...base, action: 'sell', qty: q, strategyId: src.strategy_id,
        summary: `Simulated delivery (paper entry, no goods move): delivered ${fmtQty(q)}${unitWord} ${undSym} on ${fmtQty(contracts)} ${sym} at ${fmtPx(price)}; invoice ${fmt(money(q * unitPrice * (und.multiplier || 1), ccy), ccy)} receivable ${settleDate}${where ? `. ${where}` : ''}` });
      deliveryEvents.push(d.eventId);
      left = qty8(left - q);
      const now = app.positions.get(src.id);
      if (undPlugin.onPositionChange) undPlugin.onPositionChange(app, { book, unit, inst: und, pos: now });
    }
  }
  if (long) {
    const undNow = app.positions.find(unit.id, und.id, pos.strategy_id);
    if (undNow && undPlugin.onPositionChange) undPlugin.onPositionChange(app, { book, unit, inst: und, pos: undNow });
  }
  return { eventId: r.eventId, deliveryEventIds: deliveryEvents, contracts, units, invoice, settleDate, realized: r.realized };
}

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
