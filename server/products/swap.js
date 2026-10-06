// Swaps and credit default swaps.
//
// A swap is never reduced to "buy/sell swap". The contract is a list of legs, each with its own
// side (pay or receive), type, currency, notional, rate or index, spread, schedule and day count.
// One engine covers interest-rate swaps, OIS, basis and cross-currency swaps, inflation swaps,
// total-return and equity swaps, commodity swaps, and caps/floors (a capped or floored floating leg).
//
// Leg types
//   fixed    notional x rate x day-count fraction
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
import { bookSecurityFill, fmtQty } from './common.js';
import { calendarFor } from './security.js';

const LEG_TYPES = ['fixed', 'float', 'ois', 'return', 'price', 'cap', 'floor'];
const pct = (x, dp = 3) => `${(x * 100).toFixed(dp)}%`;

export function describeLeg(leg, app) {
  const side = leg.side === 'pay' ? 'Pay' : 'Receive';
  const freq = leg.months ? `every ${leg.months} month${leg.months > 1 ? 's' : ''}` : 'at maturity';
  const und = leg.underlyingId && app ? app.instruments.get(leg.underlyingId) : null;
  const ref = und ? (und.symbol || und.name) : leg.underlyingName || 'reference asset';
  switch (leg.type) {
    case 'fixed': return `${side} fixed ${pct(leg.rate)} ${leg.ccy}, ${freq}, ${leg.dayCount}`;
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
  return generateSchedule({ start: t.effective, end: t.maturity, months: leg.months || 0, calendar: calendarFor(inst), convention: 'modified-following' });
}

const scheduleFactor = (leg, date) => {
  let f = 1;
  for (const s of leg.notionalSchedule || []) if (s.from <= date) f = s.factor;
  return f;
};

function rateFixing(app, code, date) {
  const o = app.data.rate(code, date);
  if (!o) return null;
  const d = (o.forDate || o.asOf || '').slice(0, 10);
  if (diffDays(d, date) > 7) return null; // too old to be this period's fixing
  return o;
}

/** Contractual amount of one leg for one period, unsigned for side. Returns {amount} or {missing}. */
function legAmount(app, inst, pos, leg, period) {
  const state = pos.data.legs?.[leg.id] || {};
  const scale = pos.data.notionalScale ?? 1;
  const N = Math.abs(pos.qty) * (leg.notionalFactor ?? 1) * scheduleFactor(leg, period.start) * (leg.type === 'price' ? 1 : scale);
  const yf = yearFraction(period.start, period.end, leg.dayCount || 'ACT/360');
  const used = [];
  switch (leg.type) {
    case 'fixed':
      return { amount: N * leg.rate * yf, detail: { notional: N, rate: leg.rate, fraction: yf } };
    case 'float':
    case 'cap':
    case 'floor': {
      const o = rateFixing(app, leg.index, period.start);
      if (!o) return { missing: { kind: 'rate', subject: leg.index, date: period.start } };
      used.push(app.data.recordUsed(o));
      const fix = o.value / 100;
      let r = fix + (leg.spread || 0);
      if (leg.type === 'cap') r = Math.max(fix - leg.strike, 0);
      if (leg.type === 'floor') r = Math.max(leg.strike - fix, 0);
      return { amount: N * r * yf, detail: { notional: N, fixing: o.value, fraction: yf }, used };
    }
    case 'ois': {
      const cal = calendarFor(inst);
      let growth = 1;
      let d = period.start;
      while (d < period.end) {
        let next = addDays(d, 1);
        while (next < period.end && !isBusinessDay(next, cal)) next = addDays(next, 1);
        const o = rateFixing(app, leg.index, d);
        if (!o) return { missing: { kind: 'rate', subject: leg.index, date: d } };
        growth *= 1 + ((o.value / 100) * diffDays(d, next)) / 360;
        d = next;
      }
      return { amount: N * (growth - 1 + (leg.spread || 0) * yf), detail: { notional: N, compounded: growth - 1, fraction: yf } };
    }
    case 'return': {
      let p0 = state.lastFixing ?? inst.terms.initialPrices?.[leg.id] ?? null;
      if (p0 === null) {
        const o0 = app.data.closeFor(leg.underlyingId, period.start);
        if (!o0 || o0.value === null) return { missing: { kind: 'price', subject: leg.underlyingId, date: period.start } };
        p0 = o0.value;
        used.push(app.data.recordUsed(o0));
      }
      const o1 = app.data.closeFor(leg.underlyingId, period.end);
      if (!o1 || o1.value === null) return { missing: { kind: 'price', subject: leg.underlyingId, date: period.end } };
      used.push(app.data.recordUsed(o1));
      return { amount: N * (o1.value / p0 - 1), detail: { notional: N, start: p0, end: o1.value }, used, fixing: o1.value, ratio: o1.value / p0 };
    }
    case 'price': {
      const units = Math.abs(pos.qty) * (leg.units ?? 1) * scheduleFactor(leg, period.start);
      if (leg.fixedPrice !== null && leg.fixedPrice !== undefined) return { amount: units * leg.fixedPrice, detail: { units, price: leg.fixedPrice } };
      const o = app.data.closeFor(leg.underlyingId, period.end);
      if (!o || o.value === null) return { missing: { kind: 'price', subject: leg.underlyingId, date: period.end } };
      used.push(app.data.recordUsed(o));
      return { amount: units * o.value, detail: { units, price: o.value }, used };
    }
    default:
      return { amount: 0, detail: {} };
  }
}

/** Keep exchanged notionals (cross-currency legs) in line with the open position. */
function trueUpNotionalExchange(app, { book, unit, inst, pos, date }) {
  const t = inst.terms;
  const live = !isZero(pos.qty) && date >= t.effective && date < t.maturity;
  for (const leg of t.legs) {
    if (!leg.exchangeNotional) continue;
    // Holding the swap as written: a pay leg means we received that currency's notional at the start.
    const s = sign(pos.qty) * (leg.side === 'pay' ? 1 : -1);
    const target = live ? money(s * Math.abs(pos.qty) * (leg.notionalFactor ?? 1), leg.ccy) : 0;
    // Position-tagged exchanged notional: + means we hold the cash and owe it back.
    const held = -(app.ledger.positionBalance(pos.id, 'loan.liab', leg.ccy) + app.ledger.positionBalance(pos.id, 'loan.asset', leg.ccy));
    const delta = money(target - held, leg.ccy);
    if (delta === 0) continue;
    const account = (target || held) > 0 ? 'loan.liab' : 'loan.asset';
    app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'swap.notional_exchange', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
      summary: `Notional exchange on ${inst.name}: ${delta > 0 ? 'received' : 'paid'} ${fmt(Math.abs(delta), leg.ccy)}`,
      data: { legId: leg.id, target, held },
      entries: [{ account: 'cash', ccy: leg.ccy, amount: delta, positionId: pos.id }, { account, ccy: leg.ccy, amount: -delta, positionId: pos.id }],
    });
  }
}

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
  app.tasks.schedule({ ...common, type: 'swap.maturity', dueDate: adjust(inst.terms.maturity, 'modified-following', calendarFor(inst)) });
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
      }
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
    const ccy = t.legs[0]?.ccy || draft.trading_ccy;
    // Independent amount: cash collateral posted at trade as a share of notional, returned when the swap ends.
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
    rows.push(['Collateral terms', t.initialMarginPct ? `Independent amount of ${(t.initialMarginPct * 100).toFixed(2)}% of notional, posted in cash at trade and returned when the swap ends${t.collateral ? `. ${t.collateral}` : ''}` : t.collateral || 'None stated: no collateral is posted']);
    return rows;
  },
  qtyStep: () => 1,
  settleDate(app, inst, tradeDate, book) {
    return addBusinessDays(tradeDate, inst.terms?.settleDays ?? book.settings.settlement.swap ?? 2, calendarFor(inst));
  },
  economics(app, { inst, action, qty, price, unit, strategyId }) {
    const upfront = (qty * price) / 100;
    const buy = action === 'buy';
    const notes = ['Notional is not paid. Only the upfront amount (if any) settles at trade; each leg then pays on its schedule.'];
    for (const l of inst.terms.legs) notes.push(`Leg ${l.id}: ${buy ? describeLeg(l, app) : describeLeg({ ...l, side: l.side === 'pay' ? 'receive' : 'pay' }, app)}`);
    // Collateral to post (or get back) for the position this trade leaves.
    const pct = inst.terms.initialMarginPct || 0;
    const pos = unit && !inst.draft ? app.positions.find(unit.id, inst.id, strategyId || '') : null;
    const after = Math.abs((pos?.qty || 0) + (buy ? qty : -qty));
    const held = pos ? app.ledger.positionBalance(pos.id, 'cash.margin', inst.trading_ccy) : 0;
    const initialMargin = money(after * pct - held, inst.trading_ccy);
    if (pct) notes.push(`Independent amount: ${(pct * 100).toFixed(2)}% of notional is posted as cash collateral and returned when the swap ends.`);
    return { ccy: inst.trading_ccy, principal: upfront, cash: buy ? -upfront : upfront, accrued: 0, notional: qty, exposure: null, initialMargin, notes };
  },
  fill(app, c) {
    const r = bookSecurityFill(app, c, { unitCost: c.price / 100 });
    if (r.wasFlat && !isZero(r.position.qty)) app.positions.change(r.position, { data: { cashflowsFrom: c.tradeDate, legs: {}, notionalScale: 1 } });
    return { ...r, position: app.positions.get(r.position.id) };
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const known = mark !== null && mark !== undefined;
    const mv = known ? money((pos.qty * mark) / 100, ccy) : null;
    return { price: known ? mark : null, mv, cost: pos.cost, unrealized: known ? money(mv - pos.cost, ccy) : null, accrued: 0, notional: Math.abs(pos.qty) * (pos.data.notionalScale ?? 1), exposure: null };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    trueUpNotionalExchange(app, { book, unit, inst, pos, date: app.clock.today() });
    trueUpCollateral(app, { book, unit, inst, pos: app.positions.get(pos.id) });
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    scheduleLegTasks(app, { book, unit, inst, pos: app.positions.get(pos.id) });
  },
  dataNeeds(app, { inst, task }) {
    const out = { rateCodes: [], closes: [], instruments: [] };
    if (!task) return out; // swaps accrue nothing in the ledger between payment dates
    const leg = inst.terms.legs.find((l) => l.id === task.data?.legId);
    if (leg && task.data?.periodEnd) out.rateFrom = addDays(addMonths(task.data.periodEnd, -(leg.months || 12)), -10);
    else out.rateFrom = addDays(inst.terms.effective, -10);
    for (const l of inst.terms.legs) {
      if (l.index) out.rateCodes.push(l.index);
      if (l.underlyingId) {
        const u = app.instruments.get(l.underlyingId);
        if (u) {
          out.instruments.push(u);
          if (task?.data?.periodEnd) out.closes.push({ instrument: u, date: task.data.periodEnd });
        }
      }
    }
    return out;
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (!pos || isZero(pos.qty)) return 'done';
    const t = inst.terms;
    const base = { bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine' };
    const awaiting = app.data.describe().awaitingMessage;

    if (task.type === 'swap.notional') {
      trueUpNotionalExchange(app, { book, unit, inst, pos, date: app.clock.today() });
      return 'done';
    }

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
      const amount = money(s * r.amount, leg.ccy);
      if (amount < 0 && app.ledger.balance(unit.id, 'cash', leg.ccy) < -amount - 0.004) {
        const msg = `Swap payment of ${fmt(-amount, leg.ccy)} on ${inst.name} (leg ${leg.id}) could not be paid: insufficient settled ${leg.ccy} cash in ${unit.name}.`;
        app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'task', refId: task.id, message: msg });
        return { failed: msg };
      }
      const eventId = app.ledger.post({
        ...base, type: 'swap.payment',
        summary: `Swap ${amount >= 0 ? 'receipt' : 'payment'} on ${inst.name}, leg ${leg.id} (${leg.type}), period ${eff.start} to ${period.end}: ${fmt(Math.abs(amount), leg.ccy)}`,
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
      const nextIdx = sched.findIndex((p) => p.end === period.end) + 1;
      if (nextIdx < sched.length) app.tasks.schedule({ ...base, type: 'swap.payment', dueDate: sched[nextIdx].payDate, data: { key: `${leg.id}:${sched[nextIdx].end}`, legId: leg.id, periodEnd: sched[nextIdx].end } });
      void updated;
      return { done: true, eventId };
    }

    if (task.type === 'swap.maturity') {
      const open = app.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE position_id = ? AND type = 'swap.payment' AND status IN ('pending','blocked','failed')`, pos.id).n;
      if (open) return { blocked: 'Waiting for the final leg payments to be made first.', needs: [] };
      const fresh = app.positions.get(pos.id);
      const r = bookSecurityFill(app, {
        book, unit, inst, action: fresh.qty > 0 ? 'sell' : 'buy', qty: Math.abs(fresh.qty), price: 0, fees: [], strategyId: fresh.strategy_id, tradeDate: t.maturity, settleDate: app.clock.today(),
        eventType: 'swap.matured', actor: 'engine', summary: `Swap matured: ${inst.name} (notional ${fmtQty(Math.abs(fresh.qty))})`,
      }, { unitCost: 0 });
      trueUpNotionalExchange(app, { book, unit, inst, pos: app.positions.get(pos.id), date: app.clock.today() });
      trueUpCollateral(app, { book, unit, inst, pos: app.positions.get(pos.id) });
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
 * Keep the cash collateral posted on a swap equal to its independent amount: post when the
 * position opens or grows, release when it shrinks or ends. Collateral stays the unit's own asset
 * (margin posted); it is not an expense.
 */
function trueUpCollateral(app, { book, unit, inst, pos }) {
  if (!pos) return null;
  const ccy = inst.trading_ccy;
  const target = money(Math.abs(pos.qty) * (inst.terms.initialMarginPct || 0), ccy);
  const held = app.ledger.positionBalance(pos.id, 'cash.margin', ccy);
  const delta = money(target - held, ccy);
  if (delta === 0) return null;
  return app.ledger.post({
    bookId: book.id, unitId: unit.id, type: 'swap.collateral', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
    summary: `Collateral ${delta > 0 ? 'posted' : 'returned'} on ${inst.name}: ${fmt(Math.abs(delta), ccy)} (independent amount ${((inst.terms.initialMarginPct || 0) * 100).toFixed(2)}% of ${fmtQty(Math.abs(pos.qty))} notional)`,
    data: { target, held, delta },
    entries: [{ account: 'cash.margin', ccy, amount: delta, positionId: pos.id }, { account: 'cash', ccy, amount: -delta, positionId: pos.id }],
  });
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
    out.push({ start, end: d, payDate: adjust(d, 'following', calendarFor(inst)) });
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
    return { terms: t, multiplier: 0.01, errors };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Reference', t.referenceEntity], ['Running coupon', `${(t.coupon * 1e4).toFixed(0)} bp, quarterly, ACT/360`], ['Effective', t.effective], ['Maturity', t.maturity], ['Recovery assumption', `${(t.recovery * 100).toFixed(0)}% (used only until a credit event states the real recovery)`]];
    if (t.indexFactor !== 1) rows.push(['Index factor', t.indexFactor]);
    if (t.seniority) rows.push(['Seniority', t.seniority]);
    rows.push(['Counterparty', t.counterparty || 'Simulated counterparty'], ['Collateral terms', t.collateral || 'None stated']);
    return rows;
  },
  qtyStep: () => 1,
  settleDate(app, inst, tradeDate, book) {
    return addBusinessDays(tradeDate, inst.terms?.settleDays ?? book.settings.settlement.cds ?? 1, calendarFor(inst));
  },
  economics(app, { inst, action, qty, price }) {
    const upfront = (qty * price) / 100;
    const buy = action === 'buy';
    const annual = qty * inst.terms.indexFactor * inst.terms.coupon;
    return {
      ccy: inst.trading_ccy, principal: upfront, cash: buy ? -upfront : upfront, accrued: 0, notional: qty * inst.terms.indexFactor, exposure: null, initialMargin: 0,
      notes: [`${buy ? 'Pays' : 'Receives'} a running premium of about ${fmt(annual, inst.trading_ccy)} a year, quarterly, until ${inst.terms.maturity} or a credit event.`, 'Premium accrues from the trade date; accrued premium is not exchanged at trade.'],
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
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    const common = { bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id };
    const from = pos.data.premiumPaidThrough || pos.data.premiumFrom || app.clock.today();
    const next = cdsPeriods(inst, from)[0];
    if (next) app.tasks.schedule({ ...common, type: 'cds.premium', dueDate: next.payDate, data: { key: next.end, periodEnd: next.end } });
    app.tasks.schedule({ ...common, type: 'cds.maturity', dueDate: adjust(inst.terms.maturity, 'following', calendarFor(inst)) });
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
      }
    }
    if (w < 1 - 1e-12) app.instruments.update(inst.id, { terms: { ...inst.terms, indexFactor: inst.terms.indexFactor * (1 - w) } }, { system: true });
    return { eventIds: out };
  },
};

function premiumFor(inst, pos, from, to) {
  return Math.abs(pos.qty) * inst.terms.indexFactor * inst.terms.coupon * yearFraction(from, to, 'ACT/360');
}
