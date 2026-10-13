// Listed options and OTC options.
//
// Contract quantities come from the contract's own deliverable and multiplier; nothing here
// assumes "one contract = 100 shares". Expiration, exercise and assignment are settled from the
// underlying's fixing for the expiration date. If that fixing has not been supplied the expiry
// task is blocked (visible on the Pending tab) rather than guessed.

import { addBusinessDays } from '../quant/calendar.js';
import { intrinsic } from '../quant/options.js';
import { AppError, ISO_DATE_RE, money, need, num } from '../core/util.js';
import { fmt } from '../core/books.js';
import { normalizeBasis } from '../core/agreements.js';
import { bookSecurityFill, fmtPx, fmtQty, valueSecurity } from './common.js';
import { calendarFor, standardSettleDate } from './security.js';

// Payoffs whose settlement amount the Terminal cannot work out from its own inputs: entered by hand on the expiry item
// (Pending tab, Settlement amount). A physically settled swaption is exercised into its swap by hand instead. Asian,
// lookback, basket, spread, quanto and compound options settle from inputs entered or supplied (see otcExpiryInput).
const EXOTIC_MANUAL = new Set(['swaption', 'other']);
const dateList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean))].sort();

function normalizeOption(app, draft, listed) {
  const errors = [];
  const t = { ...(draft.terms || {}) };
  t.right = String(t.right || '').toUpperCase().startsWith('P') ? 'P' : String(t.right || '').toUpperCase().startsWith('C') ? 'C' : null;
  if (!t.right) errors.push('Option type must be call or put.');
  t.strike = num(t.strike);
  if (!(t.strike > 0)) errors.push('Strike must be a positive number.');
  if (!ISO_DATE_RE.test(t.expiration || '')) errors.push('Expiration date is required (YYYY-MM-DD).');
  // A Bermudan style is OTC only: exercisable on the stated exercise dates and at expiration.
  t.exercise = (listed ? ['american', 'european'] : ['american', 'european', 'bermudan']).includes(t.exercise) ? t.exercise : listed ? 'american' : 'european';
  if (t.exercise === 'bermudan') {
    const raw = Array.isArray(t.exerciseDates) ? t.exerciseDates : String(t.exerciseDates || '').split(/[\s,;]+/);
    t.exerciseDates = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].sort();
    if (!t.exerciseDates.length) errors.push('A Bermudan option needs its exercise dates (YYYY-MM-DD, separated by commas).');
    if (t.exerciseDates.some((x) => !ISO_DATE_RE.test(x))) errors.push('Each Bermudan exercise date is a date (YYYY-MM-DD).');
    else if (ISO_DATE_RE.test(t.expiration || '') && t.exerciseDates.some((x) => x > t.expiration)) errors.push('A Bermudan exercise date cannot be after the expiration date.');
  } else delete t.exerciseDates;
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
    // Units of the underlying INSTRUMENT that one unit of quantity delivers on physical exercise: the amount that moves
    // by the same value for one unit of price. The multiplier converts the premium (and the strike) into money; the
    // underlying's own multiplier does the same for it. So an option on 1 share (multiplier 1) delivers 1 share, a bond
    // option on 1 of face (premium per 100 of face, multiplier 0.01, like the bond's own) delivers 1 of face, and an
    // option on 1 barrel delivers 1/1,000 of a 1,000-barrel future. A stated figure overrides this.
    const und = draft.underlying_id ? app.instruments.get(draft.underlying_id) : null;
    const stated = num(t.deliverable?.units);
    if (stated !== null && !(stated > 0)) errors.push('Deliverable units per unit of quantity must be positive.');
    t.deliverable = { units: stated ?? (und ? multiplier / (und.multiplier || 1) : multiplier), cash: 0 };
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
    const undFam = und?.family || null;
    if (undFam) t.underlyingFamily = undFam; else delete t.underlyingFamily;
    // A cash settlement can be paid on a stated date after the fixing (an interest-rate option pays at the end of its period).
    if (t.paymentDate === '' || t.paymentDate === null || t.paymentDate === undefined) delete t.paymentDate;
    else if (!ISO_DATE_RE.test(t.paymentDate)) errors.push('The cash settlement payment date is a date (YYYY-MM-DD).');
    else if (ISO_DATE_RE.test(t.expiration || '') && t.paymentDate < t.expiration) errors.push('The cash settlement payment date cannot be before the expiration date.');
    if (t.optionType === 'asian') {
      // Average-price option: the arithmetic mean of the underlying's closes on the averaging dates replaces the final fixing.
      // Without averaging dates the averaged settlement amount is entered by hand at expiry instead.
      t.averagingDates = dateList(t.averagingDates);
      if (!t.averagingDates.length) delete t.averagingDates;
      else if (t.averagingDates.some((x) => !ISO_DATE_RE.test(x))) errors.push('Each averaging date is a date (YYYY-MM-DD).');
      else if (ISO_DATE_RE.test(t.expiration || '') && t.averagingDates.some((x) => x > t.expiration)) errors.push('An averaging date cannot be after the expiration date.');
      if (t.averagingDates && !draft.underlying_id) errors.push('An Asian option averages the closes of an underlying instrument: choose it.');
      t.settlement = 'cash';
    } else delete t.averagingDates;
    if (t.optionType === 'lookback') {
      // Fixed strike: the observed maximum (call) or minimum (put) against the strike. Floating strike: the expiry close
      // against the observed minimum (call) or maximum (put). The extreme is recorded by hand on the position.
      t.lookbackType = t.lookbackType === 'floating' ? 'floating' : 'fixed';
      if (t.lookbackType === 'floating' && !draft.underlying_id) errors.push('A floating-strike lookback settles against the underlying close at expiry: choose the underlying instrument.');
      t.settlement = 'cash';
    } else delete t.lookbackType;
    if (t.optionType === 'basket' || t.optionType === 'spread') {
      // A composite the Terminal does not compute: its value at expiry is entered by hand and settled against the strike.
      t.settlement = 'cash';
      if (!String(t.underlyingDescription || '').trim()) errors.push(t.optionType === 'basket' ? 'A basket option names its basket (components and weights) under "Underlying reference": its value at expiry is entered by hand.' : 'A spread option names its spread (the two legs) under "Underlying reference": its value at expiry is entered by hand.');
    }
    if (t.optionType === 'quanto') {
      // The underlying's fixing, in its own currency, against the strike in that currency, converted at the fixed rate.
      t.quantoRate = num(t.quantoRate);
      if (!(t.quantoRate > 0)) errors.push('A quanto option needs its fixed conversion rate (trading currency per unit of the underlying\'s currency).');
      if (!draft.underlying_id) errors.push('A quanto option settles against an underlying instrument: choose it.');
      t.settlement = 'cash';
    } else delete t.quantoRate;
    if (t.optionType === 'swaption' && t.settlement === 'physical' && !['swap', 'cds'].includes(undFam)) errors.push('A physically settled swaption is exercised into its swap: choose the underlying swap (or credit default swap) contract.');
    if (t.optionType === 'compound' && t.settlement === 'physical' && !['otcoption', 'option'].includes(undFam)) errors.push('A compound option is exercised into an option: choose the underlying option.');
    // A credit-default swaption ends with nothing paid if the reference entity has a credit event before expiry.
    if (t.optionType === 'swaption' && undFam === 'cds') t.knockOutOnCredit = t.knockOutOnCredit !== false;
    else delete t.knockOutOnCredit;
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
export function settleOption(app, { book, unit, inst, pos, S, date, contracts, mode, obs, manualAmount, computed, entryPrice }) {
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
  else if (computed) perUnit = computed.perUnit; // worked out from averaging fixings, a recorded extreme or a value entered by hand
  else if (t.optionType === 'digital') perUnit = intrinsic(t.right, S, t.strike) > 0 ? t.payout : 0;
  else if (t.optionType === 'quanto' && t.quantoRate) perUnit = intrinsic(t.right, S, t.strike) * t.quantoRate;
  else perUnit = intrinsic(t.right, S, t.strike);
  const fixingText = computed?.note ? ` (${computed.note})` : S !== undefined && S !== null ? ` (fixing ${inst.family === 'otcoption' ? fmtPx(S) : S}${rateOption(inst) ? '%' : ''}${t.optionType === 'quanto' && t.quantoRate ? `, converted at the fixed rate ${t.quantoRate}` : ''})` : '';
  const threshold = inst.family === 'option' ? 0.01 : 1e-9;
  const itm = perUnit >= threshold;
  const forced = mode === 'user'; // an explicit early exercise is honoured even if not in the money
  // Cash is paid T+1 on the contract's calendar, or on the payment date the contract states (end of an interest period).
  const settleDate = inst.family === 'otcoption' && t.paymentDate && t.paymentDate > date ? t.paymentDate : addBusinessDays(date, 1, calendarFor(inst));
  const label = `${fmtQty(q)} ${inst.symbol || inst.name}`;

  if (!itm && !forced) {
    const r = bookSecurityFill(app, { ...base, action: closeAction, price: 0, settleDate: date, eventType: 'option.expired', summary: `Expired worthless: ${label}${inst.family === 'otcoption' ? fixingText : S !== undefined && S !== null ? ` (fixing ${S})` : ''}`, data: { fixing: S ?? null, fixingObsId: obsId, ...(computed ? { computed } : {}) } }, { unitCost: 0 });
    return { outcome: 'expired', eventId: r.eventId, realized: r.realized };
  }

  if (t.settlement === 'cash' || manualAmount !== undefined && manualAmount !== null || !active) {
    // An OTC option states the amount in its own quotation (per 100 of face for a bond option) and the fixing it came from.
    const und = inst.family === 'otcoption' && inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
    const per = inst.family !== 'otcoption' ? `${money(perUnit, inst.trading_ccy)} per unit`
      : rateOption(inst) ? `${fmtPx(perUnit)} percentage points ${t.right === 'C' ? 'over' : 'under'} the ${fmtPx(t.strike)}% strike${fixingText}, paid on ${settleDate}`
      : `${fmtPx(perUnit)} ${inst.trading_ccy} per ${und?.family === 'bond' ? '100 of face' : ['swap', 'cds'].includes(und?.family) ? '100 of notional' : 'unit'}${manualAmount !== undefined && manualAmount !== null ? ' (settlement amount entered by hand)' : !active ? ' (barrier rebate)' : fixingText}`;
    const r = bookSecurityFill(app, { ...base, action: closeAction, price: perUnit, settleDate, eventType: 'option.cash_settled', summary: `${long ? 'Exercised' : 'Assigned'} (cash settlement): ${label} at ${per}`, data: { fixing: S ?? null, fixingObsId: obsId, perUnit, ...(manualAmount !== undefined && manualAmount !== null ? { manualAmount } : {}), ...(computed ? { computed } : {}) } }, { unitCost: perUnit * inst.multiplier });
    return { outcome: 'cash_settled', eventId: r.eventId, realized: r.realized };
  }

  // Physical settlement: the option closes at zero and the deliverable changes hands at the strike.
  const und = app.instruments.get(inst.underlying_id);
  if (!und) throw new AppError('The option\'s underlying instrument is not in the registry.');
  const units = q * t.deliverable.units;
  // long call / short put receive the underlying; long put / short call deliver it.
  const receives = (t.right === 'C') === long;
  // A currency pair is delivered by exchanging both currencies at the strike, and only when the side that pays holds the
  // cash: nothing is borrowed or overdrawn to deliver. Checked before anything is booked, so a refusal changes nothing.
  if (und.family === 'fx') {
    const { base: bCcy, quote: qCcy } = und.terms;
    const payCcy = receives ? qCcy : bCcy, payAmt = money(receives ? units * t.strike : units, payCcy);
    const have = app.ledger.cash(unit.id, payCcy).availableToTrade;
    if (have < payAmt - 0.004) {
      throw new AppError(`${long ? 'Exercise' : 'Assignment'} of ${label} needs ${fmt(payAmt, payCcy)} to deliver against ${fmt(receives ? units : units * t.strike, receives ? bCcy : qCcy)}, and ${unit.kind === 'treasury' ? 'Treasury' : unit.name} has ${fmt(Math.max(have, 0), payCcy)} of ${payCcy} available. Fund it first: the currencies are exchanged only when the paying side holds the cash.`, { code: 'delivery_unfunded' });
    }
  }
  const r = bookSecurityFill(app, { ...base, action: closeAction, price: 0, settleDate: date, eventType: long ? 'option.exercised' : 'option.assigned', summary: `${long ? 'Exercised' : 'Assigned'}: ${label} at strike ${t.strike}`, data: { fixing: S ?? null, fixingObsId: obsId, strike: t.strike } }, { unitCost: 0 });
  const undPlugin = app.products.get(und.family);
  const how0 = `${long ? 'exercise' : 'assignment'} of ${inst.symbol || inst.name}`;
  if (und.family === 'swap' || und.family === 'cds') {
    // A swaption (or credit-default swaption) is exercised into its contract, which then lives with its own legs,
    // schedule and collateral basis. A call is a payer: it enters the contract as written (buys protection); a put
    // enters the opposite side (sells protection). The entry price per 100 of notional is stated (0 for a swap struck
    // at the swaption's rate); nothing is computed by a model.
    const enter = receives ? 'buy' : 'sell';
    const px = num(entryPrice) ?? 0;
    const side = und.family === 'cds' ? (enter === 'buy' ? 'bought protection on' : 'sold protection on') : (enter === 'buy' ? 'entered as written' : 'entered the opposite side of');
    const d = undPlugin.fill(app, {
      book, unit, inst: und, action: enter, qty: units, price: px, fees: [], strategyId: pos.strategy_id, tradeDate: date, settleDate: undPlugin.settleDate(app, und, date, book), actor: mode === 'user' ? 'user' : 'engine',
      eventType: 'option.delivery', summary: `Simulated exercise into ${und.symbol || und.name}: ${side} ${fmtQty(units)} notional at ${fmtPx(px)} per 100 on ${how0}`,
      data: { fromOption: inst.id, simulated: true, entryPrice: px },
    });
    const undNow = app.positions.find(unit.id, und.id, pos.strategy_id);
    if (undNow && undPlugin.onPositionChange) undPlugin.onPositionChange(app, { book, unit, inst: und, pos: undNow });
    return { outcome: long ? 'exercised' : 'assigned', eventId: r.eventId, realized: r.realized, deliveryEventId: d.eventId };
  }
  const undPos = app.positions.find(unit.id, und.id, pos.strategy_id);
  let action = receives ? 'buy' : 'sell';
  if (!receives && !['future', 'fx', 'otcoption', 'option'].includes(und.family) && (!undPos || undPos.qty < units - 1e-9)) {
    app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'warning', code: 'delivery.short', refType: 'position', refId: pos.id, message: `${long ? 'Exercise' : 'Assignment'} of ${label} delivered ${fmtQty(units)} ${und.symbol || und.name} that the strategy did not hold. The resulting short position has no securities borrow arranged.` });
  }
  if (receives && undPos && undPos.qty < 0) action = 'buy_to_cover';
  const undSettle = undPlugin.settleDate(app, und, date, book);
  const how = `${long ? 'exercise' : 'assignment'} of ${inst.symbol || inst.name}`;
  const deliverySummary = und.family === 'fx'
    ? `Simulated currency exchange on ${how}: ${receives ? 'bought' : 'sold'} ${fmt(units, und.terms.base)} against ${fmt(units * t.strike, und.terms.quote)} at strike ${t.strike}, value ${undSettle}`
    : `Simulated delivery: ${receives ? 'received' : 'delivered'} ${fmtQty(units)} ${und.symbol || und.name} at strike ${t.strike}${und.family === 'bond' ? ' plus accrued interest' : ''} on ${how}`;
  const d = undPlugin.fill(app, {
    book, unit, inst: und, action, qty: units, price: t.strike, fees: [], strategyId: pos.strategy_id, tradeDate: date, settleDate: undSettle, actor: mode === 'user' ? 'user' : 'engine',
    // The delivery is a paper entry: the Terminal moves nothing outside its own books, and the history says so.
    eventType: 'option.delivery', summary: deliverySummary,
    data: { fromOption: inst.id, simulated: true },
  });
  const undNow = app.positions.find(unit.id, und.id, pos.strategy_id);
  if (undNow && undPlugin.onPositionChange) undPlugin.onPositionChange(app, { book, unit, inst: und, pos: undNow });
  return { outcome: long ? 'exercised' : 'assigned', eventId: r.eventId, realized: r.realized, deliveryEventId: d.eventId };
}

