// Credit default swaps: premium conventions, the accrued premium exchanged at trade, and the events recorded by hand
// (s3, 2026-10-13). Used by the `cds` plugin in products/swap.js.
//
// Premium conventions (`terms.convention`)
//   standard   the ISDA standard contract (SNAC / STEC): a fixed running coupon (25, 100, 300, 500, 750 or 1000 bp),
//              roll dates on the IMM 20ths (20 March, June, September, December), each coupon date moved to the next
//              business day of the payment calendar (following). An accrual period runs from one adjusted coupon date
//              (included) to the next (excluded); the last one runs to the maturity date included. Every coupon is a
//              full coupon: a trade exchanges the premium accrued from the start of the current period to the step-in
//              date (trade date + 1 calendar day), the protection seller paying it to the buyer, so that whoever holds
//              the contract on a coupon date pays (or receives) the whole period.
//   (none)     a bespoke contract: periods from the effective date to the IMM 20ths after it and on to maturity; the
//              first period is a short stub, or (`firstStub: 'long'`) runs on to the second roll date. Premium accrues
//              from the trade date of a new position and nothing is exchanged at trade. Accrual dates are not adjusted.
//   ACT/360 in both. The amount of a period is notional outstanding x coupon x days / 360.
//
// Outstanding notional is the trade notional x `terms.indexFactor`: the index factor of an index CDS (reduced by each
// constituent's weight at its credit event), the outstanding share of a tranche, the factor of the reference
// obligation of an ABS CDS. A trade's upfront is paid on the outstanding notional (quantity x factor x price / 100).
//
// Events recorded by hand (POST /api/instruments/:id/lifecycle), for every holder in every Book:
//   credit_event   { eventType, eventDate, recovery, settlement, weight (index), entity (basket, index), settleDate, note }
//                  Protection of affected notional x (1 - recovery) to the buyer, the premium accrued on it from the start
//                  of the current period to the event date paid by the buyer (refunded when a coupon already covered
//                  days after the event). Single name, loan and ABS CDS end; an index loses the constituent's weight and
//                  goes on; an nth-to-default basket counts defaults and settles in full at the nth, then ends; a
//                  tranche is written down by the part of the index loss inside its attachment and detachment points,
//                  untouched below them, and ends when exhausted.
//                  Settlement: at the auction final price (cash), at a stated recovery (cash), or physically where the
//                  terms say so: simulated on paper (the deliverable obligation is not a position the Terminal holds).
//   paygo          ABS CDS pay-as-you-go: writedown and principal shortfall (paid by the seller, the factor falls),
//                  interest shortfall (paid by the seller), their reimbursements (paid by the buyer), amortization of the
//                  reference obligation (the factor falls, nothing is paid). Amounts per 100 of original notional.
//   cancel         loan CDS cancelled when the reference loans are refinanced: the accrued premium is settled and the
//                  contract ends with no protection payment.

import { fmt } from '../core/books.js';
import { adjust } from '../quant/calendar.js';
import { addDays, diffDays } from '../quant/dates.js';
import { cdsDates } from '../quant/schedule.js';
import { ISO_DATE_RE, isZero, money, need, num, sign } from '../core/util.js';
import { paymentCalendarFor } from './security.js';

export const CREDIT_EVENTS = {
  bankruptcy: 'Bankruptcy', failure_to_pay: 'Failure to pay', restructuring: 'Restructuring', repudiation_moratorium: 'Repudiation/moratorium',
  obligation_acceleration: 'Obligation acceleration', governmental_intervention: 'Governmental intervention', failure_to_pay_principal: 'Failure to pay principal',
  writedown: 'Writedown', distressed_ratings_downgrade: 'Distressed ratings downgrade',
};
/** The credit events a contract names, by family of reference entity (`terms.creditEventSet`), or listed one by one (`terms.creditEvents`). */
export const CREDIT_EVENT_SETS = {
  corporate: ['bankruptcy', 'failure_to_pay', 'restructuring'],
  corporate_xr: ['bankruptcy', 'failure_to_pay'],
  sovereign: ['failure_to_pay', 'repudiation_moratorium', 'restructuring', 'obligation_acceleration'],
  financial: ['bankruptcy', 'failure_to_pay', 'restructuring', 'governmental_intervention'],
  abs: ['failure_to_pay_principal', 'writedown', 'distressed_ratings_downgrade'],
};
const DEFAULT_SET = { cds_sovereign: 'sovereign', loan_cds: 'corporate_xr', abs_cds: 'abs' };
export const STANDARD_COUPONS = [0.0025, 0.01, 0.03, 0.05, 0.075, 0.1];
export const SETTLEMENT_METHODS = { auction: 'Cash, at the auction final price', cash: 'Cash, at a stated recovery', physical: 'Physical (simulated on paper)' };
export const PAYGO_KINDS = {
  writedown: 'Writedown', principal_shortfall: 'Principal shortfall', interest_shortfall: 'Interest shortfall',
  writedown_reimbursement: 'Writedown reimbursement', interest_reimbursement: 'Interest shortfall reimbursement', amortization: 'Amortization of the reference obligation',
};

