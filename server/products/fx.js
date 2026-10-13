// Spot FX and forwards.
//
// Spot FX is a conversion between two currency balances of the same unit; it creates no position.
// A cash transfer never converts currency: only an FX trade does.
//
// Forwards (deliverable FX, NDF, asset forwards, FRAs) carry no upfront cash. They hold the dealt
// forward price and settle on the value date: by exchanging the two currency amounts, by cash
// against a fixing, or by delivery of the underlying. A fixing that has not been supplied blocks
// the settlement visibly; it is never guessed.

import { fmt } from '../core/books.js';
import { CURRENCY_CALENDAR, addBusinessDays, fxValueDate, isBusinessDay } from '../quant/calendar.js';
import { yearFraction } from '../quant/daycount.js';
import { AppError, CCY_RE, ISO_DATE_RE, isZero, money, num, qty8, sign } from '../core/util.js';
import { normalizeBasis } from '../core/agreements.js';
import { dqOf, fmtPx, fmtQty } from './common.js';
import { calendarFor, calendarInfo, standardSettleDate } from './security.js';

function feeTotals(c, ccy) {
  const commission = money(c.fees?.filter((f) => f.kind === 'commission').reduce((a, f) => a + f.amount, 0) || 0, ccy);
  const other = money(c.fees?.filter((f) => f.kind !== 'commission').reduce((a, f) => a + f.amount, 0) || 0, ccy);
  return { commission, other, total: money(commission + other, ccy) };
}

export const fx = {
  family: 'fx',
  kind: 'fx',
  shortRule: 'cash',
  label: 'Spot FX',
  qtyLabel: 'Base-currency amount',
  actions: () => ['buy', 'sell'],
  priceUnits: (inst) => `${inst.terms.quote} per ${inst.terms.base}`,
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    t.base = String(t.base || '').toUpperCase();
    t.quote = String(t.quote || '').toUpperCase();
    if (!CCY_RE.test(t.base) || !CCY_RE.test(t.quote)) errors.push('A currency pair needs a base and a quote currency code.');
    if (t.base === t.quote) errors.push('Base and quote currency must differ.');
    t.settleDays = num(t.settleDays) ?? 2;
    return { terms: t, multiplier: 1, errors, tradingCcy: t.quote, settleCcy: t.quote };
  },
  describe: (inst) => [['Base currency', inst.terms.base], ['Quote currency', inst.terms.quote], ['Spot settlement', `T+${inst.terms.settleDays}`]],
  qtyStep: () => 0.01,
  // Spot value date: good days for both currencies; the value date is also a US dollar banking day.
  // A lag or a calendar set on the pair itself (instrument conventions) is applied on top of that rule.
  settleDate: (app, inst, tradeDate, book) => standardSettleDate(inst, tradeDate, book),
  calendarInfo,
  economics(app, { inst, action, qty, price }) {
    const quoteAmt = qty * price;
    const buy = action === 'buy';
    return {
      ccy: inst.terms.quote, principal: quoteAmt, cash: buy ? -quoteAmt : quoteAmt, accrued: 0, notional: quoteAmt, exposure: null, initialMargin: 0,
      otherCash: [{ ccy: inst.terms.base, amount: buy ? qty : -qty }],
      notes: [`Converts ${buy ? inst.terms.quote : inst.terms.base} into ${buy ? inst.terms.base : inst.terms.quote}. Both currency amounts settle on the same date.`],
    };
  },
  fill(app, c) {
    const { ledger, settle } = app;
    const { base, quote } = c.inst.terms;
    const buy = c.action === 'buy';
    const baseAmt = money(c.qty, base);
    const quoteAmt = money(c.qty * c.price, quote);
    const fees = feeTotals(c, quote);
    const baseSigned = buy ? baseAmt : -baseAmt; // + we receive base
    const quoteSigned = money((buy ? -quoteAmt : quoteAmt) - fees.total, quote); // + we receive quote
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: c.eventType || 'fx.conversion', instrumentId: c.inst.id, strategyId: c.strategyId, orderId: c.order?.id,
      actor: c.actor || (c.order ? 'user' : 'engine'),
      summary: c.summary || `FX conversion: ${buy ? 'bought' : 'sold'} ${fmt(baseAmt, base)} against ${fmt(quoteAmt, quote)} at ${fmtPx(c.price)}`,
      data: { action: c.action, qty: c.qty, price: c.price, base, quote, baseAmount: baseAmt, quoteAmount: quoteAmt, commission: fees.commission, fees: fees.other, settleDate: c.settleDate, fillId: c.fillId || null, ...(c.data || {}) },
      entries: [
        { account: baseSigned > 0 ? 'recv.settle' : 'pay.settle', ccy: base, amount: baseSigned },
        { account: 'fx.clearing', ccy: base, amount: -baseSigned },
        { account: quoteSigned > 0 ? 'recv.settle' : 'pay.settle', ccy: quote, amount: quoteSigned },
        { account: 'fx.clearing', ccy: quote, amount: buy ? quoteAmt : -quoteAmt },
        { account: 'pnl.commission', ccy: quote, amount: fees.commission },
        { account: 'pnl.fee', ccy: quote, amount: fees.other },
      ],
    });
    const common = { bookId: c.book.id, unitId: c.unit.id, fillId: c.fillId, orderId: c.order?.id, instrumentId: c.inst.id, strategyId: c.strategyId, kind: 'fx', dueDate: c.settleDate };
    // Receipt first, so the settlement cycle on the value date credits before it debits.
    const legs = [{ ccy: base, amount: baseSigned }, { ccy: quote, amount: quoteSigned }].sort((a, b) => b.amount - a.amount);
    for (const l of legs) settle.create({ ...common, ccy: l.ccy, amount: l.amount });
    return { eventId, position: null, realized: 0, cashNet: quoteSigned, gross: quoteAmt };
  },
  value: () => null,
};

