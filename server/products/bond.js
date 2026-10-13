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
import { accruedPer100, couponPeriod, couponPer100, nextCouponDate } from '../quant/bond.js';
import { DAY_COUNTS, yearFraction } from '../quant/daycount.js';
import { AppError, ISO_DATE_RE, isZero, money, need, num } from '../core/util.js';
import { bookSecurityFill, dqOf, fmtPx, fmtQty, trueUpAccrual } from './common.js';
import { calendarFor, paymentCalendarFor, standardSettleDate } from './security.js';

/** Face outstanding per unit of original face (pool factor for securitised paper), as it stands now. */
const factorOf = (inst) => inst.terms.factor ?? 1;

/**
 * The pool factor in force on `date`. A paydown or loss recorded by hand with an effective date keeps the history in
 * `terms.factorHistory` ([{ from, factor, prior }], oldest first): a date before the first change has the factor that
 * stood before it. Without a history the current factor applies to every date.
 */
function factorOn(inst, date) {
  const h = inst.terms.factorHistory;
  if (!Array.isArray(h) || !h.length || !date) return factorOf(inst);
  for (let i = h.length - 1; i >= 0; i--) if (date >= h[i].from) return h[i].factor;
  return h[0].prior ?? factorOf(inst);
}

/** Catalog products that are inflation-linked: they must be registered with an index ratio. */
const LINKERS = new Set(['tips', 'foreign_inflation_linked']);
/**
 * b4: loans held at a price and traded by assignment (or sub-participation). A loan cannot be borrowed, so it cannot be sold
 * short: the ticket offers buy and sell only.
 */
const LOANS = new Set(['syndicated_loan', 'leveraged_loan', 'private_credit', 'loan_participation']);
const productOf = (inst) => inst?.product_id || inst?.productId || null;
/** Catalog products that convert or exchange into shares: they must be registered with the shares and a ratio. */
const CONVERTIBLES = new Set(['convertible_bond', 'exchangeable_bond']);

/**
 * A call or put schedule: an array of { date, price } or text such as "2028-06-15 101; 2029-06-15 100". Returns null when
 * nothing is stated, { error } when it cannot be read, else the entries sorted by date.
 */
function parseSchedule(v) {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return null;
  let rows;
  if (Array.isArray(v)) rows = v.map((x) => ({ date: String(x?.date || ''), price: num(x?.price) }));
  else {
    const text = String(v).trim();
    if (!text) return null;
    rows = text.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const m = /^(\d{4}-\d{2}-\d{2})\s*(?:@|at|:|,)?\s*(-?[\d.]+)\s*%?$/i.exec(x);
      return m ? { date: m[1], price: num(m[2]) } : { date: '', price: null, text: x };
    });
  }
  const bad = rows.find((r) => !ISO_DATE_RE.test(r.date) || !(r.price > 0));
  if (bad) return { error: `"${bad.text || `${bad.date} ${bad.price}`}" is not a date (YYYY-MM-DD) followed by a price in % of par.` };
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.some((r, i) => i && r.date === rows[i - 1].date)) return { error: 'two entries have the same date.' };
  return rows.map((r) => ({ date: r.date, price: r.price }));
}
const scheduleText = (rows) => rows.map((r) => `${r.date} at ${fmtPx(r.price)}`).join('; ');

/** An inflation-linked bond carries an index ratio (reference index on the date / reference index on the dated date). */
const isLinker = (inst) => typeof inst.terms.indexRatio === 'number';
/** The index ratio in force: the last one recorded by hand (1 for a nominal bond). */
const ratioOf = (inst) => (isLinker(inst) ? inst.terms.indexRatio : 1);
/** Principal outstanding per unit of face on `date`: pool factor times index ratio. */
const scaleOn = (inst, date) => factorOn(inst, date) * ratioOf(inst);
/**
 * Principal per unit of face on which the coupon of `couponDate` is paid: the factor in force on the last day of the
 * coupon period (a paydown effective from the coupon date itself belongs to the next period) times the index ratio.
 */
const couponScale = (inst, couponDate) => factorOn(inst, addBusinessDays(couponDate, -1, 'ALLDAYS')) * ratioOf(inst);
/** Words for a coupon or accrual line when the principal is not the face: current face, or adjusted principal. */
function principalNote(inst, face, scale) {
  const ccy = inst.trading_ccy;
  if (isLinker(inst)) return ` (index ratio ${fmtRatio(ratioOf(inst))}: adjusted principal ${fmt(money(Math.abs(face) * scale, ccy), ccy)})`;
  if (Math.abs(scale - 1) > 1e-12) return ` (factor ${Number(scale.toFixed(10))}: current face ${fmtQty(money(Math.abs(face) * scale, ccy))})`;
  return '';
}
const fmtRatio = (r) => Number(r).toFixed(5);
/**
 * The day a coupon (and the principal of the same period) is paid: its coupon date, or for securitised paper with a payment
 * delay that many calendar days after it (the accrual period ends on the coupon date; Fannie Mae pays 24 days later, on the
 * 25th), moved to the next business day of the payment calendar.
 */
function couponDue(inst, couponDate) {
  const delay = inst.terms.paymentDelayDays || 0;
  return adjust(delay ? addBusinessDays(couponDate, delay, 'ALLDAYS') : couponDate, 'following', paymentCalendarFor(inst));
}

/**
 * b4: a structured note with a contingent coupon. The coupon of each coupon date is paid only if the linked underlying, observed
 * on that date and recorded by hand (terms.observations), is at or above the coupon barrier (a fraction of the initial level).
 * Nothing accrues between coupon dates (the note trades flat). At maturity the principal is par if protected; otherwise par if
 * the final observation is at or above the principal barrier, else par x final / initial.
 */
const isContingent = (inst) => typeof inst.terms?.couponBarrier === 'number' && typeof inst.terms?.initialLevel === 'number';
function contingentPer100(inst, couponDate) {
  const lvl = inst.terms.observations?.[couponDate];
  if (lvl === undefined || lvl === null) return null;
  return lvl >= inst.terms.couponBarrier * inst.terms.initialLevel - 1e-9 ? (100 * inst.terms.couponRate) / inst.terms.frequency : 0;
}
/** Coupon per 100 of principal for the coupon of `couponDate` (null while its fixing or observation is missing). */
function per100Of(inst, couponDate) {
  return isContingent(inst) ? contingentPer100(inst, couponDate) : couponPer100(couponTerms(inst, couponDate), couponDate);
}
const fmtLevel = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 6 });
const pctText = (x, dp = 2) => `${(x * 100).toFixed(dp)}%`;

