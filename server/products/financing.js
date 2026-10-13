// Funding and securities-finance arrangements: cash loans and deposits, repo and reverse repo,
// securities borrowing and lending.
//
// These are simulated arrangements with a simulated counterparty. Each is its own registry
// instrument holding the contract terms, and a position whose quantity is the principal (or the
// number of securities). Borrowed cash is a liability. Interest and fees accrue daily into
// accrued accounts and are paid on the contract's schedule.
//
// Rates, borrow fees and availability are never assumed from other data: a floating rate with no
// fixing stops accruing and says so.

import { fmt } from '../core/books.js';
import { addBusinessDays, adjust } from '../quant/calendar.js';
import { addDays, addMonths, diffDays, makeDate, ymd } from '../quant/dates.js';
import { AppError, CCY_RE, ISO_DATE_RE, isZero, money, need, num } from '../core/util.js';
import { fmtQty, trueUpAccrual } from './common.js';
import { markOf } from '../data/observation.js';
import { accruedPer100, couponDates, couponPer100 } from '../quant/bond.js';
import { calendarFor, paymentCalendarFor } from './security.js';

const basisDays = (dc) => (dc === 'ACT/365' ? 365 : 360);
const firstBusinessDayNextMonth = (date, cal) => {
  const { y, m } = ymd(date);
  return adjust(addMonths(makeDate(y, m, 1), 1), 'following', cal);
};

/**
 * Accrue interest on a principal from pos.data.accruedThrough to `date`.
 * Returns the updated { accrued, accruedThrough, rateMissing }.
 */
function accruePrincipal(app, { inst, pos, date }) {
  const t = inst.terms;
  const principal = Math.abs(pos.qty);
  let accrued = pos.data.accrued || 0;
  let through = pos.data.accruedThrough || t.startDate;
  let rateMissing = null;
  if (date <= through || isZero(principal)) return { accrued, accruedThrough: through, rateMissing: pos.data.rateMissing || null };
  const basis = basisDays(t.dayCount);
  if (t.rateType === 'floating') {
    for (let d = through; d < date; d = addDays(d, 1)) {
      const o = app.data.rate(t.referenceRate, d);
      // A fixing more than a week old is not carried forward silently.
      if (!o || diffDays((o.forDate || o.asOf || '').slice(0, 10), d) > 7) { rateMissing = d; break; }
      accrued += (principal * (o.value / 100 + (t.spread || 0))) / basis;
      through = addDays(d, 1);
    }
  } else {
    accrued += (principal * (t.rate || 0) * diffDays(through, date)) / basis;
    through = date;
  }
  return { accrued, accruedThrough: through, rateMissing };
}

function trueUpInterest(app, { book, unit, inst, pos, date, borrowPnl = 'pnl.funding', lendPnl = 'pnl.interest', label }) {
  const a = accruePrincipal(app, { inst, pos, date });
  const borrowed = pos.qty < 0;
  const ccy = inst.trading_ccy;
  trueUpAccrual(app, {
    book, unit, pos, inst, ccy, type: 'accrual.interest',
    account: borrowed ? 'accrued.liab' : 'accrued.asset', pnlAccount: borrowed ? borrowPnl : lendPnl,
    target: money(borrowed ? -a.accrued : a.accrued, ccy), summary: label || `Interest accrued on ${inst.name}`,
  });
  if (a.rateMissing && a.rateMissing !== pos.data.rateMissing) {
    app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'warning', code: 'rate.missing', refType: 'position', refId: pos.id, message: `${inst.name}: no ${inst.terms.referenceRate} fixing from ${a.rateMissing}. Interest has stopped accruing until the rate is supplied or entered.` });
  } else if (!a.rateMissing) app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'rate.missing' });
  return app.positions.change(pos, { data: a });
}

/** Pay (or receive) the accrued interest balance in cash. Returns false when cash is insufficient. */
function settleInterest(app, { book, unit, inst, pos, label }) {
  const ccy = inst.trading_ccy;
  const borrowed = pos.data.side ? pos.data.side === 'borrow' : pos.qty < 0;
  const account = borrowed ? 'accrued.liab' : 'accrued.asset';
  const bal = app.ledger.positionBalance(pos.id, account, ccy); // negative for a liability
  if (bal === 0) return { ok: true, amount: 0 };
  if (bal < 0 && app.ledger.balance(unit.id, 'cash', ccy) < -bal - 0.004) return { ok: false, amount: -bal };
  const eventId = app.ledger.post({
    bookId: book.id, unitId: unit.id, type: 'interest.payment', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
    summary: `${label || 'Interest'} ${bal < 0 ? 'paid' : 'received'} on ${inst.name}: ${fmt(Math.abs(bal), ccy)}`,
    entries: [{ account: 'cash', ccy, amount: bal, positionId: pos.id }, { account, ccy, amount: -bal, positionId: pos.id }],
  });
  app.positions.change(app.positions.get(pos.id), { data: { accrued: 0 } });
  return { ok: true, amount: Math.abs(bal), eventId };
}

/** Reference-rate history a floating arrangement needs: from the last day it accrued. */
function floatingNeeds(app, { inst, pos }) {
  if (inst.terms.rateType !== 'floating') return {};
  const through = pos?.data?.accruedThrough || inst.terms.startDate || app.clock.today();
  return { rateCodes: [inst.terms.referenceRate], rateFrom: addDays(through, -10) };
}

function describeRate(t) {
  if (t.rateType === 'floating') return `${t.referenceRate} + ${((t.spread || 0) * 100).toFixed(2)}%`;
  return `${((t.rate || 0) * 100).toFixed(3)}% fixed`;
}

function normalizeRate(t, errors, { strictDayCount = false, what = 'a cash loan or deposit' } = {}) {
  t.rateType = t.rateType === 'floating' ? 'floating' : 'fixed';
  if (t.rateType === 'fixed') {
    t.rate = num(t.rate);
    if (t.rate === null) errors.push('Enter the interest rate as a decimal (0.05 = 5%). The Terminal does not assume a rate.');
    else if (Math.abs(t.rate) > 1) errors.push('The rate looks like a percentage; enter it as a decimal (0.05 = 5%).');
  } else {
    if (!t.referenceRate) errors.push('A floating rate needs its reference rate code.');
    t.spread = num(t.spread) ?? 0;
  }
  // A day count the accrual does not implement is refused (cash loans and deposits), never replaced in silence:
  // interest would otherwise be worked out on a basis the contract does not state.
  if (strictDayCount && t.dayCount && !['ACT/360', 'ACT/365'].includes(t.dayCount)) errors.push(`Day count ${t.dayCount} is not supported for ${what}. Interest is simulated on ACT/360 or ACT/365 only.`);
  t.dayCount = ['ACT/360', 'ACT/365'].includes(t.dayCount) ? t.dayCount : 'ACT/360';
}

// ---------------------------------------------------------------------------------------------
// Cash loans and deposits
// ---------------------------------------------------------------------------------------------

