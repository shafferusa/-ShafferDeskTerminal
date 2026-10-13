// Swaps the catalog marks as partly supported, each with what makes it that product (s3, 2026-10-13). Used by the
// `swap` plugin in products/swap.js through a few small hooks; everything else about a swap is the plugin's own.
//
//   non-deliverable swap   legs worked out in their own currency (INR, BRL, KRW ...) and paid in the contract's
//                          settlement currency (`terms.settlementCcy`) at the FX fixing of the fixing date (the payment
//                          date less `terms.fixingLag` business days of the payment calendar). The fixing is the one
//                          entered by hand for that date (Data connection, Manual entries, FX rate, with its fixing date):
//                          the payment waits visibly until it is there. Nothing is ever paid in the leg's own currency.
//   CMS spread swap        a floating leg on the difference of two constant-maturity rates: (index - index2 + spread),
//                          each the fixing of the period start; either missing blocks the payment, naming it.
//   callable / puttable    `terms.callRight = { kind: 'call' | 'put', by: 'written' | 'opposite', dates: [...] }`: the
//                          right to end the swap on one of its dates, held by the party that entered the contract as
//                          written or by the other. Exercised by hand on the position (Lifecycle) on an exercise date only:
//                          each leg's amount accrued since its last payment is settled, and the swap ends at no further cost.
//   quanto                 a leg worked out in another currency (`quantoCcy`) on the notional at the contract's fixed rate
//                          (`quantoRate`, payment currency per unit of it), and paid in its own currency at that same rate:
//                          spot FX plays no part.
//   equity basket          a return leg on a basket (`basket`, names and weights, recorded) whose level is entered by hand
//                          on each payment item (Accounting, Pending), from `initialLevel`.
//   loan TRS               pass-through recorded by hand on the position: the reference loan's interest (an amount per 100
//                          of notional) and principal repaid (a share of the notional, at the repayment price, against the
//                          last fixing): the repaid notional leaves the swap with its return and its accrued financing.
//   dividend swap          a `dividend` leg: units x the cash dividends per share with an ex-date in the period, recorded by
//                          hand on the reference stock (Instrument, Dividends and corporate actions), against a fixed price leg.

import { fmt } from '../core/books.js';
import { addBusinessDays } from '../quant/calendar.js';
import { yearFraction } from '../quant/daycount.js';
import { CCY_RE, ISO_DATE_RE, isZero, money, need, num, sign } from '../core/util.js';
import { paymentCalendarFor } from './security.js';

export const PARTIAL_LEG_TYPES = ['dividend'];
const RIGHT_WORD = { call: 'call', put: 'put' };
const pct = (x, dp = 3) => `${(x * 100).toFixed(dp)}%`;
const nameOf = (inst) => inst.symbol || inst.name;
const fx = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 6 });
const exact14 = (x) => (Number.isFinite(x) ? Number(x.toPrecision(14)) : x);

