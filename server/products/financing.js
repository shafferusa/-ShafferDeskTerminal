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
import { CCY_RE, ISO_DATE_RE, isZero, money, need, num } from '../core/util.js';
import { fmtQty, trueUpAccrual } from './common.js';
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

function normalizeRate(t, errors) {
  t.rateType = t.rateType === 'floating' ? 'floating' : 'fixed';
  if (t.rateType === 'fixed') {
    t.rate = num(t.rate);
    if (t.rate === null) errors.push('Enter the interest rate as a decimal (0.05 = 5%). The Terminal does not assume a rate.');
    else if (Math.abs(t.rate) > 1) errors.push('The rate looks like a percentage; enter it as a decimal (0.05 = 5%).');
  } else {
    if (!t.referenceRate) errors.push('A floating rate needs its reference rate code.');
    t.spread = num(t.spread) ?? 0;
  }
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
    normalizeRate(t, errors);
    if (!CCY_RE.test(draft.trading_ccy || '')) errors.push('Loan currency is required.');
    t.loanType = t.loanType || 'unsecured';
    t.interestPayment = t.interestPayment === 'monthly' ? 'monthly' : 'maturity';
    if (t.maturity && !ISO_DATE_RE.test(t.maturity)) errors.push('Maturity must be YYYY-MM-DD (leave empty for an open-ended arrangement).');
    if (!t.maturity) { t.maturity = null; t.interestPayment = 'monthly'; }
    t.collateral = Array.isArray(t.collateral) ? t.collateral.map((c) => ({ positionId: c.positionId, qty: num(c.qty) })).filter((c) => c.positionId && c.qty > 0) : [];
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
  checkClose(app, { unit, inst, pos, qty }) {
    const out = [];
    const ccy = inst.trading_ccy;
    if (qty > Math.abs(pos.qty) + 0.004) out.push(`Outstanding principal is ${fmt(Math.abs(pos.qty), ccy)}; cannot repay ${fmt(qty, ccy)}.`);
    if (pos.qty < 0) {
      const full = qty >= Math.abs(pos.qty) - 0.004;
      const interest = full ? accruePrincipal(app, { inst, pos, date: app.clock.today() }).accrued : 0;
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
    if (full) pos = trueUpInterest(app, { book: c.book, unit: c.unit, inst, pos, date: c.tradeDate });
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
      const r = settleInterest(app, { book, unit, inst, pos: p });
      if (!r.ok) return fundingFailure(app, { book, unit, inst, pos, amount: r.amount, what: 'Interest payment' });
      app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'loan.interest', dueDate: firstBusinessDayNextMonth(today, paymentCalendarFor(inst)) });
      return { done: true, eventId: r.eventId };
    }
    if (task.type === 'loan.maturity') {
      const problems = loan.checkClose(app, { unit, inst, pos, qty: Math.abs(pos.qty) });
      if (problems.length) return fundingFailure(app, { book, unit, inst, pos, what: 'Repayment at maturity', detail: problems[0] });
      const r = loan.close(app, { book, unit, inst, pos, qty: Math.abs(pos.qty), tradeDate: today, actor: 'engine' });
      app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'funding.failed' });
      return { done: true, eventId: r.eventId };
    }
    return { failed: `Unknown task ${task.type}` };
  },
};

function fundingFailure(app, { book, unit, inst, pos, amount, what, detail }) {
  const msg = detail || `${what} of ${fmt(amount, inst.trading_ccy)} on ${inst.name} could not be paid: insufficient settled ${inst.trading_ccy} cash in ${unit.name}.`;
  app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'funding.failed', refType: 'position', refId: pos.id, message: `${what} failed on ${inst.name}. ${msg}` });
  return { failed: msg };
}