export const loan = {
  family: 'loan',
  kind: 'arrangement',
  label: 'Cash loan / deposit',
  qtyLabel: 'Principal',
  actions: () => ['borrow_cash', 'lend_cash'],
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    normalizeRate(t, errors, { strictDayCount: true });
    if (!CCY_RE.test(draft.trading_ccy || '')) errors.push('Loan currency is required.');
    t.loanType = t.loanType || 'unsecured';
    t.interestPayment = t.interestPayment === 'monthly' ? 'monthly' : 'maturity';
    if (t.maturity && !ISO_DATE_RE.test(t.maturity)) errors.push('Maturity must be YYYY-MM-DD (leave empty for an open-ended arrangement).');
    if (!t.maturity) { t.maturity = null; t.interestPayment = 'monthly'; }
    t.collateral = Array.isArray(t.collateral) ? t.collateral.map((c) => ({ positionId: c.positionId, qty: num(c.qty) })).filter((c) => c.positionId && c.qty > 0) : [];
    // A secured loan is secured by named positions; without a pledge it would be an unsecured loan under another name.
    if (t.loanType === 'secured' && !t.collateral.length) errors.push('A secured loan pledges collateral: choose the position to pledge and the quantity.');
    return { terms: t, multiplier: 1, errors, settleCcy: draft.trading_ccy };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Arrangement', t.loanType], ['Rate', describeRate(t)], ['Day count', t.dayCount], ['Start', t.startDate || '(on execution)'], ['Maturity', t.maturity || 'Open-ended'], ['Interest paid', t.interestPayment === 'monthly' ? 'Monthly' : 'At maturity']];
    if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
    if (t.collateral?.length) rows.push(['Collateral pledged', `${t.collateral.length} position(s)`]);
    return rows;
  },
  qtyStep: () => 0.01,
  /** Problems that would stop this arrangement opening right now. */
  checkOpen(app, { unit, inst, action, qty }) {
    const out = [];
    const ccy = inst.trading_ccy;
    // Products that exist on one side only, as the tickets offer them: a deposit is placed, a margin loan or a facility
    // drawing is borrowed.
    if (action === 'lend_cash' && ['margin_loan', 'revolving_credit_facility'].includes(inst.product_id)) out.push('A margin loan or a credit facility drawing is borrowed, not lent. To lend cash, use a cash loan, a deposit or a certificate of deposit.');
    if (action === 'borrow_cash' && ['bank_deposit', 'term_deposit', 'certificate_of_deposit'].includes(inst.product_id)) out.push('A deposit or certificate of deposit is placed (lent), not borrowed. To borrow cash, use a cash loan.');
    if (action === 'lend_cash') {
      const c = app.ledger.cash(unit.id, ccy);
      if (c.availableToWithdraw < qty - 0.004) out.push(`${unit.name} has ${fmt(c.availableToWithdraw, ccy)} of settled ${ccy} available to lend; ${fmt(qty, ccy)} requested.`);
    }
    for (const col of inst.terms.collateral || []) {
      const p = app.positions.get(col.positionId);
      if (!p || p.unit_id !== unit.id) out.push('A pledged collateral position was not found in this Treasury/Account.');
      else if (app.positions.freeQty(p) < col.qty - 1e-9) out.push(`Only ${fmtQty(app.positions.freeQty(p))} of the collateral position is unencumbered; ${fmtQty(col.qty)} requested.`);
    }
    return out;
  },
  open(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const ccy = inst.trading_ccy;
    const P = money(c.qty, ccy);
    const borrow = c.action === 'borrow_cash';
    const today = c.tradeDate;
    if (!inst.terms.startDate) app.instruments.update(inst.id, { terms: { ...inst.terms, startDate: today } }, { system: true });
    let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: inst.id, strategyId: c.strategyId });
    // More principal on an arrangement that is already open: interest on what was outstanding is accrued to today
    // first, so the addition bears interest from today and not from the last accrual date.
    if (!isZero(pos.qty)) pos = trueUpInterest(app, { book: c.book, unit: c.unit, inst, pos, date: today });
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: borrow ? 'loan.drawdown' : 'loan.placed', instrumentId: inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: pos.id,
      summary: `${borrow ? 'Borrowed' : 'Lent'} ${fmt(P, ccy)} (${inst.terms.loanType}, ${describeRate(inst.terms)}${inst.terms.maturity ? `, due ${inst.terms.maturity}` : ', open-ended'})`,
      data: { principal: P, terms: inst.terms, ...(c.data || {}) },
      entries: borrow
        ? [{ account: 'cash', ccy, amount: P, positionId: pos.id }, { account: 'loan.liab', ccy, amount: -P, positionId: pos.id }]
        : [{ account: 'cash', ccy, amount: -P, positionId: pos.id }, { account: 'loan.asset', ccy, amount: P, positionId: pos.id }],
    });
    pos = positions.change(pos, { dQty: borrow ? -P : P, data: { accrued: pos.data.accrued || 0, accruedThrough: pos.data.accruedThrough || today, side: borrow ? 'borrow' : 'lend' } });
    for (const col of inst.terms.collateral || []) {
      const p = positions.get(col.positionId);
      if (p) positions.change(p, { dPledged: col.qty });
    }
    return { eventId, position: pos, realized: 0, cashNet: borrow ? P : -P };
  },
  /**
   * What closing `qty` of principal moves in cash today: the principal, and the interest accrued to
   * today when the close is in full (a part repayment leaves the interest to its schedule).
   * The preview shows these so the repayment it displays is the cash that leaves the unit.
   */
  closeAmounts(app, { inst, pos, qty }) {
    const principal = money(Math.min(qty, Math.abs(pos.qty)), inst.trading_ccy);
    const full = principal >= Math.abs(pos.qty) - 0.004;
    const a = full ? accruePrincipal(app, { inst, pos, date: app.clock.today() }) : null;
    return { principal, interest: a ? money(a.accrued, inst.trading_ccy) : 0, full, accruedThrough: a ? a.accruedThrough : pos.data.accruedThrough || null, rateMissing: a ? a.rateMissing : null };
  },
  /** Repay (borrowed) or withdraw (lent) principal. A full repayment also settles accrued interest. */
  checkClose(app, { unit, inst, pos, qty, date = app.clock.today() }) {
    const out = [];
    const ccy = inst.trading_ccy;
    if (qty > Math.abs(pos.qty) + 0.004) out.push(`Outstanding principal is ${fmt(Math.abs(pos.qty), ccy)}; cannot repay ${fmt(qty, ccy)}.`);
    // Without a fixing the interest to today cannot be worked out: a repayment in full would settle too little, and a part
    // repayment would leave the days without a fixing to be charged later on the reduced principal.
    const missing = inst.terms.rateType === 'floating' ? accruePrincipal(app, { inst, pos, date }).rateMissing : null;
    if (missing) out.push(`Interest on ${inst.name} cannot be worked out: no ${inst.terms.referenceRate} fixing from ${missing}. Enter the fixing by hand or set the rate before repaying.`);
    if (pos.qty < 0) {
      const full = qty >= Math.abs(pos.qty) - 0.004;
      const interest = full ? accruePrincipal(app, { inst, pos, date }).accrued : 0;
      const have = app.ledger.cash(unit.id, ccy).availableToWithdraw;
      if (have < qty + interest - 0.004) out.push(`${unit.name} has ${fmt(have, ccy)} of settled ${ccy} available; ${fmt(qty + interest, ccy)} is needed (principal${full ? ' plus accrued interest' : ''}).`);
    }
    return out;
  },
  close(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const ccy = inst.trading_ccy;
    let pos = c.pos;
    const x = money(Math.min(c.qty, Math.abs(pos.qty)), ccy);
    const borrowed = pos.qty < 0;
    const full = x >= Math.abs(pos.qty) - 0.004;
    // Interest is accrued to today on the principal outstanding until now, whether the repayment is in full or in
    // part: after a part repayment the reduced principal bears interest from today only. (In part, the accrued
    // interest itself stays on its schedule; in full, it is settled below.)
    pos = trueUpInterest(app, { book: c.book, unit: c.unit, inst, pos, date: c.tradeDate });
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: borrowed ? 'loan.repayment' : 'loan.withdrawal', instrumentId: inst.id, strategyId: pos.strategy_id, orderId: c.order?.id, positionId: pos.id,
      actor: c.actor || 'user',
      summary: `${borrowed ? 'Repaid' : 'Received back'} ${fmt(x, ccy)} of principal on ${inst.name}${full ? ' (in full)' : ''}`,
      entries: borrowed
        ? [{ account: 'cash', ccy, amount: -x, positionId: pos.id }, { account: 'loan.liab', ccy, amount: x, positionId: pos.id }]
        : [{ account: 'cash', ccy, amount: x, positionId: pos.id }, { account: 'loan.asset', ccy, amount: -x, positionId: pos.id }],
    });
    const paid = full ? settleInterest(app, { book: c.book, unit: c.unit, inst, pos }) : { amount: 0 };
    pos = positions.change(positions.get(pos.id), { dQty: borrowed ? x : -x });
    if (full) {
      for (const col of inst.terms.collateral || []) {
        const p = positions.get(col.positionId);
        if (p) positions.change(p, { dPledged: -Math.min(col.qty, p.pledged_qty) });
      }
      app.tasks.cancelFor(pos.id);
    }
    // interestPaid is signed like cashNet: negative when the unit paid it, positive when it received it.
    return { eventId, position: pos, realized: 0, cashNet: borrowed ? -x : x, interestPaid: borrowed ? -(paid.amount || 0) : paid.amount || 0 };
  },
  value(app, inst, pos) {
    const ccy = inst.trading_ccy;
    const borrowed = pos.qty < 0;
    return {
      price: null, mv: null, cost: 0, unrealized: 0, ledgerCarried: true,
      carrying: pos.qty,
      accrued: app.ledger.positionBalance(pos.id, borrowed ? 'accrued.liab' : 'accrued.asset', ccy),
      notional: Math.abs(pos.qty), exposure: null,
    };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    const common = { bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id };
    const cal = paymentCalendarFor(inst); // interest and principal are payments: the currency's payment calendar applies
    if (inst.terms.interestPayment === 'monthly') app.tasks.schedule({ ...common, type: 'loan.interest', dueDate: firstBusinessDayNextMonth(app.clock.today(), cal) });
    if (inst.terms.maturity) app.tasks.schedule({ ...common, type: 'loan.maturity', dueDate: adjust(inst.terms.maturity, 'following', cal) });
  },
  dataNeeds: floatingNeeds,
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty)) return;
    trueUpInterest(app, { book, unit, inst, pos, date });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (!pos || isZero(pos.qty)) return 'done';
    const today = app.clock.today();
    if (task.type === 'loan.interest') {
      const p = trueUpInterest(app, { book, unit, inst, pos, date: today });
      if (p.data.rateMissing) return { blocked: waitingForFixing(inst, p.data.rateMissing, 'Interest payment') };
      const r = settleInterest(app, { book, unit, inst, pos: p });
      if (!r.ok) return fundingFailure(app, { book, unit, inst, pos, amount: r.amount, what: 'Interest payment' });
      app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'loan.interest', dueDate: firstBusinessDayNextMonth(today, paymentCalendarFor(inst)) });
      return { done: true, eventId: r.eventId };
    }
    if (task.type === 'loan.maturity') {
      // A maturity reached for the first time after its date (the Terminal was not running that day) is settled as of
      // that date: interest stops at maturity, exactly as if the Terminal had been running. A repayment that was
      // tried and failed for want of cash goes on accruing until it is made.
      const asOf = task.status === 'pending' && task.due_date < today ? task.due_date : today;
      const p = trueUpInterest(app, { book, unit, inst, pos, date: asOf });
      if (p.data.rateMissing) return { blocked: waitingForFixing(inst, p.data.rateMissing, 'Repayment at maturity') };
      const problems = loan.checkClose(app, { unit, inst, pos: p, qty: Math.abs(p.qty), date: asOf });
      if (problems.length) return fundingFailure(app, { book, unit, inst, pos, what: 'Repayment at maturity', detail: problems[0] });
      const r = loan.close(app, { book, unit, inst, pos, qty: Math.abs(pos.qty), tradeDate: asOf, actor: 'engine' });
      app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'funding.failed' });
      return { done: true, eventId: r.eventId };
    }
    return { failed: `Unknown task ${task.type}` };
  },
};

