// Wires the server client's third interface (the Terminal's own paper ledger) and, in demo mode, the labelled
// fixtures. Called once from app.js after the paper modules exist.
//
// The ledger interface is LOCAL ONLY: it reads this Terminal's database and never calls the gateway. Its one write,
// recording a server-supplied corporate action the user chose to record, goes through core/corpactions.js under an
// idempotency key, so the same event delivered twice (or recorded twice) posts once.

import { createHash } from 'node:crypto';
import { AppError, isZero } from '../core/util.js';
import { SOURCES } from './server-client.js';
import { createServerFixtures } from './server-fixtures.js';

const RECORDABLE = new Set(['cash_dividend', 'split']);

/** Idempotency key of a corporate-action event: the server's event ID when given, else a hash of its terms. */
export function corporateActionKey(instrumentId, ev) {
  if (ev.eventId) return `srv:${ev.eventId}`;
  const terms = [instrumentId, ev.type, ev.exDate, ev.amount ?? '', ev.ratio?.num ?? '', ev.ratio?.den ?? '', ev.currency ?? ''].join('|');
  return `srvh:${createHash('sha256').update(terms).digest('hex').slice(0, 24)}`;
}

export function createLedgerInterface(app) {
  const linkKey = (k) => `server.ca:${k}`;
  const linkOf = (k) => app.data.getSetting(linkKey(k), null);

  /** Paper records for one instrument in one Book: holdings by Account (long and short apart), orders, fills, recorded actions. */
  function instrumentRecords(inst, bookId) {
    const book = bookId ? app.books.getBook(bookId) : null;
    if (bookId && !book) throw new AppError('Book not found.', { status: 404 });
    const unitIds = book ? book.units.map((u) => u.id) : [];
    const owner = new Map(book ? book.units.map((u) => [u.id, u.kind === 'treasury' ? 'Treasury' : u.name]) : []);
    const holdings = [];
    for (const p of unitIds.length ? app.positions.list({ unitIds, instrumentId: inst.id }) : []) {
      if (isZero(p.qty)) continue;
      let h = holdings.find((x) => x.unitId === p.unit_id);
      if (!h) { h = { unitId: p.unit_id, owner: owner.get(p.unit_id), long: 0, short: 0, net: 0, positions: [] }; holdings.push(h); }
      if (p.qty > 0) h.long += p.qty; else h.short += -p.qty;
      h.net += p.qty;
      h.positions.push({ positionId: p.id, qty: p.qty, strategyId: p.strategy_id || null });
    }
    const ph = unitIds.map(() => '?').join(',');
    const orders = unitIds.length ? app.db.all(`SELECT id, strategy_id, unit_id, kind, action, qty, filled_qty, avg_price, order_type, limit_price, status, status_reason, created_at FROM orders WHERE instrument_id = ? AND unit_id IN (${ph}) ORDER BY created_at DESC LIMIT 100`, inst.id, ...unitIds) : [];
    const fills = unitIds.length ? app.db.all(`SELECT f.id, f.order_id, f.ts, f.business_date, f.qty, f.price, f.gross, f.ccy, f.fill_model, f.settle_date, o.unit_id FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.instrument_id = ? AND o.unit_id IN (${ph}) ORDER BY f.ts DESC LIMIT 100`, inst.id, ...unitIds) : [];
    const recorded = app.corpactions.list(inst.id);
    const more = book ? packageRecords(inst, book, unitIds, owner, orders) : { positions: [], strategies: [], allocations: [], history: [], historyMore: false };
    return {
      data: {
        bookId: book?.id ?? null,
        holdings: holdings.map((h) => ({ ...h, owner: h.owner ?? null })),
        orders: orders.map((o) => ({ ...o, owner: owner.get(o.unit_id) ?? null })),
        fills: fills.map((f) => ({ ...f, owner: owner.get(f.unit_id) ?? null })),
        // e3 (My positions and trades): the same valued positions as Accounting, the strategy packages holding the
        // instrument with their hedge and financing legs, hedge allocations, and this instrument's accounting events.
        ...more,
        recordedCorporateActions: recorded,
        note: 'Local paper records of this Terminal. Separate from server market history.',
      },
      asOf: app.clock.now().toISOString(),
      source: SOURCES.ledger,
    };
  }

  /** Paper records around the instrument's positions (e3): valued positions, packages, hedges, financing, history. */
  function packageRecords(inst, book, unitIds, owner, orders) {
    const positions = app.valuation.positionsOf(unitIds, { instrumentId: inst.id }).map((p) => ({
      positionId: p.positionId, unitId: p.unitId, owner: owner.get(p.unitId) ?? null, strategyId: p.strategyId, qty: p.qty, direction: p.direction,
      avgCost: p.avgCost, cost: p.cost, ccy: p.ccy, priceUnits: p.priceUnits, price: p.price, mv: p.mv, unrealized: p.unrealized, missingReason: p.missingReason,
      purpose: p.purpose, pledgedQty: p.pledgedQty, onLoanQty: p.onLoanQty, openedAt: p.openedAt,
      ...(app.hedge?.positionLinks ? app.hedge.positionLinks(p.unitId, p.positionId) : {}),
    }));
    const sids = [...new Set([...positions.map((p) => p.strategyId), ...orders.map((o) => o.strategy_id)].filter(Boolean))].slice(0, 40);
    const strategies = sids.map((sid) => app.packages.getStrategyRow(sid)).filter((s) => s && s.book_id === book.id).map((s) => {
      const legs = app.valuation.positionsOf([s.unit_id], { strategyId: s.id }).map((p) => ({
        positionId: p.positionId, instrument: p.instrument, family: p.family, qty: p.qty, direction: p.direction, purpose: p.purpose, ccy: p.ccy, mv: p.mv,
        financing: p.purpose === 'financing' || ['loan', 'repo', 'secloan'].includes(p.family),
      }));
      const hedgeRequests = app.db.all('SELECT id, status, trigger, scope_type, created_at, updated_at FROM hedge_requests WHERE strategy_id = ? AND book_id = ? ORDER BY created_at DESC LIMIT 20', s.id, book.id);
      return {
        id: s.id, name: s.name, status: s.status, template: s.template, unitId: s.unit_id, owner: owner.get(s.unit_id) ?? null, createdAt: s.created_at, closedAt: s.closed_at,
        legs, hedgeRequests, openHedgeRequest: app.hedge?.openForStrategy ? app.hedge.openForStrategy(s.id) : null,
      };
    });
    const posIds = positions.map((p) => p.positionId);
    const ph = posIds.map(() => '?').join(',');
    const allocations = posIds.length ? app.db.all(`SELECT id, unit_id, hedge_position_id, protected_position_id, strategy_id, units, capacity, basis, request_id, status, reason, created_at, ended_at FROM protection_allocations WHERE book_id = ? AND (protected_position_id IN (${ph}) OR hedge_position_id IN (${ph})) ORDER BY created_at DESC LIMIT 100`, book.id, ...posIds, ...posIds)
      .map((a) => {
        const hp = app.positions.get(a.hedge_position_id), pp = app.positions.get(a.protected_position_id);
        const hi = hp ? app.instruments.get(hp.instrument_id) : null, pi = pp ? app.instruments.get(pp.instrument_id) : null;
        return { ...a, owner: owner.get(a.unit_id) ?? null, hedge: hi ? { id: hi.id, symbol: hi.symbol, name: hi.name } : null, protected: pi ? { id: pi.id, symbol: pi.symbol, name: pi.name } : null, side: posIds.includes(a.protected_position_id) ? 'protects this instrument' : 'this instrument is the hedge' };
      }) : [];
    const h = app.accounting.history(book.id, 'book', { instrumentId: inst.id, limit: 50, includeAccruals: true });
    const history = h.events.map((e) => ({ id: e.id, ts: e.ts, businessDate: e.businessDate, type: e.type, summary: e.summary, owner: e.owner, strategyId: e.strategyId, orderId: e.orderId, cash: e.cash, correctsEventId: e.correctsEventId, correctedBy: e.correctedBy }));
    return { positions, strategies, allocations, history, historyMore: h.more };
  }

  /**
   * Record a server-supplied corporate action in the paper ledger, once. `ev` is the event as the server delivered it.
   * Returns { recorded, duplicate, caId, idempotencyKey, reason? }.
   */
  function recordCorporateAction(instrumentId, ev, source) {
    const inst = app.instruments.require(instrumentId);
    if (!RECORDABLE.has(ev.type)) throw new AppError(`A ${String(ev.type).replace(/_/g, ' ')} is informational: the paper ledger records cash dividends and splits only. Record other effects as a manual adjustment.`);
    const key = corporateActionKey(inst.id, ev);
    return app.db.tx(() => {
      const link = linkOf(key);
      if (link) {
        const ca = app.db.get('SELECT id, status FROM corporate_actions WHERE id = ?', link.caId);
        return { recorded: false, duplicate: true, caId: link.caId, status: ca?.status ?? null, idempotencyKey: key, reason: 'This event has already been recorded; it is not posted again.' };
      }
      const out = app.corpactions.record({
        instrumentId: inst.id, type: ev.type, exDate: ev.exDate, payDate: ev.payDate || ev.exDate, amount: ev.amount, ccy: ev.currency,
        ratioNum: ev.ratio?.num, ratioDen: ev.ratio?.den,
        note: `Recorded from server event ${ev.eventId || '(no event ID)'}; idempotency key ${key}`,
        source: source?.label || 'Shaffer MarketData', providerId: source?.kind || 'shaffer-marketdata',
      });
      app.data.setSetting(linkKey(key), { caId: out.id, at: app.clock.now().toISOString(), eventId: ev.eventId || null, instrumentId: inst.id });
      return { recorded: !out.duplicate, duplicate: Boolean(out.duplicate), caId: out.id, idempotencyKey: key, reason: out.duplicate ? 'An identical corporate action is already in the ledger; it is linked, not posted again.' : null };
    });
  }

  return {
    provider: { source: SOURCES.ledger, run: async (c, p) => instrumentRecords(p.instrument, p.bookId) },
    instrumentRecords, recordCorporateAction, corporateActionKey,
    /** The ledger record linked to a server event, if it has been recorded. */
    recordedFor: (instrumentId, ev) => {
      const key = corporateActionKey(instrumentId, ev);
      const link = linkOf(key);
      if (!link) return null;
      const ca = app.db.get('SELECT id, status FROM corporate_actions WHERE id = ?', link.caId);
      return { caId: link.caId, status: ca?.status ?? null, at: link.at };
    },
  };
}

/** Attach the ledger interface and (demo mode only) the fixtures to app.data.server. */
export function attachServerIntegration(app) {
  const ledger = createLedgerInterface(app);
  const fixtures = app.config.demo ? createServerFixtures(app) : null;
  app.data.server.attach({ ledger: ledger.provider, fixtures });
  app.serverLedger = ledger;
  return { ledger, fixtures };
}
