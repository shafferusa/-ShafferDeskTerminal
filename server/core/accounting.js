// Accounting views. The same five tabs exist at three scopes: the whole Book (Treasury plus
// every Account, consolidated without double-counting internal transfers), Treasury only, and
// each Account.
//
//   P&L · Open Positions · Pending Trades · Failed/Cancelled Trades · Full History
//
// Reporting-currency figures use the FX observation stored on each ledger entry at posting time
// for realized items and today's FX observation for balances, so income and FX are never counted
// twice. Anything that cannot be computed because a price or FX rate is missing is reported as
// missing, with the reason.

import { j, pj } from '../db/db.js';
import { fmt } from './books.js';
import { ACCOUNTS, BALANCE_SHEET_ACCOUNTS } from './ledger.js';
import { AppError, CCY_RE, isZero, money, need, num } from './util.js';

const PNL_CATEGORIES = [
  { key: 'realized', label: 'Realized P&L', accounts: ['pnl.realized'], note: 'Closed trades, futures variation margin, derivative cash flows.' },
  { key: 'dividends', label: 'Dividends', accounts: ['pnl.dividend'] },
  { key: 'couponInterest', label: 'Coupon and interest income', accounts: ['pnl.coupon', 'pnl.interest'] },
  { key: 'borrowFunding', label: 'Borrowing and funding expenses', accounts: ['pnl.borrow', 'pnl.funding'], note: 'Securities-borrow fees, dividend compensation on borrowed shares, loan and repo interest.' },
  { key: 'lendingIncome', label: 'Lending income', accounts: ['pnl.lending'] },
  { key: 'commissions', label: 'Commissions', accounts: ['pnl.commission'] },
  { key: 'fees', label: 'Fees', accounts: ['pnl.fee'] },
];
const REVERSIBLE = new Set(['capital.deposit', 'capital.withdrawal', 'transfer.funding', 'transfer.return', 'transfer.internal', 'manual.cashflow', 'manual.adjustment']);
const ACCRUAL_TYPES = ['accrual', 'accrual.coupon', 'accrual.interest', 'accrual.fee'];

