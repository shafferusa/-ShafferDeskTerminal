// Swaps and credit default swaps.
//
// A swap is never reduced to "buy/sell swap". The contract is a list of legs, each with its own
// side (pay or receive), type, currency, notional, rate or index, spread, schedule and day count.
// One engine covers interest-rate swaps, OIS, basis and cross-currency swaps, inflation swaps,
// total-return and equity swaps, commodity swaps, and caps/floors (a capped or floored floating leg).
//
// Leg types
//   fixed    notional x rate x day-count fraction; compounded annually when the leg says so (a leg paid once,
//            at maturity, as on a zero-coupon swap): notional x ((1 + rate)^fraction - 1)
//   float    notional x (fixing at period start + spread) x fraction
//   ois      notional x (compounded overnight fixings over the period - 1) + spread
//   return   notional x (fixing at period end / fixing at period start - 1) of the reference asset
//   price    units x price fixing at period end (or x a fixed price)
//   cap      notional x max(fixing - strike, 0) x fraction
//   floor    notional x max(strike - fixing, 0) x fraction
//
// The Terminal computes contractual cash flows only. Marks (NPV) come from Shaffer Analytics Lab /
// MarketData or manual entry. A payment whose fixing is missing is blocked visibly, never guessed.

import { fmt } from '../core/books.js';
import { addBusinessDays, adjust, isBusinessDay } from '../quant/calendar.js';
import { yearFraction, DAY_COUNTS } from '../quant/daycount.js';
import { addDays, addMonths, diffDays } from '../quant/dates.js';
import { cdsDates, generateSchedule } from '../quant/schedule.js';
import { CCY_RE, ISO_DATE_RE, isZero, money, need, num, sign } from '../core/util.js';
import { normalizeBasis } from '../core/agreements.js';
import { bookSecurityFill, fmtPx, fmtQty } from './common.js';
import { calendarFor, paymentCalendarFor, standardSettleDate } from './security.js';

const LEG_TYPES = ['fixed', 'float', 'ois', 'return', 'price', 'cap', 'floor'];
const pct = (x, dp = 3) => `${(x * 100).toFixed(dp)}%`;

export function describeLeg(leg, app) {
  const side = leg.side === 'pay' ? 'Pay' : 'Receive';
  const freq = leg.months ? `every ${leg.months} month${leg.months > 1 ? 's' : ''}` : 'at maturity';
  const und = leg.underlyingId && app ? app.instruments.get(leg.underlyingId) : null;
  const ref = und ? (und.symbol || und.name) : leg.underlyingName || 'reference asset';
  switch (leg.type) {
    case 'fixed': return `${side} fixed ${pct(leg.rate)} ${leg.ccy}${leg.compounding === 'annual' ? ', compounded annually' : ''}, ${freq}, ${leg.dayCount}`;
    case 'float': return `${side} ${leg.index}${leg.spread ? ` ${leg.spread > 0 ? '+' : '-'} ${pct(Math.abs(leg.spread), 2)}` : ''} ${leg.ccy}, ${freq}, ${leg.dayCount}`;
    case 'ois': return `${side} compounded ${leg.index}${leg.spread ? ` ${leg.spread > 0 ? '+' : '-'} ${pct(Math.abs(leg.spread), 2)}` : ''} ${leg.ccy}, ${freq}, ${leg.dayCount}`;
    case 'return': return `${side} ${leg.passDividends ? 'total' : 'price'} return on ${ref} (${leg.ccy}), reset ${freq}${leg.resetNotional ? ', notional resets' : ''}`;
    case 'price': return `${side} ${leg.fixedPrice !== null && leg.fixedPrice !== undefined ? `fixed price ${leg.fixedPrice}` : `floating price of ${ref}`} x ${leg.units} units per unit notional (${leg.ccy}), ${freq}`;
    case 'cap': return `${side} cap: max(${leg.index} - ${pct(leg.strike)}, 0) ${leg.ccy}, ${freq}, ${leg.dayCount}`;
    case 'floor': return `${side} floor: max(${pct(leg.strike)} - ${leg.index}, 0) ${leg.ccy}, ${freq}, ${leg.dayCount}`;
    default: return `${side} ${leg.type}`;
  }
}

function legSchedule(inst, leg) {
  const t = inst.terms;
  return generateSchedule({ start: t.effective, end: t.maturity, months: leg.months || 0, calendar: paymentCalendarFor(inst), convention: 'modified-following' });
}

const scheduleFactor = (leg, date) => {
  let f = 1;
  for (const s of leg.notionalSchedule || []) if (s.from <= date) f = s.factor;
  return f;
};

/**
 * The date whose fixing a period starting on `date` uses: that date itself, or, when it is not a
 * business day of the contract's payment calendar (accrual dates are not adjusted), the last
 * business day before it.
 */
export function fixingDate(inst, date) {
  const cal = paymentCalendarFor(inst);
  let d = date;
  for (let i = 0; i < 14 && !isBusinessDay(d, cal); i++) d = addDays(d, -1);
  return d;
}

/**
 * The fixing of a rate for one date, or null. Only the fixing published (or entered by hand) for
 * exactly the fixing date counts: an older fixing is never used in its place, so a fixing that has
 * not arrived blocks the payment that needs it instead of being replaced by the one before it.
 */
function rateFixing(app, inst, code, date) {
  const d = fixingDate(inst, date);
  const o = app.data.rate(code, d);
  if (!o) return null;
  return (o.forDate || o.asOf || '').slice(0, 10) === d ? o : null;
}

/**
 * Binary floating point leaves residue in a product such as 81,590 x 0.045 x 92 / 360 (938.2849999...
 * for 938.285). It is removed before an amount is rounded to the minor unit, so an exact half rounds
 * as a half.
 */
const exact = (x) => (Number.isFinite(x) ? Number(x.toPrecision(14)) : x);

