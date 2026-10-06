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
import { addBusinessDays, fxValueDate } from '../quant/calendar.js';
import { yearFraction } from '../quant/daycount.js';
import { CCY_RE, ISO_DATE_RE, isZero, money, num, qty8, sign } from '../core/util.js';
import { dqOf, fmtPx, fmtQty } from './common.js';
import { calendarFor } from './security.js';

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
  calendar: (inst) => fxValueDate('2000-01-03', inst.terms.base, inst.terms.quote, 0).calendar,
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
  settleDate: (app, inst, tradeDate) => fxValueDate(tradeDate, inst.terms.base, inst.terms.quote, inst.terms.settleDays ?? 2).date,
  calendarInfo: (inst) => {
    const v = fxValueDate('2000-01-03', inst.terms.base, inst.terms.quote, 0);
    return { id: v.calendar, label: `Payment calendars of ${inst.terms.base} and ${inst.terms.quote}`, basis: 'currency', fallback: v.missing.length > 0, approximate: v.missing.length > 0,
      note: v.missing.length ? `No payment calendar is built in for ${v.missing.join(' and ')}: weekends only are used for ${v.missing.length > 1 ? 'them' : 'it'}, so local holidays are not recognised.` : null };
  },
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
    return 'forward price';
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
    if (t.forwardType === 'asset') {
      t.settlement = ['cash', 'physical'].includes(t.settlement) ? t.settlement : 'cash';
      if (!draft.underlying_id) errors.push('An asset forward needs its underlying instrument.');
    }
    if (!ISO_DATE_RE.test(t.valueDate || '')) errors.push('Value (maturity) date is required.');
    const multiplier = num(draft.multiplier) > 0 ? num(draft.multiplier) : 1;
    return { terms: t, multiplier, errors, tradingCcy, settleCcy };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Type', { fx: 'Deliverable FX forward', ndf: 'Non-deliverable forward', asset: 'Asset forward', fra: 'Forward-rate agreement' }[t.forwardType]], ['Value date', t.valueDate]];
    if (t.base) rows.push(['Currency pair', `${t.base}/${t.quote}`]);
    if (t.forwardType === 'ndf') rows.push(['Fixing date', t.fixingDate], ['Settlement currency', t.settleCcy]);
    if (t.forwardType === 'fra') rows.push(['Interest period', `${t.periodStart} to ${t.periodEnd}`], ['Reference rate', t.fixingRate], ['Day count', t.dayCount]);
    if (t.forwardType === 'asset') rows.push(['Settlement', t.settlement]);
    if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
    if (t.collateral) rows.push(['Collateral terms', t.collateral]);
    return rows;
  },
  qtyStep: () => 0.01,
  settleDate: (app, inst) => inst.terms.valueDate,
  economics(app, { inst, action, qty, price }) {
    const t = inst.terms;
    const notional = t.forwardType === 'fra' ? qty : qty * price * inst.multiplier;
    const notes = ['No cash changes hands at trade. Settlement happens on the value date.'];
    if (t.forwardType === 'fx') notes.push(`On ${t.valueDate} the unit ${action === 'buy' ? 'receives' : 'pays'} ${fmt(qty, t.base)} and ${action === 'buy' ? 'pays' : 'receives'} ${fmt(qty * price, t.quote)}.`);
    return { ccy: inst.trading_ccy, principal: 0, cash: 0, accrued: 0, notional, exposure: (action === 'buy' ? 1 : -1) * notional, initialMargin: 0, notes };
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
  runTask(app, task, { book, unit, inst, pos }) {
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
      const und = app.instruments.get(inst.underlying_id);
      const plugin = app.products.get(und.family);
      const units = Math.abs(q) * inst.multiplier;
      const undPos = positions.find(unit.id, und.id, pos.strategy_id);
      const action = q > 0 ? (undPos && undPos.qty < 0 ? 'buy_to_cover' : 'buy') : 'sell';
      const d = plugin.fill(app, {
        book, unit, inst: und, action, qty: units, price: k, fees: [], strategyId: pos.strategy_id, tradeDate: t.valueDate, settleDate: plugin.settleDate(app, und, t.valueDate, book), actor: 'engine',
        eventType: 'forward.delivery', summary: `Forward delivery: ${q > 0 ? 'received' : 'delivered'} ${fmtQty(units)} ${und.symbol || und.name} at ${fmtPx(k)}`, data: { fromForward: inst.id },
      });
      positions.change(pos, { dQty: -q, data: { avgStrike: null } });
      const undNow = positions.find(unit.id, und.id, pos.strategy_id);
      if (undNow && plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst: und, pos: undNow });
      return { done: true, eventId: d.eventId };
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
  },
};
