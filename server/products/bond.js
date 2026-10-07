// Debt securities: bills, notes, bonds, zeros, floating-rate notes, and factor-based securitised
// paper.
//
// Quantity is face amount; price is the clean price in % of par. A trade pays or receives
// accrued interest on top of the clean price. Accrued income is kept in its own ledger account
// and trued up each day, so "coupon and interest income" is earned over time rather than
// appearing as a jump on the coupon date. Coupons and redemption are paid on the schedule in the
// contract terms. A floating coupon needs its fixing: without one the coupon is blocked visibly.
//
// Interest follows settlement, positions follow the trade date:
//   - the interest bought or sold in a trade runs to that trade's settlement date, so until the trade
//     settles the accrued balance is the interest on the face already settled plus the interest in
//     the unsettled trades (never a day of negative income on the trade date);
//   - a coupon belongs to the face settled before its coupon date: a purchase that settles on or
//     after the coupon date pays no accrued for that coupon and does not receive it, and a sale that
//     settles on or after it keeps the coupon;
//   - the accrued balance only moves forward in time: an end-of-day run for a date before the last
//     coupon paid (catching up after downtime) is skipped rather than re-accruing the old period.

import { fmt } from '../core/books.js';
import { addBusinessDays, adjust } from '../quant/calendar.js';
import { accruedPer100, couponPer100, nextCouponDate } from '../quant/bond.js';
import { DAY_COUNTS } from '../quant/daycount.js';
import { ISO_DATE_RE, isZero, money, need, num } from '../core/util.js';
import { bookSecurityFill, dqOf, fmtPx, fmtQty, trueUpAccrual } from './common.js';
import { calendarFor, paymentCalendarFor, standardSettleDate } from './security.js';

/** Face outstanding per unit of original face (pool factor for securitised paper). */
const factorOf = (inst) => inst.terms.factor ?? 1;

/** The trades booked on a position: signed face, trade date and settlement date of each fill. */
function fillsOf(app, positionId) {
  return app.db.all(`SELECT business_date, data FROM events WHERE position_id = ? AND type = 'trade.fill' ORDER BY id`, positionId)
    .map((r) => { const d = JSON.parse(r.data || '{}'); return { dq: dqOf(d.action, d.qty), tradeDate: r.business_date, settleDate: d.settleDate || r.business_date }; })
    .filter((f) => Number.isFinite(f.dq));
}

/**
 * Accrued interest a position carries at the end of `date`: interest to `date` on the face settled by
 * then, plus the interest bought (or less the interest sold) in each trade that settles later, which
 * runs to that trade's settlement date, plus any coupon that has fallen due and is not paid yet (its
 * payment date is later, or it waits for a fixing). `paying` names a coupon date being paid right now.
 * Returns null when a floating coupon has no fixing.
 */
function accrualTarget(app, inst, pos, date, { paying = null } = {}) {
  const later = fillsOf(app, pos.id).filter((f) => f.settleDate > date);
  let total = bond.accruedAmount(inst, pos.qty - later.reduce((a, f) => a + f.dq, 0), date);
  if (total === null) return null;
  for (const f of later) {
    const ai = bond.accruedAmount(inst, f.dq, f.settleDate);
    if (ai === null) return null;
    total += ai;
  }
  for (const c of unpaidCoupons(app, pos.id)) {
    if (c.couponDate > date || c.couponDate === paying) continue;
    const per100 = couponPer100(schedTerms(inst), c.couponDate);
    if (per100 === null) return null;
    total += (entitledFace(app, pos, c.couponDate) * factorOf(inst) * per100) / 100;
  }
  return total;
}

/** Coupons scheduled for a position and not paid yet: [{ couponDate, dueDate }]. */
function unpaidCoupons(app, positionId) {
  return app.db.all(`SELECT due_date, data FROM tasks WHERE position_id = ? AND type = 'bond.coupon' AND status IN ('pending','blocked','failed') ORDER BY due_date`, positionId)
    .map((r) => ({ dueDate: r.due_date, couponDate: JSON.parse(r.data || '{}').couponDate }))
    .filter((c) => c.couponDate);
}

