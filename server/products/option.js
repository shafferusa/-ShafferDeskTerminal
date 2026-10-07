// Listed options and OTC options.
//
// Contract quantities come from the contract's own deliverable and multiplier; nothing here
// assumes "one contract = 100 shares". Expiration, exercise and assignment are settled from the
// underlying's fixing for the expiration date. If that fixing has not been supplied the expiry
// task is blocked (visible on the Pending tab) rather than guessed.

import { addBusinessDays } from '../quant/calendar.js';
import { intrinsic } from '../quant/options.js';
import { AppError, ISO_DATE_RE, money, need, num } from '../core/util.js';
import { normalizeBasis } from '../core/agreements.js';
import { bookSecurityFill, fmtQty, valueSecurity } from './common.js';
import { calendarFor, standardSettleDate } from './security.js';

const EXOTIC_MANUAL = new Set(['asian', 'lookback', 'basket', 'spread', 'quanto', 'compound', 'swaption', 'other']);

function normalizeOption(app, draft, listed) {
  const errors = [];
  const t = { ...(draft.terms || {}) };
  t.right = String(t.right || '').toUpperCase().startsWith('P') ? 'P' : String(t.right || '').toUpperCase().startsWith('C') ? 'C' : null;
  if (!t.right) errors.push('Option type must be call or put.');
  t.strike = num(t.strike);
  if (!(t.strike > 0)) errors.push('Strike must be a positive number.');
  if (!ISO_DATE_RE.test(t.expiration || '')) errors.push('Expiration date is required (YYYY-MM-DD).');
  t.exercise = ['american', 'european'].includes(t.exercise) ? t.exercise : listed ? 'american' : 'european';
  t.settlement = ['physical', 'cash'].includes(t.settlement) ? t.settlement : listed ? 'physical' : 'cash';
  t.optionType = t.optionType || 'vanilla';
  let multiplier = num(draft.multiplier);
  if (listed) {
    if (!(multiplier > 0)) errors.push('Contract multiplier is required for a listed option (premium multiplier per contract).');
    const d = { ...(t.deliverable || {}) };
    // Units of the underlying INSTRUMENT one contract delivers: shares for an equity option (the multiplier unless
    // stated), but one futures contract for an option on a future, whose premium multiplier is the future's own.
    const onFuture = draft.underlying_id ? app.instruments.get(draft.underlying_id)?.family === 'future' : false;
    d.units = num(d.units) ?? (onFuture ? 1 : multiplier);
    if (!(d.units > 0)) errors.push('Deliverable units per contract must be positive.');
    d.cash = num(d.cash) ?? 0;
    t.deliverable = d;
  } else {
    multiplier = multiplier > 0 ? multiplier : 1;
    t.deliverable = { units: multiplier, cash: 0 };
    if (t.optionType === 'digital') {
      t.payout = num(t.payout);
      if (!(t.payout > 0)) errors.push('A digital option needs its fixed payout per unit.');
      t.settlement = 'cash';
    }
    if (t.optionType === 'barrier') {
      const b = t.barrier || {};
      if (!['up-in', 'up-out', 'down-in', 'down-out'].includes(b.type)) errors.push('Barrier type must be up-in, up-out, down-in or down-out.');
      if (!(num(b.level) > 0)) errors.push('Barrier level must be positive.');
      t.barrier = { type: b.type, level: num(b.level), rebate: num(b.rebate) ?? 0 };
    }
    // An OTC option carries counterparty exposure: collateral follows the basis stated on the contract.
    t.collateralBasis = normalizeBasis(t.collateralBasis, errors);
    if (!t.collateralBasis) delete t.collateralBasis;
  }
  if (!draft.underlying_id && !t.fixingRate && !t.underlyingDescription) errors.push('Choose the underlying instrument (or name the underlying rate / reference).');
  if (t.settlement === 'physical' && !draft.underlying_id) errors.push('Physical settlement needs an underlying instrument in the registry.');
  return { terms: t, multiplier: multiplier > 0 ? multiplier : 1, errors };
}

/**
 * Underlying units one LISTED contract stands for: what it delivers, in units of the underlying's own price.
 * 100 shares for a standard equity option; for an option on a future, the one future it delivers times that
 * future's multiplier (1,000 barrels, 50 index points ...). Notional, exposure and the cash reserved against a
 * written option are all measured in these units.
 */
export function underlyingUnits(app, inst) {
  const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
  return inst.terms.deliverable.units * (und?.multiplier ?? 1);
}