// ---------------------------------------------------------------------------------------------
// Repo and reverse repo
// ---------------------------------------------------------------------------------------------

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
    normalizeRate(t, errors);
    if (!CCY_RE.test(draft.trading_ccy || '')) errors.push('Repo currency is required.');
    if (!t.collateralInstrumentId) errors.push('Choose the collateral security.');
    t.collateralQty = num(t.collateralQty);
    if (!(t.collateralQty > 0)) errors.push('Collateral quantity must be positive.');
    t.haircut = num(t.haircut) ?? 0;
    if (t.haircut < 0 || t.haircut >= 1) errors.push('Haircut must be a decimal between 0 and 1 (0.02 = 2%).');
    t.term = ['overnight', 'term', 'open'].includes(t.term) ? t.term : t.endDate ? 'term' : 'open';
    if (t.term === 'open') t.endDate = null;
    else if (t.endDate && !ISO_DATE_RE.test(t.endDate)) errors.push('End date must be YYYY-MM-DD.');
    t.style = ['classic', 'buy_sell_back'].includes(t.style) ? t.style : 'classic';
    t.collateralType = ['gc', 'special'].includes(t.collateralType) ? t.collateralType : 'gc';
    t.triparty = Boolean(t.triparty);
    return { terms: t, multiplier: 1, errors, settleCcy: draft.trading_ccy };
  },
  describe(inst) {
    const t = inst.terms;
    const rows = [['Rate', describeRate(t)], ['Term', t.term === 'open' ? 'Open (until terminated)' : `${t.term}${t.endDate ? `, ends ${t.endDate}` : ''}`], ['Collateral quantity', fmtQty(t.collateralQty)], ['Haircut', `${(t.haircut * 100).toFixed(2)}%`], ['Collateral type', t.collateralType === 'special' ? 'Special' : 'General collateral'], ['Structure', `${t.style === 'buy_sell_back' ? 'Buy/sell-back' : 'Classic repo'}${t.triparty ? ', tri-party' : ', bilateral'}`]];
    if (t.agent) rows.push(['Tri-party agent', t.agent]);
    if (t.counterparty) rows.push(['Counterparty', t.counterparty]);
    return rows;
  },
  qtyStep: () => 0.01,
  checkOpen(app, { unit, inst, action, qty, collateralPositionId }) {
    const out = [];
    const ccy = inst.trading_ccy;
    if (action === 'repo') {
      const p = collateralPositionId ? app.positions.get(collateralPositionId) : null;
      if (!p || p.unit_id !== unit.id || p.instrument_id !== inst.terms.collateralInstrumentId) out.push('Choose a position in this Treasury/Account that holds the collateral security.');
      else if (app.positions.freeQty(p) < inst.terms.collateralQty - 1e-9) out.push(`Only ${fmtQty(app.positions.freeQty(p))} of the collateral is unencumbered; ${fmtQty(inst.terms.collateralQty)} is needed.`);
    } else {
      const c = app.ledger.cash(unit.id, ccy);
      if (c.availableToWithdraw < qty - 0.004) out.push(`${unit.name} has ${fmt(c.availableToWithdraw, ccy)} of settled ${ccy} available to lend; ${fmt(qty, ccy)} requested.`);
    }
    return out;
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
    app.instruments.update(inst.id, { terms: { ...inst.terms, startDate: inst.terms.startDate || today, endDate: termEnd || null } }, { system: true });
    let pos = positions.ensure({ bookId: c.book.id, unitId: c.unit.id, instrumentId: inst.id, strategyId: c.strategyId });
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: isRepo ? 'repo.open' : 'repo.reverse_open', instrumentId: inst.id, strategyId: c.strategyId, orderId: c.order?.id, positionId: pos.id,
      summary: `${isRepo ? 'Repo' : 'Reverse repo'}: ${isRepo ? 'received' : 'paid'} ${fmt(P, ccy)} against ${fmtQty(inst.terms.collateralQty)} ${coll?.symbol || coll?.name || 'collateral'} at ${describeRate(inst.terms)}${termEnd ? ` to ${termEnd}` : ', open'}`,
      data: { principal: P, terms: inst.terms, collateralPositionId: c.collateralPositionId || null, ...(c.data || {}) },
      entries: isRepo
        ? [{ account: 'cash', ccy, amount: P, positionId: pos.id }, { account: 'loan.liab', ccy, amount: -P, positionId: pos.id }]
        : [{ account: 'cash', ccy, amount: -P, positionId: pos.id }, { account: 'loan.asset', ccy, amount: P, positionId: pos.id }],
    });
    const data = { accrued: 0, accruedThrough: today, side: isRepo ? 'borrow' : 'lend' };
    if (isRepo) {
      const cp = positions.get(c.collateralPositionId);
      positions.change(cp, { dPledged: inst.terms.collateralQty });
      data.collateralPositionId = cp.id;
    } else data.collateralHeld = { instrumentId: inst.terms.collateralInstrumentId, qty: inst.terms.collateralQty };
    pos = positions.change(pos, { dQty: isRepo ? -P : P, data });
    return { eventId, position: pos, realized: 0, cashNet: isRepo ? P : -P };
  },
  checkClose(app, { unit, inst, pos }) {
    const out = [];
    if (pos.qty < 0) {
      const ccy = inst.trading_ccy;
      const due = Math.abs(pos.qty) + accruePrincipal(app, { inst, pos, date: app.clock.today() }).accrued;
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
    let pos = trueUpInterest(app, { book: c.book, unit: c.unit, inst, pos: c.pos, date: c.tradeDate, label: `Repo interest accrued on ${inst.name}` });
    const isRepo = pos.qty < 0;
    const P = Math.abs(pos.qty);
    const interest = settleInterest(app, { book: c.book, unit: c.unit, inst, pos, label: 'Repo interest' });
    const eventId = ledger.post({
      bookId: c.book.id, unitId: c.unit.id, type: isRepo ? 'repo.close' : 'repo.reverse_close', instrumentId: inst.id, strategyId: pos.strategy_id, orderId: c.order?.id, positionId: pos.id, actor: c.actor || 'user',
      summary: `${isRepo ? 'Repo repurchase' : 'Reverse repo matured'}: ${isRepo ? 'paid' : 'received'} ${fmt(P, ccy)} principal (interest ${fmt(interest.amount, ccy)}); collateral ${isRepo ? 'released' : 'returned'}`,
      data: { principal: P, interest: interest.amount },
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
    return { eventId, position: pos, realized: 0, cashNet: isRepo ? -P : P, interestPaid: isRepo ? -(interest.amount || 0) : interest.amount || 0 };
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
    if (fresh.terms.endDate) app.tasks.schedule({ bookId: book.id, unitId: unit.id, positionId: pos.id, instrumentId: inst.id, strategyId: pos.strategy_id, type: 'repo.end', dueDate: adjust(fresh.terms.endDate, 'following', paymentCalendarFor(inst)) });
  },
  dataNeeds: floatingNeeds,
  eod(app, { book, unit, inst, pos, date }) {
    if (isZero(pos.qty)) return;
    trueUpInterest(app, { book, unit, inst, pos, date, label: `Repo interest accrued on ${inst.name}` });
  },
  runTask(app, task, { book, unit, inst, pos }) {
    if (task.type !== 'repo.end') return { failed: `Unknown task ${task.type}` };
    if (!pos || isZero(pos.qty)) return 'done';
    const problems = repo.checkClose(app, { unit, inst, pos });
    if (problems.length) return fundingFailure(app, { book, unit, inst, pos, what: 'Repo repurchase', detail: problems[0] });
    const r = repo.close(app, { book, unit, inst, pos, tradeDate: app.clock.today(), actor: 'engine' });
    app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'funding.failed' });
    return { done: true, eventId: r.eventId };
  },
};

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
      collateral = money(num(inst.terms.collateralAmount) ?? inst.terms.collateralPct * c.qty * mark.value * und.multiplier, ccy);
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
      if (pos.qty - qty < shortQty - 1e-9) out.push(`${fmtQty(shortQty)} is still sold short against this borrow. Buy to cover before returning the securities.`);
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
    if (days > 0) accrued += (Math.abs(pos.qty) * price * und.multiplier * inst.terms.feeRate * days) / 360;
    trueUpAccrual(app, {
      book, unit, pos, inst, ccy, type: 'accrual.fee', account: borrowed ? 'accrued.liab' : 'accrued.asset', pnlAccount: borrowed ? 'pnl.borrow' : 'pnl.lending',
      target: money(borrowed ? -accrued : accrued, ccy), summary: `${borrowed ? 'Borrow fee' : 'Lending fee'} accrued on ${fmtQty(Math.abs(pos.qty))} ${und.symbol || und.name}`,
    });
    positions.change(positions.get(pos.id), { data: { accrued, accruedThrough: days > 0 ? date : through, lastPrice: price } });
    if (!borrowed) {
      // Cash collateral we hold against securities lent is marked to the current value.
      const target = money(inst.terms.collateralPct * Math.abs(pos.qty) * price * und.multiplier, ccy);
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