/** Contractual amount of one leg for one period, unsigned for side. Returns {amount} or {missing}. */
function legAmount(app, inst, pos, leg, period) {
  const state = pos.data.legs?.[leg.id] || {};
  const scale = pos.data.notionalScale ?? 1;
  const N = Math.abs(pos.qty) * (leg.notionalFactor ?? 1) * scheduleFactor(leg, period.start) * (leg.type === 'price' ? 1 : scale);
  const yf = yearFraction(period.start, period.end, leg.dayCount || 'ACT/360');
  const used = [];
  switch (leg.type) {
    case 'fixed':
      // Simple interest, or (a zero-coupon leg) compounded once a year over the period.
      return { amount: leg.compounding === 'annual' ? N * ((1 + leg.rate) ** yf - 1) : N * leg.rate * yf, detail: { notional: N, rate: leg.rate, fraction: yf, compounding: leg.compounding || null } };
    case 'float':
    case 'cap':
    case 'floor': {
      const o = rateFixing(app, inst, leg.index, period.start);
      if (!o) return { missing: { kind: 'rate', subject: leg.index, date: fixingDate(inst, period.start) } };
      used.push(app.data.recordUsed(o));
      const fix = o.value / 100;
      let r = fix + (leg.spread || 0);
      if (leg.type === 'cap') r = Math.max(fix - leg.strike, 0);
      if (leg.type === 'floor') r = Math.max(leg.strike - fix, 0);
      return { amount: N * r * yf, detail: { notional: N, fixing: o.value, fraction: yf }, used };
    }
    case 'ois': {
      // Each business day's fixing applies until the next business day (so a Friday fixing covers three days),
      // on the day-count basis of the leg: 365 for ACT/365, otherwise 360.
      const cal = paymentCalendarFor(inst);
      const basis = leg.dayCount === 'ACT/365' ? 365 : 360;
      let growth = 1;
      let d = period.start;
      while (d < period.end) {
        let next = addDays(d, 1);
        while (next < period.end && !isBusinessDay(next, cal)) next = addDays(next, 1);
        const o = rateFixing(app, inst, leg.index, d);
        if (!o) return { missing: { kind: 'rate', subject: leg.index, date: fixingDate(inst, d) } };
        growth *= 1 + ((o.value / 100) * diffDays(d, next)) / basis;
        d = next;
      }
      return { amount: N * (growth - 1 + (leg.spread || 0) * yf), detail: { notional: N, compounded: growth - 1, fraction: yf } };
    }
    case 'return': {
      // The fixing of a period boundary is the close of that day or, when it is not a business day of the payment
      // calendar (accrual dates are not adjusted), of the last business day before it: the rule of the rate fixings.
      const d0 = fixingDate(inst, period.start), d1 = fixingDate(inst, period.end);
      let p0 = state.lastFixing ?? inst.terms.initialPrices?.[leg.id] ?? null;
      if (p0 === null) {
        const o0 = app.data.closeFor(leg.underlyingId, d0);
        if (!o0 || o0.value === null) return { missing: { kind: 'price', subject: leg.underlyingId, date: d0 } };
        p0 = o0.value;
        used.push(app.data.recordUsed(o0));
      }
      const o1 = app.data.closeFor(leg.underlyingId, d1);
      if (!o1 || o1.value === null) return { missing: { kind: 'price', subject: leg.underlyingId, date: d1 } };
      used.push(app.data.recordUsed(o1));
      return { amount: N * (o1.value / p0 - 1), detail: { notional: N, start: p0, end: o1.value }, used, fixing: o1.value, ratio: o1.value / p0 };
    }
    case 'price': {
      const units = Math.abs(pos.qty) * (leg.units ?? 1) * scheduleFactor(leg, period.start);
      if (leg.fixedPrice !== null && leg.fixedPrice !== undefined) return { amount: units * leg.fixedPrice, detail: { units, price: leg.fixedPrice } };
      const d = fixingDate(inst, period.end);
      const o = app.data.closeFor(leg.underlyingId, d);
      if (!o || o.value === null) return { missing: { kind: 'price', subject: leg.underlyingId, date: d } };
      used.push(app.data.recordUsed(o));
      return { amount: units * o.value, detail: { units, price: o.value }, used };
    }
    default:
      return { amount: 0, detail: {} };
  }
}

/**
 * Notional on which principal has been exchanged, or is due to be exchanged, by `date`: the position's
 * notional less the changes whose own settlement date is still ahead. A change agreed after the swap has
 * started (an increase, a termination) exchanges its principal when it settles, not on the day it is agreed.
 */
const exchangedQty = (pos, date) => pos.qty - (pos.data.notionalPending || []).reduce((a, p) => (p.date > date ? a + p.dq : a), 0);

/** What bringing the exchanged principal into line on `date` would move, per leg: + received, - paid. */
function notionalExchangeDue(app, { inst, pos, date }) {
  const t = inst.terms;
  const q = exchangedQty(pos, date);
  const live = !isZero(q) && date >= t.effective && date < t.maturity;
  const out = [];
  for (const leg of t.legs) {
    if (!leg.exchangeNotional) continue;
    // Holding the swap as written: a pay leg means we received that currency's notional at the start.
    const s = sign(q) * (leg.side === 'pay' ? 1 : -1);
    const target = live ? money(s * Math.abs(q) * (leg.notionalFactor ?? 1), leg.ccy) : 0;
    // Position-tagged exchanged notional: + means we hold the cash and owe it back.
    const held = -(app.ledger.positionBalance(pos.id, 'loan.liab', leg.ccy) + app.ledger.positionBalance(pos.id, 'loan.asset', leg.ccy));
    const delta = money(target - held, leg.ccy);
    if (delta !== 0) out.push({ leg, target, held, delta });
  }
  return out;
}

/** The first currency in which the principal to be paid is more than the settled cash of the unit, or null. */
function notionalShortfall(app, unit, moves) {
  const net = {};
  for (const m of moves) net[m.leg.ccy] = (net[m.leg.ccy] || 0) + m.delta;
  for (const [ccy, amount] of Object.entries(net)) {
    if (amount >= 0) continue;
    const have = app.ledger.balance(unit.id, 'cash', ccy);
    if (have < -amount - 0.004) return { ccy, due: money(-amount, ccy), have: money(Math.max(have, 0), ccy) };
  }
  return null;
}
const shortfallMessage = (inst, unit, short, what = 'Notional exchange') => `${what} on ${inst.name} could not be made: ${fmt(short.due, short.ccy)} is to be paid and ${unit.name} has ${fmt(short.have, short.ccy)} of settled ${short.ccy} cash. Nothing was exchanged in either currency.`;