/** The fixing an option settles against for a date: an instrument close or a rate observation. */
function fixingFor(app, inst, date) {
  if (inst.terms.fixingRate) {
    const o = app.data.rate(inst.terms.fixingRate, date);
    if (o && (o.forDate || '').slice(0, 10) === date) return { value: o.value, obs: o };
    return null;
  }
  if (!inst.underlying_id) return null;
  const o = app.data.closeFor(inst.underlying_id, date);
  if (!o || o.value === null) return null;
  return { value: o.value, obs: o };
}

/**
 * Settle `contracts` of an option position at fixing S (exercise, assignment, cash settlement or
 * worthless expiry). manualAmount (total cash to the long side) overrides the formula for exotics.
 */
export function settleOption(app, { book, unit, inst, pos, S, date, contracts, mode, obs, manualAmount }) {
  const t = inst.terms;
  const long = pos.qty > 0;
  const q = Math.min(Math.abs(pos.qty), contracts ?? Math.abs(pos.qty));
  if (!(q > 0)) return null;
  const closeAction = long ? 'sell' : 'buy';
  const obsId = obs ? app.data.recordUsed(obs) : null;
  const base = { book, unit, inst, strategyId: pos.strategy_id, tradeDate: date, qty: q, fees: [], actor: mode === 'user' ? 'user' : 'engine' };
  const barrier = t.barrier;
  let active = true;
  if (barrier) {
    const hit = Boolean(pos.data.barrierHit);
    active = barrier.type.endsWith('-in') ? hit : !hit;
  }
  let perUnit;
  if (manualAmount !== undefined && manualAmount !== null) perUnit = manualAmount / (q * inst.multiplier);
  else if (!active) perUnit = barrier?.rebate || 0;
  else if (t.optionType === 'digital') perUnit = intrinsic(t.right, S, t.strike) > 0 ? t.payout : 0;
  else perUnit = intrinsic(t.right, S, t.strike);
  const threshold = inst.family === 'option' ? 0.01 : 1e-9;
  const itm = perUnit >= threshold;
  const forced = mode === 'user'; // an explicit early exercise is honoured even if not in the money
  const settleDate = addBusinessDays(date, 1, calendarFor(inst));
  const label = `${fmtQty(q)} ${inst.symbol || inst.name}`;

  if (!itm && !forced) {
    const r = bookSecurityFill(app, { ...base, action: closeAction, price: 0, settleDate: date, eventType: 'option.expired', summary: `Expired worthless: ${label}${S !== undefined && S !== null ? ` (fixing ${S})` : ''}`, data: { fixing: S ?? null, fixingObsId: obsId } }, { unitCost: 0 });
    return { outcome: 'expired', eventId: r.eventId, realized: r.realized };
  }

  if (t.settlement === 'cash' || manualAmount !== undefined && manualAmount !== null || !active) {
    const r = bookSecurityFill(app, { ...base, action: closeAction, price: perUnit, settleDate, eventType: 'option.cash_settled', summary: `${long ? 'Exercised' : 'Assigned'} (cash settlement): ${label} at ${money(perUnit, inst.trading_ccy)} per unit`, data: { fixing: S ?? null, fixingObsId: obsId, perUnit } }, { unitCost: perUnit * inst.multiplier });
    return { outcome: 'cash_settled', eventId: r.eventId, realized: r.realized };
  }

  // Physical settlement: the option closes at zero and the deliverable changes hands at the strike.
  const und = app.instruments.get(inst.underlying_id);
  if (!und) throw new AppError('The option\'s underlying instrument is not in the registry.');
  const r = bookSecurityFill(app, { ...base, action: closeAction, price: 0, settleDate: date, eventType: long ? 'option.exercised' : 'option.assigned', summary: `${long ? 'Exercised' : 'Assigned'}: ${label} at strike ${t.strike}`, data: { fixing: S ?? null, fixingObsId: obsId, strike: t.strike } }, { unitCost: 0 });
  const units = q * t.deliverable.units;
  // long call / short put receive the underlying; long put / short call deliver it.
  const receives = (t.right === 'C') === long;
  const undPlugin = app.products.get(und.family);
  const undPos = app.positions.find(unit.id, und.id, pos.strategy_id);
  let action = receives ? 'buy' : 'sell';
  if (!receives && und.family !== 'future' && (!undPos || undPos.qty < units - 1e-9)) {
    app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'warning', code: 'delivery.short', refType: 'position', refId: pos.id, message: `${long ? 'Exercise' : 'Assignment'} of ${label} delivered ${fmtQty(units)} ${und.symbol || und.name} that the strategy did not hold. The resulting short position has no securities borrow arranged.` });
  }
  if (receives && undPos && undPos.qty < 0) action = 'buy_to_cover';
  const undSettle = undPlugin.settleDate(app, und, date, book);
  const d = undPlugin.fill(app, {
    book, unit, inst: und, action, qty: units, price: t.strike, fees: [], strategyId: pos.strategy_id, tradeDate: date, settleDate: undSettle, actor: mode === 'user' ? 'user' : 'engine',
    // The delivery is a paper entry: the Terminal moves nothing outside its own books, and the history says so.
    eventType: 'option.delivery', summary: `Simulated delivery: ${receives ? 'received' : 'delivered'} ${fmtQty(units)} ${und.symbol || und.name} at strike ${t.strike} on ${long ? 'exercise' : 'assignment'} of ${inst.symbol || inst.name}`,
    data: { fromOption: inst.id, simulated: true },
  });
  const undNow = app.positions.find(unit.id, und.id, pos.strategy_id);
  if (undNow && undPlugin.onPositionChange) undPlugin.onPositionChange(app, { book, unit, inst: und, pos: undNow });
  return { outcome: long ? 'exercised' : 'assigned', eventId: r.eventId, realized: r.realized, deliveryEventId: d.eventId };
}