// ------------------------------------------------------------------------------------------

const FORWARD_TYPES = ['fx', 'ndf', 'asset', 'fra'];

/** Value of one unit of quantity per one unit of price difference. */
function unitFactor(inst) {
  const t = inst.terms;
  if (t.forwardType === 'fra') return yearFraction(t.periodStart, t.periodEnd, t.dayCount || 'ACT/360') / 100;
  return inst.multiplier;
}

export const forward = {
  family: 'forward',
  kind: 'forward',
  shortRule: 'write',
  label: 'Forward / FRA',
  qtyLabel: 'Notional',
  actions: () => ['buy', 'sell'],
  priceUnits(inst) {
    const t = inst.terms;
    if (t.forwardType === 'fra') return 'contract rate (% p.a.)';
    if (t.forwardType === 'fx' || t.forwardType === 'ndf') return `forward rate (${t.quote} per ${t.base})`;
    return t.priceUnits ? `forward price (${t.priceUnits})` : 'forward price';
  },
  qtyLabelFor(inst) {
    const t = inst.terms || {};
    if (t.forwardType === 'fx' || t.forwardType === 'ndf') return `Amount in ${t.base}`;
    if (t.forwardType === 'asset' && t.quantityUnit) return t.quantityUnit[0].toUpperCase() + t.quantityUnit.slice(1);
    return 'Notional';
  },
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    if (!FORWARD_TYPES.includes(t.forwardType)) errors.push('Forward type must be fx (deliverable), ndf, asset or fra.');
    let tradingCcy = draft.trading_ccy, settleCcy = draft.settle_ccy;
    if (t.forwardType === 'fx' || t.forwardType === 'ndf') {
      t.base = String(t.base || '').toUpperCase();
      t.quote = String(t.quote || '').toUpperCase();
      if (!CCY_RE.test(t.base) || !CCY_RE.test(t.quote) || t.base === t.quote) errors.push('An FX forward needs two different currency codes.');
      tradingCcy = t.quote;
      if (t.forwardType === 'ndf') {
        t.settleCcy = String(t.settleCcy || t.quote).toUpperCase();
        if (![t.base, t.quote].includes(t.settleCcy)) errors.push('An NDF settles in one of its two currencies.');
        settleCcy = t.settleCcy;
        t.fixingDate = t.fixingDate || t.valueDate;
      } else settleCcy = t.quote;
    }
    if (t.forwardType === 'fra') {
      if (!ISO_DATE_RE.test(t.periodStart || '') || !ISO_DATE_RE.test(t.periodEnd || '') || t.periodEnd <= t.periodStart) errors.push('An FRA needs the start and end of its interest period.');
      if (!t.fixingRate) errors.push('An FRA needs the reference rate code it fixes against.');
      t.valueDate = t.periodStart;
      t.fixingDate = t.fixingDate || t.periodStart;
      t.dayCount = t.dayCount || 'ACT/360';
    }
    // fw: a TBA mortgage contract is a forward on an agency pass-through pool that is not known when it is traded: the
    // seller allocates the pool shortly before settlement, and the allocation is recorded by hand on the position.
    const tba = (draft.productId || draft.product_id) === 'tba_mortgage';
    if (tba) {
      t.tba = true;
      if (t.forwardType !== 'asset') errors.push('A TBA mortgage contract is a forward on an asset: the agency pool allocated before settlement.');
      t.settlement = 'physical';
      t.coupon = num(t.coupon);
      if (!(t.coupon > 0)) errors.push('A TBA mortgage contract needs the pass-through coupon of the pools it can be settled with (decimal, 0.055 = 5.5%).');
    } else delete t.tba;
    if (t.forwardType === 'asset') {
      t.settlement = ['cash', 'physical'].includes(t.settlement) ? t.settlement : 'cash';
      if (!draft.underlying_id && !tba) errors.push('An asset forward needs its underlying instrument.');
    }
    if (!ISO_DATE_RE.test(t.valueDate || '')) errors.push('Value (maturity) date is required.');
    // An FX forward (deliverable or not) is settled on a day both currencies' payment systems are open: the value
    // date must be a business day of the joint calendar of its two currencies, where both calendars are built in.
    else if ((t.forwardType === 'fx' || t.forwardType === 'ndf') && CURRENCY_CALENDAR[t.base] && CURRENCY_CALENDAR[t.quote]) {
      const closed = [t.base, t.quote].filter((c) => !isBusinessDay(t.valueDate, CURRENCY_CALENDAR[c]));
      if (closed.length) errors.push(`The value date ${t.valueDate} is not a business day for ${closed.map((c) => `${c} (${CURRENCY_CALENDAR[c]} calendar)`).join(' or ')}: an FX forward settles on a day that is a business day for both ${t.base} and ${t.quote}.`);
    }
    // Collateral follows the basis stated on the contract; nothing is assumed from the product.
    t.collateralBasis = normalizeBasis(t.collateralBasis, errors);
    if (!t.collateralBasis) delete t.collateralBasis;
    // An asset forward takes its underlying's value per unit of price unless one is stated (0.01 for a bond quoted in % of par).
    const und = t.forwardType === 'asset' && draft.underlying_id ? app.instruments.get(draft.underlying_id) : null;
    const multiplier = num(draft.multiplier) > 0 ? num(draft.multiplier) : und?.multiplier > 0 ? und.multiplier : tba ? 0.01 : 1;
    // The quantity and price of an asset forward are in its underlying's own units (barrels and USD per barrel, face
    // amount and % of par, shares and price per share), so the ticket says so.
    const unitOf = { bond: 'face amount', equity: 'shares', fund: 'units', crypto: 'units' };
    const qUnit = tba ? 'original face' : und ? und.terms?.quantityUnit || unitOf[und.family] || null : null;
    const pUnit = tba ? '% of par' : und ? und.terms?.priceUnits || (und.family === 'bond' ? '% of par' : null) : null;
    if (qUnit) t.quantityUnit = qUnit; else delete t.quantityUnit;
    if (pUnit) t.priceUnits = pUnit; else delete t.priceUnits;
    return { terms: t, multiplier, errors, tradingCcy, settleCcy };
  },
  describe(inst, app) {
    const t = inst.terms;
    const rows = [['Type', { fx: 'Deliverable FX forward', ndf: 'Non-deliverable forward', asset: 'Asset forward', fra: 'Forward-rate agreement' }[t.forwardType]], ['Value date', t.valueDate]];
    if (t.base) rows.push(['Currency pair', `${t.base}/${t.quote}`]);
    if (t.forwardType === 'ndf') rows.push(['Fixing date', t.fixingDate], ['Settlement currency', t.settleCcy]);
    if (t.forwardType === 'fra') rows.push(['Interest period', `${t.periodStart} to ${t.periodEnd}`], ['Reference rate', t.fixingRate], ['Day count', t.dayCount]);
    if (t.forwardType === 'asset') rows.push(['Settlement', t.settlement]);
    if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
    if (app?.agreements) rows.push(...app.agreements.describeRows(inst));
    else if (t.collateral) rows.push(['Collateral terms', t.collateral]);
    return rows;
  },
  qtyStep: () => 0.01,
  settleDate: (app, inst) => inst.terms.valueDate,
  /**
   * Notional on which a percentage independent amount is worked out: the FRA notional, otherwise
   * quantity at the dealt price (the average dealt price once this trade is in).
   */
  collateralNotional(app, inst, { pos, qtyAfter, dq = 0, price = null }) {
    if (inst.terms.forwardType === 'fra') return Math.abs(qtyAfter);
    const before = pos?.qty || 0;
    let k = pos?.data?.avgStrike ?? price;
    if (dq && price !== null && price !== undefined) {
      if (isZero(before) || sign(before) === sign(dq)) k = (Math.abs(before) * (pos?.data?.avgStrike ?? price) + Math.abs(dq) * price) / (Math.abs(before) + Math.abs(dq));
      else if (Math.abs(dq) > Math.abs(before) + 1e-9) k = price;
    }
    return k === null || k === undefined ? null : Math.abs(qtyAfter) * k * inst.multiplier;
  },
  economics(app, { inst, action, qty, price, unit, strategyId, book }) {
    const t = inst.terms;
    const notional = t.forwardType === 'fra' ? qty : qty * price * inst.multiplier;
    const notes = ['No cash changes hands at trade. Settlement happens on the value date.'];
    if (t.forwardType === 'fx') notes.push(`On ${t.valueDate} the unit ${action === 'buy' ? 'receives' : 'pays'} ${fmt(qty, t.base)} and ${action === 'buy' ? 'pays' : 'receives'} ${fmt(qty * price, t.quote)}.`);
    // Collateral under the basis the contract states (an agreement, position-level terms, or none by explicit choice).
    const coll = app.agreements.tradeRequirement({ book, unit, inst, action, qty, price, strategyId });
    return { ccy: inst.trading_ccy, principal: 0, cash: 0, accrued: 0, notional, exposure: (action === 'buy' ? 1 : -1) * notional, initialMargin: coll.initialMargin, collateral: coll, notes: [...notes, ...coll.notes] };
  },
  fill(app, c) {
    const { ledger, positions, settle } = app;
    const inst = c.inst;
    const ccy = inst.trading_ccy;
    const dq = dqOf(c.action, c.qty);
    let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: inst.id, strategyId: c.strategyId });
    const oldQty = pos.qty;
    const avg = pos.data.avgStrike ?? c.price;
    let realized = 0;
    let newAvg = avg;
    if (isZero(oldQty) || sign(oldQty) === sign(dq)) {
      newAvg = (Math.abs(oldQty) * avg + Math.abs(dq) * c.price) / (Math.abs(oldQty) + Math.abs(dq));
    } else {
      const closing = Math.min(Math.abs(dq), Math.abs(oldQty));
      realized = money(closing * (c.price - avg) * unitFactor(inst) * sign(oldQty), ccy);
      if (Math.abs(dq) > Math.abs(oldQty) + 1e-9) newAvg = c.price;
    }
    const fees = feeTotals(c, ccy);
    const net = money(realized - fees.total, ccy);
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: c.eventType || 'trade.fill', instrumentId: inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: pos.id,
      actor: c.actor || (c.order ? 'user' : 'engine'),
      summary: c.summary || `${c.action === 'buy' ? 'Bought' : 'Sold'} forward ${fmtQty(c.qty)} ${inst.symbol || inst.name} @ ${fmtPx(c.price)} for ${inst.terms.valueDate}${realized ? ` (locked-in ${fmt(realized, ccy)}, settles on the value date)` : ''}`,
      data: { action: c.action, qty: c.qty, price: c.price, realized, commission: fees.commission, fees: fees.other, fillId: c.fillId || null, ...(c.data || {}) },
      entries: [
        { account: 'pnl.realized', ccy, amount: -realized, positionId: pos.id },
        { account: 'pnl.commission', ccy, amount: fees.commission, positionId: pos.id },
        { account: 'pnl.fee', ccy, amount: fees.other, positionId: pos.id },
        { account: net >= 0 ? 'recv.settle' : 'pay.settle', ccy, amount: net, positionId: pos.id },
      ],
    });
    const newQty = qty8(oldQty + dq);
    pos = positions.change(pos, { dQty: dq, data: { avgStrike: isZero(newQty) ? null : newAvg } });
    if (net !== 0) {
      const due = inst.terms.valueDate > c.tradeDate ? inst.terms.valueDate : c.tradeDate;
      settle.create({ bookId: c.book.id, unitId: c.unit.id, fillId: c.fillId, orderId: c.order?.id, instrumentId: inst.id, strategyId: c.strategyId, positionId: pos.id, kind: 'forward', dueDate: due, ccy, amount: net });
    }
    return { eventId, position: pos, realized, cashNet: net, gross: 0 };
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const k = pos.data.avgStrike;
    const known = mark !== null && mark !== undefined && k !== null && k !== undefined;
    const v = known ? money(pos.qty * (mark - k) * unitFactor(inst), ccy) : null;
    const t = inst.terms;
    return {
      price: mark ?? null, mv: v, cost: 0, unrealized: v, accrued: 0,
      notional: t.forwardType === 'fra' ? Math.abs(pos.qty) : k !== null && k !== undefined ? money(Math.abs(pos.qty) * k * inst.multiplier, ccy) : null,
      exposure: null, referencePrice: k ?? null,
      valuationNote: 'Undiscounted difference between the current forward price and the dealt price.',
    };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    app.agreements.onPositionChange({ book, unit, inst, pos });
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    const due = inst.terms.forwardType === 'ndf' ? inst.terms.fixingDate : inst.terms.valueDate;
    app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'forward.maturity', dueDate: due });
  },
  dataNeeds(app, { inst, task }) {
    if (task?.type !== 'forward.maturity') return {};
    const t = inst.terms;
    if (t.forwardType === 'fra') return { rateCodes: [t.fixingRate], rateFrom: addBusinessDays(t.fixingDate, -10, 'ALLDAYS') };
    if ((t.forwardType === 'ndf' || t.forwardType === 'asset') && inst.underlying_id) {
      const und = app.instruments.get(inst.underlying_id);
      if (und) return { closes: [{ instrument: und, date: t.fixingDate || t.valueDate }] };
    }
    return {};
  },
  /**
   * Early termination at a stated amount (lifecycle action `terminate`): the amount agreed with the counterparty
   * (positive received, negative paid) for all or part of the notional, settled on a stated date (default: two
   * business days on the contract's settlement calendar). The amount is realized P&L; the terminated notional leaves
   * the position, its collateral is trued up or released, and nothing is settled for it on the value date.
   */
  terminate(app, { book, unit, inst, pos, amount, qty, settleDate }) {
    const sym = inst.symbol || inst.name;
    // In the currency the contract settles in: a non-deliverable forward's settlement currency, otherwise its own.
    const ccy = inst.terms.forwardType === 'ndf' ? inst.terms.settleCcy : inst.trading_ccy;
    if (!pos || isZero(pos.qty)) throw new AppError(`This ${sym} position is closed: there is nothing to terminate.`, { code: 'termination_position_closed' });
    const a = num(amount);
    if (a === null) throw new AppError('Enter the termination amount agreed with the counterparty (positive if received, negative if paid, 0 for none).', { code: 'termination_amount' });
    const held = Math.abs(pos.qty);
    const n = qty === undefined || qty === null || qty === '' ? held : num(qty);
    if (!(n > 0)) throw new AppError('Enter the notional to terminate as a positive amount.', { code: 'termination_qty' });
    if (n > held + 1e-9) throw new AppError(`Termination of ${fmtQty(n)} was requested, but this ${sym} position holds only ${fmtQty(held)}.`, { code: 'termination_more_than_held' });
    const today = app.clock.today();
    const due = settleDate || addBusinessDays(today, 2, calendarFor(inst));
    if (!ISO_DATE_RE.test(due) || due < today) throw new AppError('The settlement date of a termination is a date from today on.', { code: 'termination_settle_date' });
    const value = money(a, ccy);
    const eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'forward.termination', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
      summary: `Terminated early: ${fmtQty(n)} of ${sym} (dealt ${fmtPx(pos.data.avgStrike)}) at a stated amount, ${value >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(value), ccy)} on ${due}${n < held - 1e-9 ? `; ${fmtQty(held - n)} remains` : ''}`,
      data: { qty: n, amount: value, settleDate: due, dealt: pos.data.avgStrike },
      entries: [
        { account: value >= 0 ? 'recv.settle' : 'pay.settle', ccy, amount: value, positionId: pos.id },
        { account: 'pnl.realized', ccy, amount: -value, positionId: pos.id },
      ],
    });
    if (value !== 0) app.settle.create({ bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, kind: 'forward', dueDate: due, ccy, amount: value });
    const dq = -sign(pos.qty) * n;
    const left = qty8(pos.qty + dq);
    const fresh = app.positions.change(pos, { dQty: dq, data: { avgStrike: isZero(left) ? null : pos.data.avgStrike } });
    app.agreements.onPositionChange({ book, unit, inst, pos: fresh });
    return { eventId, amount: value, qty: n, settleDate: due };
  },
  /**
   * Pool allocation recorded by hand on a TBA position (lifecycle action `allocate`): the agency pool the seller
   * notified, checked for good delivery against the contract (an agency pass-through with the contract's coupon),
   * delivered on the settlement date in place of the generic TBA terms. It can be changed until settlement.
   */
  allocate(app, { book, unit, inst, pos, instrumentId }) {
    const sym = inst.symbol || inst.name;
    if (!inst.terms.tba) throw new AppError('A pool allocation applies to TBA mortgage contracts.', { code: 'allocation_not_tba' });
    if (!pos || isZero(pos.qty)) throw new AppError(`This ${sym} position is closed: there is nothing to allocate.`, { code: 'allocation_position_closed' });
    const pool = instrumentId ? app.instruments.get(instrumentId) : null;
    if (!pool) throw new AppError('Choose the allocated pool: a registered agency pass-through.', { code: 'allocation_pool' });
    const POOLS = ['agency_mbs', 'specified_pool', 'mbs', 'rmbs'];
    if (!POOLS.includes(pool.product_id)) throw new AppError(`${pool.symbol || pool.name} is not an agency pass-through pool, so it is not good delivery for ${sym}.`, { code: 'allocation_not_pool' });
    if (Math.abs((pool.terms.couponRate ?? -1) - inst.terms.coupon) > 1e-9) throw new AppError(`${pool.symbol || pool.name} pays ${(pool.terms.couponRate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%; ${sym} is settled with ${(inst.terms.coupon * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}% pools.`, { code: 'allocation_coupon' });
    if (app.clock.today() > inst.terms.valueDate) throw new AppError(`The settlement date of ${sym} (${inst.terms.valueDate}) has passed.`, { code: 'allocation_late' });
    const factor = pool.terms.factor ?? 1;
    const face = Math.abs(pos.qty) * inst.multiplier / (pool.multiplier || 1);
    const eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'forward.allocation', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
      summary: `Pool allocated by hand on ${sym}: ${pool.symbol || pool.name}, ${fmtQty(face)} original face at factor ${factor} (${fmt(money(face * factor, inst.trading_ccy), inst.trading_ccy)} current face), to be delivered on ${inst.terms.valueDate}`,
      data: { poolId: pool.id, originalFace: face, factor },
    });
    app.positions.setData(pos, { allocatedPoolId: pool.id });
    return { eventId, poolId: pool.id };
  },
  runTask(app, task, ctx) {
    const r = settleForwardTask(app, task, ctx);
    // The forward ended: whatever collateral it carried is released.
    if (r && r.done && ctx.pos) app.agreements.onPositionChange({ pos: ctx.pos });
    return r;
  },
};