/** An OTC option on a rate fixing (no underlying instrument): quantity is a notional amount, strike and fixing are percent. */
const rateOption = (inst) => inst.family === 'otcoption' && Boolean(inst.terms.fixingRate) && !inst.underlying_id;
/** Quantity is a notional amount: an option on a rate fixing, or a swaption on a swap or a credit default swap. */
const notionalIsQty = (inst) => rateOption(inst) || (inst.family === 'otcoption' && ['swap', 'cds'].includes(inst.terms.underlyingFamily));

/**
 * Whether the holder may exercise today: an American option any day up to expiration, a European one at expiration
 * only, a Bermudan one (OTC) on its stated exercise dates and at expiration. Refuses with the reason otherwise.
 */
function exerciseAllowed(app, inst, verb) {
  const t = inst.terms;
  const today = app.clock.today();
  if (t.exercise === 'american' || today >= t.expiration) return;
  if (t.exercise === 'bermudan') {
    need((t.exerciseDates || []).includes(today), `This option is Bermudan: it can only be ${verb} on its exercise dates (${(t.exerciseDates || []).join(', ')}) or at expiration (${t.expiration}). Today is ${today}.`);
    return;
  }
  need(false, 'This option is European: it can only be exercised at expiration.');
}

/**
 * What an OTC option settles against at expiry when it is not the plain fixing: the average of the averaging fixings
 * (Asian), the recorded extreme (lookback), a value entered by hand (basket, spread). Returns { blocked, needs } while
 * an input is missing, { S, computed } once everything is there, or null for the plain fixing (vanilla, digital,
 * barrier, quanto, compound).
 */
