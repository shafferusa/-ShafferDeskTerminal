// The simulation engine: one cycle ("tick") moves everything that is due.
//
//   1. order matching       working legs against the latest observations
//   2. settlement           cash movements whose settlement date has arrived
//   3. lifecycle tasks      coupons, expirations, maturities, resets, payments, recalls
//   4. corporate actions    dividends and splits whose date has arrived
//   5. end of day           accruals, futures variation margin, collateral marks, day-order expiry,
//                           valuation snapshot (once per business date, after the cutoff)
//   6. hedge requests       the automatic post-trade hedge request for direct Marketplace trades
//
// The engine catches up after downtime: everything due on or before today is processed in date
// order when the Terminal next runs. Work that needs an observation the Terminal does not have is
// left blocked and visible; it is never filled in with a guess.

import { isBusinessDay, onOrBefore, prevBusinessDay } from '../quant/calendar.js';
import { addDays } from '../quant/dates.js';
import { partsInTz } from './clock.js';
import { fmt } from './books.js';
import { markOf } from '../data/observation.js';
import { isZero, money } from './util.js';

const EOD_CUTOFF_MINUTES = 17 * 60; // 17:00 New York

export function createEngine(app) {
  const { db, clock, positions, instruments, books, ledger } = app;
  let timer = null;
  let running = false;
  let lastTick = null;
  let lastError = null;
  const listeners = new Set();

  const getState = (k) => db.get('SELECT value FROM engine_state WHERE key = ?', k)?.value ?? null;
  const setState = (k, v) => db.run('INSERT INTO engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));

  function openPositions() {
    return db.all('SELECT * FROM positions WHERE ABS(qty) > 1e-9').map((r) => positions.get(r.id));
  }

  // ---- lifecycle tasks ---------------------------------------------------------------------------
  async function processTasks(today) {
    const due = app.tasks.due(today);
    if (!due.length) return 0;
    const need = { instruments: new Map(), closes: [], rateCodes: new Set(), rateFrom: addDays(today, -45) };
    for (const t of due) {
      const inst = t.instrument_id ? instruments.get(t.instrument_id) : null;
      if (!inst) continue;
      const plugin = app.products.get(inst.family);
      const pos = t.position_id ? positions.get(t.position_id) : null;
      const n = plugin.dataNeeds ? plugin.dataNeeds(app, { inst, pos, task: t }) : {};
      for (const i of n.instruments || []) need.instruments.set(i.id, i);
      for (const c of n.closes || []) need.closes.push(c);
      for (const r of n.rateCodes || []) need.rateCodes.add(r);
      if (n.rateFrom && n.rateFrom < need.rateFrom) need.rateFrom = n.rateFrom;
      need.instruments.set(inst.id, inst);
    }
    await app.data.refresh({ instruments: [...need.instruments.values()], closes: need.closes, rateCodes: [...need.rateCodes], rateRange: { from: need.rateFrom, to: today } });
    let done = 0;
    for (const t of due) {
      const fresh = app.tasks.get(t.id);
      if (!fresh || !['pending', 'blocked', 'failed'].includes(fresh.status)) continue;
      const inst = fresh.instrument_id ? instruments.get(fresh.instrument_id) : null;
      if (!inst) { app.tasks.fail(fresh.id, 'Instrument no longer exists'); continue; }
      const plugin = app.products.get(inst.family);
      if (!plugin.runTask) { app.tasks.fail(fresh.id, `No lifecycle handler for ${inst.family}`); continue; }
      try {
        db.tx(() => {
          const pos = fresh.position_id ? positions.get(fresh.position_id) : null;
          const book = books.getBook(fresh.book_id), unit = books.getUnit(fresh.unit_id);
          const r = plugin.runTask(app, fresh, { book, unit, inst, pos });
          if (r === 'done' || r?.done) {
            app.tasks.done(fresh.id, r?.eventId);
            done++;
            if (fresh.strategy_id) {
              app.packages.recomputeHolds(fresh.strategy_id);
              app.packages.refreshStrategy(fresh.strategy_id);
              if (app.hedge && ['option.expiry', 'future.expiry', 'forward.maturity', 'swap.maturity', 'cds.maturity', 'bond.maturity'].includes(fresh.type)) {
                const p = fresh.position_id ? positions.get(fresh.position_id) : null;
                if (p && (p.data.purpose === 'hedge' || p.data.purpose === 'primary')) app.hedge.flagReview(fresh.strategy_id, p.data.purpose === 'hedge' ? 'A hedge expired or matured' : 'The primary position expired or matured');
              }
            }
          } else if (r?.blocked) app.tasks.block(fresh.id, r.blocked, r.needs);
          else if (r?.failed) app.tasks.fail(fresh.id, r.failed);
        });
      } catch (err) {
        app.tasks.fail(fresh.id, `Lifecycle error: ${err.message}`);
        lastError = `${fresh.type}: ${err.message}`;
      }
    }
    return done;
  }

  // ---- end of day ----------------------------------------------------------------------------------
  /** The business date whose end-of-day run is due, or null. */
  function eodTarget() {
    const now = clock.now();
    const p = partsInTz(now);
    let target = p.date;
    if (!isBusinessDay(target, 'US') || p.minutes < EOD_CUTOFF_MINUTES) target = prevBusinessDay(target, 'US');
    else target = onOrBefore(target, 'US');
    const last = getState('eod.last');
    return !last || last < target ? target : null;
  }

  async function runEod(date) {
    const open = openPositions();
    const need = { instruments: new Map(), closes: [], rateCodes: new Set(), pairs: new Set(), rateFrom: addDays(date, -45) };
    for (const pos of open) {
      const inst = instruments.get(pos.instrument_id);
      const plugin = app.products.get(inst.family);
      need.instruments.set(inst.id, inst);
      if (inst.underlying_id) { const u = instruments.get(inst.underlying_id); if (u) need.instruments.set(u.id, u); }
      const n = plugin.dataNeeds ? plugin.dataNeeds(app, { inst, pos, date }) : {};
      for (const i of n.instruments || []) need.instruments.set(i.id, i);
      for (const c of n.closes || []) need.closes.push(c);
      for (const r of n.rateCodes || []) need.rateCodes.add(r);
      if (n.rateFrom && n.rateFrom < need.rateFrom) need.rateFrom = n.rateFrom;
      const rc = ledger.rcOf(pos.book_id);
      if (inst.trading_ccy !== rc) need.pairs.add(`${inst.trading_ccy}/${rc}`);
    }
    for (const book of books.listBooks()) {
      for (const ccy of ledger.currencies(book.units.map((u) => u.id))) if (ccy !== book.reporting_ccy) need.pairs.add(`${ccy}/${book.reporting_ccy}`);
    }
    const insts = [...need.instruments.values()];
    await app.data.refresh({ instruments: insts, closes: need.closes, rateCodes: [...need.rateCodes], pairs: [...need.pairs], valuations: insts.filter((i) => ['swap', 'cds', 'forward', 'otcoption', 'bond'].includes(i.family)), rateRange: { from: need.rateFrom, to: date } });

    for (const pos of open) {
      const inst = instruments.get(pos.instrument_id);
      const plugin = app.products.get(inst.family);
      if (!plugin.eod) continue;
      try {
        db.tx(() => plugin.eod(app, { book: books.getBook(pos.book_id), unit: books.getUnit(pos.unit_id), inst, pos: positions.get(pos.id), date }));
      } catch (err) {
        lastError = `End-of-day ${inst.symbol || inst.name}: ${err.message}`;
      }
    }
    db.tx(() => markShortCollateral());
    // OTC collateral: independent amounts trued up and variation margin exchanged, under the terms configured
    // for each position (agreement, position-level terms, or none by explicit choice). Book by Book.
    try {
      await app.data.refresh({ pairs: app.agreements.fxNeeds() });
      const coll = app.agreements.endOfDay(date);
      if (coll.error) lastError = `Collateral valuation: ${coll.error}`;
    } catch (err) {
      lastError = `Collateral valuation: ${err.message}`;
    }
    for (const s of db.all(`SELECT id FROM strategies WHERE status IN ('open','partial','attention','working')`)) db.tx(() => app.packages.recomputeHolds(s.id));
    app.orders.expireDayOrders(date);
    db.tx(() => cashDeficitSweep());
    db.tx(() => app.accounting.snapshot(date));
    setState('eod.last', date);
    return true;
  }

  /**
   * Cash collateral held against borrowed securities that have been sold short is marked to the
   * current value: collateralPct x market value sits in restricted cash. Collateral left over after
   * a short is covered is released.
   */
  function markShortCollateral() {
    const rows = db.all(`SELECT p.id FROM positions p JOIN instruments i ON i.id = p.instrument_id WHERE i.family IN ('equity','bond') AND (p.qty < -1e-9 OR EXISTS (SELECT 1 FROM entries e WHERE e.position_id = p.id AND e.account = 'cash.restricted'))`);
    for (const row of rows) {
      const pos = positions.get(row.id);
      const inst = instruments.get(pos.instrument_id);
      const book = books.getBook(pos.book_id), unit = books.getUnit(pos.unit_id);
      const ccy = inst.trading_ccy;
      const held = ledger.positionBalance(pos.id, 'cash.restricted', ccy);
      const pending = money(db.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM settlements WHERE position_id = ? AND ccy = ? AND status = 'pending' AND amount > 0 AND accounts LIKE '["cash.restricted"%'`, pos.id, ccy).s, ccy);
      const owedFromRestricted = money(-db.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM settlements WHERE position_id = ? AND ccy = ? AND status IN ('pending','failed') AND amount < 0 AND accounts LIKE '["cash.restricted"%'`, pos.id, ccy).s, ccy);
      let target = 0;
      if (pos.qty < 0) {
        const obs = app.data.price(inst.id);
        const px = markOf(obs);
        if (px === null) continue; // no price: leave the collateral as it is rather than guess
        target = money(book.settings.short.collateralPct * Math.abs(pos.qty) * px * inst.multiplier * (inst.family === 'bond' ? (inst.terms.factor ?? 1) : 1), ccy);
      }
      // Restricted cash already earmarked to pay for a cover is not surplus.
      let delta = money(target + owedFromRestricted - held - pending, ccy);
      if (Math.abs(delta) < 0.01) continue;
      if (delta > 0) {
        const cash = ledger.balance(unit.id, 'cash', ccy);
        if (cash < delta) {
          app.alerts.raise({ bookId: book.id, unitId: unit.id, level: 'error', code: 'collateral.shortfall', refType: 'position', refId: pos.id, message: `Collateral shortfall on the short in ${inst.symbol || inst.name}: ${fmt(delta, ccy)} more is required and ${unit.name} has ${fmt(Math.max(cash, 0), ccy)} of settled cash.` });
          delta = money(Math.max(cash, 0), ccy);
          if (delta <= 0) continue;
        } else app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'collateral.shortfall' });
      } else if (-delta > held) delta = -held;
      if (Math.abs(delta) < 0.01) continue;
      ledger.post({
        bookId: book.id, unitId: unit.id, type: 'collateral.mark', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
        summary: `Short collateral on ${inst.symbol || inst.name} marked to market: ${delta > 0 ? 'posted' : 'released'} ${fmt(Math.abs(delta), ccy)}`,
        data: { target, held, pending },
        entries: [{ account: 'cash.restricted', ccy, amount: delta, positionId: pos.id }, { account: 'cash', ccy, amount: -delta, positionId: pos.id }],
      });
    }
  }

  /** Any unit whose settled cash has gone negative is flagged; it is never silently funded. */
  function cashDeficitSweep() {
    for (const row of db.all(`SELECT unit_id, book_id, ccy, SUM(amount) AS bal FROM entries WHERE account = 'cash' GROUP BY unit_id, ccy`)) {
      const ref = `${row.unit_id}|${row.ccy}`;
      if (row.bal < -0.005) {
        const unit = books.getUnit(row.unit_id);
        app.alerts.raise({ bookId: row.book_id, unitId: row.unit_id, level: 'error', code: 'margin.deficit', refType: 'unit-ccy', refId: ref, message: `${unit.name} has a ${row.ccy} cash deficit of ${fmt(-row.bal, row.ccy)}. Fund it from Treasury, convert currency or arrange borrowing.` });
      } else app.alerts.resolve({ refType: 'unit-ccy', refId: ref, code: 'margin.deficit' });
    }
  }

  // ---- the cycle ---------------------------------------------------------------------------------------
  async function tick() {
    if (running) return { skipped: true };
    running = true;
    const summary = { matched: 0, settled: 0, tasks: 0, corporateActions: 0, eod: null, hedgeRequests: 0, hedgeRefreshed: 0 };
    try {
      const today = clock.today();
      summary.matched = await app.packages.runMatching();
      summary.settled = app.settle.settleDue(today);
      // Lifecycle work and corporate actions are processed in date order, so a catch-up after
      // downtime applies them in the sequence they fell due.
      await app.corpactions.pull(today);
      const dates = new Set([today]);
      for (const r of db.all(`SELECT DISTINCT due_date AS d FROM tasks WHERE status IN ('pending','blocked','failed') AND due_date <= ?`, today)) dates.add(r.d);
      for (const r of db.all(`SELECT DISTINCT CASE WHEN type = 'split' THEN ex_date ELSE COALESCE(pay_date, ex_date) END AS d FROM corporate_actions WHERE status = 'pending'`)) if (r.d <= today) dates.add(r.d);
      for (const d of [...dates].sort()) {
        summary.tasks += await processTasks(d);
        summary.corporateActions += app.corpactions.process(d);
      }
      const target = eodTarget();
      if (target) {
        await runEod(target);
        summary.eod = target;
        summary.settled += app.settle.settleDue(today);
      }
      // A collateral call that failed for want of cash is tried again each cycle. A retry delivers only what is still missing.
      summary.collateral = app.agreements.retryFailed();
      if (summary.tasks || summary.corporateActions) summary.matched += await app.packages.runMatching();
      summary.hedgeRequests = (await app.hedge.processQueue()).length;
      // Requests that were waiting for Shaffer Hedge are refreshed once it can answer. Never executed here.
      summary.hedgeRefreshed = (await app.hedge.refreshWaiting()).length;
      lastTick = clock.now().toISOString();
      if (summary.matched || summary.settled || summary.tasks || summary.corporateActions || summary.eod || summary.collateral || summary.hedgeRequests || summary.hedgeRefreshed) emit({ type: 'changed', summary });
      return summary;
    } catch (err) {
      lastError = String(err.stack || err.message || err);
      console.error('[engine]', lastError);
      return { error: lastError };
    } finally {
      running = false;
    }
  }

  function emit(msg) {
    for (const fn of listeners) {
      try { fn(msg); } catch { /* a closed stream */ }
    }
  }

  function start() {
    if (timer) return;
    const loop = async () => {
      await tick();
      timer = setTimeout(loop, app.data.getRefresh().engineTickMs);
      timer.unref?.();
    };
    timer = setTimeout(loop, 50);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    tick, start, stop, runEod, processTasks, markShortCollateral, eodTarget,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit,
    status: () => ({ running: Boolean(timer), busy: running, lastTick, lastError, lastEndOfDay: getState('eod.last'), nextEndOfDay: eodTarget(), tickMs: app.data.getRefresh().engineTickMs }),
    _unused: { isZero },
  };
}