export function createAccounting(app) {
  const { db, ledger, books, positions, instruments } = app;
  const inList = (ids) => ids.map(() => '?').join(',');

  // ---- metrics -----------------------------------------------------------------------------------
  /** FX translation effect on balances held in currencies other than the reporting currency. */
  function fxEffect(unitIds, rc) {
    if (!unitIds.length) return { value: 0, complete: true, byCurrency: [] };
    const rows = db.all(
      `SELECT account, ccy, SUM(amount) AS amount, SUM(amount_rc) AS amount_rc, SUM(CASE WHEN amount_rc IS NULL THEN 1 ELSE 0 END) AS missing
       FROM entries WHERE unit_id IN (${inList(unitIds)}) AND ccy <> ? GROUP BY account, ccy`, ...unitIds, rc,
    );
    const by = new Map();
    let complete = true;
    for (const r of rows) {
      const type = ACCOUNTS[r.account]?.type;
      if (!by.has(r.ccy)) by.set(r.ccy, { ccy: r.ccy, translation: 0, dealing: 0, missing: false });
      const b = by.get(r.ccy);
      if (r.missing) b.missing = true;
      if (type === 'asset' || type === 'liability') {
        const fx = app.data.fx(r.ccy, rc);
        if (!fx) { b.missing = true; continue; }
        b.translation += r.amount * fx.rate - (r.amount_rc || 0);
      } else if (type === 'clearing') b.dealing += -(r.amount_rc || 0);
    }
    // The reporting-currency side of conversions also carries dealing cost.
    const clr = db.get(`SELECT SUM(amount_rc) AS s FROM entries WHERE unit_id IN (${inList(unitIds)}) AND ccy = ? AND account = 'fx.clearing'`, ...unitIds, rc);
    let value = -(clr?.s || 0);
    const out = [];
    for (const b of by.values()) {
      if (b.missing) complete = false;
      value += b.translation + b.dealing;
      out.push({ ccy: b.ccy, translation: money(b.translation, rc), dealing: money(b.dealing, rc), complete: !b.missing });
    }
    return { value: money(value, rc), complete, byCurrency: out, dealingRc: money(-(clr?.s || 0), rc) };
  }

  /** Point-in-time metrics for a set of units. */
  function metrics(bookId, unitIds) {
    const rc = ledger.rcOf(bookId);
    const nav = app.valuation.nav(bookId, unitIds);
    let unrealizedRc = 0, unrealizedComplete = true;
    const unrealizedByCcy = new Map();
    for (const p of nav.positions) {
      if (p.ledgerCarried) continue;
      if (p.missing) { unrealizedComplete = false; continue; }
      if (p.unrealizedRc === null) { unrealizedComplete = false; continue; }
      unrealizedRc += p.unrealizedRc;
      unrealizedByCcy.set(p.ccy, (unrealizedByCcy.get(p.ccy) || 0) + p.unrealized);
    }
    const fx = fxEffect(unitIds, rc);
    return { rc, nav, navRc: nav.nav, navComplete: nav.complete, unrealizedRc: money(unrealizedRc, rc), unrealizedComplete, unrealizedByCcy: [...unrealizedByCcy].map(([ccy, amount]) => ({ ccy, amount: money(amount, ccy) })), fx };
  }

  /** NAV with its standing: final, or provisional together with every item that makes it so. */
  function navStatus(bookId, m) {
    const names = new Map(books.unitsOf(bookId).map((u) => [u.id, u.kind === 'treasury' ? 'Treasury' : u.name]));
    const label = (i) => i.symbol || i.name;
    const affected = [
      ...m.nav.unpriced.map((x) => ({ kind: 'unpriced', owner: names.get(x.unitId), instrument: x.instrument, qty: x.qty, ccy: x.ccy, detail: `${label(x.instrument)} (${names.get(x.unitId)}): no price, so it is carried at cost and left out of unrealized P&L` })),
      ...m.nav.stale.map((x) => ({ kind: 'stale-price', owner: names.get(x.unitId), instrument: x.instrument, qty: x.qty, ccy: x.ccy, asOf: x.asOf, detail: `${label(x.instrument)} (${names.get(x.unitId)}): valued on a mark that is not current (${x.status}, ${x.source}, as of ${x.asOf})` })),
      ...m.nav.fxMissing.map((ccy) => ({ kind: 'fx-missing', ccy, detail: `${ccy}: no conversion rate to ${m.rc}, so ${ccy} balances are left out of the total` })),
      ...m.nav.fxStale.map((x) => ({ kind: 'fx-stale', ccy: x.ccy, asOf: x.asOf, detail: `${x.ccy}: converted at a rate that is not current (${x.status}, ${x.source}, as of ${x.asOf})` })),
    ];
    return { value: m.navRc, complete: m.navComplete, provisional: m.nav.provisional, affected };
  }

  function snapshotBefore(unitIds, date) {
    // Latest snapshot strictly before `date` for each unit; null if any unit has none.
    let navRc = 0, unrealizedRc = 0, fxRc = 0, complete = true, asOf = null;
    for (const id of unitIds) {
      const row = db.get('SELECT * FROM snapshots WHERE unit_id = ? AND date < ? ORDER BY date DESC LIMIT 1', id, date);
      if (!row) {
        // A unit with no activity before the date starts from zero.
        const first = db.get('SELECT MIN(business_date) AS d FROM entries WHERE unit_id = ?', id)?.d;
        if (first && first < date) return null;
        continue;
      }
      const d = pj(row.data, {});
      navRc += d.navRc || 0; unrealizedRc += d.unrealizedRc || 0; fxRc += d.fxEffectRc || 0;
      if (!row.complete) complete = false;
      if (!asOf || row.date > asOf) asOf = row.date;
    }
    return { navRc, unrealizedRc, fxRc, complete, asOf };
  }

  // ---- 1. P&L -----------------------------------------------------------------------------------------
  function pnl(bookId, scope, { from, to } = {}) {
    const book = books.requireBook(bookId);
    const units = books.scopeUnits(bookId, scope);
    const ids = units.map((u) => u.id);
    const rc = book.reporting_ccy;
    const m = metrics(bookId, ids);
    const params = [...ids];
    let range = '';
    if (from) { range += ' AND business_date >= ?'; params.push(from); }
    if (to) { range += ' AND business_date <= ?'; params.push(to); }
    const rows = db.all(
      `SELECT account, ccy, SUM(amount) AS amount, SUM(amount_rc) AS amount_rc, SUM(CASE WHEN amount_rc IS NULL THEN 1 ELSE 0 END) AS missing
       FROM entries WHERE unit_id IN (${inList(ids)}) AND (account LIKE 'pnl.%' OR account IN ('capital','internal')) ${range} GROUP BY account, ccy`, ...params,
    );
    const categories = PNL_CATEGORIES.map((c) => {
      const mine = rows.filter((r) => c.accounts.includes(r.account));
      const byCcy = new Map();
      let rcTotal = 0, complete = true;
      for (const r of mine) {
        // Ledger income is credit-negative; report income as positive.
        byCcy.set(r.ccy, (byCcy.get(r.ccy) || 0) - r.amount);
        if (r.missing) complete = false;
        rcTotal -= r.amount_rc || 0;
      }
      return { key: c.key, label: c.label, note: c.note || null, byCurrency: [...byCcy].map(([ccy, amount]) => ({ ccy, amount: money(amount, ccy) })).filter((x) => x.amount !== 0), rc: money(rcTotal, rc), rcComplete: complete };
    });

    // Unrealized and FX are point-in-time; for a period they are the change since the last
    // valuation snapshot before the period.
    const start = from ? snapshotBefore(ids, from) : { navRc: 0, unrealizedRc: 0, fxRc: 0, complete: true, asOf: null };
    const periodKnown = start !== null;
    const unrealized = {
      key: 'unrealized', label: 'Unrealized P&L', current: m.unrealizedRc, currentByCurrency: m.unrealizedByCcy, complete: m.unrealizedComplete,
      change: periodKnown ? money(m.unrealizedRc - start.unrealizedRc, rc) : null, startAsOf: start?.asOf || null,
      note: m.unrealizedComplete ? null : 'Some open positions have no price and are carried at cost.',
    };
    const fx = {
      key: 'fx', label: 'FX effects', current: m.fx.value, complete: m.fx.complete, byCurrency: m.fx.byCurrency,
      change: periodKnown ? money(m.fx.value - start.fxRc, rc) : null,
      note: m.fx.complete ? 'Translation of foreign-currency balances at current rates, plus dealing cost on conversions.' : 'Incomplete: an FX rate is missing for at least one currency.',
    };
    const flows = { contributions: 0, withdrawals: 0, internalIn: 0, internalOut: 0, complete: true, byCurrency: [] };
    for (const r of rows.filter((x) => x.account === 'capital' || x.account === 'internal')) {
      if (r.missing) flows.complete = false;
      flows.byCurrency.push({ account: r.account, ccy: r.ccy, amount: money(-r.amount, r.ccy) });
    }
    const flowRows = db.all(
      `SELECT account, SUM(CASE WHEN amount < 0 THEN -amount_rc ELSE 0 END) AS inflow, SUM(CASE WHEN amount > 0 THEN amount_rc ELSE 0 END) AS outflow
       FROM entries WHERE unit_id IN (${inList(ids)}) AND account IN ('capital','internal') ${range} GROUP BY account`, ...params,
    );
    for (const r of flowRows) {
      if (r.account === 'capital') { flows.contributions = money(r.inflow || 0, rc); flows.withdrawals = money(r.outflow || 0, rc); } else { flows.internalIn = money(r.inflow || 0, rc); flows.internalOut = money(r.outflow || 0, rc); }
    }
    const realizedRc = categories.reduce((a, c) => a + c.rc, 0);
    const complete = categories.every((c) => c.rcComplete) && unrealized.complete && fx.complete && periodKnown;
    const total = periodKnown ? money(realizedRc + unrealized.change + fx.change, rc) : null;
    const netFlows = money(flows.contributions - flows.withdrawals + flows.internalIn - flows.internalOut, rc);
    const navStart = periodKnown ? money(start.navRc, rc) : null;
    return {
      scope: scopeInfo(bookId, scope, units), reportingCcy: rc, period: { from: from || null, to: to || null, startSnapshot: start?.asOf || null, known: periodKnown },
      categories, unrealized, fx,
      investmentPnl: total, complete,
      capital: { ...flows, net: netFlows, note: 'Capital contributions, withdrawals and internal transfers are not investment performance.' },
      nav: (() => {
        const explained = periodKnown && total !== null ? money(navStart + netFlows + total, rc) : null;
        // Start + flows + P&L is built from entries converted when they were posted; the NAV from balances
        // converted now. With every price and rate present they agree to within rounding of the lines.
        const difference = explained !== null && m.navComplete && complete ? money(m.navRc - explained, rc) : null;
        return { start: navStart, end: m.navRc, endComplete: m.navComplete, provisional: m.nav.provisional, affected: navStatus(bookId, m).affected, explained, difference, differenceIsRounding: difference !== null ? Math.abs(difference) <= 0.05 : null };
      })(),
      missing: { unpriced: m.nav.unpriced, fxMissing: m.nav.fxMissing, stale: m.nav.stale, fxStale: m.nav.fxStale },
      awaitingMessage: app.data.describe().awaitingMessage, marketConnected: app.data.marketConnected(),
    };
  }

  function scopeInfo(bookId, scope, units) {
    const all = books.unitsOf(bookId);
    return { bookId, scope: scope || 'book', consolidated: units.length > 1 || all.length === 1 && (!scope || scope === 'book'), units: units.map((u) => ({ id: u.id, name: u.name, kind: u.kind })) };
  }

  // ---- 2. Open positions -------------------------------------------------------------------------------
  function openPositions(bookId, scope) {
    const book = books.requireBook(bookId);
    const units = books.scopeUnits(bookId, scope);
    const ids = units.map((u) => u.id);
    const unitName = new Map(units.map((u) => [u.id, u]));
    const stratName = new Map();
    const rows = app.valuation.positionsOf(ids).map((p) => {
      if (p.strategyId && !stratName.has(p.strategyId)) stratName.set(p.strategyId, app.packages.getStrategyRow(p.strategyId));
      const s = p.strategyId ? stratName.get(p.strategyId) : null;
      const inst = instruments.get(p.instrument.id);
      let borrowing = null;
      if (p.qty < 0 && ['equity', 'bond'].includes(p.family)) {
        const loans = positions.list({ unitIds: [p.unitId], strategyId: p.strategyId }).filter((x) => { const i = instruments.get(x.instrument_id); return i.family === 'secloan' && i.underlying_id === inst.id && x.qty > 0; });
        const q = loans.reduce((a, x) => a + x.qty, 0);
        borrowing = { securitiesBorrowed: q, feeRate: loans.length ? instruments.get(loans[0].instrument_id).terms.feeRate : null, uncovered: Math.max(0, -p.qty - q) };
      }
      return {
        ...p, owner: { id: p.unitId, name: unitName.get(p.unitId)?.name, kind: unitName.get(p.unitId)?.kind },
        strategy: s ? { id: s.id, name: s.name, template: s.template, status: s.status, investmentStrategy: s.params.investmentStrategy || null } : null,
        borrowing,
        // The hedge request still open for this position's strategy, so it stays visible on the position.
        hedgeRequest: p.strategyId && app.hedge ? app.hedge.openForStrategy(p.strategyId) : null,
        // Relationship fields, from stored identifiers only: `relationships` (what this position finances, hedges or is
        // protected by), `protection` (linked, shared, allocated elsewhere, unrelated, unassessed; remaining exposure from
        // allocations that exist) and `hedgeOf` (this position's capacity and allocations when it is a hedge).
        ...(app.hedge?.positionLinks ? app.hedge.positionLinks(p.unitId, p.positionId) : {}),
        collateral: { pledgedQty: p.pledgedQty, onLoanQty: p.onLoanQty, restrictedCash: p.restrictedCash, marginPosted: p.marginPosted, received: p.collateral, held: p.data.collateralHeld || null },
        support: instruments.support(inst),
      };
    });
    const cash = [];
    for (const u of units) {
      for (const ccy of ledger.currencies([u.id])) {
        const c = ledger.cash(u.id, ccy);
        const borrowed = -ledger.balance(u.id, 'loan.liab', ccy), lent = ledger.balance(u.id, 'loan.asset', ccy);
        if ([c.settled, c.restricted, c.margin, c.receivable, c.payable, c.reserved, borrowed, lent].every((x) => x === 0)) continue;
        const fx = app.data.fx(ccy, book.reporting_ccy);
        cash.push({ owner: { id: u.id, name: u.name, kind: u.kind }, ...c, borrowed, lent, accruedReceivable: ledger.balance(u.id, 'accrued.asset', ccy), accruedPayable: -ledger.balance(u.id, 'accrued.liab', ccy), collateralReceived: -ledger.balance(u.id, 'coll.received', ccy), fxRate: fx ? fx.rate : null, settledRc: fx ? money(c.settled * fx.rate, book.reporting_ccy) : null });
      }
    }
    const m = metrics(bookId, ids);
    return { scope: scopeInfo(bookId, scope, units), reportingCcy: book.reporting_ccy, positions: rows, holdings: holdingsOf(rows), cash, nav: { ...navStatus(bookId, m), byCurrency: m.nav.byCurrency, unpriced: m.nav.unpriced, fxMissing: m.nav.fxMissing }, awaitingMessage: app.data.describe().awaitingMessage, marketConnected: app.data.marketConnected() };
  }

  /**
   * Gross holdings by instrument: long, short and net kept apart, with the owning Treasury or
   * Account. A net figure is never presented as the long holding.
   */
  function holdingsOf(rows) {
    const by = new Map();
    for (const p of rows) {
      if (['loan', 'repo', 'secloan'].includes(p.family)) continue;
      if (!by.has(p.instrument.id)) by.set(p.instrument.id, { instrument: p.instrument, long: 0, short: 0, net: 0, owners: [] });
      const h = by.get(p.instrument.id);
      let o = h.owners.find((x) => x.id === p.owner.id);
      if (!o) { o = { id: p.owner.id, name: p.owner.kind === 'treasury' ? 'Treasury' : p.owner.name, kind: p.owner.kind, long: 0, short: 0, net: 0 }; h.owners.push(o); }
      for (const t of [h, o]) { if (p.qty > 0) t.long += p.qty; else t.short += -p.qty; t.net += p.qty; }
    }
    return [...by.values()].sort((a, b) => ((a.instrument.symbol || a.instrument.name) < (b.instrument.symbol || b.instrument.name) ? -1 : 1));
  }

  // ---- borrowing register ---------------------------------------------------------------------------------
  const BORROW_TYPE = { loan: 'Cash loan', repo: 'Repo (cash borrowed against securities)', secloan: 'Securities borrowed' };
  const LOAN_TYPE = { margin: 'Margin loan', secured: 'Secured loan', unsecured: 'Unsecured loan', facility: 'Credit facility drawing' };
  const rateText = (t) => (t.rateType === 'floating' ? `${t.referenceRate} + ${((t.spread || 0) * 100).toFixed(2)}%` : t.rate !== null && t.rate !== undefined ? `${(t.rate * 100).toFixed(3)}% fixed` : null);

  /**
   * Every external borrowing of a scope, one record each. The record IS the position that carries
   * the liability in the owner's ledger: Treasury's funding view and the Book's consolidated view
   * read these same records, so a borrowing is never counted or created twice.
   */
  function borrowings(bookId, scope = 'book') {
    const book = books.requireBook(bookId);
    const units = books.scopeUnits(bookId, scope);
    const unit = new Map(units.map((u) => [u.id, u]));
    const ids = units.map((u) => u.id);
    const rc = book.reporting_ccy;
    const tasks = app.tasks.open(ids);
    const out = [];
    for (const p of positions.list({ unitIds: ids })) {
      if (isZero(p.qty)) continue;
      const inst = instruments.get(p.instrument_id);
      const borrowed = (inst.family === 'loan' && p.qty < 0) || (inst.family === 'repo' && p.qty < 0) || (inst.family === 'secloan' && p.qty > 0);
      if (!borrowed) continue;
      const t = inst.terms;
      const u = unit.get(p.unit_id);
      const ccy = inst.trading_ccy;
      const fx = app.data.fx(ccy, rc);
      const cash = inst.family !== 'secloan';
      const und = inst.underlying_id ? instruments.get(inst.underlying_id) : null;
      const coll = t.collateralInstrumentId ? instruments.get(t.collateralInstrumentId) : null;
      const undPx = und ? app.data.price(und.id)?.value ?? null : null;
      const principal = cash ? Math.abs(p.qty) : null;
      const securitiesValue = !cash && undPx !== null ? money(p.qty * undPx * und.multiplier, ccy) : null;
      const next = tasks.filter((x) => x.position_id === p.id && x.status !== 'failed').sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0] || null;
      const sum = (accounts) => db.get(`SELECT COALESCE(SUM(amount), 0) AS a, COALESCE(SUM(amount_rc), 0) AS r FROM entries WHERE position_id = ? AND account IN (${inList(accounts)})`, p.id, ...accounts);
      const interest = sum(['pnl.funding', 'pnl.borrow']), fees = sum(['pnl.fee', 'pnl.commission']);
      const strat = p.strategy_id ? app.packages.getStrategyRow(p.strategy_id) : null;
      let collateral;
      if (inst.family === 'repo') collateral = { kind: 'securities', description: `${coll ? coll.symbol || coll.name : 'Securities'}: ${Number(t.collateralQty).toLocaleString('en-US')} pledged, haircut ${((t.haircut || 0) * 100).toFixed(2)}%`, instrument: coll ? { id: coll.id, symbol: coll.symbol, name: coll.name } : null, qty: t.collateralQty };
      else if (inst.family === 'secloan') {
        // The cash collateral of a borrow sits on the short position it supports (the sale proceeds settle there
        // and the daily mark tops them up), so it is read from that position as well as from the borrow itself.
        const shortPos = und ? positions.find(p.unit_id, und.id, p.strategy_id) : null;
        const held = money(ledger.positionBalance(p.id, 'cash.restricted', ccy) + (shortPos ? ledger.positionBalance(shortPos.id, 'cash.restricted', ccy) : 0), ccy);
        collateral = { kind: 'cash', description: `Cash collateral ${((t.collateralPct || 1) * 100).toFixed(0)}% of market value, held as restricted cash`, cash: held || null }; }
      else if (Array.isArray(t.collateral) && t.collateral.length) collateral = { kind: 'securities', description: t.collateral.map((c) => { const cp = positions.get(c.positionId); const ci = cp ? instruments.get(cp.instrument_id) : null; return `${c.qty} ${ci ? ci.symbol || ci.name : 'securities'}`; }).join(', ') };
      else collateral = { kind: 'none', description: t.loanType === 'margin' ? 'Secured on the Account\'s holdings (margin loan); no specific pledge recorded' : 'None (unsecured)' };
      out.push({
        id: p.id, contractId: inst.id, name: inst.name,
        owner: { id: u.id, name: u.kind === 'treasury' ? 'Treasury' : u.name, kind: u.kind },
        originatedBy: u.kind === 'account' ? 'account' : 'treasury', accountOriginated: u.kind === 'account',
        type: inst.family === 'loan' ? LOAN_TYPE[t.loanType] || BORROW_TYPE.loan : BORROW_TYPE[inst.family], family: inst.family,
        lender: t.counterparty || (t.triparty ? t.agent : null) || null,
        ccy, principal, principalRc: principal !== null && fx ? money(principal * fx.rate, rc) : null,
        securities: cash ? null : { instrument: und ? { id: und.id, symbol: und.symbol, name: und.name } : null, qty: p.qty, value: securitiesValue },
        rate: cash ? { type: t.rateType || 'fixed', rate: t.rate ?? null, referenceRate: t.referenceRate || null, spread: t.spread ?? null, text: rateText(t), dayCount: t.dayCount || null } : { type: 'fee', rate: t.feeRate ?? null, text: t.feeRate !== null && t.feeRate !== undefined ? `${(t.feeRate * 100).toFixed(3)}% a year on market value` : null },
        startDate: t.startDate || (p.opened_at || '').slice(0, 10) || null,
        maturity: inst.family === 'loan' ? t.maturity || null : inst.family === 'repo' ? t.endDate || null : null,
        term: inst.family === 'repo' ? t.term : inst.family === 'secloan' ? 'open, recallable' : t.maturity ? 'term' : 'open-ended',
        collateral,
        schedule: { interest: inst.family === 'loan' ? (t.interestPayment === 'monthly' ? 'Interest paid monthly' : 'Interest paid at maturity') : inst.family === 'repo' ? 'Interest paid at repurchase' : 'Fee paid monthly', next: next ? { date: next.due_date, type: next.type, blocked: next.status === 'blocked' ? next.blocked_reason : null } : null },
        accrued: money(-ledger.positionBalance(p.id, 'accrued.liab', ccy), ccy),
        interestToDate: money(interest.a, ccy), interestToDateRc: money(interest.r, rc), feesToDate: money(fees.a, ccy),
        strategy: strat ? { id: strat.id, name: strat.name } : null, terms: app.products.get(inst.family).describe(inst, app),
      });
    }
    return out;
  }

  // ---- balance sheet -----------------------------------------------------------------------------------------
  const BS_LINES = [
    { key: 'cash', section: 'assets', label: 'Settled cash', accounts: ['cash'] },
    { key: 'restricted', section: 'assets', label: 'Restricted cash', accounts: ['cash.restricted'], note: 'Short-sale proceeds, collateral held against borrowed securities, and cash collateral received from OTC counterparties. Not buying power.' },
    { key: 'margin', section: 'assets', label: 'Margin and collateral posted', accounts: ['cash.margin'], note: 'Futures margin, and collateral posted on OTC positions. The poster\'s own asset, not spendable while posted.' },
    { key: 'receivable', section: 'assets', label: 'Receivable for unsettled trades', accounts: ['recv.settle'] },
    { key: 'accruedIncome', section: 'assets', label: 'Accrued income', accounts: ['accrued.asset'] },
    { key: 'positions', section: 'assets', label: 'Positions at market value', accounts: ['pos'], unrealized: true, note: 'Long positions less short positions. A position with no price is carried at cost.' },
    { key: 'lent', section: 'assets', label: 'Cash lent', accounts: ['loan.asset'] },
    { key: 'payable', section: 'liabilities', label: 'Payable for unsettled trades', accounts: ['pay.settle'] },
    { key: 'accruedExpense', section: 'liabilities', label: 'Accrued interest and fees payable', accounts: ['accrued.liab'] },
    { key: 'borrowed', section: 'liabilities', label: 'Cash borrowed', accounts: ['loan.liab'], note: 'External borrowing, on the balance sheet of the Treasury or Account that owes it.' },
    { key: 'collateralReceived', section: 'liabilities', label: 'Cash collateral received', accounts: ['coll.received'], note: 'Owed back to the counterparty that posted it. The cash itself is in Restricted cash.' },
  ];

  /**
   * Balance sheet of a scope as a consolidation worksheet: one column per Treasury or Account in
   * the scope, then eliminations, then the total. Internal funding between Treasury and Accounts
   * is shown in each column and eliminated in the whole-Book total; external borrowing is a
   * liability of the unit that owes it and enters the total exactly once.
   */
  function balanceSheet(bookId, scope = 'book') {
    const book = books.requireBook(bookId);
    const units = books.scopeUnits(bookId, scope);
    const all = books.unitsOf(bookId);
    const rc = book.reporting_ccy;
    const whole = units.length === all.length;
    const rate = new Map();
    const fxOf = (ccy) => { if (!rate.has(ccy)) rate.set(ccy, app.data.fx(ccy, rc)?.rate ?? null); return rate.get(ccy); };
    const cell = (byCcy) => {
      let total = 0, complete = true;
      const list = [];
      for (const [ccy, amount] of byCcy) {
        const a = money(amount, ccy);
        if (a === 0) continue;
        list.push({ ccy, amount: a });
        const r = fxOf(ccy);
        if (r === null) complete = false; else total += a * r;
      }
      return { rc: money(total, rc), complete, byCurrency: list.sort((a, b) => (a.ccy === rc ? -1 : b.ccy === rc ? 1 : a.ccy < b.ccy ? -1 : 1)) };
    };
    const addCells = (cells) => {
      const m = new Map();
      for (const c of cells) for (const x of c.byCurrency) m.set(x.ccy, (m.get(x.ccy) || 0) + x.amount);
      return cell(m);
    };
    // Per unit: ledger balances by account and currency, and unrealized P&L by currency.
    const per = new Map();
    for (const u of units) {
      const bal = new Map();
      for (const b of ledger.balances([u.id])) { if (!bal.has(b.account)) bal.set(b.account, new Map()); bal.get(b.account).set(b.ccy, b.amount); }
      const unreal = new Map();
      for (const r of app.valuation.nav(bookId, [u.id]).byCurrency) if (r.unrealized) unreal.set(r.ccy, r.unrealized);
      per.set(u.id, { bal, unreal });
    }
    const lineCell = (u, line, sign) => {
      const m = new Map();
      const { bal, unreal } = per.get(u.id);
      for (const a of line.accounts) for (const [ccy, amt] of bal.get(a) || []) m.set(ccy, (m.get(ccy) || 0) + sign * amt);
      if (line.unrealized) for (const [ccy, amt] of unreal) m.set(ccy, (m.get(ccy) || 0) + amt);
      return cell(m);
    };
    const lines = BS_LINES.map((line) => {
      const sign = line.section === 'liabilities' ? -1 : 1; // liabilities are shown as positive amounts owed
      const cells = Object.fromEntries(units.map((u) => [u.id, lineCell(u, line, sign)]));
      return { key: line.key, section: line.section, label: line.label, note: line.note || null, cells, elimination: null, total: addCells(Object.values(cells)) };
    }).filter((l) => l.total.byCurrency.length || Object.values(l.cells).some((c) => c.byCurrency.length));
    const sumSection = (section) => {
      const cells = Object.fromEntries(units.map((u) => [u.id, addCells(lines.filter((l) => l.section === section).map((l) => l.cells[u.id]))]));
      return { cells, total: addCells(Object.values(cells)) };
    };
    const assets = sumSection('assets'), liabilities = sumSection('liabilities');
    const minus = (a, b) => { const m = new Map(); for (const x of a.byCurrency) m.set(x.ccy, x.amount); for (const x of b.byCurrency) m.set(x.ccy, (m.get(x.ccy) || 0) - x.amount); return cell(m); };
    const netCells = Object.fromEntries(units.map((u) => [u.id, minus(assets.cells[u.id], liabilities.cells[u.id])]));
    const netAssets = { cells: netCells, total: addCells(Object.values(netCells)) };

    // Equity side. Internal funding: positive = funding this unit has received, negative = funding it has advanced.
    const equity = (account) => Object.fromEntries(units.map((u) => { const m = new Map(); for (const [ccy, amt] of per.get(u.id).bal.get(account) || []) m.set(ccy, -amt); return [u.id, cell(m)]; }));
    const capitalCells = equity('capital'), internalCells = equity('internal');
    const capital = { key: 'capital', label: 'External capital contributed', cells: capitalCells, elimination: null, total: addCells(Object.values(capitalCells)) };
    const internalSum = addCells(Object.values(internalCells));
    const internal = {
      key: 'internal', label: 'Funding between Treasury and Accounts', cells: internalCells,
      note: whole ? 'Internal to the Book: what Treasury advanced equals what the Accounts received, so it is eliminated from the Book total.' : 'Net funding these units have received from the rest of the Book (negative: advanced to it).',
      // In the whole Book the internal balances must cancel; anything left would be an error, so it is reported.
      elimination: whole ? { rc: money(-internalSum.rc, rc), byCurrency: internalSum.byCurrency.map((x) => ({ ccy: x.ccy, amount: -x.amount })) } : null,
      total: whole ? cell(new Map()) : internalSum, residual: whole ? internalSum.byCurrency.filter((x) => Math.abs(x.amount) > 0.004) : [],
      // Gross sides of the elimination, in the reporting currency: funding received by units, and advanced by units.
      gross: { received: money(Object.values(internalCells).reduce((a, c) => a + Math.max(0, c.rc), 0), rc), advanced: money(Object.values(internalCells).reduce((a, c) => a + Math.max(0, -c.rc), 0), rc) },
    };
    const resultCells = Object.fromEntries(units.map((u) => [u.id, { rc: money(netCells[u.id].rc - capitalCells[u.id].rc - internalCells[u.id].rc, rc), complete: netCells[u.id].complete && capitalCells[u.id].complete && internalCells[u.id].complete, byCurrency: [] }]));
    const results = { key: 'results', label: 'Results to date', note: 'Realized and unrealized profit and loss, income, expenses and FX effects, in the reporting currency.', cells: resultCells, elimination: null,
      total: { rc: money(netAssets.total.rc - capital.total.rc - internal.total.rc, rc), complete: netAssets.total.complete, byCurrency: [] } };

    // The Accounts of the scope as one column, for a worksheet with many Accounts. It is computed the
    // way an Accounts-only scope computes its total (the same cells added per currency, converted at
    // the same rates, at the same instant), so a collapsed "Accounts, combined" column is that total.
    // Transfers between the Accounts cancel in its funding line; funding from Treasury does not.
    const members = units.filter((u) => u.kind === 'account');
    let accountsCombined = null;
    if (members.length > 1) {
      const sum = (cells) => addCells(members.map((u) => cells[u.id]));
      const net = sum(netCells), cap = sum(capitalCells), fund = sum(internalCells);
      accountsCombined = {
        members: members.map((u) => u.id),
        lines: Object.fromEntries(lines.map((l) => [l.key, sum(l.cells)])),
        assets: sum(assets.cells), liabilities: sum(liabilities.cells), netAssets: net,
        representedBy: { capital: cap, internal: fund, results: { rc: money(net.rc - cap.rc - fund.rc, rc), complete: net.complete, byCurrency: [] } },
      };
    }

    const m = metrics(bookId, units.map((u) => u.id));
    const own = borrowings(bookId, units.map((u) => u.id).join(','));
    const out = {
      scope: scopeInfo(bookId, scope, units), reportingCcy: rc, asOf: app.clock.now().toISOString(), consolidated: whole && units.length > 1,
      columns: units.map((u) => ({ id: u.id, name: u.kind === 'treasury' ? 'Treasury' : u.name, kind: u.kind })),
      lines, assets, liabilities, netAssets, representedBy: [capital, internal, results], accountsCombined,
      nav: navStatus(bookId, m), borrowings: own,
      fxRates: [...rate].filter(([ccy]) => ccy !== rc).map(([ccy, r]) => ({ ccy, rate: r })),
      oversight: null,
      // OTC collateral inside the lines above, from the collateral register: what each unit of the scope has posted
      // (in "Margin and collateral posted") and holds from counterparties (in "Restricted cash", owed back in
      // "Cash collateral received"). Each amount sits with the one unit whose ledger moved. A memorandum is added
      // for amounts another unit posts on these units' behalf under a shared agreement.
      collateral: app.agreements ? app.agreements.totals(bookId, units.map((u) => u.id)) : null,
    };
    // Treasury alone: its direct balances are the columns above. What it oversees but does not owe
    // or own is listed apart, so an Account's borrowing is visible here without becoming a second loan.
    if (units.length === 1 && units[0].kind === 'treasury') {
      const accounts = all.filter((u) => u.kind === 'account');
      const acctBorrow = accounts.length ? borrowings(bookId, accounts.map((u) => u.id).join(',')) : [];
      out.oversight = {
        note: 'These balances belong to the Accounts. They are shown for oversight and are not part of Treasury\'s own assets or liabilities. Each borrowing below is the Account\'s own record, not a second loan.',
        accountBorrowings: acctBorrow,
        accounts: accounts.map((u) => {
          const am = metrics(bookId, [u.id]);
          const funded = new Map(); for (const [ccy, amt] of ledger.balances([u.id]).filter((b) => b.account === 'internal').map((b) => [b.ccy, -b.amount])) funded.set(ccy, amt);
          const borrowed = new Map(); for (const b of ledger.balances([u.id]).filter((x) => x.account === 'loan.liab')) borrowed.set(b.ccy, -b.amount);
          return { id: u.id, name: u.name, nav: navStatus(bookId, am), fundingReceived: cell(funded), cashBorrowed: cell(borrowed) };
        }),
      };
    }
    return out;
  }

  // ---- 3. Pending trades ---------------------------------------------------------------------------------
  function pending(bookId, scope) {
    const units = books.scopeUnits(bookId, scope);
    const ids = units.map((u) => u.id);
    const unitName = new Map(units.map((u) => [u.id, u.name]));
    const orders = ids.length ? db.all(`SELECT id FROM orders WHERE unit_id IN (${inList(ids)}) AND status IN ('pending','working','partial') ORDER BY created_at, leg_no`, ...ids).map((r) => decorate(app.packages.orderView(app.orders.get(r.id)))) : [];
    function decorate(o) {
      const s = app.packages.getStrategyRow(o.strategyId);
      const strategyHolds = ledger.listHolds([o.unitId]).filter((h) => h.ref_type === 'strategy' && h.ref_id === o.strategyId);
      return { ...o, owner: unitName.get(o.unitId), strategy: { id: s.id, name: s.name, status: s.status }, dependency: o.dependsOn.length ? { legs: o.dependsOn, status: o.statusReason?.startsWith('Waiting on') ? 'waiting' : 'satisfied' } : null, strategyReserved: strategyHolds.map((h) => ({ ccy: h.ccy, amount: h.amount, kind: h.kind })) };
    }
    const settlements = app.settle.pending(ids).map((s) => settlementView(s, unitName));
    const tasks = app.tasks.open(ids).filter((t) => t.status !== 'failed').map((t) => taskView(t, unitName));
    return {
      scope: scopeInfo(bookId, scope, units),
      openOrders: orders.filter((o) => o.status !== 'partial'),
      partiallyFilled: orders.filter((o) => o.status === 'partial'),
      awaitingSettlement: settlements,
      lifecycle: tasks,
    };
  }

  function settlementView(s, unitName) {
    const inst = s.instrument_id ? instruments.get(s.instrument_id) : null;
    const strat = s.strategy_id ? app.packages.getStrategyRow(s.strategy_id) : null;
    return { id: s.id, owner: unitName.get(s.unit_id), unitId: s.unit_id, kind: s.kind, instrument: app.valuation.lite(inst), strategy: strat ? { id: strat.id, name: strat.name } : null, dueDate: s.due_date, ccy: s.ccy, amount: s.amount, direction: s.amount > 0 ? 'receive' : 'pay', status: s.status, attempts: s.attempts, error: s.last_error, accounts: pj(s.accounts, ['cash']), createdAt: s.created_at, orderId: s.order_id, fillId: s.fill_id };
  }

  function taskView(t, unitName) {
    const inst = t.instrument_id ? instruments.get(t.instrument_id) : null;
    const strat = t.strategy_id ? app.packages.getStrategyRow(t.strategy_id) : null;
    const LABEL = { 'option.expiry': 'Option expiration', 'future.expiry': 'Futures final settlement', 'forward.maturity': 'Forward settlement', 'bond.coupon': 'Coupon payment', 'bond.maturity': 'Redemption at maturity', 'loan.interest': 'Interest payment', 'loan.maturity': 'Loan maturity', 'repo.end': 'Repo repurchase', 'secloan.fee': 'Borrow / lending fee payment', 'secloan.recall': 'Recall deadline', 'swap.payment': 'Swap leg payment', 'swap.notional': 'Notional exchange', 'swap.maturity': 'Swap maturity', 'cds.premium': 'CDS premium', 'cds.maturity': 'CDS maturity' };
    return { id: t.id, owner: unitName.get(t.unit_id), unitId: t.unit_id, type: t.type, label: LABEL[t.type] || t.type, instrument: app.valuation.lite(inst), strategy: strat ? { id: strat.id, name: strat.name } : null, positionId: t.position_id, dueDate: t.due_date, status: t.status, reason: t.blocked_reason, needs: t.needs, data: t.data };
  }

  // ---- 4. Failed / cancelled -------------------------------------------------------------------------------
  function failed(bookId, scope) {
    const units = books.scopeUnits(bookId, scope);
    const ids = units.map((u) => u.id);
    const unitName = new Map(units.map((u) => [u.id, u.name]));
    const orders = ids.length ? db.all(`SELECT id FROM orders WHERE unit_id IN (${inList(ids)}) AND status IN ('rejected','cancelled','expired') ORDER BY updated_at DESC LIMIT 500`, ...ids).map((r) => {
      const o = app.packages.orderView(app.orders.get(r.id));
      const s = app.packages.getStrategyRow(o.strategyId);
      const remaining = positions.list({ unitIds: [o.unitId], strategyId: o.strategyId }).filter((p) => !isZero(p.qty)).map((p) => { const i = instruments.get(p.instrument_id); return { instrument: i.symbol || i.name, qty: p.qty }; });
      const category = o.status === 'rejected' ? (o.statusReason?.startsWith('Dependency failed') ? 'Rejected (dependency failed)' : 'Rejected at execution') : o.status === 'cancelled' ? 'Cancelled' : 'Expired unfilled';
      return { ...o, category, owner: unitName.get(o.unitId), strategy: { id: s.id, name: s.name, status: s.status }, remainingPositions: remaining };
    }) : [];
    const settlements = app.settle.failed(ids).map((s) => settlementView(s, unitName));
    const tasks = app.tasks.open(ids).filter((t) => t.status === 'failed').map((t) => taskView(t, unitName));
    return { scope: scopeInfo(bookId, scope, units), orders, settlementFailures: settlements, lifecycleFailures: tasks };
  }

  // ---- 5. Full history -----------------------------------------------------------------------------------------
  function history(bookId, scope, { type, q, from, to, before, limit = 200, includeAccruals = false, strategyId, instrumentId } = {}) {
    const units = books.scopeUnits(bookId, scope);
    const ids = units.map((u) => u.id);
    const unitName = new Map(books.unitsOf(bookId).map((u) => [u.id, u.name]));
    const where = ['e.book_id = ?'];
    const params = [bookId];
    // An event belongs to a scope if it is owned by, or posts entries to, one of the scope's units.
    where.push(`(e.unit_id IN (${inList(ids)}) OR EXISTS (SELECT 1 FROM entries x WHERE x.event_id = e.id AND x.unit_id IN (${inList(ids)})))`);
    params.push(...ids, ...ids);
    if (type) { where.push('e.type LIKE ?'); params.push(`${type}%`); }
    if (!includeAccruals && !type) where.push(`e.type NOT IN (${ACCRUAL_TYPES.map(() => '?').join(',')})`), params.push(...ACCRUAL_TYPES);
    if (q) { where.push('e.summary LIKE ?'); params.push(`%${String(q).replace(/[%_]/g, '')}%`); }
    if (from) { where.push('e.business_date >= ?'); params.push(from); }
    if (to) { where.push('e.business_date <= ?'); params.push(to); }
    if (before) { where.push('e.id < ?'); params.push(Number(before)); }
    if (strategyId) { where.push('e.strategy_id = ?'); params.push(strategyId); }
    if (instrumentId) { where.push('e.instrument_id = ?'); params.push(instrumentId); }
    const lim = Math.min(Number(limit) || 200, 1000);
    params.push(lim + 1);
    const rows = db.all(`SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ?`, ...params);
    const more = rows.length > lim;
    const events = rows.slice(0, lim).map((e) => eventView(e, unitName, ids));
    const types = db.all('SELECT type, COUNT(*) AS n FROM events WHERE book_id = ? GROUP BY type ORDER BY type', bookId);
    return { scope: scopeInfo(bookId, scope, units), events, more, nextBefore: more ? events[events.length - 1].id : null, types, accrualsHidden: !includeAccruals && !type };
  }

  function eventView(e, unitName, scopeIds) {
    const entries = db.all('SELECT unit_id, account, ccy, amount, amount_rc, fx_rate, fx_obs_id FROM entries WHERE event_id = ?', e.id);
    const cash = new Map();
    for (const en of entries) {
      if (scopeIds && !scopeIds.includes(en.unit_id)) continue;
      if (en.account === 'cash') cash.set(en.ccy, (cash.get(en.ccy) || 0) + en.amount);
    }
    const inst = e.instrument_id ? instruments.get(e.instrument_id) : null;
    const correctedBy = db.all('SELECT id FROM events WHERE corrects_event_id = ?', e.id).map((r) => r.id);
    return {
      id: e.id, ts: e.ts, businessDate: e.business_date, type: e.type, summary: e.summary, owner: e.unit_id ? unitName.get(e.unit_id) : null, unitId: e.unit_id,
      instrument: inst ? { id: inst.id, symbol: inst.symbol, name: inst.name } : null, strategyId: e.strategy_id, orderId: e.order_id, positionId: e.position_id, actor: e.actor,
      cash: [...cash].map(([ccy, amount]) => ({ ccy, amount: money(amount, ccy) })).filter((c) => c.amount !== 0),
      entries: entries.map((en) => ({ owner: unitName.get(en.unit_id), account: en.account, accountLabel: ACCOUNTS[en.account]?.label || en.account, ccy: en.ccy, amount: en.amount, amountRc: en.amount_rc, fxRate: en.fx_rate, fxObsId: en.fx_obs_id })),
      data: pj(e.data, {}), correctsEventId: e.corrects_event_id, correctedBy, reversible: REVERSIBLE.has(e.type) && !correctedBy.length,
    };
  }

  // ---- corrections ---------------------------------------------------------------------------------------------------
  /** Reverse a simple cash event. The original stays in the trail; the reversal points at it. */
  function reverseEvent(eventId, { note } = {}) {
    const e = db.get('SELECT * FROM events WHERE id = ?', eventId);
    need(e, 'Event not found.', { status: 404 });
    need(REVERSIBLE.has(e.type), 'This kind of event cannot be reversed automatically. Record a manual adjustment that references it instead.');
    need(!db.get('SELECT 1 FROM events WHERE corrects_event_id = ?', eventId), 'This event has already been corrected.', { status: 409 });
    const entries = db.all('SELECT * FROM entries WHERE event_id = ?', eventId);
    for (const en of entries) {
      if (en.account === 'cash' && en.amount > 0) {
        const have = ledger.cash(en.unit_id, en.ccy).availableToWithdraw;
        need(have >= en.amount - 0.004, `Reversing this would take ${fmt(en.amount, en.ccy)} out of ${books.getUnit(en.unit_id).name}, which has ${fmt(have, en.ccy)} available.`, { code: 'insufficient_cash' });
      }
    }
    const pos = e.position_id ? positions.get(e.position_id) : null;
    return db.tx(() => {
      const id = ledger.post({
        bookId: e.book_id, unitId: e.unit_id, type: `${e.type}.reversal`, instrumentId: e.instrument_id, strategyId: e.strategy_id, positionId: e.position_id, correctsEventId: eventId,
        summary: `Correction: reversal of event #${eventId} (${e.summary})${note ? `. ${note}` : ''}`, data: { note: note || null },
        entries: entries.map((en) => ({ unitId: en.unit_id, account: en.account, ccy: en.ccy, amount: -en.amount, instrumentId: en.instrument_id, strategyId: en.strategy_id, positionId: en.position_id })),
      });
      const costBack = entries.filter((en) => en.account === 'pos' && en.position_id === e.position_id).reduce((a, en) => a + en.amount, 0);
      if (pos && costBack) positions.change(pos, { dCost: -costBack });
      return { eventId: id };
    });
  }

  const ADJ_ACCOUNTS = { realized: 'pnl.realized', dividend: 'pnl.dividend', coupon: 'pnl.coupon', interest: 'pnl.interest', borrow: 'pnl.borrow', funding: 'pnl.funding', lending: 'pnl.lending', commission: 'pnl.commission', fee: 'pnl.fee', capital: 'capital' };
  /** Manual adjusting journal: cash against a named category, optionally referencing the event it corrects. */
  function manualAdjustment({ bookId, unitId, ccy, amount, category, note, correctsEventId }) {
    books.requireBook(bookId);
    const unit = books.requireUnit(unitId, bookId);
    need(CCY_RE.test(ccy || ''), 'Enter a three-letter currency code.');
    const amt = money(num(amount), ccy);
    need(amt !== 0 && Number.isFinite(amt), 'Enter a non-zero amount (positive = cash received, negative = cash paid).');
    const account = ADJ_ACCOUNTS[category];
    need(account, 'Choose the category the adjustment belongs to.');
    need(account !== 'capital' || unit.kind === 'treasury', 'External capital is recorded in Treasury.');
    need(String(note || '').trim(), 'A manual adjustment needs a note explaining it.');
    if (correctsEventId) need(db.get('SELECT 1 FROM events WHERE id = ? AND book_id = ?', correctsEventId, bookId), 'The event being corrected was not found in this Book.');
    if (amt < 0) {
      const have = ledger.cash(unit.id, ccy).availableToWithdraw;
      need(have >= -amt - 0.004, `${unit.name} has ${fmt(have, ccy)} available; ${fmt(-amt, ccy)} is needed.`, { code: 'insufficient_cash' });
    }
    const eventId = ledger.post({
      bookId, unitId: unit.id, type: 'manual.adjustment', correctsEventId: correctsEventId || null,
      summary: `Manual adjustment (${category}): ${amt > 0 ? 'received' : 'paid'} ${fmt(Math.abs(amt), ccy)}. ${note}${correctsEventId ? ` (corrects event #${correctsEventId})` : ''}`,
      data: { category, note },
      entries: [{ account: 'cash', ccy, amount: amt }, { account, ccy, amount: -amt }],
    });
    return { eventId };
  }

  /** Manually recorded cash flow on a position (distributions, capital calls, coupons, fees on manual holdings). */
  function manualCashflow({ positionId, category, amount, note }) {
    const pos = positions.get(positionId);
    need(pos, 'Position not found.', { status: 404 });
    const inst = instruments.get(pos.instrument_id);
    const ccy = inst.trading_ccy;
    const amt = money(num(amount), ccy);
    need(amt !== 0 && Number.isFinite(amt), 'Enter a non-zero amount (positive = cash received, negative = cash paid).');
    const unit = books.getUnit(pos.unit_id);
    if (amt < 0) {
      const have = ledger.cash(unit.id, ccy).availableToWithdraw;
      need(have >= -amt - 0.004, `${unit.name} has ${fmt(have, ccy)} available; ${fmt(-amt, ccy)} is needed.`, { code: 'insufficient_cash' });
    }
    const capitalLike = category === 'return_of_capital' || category === 'capital_call';
    const account = capitalLike ? 'pos' : ADJ_ACCOUNTS[category];
    need(account && account !== 'capital', 'Choose the kind of cash flow.');
    return db.tx(() => {
      const eventId = ledger.post({
        bookId: pos.book_id, unitId: unit.id, type: 'manual.cashflow', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id,
        summary: `Manual ${String(category).replace(/_/g, ' ')} on ${inst.symbol || inst.name}: ${amt > 0 ? 'received' : 'paid'} ${fmt(Math.abs(amt), ccy)}${note ? `. ${note}` : ''}`,
        data: { category, note: note || null },
        entries: [{ account: 'cash', ccy, amount: amt, positionId: pos.id }, { account, ccy, amount: -amt, positionId: pos.id }],
      });
      // A return of capital lowers cost; a capital call raises it.
      if (capitalLike) positions.change(pos, { dCost: -amt });
      return { eventId };
    });
  }

  // ---- Treasury ----------------------------------------------------------------------------------------------------------
  function treasury(bookId) {
    const book = books.requireBook(bookId);
    const tr = books.treasuryOf(bookId);
    const units = books.unitsOf(bookId);
    const ids = units.map((u) => u.id);
    const unitName = new Map(units.map((u) => [u.id, u]));
    const rc = book.reporting_ccy;
    const cash = ledger.currencies([tr.id]).map((ccy) => {
      const c = ledger.cash(tr.id, ccy);
      return { ...c, borrowed: -ledger.balance(tr.id, 'loan.liab', ccy), lent: ledger.balance(tr.id, 'loan.asset', ccy), collateralReceived: -ledger.balance(tr.id, 'coll.received', ccy) };
    }).filter((c) => [c.settled, c.restricted, c.margin, c.receivable, c.payable, c.reserved, c.borrowed, c.lent].some((x) => x !== 0));
    const funding = [];
    for (const u of units) {
      for (const ccy of ledger.currencies([u.id])) {
        const bal = ledger.balance(u.id, 'internal', ccy);
        if (bal !== 0 && u.kind === 'account') funding.push({ account: { id: u.id, name: u.name }, ccy, funded: -bal });
      }
    }
    const all = app.valuation.positionsOf(ids);
    const arrangements = all.filter((p) => ['loan', 'repo', 'secloan'].includes(p.family)).map((p) => {
      const inst = instruments.get(p.instrument.id);
      const und = inst.underlying_id ? instruments.get(inst.underlying_id) : inst.terms.collateralInstrumentId ? instruments.get(inst.terms.collateralInstrumentId) : null;
      return { ...p, owner: { id: p.unitId, name: unitName.get(p.unitId).name, kind: unitName.get(p.unitId).kind }, name: inst.name, terms: app.products.get(inst.family).describe(inst, app), related: und ? { id: und.id, symbol: und.symbol, name: und.name } : null, rawTerms: inst.terms };
    });
    const inventory = all.filter((p) => !['loan', 'repo', 'secloan', 'swap', 'cds', 'forward', 'future', 'option', 'otcoption'].includes(p.family) && p.qty > 0).map((p) => ({
      positionId: p.positionId, owner: { id: p.unitId, name: unitName.get(p.unitId).name, kind: unitName.get(p.unitId).kind }, instrument: p.instrument, qty: p.qty, pledgedQty: p.pledgedQty, onLoanQty: p.onLoanQty,
      availableQty: Math.max(0, p.qty - p.pledgedQty - p.onLoanQty), price: p.price, priceObs: p.priceObs, ccy: p.ccy, mv: p.mv,
      availableValue: p.price !== null ? money(Math.max(0, p.qty - p.pledgedQty - p.onLoanQty) * p.price * p.instrument.multiplier * (p.family === 'bond' ? 1 : 1), p.ccy) : null,
    }));
    const received = arrangements.filter((a) => a.data?.collateralHeld).map((a) => { const i = instruments.get(a.data.collateralHeld.instrumentId); return { arrangement: a.name, owner: a.owner, instrument: i ? { id: i.id, symbol: i.symbol, name: i.name } : null, qty: a.data.collateralHeld.qty }; });
    const m = metrics(bookId, ids);
    const tm = metrics(bookId, [tr.id]);
    const allBorrow = borrowings(bookId, 'book');
    return {
      book: { id: book.id, name: book.name, reportingCcy: rc }, treasury: { id: tr.id, name: tr.name }, cash, accountFunding: funding, arrangements, otcCollateral: app.agreements ? { agreements: app.agreements.list(bookId).filter((a) => a.status === 'active').length, ...app.agreements.totals(bookId) } : null, collateralInventory: inventory, collateralReceived: received,
      bookNav: navStatus(bookId, m), treasuryNav: navStatus(bookId, tm), holds: ledger.listHolds(ids),
      // One register: Treasury's own borrowings, and Account-originated borrowings it oversees but does not owe.
      borrowings: { direct: allBorrow.filter((b) => !b.accountOriginated), accountOriginated: allBorrow.filter((b) => b.accountOriginated) },
    };
  }

  /** Header figures for a Book. */
  function overview(bookId) {
    const book = books.requireBook(bookId);
    const units = books.unitsOf(bookId);
    const rc = book.reporting_ccy;
    const rows = units.map((u) => {
      const m = metrics(bookId, [u.id]);
      const open = positions.list({ unitIds: [u.id] }).filter((p) => !isZero(p.qty)).length;
      return { id: u.id, name: u.name, kind: u.kind, nav: m.navRc, navComplete: m.navComplete, navProvisional: m.nav.provisional, unrealized: m.unrealizedRc, unrealizedComplete: m.unrealizedComplete, openPositions: open, cash: ledger.currencies([u.id]).map((ccy) => ({ ccy, ...ledger.cash(u.id, ccy) })).filter((c) => c.settled !== 0 || c.reserved !== 0 || c.unsettled !== 0 || c.restricted !== 0 || c.margin !== 0) };
    });
    const m = metrics(bookId, units.map((u) => u.id));
    return { book: { id: book.id, name: book.name, reportingCcy: rc }, nav: m.navRc, navComplete: m.navComplete, navProvisional: m.nav.provisional, navAffected: navStatus(bookId, m).affected, unrealized: m.unrealizedRc, unrealizedComplete: m.unrealizedComplete, units: rows, unpriced: m.nav.unpriced.length, fxMissing: m.nav.fxMissing, alerts: app.alerts.open(bookId) };
  }

  /** End-of-day valuation snapshot per unit, keeping the observations used. */
  function snapshot(date) {
    let n = 0;
    for (const book of books.listBooks()) {
      for (const u of book.units) {
        const m = metrics(book.id, [u.id]);
        const marks = m.nav.positions.filter((p) => !p.ledgerCarried).map((p) => ({ positionId: p.positionId, instrumentId: p.instrument.id, qty: p.qty, price: p.price, priceObsId: p.priceObs ? app.data.recordUsed(app.data.price(p.instrument.id)) : null, mv: p.mv, unrealized: p.unrealized, ccy: p.ccy }));
        const fx = m.nav.byCurrency.filter((r) => r.ccy !== m.rc && r.fxRate !== null).map((r) => { const q = app.data.fx(r.ccy, m.rc); return { ccy: r.ccy, rate: r.fxRate, fxObsId: q?.obs ? app.data.recordUsed(q.obs) : null }; });
        const data = { navRc: m.navRc, unrealizedRc: m.unrealizedRc, fxEffectRc: m.fx.value, byCurrency: m.nav.byCurrency.map((r) => ({ ccy: r.ccy, nav: r.nav, navRc: r.navRc, cash: r.cash })), marks, fx, unpriced: m.nav.unpriced.length };
        db.run(
          `INSERT INTO snapshots (date, book_id, unit_id, ts, complete, data) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(date, unit_id) DO UPDATE SET ts = excluded.ts, complete = excluded.complete, data = excluded.data`,
          date, book.id, u.id, app.clock.now().toISOString(), m.navComplete && m.unrealizedComplete && m.fx.complete ? 1 : 0, j(data),
        );
        n++;
      }
    }
    return n;
  }

  function navHistory(bookId, scope) {
    const ids = books.scopeUnits(bookId, scope).map((u) => u.id);
    if (!ids.length) return [];
    const rows = db.all(`SELECT date, SUM(json_extract(data, '$.navRc')) AS nav, MIN(complete) AS complete, COUNT(*) AS n FROM snapshots WHERE unit_id IN (${inList(ids)}) GROUP BY date ORDER BY date`, ...ids);
    return rows.map((r) => ({ date: r.date, nav: r.nav, complete: Boolean(r.complete) }));
  }

  return { pnl, openPositions, pending, failed, history, treasury, overview, metrics, snapshot, navHistory, reverseEvent, manualAdjustment, manualCashflow, eventView, balanceSheet, borrowings, navStatus };
}

export { BALANCE_SHEET_ACCOUNTS, AppError };