/** Face entitled to the coupon of `couponDate`: what the position held at the open of that date, less the trades done before it that settle on or after it. */
function entitledFace(app, pos, couponDate) {
  const unsettled = fillsOf(app, pos.id).filter((f) => f.tradeDate < couponDate && f.settleDate >= couponDate);
  return app.positions.qtyAt(pos.id, couponDate, 'open') - unsettled.reduce((a, f) => a + f.dq, 0);
}

/**
 * Move the accrued balance of a position to `target`, the difference going to coupon and interest income. The history
 * line says which way it went: interest earned on a holding, or interest cost on a short (whose accrued coupon is owed).
 */
function trueUp(app, { book, unit, inst, pos, target, disposal = false }) {
  const ccy = inst.trading_ccy;
  const name = inst.symbol || inst.name;
  const cost = money(target, ccy) < app.ledger.positionBalance(pos.id, 'accrued.asset', ccy);
  const summary = disposal ? `${cost ? 'Interest cost' : 'Interest earned'} to disposal of ${name}` : cost ? `Interest cost accrued on ${name}` : `Interest accrued on ${name}`;
  return trueUpAccrual(app, { book, unit, pos, inst, account: 'accrued.asset', pnlAccount: 'pnl.coupon', ccy, target: money(target, ccy), summary, type: 'accrual.coupon' });
}

/** True up the accrued balance as of `date` and remember that it stands at that date. */
function accrueTo(app, { book, unit, inst, pos, date, paying = null }) {
  const target = accrualTarget(app, inst, pos, date, { paying });
  if (target === null) return;
  trueUp(app, { book, unit, inst, pos, target });
  const fresh = app.positions.get(pos.id);
  if (fresh.data.accruedThrough !== date) app.positions.setData(fresh, { accruedThrough: date });
}