/** The leg fields of these products, checked and completed. `l` is changed in place. */
export function normalizePartialLeg(l, at, errors) {
  if (l.type === 'float' && l.index2) l.index2 = String(l.index2).trim();
  else delete l.index2;
  const hasQuanto = Boolean(l.quantoCcy) || (l.quantoRate !== undefined && l.quantoRate !== null && l.quantoRate !== '');
  if (hasQuanto) {
    l.quantoCcy = String(l.quantoCcy || '').toUpperCase();
    l.quantoRate = num(l.quantoRate);
    if (!CCY_RE.test(l.quantoCcy)) errors.push(`${at}: the quanto currency (the currency the payoff is worked out in) is required.`);
    if (!(l.quantoRate > 0)) errors.push(`${at}: the fixed conversion rate (${l.ccy} per ${l.quantoCcy || 'unit'}) is required and must be positive.`);
    if (!['fixed', 'float', 'return'].includes(l.type)) errors.push(`${at}: a quanto conversion applies to a fixed, floating or return leg.`);
    if (l.quantoCcy && l.quantoCcy === l.ccy) errors.push(`${at}: a quanto leg is worked out in another currency than the one it pays in.`);
  } else { delete l.quantoCcy; delete l.quantoRate; }
  if (l.type === 'return' && l.basket) {
    const parts = Array.isArray(l.basket) ? l.basket : String(l.basket).split(/[;\n]/).map((x) => x.trim()).filter(Boolean).map((x) => { const m = x.match(/^(.*?)[:=]\s*([\d.]+)\s*%?$/); return m ? { name: m[1].trim(), weight: num(m[2]) > 1 ? num(m[2]) / 100 : num(m[2]) } : { name: x, weight: null }; });
    l.basket = parts.map((b) => ({ name: String(b.name || '').trim(), weight: num(b.weight) }));
    if (l.basket.length < 2 || l.basket.some((b) => !b.name || !(b.weight > 0))) errors.push(`${at}: a basket names at least two constituents, each with its weight ("NAME: 0.25; ...").`);
    const total = l.basket.reduce((s, b) => s + (b.weight || 0), 0);
    if (l.basket.length >= 2 && Math.abs(total - 1) > 1e-6) errors.push(`${at}: the basket weights add up to ${Number(total.toFixed(6))}, not 1.`);
    l.initialLevel = num(l.initialLevel);
    if (!(l.initialLevel > 0)) errors.push(`${at}: the initial basket level (the level the first period starts from) is required.`);
    delete l.underlyingId;
  } else if (l.type === 'return') { delete l.basket; delete l.initialLevel; }
  if (l.type === 'dividend') {
    if (!l.underlyingId) errors.push(`${at}: choose the stock whose dividends the leg pays.`);
    l.units = num(l.units) ?? 1;
    if (!(l.units > 0)) errors.push(`${at}: units per unit of notional must be positive.`);
  }
}

/** The contract fields of these products, checked and completed; returns the currencies a trading currency may be. */
export function normalizePartialTerms(productId, t, errors) {
  const legCcys = (t.legs || []).map((l) => l.ccy).filter((c) => CCY_RE.test(c));
  if (t.settlementCcy) {
    t.settlementCcy = String(t.settlementCcy).toUpperCase();
    if (!CCY_RE.test(t.settlementCcy)) errors.push('The settlement currency is a three-letter code.');
    t.fixingLag = num(t.fixingLag) ?? 2;
    if (!(Number.isInteger(t.fixingLag) && t.fixingLag >= 0 && t.fixingLag <= 5)) errors.push('The FX fixing lag is a whole number of business days from 0 to 5.');
    if (legCcys.length && legCcys.every((c) => c === t.settlementCcy)) errors.push(`Every leg is in ${t.settlementCcy}: a non-deliverable swap has at least one leg worked out in another currency.`);
    if (t.legs.some((l) => l.exchangeNotional)) errors.push('A non-deliverable swap exchanges no principal.');
  } else { delete t.settlementCcy; delete t.fixingLag; }
  if (productId === 'non_deliverable_swap' && !t.settlementCcy) errors.push('A non-deliverable swap states its settlement currency (the currency every payment is made in).');
  if (t.callRight) {
    const r = { ...t.callRight };
    r.kind = r.kind === 'put' ? 'put' : 'call';
    r.by = r.by === 'opposite' ? 'opposite' : 'written';
    const dates = Array.isArray(r.dates) ? r.dates : String(r.dates || '').split(/[;,\s]+/).filter(Boolean);
    r.dates = [...new Set(dates.map(String))].sort();
    if (!r.dates.length || r.dates.some((d) => !ISO_DATE_RE.test(d))) errors.push(`The ${r.kind} dates are required as YYYY-MM-DD, separated by ";".`);
    else if (t.effective && t.maturity && r.dates.some((d) => d <= t.effective || d >= t.maturity)) errors.push(`Every ${r.kind} date falls after the effective date and before maturity.`);
    t.callRight = r;
  }
  if (['callable_swap', 'puttable_swap'].includes(productId) && !t.callRight) errors.push(`A ${productId === 'callable_swap' ? 'callable' : 'puttable'} swap states its ${productId === 'callable_swap' ? 'call' : 'put'} dates and who holds the right.`);
  return t.settlementCcy ? [...legCcys, t.settlementCcy] : legCcys;
}