/** The trades booked on a position: signed face, trade date and settlement date of each fill. */
function fillsOf(app, positionId) {
  // fw: a bond delivered on a physically settled forward or option is a fill of the position as well (its own event type).
  return app.db.all(`SELECT business_date, data FROM events WHERE position_id = ? AND type IN ('trade.fill', 'forward.delivery', 'option.delivery') ORDER BY id`, positionId)
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
    const per100 = per100Of(inst, c.couponDate);
    if (per100 === null) return null;
    total += (entitledFace(app, pos, c.couponDate) * couponScale(inst, c.couponDate) * per100) / 100;
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
  actions: (inst) => (LOANS.has(productOf(inst)) ? ['buy', 'sell'] : ['buy', 'sell', 'sell_short', 'buy_to_cover']),
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
    // Inflation-linked bonds: principal = face x index ratio (reference index on the date / reference index on the dated
    // date). The Terminal has no inflation index feed: the ratio is entered at registration and recorded by hand after.
    if (LINKERS.has(draft.productId) && (t.indexRatio === undefined || t.indexRatio === null || t.indexRatio === '')) errors.push('An inflation-linked bond needs its index ratio (reference index today / reference index on the dated date), for example 1.03514. It is not assumed.');
    if (t.indexRatio === undefined || t.indexRatio === null || t.indexRatio === '') { delete t.indexRatio; delete t.inflationFloor; } else {
      t.indexRatio = num(t.indexRatio);
      if (!(t.indexRatio > 0 && t.indexRatio < 20)) errors.push('Index ratio must be a positive number such as 1.03514.');
      t.inflationFloor = Boolean(t.inflationFloor);
    }
    // Call and put schedules: [{ date, price }], entered as "2028-06-15 101; 2029-06-15 100".
    for (const [key, label] of [['callSchedule', 'Call schedule'], ['putSchedule', 'Put schedule']]) {
      const parsed = parseSchedule(t[key]);
      if (parsed === null) { delete t[key]; continue; }
      if (parsed.error) errors.push(`${label}: ${parsed.error}`);
      else t[key] = parsed;
    }
    // Conversion into shares (convertible and exchangeable bonds): the shares are the instrument's underlying.
    if (CONVERTIBLES.has(draft.productId) && !draft.underlying_id) errors.push('A convertible or exchangeable bond needs the shares it converts into (Shares delivered on conversion).');
    if (t.conversionRatio === undefined || t.conversionRatio === null || t.conversionRatio === '') {
      delete t.conversionRatio;
      if (CONVERTIBLES.has(draft.productId)) errors.push('A convertible or exchangeable bond needs its conversion ratio: shares per 1,000 face.');
    } else {
      t.conversionRatio = num(t.conversionRatio);
      if (!(t.conversionRatio > 0)) errors.push('Conversion ratio must be a positive number of shares per 1,000 face.');
      if (!draft.underlying_id) errors.push('A conversion ratio needs the shares it converts into (Shares delivered on conversion).');
    }
    // Securitised paper: payment delay after the accrual period ends, and the guarantor of an agency pool.
    if (t.paymentDelayDays === undefined || t.paymentDelayDays === null || t.paymentDelayDays === '') delete t.paymentDelayDays;
    else {
      t.paymentDelayDays = num(t.paymentDelayDays);
      if (!(Number.isInteger(t.paymentDelayDays) && t.paymentDelayDays >= 0 && t.paymentDelayDays <= 60)) errors.push('Payment delay must be a whole number of days from 0 to 60.');
    }
    if (typeof t.guarantor === 'string') t.guarantor = t.guarantor.trim();
    if (!t.guarantor) delete t.guarantor;
    // b4: a specified pool is a pool chosen for its stated characteristics (loan balance cap, LTV, FICO, geography, loan
    // purpose...): it is priced on them (a pay-up over the TBA), so they are part of what it is and are never assumed.
    if (typeof t.poolCharacteristics === 'string') t.poolCharacteristics = t.poolCharacteristics.trim();
    if (!t.poolCharacteristics) delete t.poolCharacteristics;
    if (draft.productId === 'specified_pool' && !t.poolCharacteristics) errors.push('A specified pool needs its stated characteristics (for example: maximum loan balance, LTV, FICO, geography, loan purpose). They are what the pool is priced on and are not assumed.');
    // b4: servicing fee of an asset-backed pass-through: deducted from the interest collected before holders are paid. The coupon
    // rate stated is the gross rate; holders accrue and are paid the net rate (gross less the fee; for a floating coupon, the
    // fixing plus the spread less the fee).
    if (t.servicingFeeRate === undefined || t.servicingFeeRate === null || t.servicingFeeRate === '') delete t.servicingFeeRate;
    else {
      t.servicingFeeRate = num(t.servicingFeeRate);
      if (!(t.servicingFeeRate >= 0 && t.servicingFeeRate < 0.2)) errors.push('Servicing fee must be a decimal rate a year, such as 0.005 for 0.50%.');
      else if (t.couponType === 'zero') errors.push('A servicing fee is deducted from interest: a zero-coupon instrument has none to deduct it from.');
      else if (t.couponType === 'fixed' && !(t.servicingFeeRate < t.couponRate)) errors.push('The servicing fee must be below the gross coupon rate it is deducted from.');
    }
    // b4: a contingent coupon (structured note): the underlying observed, its initial level, the coupon barrier, and the principal
    // at maturity (protected, or a principal barrier below which it follows the underlying).
    const given = (v) => v !== undefined && v !== null && v !== '';
    if (typeof t.linkedTo === 'string') t.linkedTo = t.linkedTo.trim();
    if (given(t.couponBarrier) || given(t.initialLevel)) {
      t.couponBarrier = num(t.couponBarrier); t.initialLevel = num(t.initialLevel);
      if (!t.linkedTo) errors.push('A contingent coupon needs the underlying it is observed on (Linked to).');
      if (!(t.initialLevel > 0)) errors.push('A contingent coupon needs the underlying\'s initial level.');
      if (!(t.couponBarrier > 0 && t.couponBarrier <= 2)) errors.push('The coupon barrier is a fraction of the initial level, such as 0.7 for 70%.');
      if (t.couponType !== 'fixed') errors.push('A contingent coupon is a fixed rate paid when the barrier condition is met: choose a fixed coupon.');
      t.principalProtected = Boolean(t.principalProtected);
      if (t.principalProtected) delete t.principalBarrier;
      else {
        t.principalBarrier = num(t.principalBarrier);
        if (!(t.principalBarrier > 0 && t.principalBarrier <= 1)) errors.push('A note without principal protection needs its principal barrier, a fraction of the initial level such as 0.6.');
      }
      if (t.observations && typeof t.observations !== 'object') delete t.observations;
    } else { delete t.couponBarrier; delete t.initialLevel; delete t.principalProtected; delete t.principalBarrier; delete t.observations; if (!t.linkedTo) delete t.linkedTo; }
    // b4: the trading documentation of a loan traded by assignment: LSTA/LMA par (settles T+7 by market practice, with delayed
    // compensation to the buyer when it settles later) or distressed (T+20, no delayed compensation). The lag itself is the
    // instrument's settlement convention.
    if (t.tradingDocs === undefined || t.tradingDocs === null || t.tradingDocs === '') delete t.tradingDocs;
    else if (!['par', 'distressed'].includes(t.tradingDocs)) errors.push('Trading documentation must be par or distressed.');
    // b4: a catastrophe bond: the issue's principal sits in a collateral trust account (its assets and custodian are a term), the
    // sponsor (the ceding insurer) is paid out of it when a covered event triggers a principal loss, and the trigger is stated.
    for (const k of ['collateralAccount', 'sponsor', 'trigger']) { if (typeof t[k] === 'string') t[k] = t[k].trim(); if (!t[k]) delete t[k]; }
    if (draft.productId === 'catastrophe_bond' && !t.collateralAccount) errors.push('A catastrophe bond needs its collateral account: where the principal is held in trust and in what assets (for example: trust account at the custodian, invested in US Treasury money-market funds).');
    if (t.issueSize === undefined || t.issueSize === null || t.issueSize === '') delete t.issueSize;
    else { t.issueSize = num(t.issueSize); if (!(t.issueSize > 0)) errors.push('Issue size must be a face amount above 0.'); }
    // b4: a credit-linked note pays its coupon and principal unless its reference entity has a credit event: the entity is part of
    // what the note is.
    if (typeof t.referenceEntity === 'string') t.referenceEntity = t.referenceEntity.trim();
    if (!t.referenceEntity) delete t.referenceEntity;
    if (draft.productId === 'credit_linked_note' && !t.referenceEntity) errors.push('A credit-linked note needs its reference entity: the company or sovereign whose credit event ends the coupon and reduces principal to the recovery.');
    // b4: a deferrable tranche (a CLO or CDO mezzanine class, a PIK-toggle loan): a coupon may be paid in kind, capitalised into
    // principal instead of paid in cash. The election is recorded by hand for each coupon (manual event 'pik').
    t.pikAllowed = Boolean(t.pikAllowed);
    if (!t.pikAllowed) delete t.pikAllowed;
    // b4: a fixed PIK component (private credit: e.g. SOFR + 6.00% cash plus 2.00% PIK): that part of every coupon is capitalised
    // automatically; holders accrue the whole rate.
    if (t.pikRate === undefined || t.pikRate === null || t.pikRate === '') delete t.pikRate;
    else { t.pikRate = num(t.pikRate); if (!(t.pikRate > 0 && t.pikRate < 0.3)) errors.push('The PIK rate is a decimal a year, such as 0.02 for 2.00% paid in kind.'); else if (t.couponType === 'zero') errors.push('A PIK component needs a coupon schedule.'); }
    // b4: the lender's undrawn commitment of a delayed-draw loan, funded by draws recorded by hand.
    if (t.undrawnCommitment === undefined || t.undrawnCommitment === null || t.undrawnCommitment === '') delete t.undrawnCommitment;
    else { t.undrawnCommitment = num(t.undrawnCommitment); if (!(t.undrawnCommitment >= 0)) errors.push('The undrawn commitment is an amount of 0 or more.'); }
    if (!Array.isArray(t.pikCoupons) || !t.pikCoupons.length) delete t.pikCoupons;
    // b4: priority of a sequential-pay tranche (a CMO class): it receives principal only after the tranche senior to it has
    // been paid down to zero. The senior tranche's stated balance is a term; what is left of it is recorded by hand from each
    // remittance report (senior_balance), and a paydown of this tranche is refused while any of it is outstanding.
    if (typeof t.seniorTranche === 'string') t.seniorTranche = t.seniorTranche.trim();
    if (!t.seniorTranche) { delete t.seniorTranche; delete t.seniorBalance; delete t.seniorRemaining; } else {
      t.seniorBalance = num(t.seniorBalance);
      if (!(t.seniorBalance > 0)) errors.push(`State the original balance of ${t.seniorTranche}, the tranche paid principal first.`);
      const rem = t.seniorRemaining === undefined || t.seniorRemaining === null || t.seniorRemaining === '' ? t.seniorBalance : num(t.seniorRemaining);
      if (!(rem >= 0) || (t.seniorBalance > 0 && rem > t.seniorBalance)) errors.push(`The balance of ${t.seniorTranche} still outstanding must be between 0 and its original balance.`);
      t.seniorRemaining = rem;
    }
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
    if (typeof t.indexRatio === 'number') {
      rows.push(['Index ratio', `${fmtRatio(t.indexRatio)} (entered by hand${t.indexRatioAsOf ? `, as of ${t.indexRatioAsOf}` : ', at registration'})`]);
      rows.push(['Principal at maturity', t.inflationFloor ? 'Face x index ratio, never less than par (deflation floor)' : 'Face x index ratio (no deflation floor)']);
    }
    if (t.minDenomination > 1) rows.push(['Minimum denomination', `${fmtQty(t.minDenomination)} face`]);
    if (t.callSchedule) rows.push(['Issuer call', `${scheduleText(t.callSchedule)} (callable from each date at its price; recorded by hand)`]);
    if (t.putSchedule) rows.push(['Holder put', `${scheduleText(t.putSchedule)} (on each date at its price; recorded by hand)`]);
    if (t.calledOn) rows.push(['Called', `Redeemed in full on ${t.calledOn}`]);
    if (t.conversionRatio) rows.push(['Conversion', `${t.conversionRatio} shares per 1,000 face (recorded by hand; accrued interest is forfeited)`]);
    if (t.paymentDelayDays) rows.push(['Payment delay', `${t.paymentDelayDays} days after each accrual period ends`]);
    if (t.guarantor) rows.push(['Guarantor', `${t.guarantor} (principal and interest guaranteed; no loss allocation)`]);
    if (t.poolCharacteristics) rows.push(['Pool characteristics', `${t.poolCharacteristics} (stated at registration)`]);
    if (t.repricings?.length) rows.push(['Repricings', t.repricings.map((r) => `${r.from}: spread ${(r.prior * 100).toFixed(3)}% to ${(r.spread * 100).toFixed(3)}%${r.premium ? ` (premium ${fmtPx(r.premium)}%)` : ''}`).join('; ')]);
    if (t.tradingDocs) rows.push(['Trading documentation', t.tradingDocs === 'par' ? 'Par (assignment): delayed compensation to the buyer for the days a trade settles after the standard date' : 'Distressed (assignment): no delayed compensation']);
    if (t.collateralAccount) rows.push(['Collateral account', `${t.collateralAccount}${t.issueSize ? `; holds the outstanding principal, ${fmtQty(money(t.issueSize * (t.factor ?? 1), inst.trading_ccy))} of the ${fmtQty(t.issueSize)} issued` : ''}${t.collateralReleased ? `; released to the sponsor so far ${fmtQty(t.collateralReleased)}` : ''}`]);
    if (t.sponsor) rows.push(['Sponsor (ceding insurer)', t.sponsor]);
    if (t.trigger) rows.push(['Trigger', `${t.trigger} (a covered event and its principal loss are recorded by hand)`]);
    if (typeof t.couponBarrier === 'number') {
      rows.push(['Contingent coupon', `${(t.couponRate * 100).toFixed(3)}% a year, paid on a coupon date only if ${t.linkedTo} is at or above ${fmtLevel(t.couponBarrier * t.initialLevel)} (${pctText(t.couponBarrier, 0)} of the initial ${fmtLevel(t.initialLevel)}) on that date; observations recorded by hand; trades flat`]);
      rows.push(['Principal at maturity', t.principalProtected ? 'Protected: par' : `Par if ${t.linkedTo} finishes at or above ${fmtLevel(t.principalBarrier * t.initialLevel)} (${pctText(t.principalBarrier, 0)} of initial), else par x final / initial (not protected)`]);
      const obs = Object.entries(t.observations || {});
      if (obs.length) rows.push(['Observations', obs.map(([d, l]) => `${d}: ${fmtLevel(l)}`).join('; ')]);
    }
    if (t.referenceEntity) rows.push(['Reference entity', t.creditEvent ? `${t.referenceEntity}: credit event recorded ${t.creditEvent.date}, principal settled at the recovery ${fmtPx(t.creditEvent.recovery * 100)}% of par on ${t.creditEvent.settleDate}; coupons ended` : `${t.referenceEntity} (a credit event, recorded by hand, ends the coupon and settles principal at the recovery)`]);
    if (t.pikRate) rows.push(['PIK interest', `${(t.pikRate * 100).toFixed(3)}% a year on top of the cash coupon, capitalised into principal on each coupon date`]);
    if (typeof t.undrawnCommitment === 'number') rows.push(['Undrawn commitment', `${fmtQty(t.undrawnCommitment)} ${inst.trading_ccy}: funded at par by draws recorded by hand on an interest payment date`]);
    if (t.pikAllowed) rows.push(['Interest deferral', `Deferrable: a coupon may be paid in kind (capitalised into principal), elected by hand for each coupon${t.pikCoupons?.length ? `; paid in kind: ${t.pikCoupons.join(', ')}` : ''}`]);
    if (t.seniorTranche) rows.push(['Priority', `Sequential: principal only after ${t.seniorTranche} (stated balance ${fmtQty(t.seniorBalance)}) is retired; ${t.seniorRemaining > 0 ? `${fmtQty(t.seniorRemaining)} of it outstanding, as last recorded by hand` : `retired${t.seniorRetiredOn ? ` (recorded ${t.seniorRetiredOn})` : ''}: this tranche now receives principal`}`]);
    if (t.servicingFeeRate) rows.push(['Servicing fee', `${(t.servicingFeeRate * 100).toFixed(3)}% a year, deducted from interest before holders are paid${t.couponType === 'fixed' ? `: net coupon ${((t.couponRate - t.servicingFeeRate) * 100).toFixed(3)}%` : ''}`]);
    if (t.writtenDown) rows.push(['Written down', `${t.writtenDown.kind === 'loss' ? 'Losses allocated' : 'Principal written down'} to factor ${t.factor} on ${t.writtenDown.date}`]);
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
    // A floating-rate note whose coupon rate for the period is not known: the accrued interest that changes hands cannot be
    // computed, and booking it as zero would be a figure made up. The trade waits for the fixing.
    if (inst.terms?.couponType === 'float' && settleDate && !inst.terms.couponSuspended && bond.accruedAmount(inst, 1, settleDate) === null) {
      return { code: 'no_fixing', message: `${inst.symbol || inst.name} has no ${inst.terms.referenceRate} fixing for its current coupon period, so the accrued interest of this trade cannot be computed. Supply or enter the fixing (Data connection, Manual entries) first.` };
    }
    // b4: a credit-linked note after its reference entity's credit event: principal was settled at the recovery.
    if (inst.terms?.creditEvent) return { code: 'credit_event', message: `${inst.symbol || inst.name}: a credit event of ${inst.terms.referenceEntity} was recorded on ${inst.terms.creditEvent.date}; the notes were settled at the recovery (${fmtPx(inst.terms.creditEvent.recovery * 100)}% of par) and can no longer be traded.` };
    // Called in full by the issuer (recorded by hand): nothing is outstanding to trade.
    if (inst.terms?.calledOn) return { code: 'called', message: `${inst.symbol || inst.name} was called by the issuer and redeemed in full on ${inst.terms.calledOn}. It can no longer be traded.` };
    const m = inst.terms?.perpetual ? null : inst.terms?.maturity;
    if (!m || !settleDate || settleDate < m) return null;
    const name = inst.symbol || inst.name;
    return app.clock.today() >= m
      ? { code: 'matured', message: `${name} matured on ${m} and was redeemed. It can no longer be traded.` }
      : { code: 'matured', message: `${name} matures on ${m}; this trade would settle on ${settleDate}, ${settleDate > m ? 'after' : 'when'} it is redeemed. A trade must settle before maturity: state an earlier settlement date, or hold to redemption.` };
  },
  schedTerms,
  accruedAmount(inst, qty, date) {
    // Coupons suspended (a default, a missed or cancelled coupon recorded by hand): nothing accrues and the bond trades
    // flat, without accrued interest, until coupons are resumed.
    if (inst.terms.couponSuspended) return 0;
    if (isContingent(inst)) return 0; // b4: a contingent coupon does not accrue: the note trades flat
    const ai = accruedPer100(schedTerms(inst), date);
    return ai === null ? null : (qty * scaleOn(inst, date) * ai) / 100;
  },
  economics(app, { inst, action, qty, price, settleDate, tradeDate, book }) {
    const ccy = inst.trading_ccy;
    const scale = scaleOn(inst, settleDate);
    const principal = (qty * scale * price) / 100;
    const ai = bond.accruedAmount(inst, qty, settleDate);
    const buy = action === 'buy' || action === 'buy_to_cover';
    const notes = [];
    if (ai === null) notes.push('Accrued interest cannot be computed: the floating coupon has no fixing. It is booked as zero until the fixing is supplied.');
    if (inst.terms.couponSuspended) notes.push('Coupons are suspended: the bond trades flat, without accrued interest.');
    if (isContingent(inst)) notes.push('Contingent coupon: nothing accrues between coupon dates, so the note trades flat.');
    const dc = price > 0 ? delayedComp(app, { inst, action, qty, price, settleDate, tradeDate, book }) : null;
    if (dc) notes.push(`Delayed compensation (par documentation): settling ${dc.days} days after the standard date ${dc.standard}, the seller pays the buyer the interest for those days, ${fmt(dc.interest, ccy)}, less the cost of carry on the purchase price, ${fmt(dc.carry, ccy)}: ${fmt(Math.abs(dc.net), ccy)} ${buy ? (dc.net >= 0 ? 'received' : 'paid') : (dc.net >= 0 ? 'paid' : 'received')} at settlement, separately from the trade.`);
    // Principal and accrued interest are each rounded to the cent, as the fill books them, so the previewed
    // settlement amount is the amount that settles.
    const total = money(principal, ccy) + money(ai || 0, ccy);
    return { ccy, principal, cash: buy ? -total : total, accrued: ai || 0, notional: qty * scale, exposure: buy ? principal : -principal, initialMargin: 0, notes };
  },
  fill(app, c) {
    const f = scaleOn(c.inst, c.settleDate);
    const ai = bond.accruedAmount(c.inst, c.qty, c.settleDate) || 0;
    const r = bookSecurityFill(app, c, {
      unitCost: (c.price * f) / 100,
      accrued: ai,
      receiveAccounts: c.action === 'sell_short' ? ['cash.restricted'] : ['cash'],
      payAccounts: c.action === 'buy_to_cover' ? ['cash.restricted', 'cash'] : ['cash'],
    });
    // b4: delayed compensation of a par loan trade settling after its standard date, settled with the trade.
    const dc = delayedComp(app, { inst: c.inst, action: c.action, qty: c.qty, price: c.price, settleDate: c.settleDate, tradeDate: c.tradeDate, book: c.book });
    if (dc && dc.net !== 0) {
      const ccy = c.inst.trading_ccy;
      const buy = c.action === 'buy' || c.action === 'buy_to_cover';
      const amount = buy ? dc.net : -dc.net; // + the holder receives
      app.ledger.post({
        bookId: c.book.id, unitId: c.unit.id, type: 'loan.delayed_compensation', instrumentId: c.inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: r.position.id, actor: 'engine',
        summary: `Delayed compensation on ${c.inst.symbol || c.inst.name} (par trade settling ${c.settleDate}, ${dc.days} days after the standard date ${dc.standard}): interest ${fmt(dc.interest, ccy)} less cost of carry ${fmt(dc.carry, ccy)} on the purchase price, ${fmt(Math.abs(amount), ccy)} ${amount >= 0 ? 'receivable from the seller' : 'payable to the buyer'} at settlement`,
        data: { ...dc, settleDate: c.settleDate },
        entries: [{ account: amount >= 0 ? 'recv.settle' : 'pay.settle', ccy, amount, positionId: r.position.id }, { account: 'pnl.coupon', ccy, amount: -amount, positionId: r.position.id }],
      });
      app.settle.create({ bookId: c.book.id, unitId: c.unit.id, fillId: c.fillId, orderId: c.order?.id, instrumentId: c.inst.id, strategyId: c.strategyId, positionId: r.position.id, kind: 'delayed_comp', dueDate: c.settleDate, ccy, amount, accounts: ['cash'] });
    }
    return r;
  },
  value(app, inst, pos, obs, mark) {
    const ccy = inst.trading_ccy;
    const known = mark !== null && mark !== undefined;
    const scale = factorOf(inst) * ratioOf(inst);
    const clean = known ? money((pos.qty * scale * mark) / 100, ccy) : null;
    return {
      price: known ? mark : null,
      mv: clean, // clean value; accrued interest is carried in the ledger's accrued account
      cost: pos.cost,
      unrealized: known ? money(clean - pos.cost, ccy) : null,
      accrued: app.ledger.positionBalance(pos.id, 'accrued.asset', ccy),
      notional: money(Math.abs(pos.qty) * scale, ccy),
      // Average cost per 100 of the principal outstanding (current face, or adjusted principal), the units the price is quoted in.
      ...(Math.abs(scale - 1) > 1e-12 && !isZero(pos.qty) ? { avgCost: Math.round((pos.cost / (pos.qty * scale * 0.01)) * 1e6) / 1e6 } : {}),
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
        const per100 = per100Of(inst, c.couponDate);
        if (per100 === null) owed = null; // a floating coupon without its fixing: the balance waits for it
        else if (owed !== null) owed += (face * couponScale(inst, c.couponDate) * per100) / 100;
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
    if (next && inst.terms.couponType !== 'zero') app.tasks.schedule({ ...common, type: 'bond.coupon', dueDate: couponDue(inst, next), data: { key: next, couponDate: next } });
    if (inst.terms.maturity) app.tasks.schedule({ ...common, type: 'bond.maturity', dueDate: couponDue(inst, inst.terms.maturity) });
  },
  dataNeeds(app, { inst, task, date }) {
    if (inst.terms.couponType !== 'float') return {};
    // Back far enough for the fixing of the coupon period being paid or accrued (a quarterly period is three months long).
    const ref = task?.data?.couponDate ? addBusinessDays(task.data.couponDate, -1, 'ALLDAYS') : (date || app.clock.today());
    const start = couponPeriod(schedTerms(inst), ref)?.start || ref;
    const recent = addBusinessDays(app.clock.today(), -15, 'ALLDAYS');
    const from = addBusinessDays(start, -15, 'ALLDAYS');
    return { rateCodes: [inst.terms.referenceRate], rateFrom: from < recent ? from : recent };
  },
  /** Daily accrual true-up: earned interest goes to coupon income as it accrues. */
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty) || inst.terms.couponSuspended) return;
    // The balance already stands at a later date (a coupon was paid before this end-of-day run caught up).
    if (pos.data?.accruedThrough && date < pos.data.accruedThrough) return;
    // A floating rate missing for the period that is running is taken as soon as it is supplied or entered. Not while a
    // coupon that has fallen due still waits for the fixing of the period before (that is the coupon's to take).
    if (inst.terms.couponType === 'float' && !unpaidCoupons(app, pos.id).some((c) => c.couponDate <= date)) inst = takeFixing(app, inst, couponPeriod(schedTerms(inst), date)?.start);
    accrueTo(app, { book, unit, inst, pos, date });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    const { ledger, positions } = app;
    const ccy = inst.trading_ccy;
    const base = { bookId: book.id, unitId: unit.id, instrumentId: inst.id, strategyId: pos?.strategy_id, positionId: pos?.id, actor: 'engine' };
    if (!pos) return 'done';
    if (task.type === 'bond.coupon') {
      const couponDate = task.data.couponDate;
      // A floating coupon whose period had no fixing takes it now if it has since been supplied or entered (the fixing of the
      // period's first day; never a later one).
      const periodStart = couponPeriod(schedTerms(inst), addBusinessDays(couponDate, -1, 'ALLDAYS'))?.start || null;
      // (Not when another holder's payment already reset the coupon: the period's rate is then kept in periodCoupons, b4.)
      if (inst.terms.couponType === 'float' && (inst.terms.periodCoupons?.[couponDate] ?? null) === null) inst = takeFixing(app, inst, periodStart);
      const t = schedTerms(inst);
      // Entitlement: face settled before the coupon date.
      const face = entitledFace(app, pos, couponDate);
      const live = positions.get(pos.id);
      const scheduleNext = () => {
        const next = nextCouponDate(t, couponDate);
        if (next && !isZero(live.qty)) app.tasks.schedule({ ...base, type: 'bond.coupon', dueDate: couponDue(inst, next), data: { key: next, couponDate: next } });
      };
      if (isZero(face)) { scheduleNext(); return 'done'; }
      if (inst.terms.couponSuspended) {
        // A coupon date that passes while coupons are suspended is not paid, and says so in the history.
        const eventId = ledger.post({ ...base, type: 'bond.coupon_missed', summary: `Coupon of ${couponDate} not paid on ${fmtQty(Math.abs(face))} ${inst.symbol || inst.name}: coupons are suspended`, data: { couponDate, face } });
        scheduleNext();
        return { done: true, eventId };
      }
      const per100 = per100Of(inst, couponDate);
      // b4: a contingent coupon waits for its observation, entered by hand.
      if (per100 === null && isContingent(inst)) {
        return { blocked: `Awaiting the observation of ${inst.terms.linkedTo} on ${couponDate} for the contingent coupon: record it by hand (instrument form, Observation).`, needs: [] };
      }
      if (per100 === 0 && isContingent(inst)) {
        const lvl = inst.terms.observations[couponDate];
        const eventId = ledger.post({ ...base, type: 'bond.contingent_coupon', summary: `Contingent coupon of ${couponDate} not paid on ${fmtQty(Math.abs(face))} ${inst.symbol || inst.name}: ${inst.terms.linkedTo} observed at ${fmtLevel(lvl)}, below the coupon barrier ${fmtLevel(inst.terms.couponBarrier * inst.terms.initialLevel)} (${pctText(inst.terms.couponBarrier, 0)} of the initial ${fmtLevel(inst.terms.initialLevel)})`, data: { couponDate, face, observation: lvl, paid: false } });
        scheduleNext();
        return { done: true, eventId };
      }
      if (per100 === null) {
        return { blocked: `Awaiting the ${inst.terms.referenceRate} fixing of ${periodStart} for the coupon period ${periodStart} to ${couponDate}. ${app.data.describe().awaitingMessage}, or enter the fixing manually.`, needs: [{ kind: 'rate', subject: inst.terms.referenceRate, date: periodStart }] };
      }
      const cScale = couponScale(inst, couponDate);
      const amount = money((face * cScale * per100) / 100, ccy);
      // b4: a coupon elected to be paid in kind is capitalised: principal (the factor) rises by the coupon for every holder,
      // once for the instrument; this holder's coupon goes into its position's cost instead of its cash.
      if ((inst.terms.pikCoupons || []).includes(couponDate)) {
        let fresh = app.instruments.get(inst.id);
        if (!(fresh.terms.pikApplied || {})[couponDate]) {
          const old = factorOf(fresh);
          const nf = Math.round(old * (1 + per100 / 100) * 1e10) / 1e10;
          app.instruments.update(inst.id, { terms: { ...fresh.terms, factor: nf, factorHistory: [...(fresh.terms.factorHistory || []), { from: couponDate, factor: nf, prior: old, pik: true }], pikApplied: { ...(fresh.terms.pikApplied || {}), [couponDate]: nf } } }, { system: true });
          fresh = app.instruments.get(inst.id);
        }
        const nf = fresh.terms.pikApplied[couponDate];
        const eventId = ledger.post({
          ...base, type: 'bond.pik', summary: `Coupon of ${couponDate} paid in kind on ${fmtQty(Math.abs(face))} ${inst.symbol || inst.name}${principalNote(inst, face, cScale)}: ${fmt(Math.abs(amount), ccy)} added to principal, factor ${Number(cScale.toFixed(10))} to ${nf}`,
          data: { couponDate, per100, face, pik: true, factor: nf },
          entries: [{ account: 'pos', ccy, amount, positionId: pos.id }, { account: 'accrued.asset', ccy, amount: -amount, positionId: pos.id }],
        });
        app.positions.change(live, { dCost: amount });
        if (inst.terms.couponType === 'float') resetFloat(app, fresh, couponDate);
        const asOf = live.data?.accruedThrough && live.data.accruedThrough > couponDate ? live.data.accruedThrough : couponDate;
        if (!isZero(live.qty)) accrueTo(app, { book, unit, inst: app.instruments.get(inst.id), pos: positions.get(pos.id), date: asOf, paying: couponDate });
        scheduleNext();
        return { done: true, eventId };
      }
      // b4: a servicing fee came off the gross interest before the holder was paid: say how much.
      let servicing = '';
      if (inst.terms.servicingFeeRate) {
        const grossPer100 = couponPer100({ ...t, couponRate: inst.terms.couponType === 'fixed' ? inst.terms.couponRate : t.couponRate, currentCoupon: inst.terms.couponType === 'float' ? (inst.terms.periodCoupons?.[couponDate] ?? inst.terms.currentCoupon) : t.currentCoupon }, couponDate);
        const gross = money((face * cScale * grossPer100) / 100, ccy);
        servicing = `; gross interest ${fmt(Math.abs(gross), ccy)} less servicing fee ${fmt(Math.abs(money(gross - amount, ccy)), ccy)} (${(inst.terms.servicingFeeRate * 100).toFixed(3)}% a year)`;
      }
      if (isContingent(inst)) servicing = ` (contingent coupon: ${inst.terms.linkedTo} observed at ${fmtLevel(inst.terms.observations[couponDate])}, at or above the coupon barrier ${fmtLevel(inst.terms.couponBarrier * inst.terms.initialLevel)})`;
      // b4: a fixed PIK component: that part of the coupon is capitalised (factor up once for the instrument, cost up), the rest paid.
      if (inst.terms.pikRate && !inst.terms.couponSuspended) {
        const pikPer100 = couponPer100({ ...couponTerms(inst, couponDate), couponType: 'fixed', couponRate: inst.terms.pikRate }, couponDate);
        const pikAmount = money((face * cScale * pikPer100) / 100, ccy);
        const cashAmount = money(amount - pikAmount, ccy);
        let fresh = app.instruments.get(inst.id);
        if (!(fresh.terms.pikApplied || {})[couponDate]) {
          const old = factorOf(fresh);
          const nf = Math.round(old * (1 + pikPer100 / 100) * 1e10) / 1e10;
          app.instruments.update(inst.id, { terms: { ...fresh.terms, factor: nf, factorHistory: [...(fresh.terms.factorHistory || []), { from: couponDate, factor: nf, prior: old, pik: true }], pikApplied: { ...(fresh.terms.pikApplied || {}), [couponDate]: nf } } }, { system: true });
          fresh = app.instruments.get(inst.id);
        }
        const nf = fresh.terms.pikApplied[couponDate];
        const eventId = ledger.post({
          ...base, type: 'bond.coupon', summary: `Coupon received on ${fmtQty(Math.abs(face))} ${inst.symbol || inst.name}${principalNote(inst, face, cScale)}: ${fmt(Math.abs(cashAmount), ccy)} in cash and ${fmt(Math.abs(pikAmount), ccy)} paid in kind (${(inst.terms.pikRate * 100).toFixed(3)}% PIK added to principal, factor ${Number(cScale.toFixed(10))} to ${nf}): ${fmt(Math.abs(amount), ccy)}`,
          data: { couponDate, per100, face, pikPer100, pikAmount, cashAmount, factor: nf, ...(Math.abs(cScale - 1) > 1e-12 ? { scale: cScale } : {}) },
          entries: [{ account: 'cash', ccy, amount: cashAmount, positionId: pos.id }, { account: 'pos', ccy, amount: pikAmount, positionId: pos.id }, { account: 'accrued.asset', ccy, amount: -amount, positionId: pos.id }],
        });
        app.positions.change(live, { dCost: pikAmount });
        if (inst.terms.couponType === 'float') resetFloat(app, fresh, couponDate);
        const asOf = live.data?.accruedThrough && live.data.accruedThrough > couponDate ? live.data.accruedThrough : couponDate;
        if (!isZero(live.qty)) accrueTo(app, { book, unit, inst: app.instruments.get(inst.id), pos: positions.get(pos.id), date: asOf, paying: couponDate });
        scheduleNext();
        return { done: true, eventId };
      }
      const eventId = ledger.post({
        // A short owes the coupon to the lender of the securities: it is paid, on the face sold short.
        ...base, type: 'bond.coupon', summary: `Coupon ${amount >= 0 ? 'received' : 'paid'} on ${fmtQty(Math.abs(face))} ${inst.symbol || inst.name}${face < 0 ? ' sold short' : ''}${principalNote(inst, face, cScale)}${servicing}: ${fmt(Math.abs(amount), ccy)}`,
        data: { couponDate, per100, face, ...(Math.abs(cScale - 1) > 1e-12 ? { scale: cScale } : {}) },
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
      // b4: a structured note's principal at maturity follows its final observation unless it is protected.
      if (isContingent(inst)) {
        const t2 = inst.terms;
        const fin = t2.observations?.[t2.maturity];
        let price = t2.redemption, note = '';
        if (!t2.principalProtected) {
          if (fin === undefined || fin === null) return { blocked: `Awaiting the final observation of ${t2.linkedTo} on ${t2.maturity}: the principal repaid depends on it. Record it by hand (instrument form, Observation).`, needs: [] };
          const ratio = fin / t2.initialLevel;
          if (ratio < t2.principalBarrier - 1e-12) {
            price = Math.round(t2.redemption * ratio * 1e6) / 1e6;
            note = ` (final observation ${fmtLevel(fin)} is ${pctText(ratio)} of the initial ${fmtLevel(t2.initialLevel)}, below the principal barrier ${pctText(t2.principalBarrier, 0)}: not protected, principal repaid at the underlying's performance)`;
          } else note = ` (final observation ${fmtLevel(fin)} at or above the principal barrier ${pctText(t2.principalBarrier, 0)} of the initial: par)`;
        } else note = ' (principal protected: par whatever the final observation)';
        const r = redeem(app, { book, unit, inst, pos: live, price, face: Math.abs(live.qty), date: inst.terms.maturity, type: 'bond.redemption', label: 'Redeemed at maturity', note: `${note}` });
        bond.onPositionChange(app, { book, unit, inst, pos: positions.get(pos.id) });
        return { done: true, eventId: r.eventId };
      }
      // An inflation-linked bond repays its adjusted principal (face x index ratio); with a deflation floor (US TIPS) never
      // less than the face.
      const ratio = ratioOf(inst);
      const floored = isLinker(inst) && inst.terms.inflationFloor && ratio < 1;
      const face = Math.abs(live.qty);
      const note = !isLinker(inst) ? '' : floored
        ? ` on index ratio ${fmtRatio(ratio)}, below 1: principal floored at par, ${fmt(money(face * factorOf(inst) * inst.terms.redemption / 100, inst.trading_ccy), inst.trading_ccy)}`
        : ` on index ratio ${fmtRatio(ratio)}: adjusted principal ${fmt(money(face * factorOf(inst) * ratio * inst.terms.redemption / 100, inst.trading_ccy), inst.trading_ccy)}`;
      const r = redeem(app, { book, unit, inst, pos: live, price: inst.terms.redemption, face, date: inst.terms.maturity, type: 'bond.redemption', label: 'Redeemed at maturity', scale: factorOf(inst) * (floored ? 1 : ratio), note });
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
  /**
   * Coupon suspension by hand (an issuer default or a missed coupon; a cancelled discretionary coupon), and its resumption.
   * Suspending puts every holding on non-accrual: the interest accrued and not yet received is reversed out of coupon and
   * interest income, in every Book, because it will not be paid; no interest accrues, coupon dates pass unpaid (each one
   * listed in the history) and the bond trades flat. Resuming restarts accrual and payment from the next end of day.
   */
  suspendCoupons(app, { inst, suspended }) {
    app.instruments.update(inst.id, { terms: { ...inst.terms, couponSuspended: Boolean(suspended) } }, { system: true });
    if (!suspended) return { suspended: false };
    const ccy = inst.trading_ccy;
    const name = inst.symbol || inst.name;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (app.ledger.positionBalance(p.id, 'accrued.asset', ccy) === 0) continue;
      const book = app.books.getBook(p.book_id), unit = app.books.getUnit(p.unit_id);
      const id = trueUpAccrual(app, { book, unit, pos: p, inst, account: 'accrued.asset', pnlAccount: 'pnl.coupon', ccy, target: 0, summary: `Accrued interest reversed on ${name}: coupons suspended, not accrued or paid`, type: 'accrual.coupon' });
      if (id) eventIds.push(id);
    }
    return { suspended: true, eventIds };
  },
  /** Instrument-level events recorded by hand (POST /api/instruments/:id/lifecycle). */
  manualEvent(app, { inst, action, body }) {
    if (action === 'index_ratio') return bond.recordIndexRatio(app, { inst, ratio: body.ratio, asOf: body.asOf });
    if (action === 'call') return bond.callIssue(app, { inst, price: body.price, share: body.share, note: body.note });
    if (action === 'writedown') return bond.writeDown(app, { inst, newFactor: body.newFactor, effective: body.effective, kind: body.kind, note: body.note });
    if (action === 'senior_balance') return bond.recordSeniorBalance(app, { inst, remaining: body.remaining, note: body.note });
    if (action === 'pik') return bond.electPik(app, { inst, couponDate: body.couponDate, note: body.note });
    if (action === 'credit_event') return bond.creditEvent(app, { inst, recovery: body.recovery, settleDate: body.settleDate, note: body.note });
    if (action === 'observation') return bond.recordObservation(app, { inst, date: body.date, level: body.level, note: body.note });
    if (action === 'reprice') return bond.reprice(app, { inst, spread: body.spread, premium: body.premium, note: body.note });
    throw new AppError(`Unknown debt-security event "${action}".`);
  },
  /** Position-level events recorded by hand (POST /api/positions/:id/lifecycle). */
  positionEvent(app, ctx) {
    if (ctx.action === 'put') return bond.exercisePut(app, { ...ctx, face: ctx.body.face, label: ctx.body.label });
    if (ctx.action === 'convert') return bond.convert(app, { ...ctx, face: ctx.body.face, sharePrice: ctx.body.sharePrice, settlement: ctx.body.settlement });
    if (ctx.action === 'draw') return bond.draw(app, { ...ctx, amount: ctx.body.amount, note: ctx.body.note });
    throw new AppError(`Unknown debt-security event "${ctx.action}".`);
  },
  /**
   * Index ratio of an inflation-linked bond recorded by hand (the Terminal has no inflation index feed).
   * The rule: principal outstanding = face x index ratio. For every holder, in every Book, the change in principal at par
   * (face x pool factor x (new ratio - old ratio)) is inflation accretion: it is added to the position's carrying cost and
   * booked as coupon and interest income (a fall in the ratio, deflation, is a negative accretion). The accrued interest,
   * which runs on the adjusted principal, is trued up to today at the new ratio. Later trades settle at the new ratio,
   * coupons are paid on face x ratio, and redemption repays face x ratio (floored at par when the bond has a deflation floor).
   */
  recordIndexRatio(app, { inst, ratio, asOf }) {
    const name = inst.symbol || inst.name;
    need(isLinker(inst), `${name} is not an inflation-linked bond: it was registered without an index ratio.`);
    const r = num(ratio);
    need(r !== null && r > 0 && r < 20, 'Enter the index ratio as a positive number, for example 1.03514.');
    const old = ratioOf(inst);
    need(Math.abs(r - old) > 1e-12, `The index ratio of ${name} is already ${fmtRatio(old)}.`);
    const today = app.clock.today();
    const date = asOf ? String(asOf) : today;
    need(ISO_DATE_RE.test(date), 'The date the index ratio applies to must be YYYY-MM-DD.');
    app.instruments.update(inst.id, { terms: { ...inst.terms, indexRatio: r, indexRatioAsOf: date } }, { system: true });
    const fresh = app.instruments.get(inst.id);
    const ccy = inst.trading_ccy;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const book = app.books.getBook(p.book_id), unit = app.books.getUnit(p.unit_id);
      const accretion = money(p.qty * factorOf(inst) * (r - old), ccy);
      eventIds.push(app.ledger.post({
        bookId: book.id, unitId: unit.id, type: 'bond.index_ratio', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user',
        summary: `Index ratio of ${name} recorded by hand: ${fmtRatio(old)} to ${fmtRatio(r)} (as of ${date}). Principal of ${fmtQty(Math.abs(p.qty))} face${p.qty < 0 ? ' sold short' : ''} ${p.qty * (r - old) >= 0 ? 'up' : 'down'} ${fmt(Math.abs(accretion), ccy)}: inflation ${accretion >= 0 ? 'accretion earned' : 'accretion lost'}`,
        data: { from: old, to: r, asOf: date, accretion, manual: true },
        entries: [{ account: 'pos', ccy, amount: accretion, positionId: p.id }, { account: 'pnl.coupon', ccy, amount: -accretion, positionId: p.id }],
      }));
      const after = app.positions.change(p, { dCost: accretion });
      if (!fresh.terms.couponSuspended) accrueTo(app, { book, unit, inst: fresh, pos: after, date: today });
    }
    return { indexRatio: r, eventIds };
  },
  /**
   * Issuer call recorded by hand, for the whole issue: every holder, in every Book, is redeemed at the call price in force
   * today under the call schedule (callable from each date at its price), with the accrued interest to today paid with it.
   * `share` below 1 is a partial call, pro rata: that share of each holding (in whole minimum denominations) is redeemed and
   * the rest stays outstanding. A full call closes every holding, cancels the remaining coupons and redemption, and the
   * bond can no longer be traded. A call before the first call date, or at a price other than the one in force, is refused.
   * (The call notice period is not modelled: the call is recorded on the redemption date.)
   */
  callIssue(app, { inst, price, share, note }) {
    const name = inst.symbol || inst.name;
    const sched = inst.terms.callSchedule;
    need(Array.isArray(sched) && sched.length, `${name} has no call schedule: it was registered as not callable by the issuer. A tender or another early redemption is recorded on a position (Lifecycle, Early redemption).`);
    need(!inst.terms.calledOn, `${name} was called in full on ${inst.terms.calledOn}; nothing is left outstanding.`);
    const today = app.clock.today();
    const inForce = [...sched].reverse().find((r) => r.date <= today);
    need(inForce, `${name} is not callable before ${sched[0].date}, its first call date (at ${fmtPx(sched[0].price)}% of par).`);
    const has = (v) => v !== undefined && v !== null && v !== '';
    const p = has(price) ? num(price) : inForce.price;
    need(p !== null && Math.abs(p - inForce.price) < 1e-9, `The call price in force on ${today} is ${fmtPx(inForce.price)}% of par (from ${inForce.date} under the call schedule); a call at ${fmtPx(p)} is not in the terms.`);
    const sh = has(share) ? num(share) : 1;
    need(sh !== null && sh > 0 && sh <= 1, 'The share of the issue called must be above 0 and at most 1 (1 = the whole issue).');
    const full = sh >= 1 - 1e-12;
    const step = inst.terms.minDenomination || 1;
    const eventIds = [];
    for (const pos of app.positions.heldAround(inst.id)) {
      if (isZero(pos.qty)) continue;
      const book = app.books.getBook(pos.book_id), unit = app.books.getUnit(pos.unit_id);
      const face = full ? Math.abs(pos.qty) : Math.round((Math.abs(pos.qty) * sh) / step) * step;
      if (!(face > 0)) continue;
      const label = full ? 'Issuer call recorded by hand (whole issue)' : `Partial issuer call recorded by hand (${Number((sh * 100).toFixed(6))}% of the issue, pro rata)`;
      const r = redeem(app, { book, unit, inst, pos, price: p, face, date: today, type: 'bond.call', label: note ? `${label}, ${note}` : label, actor: 'user', accrued: Math.abs(bond.accruedAmount(inst, face, today) || 0) });
      eventIds.push(r.eventId);
      bond.onPositionChange(app, { book, unit, inst, pos: app.positions.get(pos.id) });
    }
    if (full) app.instruments.update(inst.id, { terms: { ...app.instruments.get(inst.id).terms, calledOn: today, calledAt: p } }, { system: true });
    return { price: p, share: sh, eventIds };
  },
  /**
   * Holder put recorded by hand: a long holder puts `face` back to the issuer on a put date of the schedule (moved to the
   * next payment day when it is not one), at that date's put price, with the accrued interest to today paid with it.
   * Any other day is refused and the put dates are named. (The put notice window is not modelled.)
   */
  exercisePut(app, { book, unit, inst, pos, face, label }) {
    const name = inst.symbol || inst.name;
    const sched = inst.terms.putSchedule;
    need(Array.isArray(sched) && sched.length, `${name} has no put schedule: the holder cannot put it back to the issuer.`);
    need(pos.qty > 0, 'Only a holder (a long position) can put the bonds back to the issuer.');
    const today = app.clock.today();
    const cal = paymentCalendarFor(inst);
    const entry = sched.find((r) => r.date === today || adjust(r.date, 'following', cal) === today);
    if (!entry) {
      const next = sched.find((r) => r.date > today);
      throw new AppError(`${today} is not a put date of ${name}. The holder may put only on ${scheduleText(sched)}${next ? `; the next is ${next.date}` : '; no put date is left'}.`);
    }
    const f = face === undefined || face === null || face === '' ? pos.qty : num(face);
    need(f > 0 && f <= pos.qty + 1e-9, `The position is ${fmtQty(pos.qty)} face; cannot put ${fmtQty(f)}.`);
    const step = inst.terms.minDenomination || 1;
    need(Math.abs(f / step - Math.round(f / step)) < 1e-9, `The face put must be a multiple of the minimum denomination, ${fmtQty(step)}.`);
    const r = redeem(app, { book, unit, inst, pos, price: entry.price, face: f, date: today, type: 'bond.put', label: `Holder put recorded by hand (put date ${entry.date})${label ? `, ${label}` : ''}`, actor: 'user', accrued: Math.abs(bond.accruedAmount(inst, f, today) || 0) });
    return { price: entry.price, eventId: r.eventId };
  },
  /**
   * Conversion (convertible bond) or exchange (exchangeable bond) into shares, recorded by hand by a long holder.
   * Shares = face / 1,000 x conversion ratio. The rule the Terminal applies:
   *   - the bonds converted leave the position at their carrying cost (average cost), with no realized P&L;
   *   - the whole shares open in the same strategy instance at that carrying cost (less the part of it that belongs to a
   *     fraction of a share), booked as a simulated delivery;
   *   - a fraction of a share is paid in cash at the share price entered by hand; its share of the cost against that cash
   *     is realized P&L;
   *   - the accrued interest on the bonds converted is forfeited (US market practice: no payment for accrued interest on
   *     conversion): it is reversed out of coupon and interest income.
   * With `settlement: 'cash'` (the issuer's election to pay cash instead of shares) the bonds are redeemed for the shares'
   * value at the share price entered, and the difference from carrying cost is realized; accrued interest is forfeited.
   */
  convert(app, { book, unit, inst, pos, face, sharePrice, settlement }) {
    const name = inst.symbol || inst.name;
    const ratio = inst.terms.conversionRatio;
    need(ratio > 0 && inst.underlying_id, `${name} does not convert into shares: it has no conversion ratio or shares registered.`);
    need(pos.qty > 0, 'Only a holder (a long position) can convert the bonds into shares.');
    const und = app.instruments.get(inst.underlying_id);
    need(und, 'The shares this bond converts into are not in the registry.');
    need(und.trading_ccy === inst.trading_ccy, `The shares trade in ${und.trading_ccy} and the bond in ${inst.trading_ccy}: a conversion across currencies is not supported.`);
    const f = face === undefined || face === null || face === '' ? pos.qty : num(face);
    need(f > 0 && f <= pos.qty + 1e-9, `The position is ${fmtQty(pos.qty)} face; cannot convert ${fmtQty(f)}.`);
    const step = inst.terms.minDenomination || 1;
    need(Math.abs(f / step - Math.round(f / step)) < 1e-9, `The face converted must be a multiple of the minimum denomination, ${fmtQty(step)}.`);
    const cash = settlement === 'cash';
    const shares = Math.round((f / 1000) * ratio * 1e8) / 1e8;
    const whole = cash ? 0 : Math.floor(shares + 1e-9);
    const frac = Math.round((shares - whole) * 1e8) / 1e8;
    const px = sharePrice === undefined || sharePrice === null || sharePrice === '' ? null : num(sharePrice);
    need(!(frac > 0) || (px !== null && px > 0), cash
      ? 'Enter the share price the cash settlement is worked out at.'
      : `${fmtQty(f)} face converts into ${fmtQty(shares)} shares: enter the share price for the fraction of a share paid in cash.`);
    const ccy = inst.trading_ccy;
    const today = app.clock.today();
    const costOut = isZero(f - pos.qty) ? pos.cost : money((pos.cost * f) / pos.qty, ccy);
    const costShares = cash ? 0 : isZero(frac) ? costOut : money((costOut * whole) / shares, ccy);
    const cashPaid = money(frac * (px || 0), ccy);
    const realized = money(cashPaid - (costOut - costShares), ccy);
    const forfeited = isZero(f - pos.qty) ? app.ledger.positionBalance(pos.id, 'accrued.asset', ccy) : money((app.ledger.positionBalance(pos.id, 'accrued.asset', ccy) * f) / pos.qty, ccy);
    const exchange = inst.product_id === 'exchangeable_bond' || inst.productId === 'exchangeable_bond';
    const verb = exchange ? 'Exchange' : 'Conversion';
    const undName = und.symbol || und.name;
    const undPos = cash ? null : app.positions.ensure({ bookId: book.id, unitId: unit.id, instrumentId: und.id, strategyId: pos.strategy_id });
    const entries = [
      { account: 'pos', ccy, amount: -costOut, positionId: pos.id },
      ...(cash ? [] : [{ account: 'pos', ccy, amount: costShares, positionId: undPos.id }]),
      { account: 'cash', ccy, amount: cashPaid, positionId: pos.id },
      { account: 'pnl.realized', ccy, amount: -realized, positionId: pos.id },
      { account: 'accrued.asset', ccy, amount: -forfeited, positionId: pos.id },
      { account: 'pnl.coupon', ccy, amount: forfeited, positionId: pos.id },
    ].filter((e) => e.amount !== 0);
    const summary = cash
      ? `${verb} recorded by hand, settled in cash by the issuer: ${fmtQty(f)} ${name} for the value of ${fmtQty(shares)} ${undName} at ${fmtPx(px)} ${ccy}: ${fmt(cashPaid, ccy)}${realized ? ` (realized ${fmt(realized, ccy)})` : ''}${forfeited ? `; accrued interest ${fmt(forfeited, ccy)} forfeited` : ''}`
      : `${verb} recorded by hand: ${fmtQty(f)} ${name} into ${fmtQty(whole)} ${undName} (simulated delivery, ${ratio} shares per 1,000 face) at the bonds' carrying cost ${fmt(costShares, ccy)}${frac > 0 ? `; ${fmtQty(frac)} of a share paid in cash at ${fmtPx(px)}: ${fmt(cashPaid, ccy)}${realized ? ` (realized ${fmt(realized, ccy)})` : ''}` : ''}${forfeited ? `; accrued interest ${fmt(forfeited, ccy)} forfeited` : ''}`;
    const eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: exchange ? 'bond.exchange' : 'bond.conversion', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
      summary, data: { face: f, ratio, shares, wholeShares: whole, fraction: frac, sharePrice: px, settlement: cash ? 'cash' : 'shares', costOut, costShares, cashPaid, realized, forfeited, sharesInstrumentId: und.id, simulated: true, manual: true },
      entries,
    });
    app.positions.change(pos, { dQty: -f, dCost: -costOut });
    if (!cash && whole > 0) {
      const after = app.positions.change(undPos, { dQty: whole, dCost: costShares });
      const undPlugin = app.products.get(und.family);
      if (undPlugin.onPositionChange) undPlugin.onPositionChange(app, { book, unit, inst: und, pos: after });
    }
    return { eventId, shares, wholeShares: whole, cashPaid, realized, forfeited };
  },
  /**
   * Principal written down by hand without payment: a contingent convertible's trigger event (kind 'writedown') or a
   * realized loss allocated to a securitisation tranche (kind 'loss'). The factor falls from its current value to
   * `newFactor` for every holder, in every Book, from `effective` (default today; for a monthly pool, the first day of the
   * accrual period the loss applies to). Each position's cost falls in proportion and the cost written off is a realized
   * loss; no cash moves. Interest accrued on the principal written off is cancelled (the accrued balance is trued up on the
   * reduced principal). A loss cannot be allocated to a pool whose principal is guaranteed (an agency pool). A full
   * write-down (factor 0) is recorded on each position as an early redemption at 0 instead.
   */
  writeDown(app, { inst, newFactor, effective, kind, note }) {
    const name = inst.symbol || inst.name;
    // b4: 'trigger' is a catastrophe bond's covered event: a principal loss like an allocated loss, with the collateral released.
    const cat = kind === 'trigger';
    const loss = kind === 'loss' || cat;
    need(!(loss && inst.terms.guarantor), `${name} is guaranteed by ${inst.terms.guarantor}: losses on the underlying loans are not passed to holders. A defaulted loan's principal reaches the pool as a paydown (principal paid at par), recorded as a paydown.`);
    const nf = num(newFactor);
    const old = factorOf(inst);
    need(nf !== 0, `A full write-down of ${name} (factor 0) is recorded on each position as an early redemption at 0 (Lifecycle, Early redemption).`);
    need(nf !== null && nf > 0 && nf < old, `The principal outstanding after the ${loss ? 'loss' : 'write-down'} must be a factor above 0 and below the current factor ${old}.`);
    const today = app.clock.today();
    const from = effective ? String(effective) : today;
    need(ISO_DATE_RE.test(from) && from <= today, 'The effective date must be YYYY-MM-DD and not later than today.');
    const ccy = inst.trading_ccy;
    const history = [...(inst.terms.factorHistory || []), { from, factor: nf, prior: old }];
    const released = cat && inst.terms.issueSize ? money(inst.terms.issueSize * (old - nf), ccy) : null;
    app.instruments.update(inst.id, { terms: { ...inst.terms, factor: nf, factorHistory: history, writtenDown: { kind: cat ? 'trigger' : loss ? 'loss' : 'writedown', date: today, from }, ...(released ? { collateralReleased: money((inst.terms.collateralReleased || 0) + released, ccy) } : {}) } }, { system: true });
    const fresh = app.instruments.get(inst.id);
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const book = app.books.getBook(p.book_id), unit = app.books.getUnit(p.unit_id);
      const costOut = money((p.cost * (old - nf)) / old, ccy);
      const faceOff = money(Math.abs(p.qty) * (old - nf), ccy);
      eventIds.push(app.ledger.post({
        bookId: book.id, unitId: unit.id, type: cat ? 'bond.trigger' : loss ? 'bond.loss' : 'bond.writedown', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user',
        summary: `${cat ? 'Covered event recorded by hand on' : loss ? 'Realized loss allocated by hand to' : 'Principal written down by hand on'} ${name}${note ? ` (${note})` : ''}: factor ${old} to ${nf}${from !== today ? ` from ${from}` : ''}, ${fmtQty(faceOff)} of principal written off with no payment (${fmtQty(Math.abs(p.qty))} original face); cost ${fmt(Math.abs(costOut), ccy)} written off as realized ${p.qty > 0 ? 'loss' : 'gain'}${cat ? `${released ? `; ${fmt(released, ccy)} of collateral released from the collateral account to ${inst.terms.sponsor || 'the sponsor'}` : `; the collateral is released to ${inst.terms.sponsor || 'the sponsor'}`}` : ''}`,
        data: { kind: cat ? 'trigger' : loss ? 'loss' : 'writedown', oldFactor: old, newFactor: nf, effective: from, costOut, manual: true, ...(released ? { collateralReleased: released } : {}) },
        entries: [{ account: 'pos', ccy, amount: -costOut, positionId: p.id }, { account: 'pnl.realized', ccy, amount: costOut, positionId: p.id }],
      }));
      const after = app.positions.change(p, { dCost: -costOut });
      // Interest accrued on the principal written off is cancelled: the balance is trued up on the reduced principal, as of
      // the last date it stands at.
      if (!fresh.terms.couponSuspended) {
        const asOf = after.data?.accruedThrough && after.data.accruedThrough <= today ? after.data.accruedThrough : today;
        const target = accrualTarget(app, fresh, after, asOf);
        if (target !== null) {
          const id = trueUpAccrual(app, { book, unit, pos: after, inst: fresh, account: 'accrued.asset', pnlAccount: 'pnl.coupon', ccy, target: money(target, ccy), summary: `Accrued interest cancelled with the principal written off on ${name}`, type: 'accrual.coupon' });
          if (id) eventIds.push(id);
        }
      }
    }
    return { factor: nf, eventIds };
  },
  /** Principal paydown by hand: the pool factor falls and the paid-down face is redeemed at par. */
  /**
   * Principal paydown by hand (scheduled amortisation and prepayments of securitised paper): the pool factor falls from its
   * current value to `newFactor` for every holder, in every Book. Each holder is paid the face it was entitled to on the
   * effective date (face settled before it) x (old factor - new factor) x the redemption price (and index ratio, if any);
   * its position's cost falls in proportion and the difference from the cash is realized P&L (a premium or discount on the
   * principal returned).
   *   effective         the date the new factor applies from (the first day of the accrual period it is published for);
   *                     today when not given. Accrued interest and coupons of the period that started on it run on the new
   *                     factor; the coupon of the period that ended before it keeps the old one.
   *   payDate           the day the principal is paid (with the coupon of the period that has ended, after the payment
   *                     delay): a receivable until then, settled on that date. Today when not given (paid at once).
   *   scheduledFactor   optional: the factor after the scheduled amortisation only. The history then says how much of the
   *                     principal was scheduled and how much was prepaid (and the single monthly mortality, SMM).
   */
  /**
   * A draw on a delayed-draw loan, recorded by hand by the lender (b4): the borrower draws `amount` of the lender's undrawn
   * commitment and the lender funds it at par, in cash, now. The principal joins the interest period that starts today, so a draw
   * is recorded on an interest payment date (the start of a period); interest for a stub from another day is not modelled. The
   * position's face rises by amount / factor (principal outstanding per unit of face), its cost by the amount.
   */
  draw(app, { book, unit, inst, pos, amount, note }) {
    const name = inst.symbol || inst.name;
    const t = inst.terms;
    need(typeof t.undrawnCommitment === 'number', `${name} has no undrawn commitment: it is not a delayed-draw loan.`);
    need(pos.qty > 0, 'Only the lender (a long position) funds a draw.');
    const ccy = inst.trading_ccy;
    const a = money(num(amount), ccy);
    need(a > 0, 'Enter the amount drawn.');
    need(a <= t.undrawnCommitment + 0.004, `The undrawn commitment of ${name} is ${fmt(t.undrawnCommitment, ccy)}; ${fmt(a, ccy)} cannot be drawn.`);
    const today = app.clock.today();
    const st = schedTerms(inst);
    need(nextCouponDate(st, addBusinessDays(today, -1, 'ALLDAYS')) === today, `A draw funds at the start of an interest period: record it on an interest payment date of ${name} (the next is ${nextCouponDate(st, today)}). A stub period from another day is not modelled.`);
    const have = app.ledger.cash(unit.id, ccy).availableToWithdraw;
    need(have >= a - 0.004, `${unit.name} has ${fmt(have, ccy)} available; the draw needs ${fmt(a, ccy)}.`, { code: 'insufficient_cash' });
    const scale = scaleOn(inst, today);
    const dq = Math.round((a / scale) * 1e8) / 1e8;
    const left = money(t.undrawnCommitment - a, ccy);
    app.instruments.update(inst.id, { terms: { ...t, undrawnCommitment: left } }, { system: true });
    const eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'loan.draw', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'user',
      summary: `Draw funded on ${name}, recorded by hand${note ? ` (${note})` : ''}: ${fmt(a, ccy)} of principal at par (${fmtQty(dq)} face${Math.abs(scale - 1) > 1e-12 ? ` at factor ${Number(scale.toFixed(10))}` : ''}); undrawn commitment ${fmt(t.undrawnCommitment, ccy)} to ${fmt(left, ccy)}`,
      data: { amount: a, face: dq, scale, undrawnBefore: t.undrawnCommitment, undrawnAfter: left, manual: true },
      entries: [{ account: 'cash', ccy, amount: -a, positionId: pos.id }, { account: 'pos', ccy, amount: a, positionId: pos.id }],
    });
    app.positions.change(pos, { dQty: dq, dCost: a });
    return { eventId, amount: a, face: dq };
  },
  /**
   * A repricing amendment of a floating-rate loan, recorded by hand (b4): the lenders agree a new spread over the reference rate.
   * It takes effect at the start of an interest period (recorded on the payment date that starts it, after that day's interest
   * has been paid and the rate reset): the running period's rate becomes the fixing plus the new spread, and so do later resets.
   * A repricing within the soft-call period pays every holder a premium (`premium`, % of principal outstanding, e.g. 1 for
   * "101 soft call"), received at once as interest income.
   */
  reprice(app, { inst, spread, premium, note }) {
    const name = inst.symbol || inst.name;
    const t = inst.terms;
    need(t.couponType === 'float', `${name} pays a fixed coupon: a repricing of the spread applies to floating-rate loans.`);
    const sp = num(spread);
    need(sp !== null && sp >= 0 && sp < 0.5, 'Enter the new spread as a decimal a year (0.03 = 3.00%).');
    need(Math.abs(sp - (t.spread || 0)) > 1e-12, `The spread of ${name} is already ${((t.spread || 0) * 100).toFixed(3)}%.`);
    const has = (v) => v !== undefined && v !== null && v !== '';
    const prem = has(premium) ? num(premium) : 0;
    need(prem !== null && prem >= 0 && prem <= 10, 'The repricing premium is a percentage of principal from 0 to 10 (1 for a 101 soft call).');
    const today = app.clock.today();
    const st = schedTerms(inst);
    // The interest period that starts on the payment date that is today.
    let start = null;
    for (const d of [today, ...[1, 2, 3, 4, 5, 6, 7].map((k) => addBusinessDays(today, -k, 'ALLDAYS'))]) {
      if (nextCouponDate(st, addBusinessDays(d, -1, 'ALLDAYS')) === d && couponDue(inst, d) === today) { start = d; break; }
    }
    need(start, `A repricing takes effect at the start of an interest period: record it on an interest payment date of ${name}. Today is not one.`);
    const waiting = app.db.get(`SELECT 1 AS x FROM tasks WHERE instrument_id = ? AND type = 'bond.coupon' AND status IN ('pending','blocked','failed') AND json_extract(data, '$.couponDate') = ?`, inst.id, start);
    need(!waiting, `The interest due today on ${name} has not been paid yet: it is paid at the old spread first.`);
    const old = t.spread || 0;
    const current = t.currentCoupon === null || t.currentCoupon === undefined ? t.currentCoupon : Math.round((t.currentCoupon - old + sp) * 1e10) / 1e10;
    app.instruments.update(inst.id, { terms: { ...t, spread: sp, currentCoupon: current, repricings: [...(t.repricings || []), { from: start, spread: sp, prior: old, premium: prem }] } }, { system: true });
    const ccy = inst.trading_ccy;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const amount = prem > 0 ? money(Math.abs(p.qty) * scaleOn(inst, today) * prem / 100, ccy) * Math.sign(p.qty) : 0;
      eventIds.push(app.ledger.post({
        bookId: p.book_id, unitId: p.unit_id, type: 'loan.repricing', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user',
        summary: `Repricing of ${name} recorded by hand${note ? ` (${note})` : ''}: spread ${(old * 100).toFixed(3)}% to ${(sp * 100).toFixed(3)}% from ${start}${current !== null && current !== undefined ? `, the period's rate ${((current) * 100).toFixed(3)}%` : ''}${amount ? `; repricing premium ${fmtPx(prem)}% of principal: ${fmt(Math.abs(amount), ccy)} ${amount > 0 ? 'received' : 'paid'}` : ''}`,
        data: { from: start, spread: sp, prior: old, premium: prem, amount, manual: true },
        entries: amount ? [{ account: 'cash', ccy, amount, positionId: p.id }, { account: 'pnl.coupon', ccy, amount: -amount, positionId: p.id }] : [],
      }));
    }
    return { spread: sp, from: start, eventIds };
  },
  /**
   * The observation of a structured note's linked underlying on a coupon date, recorded by hand (b4; the Terminal has no index
   * feed for it). It decides that date's contingent coupon (paid if at or above the coupon barrier) and, on the maturity date,
   * the principal repaid. Each holder gets a history line; the coupon or redemption waiting for it then completes.
   */
  recordObservation(app, { inst, date, level, note }) {
    const name = inst.symbol || inst.name;
    const t = inst.terms;
    need(isContingent(inst), `${name} has no contingent coupon: there is nothing to observe.`);
    const d = String(date || '');
    need(ISO_DATE_RE.test(d), 'Enter the observation date (a coupon date) as YYYY-MM-DD.');
    need(d <= app.clock.today(), `${d} is in the future: an observation is recorded on or after its date.`);
    const st = schedTerms(inst);
    need(nextCouponDate(st, addBusinessDays(d, -1, 'ALLDAYS')) === d, `${d} is not an observation (coupon) date of ${name}.`);
    need(!(t.observations && t.observations[d] !== undefined), `The observation of ${d} is already recorded: ${fmtLevel(t.observations?.[d])}.`);
    const lvl = num(level);
    need(lvl !== null && lvl > 0, `Enter the level of ${t.linkedTo} observed on ${d}.`);
    app.instruments.update(inst.id, { terms: { ...t, observations: { ...(t.observations || {}), [d]: lvl } } }, { system: true });
    const hit = lvl >= t.couponBarrier * t.initialLevel - 1e-9;
    const atMaturity = d === t.maturity;
    const ratio = lvl / t.initialLevel;
    const principal = !atMaturity ? '' : t.principalProtected ? '; principal protected: par at maturity' : ratio >= t.principalBarrier - 1e-12 ? `; at or above the principal barrier ${pctText(t.principalBarrier, 0)}: par at maturity` : `; below the principal barrier ${pctText(t.principalBarrier, 0)}: principal repaid at ${pctText(ratio)} of par`;
    const summary = `Observation of ${t.linkedTo} on ${d} recorded by hand${note ? ` (${note})` : ''}: ${fmtLevel(lvl)} (${pctText(ratio)} of the initial ${fmtLevel(t.initialLevel)}): ${hit ? `at or above the coupon barrier, the contingent coupon of ${pctText(t.couponRate / t.frequency)} is paid` : 'below the coupon barrier, no coupon'}${principal}`;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty) && !unpaidCoupons(app, p.id).length) continue;
      eventIds.push(app.ledger.post({ bookId: p.book_id, unitId: p.unit_id, type: 'bond.observation', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user', summary, data: { date: d, level: lvl, couponPaid: hit, manual: true } }));
    }
    return { date: d, level: lvl, couponPaid: hit, eventIds };
  },
  /**
   * Credit event of a credit-linked note's reference entity, recorded by hand (b4). The rule the Terminal applies, for every holder
   * in every Book:
   *   - the coupon ends: interest ceases from the last coupon date, so the interest accrued since it is forfeited (reversed out of
   *     coupon and interest income) and no later coupon is paid;
   *   - principal is reduced to the recovery (the final price of the reference entity's obligations, a decimal: 0.38 = 38% of
   *     par) and settled at it: each position is redeemed at recovery x 100, receivable until `settleDate` (the auction
   *     settlement date; today if not given), and the difference from carrying cost is realized;
   *   - the note can no longer be traded.
   */
  creditEvent(app, { inst, recovery, settleDate, note }) {
    const name = inst.symbol || inst.name;
    need(inst.terms.referenceEntity, `${name} has no reference entity: a credit event is recorded on a credit-linked note (or, for a credit-default swap, on the swap).`);
    need(!inst.terms.creditEvent, `A credit event of ${inst.terms.referenceEntity} was already recorded on ${inst.terms.creditEvent?.date}.`);
    const R = num(recovery);
    need(R !== null && R >= 0 && R <= 1, 'Enter the recovery as a decimal from 0 to 1 (0.38 = 38% of par), from the auction or the calculation agent.');
    const today = app.clock.today();
    const pay = settleDate ? String(settleDate) : today;
    need(ISO_DATE_RE.test(pay) && pay >= today, 'The recovery settlement date must be YYYY-MM-DD and not earlier than today.');
    const price = Math.round(R * 100 * 1e6) / 1e6;
    app.instruments.update(inst.id, { terms: { ...inst.terms, couponSuspended: true, creditEvent: { date: today, recovery: R, settleDate: pay } } }, { system: true });
    const fresh = app.instruments.get(inst.id);
    const ccy = inst.trading_ccy;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const book = app.books.getBook(p.book_id), unit = app.books.getUnit(p.unit_id);
      if (app.ledger.positionBalance(p.id, 'accrued.asset', ccy) !== 0) {
        const id = trueUpAccrual(app, { book, unit, pos: p, inst: fresh, account: 'accrued.asset', pnlAccount: 'pnl.coupon', ccy, target: 0, summary: `Accrued interest forfeited on ${name}: credit event of ${inst.terms.referenceEntity}, interest ceases from the last coupon date`, type: 'accrual.coupon' });
        if (id) eventIds.push(id);
      }
      const live = app.positions.get(p.id);
      const r = redeem(app, { book, unit, inst: fresh, pos: live, price, face: Math.abs(live.qty), date: today, settleDate: pay, type: 'bond.credit_event', actor: 'user',
        label: `Credit event of ${inst.terms.referenceEntity} recorded by hand${note ? ` (${note})` : ''}: principal reduced to the recovery and settled${pay > today ? ` on ${pay}` : ''}, coupons ended` });
      eventIds.push(r.eventId);
      bond.onPositionChange(app, { book, unit, inst: fresh, pos: app.positions.get(p.id) });
    }
    return { recovery: R, settleDate: pay, eventIds };
  },
  /**
   * A coupon to be paid in kind, recorded by hand (b4): a deferrable tranche (CLO or CDO mezzanine class whose coverage test
   * fails, a PIK-toggle loan whose borrower elects it) defers the coupon of `couponDate` (the next coupon date when not given)
   * and capitalises it. Interest goes on accruing and is income as before; on the coupon date the coupon is added to principal
   * for every holder instead of being paid: the factor rises by coupon / principal, each position's cost rises by its coupon,
   * and no cash moves. Later interest runs on the larger principal.
   */
  electPik(app, { inst, couponDate, note }) {
    const name = inst.symbol || inst.name;
    const t = schedTerms(inst);
    need(inst.terms.pikAllowed, `${name} is not deferrable: its terms do not allow a coupon to be paid in kind. A missed coupon is recorded as a coupon suspension.`);
    need(inst.terms.couponType !== 'zero', `${name} pays no coupon to defer.`);
    const today = app.clock.today();
    const d = couponDate ? String(couponDate) : nextCouponDate(t, addBusinessDays(today, -1, 'ALLDAYS'));
    need(ISO_DATE_RE.test(d || ''), 'The coupon date must be YYYY-MM-DD.');
    need(nextCouponDate(t, addBusinessDays(d, -1, 'ALLDAYS')) === d, `${d} is not a coupon date of ${name}; the next is ${nextCouponDate(t, addBusinessDays(today, -1, 'ALLDAYS'))}.`);
    need(couponDue(inst, d) >= today, `The coupon of ${d} has already fallen due; a coupon is elected to be paid in kind before it is paid.`);
    need(!(inst.terms.pikCoupons || []).includes(d), `The coupon of ${d} is already to be paid in kind.`);
    need(!app.db.get(`SELECT 1 AS x FROM tasks WHERE instrument_id = ? AND type = 'bond.coupon' AND status = 'done' AND json_extract(data, '$.couponDate') = ?`, inst.id, d), `The coupon of ${d} has already been paid.`);
    app.instruments.update(inst.id, { terms: { ...inst.terms, pikCoupons: [...(inst.terms.pikCoupons || []), d] } }, { system: true });
    const summary = `Coupon of ${d} on ${name} to be paid in kind, recorded by hand${note ? ` (${note})` : ''}: interest is still earned; on ${couponDue(inst, d)} it is added to principal instead of paid`;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      eventIds.push(app.ledger.post({ bookId: p.book_id, unitId: p.unit_id, type: 'bond.pik_election', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user', summary, data: { couponDate: d, manual: true } }));
    }
    return { couponDate: d, eventIds };
  },
  /**
   * The balance still outstanding on the tranche senior to a sequential-pay tranche, recorded by hand from a remittance report
   * (b4). Until it reaches zero this tranche receives no principal: its paydowns are refused. At zero the senior tranche is
   * retired and this tranche's own factor is recorded by hand from then on. Every holder gets a history line; no cash moves.
   */
  recordSeniorBalance(app, { inst, remaining, note }) {
    const name = inst.symbol || inst.name;
    const t = inst.terms;
    need(t.seniorTranche, `${name} has no senior tranche in its terms: it is not paid principal after another tranche.`);
    const r = num(remaining);
    need(r !== null && r >= 0, `Enter the balance of ${t.seniorTranche} still outstanding, 0 or more (0 when it is retired).`);
    need(t.seniorRemaining > 0, `${t.seniorTranche} is already retired; ${name} receives principal and its own factor is recorded as a paydown.`);
    need(r < t.seniorRemaining, `${t.seniorTranche} has ${fmtQty(t.seniorRemaining)} outstanding as last recorded; a senior tranche is only paid down: enter less than that.`);
    const today = app.clock.today();
    const retired = isZero(r);
    app.instruments.update(inst.id, { terms: { ...t, seniorRemaining: r, ...(retired ? { seniorRetiredOn: today } : {}) } }, { system: true });
    const summary = `${t.seniorTranche} (senior to ${name}) balance recorded by hand${note ? ` (${note})` : ''}: ${fmtQty(t.seniorRemaining)} to ${fmtQty(r)}${retired ? `: retired. ${name} now receives principal; its own factor is recorded as a paydown` : `. ${name} receives no principal until it is retired`}`;
    const eventIds = [];
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      eventIds.push(app.ledger.post({ bookId: p.book_id, unitId: p.unit_id, type: 'bond.senior_balance', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user', summary, data: { from: t.seniorRemaining, to: r, retired, manual: true } }));
    }
    return { remaining: r, retired, eventIds };
  },
  paydown(app, { book, unit, inst, newFactor, effective, payDate, scheduledFactor, note }) {
    // b4: a sequential tranche is paid no principal while the tranche senior to it is outstanding.
    if (inst.terms.seniorTranche && inst.terms.seniorRemaining > 0) throw new AppError(`${inst.symbol || inst.name} receives principal only after ${inst.terms.seniorTranche} is retired: ${fmtQty(inst.terms.seniorRemaining)} of it is outstanding as last recorded. Principal collected goes to ${inst.terms.seniorTranche} first; record its balance (senior tranche balance) as it is paid down, and this tranche's factor once it is retired.`);
    const nf = num(newFactor);
    const old = factorOf(inst);
    need(nf > 0 && nf < old, `New factor must be below the current factor ${old} and above zero.`);
    const today = app.clock.today();
    const from = effective ? String(effective) : today;
    need(ISO_DATE_RE.test(from) && from <= today, 'The date the new factor is effective from must be YYYY-MM-DD and not later than today.');
    const pay = payDate ? String(payDate) : today;
    need(ISO_DATE_RE.test(pay) && pay >= today, 'The principal payment date must be YYYY-MM-DD and not earlier than today.');
    const has = (v) => v !== undefined && v !== null && v !== '';
    const sf = has(scheduledFactor) ? num(scheduledFactor) : null;
    need(sf === null || (sf <= old + 1e-12 && sf >= nf - 1e-12), `The factor after scheduled principal must lie between the new factor ${nf} and the current factor ${old}.`);
    const name = inst.symbol || inst.name;
    const ccy = inst.trading_ccy;
    const split = sf === null ? '' : `; scheduled principal ${Number((old - sf).toFixed(10))}, prepaid ${Number((sf - nf).toFixed(10))} of original face (SMM ${((sf - nf) / sf * 100).toFixed(4)}%)`;
    const history = [...(inst.terms.factorHistory || []), { from, factor: nf, prior: old }];
    app.instruments.update(inst.id, { terms: { ...inst.terms, factor: nf, factorHistory: history } }, { system: true });
    const fresh = app.instruments.get(inst.id);
    const out = [];
    // Every holder of the instrument is paid down, in every Book.
    for (const p of app.positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const b = book && p.book_id === book.id ? book : app.books.getBook(p.book_id), u = unit && p.unit_id === unit.id ? unit : app.books.getUnit(p.unit_id);
      const face = from === today ? p.qty : entitledFace(app, p, from);
      const paid = money(face * (old - nf) * ratioOf(inst) * (inst.terms.redemption / 100), ccy);
      const costOut = money(p.cost * ((old - nf) / old), ccy);
      const later = pay > today;
      const eventId = app.ledger.post({
        bookId: b.id, unitId: u.id, type: 'bond.paydown', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'user',
        summary: `Principal paydown on ${name}${note ? ` (${note})` : ''}: factor ${old} to ${nf}${from !== today ? ` from ${from}` : ''}${split}, ${fmt(Math.abs(paid), ccy)} ${later ? `${paid >= 0 ? 'receivable' : 'payable'} on ${pay}` : paid >= 0 ? 'received' : 'paid'}`,
        data: { oldFactor: old, newFactor: nf, effective: from, payDate: pay, scheduledFactor: sf, manual: true },
        entries: [
          { account: later ? (paid >= 0 ? 'recv.settle' : 'pay.settle') : 'cash', ccy, amount: paid, positionId: p.id },
          { account: 'pos', ccy, amount: -costOut, positionId: p.id },
          { account: 'pnl.realized', ccy, amount: money(costOut - paid, ccy), positionId: p.id },
        ],
      });
      const after = app.positions.change(p, { dCost: -costOut });
      if (later && paid !== 0) app.settle.create({ bookId: b.id, unitId: u.id, instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, kind: 'paydown', dueDate: pay, ccy, amount: paid, accounts: ['cash'] });
      out.push(eventId);
      // Recorded after the period it applies from had begun: the interest accrued since then is restated on the new factor.
      if (from < today && !fresh.terms.couponSuspended && after.data?.accruedThrough && after.data.accruedThrough >= from) {
        const target = accrualTarget(app, fresh, after, after.data.accruedThrough);
        if (target !== null) {
          const down = money(target, ccy) < app.ledger.positionBalance(after.id, 'accrued.asset', ccy);
          const id = trueUpAccrual(app, { book: b, unit: u, pos: after, inst: fresh, account: 'accrued.asset', pnlAccount: 'pnl.coupon', ccy, target: money(target, ccy), summary: `Accrued interest restated on the new factor of ${name}, ${down ? 'down' : 'up'}`, type: 'accrual.coupon' });
          if (id) out.push(id);
        }
      }
    }
    return { eventIds: out };
  },
};

/**
 * b4: delayed compensation of a loan trade on par documentation (LSTA): when a trade settles after its standard settlement date
 * (T+7 by market practice: the instrument's convention), the buyer is put in the position it would have had from that date: the
 * seller pays it the interest on the principal for the days between the standard and the actual settlement date, and the buyer
 * pays the seller the cost of carry, the purchase price at the reference rate for the same days. Net, in the buyer's favour:
 * `net` (negative when the carry is larger). Null when it does not apply.
 */
function delayedComp(app, { inst, action, qty, price, settleDate, tradeDate, book }) {
  if (inst.terms?.tradingDocs !== 'par' || !settleDate) return null;
  const today = tradeDate || app.clock.today();
  let standard = null;
  try { standard = standardSettleDate(inst, today, book || null); } catch { standard = null; }
  if (!ISO_DATE_RE.test(standard || '') || settleDate <= standard) return null;
  const t = schedTerms(inst);
  const rate = t.couponType === 'float' ? t.currentCoupon : t.couponRate;
  if (rate === null || rate === undefined) return null;
  const base = t.couponType === 'float' ? (inst.terms.currentCouponFixing?.value !== undefined ? inst.terms.currentCouponFixing.value / 100 : rate - (t.spread || 0)) : 0;
  const ccy = inst.trading_ccy;
  const principal = Math.abs(qty) * scaleOn(inst, settleDate);
  const yf = yearFraction(standard, settleDate, t.dayCount || 'ACT/360');
  const interest = money(principal * rate * yf, ccy);
  const carry = money(((principal * price) / 100) * base * yf, ccy);
  const days = Math.round((Date.parse(settleDate) - Date.parse(standard)) / 86400000);
  return { standard, days, interest, carry, net: money(interest - carry, ccy), rate, base };
}

/**
 * Terms for the coupon of `couponDate` (b4). A floating coupon is reset to the next period's rate when it is paid; when an
 * instrument has several holders the first holder's payment resets it, so the rate of the period that ended is kept in
 * `terms.periodCoupons` and every later holder is paid at that rate, not at the new period's.
 */
function couponTerms(inst, couponDate) {
  const pc = inst.terms.periodCoupons?.[couponDate];
  if (inst.terms.couponType !== 'float' || pc === undefined || pc === null) return schedTerms(inst);
  return schedTerms({ ...inst, terms: { ...inst.terms, currentCoupon: pc } });
}

/** Terms used for schedule arithmetic (a perpetual gets a far-off synthetic maturity on its anchor). */
function schedTerms(inst) {
  let t = inst.terms;
  // b4: a servicing fee is deducted from the gross rate: holders accrue and are paid the net rate.
  if (t.servicingFeeRate) {
    if (t.couponType === 'fixed') t = { ...t, couponRate: t.couponRate - t.servicingFeeRate };
    else if (t.couponType === 'float' && t.currentCoupon !== null && t.currentCoupon !== undefined) t = { ...t, currentCoupon: t.currentCoupon - t.servicingFeeRate };
  }
  // b4: a fixed PIK component accrues with the cash coupon (the coupon task splits the payment).
  if (t.pikRate) {
    if (t.couponType === 'fixed') t = { ...t, couponRate: t.couponRate + t.pikRate };
    else if (t.couponType === 'float' && t.currentCoupon !== null && t.currentCoupon !== undefined) t = { ...t, currentCoupon: t.currentCoupon + t.pikRate };
  }
  if (!t.perpetual) return t;
  const y = Number(t.anchorDate.slice(0, 4));
  return { ...t, maturity: `${y + 200}${t.anchorDate.slice(4)}` };
}

function redeem(app, { book, unit, inst, pos, price, face, date, type, label, actor = 'engine', accrued = 0, scale = null, note = '', settleDate = null }) {
  const long = pos.qty > 0;
  // Principal per unit of face: the pool factor times the index ratio, unless the caller states it (an inflation floor).
  const s = scale ?? factorOf(inst) * ratioOf(inst);
  const ccy = inst.trading_ccy;
  const extra = note || (isLinker(inst) ? ` on index ratio ${fmtRatio(ratioOf(inst))}: ${fmt(money(face * s * price / 100, ccy), ccy)}` : Math.abs(s - 1) > 1e-12 ? ` on current face ${fmtQty(money(face * s, ccy))}` : '');
  // Settle the outstanding accrued interest to zero against cash before closing the principal.
  return bookSecurityFill(app, {
    book, unit, inst, action: long ? 'sell' : 'buy_to_cover', qty: face, price, fees: [], strategyId: pos.strategy_id, tradeDate: date, settleDate: settleDate || app.clock.today(),
    eventType: type, actor, summary: `${label}: ${fmtQty(face)} ${inst.symbol || inst.name} at ${fmtPx(price)}% of par${extra}`,
  }, { unitCost: (price * s) / 100, accrued });
}

/** The reference-rate fixing of a floating coupon period, set on its first day (or up to five days before it). */
function fixingFor(app, inst, start) {
  const o = app.data.rate(inst.terms.referenceRate, start);
  return o && (o.forDate || '').slice(0, 10) >= addBusinessDays(start, -5, 'ALLDAYS') ? o : null;
}

/**
 * A floating-rate note with no coupon rate for the period starting `start` takes that period's fixing as soon as it has
 * been supplied or entered by hand, and the missing-fixing alert is resolved. Never a guess: without that fixing nothing
 * changes. Returns the instrument as it now stands.
 */
function takeFixing(app, inst, start) {
  const t = inst.terms;
  if (t.couponType !== 'float' || (t.currentCoupon !== null && t.currentCoupon !== undefined) || !start) return inst;
  const o = fixingFor(app, inst, start);
  if (!o) return inst;
  app.instruments.update(inst.id, { terms: { ...t, currentCoupon: o.value / 100 + (t.spread || 0), currentCouponFixing: { date: o.forDate, value: o.value, obsId: app.data.recordUsed(o) } } }, { system: true });
  app.alerts.resolve({ refType: 'instrument', refId: inst.id, code: 'bond.fixing' });
  return app.instruments.get(inst.id);
}

/** After a floating coupon is paid, set the coupon for the new period from the reference-rate fixing. */
function resetFloat(app, inst, resetDate) {
  const o = app.data.rate(inst.terms.referenceRate, resetDate);
  const ok = o && (o.forDate || '').slice(0, 10) >= addBusinessDays(resetDate, -5, 'ALLDAYS');
  const current = ok ? o.value / 100 + (inst.terms.spread || 0) : null;
  // b4: the rate of the period that ended stays with its coupon date (couponTerms), for the holders not yet paid.
  const kept = inst.terms.periodCoupons?.[resetDate] ?? inst.terms.currentCoupon;
  const periodCoupons = kept === null || kept === undefined ? inst.terms.periodCoupons : { ...(inst.terms.periodCoupons || {}), [resetDate]: kept };
  app.instruments.update(inst.id, { terms: { ...inst.terms, currentCoupon: current, currentCouponFixing: ok ? { date: o.forDate, value: o.value, obsId: app.data.recordUsed(o) } : null, ...(periodCoupons ? { periodCoupons } : {}) } }, { system: true });
  if (!ok) app.alerts.raise({ level: 'warning', code: 'bond.fixing', refType: 'instrument', refId: inst.id, message: `${inst.symbol || inst.name}: no ${inst.terms.referenceRate} fixing for the coupon period starting ${resetDate}. Interest is not accruing until the fixing is supplied or entered.` });
}

export { resetFloat };