/**
 * A payment or repayment of a floating arrangement whose interest cannot be worked out: a fixing is missing. It waits,
 * visibly, until the fixing is entered or the rate is set by hand; it is never settled on the interest accrued so far.
 */
const waitingForFixing = (inst, missing, what) => `${what} on ${inst.name} is waiting for a ${inst.terms.referenceRate} fixing: none is available from ${missing}, so the interest due cannot be worked out. Enter the fixing by hand (Data connection, Manual entries) or set the rate on the arrangement.`;

function fundingFailure(app, { book, unit, inst, pos, amount, what, detail }) {
  const msg = detail || `${what} of ${fmt(amount, inst.trading_ccy)} on ${inst.name} could not be paid: insufficient settled ${inst.trading_ccy} cash in ${unit.name}.`;
  app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'position', refId: pos.id, message: `${what} failed on ${inst.name}. ${msg}` });
  return { failed: msg };
}

// ---------------------------------------------------------------------------------------------
// Repo and reverse repo
// ---------------------------------------------------------------------------------------------

/**
 * What `qty` of a security is worth in `ccy` on `date`: quantity x price x multiplier, and for a debt security its dirty
 * value (the interest accrued to `date` added to the clean value). { worth, clean, accrued, price } or { error }.
 */
function collateralWorth(app, coll, qty, ccy, date) {
  const name = coll.symbol || coll.name;
  const px = markOf(app.data.price(coll.id));
  if (px === null || px === undefined) return { error: `${name} has no price, so the cash this collateral supports cannot be worked out. Enter a price for it first.` };
  const fx = coll.trading_ccy === ccy ? { rate: 1 } : app.data.fx(coll.trading_ccy, ccy);
  if (!fx) return { error: `No ${coll.trading_ccy}/${ccy} conversion rate is available, so the cash this collateral supports cannot be worked out.` };
  const bond = coll.family === 'bond';
  const factor = bond ? coll.terms.factor ?? 1 : 1;
  const clean = qty * px * coll.multiplier * factor;
  const ai = bond ? ((accruedPer100(coll.terms, date) ?? 0) * qty * factor) / 100 : 0;
  return { price: px, clean: money(clean * fx.rate, ccy), accrued: money(ai * fx.rate, ccy), worth: money((clean + ai) * fx.rate, ccy) };
}

// Products that exist on one side only: a repo and a sell/buy-back raise cash, a reverse repo and a buy/sell-back lend it.
const REPO_SIDE_ONLY = { repo: 'repo', sell_buy_back: 'repo', reverse_repo: 'reverse_repo', buy_sell_back: 'reverse_repo' };
const BSB_PRODUCTS = new Set(['buy_sell_back', 'sell_buy_back']);
const isBsb = (inst) => BSB_PRODUCTS.has(inst.product_id);
const REPO_LABEL = { repo: 'A repo', reverse_repo: 'A reverse repo', sell_buy_back: 'A sell/buy-back', buy_sell_back: 'A buy/sell-back' };
const symOf = (i) => (i ? i.symbol || i.name : 'collateral');

/**
 * The cover a quantity of collateral gives: its value (dirty for a debt security), less the haircut, less the additional
 * buffer the terms state (a negative buffer adds to it). { worth, clean, accrued, haircut, afterHaircut, buffer, cover } or { error }.
 */
function coverFor(app, inst, coll, qty, date) {
  const ccy = inst.trading_ccy;
  const w = collateralWorth(app, coll, qty, ccy, date);
  if (w.error) return w;
  const h = inst.terms.haircut || 0;
  const buffer = money(inst.terms.buffer || 0, ccy);
  const afterHaircut = money(w.worth * (1 - h), ccy);
  return { ...w, qty, haircut: h, haircutAmount: money(w.worth - afterHaircut, ccy), afterHaircut, buffer, cover: money(afterHaircut - buffer, ccy) };
}
const bufferText = (c, ccy) => (c.buffer > 0 ? `, less the additional buffer of ${fmt(c.buffer, ccy)}` : c.buffer < 0 ? `, plus the additional funding of ${fmt(-c.buffer, ccy)} the terms state` : '');
const coverText = (c, coll, ccy) => `${fmtQty(c.qty)} ${symOf(coll)} is worth ${fmt(c.worth, ccy)}${c.accrued ? ` (${fmt(c.clean, ccy)} clean plus ${fmt(c.accrued, ccy)} accrued interest)` : ''} and the haircut is ${(c.haircut * 100).toFixed(2)}%${bufferText(c, ccy)}`;

/** What is owed on an open repo (principal and the repo interest accrued), from the borrower's or the lender's side. */
const owedOn = (app, inst, pos) => money(Math.abs(pos.qty) + Math.abs(app.ledger.positionBalance(pos.id, pos.qty < 0 ? 'accrued.liab' : 'accrued.asset', inst.trading_ccy)), inst.trading_ccy);

/**
 * A buy/sell-back or sell/buy-back is two outright trades in one debt security: a spot trade for the cash principal and a
 * forward trade the other way, its price fixed at inception. The forward amount is the principal with repo interest to
 * the forward date, less each coupon paid on the security during the term with repo interest from its payment date (the
 * buyer keeps the coupon; the forward price is reduced by it). Prices are per 100 face, dirty and clean.
 */
function forwardOf(app, inst, coll, P, start) {
  const t = inst.terms;
  const ccy = inst.trading_ccy;
  const basis = basisDays(t.dayCount);
  const end = adjust(t.endDate, 'following', paymentCalendarFor(inst));
  const face = t.collateralQty * (coll.terms.factor ?? 1);
  const coupons = couponDates(coll.terms, start)
    .map((d) => ({ couponDate: d, payDate: adjust(d, 'following', paymentCalendarFor(coll)) }))
    .filter((c) => c.payDate > start && c.payDate <= end)
    .map((c) => ({ ...c, amount: money((face * (couponPer100(coll.terms, c.couponDate) ?? 0)) / 100, ccy) }));
  let amount = P * (1 + (t.rate * diffDays(start, end)) / basis);
  for (const c of coupons) amount -= c.amount * (1 + (t.rate * diffDays(c.payDate, end)) / basis);
  amount = money(amount, ccy);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const dirty = r6((amount / face) * 100);
  return { endDate: end, amount, spotDirtyPer100: r6((P / face) * 100), dirtyPer100: dirty, cleanPer100: r6(dirty - (accruedPer100(coll.terms, end) ?? 0)), coupons };
}

/**
 * A coupon paid on the security of a buy/sell-back or sell/buy-back during the term belongs to the buyer: the seller of
 * the bonds (who still carries them, the sale being a financing) receives it from the issuer and passes it on, which
 * reduces what it pays back at the forward date; the buyer receives it, which reduces what it is paid back. Interest is
 * brought to the payment date first, so the principal reduced bears interest from then on. Idempotent per coupon date.
 */