/** Description rows of these products' terms. */
export function partialRows(inst, app) {
  const t = inst.terms;
  const rows = [];
  if (t.settlementCcy) rows.push(['Settlement', `Non-deliverable: every payment is made in ${t.settlementCcy}, converted at the FX fixing ${t.fixingLag} business day${t.fixingLag === 1 ? '' : 's'} before the payment date (entered by hand with its fixing date); nothing is paid in ${[...new Set(t.legs.map((l) => l.ccy).filter((c) => c !== t.settlementCcy))].join(', ')}`]);
  if (t.callRight) rows.push([t.callRight.kind === 'put' ? 'Put right' : 'Call right', `Held by the party that ${t.callRight.by === 'written' ? 'enters the contract as written' : 'enters the opposite side'}; exercisable on ${t.callRight.dates.join(', ')} (recorded by hand on that date): the amounts accrued since the last payments are settled and the swap ends`]);
  for (const l of t.legs) {
    if (l.index2) rows.push([`Leg ${l.id} rate`, `${l.index} - ${l.index2}${l.spread ? ` ${l.spread > 0 ? '+' : '-'} ${pct(Math.abs(l.spread), 2)}` : ''}, each fixed at the period start (constant-maturity spread)`]);
    if (l.quantoRate) rows.push([`Leg ${l.id} quanto`, `Worked out in ${l.quantoCcy} on the notional at the fixed rate ${fx(l.quantoRate)} ${l.ccy} per ${l.quantoCcy}, paid in ${l.ccy} at that same rate`]);
    if (l.basket) rows.push([`Leg ${l.id} basket`, `${l.basket.map((b) => `${b.name} ${pct(b.weight, 2)}`).join('; ')}; initial level ${l.initialLevel}; the level at each reset is entered by hand on the payment item`]);
    if (l.type === 'dividend') {
      const u = app?.instruments.get(l.underlyingId);
      rows.push([`Leg ${l.id} dividends`, `${l.units} x the cash dividends per share of ${u ? u.symbol || u.name : 'the reference stock'} with an ex-date in each period, as recorded on it by hand`]);
    }
  }
  return rows;
}

/**
 * The amount of one of these legs for one period, or null when the leg is an ordinary one. `deps.legAmount` is the
 * plugin's own calculation, used for the parts that are ordinary.
 */
export function partialLegAmount(app, inst, pos, leg, period, deps) {
  if (leg.quantoRate) {
    // Worked out in the quanto currency on the notional at the fixed rate, then paid at that same rate.
    const base = deps.legAmount(app, inst, pos, { ...leg, quantoRate: undefined, quantoCcy: undefined, ccy: leg.quantoCcy, notionalFactor: (leg.notionalFactor ?? 1) / leg.quantoRate }, period);
    if (base.missing) return base;
    const local = money(exact14(base.amount), leg.quantoCcy);
    const how = leg.type === 'return' && base.ratio ? `return ${base.ratio >= 1 ? '+' : ''}${((base.ratio - 1) * 100).toFixed(3)}% on ${fmt(base.detail.notional, leg.quantoCcy)}` : `on ${fmt(base.detail.notional, leg.quantoCcy)}`;
    return { ...base, amount: base.amount * leg.quantoRate, note: `worked out in ${leg.quantoCcy}: ${fmt(Math.abs(local), leg.quantoCcy)}, ${how}, converted at the fixed rate ${fx(leg.quantoRate)}`, detail: { ...base.detail, quanto: { ccy: leg.quantoCcy, amount: base.amount, rate: leg.quantoRate } } };
  }
  if (leg.type === 'float' && leg.index2) {
    const one = deps.legAmount(app, inst, pos, { ...leg, index2: undefined }, period);
    if (one.missing) return one;
    const two = deps.legAmount(app, inst, pos, { ...leg, index: leg.index2, index2: undefined, spread: 0 }, period);
    if (two.missing) return two;
    return { amount: one.amount - two.amount, detail: { notional: one.detail.notional, fixing: one.detail.fixing, fixing2: two.detail.fixing, fraction: one.detail.fraction }, used: [...(one.used || []), ...(two.used || [])] };
  }
  if (leg.type === 'return' && leg.basket) {
    const state = pos.data.legs?.[leg.id] || {};
    const p0 = state.lastFixing ?? leg.initialLevel;
    const p1 = num(period.basketLevel);
    const date = deps.fixingDate(inst, period.end);
    if (p1 === null) return { missing: { kind: 'basket-level', subject: leg.id, date, message: `Awaiting the basket level of ${date} for leg ${leg.id} of ${nameOf(inst)}: the composite is not supplied by any service. Enter it by hand on this item (Accounting, Pending).` } };
    const N = Math.abs(pos.qty) * (leg.notionalFactor ?? 1) * (pos.data.notionalScale ?? 1);
    return { amount: N * (p1 / p0 - 1), detail: { notional: N, start: p0, end: p1, basket: true }, fixing: p1, ratio: p1 / p0 };
  }
  if (leg.type === 'dividend') {
    const units = Math.abs(pos.qty) * (leg.units ?? 1);
    const divs = app.corpactions.list(leg.underlyingId).filter((c) => c.type === 'cash_dividend' && c.status !== 'cancelled' && c.ex_date >= period.start && c.ex_date < period.end).sort((a, b) => (a.ex_date < b.ex_date ? -1 : 1));
    const perShare = Number(divs.reduce((s, c) => s + c.amount, 0).toFixed(10));
    return { amount: units * perShare, detail: { units, perShare, dividends: divs.map((c) => ({ exDate: c.ex_date, amount: c.amount })) } };
  }
  return null;
}