function otcExpiryInput(app, { inst, pos, task }) {
  const t = inst.terms;
  const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
  const undName = und ? und.symbol || und.name : 'the underlying';
  const awaiting = app.data.describe().awaitingMessage;
  if (t.optionType === 'asian') {
    if (!t.averagingDates) return { blocked: `Enter the settlement amount for this asian option: no averaging dates are stated on the contract, so the average is not worked out by the Terminal.`, needs: [{ kind: 'settlement-amount', taskId: task.id }] };
    const got = t.averagingDates.map((d) => ({ d, o: app.data.closeFor(inst.underlying_id, d) }));
    const missing = got.filter((x) => !x.o || x.o.value === null).map((x) => x.d);
    if (missing.length) return { blocked: `Awaiting the averaging fixings of ${undName} for ${missing.join(', ')}. ${awaiting}, or enter each closing price by hand (instrument drawer, Overview, "Closing price or fixing for date").`, needs: missing.map((d) => ({ kind: 'price', subject: inst.underlying_id, date: d })) };
    for (const x of got) app.data.recordUsed(x.o);
    const avg = got.reduce((a, x) => a + x.o.value, 0) / got.length;
    return { S: avg, computed: { perUnit: intrinsic(t.right, avg, t.strike), note: `average of ${got.length} fixings ${fmtPx(Math.round(avg * 1e6) / 1e6)}`, average: avg, fixings: got.map((x) => ({ date: x.d, value: x.o.value })) } };
  }
  if (t.optionType === 'lookback') {
    const x = pos.data.lookbackExtreme;
    const which = t.lookbackType === 'floating' ? (t.right === 'C' ? 'minimum' : 'maximum') : (t.right === 'C' ? 'maximum' : 'minimum');
    if (x === undefined || x === null) return { blocked: `Record the observed ${which} of ${undName} over the life of the option (the position's Lifecycle menu, Lookback extreme). The Terminal does not monitor prices between closes.`, needs: [{ kind: 'lookback-extreme', positionId: pos.id }] };
    if (t.lookbackType === 'fixed') return { S: x, computed: { perUnit: intrinsic(t.right, x, t.strike), note: `observed ${which} ${fmtPx(x)}, recorded by hand`, extreme: x } };
    const f = fixingFor(app, inst, t.expiration);
    if (!f) return { blocked: `Awaiting the ${t.expiration} fixing for ${undName}. ${awaiting}, or enter the closing price manually.`, needs: [{ kind: 'price', subject: inst.underlying_id, date: t.expiration }] };
    const perUnit = Math.max(0, t.right === 'C' ? f.value - x : x - f.value);
    return { S: f.value, obs: f.obs, computed: { perUnit, note: `close ${fmtPx(f.value)} against the observed ${which} ${fmtPx(x)}, recorded by hand`, extreme: x } };
  }
  if (t.optionType === 'basket' || t.optionType === 'spread') {
    const v = task.data.settlementValue;
    if (v === undefined || v === null) return { blocked: `Enter the ${t.optionType} value at expiry (${t.underlyingDescription}): a composite the Terminal does not compute. Accounting, Pending, Settlement value.`, needs: [{ kind: 'settlement-value', taskId: task.id }] };
    return { S: v, computed: { perUnit: intrinsic(t.right, v, t.strike), note: `${t.optionType} value ${fmtPx(v)}, entered by hand`, value: v } };
  }
  return null;
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
      if (t.barrier) rows.push(['Barrier', `${t.barrier.type} at ${t.barrier.level}${t.barrier.rebate ? `, rebate ${t.barrier.rebate} per unit` : ''}`]);
      if (t.exerciseDates) rows.push(['Bermudan exercise dates', t.exerciseDates.join(', ')]);
      if (t.averagingDates) rows.push(['Averaging dates', t.averagingDates.join(', ')]);
      if (t.lookbackType) rows.push(['Lookback', t.lookbackType === 'floating' ? 'Floating strike: expiry close against the observed extreme' : 'Fixed strike: observed extreme against the strike']);
      if (t.quantoRate) rows.push(['Quanto conversion rate (fixed)', t.quantoRate]);
      if (t.underlyingDescription) rows.push(['Underlying reference', t.underlyingDescription]);
      if (t.paymentDate) rows.push(['Cash settlement paid on', t.paymentDate]);
      if (t.knockOutOnCredit) rows.push(['Credit event', 'Knocks the option out: it ends with nothing paid']);
      if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
      if (!listed && app?.agreements) rows.push(...app.agreements.describeRows(inst));
      return rows;
    },
    /**
     * Notional on which a percentage independent amount is worked out: the deliverable at the strike (quantity x
     * strike x multiplier, in the trading currency). Only the writer of an option has an obligation to secure: the
     * buyer has paid the premium and owes nothing more, so a long position calls for no independent amount.
     */
    collateralNotional: (app, inst, { qtyAfter }) => (qtyAfter >= 0 ? 0 : notionalIsQty(inst) ? Math.abs(qtyAfter) : Math.abs(qtyAfter) * inst.terms.strike * inst.multiplier * (inst.terms.quantoRate || 1)),
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
        // (OTC: quantity x multiplier x price, the multiplier turning the underlying's price into money as it does the premium.)
        // A quanto's underlying is priced in another currency: its notional is converted at the contract's fixed rate.
        // An option on a rate fixing, or on a swap or a credit default swap, is dealt on a notional amount: the quantity itself.
        notional: listed ? qty * underlyingUnits(app, inst) * (undPx !== null ? undPx : inst.terms.strike) : notionalIsQty(inst) ? qty : qty * inst.multiplier * (undPx !== null ? undPx : inst.terms.strike) * (inst.terms.quantoRate || 1),
        notionalBasis: notionalIsQty(inst) ? 'notional amount of the option' : undPx !== null ? 'underlying price' : 'strike (no underlying price available)',
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
      v.notional = !listed && notionalIsQty(inst) ? Math.abs(pos.qty) : px !== null ? money(Math.abs(pos.qty) * (listed ? underlyingUnits(app, inst) : inst.multiplier * (inst.terms.quantoRate || 1)) * px, inst.trading_ccy) : null;
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
        // An Asian option needs the close of every averaging date.
        if (und) return { closes: [...new Set([...(inst.terms.averagingDates || []), inst.terms.expiration])].map((date) => ({ instrument: und, date })) };
      }
      if (task?.type === 'option.expiry' && inst.terms.fixingRate) return { rateCodes: [inst.terms.fixingRate], rateFrom: addBusinessDays(inst.terms.expiration, -10, 'ALLDAYS') };
      return {};
    },
    runTask(app, task, { book, unit, inst, pos }) {
      if (task.type !== 'option.expiry') return { failed: `Unknown task ${task.type}` };
      if (!pos || Math.abs(pos.qty) < 1e-9) return 'done';
      const t = inst.terms;
      const hasManual = task.data.manualAmount !== undefined && task.data.manualAmount !== null;
      if (!listed && !hasManual) {
        // Payoffs settled from inputs that are entered by hand or supplied (averaging fixings, a recorded extreme, a value).
        const pre = otcExpiryInput(app, { inst, pos, task });
        if (pre?.blocked) return pre;
        if (pre) {
          const r = settleOption(app, { book, unit, inst, pos, S: pre.S ?? null, obs: pre.obs || null, computed: pre.computed, date: t.expiration, mode: 'engine' });
          app.agreements.onPositionChange({ pos }); // the option ended: its collateral is released
          return { done: true, eventId: r?.eventId };
        }
      }
      if (EXOTIC_MANUAL.has(t.optionType) && !hasManual) {
        if (t.optionType === 'swaption' && t.settlement === 'physical') {
          const und = app.instruments.get(inst.underlying_id);
          return { blocked: `Record the exercise decision: exercise into ${und ? und.symbol || und.name : 'the underlying swap'} from the position's Lifecycle menu (Exercise, with the entry price per 100), or enter 0 as the settlement amount if the swaption is not exercised. The Terminal does not value the swap to decide for you.`, needs: [{ kind: 'settlement-amount', taskId: task.id }] };
        }
        return { blocked: `Enter the settlement amount for this ${t.optionType === 'swaption' ? 'swaption' : `${t.optionType} option`} (it is not computed by the Terminal).`, needs: [{ kind: 'settlement-amount', taskId: task.id }] };
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
      let r;
      try {
        r = settleOption(app, { book, unit, inst, pos, S: fx.value, date: t.expiration, obs: fx.obs, mode: 'engine' });
      } catch (err) {
        // A physical currency exchange the paying side cannot fund: nothing was booked; the item fails visibly and is retried.
        if (err.code === 'delivery_unfunded') return { failed: err.message };
        throw err;
      }
      if (!listed) app.agreements.onPositionChange({ pos }); // the option ended: its collateral is released
      return { done: true, eventId: r?.eventId };
    },
    /** User-initiated early exercise of a long American option. */
    exercise(app, { book, unit, inst, pos, contracts, price }) {
      need(pos.qty > 0, 'Only a long option can be exercised.');
      exerciseAllowed(app, inst, 'exercised');
      const q = num(contracts) ?? pos.qty;
      need(q > 0 && q <= pos.qty + 1e-9, `You hold ${fmtQty(pos.qty)}; cannot exercise ${fmtQty(q)}.`);
      const ot = inst.terms.optionType;
      if (!listed && inst.terms.settlement === 'cash' && ['asian', 'lookback', 'basket', 'spread', 'swaption', 'other'].includes(ot)) {
        throw new AppError(`A cash-settled ${ot} option is settled by its expiry item, from ${{ asian: 'its averaging fixings', lookback: 'the extreme recorded on it', basket: 'the basket value entered at expiry', spread: 'the spread value entered at expiry' }[ot] || 'the settlement amount entered at expiry'} (Accounting, Pending). It is not exercised by hand.`);
      }
      let S = null, obs = null;
      if (inst.terms.settlement === 'cash') {
        obs = inst.underlying_id ? app.data.price(inst.underlying_id) : null;
        need(obs && obs.value !== null, 'Cash-settled exercise needs a current underlying price, and none is available.');
        S = obs.value;
      }
      return settleOption(app, { book, unit, inst, pos, S, date: app.clock.today(), contracts: q, obs, mode: 'user', entryPrice: price });
    },
    /** A credit event on the reference entity of a knock-out credit-default swaption: it ends now with nothing paid. */
    knockOut(app, { book, unit, inst, pos, note }) {
      need(!listed && inst.terms.knockOutOnCredit, 'Only a credit-default swaption that knocks out on a credit event can be knocked out.');
      need(Math.abs(pos.qty) > 1e-9, 'This position is already closed.');
      const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
      const entity = und?.terms?.referenceEntity || (und ? und.symbol || und.name : 'the reference entity');
      const r = bookSecurityFill(app, { book, unit, inst, strategyId: pos.strategy_id, tradeDate: app.clock.today(), qty: Math.abs(pos.qty), fees: [], actor: 'user', action: pos.qty > 0 ? 'sell' : 'buy', price: 0, settleDate: app.clock.today(), eventType: 'option.knocked_out',
        summary: `Knocked out by a credit event on ${entity}: ${fmtQty(Math.abs(pos.qty))} ${inst.symbol || inst.name} ends with nothing paid (recorded by hand)${note ? `. ${note}` : ''}`, data: { knockOut: true, note: note || null } }, { unitCost: 0 });
      return { outcome: 'knocked_out', eventId: r.eventId, realized: r.realized };
    },
    /** The observed maximum (call) or minimum (put) of a lookback's underlying, recorded by hand. A later record replaces it. */
    recordExtreme(app, { book, unit, inst, pos, value, date, note }) {
      need(!listed && inst.terms.optionType === 'lookback', 'An observed extreme is recorded on a lookback option only.');
      const v = num(value);
      need(v !== null && v > 0, `Enter the observed ${inst.terms.right === 'C' ? 'maximum' : 'minimum'} of the underlying as a positive price.`);
      need(!date || ISO_DATE_RE.test(date), 'The date of the extreme is a date (YYYY-MM-DD).');
      need(!date || date <= inst.terms.expiration, 'The extreme must be observed on or before the expiration date.');
      const which = inst.terms.lookbackType === 'floating' ? (inst.terms.right === 'C' ? 'minimum' : 'maximum') : (inst.terms.right === 'C' ? 'maximum' : 'minimum');
      const prev = pos.data.lookbackExtreme ?? null;
      app.positions.setData(pos, { lookbackExtreme: v, lookbackExtremeDate: date || app.clock.today(), lookbackExtremeAt: app.clock.now().toISOString() });
      const und = inst.underlying_id ? app.instruments.get(inst.underlying_id) : null;
      const eventId = app.ledger.post({ bookId: book.id, unitId: unit.id, type: 'option.lookback_extreme', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id,
        summary: `Observed ${which} of ${und ? und.symbol || und.name : 'the underlying'} recorded on ${inst.symbol || inst.name}: ${fmtPx(v)}${date ? ` on ${date}` : ''}${prev !== null ? ` (replaces ${fmtPx(prev)})` : ''}, recorded by hand${note ? `. ${note}` : ''}`, data: { extreme: v, which, date: date || null, previous: prev } });
      return { eventId };
    },
    /** Simulated early assignment of a short American option (never happens on its own). */
    assign(app, { book, unit, inst, pos, contracts }) {
      need(pos.qty < 0, 'Only a short option can be assigned.');
      if (inst.terms.exercise === 'bermudan') exerciseAllowed(app, inst, 'assigned');
      else need(inst.terms.exercise === 'american', 'A European option cannot be assigned before expiration.');
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