export const bond = {
  family: 'bond',
  kind: 'security',
  shortRule: 'borrow',
  label: 'Debt security',
  qtyLabel: 'Face amount',
  actions: () => ['buy', 'sell', 'sell_short', 'buy_to_cover'],
  priceUnits: () => '% of par (clean)',
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    t.couponType = ['fixed', 'zero', 'float'].includes(t.couponType) ? t.couponType : num(t.couponRate) > 0 ? 'fixed' : 'zero';
    if (t.perpetual) delete t.maturity;
    else if (!ISO_DATE_RE.test(t.maturity || '')) errors.push('Maturity date is required (or mark the bond as perpetual).');
    if (t.couponType === 'fixed') {
      t.couponRate = num(t.couponRate);
      if (!(t.couponRate >= 0)) errors.push('Coupon rate is required as a decimal (0.045 = 4.5%).');
      if (t.couponRate > 1) errors.push('Coupon rate looks like a percentage; enter it as a decimal (0.045 = 4.5%).');
    }
    if (t.couponType === 'float') {
      if (!t.referenceRate) errors.push('A floating-rate note needs its reference rate code.');
      t.spread = num(t.spread) ?? 0;
      t.currentCoupon = num(t.currentCoupon);
    }
    if (t.couponType !== 'zero') {
      t.frequency = num(t.frequency) ?? 2;
      if (![1, 2, 4, 12].includes(t.frequency)) errors.push('Coupon frequency must be 1, 2, 4 or 12 payments a year.');
      if (t.perpetual && !ISO_DATE_RE.test(t.anchorDate || '')) errors.push('A perpetual bond needs one coupon date (anchor) to build its schedule.');
    } else t.frequency = 0;
    t.dayCount = DAY_COUNTS.includes(t.dayCount) ? t.dayCount : 'ACT/ACT';
    t.redemption = num(t.redemption) ?? 100;
    t.factor = num(t.factor) ?? 1;
    if (!(t.factor > 0 && t.factor <= 1)) errors.push('Pool factor must be between 0 and 1.');
    if (t.issueDate && !ISO_DATE_RE.test(t.issueDate)) errors.push('Issue date must be YYYY-MM-DD.');
    // Minimum denomination: trades are in multiples of it (the quantity step of the ticket and the preview).
    if (t.minDenomination === undefined || t.minDenomination === null || t.minDenomination === '') delete t.minDenomination;
    else {
      t.minDenomination = num(t.minDenomination);
      if (!(t.minDenomination >= 1) || !Number.isInteger(t.minDenomination)) errors.push('Minimum denomination must be a whole face amount of 1 or more (1,000 for a bond traded in pieces of 1,000).');
    }
    return { terms: t, multiplier: 0.01, errors };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Coupon', t.couponType === 'zero' ? 'Zero coupon / discount' : t.couponType === 'float' ? `${t.referenceRate} + ${(t.spread * 100).toFixed(2)}% (current ${t.currentCoupon !== null && t.currentCoupon !== undefined ? `${(t.currentCoupon * 100).toFixed(3)}%` : 'no fixing'})` : `${(t.couponRate * 100).toFixed(3)}% fixed`]];
    if (t.frequency) rows.push(['Payments per year', t.frequency]);
    rows.push(['Maturity', t.perpetual ? 'Perpetual' : t.maturity], ['Day count', t.dayCount], ['Redemption', `${t.redemption}% of par`]);
    if (t.factor !== 1) rows.push(['Pool factor', t.factor]);
    if (t.minDenomination > 1) rows.push(['Minimum denomination', `${fmtQty(t.minDenomination)} face`]);
    if (t.issueDate) rows.push(['Issue date', t.issueDate]);
    if (t.seniority) rows.push(['Seniority', t.seniority]);
    return rows;
  },
  qtyStep: (inst) => inst.terms?.minDenomination || 1,
  settleDate: (app, inst, tradeDate, book) => standardSettleDate(inst, tradeDate, book),
  /**
   * A debt security trades only for settlement before its maturity date: on that date it is redeemed, and after it
   * there is nothing left to deliver. The preview blocks on this and an order refuses to fill on it. (A trade on the
   * last days before maturity can still state an earlier settlement on its ticket.)
   */
  tradeRefusal(app, { inst, settleDate }) {
    const m = inst.terms?.perpetual ? null : inst.terms?.maturity;
    if (!m || !settleDate || settleDate < m) return null;
    const name = inst.symbol || inst.name;
    return app.clock.today() >= m
      ? { code: 'matured', message: `${name} matured on ${m} and was redeemed. It can no longer be traded.` }
      : { code: 'matured', message: `${name} matures on ${m}; this trade would settle on ${settleDate}, ${settleDate > m ? 'after' : 'when'} it is redeemed. A trade must settle before maturity: state an earlier settlement date, or hold to redemption.` };
  },
  schedTerms,
  accruedAmount(inst, qty, date) {
    const ai = accruedPer100(schedTerms(inst), date);
    return ai === null ? null : (qty * factorOf(inst) * ai) / 100;
  },
  economics(app, { inst, action, qty, price, settleDate }) {
    const ccy = inst.trading_ccy;
    const principal = (qty * factorOf(inst) * price) / 100;
    const ai = bond.accruedAmount(inst, qty, settleDate);
    const buy = action === 'buy' || action === 'buy_to_cover';
    const notes = [];
    if (ai === null) notes.push('Accrued interest cannot be computed: the floating coupon has no fixing. It is booked as zero until the fixing is supplied.');
    // Principal and accrued interest are each rounded to the cent, as the fill books them, so the previewed
    // settlement amount is the amount that settles.
    const total = money(principal, ccy) + money(ai || 0, ccy);
    return { ccy, principal, cash: buy ? -total : total, accrued: ai || 0, notional: qty * factorOf(inst), exposure: buy ? principal : -principal, initialMargin: 0, notes };
  },
  fill(app, c) {
    const f = factorOf(c.inst);
    const ai = bond.accruedAmount(c.inst, c.qty, c.settleDate) || 0;
    return bookSecurityFill(app, c, {
      unitCost: (c.price * f) / 100,
      accrued: ai,
      receiveAccounts: c.action === 'sell_short' ? ['cash.restricted'] : ['cash'],
      payAccounts: c.action === 'buy_to_cover' ? ['cash.restricted', 'cash'] : ['cash'],
    });
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const known = mark !== null && mark !== undefined;
    const clean = known ? money((pos.qty * factorOf(inst) * mark) / 100, ccy) : null;
    return {
      price: known ? mark : null,
      mv: clean, // clean value; accrued interest is carried in the ledger's accrued account
      cost: pos.cost,
      unrealized: known ? money(clean - pos.cost, ccy) : null,
      accrued: app.ledger.positionBalance(pos.id, 'accrued.asset', ccy),
      notional: money(Math.abs(pos.qty) * factorOf(inst), ccy),
      exposure: clean,
    };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    const t = schedTerms(inst);
    const common = { bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id };
    const today = app.clock.today();
    if (isZero(pos.qty)) {
      // A coupon stays with the seller when the sale settles on or after its coupon date (or was made after it and
      // before it was paid). Such a coupon stays scheduled and the accrued balance is left at exactly what is still
      // to be received. Whatever else was earned and not yet recognised is income now; nothing else stays behind.
      const scheduled = unpaidCoupons(app, pos.id);
      app.tasks.cancelFor(pos.id);
      let owed = 0;
      for (const c of scheduled) {
        const face = inst.terms.couponSuspended ? 0 : entitledFace(app, pos, c.couponDate);
        if (isZero(face)) continue;
        app.tasks.schedule({ ...common, type: 'bond.coupon', dueDate: c.dueDate, data: { key: c.couponDate, couponDate: c.couponDate } });
        const per100 = couponPer100(t, c.couponDate);
        if (per100 === null) owed = null; // a floating coupon without its fixing: the balance waits for it
        else if (owed !== null) owed += (face * factorOf(inst) * per100) / 100;
      }
      if (owed !== null) trueUp(app, { book, unit, inst, pos, target: owed, disposal: true });
      return undefined;
    }
    let next = nextCouponDate(t, addBusinessDays(today, -1, 'ALLDAYS'));
    // A trade on a coupon date, after that coupon has been dealt with for this position (paid, or passed with nothing
    // due), must not schedule the same coupon again: it would be paid twice.
    if (next && app.db.get(`SELECT 1 AS x FROM tasks WHERE position_id = ? AND type = 'bond.coupon' AND status = 'done' AND json_extract(data, '$.couponDate') = ?`, pos.id, next)) next = nextCouponDate(t, next);
    // A position whose every trade settles on or after the coupon date has no face entitled to that coupon (it was
    // bought ex coupon): its schedule starts with the coupon after, not with one it will never be paid.
    if (next && isZero(entitledFace(app, pos, next)) && !app.db.get(`SELECT 1 AS x FROM tasks WHERE position_id = ? AND type = 'bond.coupon' AND status IN ('pending','blocked','failed') AND json_extract(data, '$.couponDate') = ?`, pos.id, next)) next = nextCouponDate(t, next);
    if (next && inst.terms.couponType !== 'zero') app.tasks.schedule({ ...common, type: 'bond.coupon', dueDate: adjust(next, 'following', paymentCalendarFor(inst)), data: { key: next, couponDate: next } });
    if (inst.terms.maturity) app.tasks.schedule({ ...common, type: 'bond.maturity', dueDate: adjust(inst.terms.maturity, 'following', paymentCalendarFor(inst)) });
  },
  dataNeeds(app, { inst }) {
    if (inst.terms.couponType !== 'float') return {};
    return { rateCodes: [inst.terms.referenceRate], rateFrom: addBusinessDays(app.clock.today(), -15, 'ALLDAYS') };
  },
  /** Daily accrual true-up: earned interest goes to coupon income as it accrues. */
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty) || inst.terms.couponSuspended) return;
    // The balance already stands at a later date (a coupon was paid before this end-of-day run caught up).
    if (pos.data?.accruedThrough && date < pos.data.accruedThrough) return;
    accrueTo(app, { book, unit, inst, pos, date });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    const { ledger, positions } = app;
    const ccy = inst.trading_ccy;
    const base = { bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos?.strategy_id, positionId: pos?.id, actor: 'engine' };
    if (!pos) return 'done';
    if (task.type === 'bond.coupon') {
      const couponDate = task.data.couponDate;
      const t = schedTerms(inst);
      // Entitlement: face settled before the coupon date.
      const face = entitledFace(app, pos, couponDate);
      const live = positions.get(pos.id);
      const scheduleNext = () => {
        const next = nextCouponDate(t, couponDate);
        if (next && !isZero(live.qty)) app.tasks.schedule({ ...base, type: 'bond.coupon', dueDate: adjust(next, 'following', paymentCalendarFor(inst)), data: { key: next, couponDate: next } });
      };
      if (isZero(face) || inst.terms.couponSuspended) { scheduleNext(); return 'done'; }
      const per100 = couponPer100(t, couponDate);
      if (per100 === null) {
        return { blocked: `Awaiting the ${inst.terms.referenceRate} fixing for the coupon period ending ${couponDate}. ${app.data.describe().awaitingMessage}, or enter the fixing manually.`, needs: [{ kind: 'rate', subject: inst.terms.referenceRate, date: couponDate }] };
      }
      const amount = money((face * factorOf(inst) * per100) / 100, ccy);
      const eventId = ledger.post({
        // A short owes the coupon to the lender of the securities: it is paid, on the face sold short.
        ...base, type: 'bond.coupon', summary: `Coupon ${amount >= 0 ? 'received' : 'paid'} on ${fmtQty(Math.abs(face))} ${inst.symbol || inst.name}${face < 0 ? ' sold short' : ''}: ${fmt(Math.abs(amount), ccy)}`,
        data: { couponDate, per100, face },
        entries: [{ account: 'cash', ccy, amount, positionId: pos.id }, { account: 'accrued.asset', ccy, amount: -amount, positionId: pos.id }],
      });
      if (inst.terms.couponType === 'float') resetFloat(app, inst, couponDate);
      // Whatever the coupon exceeded the accrued balance by is income earned up to the coupon date. The balance
      // then stands at the coupon date (or at the last end of day, if that is later because the coupon was paid late).
      const asOf = live.data?.accruedThrough && live.data.accruedThrough > couponDate ? live.data.accruedThrough : couponDate;
      if (!isZero(live.qty)) {
        if (!inst.terms.couponSuspended) accrueTo(app, { book, unit, inst: app.instruments.get(inst.id), pos: live, date: asOf, paying: couponDate });
      } else if (!unpaidCoupons(app, pos.id).some((c) => c.couponDate !== couponDate)) {
        trueUp(app, { book, unit, inst, pos: live, target: 0, disposal: true });
      }
      scheduleNext();
      return { done: true, eventId };
    }
    if (task.type === 'bond.maturity') {
      const live = positions.get(pos.id);
      if (isZero(live.qty)) return 'done';
      // Final coupon first if it has not been paid yet.
      const pendingCoupon = app.db.get(`SELECT id FROM tasks WHERE position_id = ? AND type = 'bond.coupon' AND status IN ('pending','blocked') AND due_date <= ?`, pos.id, task.due_date);
      if (pendingCoupon) return { blocked: 'Waiting for the final coupon to be paid first.', needs: [] };
      const r = redeem(app, { book, unit, inst, pos: live, price: inst.terms.redemption, face: Math.abs(live.qty), date: inst.terms.maturity, type: 'bond.redemption', label: 'Redeemed at maturity' });
      bond.onPositionChange(app, { book, unit, inst, pos: positions.get(pos.id) });
      return { done: true, eventId: r.eventId };
    }
    return { failed: `Unknown task ${task.type}` };
  },
  /** Early redemption by hand (issuer call, investor put, tender) at a stated price. */
  redeemEarly(app, { book, unit, inst, pos, price, face, label }) {
    const p = num(price);
    need(p >= 0, 'Enter the redemption price in % of par.');
    const f = num(face) ?? Math.abs(pos.qty);
    need(f > 0 && f <= Math.abs(pos.qty) + 1e-9, `The position is ${fmtQty(Math.abs(pos.qty))} face; cannot redeem ${fmtQty(f)}.`);
    const date = app.clock.today();
    const r = redeem(app, { book, unit, inst, pos, price: p, face: f, date, type: 'bond.early_redemption', label: label || 'Redeemed early', actor: 'user', accrued: Math.abs(bond.accruedAmount(inst, f, date) || 0) });
    bond.onPositionChange(app, { book, unit, inst, pos: app.positions.get(pos.id) });
    return r;
  },
  /** Principal paydown by hand: the pool factor falls and the paid-down face is redeemed at par. */
  paydown(app, { book, unit, inst, newFactor }) {
    const nf = num(newFactor);
    const old = factorOf(inst);
    need(nf > 0 && nf < old, `New factor must be below the current factor ${old} and above zero.`);
    const out = [];
    // Every holder of the instrument is paid down, in every Book.
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const b = app.books.getBook(p.book_id), u = app.books.getUnit(p.unit_id);
      const ccy = inst.trading_ccy;
      const paid = money(p.qty * (old - nf) * (inst.terms.redemption / 100), ccy);
      const costOut = money(p.cost * ((old - nf) / old), ccy);
      const eventId = app.ledger.post({
        bookId: b.id, unitId: u.id, type: 'bond.paydown', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user',
        summary: `Principal paydown on ${inst.symbol || inst.name}: factor ${old} to ${nf}, ${fmt(Math.abs(paid), ccy)} ${paid >= 0 ? 'received' : 'paid'}`,
        data: { oldFactor: old, newFactor: nf },
        entries: [
          { account: 'cash', ccy, amount: paid, positionId: p.id },
          { account: 'pos', ccy, amount: -costOut, positionId: p.id },
          { account: 'pnl.realized', ccy, amount: money(costOut - paid, ccy), positionId: p.id },
        ],
      });
      app.positions.change(p, { dCost: -costOut });
      out.push(eventId);
    }
    app.instruments.update(inst.id, { terms: { ...inst.terms, factor: nf } }, { system: true });
    return { eventIds: out };
  },
};