function passCoupons(app, { book, unit, inst, pos, upTo }) {
  const f = inst.terms.forward;
  let p = pos;
  if (!f?.coupons?.length || isZero(p.qty)) return p;
  const ccy = inst.trading_ccy;
  const coll = app.instruments.get(inst.terms.collateralInstrumentId);
  for (const c of f.coupons) {
    if (c.payDate > upTo || (p.data.couponsPassed || []).includes(c.couponDate)) continue;
    p = trueUpInterest(app, { book, unit, inst, pos: p, date: c.payDate, label: `Repo interest accrued on ${inst.name}` });
    const sold = p.qty < 0;
    app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'repo.coupon', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'engine',
      summary: sold
        ? `Coupon of ${c.couponDate} on the ${fmtQty(inst.terms.collateralQty)} ${symOf(coll)} sold under ${inst.name} passed to the buyer: ${fmt(c.amount, ccy)}; it reduces the amount paid back at the forward date`
        : `Coupon of ${c.couponDate} on the ${fmtQty(inst.terms.collateralQty)} ${symOf(coll)} bought under ${inst.name} received: ${fmt(c.amount, ccy)}; it reduces the amount received back at the forward date`,
      data: { couponDate: c.couponDate, payDate: c.payDate, amount: c.amount },
      entries: sold
        ? [{ account: 'cash', ccy, amount: -c.amount, positionId: p.id }, { account: 'loan.liab', ccy, amount: c.amount, positionId: p.id }]
        : [{ account: 'cash', ccy, amount: c.amount, positionId: p.id }, { account: 'loan.asset', ccy, amount: -c.amount, positionId: p.id }],
    });
    p = app.positions.change(app.positions.get(p.id), { dQty: sold ? c.amount : -c.amount, data: { couponsPassed: [...(p.data.couponsPassed || []), c.couponDate] } });
  }
  return p;
}