const bp = (x) => `${Math.round(x * 1e4)} bp`;
const pctText = (x, dp = 2) => `${(x * 100).toFixed(dp)}%`;
const nameOf = (inst) => inst.symbol || inst.name;
const near = (a, b) => Math.abs(a - b) < 1e-9;
const STRUCTURE = { credit_basket_swap: 'basket', cds_index_tranche: 'tranche', cds_index: 'index', abs_cds: 'abs', loan_cds: 'loan' };
export const structureOf = (inst) => STRUCTURE[inst.product_id || inst.productId] || 'single';

/** The terms the credit products add to a CDS contract, checked and completed. `t` is changed in place. */
export function normalizeCreditTerms(productId, t, errors) {
  t.convention = t.convention === 'standard' ? 'standard' : null;
  if (t.convention === 'standard' && t.coupon !== null && t.coupon !== undefined && !STANDARD_COUPONS.some((c) => near(c, t.coupon))) {
    errors.push(`A standard contract pays one of the standard running coupons (${STANDARD_COUPONS.map(bp).join(', ')}); ${bp(t.coupon)} is not one. State the bespoke convention for any other coupon.`);
  }
  t.firstStub = t.convention ? null : t.firstStub === 'long' ? 'long' : 'short';
  t.settlement = SETTLEMENT_METHODS[t.settlement] ? t.settlement : 'auction';
  if (t.settlement === 'physical' && !String(t.deliverable || '').trim()) errors.push('Physical settlement needs the deliverable obligation (Deliverable obligation).');
  if (t.creditEventSet && !CREDIT_EVENT_SETS[t.creditEventSet]) errors.push(`Credit events "${t.creditEventSet}" is not one of: ${Object.keys(CREDIT_EVENT_SETS).join(', ')}.`);
  const set = CREDIT_EVENT_SETS[t.creditEventSet] ? t.creditEventSet : DEFAULT_SET[productId] || 'corporate';
  t.creditEventSet = set;
  t.creditEvents = Array.isArray(t.creditEvents) && t.creditEvents.length ? t.creditEvents.filter((e) => CREDIT_EVENTS[e]) : CREDIT_EVENT_SETS[set];
  if (productId === 'credit_basket_swap') {
    const names = Array.isArray(t.basket) ? t.basket : String(t.basket || '').split(/[;\n]/);
    t.basket = names.map((x) => String(x).trim()).filter(Boolean);
    if (t.basket.length < 2) errors.push('A credit basket names at least two reference entities (Basket reference entities, separated by ";").');
    if (new Set(t.basket.map((x) => x.toLowerCase())).size !== t.basket.length) errors.push('A reference entity is named twice in the basket.');
    t.nth = num(t.nth) ?? 1;
    if (!(Number.isInteger(t.nth) && t.nth >= 1 && t.nth <= t.basket.length)) errors.push(`The default that triggers protection (nth) must be a whole number from 1 to ${t.basket.length || 'the number of names'}.`);
  }
  if (productId === 'cds_index_tranche') {
    t.attachment = num(t.attachment);
    t.detachment = num(t.detachment);
    if (t.attachment === null || t.detachment === null || !(t.attachment >= 0 && t.attachment < t.detachment && t.detachment <= 1)) errors.push('A tranche needs its attachment and detachment points as decimals of the index notional, 0 <= attachment < detachment <= 1 (0.03 = 3%).');
    t.indexLoss = num(t.indexLoss) ?? 0;
    t.indexRecovered = num(t.indexRecovered) ?? 0;
  }
  if (productId === 'loan_cds') t.cancellable = t.cancellable !== false;
  else delete t.cancellable;
  if (productId === 'abs_cds') {
    t.paygo = true;
    if (!String(t.referenceObligation || '').trim()) errors.push('An ABS CDS names its reference obligation (the securitised bond: Reference obligation).');
  }
  if (!Array.isArray(t.defaults)) t.defaults = [];
  return t;
}

