// Valuation of positions and units.
//
// Every valuation names the observation it used. A position with no price is reported as
// unpriced: its market value and unrealized P&L are missing (null), never zero, and totals that
// depend on it are flagged incomplete. Cash, receivables, payables, loans and accruals are always
// known because they live in the ledger.

import { markOf } from '../data/observation.js';
import { MARKET_VIEWS } from './catalog.js';
import { BALANCE_SHEET_ACCOUNTS } from './ledger.js';
import { isZero, money, round } from './util.js';

export function createValuation(app) {
  const { positions, ledger } = app;

  const lite = (inst) => inst && { id: inst.id, symbol: inst.symbol, name: inst.name, family: inst.family, productId: inst.product_id, marketView: inst.market_view, ccy: inst.trading_ccy, multiplier: inst.multiplier, underlyingId: inst.underlying_id, terms: summariseTerms(inst) };

  function summariseTerms(inst) {
    const t = inst.terms || {};
    const out = {};
    for (const k of ['right', 'strike', 'expiration', 'maturity', 'couponRate', 'couponType', 'valueDate', 'forwardType', 'effective', 'root', 'referenceEntity', 'loanType', 'repoType', 'endDate', 'feeRate', 'rate', 'rateType', 'referenceRate', 'spread']) if (t[k] !== undefined && t[k] !== null) out[k] = t[k];
    if (t.deliverable) out.deliverableUnits = t.deliverable.units;
    return out;
  }

  /** Value one position. */
  function position(pos, { rc } = {}) {
    const inst = app.instruments.get(pos.instrument_id);
    const plugin = app.products.get(inst.family);
    const obs = app.data.price(inst.id);
    const mark = markOf(obs);
    const v = plugin.value(app, inst, pos, obs, mark) || {};
    const ccy = inst.trading_ccy;
    const reportingCcy = rc || ledger.rcOf(pos.book_id);
    const fx = app.data.fx(ccy, reportingCcy);
    const toRc = (x) => (x === null || x === undefined || !fx ? null : money(x * fx.rate, reportingCcy));
    const denom = pos.qty * inst.multiplier;
    const avgCost = inst.family === 'future' ? pos.data.mark ?? null
      : inst.family === 'forward' ? pos.data.avgStrike ?? null
        : v.ledgerCarried ? null : isZero(denom) ? null : round(pos.cost / denom, 6);
    const missing = !v.ledgerCarried && (v.mv === null || v.mv === undefined);
    return {
      positionId: pos.id, bookId: pos.book_id, unitId: pos.unit_id, strategyId: pos.strategy_id || null,
      instrument: lite(inst), family: inst.family, ccy,
      qty: pos.qty, direction: directionOf(inst, pos), avgCost, cost: v.ledgerCarried ? null : pos.cost,
      price: v.price ?? null, priceObs: obs ? app.data.present(obs) : null, priceUnits: plugin.priceUnits ? plugin.priceUnits(inst) : null,
      mv: v.mv ?? null, unrealized: v.unrealized ?? null, accrued: v.accrued ?? 0, notional: v.notional ?? null, exposure: v.exposure ?? null,
      carrying: v.carrying ?? null, ledgerCarried: Boolean(v.ledgerCarried), referencePrice: v.referencePrice ?? null,
      marginPosted: v.marginPosted ?? ledger.positionBalance(pos.id, 'cash.margin', ccy),
      restrictedCash: ledger.positionBalance(pos.id, 'cash.restricted', ccy),
      collateral: v.collateral ?? null, recall: v.recall ?? null, valuationNote: v.valuationNote || null,
      pledgedQty: pos.pledged_qty, onLoanQty: pos.onloan_qty, purpose: pos.data.purpose || 'primary', hedgeLinkId: pos.data.hedgeLinkId || null,
      mvRc: toRc(v.mv), unrealizedRc: toRc(v.unrealized), accruedRc: toRc(v.accrued ?? 0), notionalRc: toRc(v.notional),
      fxRate: fx ? fx.rate : null, fxObs: fx?.obs ? app.data.present(fx.obs) : null, fxMissing: !fx,
      missing, missingReason: missing ? (app.data.marketConnected() ? 'No price available' : app.data.describe().awaitingMessage) : null,
      openedAt: pos.opened_at, data: pos.data,
    };
  }

  function directionOf(inst, pos) {
    if (isZero(pos.qty)) return 'flat';
    switch (inst.family) {
      case 'loan': return pos.qty < 0 ? 'borrowed' : 'lent';
      case 'repo': return pos.qty < 0 ? 'repo (cash borrowed)' : 'reverse repo (cash lent)';
      case 'secloan': return pos.qty > 0 ? 'securities borrowed' : 'securities lent';
      case 'cds': return pos.qty > 0 ? 'protection bought' : 'protection sold';
      case 'swap': return pos.qty > 0 ? 'as written' : 'opposite side';
      default: return pos.qty > 0 ? 'long' : 'short';
    }
  }

  /** All open positions of a set of units, valued. */
  function positionsOf(unitIds, filter = {}) {
    return positions.list({ unitIds, ...filter }).filter((p) => !isZero(p.qty)).map((p) => position(p));
  }

  /**
   * Net asset value of a set of units in the reporting currency, with the pieces that make it up.
   * complete=false when an FX rate or a price was missing; the missing items are listed.
   */
  function nav(bookId, unitIds) {
    const rc = ledger.rcOf(bookId);
    const bal = ledger.balances(unitIds).filter((b) => BALANCE_SHEET_ACCOUNTS.includes(b.account));
    const byCcy = new Map();
    const add = (ccy, key, x) => {
      if (!byCcy.has(ccy)) byCcy.set(ccy, { ccy, ledger: 0, unrealized: 0, cash: 0, restricted: 0, margin: 0, receivable: 0, payable: 0, positionsAtCost: 0, loansLent: 0, loansBorrowed: 0, accruedAsset: 0, accruedLiab: 0, collateralReceived: 0 });
      byCcy.get(ccy)[key] += x;
    };
    const MAP = { cash: 'cash', 'cash.restricted': 'restricted', 'cash.margin': 'margin', 'recv.settle': 'receivable', 'pay.settle': 'payable', pos: 'positionsAtCost', 'loan.asset': 'loansLent', 'loan.liab': 'loansBorrowed', 'accrued.asset': 'accruedAsset', 'accrued.liab': 'accruedLiab', 'coll.received': 'collateralReceived' };
    for (const b of bal) {
      add(b.ccy, 'ledger', b.amount);
      add(b.ccy, MAP[b.account], b.amount);
    }
    const valued = positionsOf(unitIds);
    const unpriced = [];
    for (const p of valued) {
      if (p.ledgerCarried) continue;
      if (p.missing) { unpriced.push({ positionId: p.positionId, instrument: p.instrument, qty: p.qty, cost: p.cost, ccy: p.ccy }); continue; }
      add(p.ccy, 'unrealized', p.unrealized || 0);
    }
    let navRc = 0, complete = true;
    const fxMissing = [];
    const rows = [];
    for (const r of byCcy.values()) {
      const local = money(r.ledger + r.unrealized, r.ccy);
      const fx = app.data.fx(r.ccy, rc);
      const rcValue = fx ? money(local * fx.rate, rc) : null;
      if (!fx && Math.abs(local) > 0.004) { complete = false; fxMissing.push(r.ccy); } else if (fx) navRc += rcValue;
      rows.push({ ...roundAll(r), nav: local, navRc: rcValue, fxRate: fx ? fx.rate : null, fxObs: fx?.obs ? app.data.present(fx.obs) : null });
    }
    if (unpriced.length) complete = false;
    return { reportingCcy: rc, nav: money(navRc, rc), complete, byCurrency: rows.sort((a, b) => (a.ccy === rc ? -1 : b.ccy === rc ? 1 : a.ccy < b.ccy ? -1 : 1)), unpriced, fxMissing, positions: valued };
  }

  function roundAll(r) {
    const out = { ccy: r.ccy };
    for (const [k, v] of Object.entries(r)) if (k !== 'ccy') out[k] = money(v, r.ccy);
    return out;
  }

  /** Market-view of an instrument's listing geography, for exposure tables. */
  const viewLabel = (id) => MARKET_VIEWS[id]?.label || id;

  return { position, positionsOf, nav, lite, viewLabel };
}