/** Terms used for schedule arithmetic (a perpetual gets a far-off synthetic maturity on its anchor). */
function schedTerms(inst) {
  const t = inst.terms;
  if (!t.perpetual) return t;
  const y = Number(t.anchorDate.slice(0, 4));
  return { ...t, maturity: `${y + 200}${t.anchorDate.slice(4)}` };
}

function redeem(app, { book, unit, inst, pos, price, face, date, type, label, actor = 'engine', accrued = 0 }) {
  const long = pos.qty > 0;
  // Settle the outstanding accrued interest to zero against cash before closing the principal.
  return bookSecurityFill(app, {
    book, unit, inst, action: long ? 'sell' : 'buy_to_cover', qty: face, price, fees: [], strategyId: pos.strategy_id, tradeDate: date, settleDate: app.clock.today(),
    eventType: type, actor, summary: `${label}: ${fmtQty(face)} ${inst.symbol || inst.name} at ${fmtPx(price)}% of par`,
  }, { unitCost: (price * factorOf(inst)) / 100, accrued });
}

/** After a floating coupon is paid, set the coupon for the new period from the reference-rate fixing. */
function resetFloat(app, inst, resetDate) {
  const o = app.data.rate(inst.terms.referenceRate, resetDate);
  const ok = o && (o.forDate || '').slice(0, 10) >= addBusinessDays(resetDate, -5, 'ALLDAYS');
  const current = ok ? o.value / 100 + (inst.terms.spread || 0) : null;
  app.instruments.update(inst.id, { terms: { ...inst.terms, currentCoupon: current, currentCouponFixing: ok ? { date: o.forDate, value: o.value, obsId: app.data.recordUsed(o) } : null } }, { system: true });
  if (!ok) app.alerts.raise({ level: 'warning', code: 'bond.fixing', refType: 'instrument', refId: inst.id, message: `${inst.symbol || inst.name}: no ${inst.terms.referenceRate} fixing for the coupon period starting ${resetDate}. Interest is not accruing until the fixing is supplied or entered.` });
}

export { resetFloat };