export const repo = {
  family: 'repo',
  kind: 'arrangement',
  label: 'Repo / reverse repo',
  qtyLabel: 'Cash principal',
  actions: () => ['repo', 'reverse_repo'],
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    // Repo interest is money-market interest: ACT/360 (dollar, euro) or ACT/365 (sterling). Another day count is refused.
    normalizeRate(t, errors, { strictDayCount: true, what: 'a repo' });
    if (!CCY_RE.test(draft.trading_ccy || '')) errors.push('Repo currency is required.');
    if (!t.collateralInstrumentId) errors.push('Choose the collateral security.');
    t.collateralQty = num(t.collateralQty);
    if (!(t.collateralQty > 0)) errors.push('Collateral quantity must be positive.');
    t.haircut = num(t.haircut) ?? 0;
    if (t.haircut < 0 || t.haircut >= 1) errors.push('Haircut must be a decimal between 0 and 1 (0.02 = 2%).');
    // An additional funding buffer the terms state, in the repo currency: positive takes cash off what the collateral
    // supports after the haircut, negative adds to it. Empty is none.
    t.buffer = num(t.buffer) ?? 0;
    t.term = ['overnight', 'term', 'open'].includes(t.term) ? t.term : t.endDate ? 'term' : 'open';
    if (t.term === 'open') t.endDate = null;
    else if (t.endDate && !ISO_DATE_RE.test(t.endDate)) errors.push('End date must be YYYY-MM-DD.');
    else if (t.term === 'term' && !t.endDate) errors.push('A term repo needs its end date (choose Open for a repo that runs until terminated).');
    t.style = ['classic', 'buy_sell_back'].includes(t.style) ? t.style : 'classic';
    t.collateralType = ['gc', 'special'].includes(t.collateralType) ? t.collateralType : 'gc';
    t.triparty = Boolean(t.triparty);
    return { terms: t, multiplier: 1, errors, settleCcy: draft.trading_ccy };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Rate', describeRate(t)], ['Term', t.term === 'open' ? 'Open (until terminated)' : `${t.term}${t.endDate ? `, ends ${t.endDate}` : ''}`], ['Collateral quantity', fmtQty(t.collateralQty)], ['Haircut', `${(t.haircut * 100).toFixed(2)}%`]];
    if (t.buffer) rows.push(['Additional buffer', `${t.buffer > 0 ? 'less' : 'plus'} ${fmt(Math.abs(t.buffer), inst.trading_ccy)}`]);
    rows.push(['Collateral type', t.collateralType === 'special' ? 'Special' : 'General collateral'], ['Structure', `${isBsb(inst) || t.style === 'buy_sell_back' ? 'Buy/sell-back' : 'Classic repo'}${t.triparty ? ', tri-party' : ', bilateral'}`]);
    if (t.forward) rows.push(['Forward price', `${t.forward.cleanPer100.toFixed(6)} clean, ${t.forward.dirtyPer100.toFixed(6)} dirty, on ${t.forward.endDate}: ${fmt(t.forward.amount, inst.trading_ccy)}`]);
    if (t.agent) rows.push(['Tri-party agent', t.agent]);
    if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
    return rows;
  },
  qtyStep: () => 0.01,
  checkOpen(app, { unit, inst, action, qty, collateralPositionId }) {
    const out = [];
    const ccy = inst.trading_ccy;
    const t = inst.terms;
    const today = app.clock.today();
    const side = REPO_SIDE_ONLY[inst.product_id];
    if (side && side !== action) out.push(side === 'repo'
      ? `${REPO_LABEL[inst.product_id]} raises cash against securities: it is entered on the Repo side. To lend cash against collateral, use a reverse repo or a buy/sell-back.`
      : `${REPO_LABEL[inst.product_id]} lends cash against securities: it is entered on the Reverse repo side. To raise cash against securities, use a repo or a sell/buy-back.`);
    if (t.term === 'term' && t.endDate && t.endDate <= today) out.push(`The end date ${t.endDate} is not after today (${today}).`);
    const coll = app.instruments.get(t.collateralInstrumentId);
    // Buy/sell-back and sell/buy-back: the forward price is fixed at inception, so the rate is fixed, the forward date
    // stated, and the security one whose coupons are known in advance, in the repo currency.
    if (isBsb(inst)) {
      if (t.rateType !== 'fixed') out.push(`${REPO_LABEL[inst.product_id]} fixes its forward price at inception: the repo rate must be fixed.`);
      if (t.term !== 'term' || !t.endDate) out.push(`${REPO_LABEL[inst.product_id]} runs to a stated forward date: choose Term and enter the end date.`);
      if (coll && (coll.family !== 'bond' || coll.terms.couponType === 'float')) out.push(`${REPO_LABEL[inst.product_id]} is done in a debt security whose coupons are known at inception; ${symOf(coll)} is not one.`);
      if (coll && coll.trading_ccy !== ccy) out.push(`${REPO_LABEL[inst.product_id]} is in the currency of its security (${coll.trading_ccy}).`);
    } else if (t.style === 'buy_sell_back') out.push('Structure Buy/sell-back belongs to the Buy/sell-back and Sell/buy-back products: choose one of them as the product, or Classic repo as the structure.');
    // The cash cannot exceed what the collateral supports: its market value (a debt security at its dirty value: clean
    // price plus the interest accrued to today) less the haircut and any additional buffer the terms state. This holds
    // for the cash raised on a repo and for the cash lent on a reverse repo. Without a price, or without a conversion
    // rate when the collateral is in another currency, that cannot be worked out and nothing is assumed.
    const supports = (c) => {
      if (c.error) { out.push(c.error); return; }
      if (qty > c.cover + 0.004) out.push(`The collateral${action === 'reverse_repo' ? ' received' : ''} supports at most ${fmt(Math.max(0, c.cover), ccy)}: ${coverText(c, coll, ccy)}; ${fmt(qty, ccy)} requested.`);
    };
    if (action === 'repo') {
      const p = collateralPositionId ? app.positions.get(collateralPositionId) : null;
      if (!p || p.unit_id !== unit.id || p.instrument_id !== t.collateralInstrumentId) out.push('Choose a position in this Treasury/Account that holds the collateral security.');
      else if (app.positions.freeQty(p) < t.collateralQty - 1e-9) out.push(`Only ${fmtQty(app.positions.freeQty(p))} of the collateral is unencumbered; ${fmtQty(t.collateralQty)} is needed.`);
      else supports(coverFor(app, inst, coll, t.collateralQty, today));
    } else {
      if (!coll) out.push('Choose the collateral security.');
      else supports(coverFor(app, inst, coll, t.collateralQty, today));
      const c = app.ledger.cash(unit.id, ccy);
      if (c.availableToWithdraw < qty - 0.004) out.push(`${unit.name} has ${fmt(c.availableToWithdraw, ccy)} of settled ${ccy} available to lend; ${fmt(qty, ccy)} requested.`);
    }
    return out;
  },
  /** The reconciliation the preview shows: collateral value, haircut, buffer and the most cash it supports. */
  previewDetail(app, { inst, qty, collateralPositionId }) {
    const coll = app.instruments.get(inst.terms.collateralInstrumentId);
    if (!coll) return null;
    const c = coverFor(app, inst, coll, inst.terms.collateralQty, app.clock.today());
    const collateral = c.error ? null : { qty: c.qty, price: c.price, clean: c.clean, accrued: c.accrued, worth: c.worth, haircut: c.haircut, haircutAmount: c.haircutAmount, afterHaircut: c.afterHaircut, buffer: c.buffer, supports: c.cover, symbol: symOf(coll) };
    const forward = isBsb(inst) && collateral && inst.terms.rateType === 'fixed' && inst.terms.endDate && coll.family === 'bond' ? forwardOf(app, inst, coll, money(qty, inst.trading_ccy), inst.terms.startDate || app.clock.today()) : null;
    // An overnight repo ends on the next business day of the currency's payment calendar: shown in the preview before it exists.
    const maturity = inst.terms.term === 'overnight' && !inst.terms.endDate ? addBusinessDays(app.clock.today(), 1, paymentCalendarFor(inst)) : null;
    return { collateral, forward, maturity, positionId: collateralPositionId || null };
  },
  open(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const ccy = inst.trading_ccy;
    const P = money(c.qty, ccy);
    const isRepo = c.action === 'repo';
    const today = c.tradeDate;
    const coll = app.instruments.get(inst.terms.collateralInstrumentId);
    const termEnd = inst.terms.term === 'overnight' && !inst.terms.endDate ? addBusinessDays(today, 1, paymentCalendarFor(inst)) : inst.terms.endDate;
    const bsb = isBsb(inst);
    let terms = { ...inst.terms, startDate: inst.terms.startDate || today, endDate: termEnd || null, ...(bsb ? { style: 'buy_sell_back' } : {}) };
    if (bsb) terms = { ...terms, forward: forwardOf(app, { ...inst, terms }, coll, P, terms.startDate) };
    app.instruments.update(inst.id, { terms }, { system: true });
    const fresh = app.instruments.get(inst.id);
    let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: inst.id, strategyId: c.strategyId });
    const f = terms.forward;
    const summary = bsb
      ? `${isRepo ? 'Sell/buy-back: sold' : 'Buy/sell-back: bought'} ${fmtQty(terms.collateralQty)} ${symOf(coll)} spot for ${fmt(P, ccy)} and ${isRepo ? 'bought it back' : 'sold it back'} forward for ${f.endDate} at ${fmt(f.amount, ccy)} (forward price ${f.cleanPer100.toFixed(6)} clean, ${f.dirtyPer100.toFixed(6)} dirty; ${describeRate(terms)})`
      : `${isRepo ? 'Repo' : 'Reverse repo'}: ${isRepo ? 'received' : 'paid'} ${fmt(P, ccy)} against ${fmtQty(terms.collateralQty)} ${symOf(coll)} at ${describeRate(terms)}${termEnd ? ` to ${termEnd}` : ', open'}`;
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: isRepo ? 'repo.open' : 'repo.reverse_open', instrumentId: inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: pos.id,
      summary, data: { principal: P, terms: fresh.terms, collateralPositionId: c.collateralPositionId || null, ...(c.data || {}) },
      entries: isRepo
        ? [{ account: 'cash', ccy, amount: P, positionId: pos.id }, { account: 'loan.liab', ccy, amount: -P, positionId: pos.id }]
        : [{ account: 'cash', ccy, amount: -P, positionId: pos.id }, { account: 'loan.asset', ccy, amount: P, positionId: pos.id }],
    });
    const data = { accrued: 0, accruedThrough: today, side: isRepo ? 'borrow' : 'lend', ...(bsb ? { couponsPassed: [] } : {}) };
    if (isRepo) {
      const cp = positions.get(c.collateralPositionId);
      positions.change(cp, { dPledged: terms.collateralQty });
      data.collateralPositionId = cp.id;
    } else data.collateralHeld = { instrumentId: terms.collateralInstrumentId, qty: terms.collateralQty };
    pos = positions.change(pos, { dQty: isRepo ? -P : P, data });
    return { eventId, position: pos, realized: 0, cashNet: isRepo ? P : -P };
  },
  checkClose(app, { unit, inst, pos, qty, date = app.clock.today() }) {
    const out = [];
    const ccy = inst.trading_ccy;
    // A repurchase (or the termination of a reverse repo) is for the whole principal: a part is not simulated, and it is
    // refused rather than quietly turned into a repurchase in full.
    if (qty !== undefined && qty !== null && qty < Math.abs(pos.qty) - 0.004) out.push(`A repo is repurchased or terminated in full: ${fmt(Math.abs(pos.qty), ccy)} is outstanding and ${fmt(qty, ccy)} was asked for. A partial repurchase is not simulated; repurchase in full and open a new repo for the amount that stays.`);
    const missing = inst.terms.rateType === 'floating' ? accruePrincipal(app, { inst, pos, date }).rateMissing : null;
    if (missing) out.push(`Repo interest on ${inst.name} cannot be worked out: no ${inst.terms.referenceRate} fixing from ${missing}. Enter the fixing by hand or set the rate before the repurchase.`);
    if (pos.qty < 0) {
      const due = Math.abs(pos.qty) + accruePrincipal(app, { inst, pos, date }).accrued;
      const have = app.ledger.cash(unit.id, ccy).availableToWithdraw;
      if (have < due - 0.004) out.push(`Repurchase needs ${fmt(due, ccy)} (principal plus repo interest); ${unit.name} has ${fmt(have, ccy)} of settled ${ccy} available.`);
    }
    return out;
  },
  /** What a repurchase / termination moves in cash today: the principal and the repo interest accrued to today. */
  closeAmounts(app, { inst, pos }) {
    const a = accruePrincipal(app, { inst, pos, date: app.clock.today() });
    return { principal: money(Math.abs(pos.qty), inst.trading_ccy), interest: money(a.accrued, inst.trading_ccy), full: true, accruedThrough: a.accruedThrough, rateMissing: a.rateMissing };
  },
  /** Repurchase / terminate: principal and repo interest are paid and the collateral is returned. */
  close(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const ccy = inst.trading_ccy;
    let pos = passCoupons(app, { book: c.book, unit: c.unit, inst, pos: c.pos, upTo: c.tradeDate });
    pos = trueUpInterest(app, { book: c.book, unit: c.unit, inst, pos, date: c.tradeDate, label: `Repo interest accrued on ${inst.name}` });
    const isRepo = pos.qty < 0;
    const P = Math.abs(pos.qty);
    const interest = settleInterest(app, { book: c.book, unit: c.unit, inst, pos, label: 'Repo interest' });
    const coll = app.instruments.get(inst.terms.collateralInstrumentId);
    const summary = isBsb(inst)
      ? `${isRepo ? 'Sell/buy-back completed: bought back' : 'Buy/sell-back completed: sold back'} ${fmtQty(inst.terms.collateralQty)} ${symOf(coll)} for ${fmt(money(P + (interest.amount || 0), ccy), ccy)} (principal ${fmt(P, ccy)}, repo interest ${fmt(interest.amount, ccy)})`
      : `${isRepo ? 'Repo repurchase' : 'Reverse repo matured'}: ${isRepo ? 'paid' : 'received'} ${fmt(P, ccy)} principal (interest ${fmt(interest.amount, ccy)}); collateral ${isRepo ? 'released' : 'returned'}`;
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: isRepo ? 'repo.close' : 'repo.reverse_close', instrumentId: inst.id, strategyId: pos.strategy_id, orderId: c.order?.id, positionId: pos.id, actor: c.actor || 'user',
      summary, data: { principal: P, interest: interest.amount },
      entries: isRepo
        ? [{ account: 'cash', ccy, amount: -P, positionId: pos.id }, { account: 'loan.liab', ccy, amount: P, positionId: pos.id }]
        : [{ account: 'cash', ccy, amount: P, positionId: pos.id }, { account: 'loan.asset', ccy, amount: -P, positionId: pos.id }],
    });
    pos = positions.get(pos.id);
    if (isRepo && pos.data.collateralPositionId) {
      const cp = positions.get(pos.data.collateralPositionId);
      if (cp) positions.change(cp, { dPledged: -Math.min(inst.terms.collateralQty, cp.pledged_qty) });
    }
    pos = positions.change(pos, { dQty: isRepo ? P : -P, data: { collateralHeld: null } });
    app.tasks.cancelFor(pos.id);
    app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'repo.margin' });
    return { eventId, position: pos, realized: 0, cashNet: isRepo ? -P : P, interestPaid: isRepo ? -(interest.amount || 0) : interest.amount || 0 };
  },
  /** A buy/sell-back's forward price is fixed at inception: its rate cannot be reset. */
  checkSetRate(inst) {
    return isBsb(inst) ? `${REPO_LABEL[inst.product_id]} fixed its forward price at inception (${inst.terms.forward ? fmt(inst.terms.forward.amount, inst.trading_ccy) : 'on its terms'}): the rate cannot be reset. Close it and enter a new one at the new rate.` : null;
  },
  /**
   * A change of collateral agreed with the counterparty, recorded by hand: more collateral (a margin call met after the
   * collateral fell), a return of excess collateral (after it rose), or a substitution by another security. The cover
   * after a return or a substitution must still meet what is owed with repo interest. On a repo the securities are the
   * borrower's own positions (pledged or released); on a reverse repo they are held, not owned, and only the record of
   * what is held changes. A buy/sell-back or sell/buy-back has no collateral to change: its securities were sold outright.
   */
  collateralChange(app, { book, unit, inst, pos, change, qty, positionId, instrumentId }) {
    const { positions } = app;
    const ccy = inst.trading_ccy;
    const t = inst.terms;
    need(!isZero(pos.qty), 'This repo is closed.');
    need(!isBsb(inst), `${REPO_LABEL[inst.product_id]} is two outright trades in one security with the forward price fixed at inception: there is no collateral to top up, return or substitute. Close it and enter a new one to change the securities.`);
    need(['pledge', 'release', 'substitute'].includes(change), 'Choose the collateral change: more collateral (a margin call), a return of excess collateral, or a substitution.');
    // A special repo is done for the security it names: that security is the point of the trade and is not substituted.
    need(!(change === 'substitute' && t.collateralType === 'special'), 'The collateral of a special repo is the security it names: it cannot be substituted. To change the security, repurchase the repo and enter a new one.');
    const q = num(qty);
    need(q > 0, 'Enter the quantity of collateral as a positive number.');
    const borrowed = pos.qty < 0;
    const today = app.clock.today();
    const coll = app.instruments.get(t.collateralInstrumentId);
    const owed = owedOn(app, inst, pos);
    const cp = borrowed ? positions.get(pos.data.collateralPositionId) : null;
    let newColl = coll, newQty, newPos = null;
    if (change === 'pledge') {
      if (borrowed) need(cp && positions.freeQty(cp) >= q - 1e-9, `Only ${fmtQty(cp ? Math.max(0, positions.freeQty(cp)) : 0)} more ${symOf(coll)} is unencumbered in ${unit.name}; ${fmtQty(q)} requested.`);
      newQty = t.collateralQty + q;
    } else if (change === 'release') {
      need(q < t.collateralQty - 1e-9, `${fmtQty(t.collateralQty)} ${symOf(coll)} is ${borrowed ? 'pledged' : 'held'}: to return all of it, ${borrowed ? 'repurchase' : 'terminate'} the repo.`);
      newQty = t.collateralQty - q;
    } else {
      if (borrowed) {
        newPos = positionId ? positions.get(positionId) : null;
        need(newPos && newPos.unit_id === unit.id && newPos.qty > 0, `Choose a long position held in ${unit.name} to pledge in substitution.`);
        need(newPos.id !== cp?.id, `The substitute must be another security than the ${symOf(coll)} already pledged.`);
        newColl = app.instruments.get(newPos.instrument_id);
        need(positions.freeQty(newPos) >= q - 1e-9, `Only ${fmtQty(Math.max(0, positions.freeQty(newPos)))} ${symOf(newColl)} is unencumbered in ${unit.name}; ${fmtQty(q)} requested.`);
      } else {
        newColl = instrumentId ? app.instruments.get(instrumentId) : null;
        need(newColl && ['bond', 'equity', 'fund'].includes(newColl.family), 'Choose the security received in substitution.');
        need(newColl.id !== coll?.id, `The substitute must be another security than the ${symOf(coll)} already held.`);
      }
      newQty = q;
    }
    const c = coverFor(app, inst, newColl, newQty, today);
    need(!c.error, c.error);
    if (change !== 'pledge' && c.cover < owed - 0.004) {
      throw new AppError(`After the ${change === 'release' ? 'return' : 'substitution'} the cover would be ${fmt(money(owed - c.cover, ccy), ccy)} short: ${coverText(c, newColl, ccy)}, so it covers ${fmt(c.cover, ccy)} against ${fmt(owed, ccy)} owed with repo interest.`);
    }
    if (borrowed) {
      if (change === 'pledge') positions.change(cp, { dPledged: q });
      else if (change === 'release') positions.change(cp, { dPledged: -q });
      else {
        if (cp) positions.change(cp, { dPledged: -Math.min(t.collateralQty, cp.pledged_qty) });
        positions.change(newPos, { dPledged: q });
      }
    }
    app.instruments.update(inst.id, { terms: { ...t, collateralInstrumentId: newColl.id, collateralQty: newQty } }, { system: true });
    const after = `now ${fmtQty(newQty)} ${symOf(newColl)} ${borrowed ? 'pledged' : 'held'}, worth ${fmt(c.worth, ccy)}: cover ${fmt(c.cover, ccy)} against ${fmt(owed, ccy)} owed`;
    const summary = {
      pledge: borrowed ? `Margin call met on ${inst.name}: pledged ${fmtQty(q)} more ${symOf(coll)} (${after})` : `Margin call on ${inst.name}: received ${fmtQty(q)} more ${symOf(coll)} from the counterparty (${after})`,
      release: borrowed ? `Excess collateral returned on ${inst.name}: ${fmtQty(q)} ${symOf(coll)} released (${after})` : `Excess collateral returned to the counterparty on ${inst.name}: ${fmtQty(q)} ${symOf(coll)} (${after})`,
      substitute: `Collateral substituted on ${inst.name}: ${fmtQty(t.collateralQty)} ${symOf(coll)} ${borrowed ? 'released' : 'returned'}, ${fmtQty(q)} ${symOf(newColl)} ${borrowed ? 'pledged' : 'received'} (${after})`,
    }[change];
    let fresh = positions.get(pos.id);
    fresh = positions.change(fresh, { data: borrowed ? (newPos ? { collateralPositionId: newPos.id } : {}) : { collateralHeld: { instrumentId: newColl.id, qty: newQty } } });
    const eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'repo.collateral', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id,
      summary, data: { change, qty: q, from: { instrumentId: coll?.id || null, qty: t.collateralQty }, to: { instrumentId: newColl.id, qty: newQty }, worth: c.worth, cover: c.cover, owed },
    });
    checkCover(app, { book, unit, inst: app.instruments.get(inst.id), pos: fresh, date: today });
    return { eventId, collateralQty: newQty, cover: c.cover, owed };
  },
  value(app, inst, pos) {
    const ccy = inst.trading_ccy;
    const borrowed = pos.qty < 0;
    return {
      price: null, mv: null, cost: 0, unrealized: 0, ledgerCarried: true, carrying: pos.qty,
      accrued: app.ledger.positionBalance(pos.id, borrowed ? 'accrued.liab' : 'accrued.asset', ccy),
      notional: Math.abs(pos.qty), exposure: null,
    };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    const fresh = app.instruments.get(inst.id);
    const common = { bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id };
    if (fresh.terms.endDate) app.tasks.schedule({ ...common, type: 'repo.end', dueDate: adjust(fresh.terms.endDate, 'following', paymentCalendarFor(inst)) });
    // The coupons a buy/sell-back or sell/buy-back passes over during its term, each on its payment date.
    for (const c of fresh.terms.forward?.coupons || []) {
      if (!(pos.data.couponsPassed || []).includes(c.couponDate)) app.tasks.schedule({ ...common, type: 'repo.coupon', dueDate: c.payDate, data: { key: c.couponDate, couponDate: c.couponDate } });
    }
  },
  /** The fixings a floating repo needs, and the collateral's price for the daily check of its cover. */
  dataNeeds(app, args) {
    const coll = app.instruments.get(args.inst.terms.collateralInstrumentId);
    const f = floatingNeeds(app, args);
    return coll ? { ...f, instruments: [coll] } : f;
  },
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty)) return;
    let p = passCoupons(app, { book, unit, inst, pos, upTo: date });
    p = trueUpInterest(app, { book, unit, inst, pos: p, date, label: `Repo interest accrued on ${inst.name}` });
    checkCover(app, { book, unit, inst, pos: p, date });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (!pos || isZero(pos.qty)) return 'done';
    if (task.type === 'repo.coupon') {
      passCoupons(app, { book, unit, inst, pos, upTo: task.due_date });
      return 'done';
    }
    if (task.type !== 'repo.end') return { failed: `Unknown task ${task.type}` };
    // As for a loan: a repurchase date reached for the first time after the day itself is settled as of that date.
    const today = app.clock.today();
    const asOf = task.status === 'pending' && task.due_date < today ? task.due_date : today;
    let p = passCoupons(app, { book, unit, inst, pos, upTo: asOf });
    p = trueUpInterest(app, { book, unit, inst, pos: p, date: asOf, label: `Repo interest accrued on ${inst.name}` });
    if (p.data.rateMissing) return { blocked: waitingForFixing(inst, p.data.rateMissing, pos.qty < 0 ? 'Repo repurchase' : 'Reverse repo termination') };
    const problems = repo.checkClose(app, { unit, inst, pos: p, date: asOf });
    if (problems.length) return fundingFailure(app, { book, unit, inst, pos, what: 'Repo repurchase', detail: problems[0] });
    const r = repo.close(app, { book, unit, inst, pos: p, tradeDate: asOf, actor: 'engine' });
    app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'funding.failed' });
    return { done: true, eventId: r.eventId };
  },
};