/** Description rows the credit terms add. */
export function creditRows(inst) {
  const t = inst.terms;
  const rows = [];
  rows.push(['Premium convention', t.convention === 'standard' ? 'Standard (full first coupon): IMM roll dates moved to the next business day, accrued premium exchanged at trade (step-in the day after the trade), last period to maturity included' : `Bespoke: periods from the effective date to the IMM roll dates, first period a ${t.firstStub === 'long' ? 'long stub (to the second roll date)' : 'short stub'}; premium from the trade date, nothing exchanged at trade`]);
  rows.push(['Credit events', (t.creditEvents || []).map((e) => CREDIT_EVENTS[e]).join(', ')]);
  rows.push(['Settlement after a credit event', `${SETTLEMENT_METHODS[t.settlement || 'auction']}${t.settlement === 'physical' ? `: ${t.deliverable}` : ''}`]);
  if (t.basket?.length) rows.push(['Basket', `${t.basket.join('; ')}. Protection on the ${ordinal(t.nth)} default${t.defaults?.length ? `; defaults so far: ${t.defaults.map((d) => `${d.entity} (${d.date})`).join(', ')}` : ''}`]);
  if (isNum(t.attachment)) rows.push(['Tranche', `${pctText(t.attachment)} to ${pctText(t.detachment)} of the index; index loss so far ${pctText(t.indexLoss || 0, 4)}, recovered ${pctText(t.indexRecovered || 0, 4)}; outstanding ${pctText(t.indexFactor ?? 1, 4)} of the tranche`]);
  if (t.cancellable) rows.push(['Cancellation', 'Cancelled with no protection payment if the reference loans are repaid and not replaced (recorded by hand); accrued premium is settled']);
  if (t.paygo) rows.push(['Reference obligation', `${t.referenceObligation}; pay-as-you-go writedowns, principal and interest shortfalls and their reimbursements recorded by hand`]);
  if (t.ended) rows.push(['Ended', `${t.ended.date}: ${t.ended.reason}`]);
  return rows;
}
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** IMM 20ths d with from < d <= to. */
function immDates(from, to) {
  const out = [];
  for (let y = Number(from.slice(0, 4)); `${y}-01-01` <= to; y++) {
    for (const m of ['03', '06', '09', '12']) { const d = `${y}-${m}-20`; if (d > from && d <= to) out.push(d); }
  }
  return out;
}

/**
 * Every premium period of the contract: { start, end, payDate }, `end` excluded from the accrual (for the last period
 * of a standard contract, the day after maturity, so that maturity is included).
 */
export function cdsSchedule(inst) {
  const t = inst.terms;
  const cal = paymentCalendarFor(inst);
  if (t.convention === 'standard') {
    // The roll date on or before the effective date opens the first period.
    const y = Number(t.effective.slice(0, 4));
    const before = immDates(`${y - 1}-01-01`, t.effective);
    const first = before[before.length - 1];
    const rolls = [first, ...immDates(first, t.maturity)];
    if (rolls[rolls.length - 1] !== t.maturity) rolls.push(t.maturity);
    const out = [];
    for (let i = 0; i < rolls.length - 1; i++) {
      const last = i === rolls.length - 2;
      out.push({ start: adjust(rolls[i], 'following', cal), end: last ? addDays(t.maturity, 1) : adjust(rolls[i + 1], 'following', cal), payDate: adjust(rolls[i + 1], 'following', cal) });
    }
    return out;
  }
  let dates = cdsDates(t.effective, t.maturity);
  if (t.firstStub === 'long' && dates.length > 1) dates = dates.slice(1);
  const out = [];
  let start = t.effective;
  for (const d of dates) { out.push({ start, end: d, payDate: adjust(d, 'following', cal) }); start = d; }
  return out;
}
export const periodsFrom = (inst, from) => cdsSchedule(inst).filter((p) => p.end > from);
/** The period a date falls in (start <= date < end), or the first one for a date before the contract starts. */
export function periodOf(inst, date) {
  const all = cdsSchedule(inst);
  return all.find((p) => p.start <= date && date < p.end) || (date < all[0].start ? all[0] : all[all.length - 1]);
}
/** Days of premium accrual from `from` to `to`: to excluded, or included when the convention counts the end date (standard). */
const accrualDays = (inst, from, to, inclusive) => diffDays(from, to) + (inclusive && inst.terms.convention === 'standard' ? 1 : 0);

/** Where a new position's premium starts: its trade date (bespoke), or the start of the period of its step-in date (standard). */
export function premiumStart(inst, tradeDate) {
  if (inst.terms.convention === 'standard') return periodOf(inst, addDays(tradeDate, 1)).start;
  // Bespoke: from the trade date, but never before protection starts (a trade dealt before the effective date).
  return tradeDate > inst.terms.effective ? tradeDate : inst.terms.effective;
}

/**
 * Premium accrued on `qty` of notional from the start of the current period to the step-in date (standard convention only):
 * what the protection seller pays the buyer at trade. Unsigned. { amount, from, stepIn, days } or { amount: 0 }.
 */
export function tradeAccrual(inst, tradeDate, qty) {
  if (inst.terms.convention !== 'standard') return { amount: 0 };
  const stepIn = addDays(tradeDate, 1);
  const from = periodOf(inst, stepIn).start;
  const days = Math.max(0, diffDays(from, stepIn));
  return { amount: money(Math.abs(qty) * (inst.terms.indexFactor ?? 1) * inst.terms.coupon * days / 360, inst.trading_ccy), from, stepIn, days };
}

