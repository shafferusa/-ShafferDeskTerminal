// Shared booking helpers for product-family plugins.

import { fmt } from '../core/books.js';
import { money, qty8 } from '../core/util.js';

export const BUY_ACTIONS = new Set(['buy', 'buy_to_cover']);
export const dqOf = (action, qty) => (BUY_ACTIONS.has(action) ? qty : -qty);

export const ACTION_LABEL = {
  buy: 'Bought', sell: 'Sold', sell_short: 'Sold short', buy_to_cover: 'Bought to cover',
};

export const fmtQty = (q) => Number(q).toLocaleString('en-US', { maximumFractionDigits: 8 });
export const fmtPx = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * Book a trade in a security-like instrument (average cost, cash settles on the settlement date).
 *
 * c: { book, unit, inst, action, qty, price, fees[], strategyId, tradeDate, settleDate, order?, fillId?,
 *      summary?, eventType?, data?, actor? }
 * o: { unitCost            cost per 1 unit of quantity in trading currency (price x multiplier)
 *      accrued = 0         accrued interest bought (+) on a buy / sold on a sell, as a positive number
 *      receiveAccounts     cash buckets that receive sale proceeds (default ['cash'])
 *      payAccounts         cash buckets a purchase is paid from, in order (default ['cash'])
 *      settle = true       false books cash immediately with no settlement row (used when price is 0) }
 * Returns { eventId, position, realized, cashNet, gross }.
 */
export function bookSecurityFill(app, c, o) {
  const { ledger, positions, settle } = app;
  const ccy = c.inst.trading_ccy;
  const dq = dqOf(c.action, c.qty);
  let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: c.inst.id, strategyId: c.strategyId });
  const wasFlat = Math.abs(pos.qty) < 1e-9;
  const m = positions.tradeMath(pos, dq, o.unitCost, ccy);
  const accrued = money(o.accrued || 0, ccy);
  const accruedSigned = dq > 0 ? accrued : -accrued;
  const commission = money(c.fees?.filter((f) => f.kind === 'commission').reduce((a, f) => a + f.amount, 0) || 0, ccy);
  const otherFees = money(c.fees?.filter((f) => f.kind !== 'commission').reduce((a, f) => a + f.amount, 0) || 0, ccy);
  // Positive cashNet = the unit receives cash at settlement.
  const cashNet = money(-m.gross - accruedSigned - commission - otherFees, ccy);
  const settleAccount = cashNet < 0 ? 'pay.settle' : 'recv.settle';
  const entries = [
    { account: 'pos', ccy, amount: m.costDelta, positionId: pos.id },
    { account: settleAccount, ccy, amount: cashNet, positionId: pos.id },
    { account: 'pnl.realized', ccy, amount: -m.realized, positionId: pos.id },
    { account: 'pnl.commission', ccy, amount: commission, positionId: pos.id },
    { account: 'pnl.fee', ccy, amount: otherFees, positionId: pos.id },
    { account: 'accrued.asset', ccy, amount: accruedSigned, positionId: pos.id },
  ];
  const verb = ACTION_LABEL[c.action] || c.action;
  const eventId = ledger.post({
    bookId: c.book.id, unitId: c.unit.id, type: c.eventType || 'trade.fill', instrumentId: c.inst.id, strategyId: c.strategyId,
    orderId: c.order?.id, positionId: pos.id, actor: c.actor || (c.order ? 'user' : 'engine'),
    summary: c.summary || `${verb} ${fmtQty(c.qty)} ${c.inst.symbol || c.inst.name} @ ${fmtPx(c.price)} ${ccy}${m.realized ? ` (realized ${fmt(m.realized, ccy)})` : ''}`,
    data: { action: c.action, qty: c.qty, price: c.price, gross: m.gross, accrued, commission, fees: otherFees, realized: m.realized, settleDate: c.settleDate, fillId: c.fillId || null, ...(c.data || {}) },
    entries,
  });
  pos = positions.change(pos, { dQty: dq, dCost: m.costDelta });
  if (cashNet !== 0) {
    settle.create({
      bookId: c.book.id, unitId: c.unit.id, fillId: c.fillId, orderId: c.order?.id, instrumentId: c.inst.id, strategyId: c.strategyId, positionId: pos.id,
      kind: 'trade', dueDate: c.settleDate, ccy, amount: cashNet,
      accounts: cashNet > 0 ? (o.receiveAccounts || ['cash']) : (o.payAccounts || ['cash']),
    });
  }
  return { eventId, position: pos, realized: m.realized, cashNet, gross: m.gross, wasFlat, closedQty: m.closedQty, openedQty: m.openedQty };
}

/** Standard valuation of a security-like position. Returns nulls (not zeros) when the price is missing. */
export function valueSecurity(inst, pos, obs, mark) {
  const price = mark;
  const known = price !== null && price !== undefined;
  const mv = known ? pos.qty * price * inst.multiplier : null;
  return {
    price: known ? price : null,
    mv: known ? money(mv, inst.trading_ccy) : null,
    cost: pos.cost,
    unrealized: known ? money(mv - pos.cost, inst.trading_ccy) : null,
    accrued: 0,
    notional: known ? money(Math.abs(mv), inst.trading_ccy) : null,
    exposure: known ? money(mv, inst.trading_ccy) : null,
  };
}

/** True-up an accrual account for a position to a target balance, booking the difference to P&L. */
export function trueUpAccrual(app, { book, unit, pos, inst, account, pnlAccount, ccy, target, summary, type = 'accrual' }) {
  const current = app.ledger.positionBalance(pos.id, account, ccy);
  const delta = money(target - current, ccy);
  if (delta === 0) return null;
  return app.ledger.post({
    bookId: book.id, unitId: unit.id, type, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
    summary: `${summary}: ${fmt(Math.abs(delta), ccy)}`,
    data: { account, target, previous: current },
    entries: [
      { account, ccy, amount: delta, positionId: pos.id },
      { account: pnlAccount, ccy, amount: -delta, positionId: pos.id },
    ],
  });
}

export const signedQty = (action, qty) => qty8(dqOf(action, qty));