/**
 * Keep exchanged notionals (cross-currency legs) in line with the open position. Principal is exchanged in
 * every currency or in none: when the cash to be paid is not there, nothing moves, cash never goes below
 * zero, and the reason is returned as { failed } for the caller to show and to try again.
 */
function trueUpNotionalExchange(app, { book, unit, inst, pos, date, what }) {
  const moves = notionalExchangeDue(app, { inst, pos, date });
  if (!moves.length) return { moved: 0 };
  const short = notionalShortfall(app, unit, moves);
  if (short) return { failed: shortfallMessage(inst, unit, short, what) };
  let eventId = null;
  for (const { leg, target, held, delta } of moves) {
    const account = (target || held) > 0 ? 'loan.liab' : 'loan.asset';
    eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'swap.notional_exchange', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
      summary: `Notional exchange on ${inst.name}: ${delta > 0 ? 'received' : 'paid'} ${fmt(Math.abs(delta), leg.ccy)}`,
      data: { legId: leg.id, target, held },
      entries: [{ account: 'cash', ccy: leg.ccy, amount: delta, positionId: pos.id }, { account, ccy: leg.ccy, amount: -delta, positionId: pos.id }],
    });
  }
  return { moved: moves.length, eventId };
}

/** A task that brings the exchanged principal into line on `dueDate`: the effective date, or the settlement date of a later change. */
const scheduleNotional = (app, { book, unit, inst, pos }, dueDate, key) => app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'swap.notional', dueDate, data: { key } });
const maturityPayDate = (inst) => adjust(inst.terms.maturity, 'modified-following', paymentCalendarFor(inst));

function scheduleLegTasks(app, { book, unit, inst, pos }) {
  const today = app.clock.today();
  const common = { bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id };
  const from = pos.data.cashflowsFrom || today;
  for (const leg of inst.terms.legs) {
    const sched = legSchedule(inst, leg);
    // Next period that ends after the position was opened and has not been paid.
    const paid = pos.data.legs?.[leg.id]?.paidThrough || null;
    const idx = sched.findIndex((p) => p.end > from && (!paid || p.end > paid));
    if (idx >= 0) app.tasks.schedule({ ...common, type: 'swap.payment', dueDate: sched[idx].payDate, data: { key: `${leg.id}:${sched[idx].end}`, legId: leg.id, periodEnd: sched[idx].end } });
  }
  if (inst.terms.legs.some((l) => l.exchangeNotional) && today < inst.terms.effective) app.tasks.schedule({ ...common, type: 'swap.notional', dueDate: inst.terms.effective, data: { key: 'start' } });
  app.tasks.schedule({ ...common, type: 'swap.maturity', dueDate: maturityPayDate(inst) });
}

