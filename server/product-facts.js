// Contract facts for the product-specific detail pages (p1): what the Terminal itself knows about a contract from its
// terms and its paper engine, never server data and never a valuation.
//
//   GET /api/instruments/:id/contract-facts?bookId=
//     accrued     bond: accrued interest per 100 face to today, worked out by the paper engine from the coupon schedule
//                 (the same figure the ticket and the ledger use); null with a reason when it cannot be (no fixing)
//     coupons     bond: the coupon dates still to come from the contract terms (accrual end and payment date), with the
//                 amount per 100 face only where the contract fixes it (a fixed coupon, or the current period of a
//                 floating coupon whose fixing is known); redemption date and price; call and put schedules as registered
//     legs        swap: each leg's periods still to come (start, end, payment date) from the contract terms and its
//                 payment calendar, and the next payment
//     premium     credit default swap: the premium periods still to come
//     scheduled   the paper engine's scheduled lifecycle work on this instrument in this Book (coupon, payment,
//                 expiry, maturity tasks), with their status; empty when the Book holds nothing in it
//
// Contract arithmetic only (dates and amounts the contract states); no yield, spread, Greek, curve or mark is
// computed here: those are shown only when the server supplies them (docs/SERVER-CLIENT.md).

import { adjust, addBusinessDays } from './quant/calendar.js';
import { couponDates, couponPer100 } from './quant/bond.js';
import { paymentCalendarFor } from './products/security.js';
import { legSchedule } from './products/swap.js';
import { periodsFrom } from './products/credit.js';
import { need } from './core/util.js';

const MAX_ROWS = 12;

export function registerProductFactsRoutes(r, app, { requireVisible }) {
  r.get('/api/instruments/:id/contract-facts', ({ params, query }) => {
    const inst = requireVisible(params.id, query.bookId);
    const today = app.clock.today();
    const out = { instrumentId: inst.id, family: inst.family, today, source: 'Terminal: contract terms and paper engine', accrued: null, coupons: null, legs: null, premium: null, scheduled: [] };
    try {
      if (inst.family === 'bond') Object.assign(out, bondFacts(app, inst, today));
      if (inst.family === 'swap' && Array.isArray(inst.terms?.legs)) out.legs = swapLegs(inst, today);
      if (inst.family === 'cds' && inst.terms?.effective && inst.terms?.maturity) out.premium = cdsPremium(inst, today);
    } catch (err) {
      out.error = `The schedule could not be worked out from the contract terms: ${err.message}`;
    }
    if (query.bookId) out.scheduled = scheduledIn(app, inst, query.bookId);
    return out;
  });

  /** Lifecycle tasks of this instrument in one Book, oldest due first (the paper engine's own schedule). */
  function scheduledIn(app, inst, bookId) {
    need(app.books.getBook(bookId), 'Unknown Book.', { status: 404 });
    const names = new Map(app.books.unitsOf(bookId).map((u) => [u.id, u.kind === 'treasury' ? 'Treasury' : u.name]));
    return app.db.all(`SELECT id, unit_id, type, due_date, status, blocked_reason, data FROM tasks WHERE instrument_id = ? AND book_id = ? AND status IN ('pending','blocked','failed') ORDER BY due_date, created_at LIMIT 40`, inst.id, bookId)
      .map((t) => ({ id: t.id, type: t.type, dueDate: t.due_date, status: t.status, blockedReason: t.blocked_reason || null, owner: names.get(t.unit_id) || null, legId: safeJson(t.data).legId ?? null }));
  }
}

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

function bondFacts(app, inst, today) {
  const plugin = app.products.get('bond');
  const t = inst.terms || {};
  // Accrued interest: the paper engine's figure (bond.js accruedAmount), per 100 face, to today.
  let per100 = null, why = null;
  try { per100 = plugin.accruedAmount(inst, 100, today); } catch (err) { why = err.message; }
  if (per100 === null && !why) why = t.couponType === 'float' ? `No ${t.referenceRate || 'reference rate'} fixing for the current coupon period, so the accrued interest cannot be worked out.` : 'Not available from the contract terms.';
  const accrued = {
    per100: Number.isFinite(per100) ? per100 : null, asOf: today, reason: why,
    note: t.couponSuspended ? 'Coupons are suspended: the bond trades flat, without accrued interest.' : typeof t.couponBarrier === 'number' ? 'A contingent coupon does not accrue: the note trades flat.' : null,
  };
  // Coupon schedule from the contract (bond.js couponDue: the payment date is the coupon date, or that many days after it
  // for paper with a payment delay, moved to the next business day of the payment calendar).
  const sched = plugin.schedTerms(inst);
  const cal = paymentCalendarFor(inst);
  const all = t.couponType === 'zero' ? [] : couponDates(sched, today);
  const rows = all.slice(0, MAX_ROWS).map((d, i) => {
    const payDate = adjust(t.paymentDelayDays ? addBusinessDays(d, t.paymentDelayDays, 'ALLDAYS') : d, 'following', cal);
    let amount = null, reason = null;
    if (t.couponSuspended) reason = 'Coupons suspended';
    else if (typeof t.couponBarrier === 'number') reason = `Contingent on ${t.linkedTo || 'the linked underlying'} on the coupon date`;
    else if (t.couponType === 'fixed') amount = couponPer100(sched, d);
    else if (t.couponType === 'float') {
      if (i === 0 && t.currentCoupon !== null && t.currentCoupon !== undefined) amount = couponPer100(sched, d);
      else reason = i === 0 ? 'Awaiting the fixing of the current period' : 'Set by the fixing at the start of its period';
    }
    return { accrualEnd: d, payDate, per100: Number.isFinite(amount) ? amount : null, reason };
  });
  const coupons = {
    type: t.couponType || null, frequency: t.frequency ?? null, dayCount: t.dayCount || null,
    rows, remaining: t.perpetual ? null : all.length, perpetual: Boolean(t.perpetual),
    redemption: t.perpetual ? null : { date: t.maturity || null, payDate: t.maturity ? adjust(t.maturity, 'following', cal) : null, pricePct: t.redemption ?? 100, factor: t.factor ?? 1 },
    calls: Array.isArray(t.callSchedule) ? t.callSchedule : [], puts: Array.isArray(t.putSchedule) ? t.putSchedule : [],
    calledOn: t.calledOn || null, calendar: cal,
  };
  return { accrued, coupons };
}

function swapLegs(inst, today) {
  return inst.terms.legs.map((leg) => {
    const periods = legSchedule(inst, leg).filter((p) => p.payDate >= today);
    return {
      id: leg.id, side: leg.side, type: leg.type, ccy: leg.ccy, months: leg.months ?? null, dayCount: leg.dayCount || null,
      index: leg.index || null, rate: leg.rate ?? null, spread: leg.spread ?? null,
      periods: periods.slice(0, MAX_ROWS).map((p) => ({ start: p.start, end: p.end, payDate: p.payDate })),
      remaining: periods.length, next: periods[0] ? { start: periods[0].start, end: periods[0].end, payDate: periods[0].payDate } : null,
    };
  });
}

function cdsPremium(inst, today) {
  const periods = periodsFrom(inst, today);
  return { coupon: inst.terms.coupon ?? null, periods: periods.slice(0, MAX_ROWS).map((p) => ({ start: p.start, end: p.end, payDate: p.payDate })), remaining: periods.length, next: periods[0] || null };
}