/** Premium of a position for one period (or part of it): |qty| x factor x coupon x days / 360. */
export const premiumAmount = (inst, qty, from, to) => Math.abs(qty) * (inst.terms.indexFactor ?? 1) * inst.terms.coupon * diffDays(from, to) / 360;

/** Net accrued-premium balance carried by a position (standard convention): + prepaid by us, - owed by us. */
export const accruedBalance = (app, pos, ccy) => app.ledger.positionBalance(pos.id, 'accrued.asset', ccy) + app.ledger.positionBalance(pos.id, 'accrued.liab', ccy);
/** Entries that clear `share` of a position's accrued-premium balances; the caller balances them against P&L. */
function clearAccrued(app, pos, ccy, share = 1) {
  const out = [];
  for (const account of ['accrued.asset', 'accrued.liab']) {
    const b = app.ledger.positionBalance(pos.id, account, ccy);
    const x = money(b * share, ccy);
    if (x !== 0) out.push({ account, ccy, amount: -x, positionId: pos.id });
  }
  return out;
}
const sumOf = (entries) => entries.reduce((a, e) => a + e.amount, 0);

/**
 * After a fill under the standard convention: an accrued premium received at trade is owed back with the next coupon, so it
 * is carried as a liability, not as a negative asset. Returns the event id or null.
 */
export function classifyTradeAccrual(app, { book, unit, inst, pos, strategyId }) {
  const ccy = inst.trading_ccy;
  const asset = app.ledger.positionBalance(pos.id, 'accrued.asset', ccy);
  if (asset >= 0) return null;
  return app.ledger.post({
    bookId: book.id, unitId: unit.id, type: 'cds.accrued', instrumentId: inst.id, strategyId, positionId: pos.id, actor: 'engine',
    summary: `Premium accrued since the last coupon date, received at trade on ${nameOf(inst)}: ${fmt(-asset, ccy)} carried as owed back with the next coupon`,
    entries: [{ account: 'accrued.asset', ccy, amount: -asset, positionId: pos.id }, { account: 'accrued.liab', ccy, amount: asset, positionId: pos.id }],
  });
}

/**
 * After a fill under the standard convention that terminated notional: the accrued premium exchanged for the terminated
 * part is premium for the time it was held (paid by a protection buyer, received by a seller), so it is realized at once;
 * only the accrued premium of notional opened or added is carried to the next coupon. `booked` is the signed amount the
 * fill put in accrued premium (+ paid, - received). Returns the event id or null.
 */
export function realizeTerminatedAccrual(app, { book, unit, inst, pos, strategyId, booked, closedQty, qty }) {
  const ccy = inst.trading_ccy;
  if (!booked || !(closedQty > 0) || !(qty > 0)) return null;
  const amount = money(booked * Math.min(1, closedQty / qty), ccy);
  if (amount === 0) return null;
  return app.ledger.post({
    bookId: book.id, unitId: unit.id, type: 'cds.accrued', instrumentId: inst.id, strategyId, positionId: pos.id, actor: 'engine',
    summary: `Premium accrued on the ${Number(closedQty).toLocaleString('en-US')} terminated on ${nameOf(inst)}, ${fmt(Math.abs(amount), ccy)}, ${amount > 0 ? 'paid' : 'received'} with the termination: realized as premium for the time it was held`,
    entries: [{ account: 'accrued.asset', ccy, amount: -amount, positionId: pos.id }, { account: 'pnl.realized', ccy, amount, positionId: pos.id }],
  });
}

/** A position that has closed carries no accrued premium: what is left is premium for the time it was held (realized). */
export function settleAccruedOnClose(app, { book, unit, inst, pos }) {
  const ccy = inst.trading_ccy;
  const entries = clearAccrued(app, pos, ccy);
  if (!entries.length) return null;
  const pnl = money(-sumOf(entries), ccy);
  return app.ledger.post({
    bookId: book.id, unitId: unit.id, type: 'cds.accrued', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
    summary: `Accrued premium on ${nameOf(inst)} settled with the termination: ${fmt(Math.abs(pnl), ccy)} ${pnl > 0 ? 'premium cost' : 'premium income'} for the time held`,
    entries: [...entries, { account: 'pnl.realized', ccy, amount: pnl, positionId: pos.id }],
  });
}

/** Clear a position's accrued-premium balances as part of a coupon: returns the entries (balanced by the caller's P&L entry). */
export const couponAccrualEntries = (app, pos, ccy) => clearAccrued(app, pos, ccy);

// ---------------------------------------------------------------------------------------------------------------------
// Events recorded by hand
// ---------------------------------------------------------------------------------------------------------------------

function checkDate(app, d, what, { notAfterToday = true } = {}) {
  const date = d ? String(d) : app.clock.today();
  need(ISO_DATE_RE.test(date), `${what} must be a date (YYYY-MM-DD).`);
  if (notAfterToday) need(date <= app.clock.today(), `${what} (${date}) is after today (${app.clock.today()}). Record an event once it has happened.`);
  return date;
}