/** The FX fixing of `pair` ('USD/INR') entered by hand for exactly `date`: { rate (quote per base), obs } or null. */
function fixingOn(app, base, quote, date) {
  const direct = app.data.latestManual('fx', `${base}/${quote}`, { forDate: date });
  if (direct?.value > 0) return { rate: direct.value, pair: `${base}/${quote}`, obs: direct };
  const inverse = app.data.latestManual('fx', `${quote}/${base}`, { forDate: date });
  if (inverse?.value > 0) return { rate: 1 / inverse.value, pair: `${quote}/${base}`, quoted: inverse.value, obs: inverse };
  return null;
}

/**
 * A payment of a non-deliverable leg: worked out in the leg's currency, paid in the settlement currency at the fixing.
 * Returns the task outcome. `ctx` carries what the plugin's payment code has worked out (period, amount in leg currency).
 */
export function nonDeliverablePayment(app, task, { book, unit, inst, pos, leg, sched, period, eff, r, base, exact }) {
  const t = inst.terms;
  const S = t.settlementCcy;
  const cal = paymentCalendarFor(inst);
  const fixDate = addBusinessDays(period.payDate, -t.fixingLag, cal);
  const f = fixingOn(app, S, leg.ccy, fixDate);
  if (!f) {
    return { blocked: `Awaiting the ${S}/${leg.ccy} settlement fixing of ${fixDate} for leg ${leg.id} of ${inst.name}: a non-deliverable payment is made in ${S} at that fixing. Enter it by hand (Data connection, Manual entries, FX rate, with its fixing date).`, needs: [{ kind: 'fx', subject: `${S}/${leg.ccy}`, date: fixDate }] };
  }
  const s = sign(pos.qty) * (leg.side === 'receive' ? 1 : -1);
  const local = money(s * exact(r.amount), leg.ccy);
  const amount = money(exact(local / f.rate), S);
  if (amount < 0 && app.ledger.balance(unit.id, 'cash', S) < -amount - 0.004) {
    const msg = `Swap payment of ${fmt(-amount, S)} on ${inst.name} (leg ${leg.id}) could not be paid: insufficient settled ${S} cash in ${unit.name}.`;
    app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'task', refId: task.id, message: msg });
    return { failed: msg };
  }
  const rateText = f.quoted !== undefined ? `${f.pair} fixing of ${fixDate} (${fx(f.quoted)})` : `${f.pair} fixing of ${fixDate} (${fx(f.rate)})`;
  const eventId = app.ledger.post({
    ...base, type: 'swap.payment',
    summary: `Swap ${amount >= 0 ? 'receipt' : 'payment'} on ${inst.name}, leg ${leg.id} (${leg.type}), period ${eff.start} to ${period.end}: ${fmt(Math.abs(local), leg.ccy)}, settled in ${S} at the ${rateText}: ${fmt(Math.abs(amount), S)}`,
    data: { legId: leg.id, period: eff, detail: r.detail, obsIds: [...(r.used || []), app.data.recordUsed(f.obs)], local: { ccy: leg.ccy, amount: local }, fixing: { pair: f.pair, date: fixDate, rate: f.rate } },
    entries: [{ account: 'cash', ccy: S, amount, positionId: pos.id }, { account: 'pnl.realized', ccy: S, amount: -amount, positionId: pos.id }],
  });
  app.alerts.resolve({ refType: 'task', refId: task.id, code: 'funding.failed' });
  const legs = { ...(pos.data.legs || {}) };
  legs[leg.id] = { ...(legs[leg.id] || {}), paidThrough: period.end };
  app.positions.change(pos, { data: { legs } });
  const nextIdx = sched.findIndex((p) => p.end === period.end) + 1;
  if (nextIdx < sched.length) app.tasks.schedule({ ...base, type: 'swap.payment', dueDate: sched[nextIdx].payDate, data: { key: `${leg.id}:${sched[nextIdx].end}`, legId: leg.id, periodEnd: sched[nextIdx].end } });
  return { done: true, eventId };
}