function makeOptionPlugin(family, listed) {
  return {
    family,
    kind: 'security',
    shortRule: 'write',
    label: listed ? 'Listed option' : 'OTC option',
    qtyLabel: listed ? 'Contracts' : 'Underlying units',
    actions: () => ['buy', 'sell'],
    priceUnits: () => (listed ? 'premium per underlying unit' : 'premium per unit'),
    calendar: calendarFor,
    normalize: (app, draft) => normalizeOption(app, draft, listed),
    describe(inst, app) {
      const t = inst.terms;
      const rows = [['Type', `${t.right === 'C' ? 'Call' : 'Put'}${t.optionType !== 'vanilla' ? ` (${t.optionType})` : ''}`], ['Strike', t.strike], ['Expiration', t.expiration], ['Exercise', t.exercise], ['Settlement', t.settlement], ['Multiplier', inst.multiplier]];
      if (listed) rows.push(['Deliverable per contract', `${t.deliverable.units} units${t.deliverable.cash ? ` + ${t.deliverable.cash} cash` : ''}`]);
      if (t.payout) rows.push(['Digital payout per unit', t.payout]);
      if (t.barrier) rows.push(['Barrier', `${t.barrier.type} at ${t.barrier.level}`]);
      if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
      if (!listed && app?.agreements) rows.push(...app.agreements.describeRows(inst));
      return rows;
    },
    /** Notional on which a percentage independent amount is worked out: the deliverable at the strike. */
    collateralNotional: (app, inst, { qtyAfter }) => Math.abs(qtyAfter) * inst.terms.deliverable.units * inst.terms.strike,
    qtyStep: () => (listed ? 1 : 1e-6),
    settleDate: (app, inst, tradeDate, book) => standardSettleDate(inst, tradeDate, book),
    economics(app, { inst, action, qty, price, unit, strategyId, book }) {
      const gross = qty * price * inst.multiplier;
      const buy = action === 'buy';
      const und = inst.underlying_id ? app.data.price(inst.underlying_id) : null;
      const undPx = und?.value ?? null;
      // OTC only: collateral under the basis the contract states. A listed option is a cleared product (Book assumptions).
      const coll = listed ? null : app.agreements.tradeRequirement({ book, unit, inst, action, qty, price, strategyId, cashOut: buy ? gross : 0 });
      return {
        ccy: inst.trading_ccy, principal: gross, cash: buy ? -gross : gross, accrued: 0,
        // Notional is the value of the deliverable, which is not the premium paid.
        notional: qty * (listed ? underlyingUnits(app, inst) : inst.terms.deliverable.units) * (undPx !== null ? undPx : inst.terms.strike),
        notionalBasis: undPx !== null ? 'underlying price' : 'strike (no underlying price available)',
        exposure: null, initialMargin: coll ? coll.initialMargin : 0, ...(coll ? { collateral: coll } : {}), notes: coll ? [...coll.notes] : [],
      };
    },
    fill(app, c) {
      return bookSecurityFill(app, c, { unitCost: c.price * c.inst.multiplier });
    },
    value(app, inst, pos, obs, mark) {
      const v = valueSecurity(inst, pos, obs, mark);
      const und = inst.underlying_id ? app.data.price(inst.underlying_id) : null;
      const px = und?.value ?? null;
      v.notional = px !== null ? money(Math.abs(pos.qty) * (listed ? underlyingUnits(app, inst) : inst.terms.deliverable.units) * px, inst.trading_ccy) : null;
      v.exposure = null;
      return v;
    },
    onPositionChange(app, { book, unit, inst, pos }) {
      if (!listed) app.agreements.onPositionChange({ book, unit, inst, pos });
      if (Math.abs(pos.qty) < 1e-9) return app.tasks.cancelFor(pos.id);
      app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'option.expiry', dueDate: inst.terms.expiration });
    },
    dataNeeds(app, { inst, task }) {
      if (task?.type === 'option.expiry' && inst.underlying_id) {
        const und = app.instruments.get(inst.underlying_id);
        if (und) return { closes: [{ instrument: und, date: inst.terms.expiration }] };
      }
      if (task?.type === 'option.expiry' && inst.terms.fixingRate) return { rateCodes: [inst.terms.fixingRate], rateFrom: addBusinessDays(inst.terms.expiration, -10, 'ALLDAYS') };
      return {};
    },
    runTask(app, task, { book, unit, inst, pos }) {
      if (task.type !== 'option.expiry') return { failed: `Unknown task ${task.type}` };
      if (!pos || Math.abs(pos.qty) < 1e-9) return 'done';
      const t = inst.terms;
      if (EXOTIC_MANUAL.has(t.optionType) && (task.data.manualAmount === undefined || task.data.manualAmount === null)) {
        return { blocked: `Enter the settlement amount for this ${t.optionType} option (it is not computed by the Terminal).`, needs: [{ kind: 'settlement-amount', taskId: task.id }] };
      }
      if (task.data.manualAmount !== undefined && task.data.manualAmount !== null) {
        const r = settleOption(app, { book, unit, inst, pos, S: null, date: t.expiration, manualAmount: task.data.manualAmount, mode: 'engine' });
        if (!listed) app.agreements.onPositionChange({ pos }); // the option ended: its collateral is released
        return { done: true, eventId: r?.eventId };
      }
      const fx = fixingFor(app, inst, t.expiration);
      if (!fx) {
        const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
        const what = inst.terms.fixingRate ? `rate ${inst.terms.fixingRate}` : und ? (und.symbol || und.name) : 'the underlying';
        return {
          blocked: `Awaiting the ${t.expiration} fixing for ${what}. ${app.data.describe().awaitingMessage}, or enter the closing price manually.`,
          needs: [inst.terms.fixingRate ? { kind: 'rate', subject: inst.terms.fixingRate, date: t.expiration } : { kind: 'price', subject: inst.underlying_id, date: t.expiration }],
        };
      }
      const r = settleOption(app, { book, unit, inst, pos, S: fx.value, date: t.expiration, obs: fx.obs, mode: 'engine' });
      if (!listed) app.agreements.onPositionChange({ pos }); // the option ended: its collateral is released
      return { done: true, eventId: r?.eventId };
    },
    /** User-initiated early exercise of a long American option. */
    exercise(app, { book, unit, inst, pos, contracts }) {
      need(pos.qty > 0, 'Only a long option can be exercised.');
      need(inst.terms.exercise === 'american' || app.clock.today() >= inst.terms.expiration, 'This option is European: it can only be exercised at expiration.');
      const q = num(contracts) ?? pos.qty;
      need(q > 0 && q <= pos.qty + 1e-9, `You hold ${fmtQty(pos.qty)}; cannot exercise ${fmtQty(q)}.`);
      let S = null, obs = null;
      if (inst.terms.settlement === 'cash') {
        obs = inst.underlying_id ? app.data.price(inst.underlying_id) : null;
        need(obs && obs.value !== null, 'Cash-settled exercise needs a current underlying price, and none is available.');
        S = obs.value;
      }
      return settleOption(app, { book, unit, inst, pos, S, date: app.clock.today(), contracts: q, obs, mode: 'user' });
    },
    /** Simulated early assignment of a short American option (never happens on its own). */
    assign(app, { book, unit, inst, pos, contracts }) {
      need(pos.qty < 0, 'Only a short option can be assigned.');
      need(inst.terms.exercise === 'american', 'A European option cannot be assigned before expiration.');
      const q = num(contracts) ?? -pos.qty;
      need(q > 0 && q <= -pos.qty + 1e-9, `You are short ${fmtQty(-pos.qty)}; cannot assign ${fmtQty(q)}.`);
      let S = null, obs = null;
      if (inst.terms.settlement === 'cash') {
        obs = inst.underlying_id ? app.data.price(inst.underlying_id) : null;
        need(obs && obs.value !== null, 'Cash-settled assignment needs a current underlying price, and none is available.');
        S = obs.value;
      }
      return settleOption(app, { book, unit, inst, pos, S, date: app.clock.today(), contracts: q, obs, mode: 'user' });
    },
  };
}

export const option = makeOptionPlugin('option', true);
export const otcoption = makeOptionPlugin('otcoption', false);
export { fixingFor };