/** Where a settlement amount goes: cash today, or a receivable / payable settling on `settleDate`. */
function cashAccount(amount, later) { return later ? (amount >= 0 ? 'recv.settle' : 'pay.settle') : 'cash'; }

/**
 * Settle one holder's share of an event. `affected` is the notional whose premium stops (it pays its accrued premium to
 * `when`), `protection` the amount the protection buyer receives (signed for the holder inside), `endShare` the share of the
 * position's cost that goes (realized), `close` whether the position ends.
 */
function settleHolder(app, deps, { inst, p, when, affected, protection, lines, endShare, close, settleDate: stated, type, summary, data }) {
  let settleDate = stated;
  const ccy = inst.trading_ccy;
  const book = app.books.getBook(p.book_id), unit = app.books.getUnit(p.unit_id);
  const from = p.data.premiumPaidThrough || p.data.premiumFrom || inst.terms.effective;
  // A coupon already paid for days after the event is refunded (negative days); premium that was never paid is not.
  let days = accrualDays(inst, from, when, true);
  if (days < 0 && !p.data.premiumPaidThrough) days = 0;
  const accrued = money(Math.abs(affected) * inst.terms.coupon * days / 360, ccy);
  const s = sign(p.qty); // + protection bought
  let later = settleDate && settleDate > app.clock.today();
  const cashLines = (lines || [{ amount: protection }]).map((l) => ({ ...l, amount: money(s * l.amount, ccy) }));
  if (accrued !== 0) cashLines.push({ amount: money(-s * accrued, ccy), what: 'accrued premium' });
  const net = money(cashLines.reduce((a, l) => a + l.amount, 0), ccy);
  // An amount to pay today that the owner's settled cash does not cover is not taken from cash (which never goes below
  // zero): it becomes a payable due today, whose settlement fails visibly and is retried until the cash is there.
  if (!later && net < 0 && app.ledger.balance(unit.id, 'cash', ccy) < -net - 0.004) { later = true; settleDate = app.clock.today(); }
  const share = close ? 1 : endShare;
  const costOut = money(p.cost * share, ccy);
  const acc = clearAccrued(app, p, ccy, share);
  const entries = [
    ...cashLines.filter((l) => l.amount !== 0).map((l) => ({ account: cashAccount(net, later), ccy, amount: l.amount, positionId: p.id })),
    ...(costOut !== 0 ? [{ account: 'pos', ccy, amount: -costOut, positionId: p.id }] : []),
    ...acc,
  ];
  const pnl = money(-sumOf(entries), ccy);
  if (pnl !== 0) entries.push({ account: 'pnl.realized', ccy, amount: pnl, positionId: p.id });
  const words = summary({ accrued, days, from, net, later, s, settleDate });
  const eventId = app.ledger.post({ bookId: book.id, unitId: unit.id, type, instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user', summary: words, data: { ...data, from, to: when, days, accruedPremium: accrued, net, settleDate: later ? settleDate : app.clock.today() }, entries });
  if (later && net !== 0) app.settle.create({ bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, kind: 'credit_event', dueDate: settleDate, ccy, amount: net, accounts: ['cash'] });
  let pos = app.positions.change(p, { dCost: -costOut });
  if (close) {
    deps.bookSecurityFill(app, { book, unit, inst, action: pos.qty > 0 ? 'sell' : 'buy', qty: Math.abs(pos.qty), price: 0, fees: [], strategyId: pos.strategy_id, tradeDate: when, settleDate: app.clock.today(), eventType: 'cds.terminated', actor: 'user', summary: `${nameOf(inst)} ended for this position: ${data.endReason}` }, { unitCost: 0 });
    app.tasks.cancelFor(pos.id);
    pos = app.positions.get(pos.id);
  }
  app.agreements.onPositionChange({ book, unit, inst, pos });
  return eventId;
}

const holders = (app, inst) => app.positions.heldAround(inst.id).filter((p) => !isZero(p.qty));

/** A credit event recorded by hand. Returns { eventIds, outcome }. */
export function creditEvent(app, inst, body, deps) {
  const t = inst.terms;
  const ccy = inst.trading_ccy;
  const name = nameOf(inst);
  const structure = structureOf(inst);
  need(!t.ended, `${name} has ended (${t.ended?.date}: ${t.ended?.reason}). No further credit event is recorded on it.`);
  const when = checkDate(app, body.eventDate || body.date, 'The credit event date');
  need(when <= t.maturity, `The credit event date ${when} is after the contract's maturity ${t.maturity}: protection had ended.`);
  const R = num(body.recovery);
  need(R !== null && R >= 0 && R <= 1, 'Enter the recovery rate (the auction final price, or the stated recovery) as a decimal between 0 and 1.');
  const type = body.eventType || null;
  if (type) {
    need(CREDIT_EVENTS[type], `"${type}" is not a credit event the Terminal knows (${Object.keys(CREDIT_EVENTS).join(', ')}).`);
    need((t.creditEvents || []).includes(type), `${CREDIT_EVENTS[type]} is not a credit event under the terms of ${name}. Its credit events: ${(t.creditEvents || []).map((e) => CREDIT_EVENTS[e]).join(', ')}.`);
  }
  const method = body.settlement || (t.settlement === 'physical' ? 'physical' : t.settlement || 'auction');
  need(SETTLEMENT_METHODS[method], `Settlement must be one of: ${Object.keys(SETTLEMENT_METHODS).join(', ')}.`);
  need(method !== 'physical' || t.settlement === 'physical', `${name} does not settle physically: its terms settle ${t.settlement === 'cash' ? 'in cash at a stated recovery' : 'in cash at the auction final price'}. Record the credit event with that settlement.`);
  const settleDate = body.settleDate ? checkDate(app, body.settleDate, 'The settlement date', { notAfterToday: false }) : null;
  if (settleDate) need(settleDate >= app.clock.today(), `The settlement date ${settleDate} is before today.`);
  const entity = String(body.entity || '').trim() || null;
  const typeText = type ? `${CREDIT_EVENTS[type]}` : 'Credit event';
  const howText = method === 'auction' ? `auction final price ${pctText(R, 3)}` : method === 'cash' ? `stated recovery ${pctText(R, 3)}` : `physical settlement (simulated on paper), final price ${pctText(R, 3)}`;
  const factor = t.indexFactor ?? 1;
  let newTerms = { ...t };
  let outcome;
  const record = { entity: entity || t.referenceEntity, date: when, recovery: R, type, settlement: method, recordedOn: app.clock.today() };

  // What the event does to the contract: the share of original notional whose premium stops (cut), the protection paid per
  // unit of original notional (pay), whether every position ends.
  let cut = 0, pay = 0, ends = false, endReason = '', noteText = '';
  if (structure === 'basket') {
    need(entity, `Name the reference entity of ${name} that defaulted (one of: ${t.basket.join('; ')}).`);
    const listed = t.basket.find((x) => x.toLowerCase() === entity.toLowerCase());
    need(listed, `${entity} is not in the basket of ${name} (${t.basket.join('; ')}).`);
    need(!t.defaults.some((d) => d.entity.toLowerCase() === entity.toLowerCase()), `A credit event of ${listed} is already recorded on ${name}.`);
    record.entity = listed;
    const count = t.defaults.length + 1;
    if (count < t.nth) noteText = `${ordinal(count)} default in the basket; protection is on the ${ordinal(t.nth)}: nothing is paid and the contract goes on`;
    else { cut = factor; pay = factor * (1 - R); ends = true; endReason = `${ordinal(t.nth)} default in the basket (${listed}), settled in full`; }
  } else if (structure === 'index') {
    const w = num(body.weight);
    need(w !== null && w > 0 && w <= factor + 1e-12, `Enter the defaulted constituent's weight as a share of the original index notional (0.008 = 1/125), at most the index factor ${factor}.`);
    if (entity) need(!t.defaults.some((d) => d.entity.toLowerCase() === entity.toLowerCase()), `A credit event of ${entity} is already recorded on ${name}.`);
    record.weight = w;
    cut = w; pay = w * (1 - R);
    newTerms.indexFactor = Number((factor - w).toFixed(12));
    ends = newTerms.indexFactor <= 1e-12;
    endReason = 'every constituent has defaulted';
    noteText = `index factor ${factor} to ${newTerms.indexFactor}`;
  } else if (structure === 'tranche') {
    const w = num(body.weight);
    need(w !== null && w > 0 && w <= 1, 'Enter the defaulted constituent\'s weight in the index as a decimal of the index notional (0.04 = 1/25).');
    if (entity) need(!t.defaults.some((d) => d.entity.toLowerCase() === entity.toLowerCase()), `A credit event of ${entity} is already recorded on ${name}.`);
    record.weight = w;
    const A = t.attachment, D = t.detachment, width = D - A;
    const L0 = t.indexLoss || 0, C0 = t.indexRecovered || 0;
    const L1 = L0 + w * (1 - R), C1 = C0 + w * R;
    const lossIn = (L) => Math.min(Math.max(L - A, 0), width) / width; // share of the tranche written down by losses
    const out = (L, C) => Math.max(0, Math.min(D, 1 - C) - Math.max(A, L)) / width; // outstanding share
    const f1 = Number(out(L1, C1).toFixed(12));
    pay = Number((lossIn(L1) - lossIn(L0)).toFixed(12));
    cut = Number((factor - f1).toFixed(12));
    newTerms = { ...newTerms, indexLoss: Number(L1.toFixed(12)), indexRecovered: Number(C1.toFixed(12)), indexFactor: f1 };
    ends = f1 <= 1e-12;
    endReason = `the tranche is exhausted (index loss ${pctText(L1, 4)} reached the detachment point ${pctText(D)})`;
    noteText = pay === 0 && cut === 0 ? `index loss ${pctText(L0, 4)} to ${pctText(L1, 4)}, below the attachment point ${pctText(A)}: the tranche is untouched`
      : `index loss ${pctText(L0, 4)} to ${pctText(L1, 4)}; ${pctText(pay, 4)} of the tranche written down${cut - pay > 1e-12 ? ` and ${pctText(cut - pay, 4)} amortized by recoveries` : ''}; outstanding ${pctText(factor, 4)} to ${pctText(f1, 4)}`;
  } else {
    cut = factor; pay = factor * (1 - R); ends = true; endReason = `credit event of ${t.referenceEntity}, settled`;
  }
  record.paidPerUnit = pay;
  newTerms.defaults = [...(t.defaults || []), record];
  if (ends) newTerms.ended = { date: when, reason: endReason };

  // The contract's terms change first (factor, defaults, end), so that collateral is trued up on what is left.
  app.instruments.update(inst.id, { terms: newTerms }, { system: true });
  const fresh = app.instruments.get(inst.id);
  const eventIds = [];
  for (const p of holders(app, fresh)) {
    const q = Math.abs(p.qty);
    const physical = method === 'physical' && pay > 0;
    const lines = physical
      ? [{ amount: q * cut, what: 'par for the deliverable obligation' }, { amount: -q * cut * R, what: 'deliverable obligation at the final price' }]
      : [{ amount: q * pay, what: 'protection' }];
    eventIds.push(settleHolder(app, deps, {
      inst: fresh, p, when, affected: q * cut, protection: q * pay, lines: physical ? lines : null, endShare: factor > 0 ? cut / factor : 1, close: ends, settleDate,
      type: 'cds.credit_event',
      data: { recovery: R, eventType: type, settlement: method, entity: record.entity, weight: record.weight ?? null, protection: money(q * pay, ccy), affectedNotional: q * cut, endReason },
      summary: ({ accrued, net, later, s, settleDate: due }) => {
        const prot = money(q * pay, ccy);
        const pieces = [`${typeText} of ${record.entity} on ${when} recorded by hand for ${name}, ${howText}`];
        if (noteText) pieces.push(noteText);
        if (physical) pieces.push(`deliverable obligation ${t.deliverable}, ${fmt(q * cut, ccy)} face delivered against par (simulated on paper: the Terminal moves no securities; the obligation is taken as ${s > 0 ? 'bought' : 'sold'} at the final price, ${fmt(q * cut * R, ccy)})`);
        else if (pay > 0) pieces.push(`protection ${fmt(prot, ccy)} (${fmt(q * cut, ccy)} x ${pctText((pay / cut) || 0, 3)})`);
        if (accrued !== 0) pieces.push(`accrued premium ${fmt(Math.abs(accrued), ccy)}${accrued < 0 ? ' refunded' : ''}`);
        pieces.push(net === 0 ? 'nothing paid' : `${net > 0 ? (later ? 'receivable' : 'received') : (later ? 'payable' : 'paid')} ${fmt(Math.abs(net), ccy)}${later ? ` on ${due}` : ''}${later && due === app.clock.today() && !settleDate ? ' (not enough settled cash today: it settles when the cash is there)' : ''}`);
        return pieces.join('; ');
      },
    }));
  }
  outcome = { ended: ends, indexFactor: newTerms.indexFactor ?? null, paidPerUnit: pay, note: noteText || null };
  return { eventIds, outcome };
}

/** ABS CDS pay-as-you-go event recorded by hand. */
export function paygo(app, inst, body, deps) {
  const t = inst.terms;
  const name = nameOf(inst);
  need(t.paygo, `Pay-as-you-go events apply to ABS credit default swaps; ${name} is not one.`);
  need(!t.ended, `${name} has ended (${t.ended?.date}: ${t.ended?.reason}).`);
  const kind = body.kind;
  need(PAYGO_KINDS[kind], `Choose the pay-as-you-go event: ${Object.keys(PAYGO_KINDS).join(', ')}.`);
  const when = checkDate(app, body.date, 'The date of the event');
  const factor = t.indexFactor ?? 1;
  const amount = num(body.amount);
  let newFactor = factor, pay = 0, cut = 0;
  if (kind === 'amortization') {
    need(amount !== null && amount >= 0 && amount < factor, `Enter the reference obligation's new factor, from 0 up to (not including) the current ${factor}.`);
    newFactor = amount; cut = factor - amount;
  } else {
    need(amount !== null && amount > 0, 'Enter the amount per 100 of original notional (above zero).');
    const a = amount / 100;
    if (kind === 'writedown' || kind === 'principal_shortfall') { need(a <= factor + 1e-12, `${PAYGO_KINDS[kind]} of ${amount} per 100 is more than the ${(factor * 100).toFixed(4)} per 100 outstanding.`); pay = a; cut = a; newFactor = factor - a; }
    if (kind === 'interest_shortfall') pay = a;
    if (kind === 'interest_reimbursement') pay = -a;
    if (kind === 'writedown_reimbursement') {
      const written = (t.defaults || []).filter((d) => d.paygo === 'writedown' || d.paygo === 'principal_shortfall').reduce((s, d) => s + d.amount, 0) - (t.defaults || []).filter((d) => d.paygo === 'writedown_reimbursement').reduce((s, d) => s + d.amount, 0);
      need(a <= written / 100 + 1e-12, `A reimbursement of ${amount} per 100 is more than the ${written} per 100 written down and not yet reimbursed.`);
      pay = -a; newFactor = factor + a;
    }
  }
  newFactor = Number(newFactor.toFixed(12));
  const ends = newFactor <= 1e-12;
  const newTerms = { ...t, indexFactor: newFactor, defaults: [...(t.defaults || []), { paygo: kind, amount: kind === 'amortization' ? null : amount, factor: newFactor, date: when, recordedOn: app.clock.today() }] };
  if (ends) newTerms.ended = { date: when, reason: 'the reference obligation is written down or paid down in full' };
  const ccy = inst.trading_ccy;
  app.instruments.update(inst.id, { terms: newTerms }, { system: true });
  const fresh = app.instruments.get(inst.id);
  const eventIds = [];
  for (const p of holders(app, fresh)) {
    const q = Math.abs(p.qty);
    eventIds.push(settleHolder(app, deps, {
      inst: fresh, p, when, affected: q * cut, protection: q * pay, endShare: factor > 0 ? Math.max(cut, 0) / factor : 0, close: ends, settleDate: null,
      type: 'cds.paygo',
      data: { paygo: kind, amount, oldFactor: factor, newFactor, endReason: newTerms.ended?.reason || null },
      summary: ({ accrued, net }) => [
        `${PAYGO_KINDS[kind]} on ${t.referenceObligation} recorded by hand for ${name} (${when})`,
        kind === 'amortization' ? `factor ${factor} to ${newFactor}, nothing paid for it` : `${fmt(Math.abs(q * pay), ccy)} (${amount} per 100 of ${fmt(q, ccy)}) ${pay > 0 ? 'paid by the protection seller' : 'paid by the protection buyer'}${cut ? `; factor ${factor} to ${newFactor}` : ''}${kind === 'writedown_reimbursement' ? `; factor ${factor} to ${newFactor}` : ''}`,
        accrued !== 0 ? `accrued premium on the ${cut ? 'reduced' : 'affected'} notional ${fmt(Math.abs(accrued), ccy)}` : null,
        net === 0 ? 'nothing to settle' : `${net > 0 ? 'received' : 'paid'} ${fmt(Math.abs(net), ccy)}`,
      ].filter(Boolean).join('; '),
    }));
  }
  return { eventIds, outcome: { indexFactor: newFactor, ended: ends } };
}

/** Loan CDS cancelled on refinancing: accrued premium settled, no protection payment, the contract ends. */
export function cancelOnRefinancing(app, inst, body, deps) {
  const t = inst.terms;
  const name = nameOf(inst);
  need(t.cancellable, `${name} is not cancellable: cancellation on refinancing applies to a loan CDS whose terms allow it.`);
  need(!t.ended, `${name} has ended (${t.ended?.date}: ${t.ended?.reason}).`);
  const when = checkDate(app, body.date, 'The cancellation date');
  need(when >= t.effective || t.convention === 'standard', `The cancellation date ${when} is before the effective date ${t.effective}.`);
  const reason = `cancelled: the reference loans of ${t.referenceEntity} were repaid and not replaced${body.note ? ` (${body.note})` : ''}`;
  const ccy = inst.trading_ccy;
  app.instruments.update(inst.id, { terms: { ...t, ended: { date: when, reason } } }, { system: true });
  const fresh = app.instruments.get(inst.id);
  const eventIds = [];
  for (const p of holders(app, fresh)) {
    const q = Math.abs(p.qty) * (t.indexFactor ?? 1);
    eventIds.push(settleHolder(app, deps, {
      inst: fresh, p, when, affected: q, protection: 0, endShare: 1, close: true, settleDate: null, type: 'cds.cancelled',
      data: { endReason: reason },
      summary: ({ accrued, net }) => `${name} cancelled on ${when}, recorded by hand: ${reason}. No protection is paid; accrued premium ${fmt(Math.abs(accrued), ccy)} to the cancellation date; ${net === 0 ? 'nothing to settle' : `${net > 0 ? 'received' : 'paid'} ${fmt(Math.abs(net), ccy)}`}`,
    }));
  }
  return { eventIds, outcome: { ended: true } };
}