/**
 * The daily check of a repo's cover: the collateral at its value today (dirty for a debt security), less the haircut and
 * any additional buffer, against what is owed (principal and repo interest). A shortfall is raised, with its amount, and
 * says what to do: record the margin call (more collateral) with Collateral on the repo's row; it clears when the cover is
 * restored. A buy/sell-back has no margin: its securities were sold outright at a fixed forward price.
 */
function checkCover(app, { book, unit, inst, pos, date }) {
  const coll = app.instruments.get(inst.terms.collateralInstrumentId);
  if (!coll || isBsb(inst)) return;
  const ccy = inst.trading_ccy;
  const c = coverFor(app, inst, coll, inst.terms.collateralQty, date);
  if (c.error) return;
  const borrowed = pos.qty < 0;
  const owed = owedOn(app, inst, pos);
  const short = money(owed - c.cover, ccy);
  if (short < 0.01) { app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'repo.margin' }); return; }
  const what = `${fmtQty(inst.terms.collateralQty)} ${symOf(coll)} ${borrowed ? 'pledged' : 'received'}`;
  app.alerts.raise({
    bookId: book.id, unitId: unit.id, level: 'warning', code: 'repo.margin', refType: 'position', refId: pos.id,
    message: `${inst.name}: the ${what} are worth ${fmt(c.worth, ccy)} on ${date}, ${fmt(c.cover, ccy)} after the ${(c.haircut * 100).toFixed(2)}% haircut${bufferText(c, ccy)}, against ${fmt(owed, ccy)} ${borrowed ? 'owed' : 'lent'} with repo interest: the cover is ${fmt(short, ccy)} short. ${borrowed ? 'The counterparty may call for more collateral: record the securities pledged with Collateral on the repo, or repurchase it.' : 'Call the counterparty for more collateral and record what it delivers with Collateral on the reverse repo, or terminate it.'}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Securities borrowing and lending
// ---------------------------------------------------------------------------------------------

/** Price used for fee and collateral marks: the date's close, else the latest observation. */
function loanMark(app, underlyingId, date) {
  const c = app.data.closeFor(underlyingId, date);
  if (c && c.value !== null) return c;
  const p = app.data.price(underlyingId);
  return p && p.value !== null ? p : null;
}

/**
 * The market value of `qty` of a security lent or borrowed at `price` on `date`: for a debt security its dirty value (the
 * interest accrued to `date` added), on which a bond loan's cash collateral and fee are worked out.
 */
function loanValue(und, qty, price, date) {
  const bond = und.family === 'bond';
  const factor = bond ? und.terms.factor ?? 1 : 1;
  const ai = bond ? ((accruedPer100(und.terms, date) ?? 0) * qty * factor) / 100 : 0;
  return qty * price * und.multiplier * factor + ai;
}

export const secloan = {
  family: 'secloan',
  kind: 'arrangement',
  label: 'Securities loan',
  qtyLabel: 'Securities quantity',
  actions: () => ['borrow_sec', 'lend_sec'],
  calendar: calendarFor,
  normalize(app, draft) {
    const errors = [];
    const t = { ...(draft.terms || {}) };
    if (!draft.underlying_id) errors.push('Choose the security being borrowed or lent.');
    t.feeRate = num(t.feeRate);
    if (t.feeRate === null) errors.push('Enter the borrow/lending fee as a decimal per annum (0.005 = 0.5%). The Terminal does not assume a fee.');
    else if (t.feeRate < 0 || t.feeRate > 5) errors.push('The fee rate must be a decimal per annum (0.005 = 0.5%).');
    t.collateralPct = num(t.collateralPct) ?? 1.02;
    if (!(t.collateralPct >= 1 && t.collateralPct <= 2)) errors.push('Collateral must be between 100% and 200% of market value (1.02 = 102%).');
    t.recallable = t.recallable !== false;
    return { terms: t, multiplier: 1, errors };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Fee', `${(t.feeRate * 100).toFixed(3)}% p.a. on market value`], ['Cash collateral', `${(t.collateralPct * 100).toFixed(1)}% of market value`], ['Recallable', t.recallable ? 'Yes' : 'No'], ['Start', t.startDate || '(on execution)']];
    if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
    if (t.availabilitySource) rows.push(['Availability source', t.availabilitySource]);
    return rows;
  },
  qtyStep: () => 1,
  /** What the preview shows for securities lent: the cash collateral received, at its share of the market value (dirty for a bond). */
  previewDetail(app, { inst, action, qty }) {
    if (action !== 'lend_sec') return null;
    const und = app.instruments.get(inst.underlying_id);
    const mark = und ? loanMark(app, und.id, app.clock.today()) : null;
    const value = mark && und ? money(loanValue(und, qty, mark.value, app.clock.today()), inst.trading_ccy) : null;
    const stated = num(inst.terms.collateralAmount);
    return { value, collateralPct: inst.terms.collateralPct, collateralCash: stated ?? (value !== null ? money(inst.terms.collateralPct * value, inst.trading_ccy) : null) };
  },
  checkOpen(app, { unit, inst, action, qty, sourcePositionId }) {
    const out = [];
    if (action === 'lend_sec') {
      const p = sourcePositionId ? app.positions.get(sourcePositionId) : null;
      if (!p || p.unit_id !== unit.id || p.instrument_id !== inst.underlying_id) out.push('Choose a position in this Treasury/Account that holds the security to lend.');
      else if (app.positions.freeQty(p) < qty - 1e-9) out.push(`Only ${fmtQty(app.positions.freeQty(p))} is unencumbered; ${fmtQty(qty)} requested.`);
      if (!loanMark(app, inst.underlying_id, app.clock.today()) && num(inst.terms.collateralAmount) === null) out.push('No price is available to size the cash collateral. Enter a price for the security or state the collateral amount.');
    }
    return out;
  },
  open(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const und = app.instruments.get(inst.underlying_id);
    const ccy = inst.trading_ccy;
    const today = c.tradeDate;
    const borrow = c.action === 'borrow_sec';
    if (!inst.terms.startDate) app.instruments.update(inst.id, { terms: { ...inst.terms, startDate: today } }, { system: true });
    let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: inst.id, strategyId: c.strategyId });
    const mark = loanMark(app, inst.underlying_id, today);
    const entries = [];
    const data = { accrued: pos.data.accrued || 0, accruedThrough: pos.data.accruedThrough || today, side: borrow ? 'borrow' : 'lend', lastPrice: mark?.value ?? pos.data.lastPrice ?? null };
    let collateral = 0;
    if (!borrow) {
      const src = positions.get(c.sourcePositionId);
      positions.change(src, { dOnLoan: c.qty });
      data.sourcePositionId = src.id;
      collateral = money(num(inst.terms.collateralAmount) ?? inst.terms.collateralPct * loanValue(und, c.qty, mark.value, today), ccy);
      entries.push({ account: 'cash.restricted', ccy, amount: collateral, positionId: pos.id }, { account: 'coll.received', ccy, amount: -collateral, positionId: pos.id });
    }
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: borrow ? 'secloan.borrow' : 'secloan.lend', instrumentId: inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: pos.id,
      summary: borrow
        ? `Borrowed ${fmtQty(c.qty)} ${und.symbol || und.name} at a fee of ${(inst.terms.feeRate * 100).toFixed(3)}% p.a.`
        : `Lent ${fmtQty(c.qty)} ${und.symbol || und.name} at a fee of ${(inst.terms.feeRate * 100).toFixed(3)}% p.a.; received ${fmt(collateral, ccy)} cash collateral`,
      data: { qty: c.qty, terms: inst.terms, priceObsId: mark ? app.data.recordUsed(mark) : null, ...(c.data || {}) },
      entries,
    });
    pos = positions.change(pos, { dQty: borrow ? c.qty : -c.qty, data });
    return { eventId, position: pos, realized: 0, cashNet: 0 };
  },
  checkClose(app, { unit, inst, pos, qty }) {
    const out = [];
    if (qty > Math.abs(pos.qty) + 1e-9) out.push(`Only ${fmtQty(Math.abs(pos.qty))} is outstanding on this loan.`);
    if (pos.qty > 0) {
      // Borrowed securities can only go back once the short they support has been covered.
      const short = app.positions.find(unit.id, inst.underlying_id, pos.strategy_id);
      const shortQty = short && short.qty < 0 ? -short.qty : 0;
      // t1: a strategy can hold more than one borrow of the same security (a resized short borrows again): together they
      // support the short, so what may go back is what all of them hold beyond it, not what this one record holds alone.
      const others = app.positions.list({ unitIds: [unit.id], strategyId: pos.strategy_id })
        .filter((p) => p.id !== pos.id && p.qty > 0 && app.instruments.get(p.instrument_id)?.family === 'secloan' && app.instruments.get(p.instrument_id)?.underlying_id === inst.underlying_id)
        .reduce((a, p) => a + p.qty, 0);
      if (pos.qty + others - qty < shortQty - 1e-9) out.push(`${fmtQty(shortQty)} is still sold short against this borrow. Buy to cover before returning the securities.`);
    }
    return out;
  },
  /** Return borrowed securities, or take lent securities back. */
  close(app, c) {
    const { ledger, positions } = app;
    const inst = c.inst;
    const und = app.instruments.get(inst.underlying_id);
    const ccy = inst.trading_ccy;
    let pos = c.pos;
    secloan.eod(app, { book: c.book, unit: c.unit, inst, pos, date: c.tradeDate });
    pos = positions.get(pos.id);
    const borrowed = pos.qty > 0;
    const q = Math.min(c.qty, Math.abs(pos.qty));
    const full = q >= Math.abs(pos.qty) - 1e-9;
    const entries = [];
    let collateralBack = 0;
    if (!borrowed) {
      const held = -ledger.positionBalance(pos.id, 'coll.received', ccy);
      collateralBack = full ? held : money(held * (q / Math.abs(pos.qty)), ccy);
      entries.push({ account: 'cash.restricted', ccy, amount: -collateralBack, positionId: pos.id }, { account: 'coll.received', ccy, amount: collateralBack, positionId: pos.id });
    }
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: borrowed ? 'secloan.return' : 'secloan.recall', instrumentId: inst.id, strategyId: pos.strategy_id, orderId: c.order?.id, positionId: pos.id, actor: c.actor || 'user',
      summary: borrowed ? `Returned ${fmtQty(q)} borrowed ${und.symbol || und.name}` : `Took back ${fmtQty(q)} ${und.symbol || und.name} from loan; returned ${fmt(collateralBack, ccy)} cash collateral`,
      data: { qty: q },
      entries,
    });
    if (full) settleFees(app, { book: c.book, unit: c.unit, inst, pos });
    if (!borrowed && pos.data.sourcePositionId) {
      const src = positions.get(pos.data.sourcePositionId);
      if (src) positions.change(src, { dOnLoan: -Math.min(q, src.onloan_qty) });
    }
    pos = positions.change(positions.get(pos.id), { dQty: borrowed ? -q : q, data: full ? { recall: null } : {} });
    if (full) {
      app.tasks.cancelFor(pos.id);
      app.alerts.resolve({ refType: 'position', refId: pos.id });
    }
    return { eventId, position: pos, realized: 0, cashNet: 0 };
  },
  value(app, inst, pos) {
    const ccy = inst.trading_ccy;
    const und = app.instruments.get(inst.underlying_id);
    const p = app.data.price(inst.underlying_id);
    const borrowed = pos.qty > 0;
    return {
      price: null, mv: null, cost: 0, unrealized: 0, ledgerCarried: true, carrying: null,
      accrued: app.ledger.positionBalance(pos.id, borrowed ? 'accrued.liab' : 'accrued.asset', ccy),
      notional: p && p.value !== null ? money(Math.abs(pos.qty) * p.value * (und?.multiplier || 1), ccy) : null,
      exposure: null,
      collateral: borrowed ? null : -app.ledger.positionBalance(pos.id, 'coll.received', ccy),
      recall: pos.data.recall || null,
    };
  },
  onPositionChange(app, { book, unit, inst, pos }) {
    if (isZero(pos.qty)) return app.tasks.cancelFor(pos.id);
    app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'secloan.fee', dueDate: firstBusinessDayNextMonth(app.clock.today(), paymentCalendarFor(inst)) });
  },
  dataNeeds(app, { inst, date }) {
    const und = app.instruments.get(inst.underlying_id);
    return und ? { instruments: [und], closes: date ? [{ instrument: und, date }] : [] } : {};
  },
  /** Daily fee accrual on market value, and collateral marked to the day's price. */
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty)) return;
    const { ledger, positions } = app;
    const und = app.instruments.get(inst.underlying_id);
    const ccy = inst.trading_ccy;
    const borrowed = pos.qty > 0;
    const mark = loanMark(app, inst.underlying_id, date);
    const price = mark?.value ?? pos.data.lastPrice ?? null;
    const through = pos.data.accruedThrough || inst.terms.startDate || date;
    let accrued = pos.data.accrued || 0;
    if (price === null) {
      app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'warning', code: 'secloan.noprice', refType: 'position', refId: pos.id, message: `No price for ${und?.symbol || und?.name}: the ${borrowed ? 'borrow' : 'lending'} fee and collateral on ${inst.name} are not being marked.` });
      return;
    }
    app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'secloan.noprice' });
    const days = Math.max(0, diffDays(through, date));
    // The fee accrues on the clean market value (quantity x price x multiplier) for every security; a bond loan's cash
    // collateral is on its dirty value (below and at the start).
    if (days > 0) accrued += (Math.abs(pos.qty) * price * und.multiplier * inst.terms.feeRate * days) / 360;
    trueUpAccrual(app, {
      book, unit, pos, inst, ccy, type: 'accrual.fee', account: borrowed ? 'accrued.liab' : 'accrued.asset', pnlAccount: borrowed ? 'pnl.borrow' : 'pnl.lending',
      target: money(borrowed ? -accrued : accrued, ccy), summary: `${borrowed ? 'Borrow fee' : 'Lending fee'} accrued on ${fmtQty(Math.abs(pos.qty))} ${und.symbol || und.name}`,
    });
    positions.change(positions.get(pos.id), { data: { accrued, accruedThrough: days > 0 ? date : through, lastPrice: price } });
    if (!borrowed) {
      // Cash collateral we hold against securities lent is marked to the current value.
      const target = money(inst.terms.collateralPct * loanValue(und, Math.abs(pos.qty), price, date), ccy);
      const held = -ledger.positionBalance(pos.id, 'coll.received', ccy);
      const delta = money(target - held, ccy);
      if (Math.abs(delta) >= 0.01) {
        ledger.post({
          bookId: book.id, unitId: unit.id, type: 'collateral.mark', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
          summary: `Collateral on securities lent marked to market: ${delta > 0 ? 'received' : 'returned'} ${fmt(Math.abs(delta), ccy)}`,
          data: { target, held, price, priceObsId: mark ? app.data.recordUsed(mark) : null },
          entries: [{ account: 'cash.restricted', ccy, amount: delta, positionId: pos.id }, { account: 'coll.received', ccy, amount: -delta, positionId: pos.id }],
        });
      }
    }
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (!pos || isZero(pos.qty)) return 'done';
    const today = app.clock.today();
    if (task.type === 'secloan.fee') {
      secloan.eod(app, { book, unit, inst, pos, date: today });
      const r = settleFees(app, { book, unit, inst, pos: app.positions.get(pos.id) });
      if (!r.ok) return fundingFailure(app, { book, unit, inst, pos, amount: r.amount, what: 'Borrow fee payment' });
      app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'secloan.fee', dueDate: firstBusinessDayNextMonth(today, paymentCalendarFor(inst)) });
      return { done: true, eventId: r.eventId };
    }
    if (task.type === 'secloan.recall') {
      // The recall deadline has arrived. If the securities are still out, force the buy-in.
      const fresh = app.positions.get(pos.id);
      if (!fresh.data.recall) return 'done';
      const r = app.packages.forceBuyIn({ book, unit, loanPos: fresh, inst, qty: Math.min(fresh.data.recall.qty, fresh.qty) });
      return r.done ? 'done' : { blocked: r.reason, needs: r.needs || [] };
    }
    return { failed: `Unknown task ${task.type}` };
  },
  /** The lender recalls borrowed securities. Sets the deadline; the short must be covered or re-borrowed. */
  recall(app, { book, unit, inst, pos, qty, days = 2 }) {
    need(pos.qty > 0, 'Only borrowed securities can be recalled by the lender.');
    need(inst.terms.recallable, 'This borrow is not recallable.');
    const q = num(qty) ?? pos.qty;
    need(q > 0 && q <= pos.qty + 1e-9, `Only ${fmtQty(pos.qty)} is borrowed.`);
    const today = app.clock.today();
    const due = addBusinessDays(today, days, calendarFor(inst));
    const und = app.instruments.get(inst.underlying_id);
    const eventId = app.ledger.post({
      bookId: book.id, unitId: unit.id, type: 'secloan.recall_notice', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id,
      summary: `Lender recalled ${fmtQty(q)} ${und.symbol || und.name}; due back by ${due}`, data: { qty: q, due },
    });
    app.positions.change(pos, { data: { recall: { qty: q, noticeDate: today, dueDate: due } } });
    app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'secloan.recall', dueDate: due, data: { key: `recall-${today}` } });
    app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'secloan.recalled', refType: 'position', refId: pos.id, message: `${fmtQty(q)} ${und.symbol || und.name} has been recalled by the lender and must be returned by ${due}. Cover the short or arrange a new borrow; otherwise a buy-in is forced on that date.` });
    return { eventId, due };
  },
};

function settleFees(app, { book, unit, inst, pos }) {
  return settleInterest(app, { book, unit, inst, pos: { ...pos, data: { ...pos.data, side: pos.qty > 0 ? 'borrow' : 'lend' } }, label: pos.qty > 0 ? 'Borrow fee' : 'Lending fee' });
}

export { accruePrincipal, loanMark };