function settleForwardTask(app, task, { book, unit, inst, pos }) {
  {
    if (task.type !== 'forward.maturity') return { failed: `Unknown task ${task.type}` };
    if (!pos || isZero(pos.qty)) return 'done';
    const { ledger, positions } = app;
    const t = inst.terms;
    const k = pos.data.avgStrike;
    const q = pos.qty;
    const base = { bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine' };
    const awaiting = app.data.describe().awaitingMessage;

    if (t.forwardType === 'fx') {
      // Exchange the two currency amounts. The paying side must hold the cash.
      const baseAmt = money(Math.abs(q), t.base), quoteAmt = money(Math.abs(q) * k, t.quote);
      const payCcy = q > 0 ? t.quote : t.base, payAmt = q > 0 ? quoteAmt : baseAmt;
      const have = ledger.balance(unit.id, 'cash', payCcy);
      if (have < payAmt - 0.004) {
        app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'forward.unfunded', refType: 'position', refId: pos.id, message: `FX forward ${inst.symbol || inst.name} is due: ${fmt(payAmt, payCcy)} must be delivered but only ${fmt(Math.max(have, 0), payCcy)} of settled ${payCcy} is held.` });
        return { failed: `Delivery failed: ${fmt(payAmt, payCcy)} due, ${fmt(Math.max(have, 0), payCcy)} of settled ${payCcy} available.` };
      }
      const s = q > 0 ? 1 : -1;
      const eventId = ledger.post({
        ...base, type: 'forward.settlement',
        summary: `FX forward settled: ${q > 0 ? 'received' : 'delivered'} ${fmt(baseAmt, t.base)} against ${fmt(quoteAmt, t.quote)} at ${fmtPx(k)}`,
        data: { rate: k, baseAmount: baseAmt, quoteAmount: quoteAmt },
        entries: [
          { account: 'cash', ccy: t.base, amount: s * baseAmt }, { account: 'fx.clearing', ccy: t.base, amount: -s * baseAmt },
          { account: 'cash', ccy: t.quote, amount: -s * quoteAmt }, { account: 'fx.clearing', ccy: t.quote, amount: s * quoteAmt },
        ],
      });
      positions.change(pos, { dQty: -q, data: { avgStrike: null } });
      app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'forward.unfunded' });
      return { done: true, eventId };
    }

    if (t.forwardType === 'fra') {
      const o = app.data.rate(t.fixingRate, t.fixingDate);
      if (!o || (o.forDate || '').slice(0, 10) !== t.fixingDate) {
        return { blocked: `Awaiting the ${t.fixingDate} fixing of ${t.fixingRate}. ${awaiting}, or enter the fixing manually.`, needs: [{ kind: 'rate', subject: t.fixingRate, date: t.fixingDate }] };
      }
      const dcf = yearFraction(t.periodStart, t.periodEnd, t.dayCount);
      const L = o.value;
      const amount = money((q * ((L - k) / 100) * dcf) / (1 + (L / 100) * dcf), inst.trading_ccy);
      const eventId = ledger.post({
        ...base, type: 'forward.settlement',
        summary: `FRA settled against ${t.fixingRate} fixing ${L}% (contract ${k}%): ${amount >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(amount), inst.trading_ccy)}`,
        data: { fixing: L, contractRate: k, dcf, fixingObsId: app.data.recordUsed(o) },
        entries: [{ account: 'cash', ccy: inst.trading_ccy, amount }, { account: 'pnl.realized', ccy: inst.trading_ccy, amount: -amount }],
      });
      positions.change(pos, { dQty: -q, data: { avgStrike: null } });
      return { done: true, eventId };
    }

    if (t.forwardType === 'asset' && t.settlement === 'physical') {
      // A TBA contract delivers the pool allocated to it by hand; until one is recorded it waits, visibly.
      const und = pos.data.allocatedPoolId ? app.instruments.get(pos.data.allocatedPoolId) : inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
      if (!und) return { blocked: `Awaiting the pool allocation of ${inst.symbol || inst.name}: record the pool the seller allocated on the position (Lifecycle, Pool allocation); it is then delivered (simulated) at ${fmtPx(k)}.`, needs: [] };
      const plugin = app.products.get(und.family);
      // Units of the underlying delivered: quantity x the forward's value per unit of price, over the underlying's own
      // (a bond forward on 1,000,000 face with multiplier 0.01 delivers 1,000,000 face of a bond whose multiplier is 0.01).
      const units = qty8(Math.abs(q) * inst.multiplier / (und.multiplier || 1));
      // Delivery against payment on the forward's value date itself (the date the contract settles), not a further
      // settlement lag of the underlying counted from it; later only if the delivery is made late.
      const today = app.clock.today();
      const settleDate = t.valueDate > today ? t.valueDate : today;
      const label = (n) => `Simulated forward delivery (paper entry, no goods or securities move): ${q > 0 ? 'received' : 'delivered'} ${fmtQty(n)} ${und.symbol || und.name} at ${fmtPx(k)} on ${inst.symbol || inst.name}`;
      const base = { book, unit, inst: und, price: k, fees: [], tradeDate: t.valueDate, settleDate, actor: 'engine', eventType: 'forward.delivery', data: { fromForward: inst.id, simulated: true } };
      let firstEvent = null;
      if (q > 0) {
        const undPos = positions.find(unit.id, und.id, pos.strategy_id);
        const d = plugin.fill(app, { ...base, action: undPos && undPos.qty < 0 ? 'buy_to_cover' : 'buy', qty: units, strategyId: pos.strategy_id, summary: label(units) });
        firstEvent = d.eventId;
        const undNow = positions.find(unit.id, und.id, pos.strategy_id);
        if (undNow && plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst: und, pos: undNow });
      } else {
        // fw: the seller delivers what the unit holds (in any of its strategy instances, its own first). Without enough of
        // the underlying the delivery waits, visibly: it never opens an unborrowed short position.
        const sources = positions.list({ unitIds: [unit.id] }).filter((p) => p.instrument_id === und.id && p.qty > 1e-9)
          .sort((a, b) => (a.strategy_id === pos.strategy_id ? -1 : b.strategy_id === pos.strategy_id ? 1 : 0));
        const have = qty8(sources.reduce((a, p) => a + p.qty, 0));
        if (have < units - 1e-9) {
          return { blocked: `Delivery due on ${inst.symbol || inst.name}: ${fmtQty(units)} ${und.symbol || und.name} must be delivered at ${fmtPx(k)}, but ${unit.name} holds ${fmtQty(have)}. Buy or borrow the rest; the delivery is made once it is held.`, needs: [] };
        }
        let left = units;
        for (const src of sources) {
          if (left <= 1e-9) break;
          const n = Math.min(src.qty, left);
          const d = plugin.fill(app, { ...base, action: 'sell', qty: n, strategyId: src.strategy_id, summary: label(n) });
          firstEvent ||= d.eventId;
          left = qty8(left - n);
          const now = positions.get(src.id);
          if (plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst: und, pos: now });
        }
      }
      positions.change(pos, { dQty: -q, data: { avgStrike: null } });
      return { done: true, eventId: firstEvent };
    }

    // Cash settlement against a fixing (NDF, cash-settled asset forward).
    const fixDate = t.fixingDate || t.valueDate;
    let fixing = inst.underlying_id ? app.data.closeFor(inst.underlying_id, fixDate) : null;
    if (!fixing && t.base) fixing = app.data.latestManual('fx', `${t.base}/${t.quote}`, { forDate: fixDate });
    if (!fixing || fixing.value === null) {
      const subject = inst.underlying_id || `${t.base}/${t.quote}`;
      return { blocked: `Awaiting the ${fixDate} fixing for ${inst.symbol || inst.name}. ${awaiting}, or enter the fixing manually.`, needs: [{ kind: inst.underlying_id ? 'price' : 'fx', subject, date: fixDate }] };
    }
    const F = fixing.value;
    let ccy = inst.trading_ccy;
    let amount = q * (F - k) * inst.multiplier;
    if (t.forwardType === 'ndf' && t.settleCcy === t.base) { ccy = t.base; amount /= F; }
    amount = money(amount, ccy);
    const due = t.valueDate > fixDate ? t.valueDate : fixDate;
    const eventId = ledger.post({
      ...base, type: 'forward.settlement',
      summary: `${t.forwardType === 'ndf' ? 'NDF' : 'Forward'} fixed at ${fmtPx(F)} against ${fmtPx(k)}: ${amount >= 0 ? 'receivable' : 'payable'} ${fmt(Math.abs(amount), ccy)} on ${due}`,
      data: { fixing: F, dealt: k, fixingObsId: app.data.recordUsed(fixing) },
      entries: [{ account: amount >= 0 ? 'recv.settle' : 'pay.settle', ccy, amount }, { account: 'pnl.realized', ccy, amount: -amount }],
    });
    if (amount !== 0) app.settle.create({ bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, kind: 'forward', dueDate: due, ccy, amount });
    positions.change(pos, { dQty: -q, data: { avgStrike: null } });
    return { done: true, eventId };
  }
}