export const swap = {
  family: 'swap',
  kind: 'security',
  shortRule: 'write',
  label: 'Swap',
  qtyLabel: 'Notional',
  actions: () => ['buy', 'sell'],
  actionLabels: { buy: 'Enter as written', sell: 'Enter the opposite side' },
  priceUnits: () => 'upfront / NPV per 100 notional',
  calendar: calendarFor,
  describeLeg,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    if (!ISO_DATE_RE.test(t.effective || '')) errors.push('Effective date is required.');
    if (!ISO_DATE_RE.test(t.maturity || '')) errors.push('Maturity date is required.');
    if (t.effective && t.maturity && t.maturity <= t.effective) errors.push('Maturity must be after the effective date.');
    if (!Array.isArray(t.legs) || !t.legs.length) errors.push('A swap needs at least one leg, each with its side, type, currency and terms.');
    t.legs = (t.legs || []).map((raw, i) => {
      const l = { ...raw };
      l.id = l.id || String.fromCharCode(65 + i);
      const at = `Leg ${l.id}`;
      if (!['pay', 'receive'].includes(l.side)) errors.push(`${at}: state whether this leg is paid or received.`);
      if (!LEG_TYPES.includes(l.type)) errors.push(`${at}: type must be one of ${LEG_TYPES.join(', ')}.`);
      l.ccy = String(l.ccy || draft.trading_ccy || '').toUpperCase();
      if (!CCY_RE.test(l.ccy)) errors.push(`${at}: currency is required.`);
      l.months = num(l.months) ?? 0;
      l.dayCount = DAY_COUNTS.includes(l.dayCount) ? l.dayCount : 'ACT/360';
      l.notionalFactor = num(l.notionalFactor) ?? 1;
      if (!(l.notionalFactor > 0)) errors.push(`${at}: notional factor must be positive.`);
      if (l.type === 'fixed') {
        l.rate = num(l.rate);
        if (l.rate === null) errors.push(`${at}: fixed rate is required as a decimal (0.04 = 4%).`);
        else if (Math.abs(l.rate) > 1) errors.push(`${at}: the fixed rate looks like a percentage; enter it as a decimal.`);
        l.compounding = l.compounding === 'annual' ? 'annual' : null;
        if (l.compounding && l.months) errors.push(`${at}: compounding applies to a fixed leg paid once, at maturity. Choose payment at maturity, or no compounding.`);
      } else delete l.compounding;
      if (['float', 'ois', 'cap', 'floor'].includes(l.type)) {
        if (!l.index) errors.push(`${at}: floating index (rate code) is required.`);
        l.spread = num(l.spread) ?? 0;
      }
      if (l.type === 'cap' || l.type === 'floor') {
        l.strike = num(l.strike);
        if (l.strike === null) errors.push(`${at}: strike rate is required as a decimal.`);
      }
      if (l.type === 'return' || (l.type === 'price' && (l.fixedPrice === null || l.fixedPrice === undefined || l.fixedPrice === ''))) {
        if (!l.underlyingId) errors.push(`${at}: choose the reference asset.`);
      }
      if (l.type === 'price') {
        l.units = num(l.units) ?? 1;
        l.fixedPrice = num(l.fixedPrice);
      }
      l.exchangeNotional = Boolean(l.exchangeNotional);
      l.resetNotional = Boolean(l.resetNotional);
      l.passDividends = Boolean(l.passDividends);
      if (Array.isArray(l.notionalSchedule)) l.notionalSchedule = l.notionalSchedule.filter((s) => ISO_DATE_RE.test(s.from || '') && num(s.factor) >= 0).map((s) => ({ from: s.from, factor: num(s.factor) })).sort((a, b) => (a.from < b.from ? -1 : 1));
      return l;
    });
    // Quantity (the notional) and price (upfront, mark, per 100 of notional) are in the contract's trading currency, and a
    // leg's own notional is the quantity x its notional factor. The currency stated on the contract is kept when a leg is
    // in it; it is never replaced silently by another one. Left empty, it is the first leg's.
    const stated = String(draft.trading_ccy || '').toUpperCase();
    const legCcys = t.legs.map((l) => l.ccy).filter((c) => CCY_RE.test(c));
    if (stated && legCcys.length && !legCcys.includes(stated)) errors.push(`The trading currency ${stated} is not the currency of any leg (${[...new Set(legCcys)].join(', ')}). The notional and the price of a swap are stated in its trading currency: use the currency of one of the legs.`);
    const ccy = legCcys.includes(stated) ? stated : (t.legs[0]?.ccy || stated);
    // Collateral follows the basis stated on the contract (an agreement, position-level terms, or an explicit
    // uncollateralized assumption). The older initialMarginPct field is still read as position-level terms.
    t.collateralBasis = normalizeBasis(t.collateralBasis, errors);
    if (!t.collateralBasis) delete t.collateralBasis;
    t.initialMarginPct = num(t.initialMarginPct);
    if (t.initialMarginPct !== null && !(t.initialMarginPct >= 0 && t.initialMarginPct < 1)) errors.push('The independent amount is a share of notional between 0 and 1 (0.10 = 10%).');
    return { terms: t, multiplier: 0.01, errors, tradingCcy: ccy, settleCcy: ccy };
  },
  describe(inst, app) {
    const t = inst.terms;
    const rows = [['Effective', t.effective], ['Maturity', t.maturity]];
    for (const l of t.legs) rows.push([`Leg ${l.id}`, describeLeg(l, app)]);
    const ccys = [...new Set(t.legs.map((l) => l.ccy))];
    rows.push(['Currencies', ccys.join(', ')]);
    if (t.legs.some((l) => l.exchangeNotional)) rows.push(['Notional exchange', 'At start and maturity']);
    rows.push(['Counterparty', t.counterparty || 'Simulated counterparty']);
    rows.push(...collateralRows(inst, app));
    return rows;
  },
  qtyStep: () => 1,
  settleDate: (app, inst, tradeDate, book) => standardSettleDate(inst, tradeDate, book),
  /** Notional on which a percentage independent amount is worked out. */
  collateralNotional: (app, inst, { pos, qtyAfter }) => Math.abs(qtyAfter) * (pos?.data?.notionalScale ?? 1),
  economics(app, { inst, action, qty, price, unit, strategyId, book }) {
    const upfront = (qty * price) / 100;
    const buy = action === 'buy';
    const notes = ['Notional is not paid. Only the upfront amount (if any) settles at trade; each leg then pays on its schedule.'];
    for (const l of inst.terms.legs) notes.push(`Leg ${l.id}: ${buy ? describeLeg(l, app) : describeLeg({ ...l, side: l.side === 'pay' ? 'receive' : 'pay' }, app)}`);
    // Principal exchanged (cross-currency legs). A trade that settles while the swap is running exchanges its principal with
    // that settlement, so the cash to be paid is part of what the trade needs; before the effective date it is only announced.
    let otherCash;
    const exch = inst.terms.legs.filter((l) => l.exchangeNotional);
    if (exch.length) {
      const t = inst.terms;
      const settle = standardSettleDate(inst, app.clock.today(), book);
      const dq = buy ? qty : -qty;
      const amounts = exch.map((l) => ({ ccy: l.ccy, amount: money((l.side === 'pay' ? 1 : -1) * dq * (l.notionalFactor ?? 1), l.ccy) }));
      const say = amounts.map((a) => `${a.amount >= 0 ? 'receive' : 'pay'} ${fmt(Math.abs(a.amount), a.ccy)}`).join(', ');
      if (settle >= t.maturity) notes.push('No principal is exchanged for this trade: the swap matures before it settles.');
      else if (settle >= t.effective) {
        otherCash = amounts;
        notes.push(`Principal is exchanged when this trade settles (${settle}): ${say}. It goes back the other way at maturity or on termination.`);
      } else {
        // Not required today, but said plainly when it is not there today either.
        const lacking = unit ? amounts.filter((a) => a.amount < 0 && app.ledger.balance(unit.id, 'cash', a.ccy) < -a.amount - 0.004).map((a) => `${fmt(Math.max(app.ledger.balance(unit.id, 'cash', a.ccy), 0), a.ccy)} of settled ${a.ccy} cash`) : [];
        notes.push(`Principal is exchanged on the effective date ${t.effective}: ${say}. The cash to be paid must be in ${unit?.name || 'the owner'} on that date; it is not set aside now.${lacking.length ? ` ${unit.name} has ${lacking.join(' and ')} today: without more, the exchange will fail on that date and wait.` : ''}`);
      }
    }
    // Collateral to post (or get back) for the position this trade leaves, under the basis the contract states.
    const coll = app.agreements.tradeRequirement({ book, unit, inst, action, qty, price, strategyId, cashOut: Math.max(0, buy ? upfront : -upfront) });
    return { ccy: inst.trading_ccy, principal: upfront, cash: buy ? -upfront : upfront, accrued: 0, notional: qty, exposure: null, initialMargin: coll.initialMargin, collateral: coll, otherCash, notes: [...notes, ...coll.notes] };
  },
  fill(app, c) {
    // The audit trail names what was done to the contract (entered, increased, terminated), never "bought" or "sold".
    const summary = c.summary || swapFillSummary(app, c);
    const r = bookSecurityFill(app, { ...c, summary }, { unitCost: c.price / 100 });
    let data = null;
    if (r.wasFlat && !isZero(r.position.qty)) data = { cashflowsFrom: c.tradeDate, legs: {}, notionalScale: 1 };
    // Principal for this change is exchanged when the change settles: until then it is held back from the exchanged notional.
    if (c.inst.terms.legs.some((l) => l.exchangeNotional) && c.settleDate && c.tradeDate && c.settleDate > c.tradeDate) {
      const before = app.positions.get(r.position.id).data.notionalPending || [];
      data = { ...(data || {}), notionalPending: [...before.filter((p) => p.date > c.tradeDate), { date: c.settleDate, dq: c.action === 'buy' ? c.qty : -c.qty }] };
    }
    if (data) app.positions.change(app.positions.get(r.position.id), { data });
    return { ...r, position: app.positions.get(r.position.id) };
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const known = mark !== null && mark !== undefined;
    const mv = known ? money((pos.qty * mark) / 100, ccy) : null;
    return { price: known ? mark : null, mv, cost: pos.cost, unrealized: known ? money(mv - pos.cost, ccy) : null, accrued: 0, notional: Math.abs(pos.qty) * (pos.data.notionalScale ?? 1), exposure: null };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    const today = app.clock.today();
    const exchanged = trueUpNotionalExchange(app, { book, unit, inst, pos, date: today });
    app.agreements.onPositionChange({ book, unit, inst, pos });
    if (isZero(pos.qty)) app.tasks.cancelFor(pos.id);
    else scheduleLegTasks(app, { book, unit, inst, pos: app.positions.get(pos.id) });
    // Principal still to be exchanged: when a change made after the start settles (at the latest on the maturity date,
    // when everything goes back), and again today if it was due now and the cash to pay it was not there.
    const last = maturityPayDate(inst);
    for (const p of pos.data.notionalPending || []) {
      if (p.date > today && p.date > inst.terms.effective) scheduleNotional(app, { book, unit, inst, pos }, p.date < last ? p.date : last, `settle:${p.date}`);
    }
    if (exchanged.failed) scheduleNotional(app, { book, unit, inst, pos }, today, 'retry');
  },
  dataNeeds(app, { inst, task }) {
    const out = { rateCodes: [], closes: [], instruments: [] };
    if (!task) return out; // swaps accrue nothing in the ledger between payment dates
    const leg = inst.terms.legs.find((l) => l.id === task.data?.legId);
    // Fixings from the start of the period being paid: a leg that pays once, at maturity, has one period from the effective date.
    if (leg && task.data?.periodEnd) out.rateFrom = addDays(leg.months ? addMonths(task.data.periodEnd, -leg.months) : inst.terms.effective, -10);
    else out.rateFrom = addDays(inst.terms.effective, -10);
    for (const l of inst.terms.legs) {
      if (l.index) out.rateCodes.push(l.index);
      if (l.underlyingId) {
        const u = app.instruments.get(l.underlyingId);
        if (u) {
          out.instruments.push(u);
          if (task?.data?.periodEnd) out.closes.push({ instrument: u, date: fixingDate(inst, task.data.periodEnd) });
          // A return leg also needs the fixing its period starts from, unless an earlier reset or the contract already gave it
          // (asking for it again does no harm): without this the first period of an index or return leg could never be paid
          // from supplied data.
          if (l.type === 'return' && l.id === task?.data?.legId && task.data.periodEnd) {
            const period = legSchedule(inst, l).find((x) => x.end === task.data.periodEnd);
            if (period) out.closes.push({ instrument: u, date: fixingDate(inst, period.start) });
          }
        }
      }
    }
    return out;
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (!pos) return 'done';
    const t = inst.terms;
    const base = { bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine' };
    const unfunded = (message) => {
      app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'task', refId: task.id, message });
      return { failed: message };
    };

    // The exchange of principal: at the start, and when a later change settles (also the last one, after a full termination).
    if (task.type === 'swap.notional') {
      const today = app.clock.today();
      const all = pos.data.notionalPending || [];
      const pending = all.filter((p) => p.date > today);
      const fresh = pending.length === all.length ? pos : app.positions.change(pos, { data: { notionalPending: pending } });
      const r = trueUpNotionalExchange(app, { book, unit, inst, pos: fresh, date: today });
      if (r.failed) return unfunded(r.failed);
      app.alerts.resolve({ refType: 'task', refId: task.id, code: 'funding.failed' });
      return { done: true, eventId: r.eventId };
    }
    if (isZero(pos.qty)) return 'done';
    const awaiting = app.data.describe().awaitingMessage;

    if (task.type === 'swap.payment') {
      const leg = t.legs.find((l) => l.id === task.data.legId);
      const sched = legSchedule(inst, leg);
      const period = sched.find((p) => p.end === task.data.periodEnd);
      if (!leg || !period) return 'done';
      // A position opened part-way through a period pays from its own start date.
      const from = pos.data.cashflowsFrom || t.effective;
      const eff = { ...period, start: from > period.start && from < period.end && leg.type !== 'return' ? from : period.start };
      const r = legAmount(app, inst, pos, leg, eff);
      if (r.missing) {
        const what = r.missing.kind === 'rate' ? `the ${r.missing.subject} fixing for ${r.missing.date}` : `the ${r.missing.date} fixing for ${app.instruments.get(r.missing.subject)?.symbol || 'the reference asset'}`;
        return { blocked: `Awaiting ${what}. ${awaiting}, or enter the fixing manually.`, needs: [r.missing] };
      }
      const s = sign(pos.qty) * (leg.side === 'receive' ? 1 : -1);
      const amount = money(s * exact(r.amount), leg.ccy);
      if (amount < 0 && app.ledger.balance(unit.id, 'cash', leg.ccy) < -amount - 0.004) {
        const msg = `Swap payment of ${fmt(-amount, leg.ccy)} on ${inst.name} (leg ${leg.id}) could not be paid: insufficient settled ${leg.ccy} cash in ${unit.name}.`;
        app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'task', refId: task.id, message: msg });
        return { failed: msg };
      }
      // A caplet or floorlet whose fixing is not through the strike pays nothing: that is recorded, and said in those words.
      const nothing = amount === 0 && (leg.type === 'cap' || leg.type === 'floor') && r.detail?.fixing !== undefined;
      const eventId = app.ledger.post({
        ...base, type: 'swap.payment',
        summary: nothing
          ? `Nothing due on ${inst.name}, leg ${leg.id} (${leg.type}), period ${eff.start} to ${period.end}: the ${leg.index} fixing ${pct(r.detail.fixing / 100)} is not ${leg.type === 'cap' ? 'above' : 'below'} the strike ${pct(leg.strike)}`
          : `Swap ${amount >= 0 ? 'receipt' : 'payment'} on ${inst.name}, leg ${leg.id} (${leg.type}), period ${eff.start} to ${period.end}: ${fmt(Math.abs(amount), leg.ccy)}`,
        data: { legId: leg.id, period: eff, detail: r.detail, obsIds: r.used || [] },
        entries: [{ account: 'cash', ccy: leg.ccy, amount, positionId: pos.id }, { account: 'pnl.realized', ccy: leg.ccy, amount: -amount, positionId: pos.id }],
      });
      app.alerts.resolve({ refType: 'task', refId: task.id, code: 'funding.failed' });
      const legs = { ...(pos.data.legs || {}) };
      legs[leg.id] = { ...(legs[leg.id] || {}), paidThrough: period.end };
      const patch = { legs };
      if (leg.type === 'return') {
        legs[leg.id].lastFixing = r.fixing;
        if (leg.resetNotional) patch.notionalScale = (pos.data.notionalScale ?? 1) * r.ratio;
      }
      const updated = app.positions.change(pos, { data: patch });
      // A notional reset changes the independent amount the terms call for.
      if (patch.notionalScale !== undefined) app.agreements.onPositionChange({ book, unit, inst, pos: updated });
      const nextIdx = sched.findIndex((p) => p.end === period.end) + 1;
      if (nextIdx < sched.length) app.tasks.schedule({ ...base, type: 'swap.payment', dueDate: sched[nextIdx].payDate, data: { key: `${leg.id}:${sched[nextIdx].end}`, legId: leg.id, periodEnd: sched[nextIdx].end } });
      void updated;
      return { done: true, eventId };
    }

    if (task.type === 'swap.maturity') {
      const open = app.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE position_id = ? AND type = 'swap.payment' AND status IN ('pending','blocked','failed')`, pos.id).n;
      if (open) return { blocked: 'Waiting for the final leg payments to be made first.', needs: [] };
      // The principal that goes back at maturity must be there before the contract is ended.
      const short = notionalShortfall(app, unit, notionalExchangeDue(app, { inst, pos, date: app.clock.today() }));
      if (short) return unfunded(shortfallMessage(inst, unit, short, 'Final notional exchange'));
      app.alerts.resolve({ refType: 'task', refId: task.id, code: 'funding.failed' });
      const fresh = app.positions.get(pos.id);
      const r = bookSecurityFill(app, {
        book, unit, inst, action: fresh.qty > 0 ? 'sell' : 'buy', qty: Math.abs(fresh.qty), price: 0, fees: [], strategyId: fresh.strategy_id, tradeDate: t.maturity, settleDate: app.clock.today(),
        eventType: 'swap.matured', actor: 'engine', summary: `Swap matured: ${inst.name} (notional ${fmtQty(Math.abs(fresh.qty))})`,
      }, { unitCost: 0 });
      trueUpNotionalExchange(app, { book, unit, inst, pos: app.positions.get(pos.id), date: app.clock.today() });
      app.agreements.onPositionChange({ book, unit, inst, pos });
      return { done: true, eventId: r.eventId };
    }
    return { failed: `Unknown task ${task.type}` };
  },
  /** Dividend pass-through on total-return legs when a dividend is recorded on the reference asset. */
  onCorporateAction(app, { ca, book, unit, inst, pos }) {
    if (ca.type !== 'cash_dividend' || isZero(pos.qty)) return null;
    let eventId = null;
    for (const leg of inst.terms.legs) {
      if (leg.type !== 'return' || !leg.passDividends || leg.underlyingId !== ca.instrument_id) continue;
      const p0 = pos.data.legs?.[leg.id]?.lastFixing ?? inst.terms.initialPrices?.[leg.id] ?? null;
      if (p0 === null) continue;
      const shares = (Math.abs(pos.qty) * (leg.notionalFactor ?? 1) * (pos.data.notionalScale ?? 1)) / p0;
      const s = sign(pos.qty) * (leg.side === 'receive' ? 1 : -1);
      const amount = money(s * shares * ca.amount, leg.ccy);
      if (amount === 0) continue;
      eventId = app.ledger.post({
        bookId: book.id, unitId: unit.id, type: 'swap.dividend', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
        summary: `Dividend pass-through on ${inst.name}: ${amount >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(amount), leg.ccy)} (${fmtQty(shares)} reference shares x ${ca.amount})`,
        data: { corporateActionId: ca.id, shares, perShare: ca.amount },
        entries: [{ account: 'cash', ccy: leg.ccy, amount, positionId: pos.id }, { account: 'pnl.realized', ccy: leg.ccy, amount: -amount, positionId: pos.id }],
      });
    }
    return eventId;
  },
};

/**
 * What a fill did to a swap-family contract, for the audit trail: entered (as written or on the
 * opposite side), increased, terminated in part or terminated, with the notional, the amount per
 * 100 notional it was done at, and the realized result of a termination.
 */
function swapFillSummary(app, c) {
  const ccy = c.inst.trading_ccy;
  const before = app.positions.find(c.unit.id, c.inst.id, c.strategyId) || { qty: 0, cost: 0 };
  const dq = c.action === 'buy' ? c.qty : -c.qty;
  const m = app.positions.tradeMath(before, dq, c.price / 100, ccy);
  const what = `${fmtQty(c.qty)} notional of ${c.inst.symbol || c.inst.name}`;
  const at = `at ${fmtPx(c.price)} per 100 notional`;
  const side = dq > 0 ? 'as written' : 'on the opposite side';
  if (isZero(before.qty)) return `Entered ${side}: ${what} ${at}`;
  if (isZero(m.closedQty)) return `Increased ${side}: ${what} ${at}`;
  const realized = ` (realized ${fmt(m.realized, ccy)})`;
  if (!isZero(m.openedQty)) return `Terminated ${fmtQty(Math.abs(before.qty))} notional of ${c.inst.symbol || c.inst.name} and entered ${fmtQty(Math.abs(m.openedQty))} ${side} ${at}${realized}`;
  const left = Math.abs(before.qty) - Math.abs(m.closedQty);
  return isZero(left) ? `Terminated: ${what} ${at}${realized}` : `Terminated in part: ${fmtQty(c.qty)} of ${fmtQty(Math.abs(before.qty))} notional of ${c.inst.symbol || c.inst.name} ${at}${realized}`;
}

/** The "Collateral terms" rows of an OTC contract: the basis it states, and any free-text terms kept on record. */
function collateralRows(inst, app) {
  if (app?.agreements) return app.agreements.describeRows(inst);
  return [['Collateral terms', inst.terms?.collateral || 'None stated']];
}

// ---------------------------------------------------------------------------------------------
// Credit default swaps
// ---------------------------------------------------------------------------------------------

function cdsPeriods(inst, from) {
  const t = inst.terms;
  const dates = cdsDates(t.effective, t.maturity);
  const out = [];
  let start = t.effective;
  for (const d of dates) {
    out.push({ start, end: d, payDate: adjust(d, 'following', paymentCalendarFor(inst)) });
    start = d;
  }
  return out.filter((p) => p.end > from);
}

export const cds = {
  family: 'cds',
  kind: 'security',
  shortRule: 'write',
  label: 'Credit default swap',
  qtyLabel: 'Notional',
  actions: () => ['buy', 'sell'],
  actionLabels: { buy: 'Buy protection (pay premium)', sell: 'Sell protection (receive premium)' },
  priceUnits: () => 'upfront per 100 notional (paid by the protection buyer)',
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    if (!t.referenceEntity) errors.push('Reference entity (or index) is required.');
    t.coupon = num(t.coupon);
    if (t.coupon === null || t.coupon < 0) errors.push('Running coupon is required as a decimal (0.01 = 100 bp).');
    else if (t.coupon > 1) errors.push('The coupon looks like basis points or a percentage; enter it as a decimal (0.01 = 100 bp).');
    if (!ISO_DATE_RE.test(t.maturity || '')) errors.push('Maturity date is required.');
    if (!ISO_DATE_RE.test(t.effective || '')) t.effective = app.clock.today();
    t.recovery = num(t.recovery) ?? 0.4;
    t.indexFactor = num(t.indexFactor) ?? 1;
    t.dayCount = 'ACT/360';
    t.collateralBasis = normalizeBasis(t.collateralBasis, errors);
    if (!t.collateralBasis) delete t.collateralBasis;
    return { terms: t, multiplier: 0.01, errors };
  },
  describe(inst, app) {
    const t = inst.terms;
    const rows = [['Reference', t.referenceEntity], ['Running coupon', `${(t.coupon * 1e4).toFixed(0)} bp, quarterly, ACT/360`], ['Effective', t.effective], ['Maturity', t.maturity], ['Recovery assumption', `${(t.recovery * 100).toFixed(0)}% (used only until a credit event states the real recovery)`]];
    if (t.indexFactor !== 1) rows.push(['Index factor', t.indexFactor]);
    if (t.seniority) rows.push(['Seniority', t.seniority]);
    rows.push(['Counterparty', t.counterparty || 'Simulated counterparty'], ...collateralRows(inst, app));
    return rows;
  },
  qtyStep: () => 1,
  settleDate: (app, inst, tradeDate, book) => standardSettleDate(inst, tradeDate, book),
  /** Notional on which a percentage independent amount is worked out. */
  collateralNotional: (app, inst, { qtyAfter }) => Math.abs(qtyAfter) * (inst.terms.indexFactor ?? 1),
  economics(app, { inst, action, qty, price, unit, strategyId, book }) {
    const upfront = (qty * price) / 100;
    const buy = action === 'buy';
    const annual = qty * inst.terms.indexFactor * inst.terms.coupon;
    // Collateral under the basis the contract states. Nothing is assumed from the product.
    const coll = app.agreements.tradeRequirement({ book, unit, inst, action, qty, price, strategyId, cashOut: Math.max(0, buy ? upfront : -upfront) });
    return {
      ccy: inst.trading_ccy, principal: upfront, cash: buy ? -upfront : upfront, accrued: 0, notional: qty * inst.terms.indexFactor, exposure: null, initialMargin: coll.initialMargin, collateral: coll,
      notes: [`${buy ? 'Pays' : 'Receives'} a running premium of about ${fmt(annual, inst.trading_ccy)} a year, quarterly, until ${inst.terms.maturity} or a credit event.`, 'Premium accrues from the trade date; accrued premium is not exchanged at trade.', ...coll.notes],
    };
  },
  fill(app, c) {
    const r = bookSecurityFill(app, c, { unitCost: c.price / 100 });
    if (r.wasFlat && !isZero(r.position.qty)) app.positions.change(r.position, { data: { premiumFrom: c.tradeDate } });
    return { ...r, position: app.positions.get(r.position.id) };
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const known = mark !== null && mark !== undefined;
    const mv = known ? money((pos.qty * inst.terms.indexFactor * mark) / 100, ccy) : null;
    return { price: known ? mark : null, mv, cost: pos.cost, unrealized: known ? money(mv - pos.cost, ccy) : null, accrued: 0, notional: Math.abs(pos.qty) * inst.terms.indexFactor, exposure: null };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    app.agreements.onPositionChange({ book, unit, inst, pos });
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    const common = { bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id };
    const from = pos.data.premiumPaidThrough || pos.data.premiumFrom || app.clock.today();
    const next = cdsPeriods(inst, from)[0];
    if (next) app.tasks.schedule({ ...common, type: 'cds.premium', dueDate: next.payDate, data: { key: next.end, periodEnd: next.end } });
    app.tasks.schedule({ ...common, type: 'cds.maturity', dueDate: adjust(inst.terms.maturity, 'following', paymentCalendarFor(inst)) });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (!pos || isZero(pos.qty)) return 'done';
    const ccy = inst.trading_ccy;
    const base = { bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine' };
    if (task.type === 'cds.premium') {
      const from = pos.data.premiumPaidThrough || pos.data.premiumFrom || inst.terms.effective;
      const amount = premiumFor(inst, pos, from, task.data.periodEnd);
      const signed = money(-sign(pos.qty) * amount, ccy); // buyer pays
      if (signed < 0 && app.ledger.balance(unit.id, 'cash', ccy) < -signed - 0.004) {
        const msg = `CDS premium of ${fmt(-signed, ccy)} on ${inst.name} could not be paid: insufficient settled ${ccy} cash in ${unit.name}.`;
        app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'task', refId: task.id, message: msg });
        return { failed: msg };
      }
      const eventId = app.ledger.post({
        ...base, type: 'cds.premium', summary: `CDS premium ${signed < 0 ? 'paid' : 'received'} on ${inst.name} for ${from} to ${task.data.periodEnd}: ${fmt(Math.abs(signed), ccy)}`,
        data: { from, to: task.data.periodEnd },
        entries: [{ account: 'cash', ccy, amount: signed, positionId: pos.id }, { account: 'pnl.realized', ccy, amount: -signed, positionId: pos.id }],
      });
      app.alerts.resolve({ refType: 'task', refId: task.id, code: 'funding.failed' });
      const updated = app.positions.change(pos, { data: { premiumPaidThrough: task.data.periodEnd } });
      const next = cdsPeriods(inst, task.data.periodEnd)[0];
      if (next) app.tasks.schedule({ ...base, type: 'cds.premium', dueDate: next.payDate, data: { key: next.end, periodEnd: next.end } });
      void updated;
      return { done: true, eventId };
    }
    if (task.type === 'cds.maturity') {
      const open = app.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE position_id = ? AND type = 'cds.premium' AND status IN ('pending','blocked','failed')`, pos.id).n;
      if (open) return { blocked: 'Waiting for the final premium payment first.', needs: [] };
      const fresh = app.positions.get(pos.id);
      const r = bookSecurityFill(app, { book, unit, inst, action: fresh.qty > 0 ? 'sell' : 'buy', qty: Math.abs(fresh.qty), price: 0, fees: [], strategyId: fresh.strategy_id, tradeDate: inst.terms.maturity, settleDate: app.clock.today(), eventType: 'cds.matured', actor: 'engine', summary: `CDS matured without a credit event: ${inst.name}` }, { unitCost: 0 });
      app.agreements.onPositionChange({ book, unit, inst, pos }); // collateral goes back when the contract ends
      return { done: true, eventId: r.eventId };
    }
    return { failed: `Unknown task ${task.type}` };
  },
  /**
   * Credit event, triggered by hand. `recovery` is the real recovery rate (decimal).
   * `weight` (0-1] is the share of notional affected: 1 for a single name, the constituent weight for an index.
   */
  creditEvent(app, { inst, recovery, weight = 1, date }) {
    const R = num(recovery);
    need(R !== null && R >= 0 && R <= 1, 'Enter the recovery rate as a decimal between 0 and 1.');
    const w = num(weight) ?? 1;
    need(w > 0 && w <= 1, 'Weight must be between 0 and 1.');
    const when = date || app.clock.today();
    const ccy = inst.trading_ccy;
    const out = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const book = app.books.getBook(p.book_id), unit = app.books.getUnit(p.unit_id);
      const from = p.data.premiumPaidThrough || p.data.premiumFrom || inst.terms.effective;
      const affected = Math.abs(p.qty) * inst.terms.indexFactor * w;
      const accruedPremium = money(affected * inst.terms.coupon * yearFraction(from, when > from ? when : from, 'ACT/360'), ccy);
      const protection = money(affected * (1 - R), ccy);
      const net = money(sign(p.qty) * (protection - accruedPremium), ccy); // buyer receives protection, pays accrued premium
      const eventId = app.ledger.post({
        bookId: book.id, unitId: unit.id, type: 'cds.credit_event', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user',
        summary: `Credit event on ${inst.terms.referenceEntity}: protection ${fmt(protection, ccy)} at ${(R * 100).toFixed(1)}% recovery, accrued premium ${fmt(accruedPremium, ccy)}; ${net >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(net), ccy)}`,
        data: { recovery: R, weight: w, affectedNotional: affected, protection, accruedPremium },
        entries: [{ account: 'cash', ccy, amount: net, positionId: p.id }, { account: 'pnl.realized', ccy, amount: -net, positionId: p.id }],
      });
      out.push(eventId);
      if (w >= 1 - 1e-12) {
        bookSecurityFill(app, { book, unit, inst, action: p.qty > 0 ? 'sell' : 'buy', qty: Math.abs(p.qty), price: 0, fees: [], strategyId: p.strategy_id, tradeDate: when, settleDate: when, eventType: 'cds.terminated', actor: 'user', summary: `CDS terminated by credit event: ${inst.name}` }, { unitCost: 0 });
        app.tasks.cancelFor(p.id);
        app.agreements.onPositionChange({ book, unit, inst, pos: p }); // termination releases its collateral
      }
    }
    if (w < 1 - 1e-12) {
      app.instruments.update(inst.id, { terms: { ...inst.terms, indexFactor: inst.terms.indexFactor * (1 - w) } }, { system: true });
      // The surviving notional is smaller, so a percentage independent amount is trued up.
      for (const p of app.positions.heldAround(inst.id)) if (!isZero(p.qty)) app.agreements.onPositionChange({ pos: p });
    }
    return { eventIds: out };
  },
};

function premiumFor(inst, pos, from, to) {
  return Math.abs(pos.qty) * inst.terms.indexFactor * inst.terms.coupon * yearFraction(from, to, 'ACT/360');
}