/** The basket level entered by hand on a payment item. */
export function setBasketLevel(app, task, value) {
  const inst = app.instruments.get(task.instrument_id);
  const leg = inst?.terms?.legs?.find((l) => l.id === task.data?.legId);
  need(leg?.basket, 'A basket level is entered on the payment item of a basket return leg.');
  const v = num(value);
  need(v !== null && v > 0, 'Enter the basket level as a positive number.');
  app.tasks.setData(task.id, { ...task.data, basketLevel: v, basketLevelAt: app.clock.now().toISOString() });
  return { ok: true };
}

/** Plugin methods for the position's Lifecycle menu. `deps` are the plugin's own helpers. */
export function partialMethods(deps) {
  const { legAmount, legSchedule, bookSecurityFill, exact } = deps;

  /** The amount each rate leg has accrued from its last payment to `to`, signed for the holder. */
  function accruedLegs(app, inst, pos, to, keep = (l) => ['fixed', 'float', 'ois', 'cap', 'floor'].includes(l.type)) {
    const out = [];
    for (const leg of inst.terms.legs) {
      if (!keep(leg)) continue;
      const paid = pos.data.legs?.[leg.id]?.paidThrough;
      const sched = legSchedule(inst, leg);
      const current = sched.find((p) => p.end > (paid || '0000-00-00'));
      if (!current) continue;
      const opened = pos.data.cashflowsFrom || inst.terms.effective;
      const from = paid && paid > current.start ? paid : current.start > opened ? current.start : opened;
      if (from >= to) continue;
      const r = legAmount(app, inst, pos, leg, { ...current, start: from, end: to });
      if (r.missing) return { missing: r.missing, leg };
      const s = sign(pos.qty) * (leg.side === 'receive' ? 1 : -1);
      out.push({ leg, from, amount: money(s * exact(r.amount), leg.ccy), detail: r.detail, used: r.used || [] });
    }
    return { rows: out };
  }

  return {
    /**
     * The call or put of a callable or puttable swap, exercised by hand on one of its dates: by us (the right must be
     * ours) or by the counterparty (it must be theirs). The legs' amounts accrued since their last payment are settled
     * and the swap ends at no further cost.
     */
    exerciseTermination(app, { book, unit, inst, pos }, body) {
      const t = inst.terms;
      const right = t.callRight;
      need(right, `${nameOf(inst)} has no call or put: it ends early only by a termination at an agreed amount.`);
      const word = RIGHT_WORD[right.kind];
      need(!isZero(pos.qty), 'This position is closed.');
      const today = app.clock.today();
      need(right.dates.includes(today), `${nameOf(inst)} can be ${word === 'call' ? 'called' : 'put'} only on its ${word} dates (${right.dates.join(', ')}); today is ${today}.`);
      const ours = (pos.qty > 0 ? 'written' : 'opposite') === right.by;
      const by = body.by === 'counterparty' ? 'counterparty' : 'us';
      need(by === 'us' ? ours : !ours, by === 'us'
        ? `The ${word} on ${nameOf(inst)} belongs to the party that ${right.by === 'written' ? 'entered it as written' : 'entered the opposite side'}; this position is the other side, so it cannot exercise it. Record the counterparty's exercise instead.`
        : `The ${word} on ${nameOf(inst)} belongs to this position: the counterparty cannot exercise it. Record our own exercise instead.`);
      const acc = accruedLegs(app, inst, pos, today);
      need(!acc.missing, acc.missing ? `The amount accrued on leg ${acc.leg.id} needs the ${acc.missing.subject} fixing of ${acc.missing.date}: enter it first.` : '');
      const net = {};
      for (const x of acc.rows) net[x.leg.ccy] = money((net[x.leg.ccy] || 0) + x.amount, x.leg.ccy);
      for (const [ccy, amount] of Object.entries(net)) {
        if (amount < 0) need(app.ledger.balance(unit.id, 'cash', ccy) >= -amount - 0.004, `The accrued amounts to settle on exercise come to ${fmt(-amount, ccy)} to pay, and ${unit.name} has ${fmt(Math.max(app.ledger.balance(unit.id, 'cash', ccy), 0), ccy)} of settled ${ccy} cash.`);
      }
      const who = by === 'us' ? 'by us' : 'by the counterparty';
      let eventId = null;
      if (acc.rows.length) {
        eventId = app.ledger.post({
          bookId: book.id, unitId: unit.id, type: 'swap.exercise', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
          summary: `${word === 'call' ? 'Call' : 'Put'} of ${nameOf(inst)} exercised ${who} on ${today}, recorded by hand: accrued amounts settled, ${acc.rows.map((x) => `leg ${x.leg.id} (${x.leg.type}) ${x.from} to ${today} ${x.amount >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(x.amount), x.leg.ccy)}`).join('; ')}`,
          data: { right: right.kind, by, legs: acc.rows.map((x) => ({ legId: x.leg.id, from: x.from, to: today, amount: x.amount, detail: x.detail })), obsIds: acc.rows.flatMap((x) => x.used) },
          entries: acc.rows.flatMap((x) => (x.amount ? [{ account: 'cash', ccy: x.leg.ccy, amount: x.amount, positionId: pos.id }, { account: 'pnl.realized', ccy: x.leg.ccy, amount: -x.amount, positionId: pos.id }] : [])),
        });
      }
      const legs = { ...(pos.data.legs || {}) };
      for (const leg of inst.terms.legs) legs[leg.id] = { ...(legs[leg.id] || {}), paidThrough: today };
      const fresh = app.positions.change(pos, { data: { legs } });
      const r = bookSecurityFill(app, {
        book, unit, inst, action: fresh.qty > 0 ? 'sell' : 'buy', qty: Math.abs(fresh.qty), price: 0, fees: [], strategyId: fresh.strategy_id, tradeDate: today, settleDate: today,
        eventType: 'swap.terminated', actor: 'user', summary: `Terminated on the exercise of the ${word} ${who}: ${Number(Math.abs(fresh.qty)).toLocaleString('en-US')} notional of ${nameOf(inst)} at 0.00 per 100 notional`,
      }, { unitCost: 0 });
      app.tasks.cancelFor(pos.id);
      return { eventId: eventId || r.eventId, settled: net };
    },

    /**
     * A loan total-return swap's pass-through of the reference loan, recorded by hand. `kind: 'interest'`, `amount` per 100
     * of notional; `kind: 'principal'`, `share` of the notional repaid (0-1] at `price` (default 100) against the last
     * fixing: that notional leaves the swap with its return and the financing accrued on it.
     */
    passThrough(app, { book, unit, inst, pos }, body) {
      const t = inst.terms;
      const ret = t.legs.find((l) => l.type === 'return');
      need(ret && inst.product_id === 'loan_trs', 'A pass-through applies to a loan total-return swap.');
      need(!isZero(pos.qty), 'This position is closed.');
      const today = app.clock.today();
      const s = sign(pos.qty) * (ret.side === 'receive' ? 1 : -1); // + we receive the loan's return
      const ccy = ret.ccy;
      const ref = app.instruments.get(ret.underlyingId);
      const refName = ref ? ref.symbol || ref.name : 'the reference loan';
      if (body.kind === 'interest') {
        const per = num(body.amount);
        need(per !== null && per > 0, 'Enter the interest passed through per 100 of notional (the reference loan\'s coupon for the period).');
        const amount = money(s * Math.abs(pos.qty) * (pos.data.notionalScale ?? 1) * per / 100, ccy);
        if (amount < 0) need(app.ledger.balance(unit.id, 'cash', ccy) >= -amount - 0.004, `The interest to pass through is ${fmt(-amount, ccy)} and ${unit.name} has ${fmt(Math.max(app.ledger.balance(unit.id, 'cash', ccy), 0), ccy)} of settled ${ccy} cash.`);
        const eventId = app.ledger.post({
          bookId: book.id, unitId: unit.id, type: 'swap.pass_through', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
          summary: `Interest of ${refName} passed through on ${nameOf(inst)}, recorded by hand${body.note ? ` (${body.note})` : ''}: ${per} per 100 of ${fmt(Math.abs(pos.qty), ccy)}, ${amount >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(amount), ccy)}`,
          data: { kind: 'interest', perHundred: per, amount },
          entries: [{ account: 'cash', ccy, amount, positionId: pos.id }, { account: 'pnl.realized', ccy, amount: -amount, positionId: pos.id }],
        });
        return { eventId };
      }
      need(body.kind === 'principal', 'Choose the pass-through: interest or principal.');
      const share = num(body.share);
      need(share !== null && share > 0 && share < 1, 'Enter the share of the notional repaid, above 0 and below 1 (a full repayment is a termination).');
      const price = num(body.price) ?? 100;
      need(price > 0, 'Enter the repayment price in % of par.');
      const p0 = pos.data.legs?.[ret.id]?.lastFixing ?? t.initialPrices?.[ret.id] ?? null;
      need(p0 !== null, `The reference loan's last fixing is not known yet: enter the first period's starting price (${refName}'s close) first.`);
      const q = Math.abs(pos.qty) * share;
      const ret$ = money(s * q * (price / p0 - 1), ccy);
      // The financing of the repaid notional, accrued since the last payment of each other leg.
      const acc = accruedLegs(app, inst, { ...pos, qty: sign(pos.qty) * q }, today);
      need(!acc.missing, acc.missing ? `The financing accrued on leg ${acc.leg.id} needs the ${acc.missing.subject} fixing of ${acc.missing.date}: enter it first.` : '');
      const fin = acc.rows.filter((x) => x.leg.type !== 'return');
      const total = money(ret$ + fin.reduce((a, x) => a + (x.leg.ccy === ccy ? x.amount : 0), 0), ccy);
      if (total < 0) need(app.ledger.balance(unit.id, 'cash', ccy) >= -total - 0.004, `The pass-through comes to ${fmt(-total, ccy)} to pay and ${unit.name} has ${fmt(Math.max(app.ledger.balance(unit.id, 'cash', ccy), 0), ccy)} of settled ${ccy} cash.`);
      const costOut = money(pos.cost * share, ccy);
      const entries = [
        ...(ret$ ? [{ account: 'cash', ccy, amount: ret$, positionId: pos.id }] : []),
        ...fin.filter((x) => x.amount).map((x) => ({ account: 'cash', ccy: x.leg.ccy, amount: x.amount, positionId: pos.id })),
        ...(costOut ? [{ account: 'pos', ccy, amount: -costOut, positionId: pos.id }] : []),
      ];
      const byCcy = {};
      for (const e of entries) byCcy[e.ccy] = (byCcy[e.ccy] || 0) + e.amount;
      for (const [c, v] of Object.entries(byCcy)) if (money(v, c)) entries.push({ account: 'pnl.realized', ccy: c, amount: money(-v, c), positionId: pos.id });
      const eventId = app.ledger.post({
        bookId: book.id, unitId: unit.id, type: 'swap.pass_through', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
        summary: `Principal of ${refName} repaid and passed through on ${nameOf(inst)}, recorded by hand${body.note ? ` (${body.note})` : ''}: ${pct(share, 2)} of the notional, ${fmt(q, ccy)}, at ${price} against the last fixing ${p0}: return ${ret$ >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(ret$), ccy)}${fin.map((x) => `; leg ${x.leg.id} (${x.leg.type}) accrued ${x.from} to ${today} on it ${x.amount >= 0 ? 'received' : 'paid'} ${fmt(Math.abs(x.amount), x.leg.ccy)}`).join('')}; cost of the repaid part ${fmt(Math.abs(costOut), ccy)} realized; the notional falls to ${fmt(Math.abs(pos.qty) - q, ccy)}`,
        data: { kind: 'principal', share, price, lastFixing: p0, notionalRepaid: q, returnAmount: ret$, financing: fin.map((x) => ({ legId: x.leg.id, amount: x.amount, from: x.from })), costOut },
        entries,
      });
      app.positions.change(pos, { dQty: -sign(pos.qty) * q, dCost: -costOut });
      return { eventId };
    },
  };
}
