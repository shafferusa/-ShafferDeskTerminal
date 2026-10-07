// Read-only integrity check of one Book's paper accounts.
//
// Nothing here writes. It re-reads the stored events, entries, fills, settlements, positions and
// tasks of one Book and reports whether they still agree with each other and with the accounting
// views built from them. The test matrix (test/matrix) calls it after every step of every
// scenario; `GET /api/books/:id/integrity` returns the same report.
//
// What is checked, and the keys that define a duplicate:
//
//   book-isolation         every entry of the Book's events belongs to a Treasury or Account of this Book
//   events-balanced        each event's entries sum to zero per owner and currency
//   trial-balance          per owner and currency, assets + liabilities + equity + P&L + clearing = 0
//   net-assets             per owner: assets - liabilities = net assets on the balance sheet, and the same figure
//                          rebuilt here from raw ledger balances plus unrealized P&L
//   book-equals-owners     whole-Book balance sheet = the owners' own balance sheets added up, line by line;
//                          funding between Treasury and Accounts nets to zero in every currency
//   settlements-ledger     unsettled trades in the settlement queue = the receivable/payable ledger balances
//   positions-ledger       a securities position's cost = its `pos` ledger balance; its quantity = its last
//                          recorded quantity change
//   holdings-gross         gross holdings (long, short, net) = the positions they summarise
//   no-duplicate-fills     fills of an order add up to its filled quantity and never exceed the order;
//                          one ledger event per fill (key: fills.event_id) and one fill per trade event
//   no-duplicate-settlements  one settlement per (fill, kind, currency, direction); one ledger event per settled
//                          settlement and one settlement per settlement event
//   no-duplicate-payments  one dividend event per (corporate action, position); one interest or fee payment
//                          per (position, business date); one completed lifecycle task per
//                          (position, type, due date, key)
//   no-duplicate-accruals  the accrued balance in the ledger equals the position's own accrual counter, and
//                          every accrual event starts from the ledger balance left by the one before it
//   no-duplicate-postings  one order per (submission, leg); one strategy per confirmation token; one
//                          post-trade hedge request per strategy; one open hold per (reference, kind, currency)
//
// A duplicate accrual of the same day cannot be recognised from its key alone (two one-day accruals at
// the same price look identical), so the totals are also checked against hand-calculated figures in
// the scenarios themselves.

import { ACCOUNTS, BALANCE_SHEET_ACCOUNTS } from './ledger.js';
import { ccyDecimals, isZero, money } from './util.js';
import { pj } from '../db/db.js';

const SECURITY_FAMILIES = new Set(['equity', 'fund', 'spot', 'crypto', 'manual']);
const ACCRUAL_FAMILIES = new Set(['loan', 'repo', 'secloan']);

export function createIntegrity(app) {
  const { db, books, ledger, positions, instruments } = app;
  const tol = (ccy) => 0.5 * 10 ** -ccyDecimals(ccy) + 1e-9;
  const qs = (ids) => ids.map(() => '?').join(',');

  function check(bookId) {
    const book = books.requireBook(bookId);
    const units = book.units;
    const ids = units.map((u) => u.id);
    const name = new Map(units.map((u) => [u.id, u.kind === 'treasury' ? 'Treasury' : u.name]));
    const rc = book.reporting_ccy;
    const checks = [];
    const add = (id, label, problems) => checks.push({ id, label, ok: problems.length === 0, problems: problems.slice(0, 25), more: Math.max(0, problems.length - 25) });

    // ---- book isolation ------------------------------------------------------------------------------
    {
      const p = [];
      for (const r of db.all(`SELECT en.id, en.event_id, en.unit_id, en.book_id FROM entries en JOIN events e ON e.id = en.event_id WHERE e.book_id = ? AND (en.book_id <> e.book_id OR en.unit_id NOT IN (${qs(ids)}))`, bookId, ...ids)) {
        p.push(`Entry ${r.id} of event ${r.event_id} belongs to ${r.unit_id} in Book ${r.book_id}, outside this Book.`);
      }
      for (const r of db.all(`SELECT en.id, en.event_id FROM entries en JOIN events e ON e.id = en.event_id WHERE en.unit_id IN (${qs(ids)}) AND e.book_id <> ?`, ...ids, bookId)) {
        p.push(`Entry ${r.id} posts to this Book from event ${r.event_id} of another Book.`);
      }
      for (const r of db.all(`SELECT id, unit_id FROM positions WHERE book_id = ? AND unit_id NOT IN (${qs(ids)})`, bookId, ...ids)) p.push(`Position ${r.id} is held by ${r.unit_id}, which is not in this Book.`);
      add('book-isolation', 'Every entry and position belongs to this Book', p);
    }

    // ---- every event balances -----------------------------------------------------------------------------
    {
      const p = [];
      for (const r of db.all('SELECT event_id, unit_id, ccy, SUM(amount) AS s FROM entries WHERE book_id = ? GROUP BY event_id, unit_id, ccy', bookId)) {
        if (Math.abs(r.s) > tol(r.ccy)) p.push(`Event ${r.event_id} is out of balance for ${name.get(r.unit_id) || r.unit_id} in ${r.ccy} by ${money(r.s, r.ccy)}.`);
      }
      add('events-balanced', 'Every ledger event balances per owner and currency', p);
    }

    // ---- trial balance --------------------------------------------------------------------------------------
    const trialBalance = {};
    const raw = new Map(); // unit|ccy -> { assets, liabilities, other }
    {
      const p = [];
      for (const r of db.all(`SELECT unit_id, account, ccy, SUM(amount) AS s FROM entries WHERE book_id = ? GROUP BY unit_id, account, ccy`, bookId)) {
        const amount = money(r.s, r.ccy);
        if (amount !== 0) ((trialBalance[r.unit_id] ||= {})[r.account] ||= {})[r.ccy] = amount;
        const k = `${r.unit_id}|${r.ccy}`;
        const t = raw.get(k) || { unit: r.unit_id, ccy: r.ccy, bs: 0, other: 0 };
        if (!ACCOUNTS[r.account]) p.push(`Unknown ledger account "${r.account}" in ${name.get(r.unit_id) || r.unit_id}.`);
        else if (BALANCE_SHEET_ACCOUNTS.includes(r.account)) t.bs += r.s; else t.other += r.s;
        raw.set(k, t);
      }
      for (const t of raw.values()) {
        if (Math.abs(t.bs + t.other) > tol(t.ccy)) p.push(`${name.get(t.unit)}: assets and liabilities (${money(t.bs, t.ccy)} ${t.ccy}) do not equal capital, funding and results (${money(-t.other, t.ccy)} ${t.ccy}).`);
      }
      add('trial-balance', 'Assets less liabilities equal capital, internal funding and results, per owner and currency', p);
    }

    // ---- net assets per owner, and the Book against its owners ------------------------------------------------
    const cellMap = (cell) => new Map((cell?.byCurrency || []).map((x) => [x.ccy, x.amount]));
    const sameMap = (a, b, n = 1) => {
      const out = [];
      for (const ccy of new Set([...a.keys(), ...b.keys()])) if (Math.abs((a.get(ccy) || 0) - (b.get(ccy) || 0)) > n * tol(ccy) * 2) out.push(`${ccy}: ${money(a.get(ccy) || 0, ccy)} against ${money(b.get(ccy) || 0, ccy)}`);
      return out;
    };
    const own = new Map(); // unit id -> its own balance sheet
    {
      const p = [];
      for (const u of units) {
        const bs = app.accounting.balanceSheet(bookId, u.id);
        own.set(u.id, bs);
        const a = cellMap(bs.assets.cells[u.id]), l = cellMap(bs.liabilities.cells[u.id]), n = cellMap(bs.netAssets.cells[u.id]);
        const diff = new Map();
        for (const [ccy, v] of a) diff.set(ccy, v);
        for (const [ccy, v] of l) diff.set(ccy, (diff.get(ccy) || 0) - v);
        for (const d of sameMap(diff, n)) p.push(`${name.get(u.id)}: assets less liabilities do not equal net assets (${d}).`);
        // The same figure rebuilt from raw ledger balances plus unrealized P&L on priced positions.
        const rebuilt = new Map();
        for (const t of raw.values()) if (t.unit === u.id) rebuilt.set(t.ccy, (rebuilt.get(t.ccy) || 0) + t.bs);
        for (const r of app.valuation.nav(bookId, [u.id]).byCurrency) if (r.unrealized) rebuilt.set(r.ccy, (rebuilt.get(r.ccy) || 0) + r.unrealized);
        for (const [ccy, v] of rebuilt) if (Math.abs(v) <= tol(ccy)) rebuilt.delete(ccy);
        for (const d of sameMap(rebuilt, n)) p.push(`${name.get(u.id)}: net assets on the balance sheet do not equal ledger balances plus unrealized P&L (${d}).`);
        if (bs.netAssets.total.complete && bs.nav.complete && Math.abs(bs.netAssets.total.rc - bs.nav.value) > 0.011 * Math.max(1, n.size)) p.push(`${name.get(u.id)}: net assets ${bs.netAssets.total.rc} ${rc} differ from the net asset value ${bs.nav.value} ${rc}.`);
      }
      add('net-assets', 'Assets less liabilities equal net assets for every owner', p);
    }
    {
      const p = [];
      const whole = app.accounting.balanceSheet(bookId, 'book');
      for (const line of whole.lines) {
        const sum = new Map();
        for (const u of units) {
          const mine = own.get(u.id).lines.find((l) => l.key === line.key);
          for (const [ccy, v] of cellMap(mine?.cells[u.id])) sum.set(ccy, (sum.get(ccy) || 0) + v);
        }
        for (const d of sameMap(sum, cellMap(line.total), units.length)) p.push(`Book line "${line.label}" is not the sum of its owners (${d}).`);
      }
      const net = new Map();
      for (const u of units) for (const [ccy, v] of cellMap(own.get(u.id).netAssets.cells[u.id])) net.set(ccy, (net.get(ccy) || 0) + v);
      for (const d of sameMap(net, cellMap(whole.netAssets.total), units.length)) p.push(`Book net assets are not the sum of the owners' net assets (${d}).`);
      for (const r of db.all(`SELECT ccy, SUM(amount) AS s FROM entries WHERE book_id = ? AND account = 'internal' GROUP BY ccy`, bookId)) {
        if (Math.abs(r.s) > tol(r.ccy)) p.push(`Funding between Treasury and Accounts does not net to zero in ${r.ccy}: ${money(r.s, r.ccy)} is left.`);
      }
      const internal = whole.representedBy.find((x) => x.key === 'internal');
      if (internal?.residual?.length) p.push(`The Book balance sheet reports an internal funding residual: ${internal.residual.map((x) => `${x.amount} ${x.ccy}`).join(', ')}.`);
      // External borrowings: each record once, owned by one unit of this Book.
      const reg = app.accounting.borrowings(bookId, 'book');
      const seen = new Set();
      for (const b of reg) { if (seen.has(b.id)) p.push(`Borrowing ${b.id} is listed twice in the Book register.`); seen.add(b.id); }
      const perOwner = units.flatMap((u) => app.accounting.borrowings(bookId, u.id));
      if (perOwner.length !== reg.length) p.push(`The Book register lists ${reg.length} borrowings; the owners' registers list ${perOwner.length} in total.`);
      add('book-equals-owners', 'The Book equals its owners after internal funding is eliminated', p);
    }

    // ---- settlement queue against the ledger ----------------------------------------------------------------------
    {
      const p = [];
      const queue = new Map();
      for (const r of db.all(`SELECT unit_id, ccy, SUM(amount) AS s FROM settlements WHERE book_id = ? AND status IN ('pending','failed') GROUP BY unit_id, ccy`, bookId)) queue.set(`${r.unit_id}|${r.ccy}`, r.s);
      const led = new Map();
      for (const r of db.all(`SELECT unit_id, ccy, SUM(amount) AS s FROM entries WHERE book_id = ? AND account IN ('recv.settle','pay.settle') GROUP BY unit_id, ccy`, bookId)) led.set(`${r.unit_id}|${r.ccy}`, r.s);
      for (const k of new Set([...queue.keys(), ...led.keys()])) {
        const [u, ccy] = k.split('|');
        if (Math.abs((queue.get(k) || 0) - (led.get(k) || 0)) > tol(ccy)) p.push(`${name.get(u)}: ${money(queue.get(k) || 0, ccy)} ${ccy} awaits settlement in the queue, but the ledger carries ${money(led.get(k) || 0, ccy)} ${ccy} unsettled.`);
      }
      add('settlements-ledger', 'Pending settlements equal the unsettled receivable and payable balances', p);
    }

    // ---- positions against the ledger; gross holdings ----------------------------------------------------------------
    {
      const p = [];
      const all = db.all('SELECT * FROM positions WHERE book_id = ?', bookId).map((r) => positions.get(r.id));
      for (const pos of all) {
        const inst = instruments.get(pos.instrument_id);
        if (!inst) { p.push(`Position ${pos.id} refers to an instrument that is not in the registry.`); continue; }
        const ccy = inst.trading_ccy;
        if (SECURITY_FAMILIES.has(inst.family)) {
          const led = ledger.positionBalance(pos.id, 'pos', ccy);
          if (Math.abs(led - pos.cost) > tol(ccy)) p.push(`${inst.symbol || inst.name} (${name.get(pos.unit_id)}): position cost ${money(pos.cost, ccy)} differs from its ledger balance ${led} ${ccy}.`);
        }
        const last = db.get('SELECT qty FROM position_history WHERE position_id = ? ORDER BY id DESC LIMIT 1', pos.id);
        if ((last ? last.qty : 0) !== pos.qty && Math.abs((last ? last.qty : 0) - pos.qty) > 1e-8) p.push(`${inst.symbol || inst.name} (${name.get(pos.unit_id)}): quantity ${pos.qty} differs from its last recorded change ${last ? last.qty : 0}.`);
      }
      add('positions-ledger', 'Position cost and quantity agree with the ledger and the quantity log', p);

      const g = [];
      const view = app.accounting.openPositions(bookId, 'book');
      const direct = new Map();
      for (const pos of all) {
        if (isZero(pos.qty)) continue;
        const inst = instruments.get(pos.instrument_id);
        if (!inst || ACCRUAL_FAMILIES.has(inst.family)) continue;
        const d = direct.get(inst.id) || { long: 0, short: 0, net: 0 };
        if (pos.qty > 0) d.long += pos.qty; else d.short -= pos.qty;
        d.net += pos.qty;
        direct.set(inst.id, d);
      }
      for (const h of view.holdings) {
        const d = direct.get(h.instrument.id) || { long: 0, short: 0, net: 0 };
        const label = h.instrument.symbol || h.instrument.name;
        if (Math.abs(h.long - h.short - h.net) > 1e-8) g.push(`${label}: long ${h.long} less short ${h.short} is not the net ${h.net}.`);
        if (Math.abs(h.long - d.long) > 1e-8 || Math.abs(h.short - d.short) > 1e-8) g.push(`${label}: holdings show long ${h.long} and short ${h.short}; the positions add up to long ${d.long} and short ${d.short}.`);
        const o = h.owners.reduce((a, x) => ({ long: a.long + x.long, short: a.short + x.short }), { long: 0, short: 0 });
        if (Math.abs(o.long - h.long) > 1e-8 || Math.abs(o.short - h.short) > 1e-8) g.push(`${label}: the owners' holdings do not add up to the total.`);
        direct.delete(h.instrument.id);
      }
      for (const id of direct.keys()) g.push(`${instruments.get(id)?.symbol || id}: held, but missing from the holdings summary.`);
      add('holdings-gross', 'Gross holdings (long, short, net) reconcile to the positions', g);
    }

    // ---- duplicates ---------------------------------------------------------------------------------------------------------
    {
      const p = [];
      for (const o of db.all(`SELECT o.id, o.qty, o.filled_qty, COALESCE(SUM(f.qty), 0) AS s FROM orders o LEFT JOIN fills f ON f.order_id = o.id WHERE o.book_id = ? GROUP BY o.id`, bookId)) {
        if (Math.abs(o.s - o.filled_qty) > 1e-8) p.push(`Order ${o.id}: fills add up to ${o.s}, but the order records ${o.filled_qty} filled.`);
        if (o.s > o.qty + 1e-8) p.push(`Order ${o.id}: filled ${o.s}, more than its quantity ${o.qty}.`);
      }
      for (const r of db.all(`SELECT f.event_id, COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ? AND f.event_id IS NOT NULL GROUP BY f.event_id HAVING COUNT(*) > 1`, bookId)) p.push(`Ledger event ${r.event_id} is claimed by ${r.n} fills.`);
      for (const r of db.all(`SELECT e.id FROM events e WHERE e.book_id = ? AND e.type = 'trade.fill' AND e.order_id IS NOT NULL AND (SELECT COUNT(*) FROM fills f WHERE f.event_id = e.id) <> 1`, bookId)) p.push(`Trade event ${r.id} does not belong to exactly one fill.`);
      add('no-duplicate-fills', 'No fill is recorded twice', p);
    }
    {
      const p = [];
      for (const r of db.all(`SELECT fill_id, kind, ccy, (amount > 0) AS dir, COUNT(*) AS n FROM settlements WHERE book_id = ? AND fill_id IS NOT NULL GROUP BY fill_id, kind, ccy, (amount > 0) HAVING COUNT(*) > 1`, bookId)) p.push(`Fill ${r.fill_id} has ${r.n} ${r.kind} settlements in ${r.ccy} in the same direction.`);
      for (const r of db.all(`SELECT event_id, COUNT(*) AS n FROM settlements WHERE book_id = ? AND event_id IS NOT NULL GROUP BY event_id HAVING COUNT(*) > 1`, bookId)) p.push(`Settlement event ${r.event_id} is claimed by ${r.n} settlements.`);
      for (const r of db.all(`SELECT id FROM settlements WHERE book_id = ? AND status = 'settled' AND event_id IS NULL`, bookId)) p.push(`Settlement ${r.id} is marked settled without a ledger event.`);
      for (const r of db.all(`SELECT e.id FROM events e WHERE e.book_id = ? AND e.type IN ('settlement.pay','settlement.receive') AND (SELECT COUNT(*) FROM settlements s WHERE s.event_id = e.id) <> 1`, bookId)) p.push(`Settlement event ${r.id} does not belong to exactly one settlement.`);
      add('no-duplicate-settlements', 'No settlement is paid or received twice', p);
    }
    {
      const p = [];
      const seen = new Map();
      for (const e of db.all(`SELECT id, type, position_id, data FROM events WHERE book_id = ? AND type IN ('dividend','dividend.compensation')`, bookId)) {
        const k = `${pj(e.data, {}).corporateActionId}|${e.position_id}`;
        if (seen.has(k)) p.push(`Events ${seen.get(k)} and ${e.id} both pay the same corporate action on the same position.`);
        seen.set(k, e.id);
      }
      for (const r of db.all(`SELECT position_id, business_date, COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'interest.payment' AND position_id IS NOT NULL GROUP BY position_id, business_date HAVING COUNT(*) > 1`, bookId)) p.push(`Position ${r.position_id} has ${r.n} interest or fee payments dated ${r.business_date}.`);
      for (const r of db.all(`SELECT position_id, type, due_date, COALESCE(json_extract(data, '$.key'), '') AS k, COUNT(*) AS n FROM tasks WHERE book_id = ? AND status = 'done' GROUP BY position_id, type, due_date, k HAVING COUNT(*) > 1`, bookId)) p.push(`Lifecycle item ${r.type} due ${r.due_date} ran ${r.n} times for position ${r.position_id}.`);
      add('no-duplicate-payments', 'No dividend, interest, fee or lifecycle payment is made twice', p);
    }
    {
      const p = [];
      for (const pos of db.all('SELECT * FROM positions WHERE book_id = ?', bookId).map((r) => positions.get(r.id))) {
        const inst = instruments.get(pos.instrument_id);
        if (!inst || !ACCRUAL_FAMILIES.has(inst.family)) continue;
        const ccy = inst.trading_ccy;
        const borrowed = inst.family === 'secloan' ? (pos.data.side ? pos.data.side === 'borrow' : pos.qty > 0) : pos.qty < 0;
        const account = borrowed ? 'accrued.liab' : 'accrued.asset';
        const led = Math.abs(ledger.positionBalance(pos.id, account, ccy));
        const counter = money(Math.abs(pos.data.accrued || 0), ccy);
        if (!isZero(pos.qty) && Math.abs(led - counter) > tol(ccy)) p.push(`${inst.name}: ${led} ${ccy} is accrued in the ledger, but the position's own accrual stands at ${counter} ${ccy}.`);
        let running = 0;
        for (const e of db.all(`SELECT e.id, e.type, e.data, (SELECT COALESCE(SUM(amount), 0) FROM entries x WHERE x.event_id = e.id AND x.position_id = ? AND x.account = ?) AS d FROM events e WHERE e.position_id = ? ORDER BY e.id`, pos.id, account, pos.id)) {
          if (e.type.startsWith('accrual')) {
            const data = pj(e.data, {});
            if (data.account === account && typeof data.previous === 'number' && Math.abs(data.previous - money(running, ccy)) > tol(ccy)) p.push(`${inst.name}: accrual event ${e.id} started from ${data.previous} ${ccy}, but the ledger stood at ${money(running, ccy)} ${ccy}.`);
          }
          running += e.d;
        }
      }
      add('no-duplicate-accruals', 'Accrued interest and fees in the ledger equal each position\'s own accrual', p);
    }
    {
      const p = [];
      for (const r of db.all(`SELECT submission, leg_no, COUNT(*) AS n FROM orders WHERE book_id = ? GROUP BY submission, leg_no HAVING COUNT(*) > 1`, bookId)) p.push(`Leg ${r.leg_no} of submission ${r.submission} exists ${r.n} times.`);
      for (const r of db.all(`SELECT client_token, COUNT(*) AS n FROM strategies WHERE book_id = ? AND client_token IS NOT NULL GROUP BY client_token HAVING COUNT(*) > 1`, bookId)) p.push(`Confirmation token ${r.client_token} created ${r.n} strategy instances.`);
      for (const r of db.all(`SELECT strategy_id, COUNT(*) AS n FROM hedge_requests WHERE book_id = ? AND trigger = 'post_trade' AND strategy_id IS NOT NULL GROUP BY strategy_id HAVING COUNT(*) > 1`, bookId)) p.push(`Strategy ${r.strategy_id} has ${r.n} post-trade hedge requests.`);
      for (const r of db.all(`SELECT ref_type, ref_id, kind, ccy, unit_id, COUNT(*) AS n FROM holds WHERE book_id = ? AND released_at IS NULL GROUP BY ref_type, ref_id, kind, ccy, unit_id HAVING COUNT(*) > 1`, bookId)) p.push(`${r.n} open ${r.kind} holds exist for ${r.ref_type} ${r.ref_id} in ${r.ccy}.`);
      add('no-duplicate-postings', 'No order, strategy, hedge request or hold is created twice', p);
    }

    const count = (sql) => db.get(sql, bookId).n;
    return {
      bookId, reportingCcy: rc, at: app.clock.now().toISOString(), ok: checks.every((c) => c.ok), checks,
      problems: checks.flatMap((c) => c.problems.map((m) => `[${c.id}] ${m}`)),
      counts: {
        events: count('SELECT COUNT(*) AS n FROM events WHERE book_id = ?'), entries: count('SELECT COUNT(*) AS n FROM entries WHERE book_id = ?'),
        orders: count('SELECT COUNT(*) AS n FROM orders WHERE book_id = ?'), fills: count('SELECT COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ?'),
        settlements: count('SELECT COUNT(*) AS n FROM settlements WHERE book_id = ?'), positions: count('SELECT COUNT(*) AS n FROM positions WHERE book_id = ?'),
        strategies: count('SELECT COUNT(*) AS n FROM strategies WHERE book_id = ?'), hedgeRequests: count('SELECT COUNT(*) AS n FROM hedge_requests WHERE book_id = ?'),
        tasks: count('SELECT COUNT(*) AS n FROM tasks WHERE book_id = ?'),
      },
      // Ledger balances by owner, account and currency (debit positive), for anyone who wants to re-add them.
      trialBalance: Object.fromEntries(Object.entries(trialBalance).map(([u, v]) => [u, { owner: name.get(u) || u, accounts: v }])),
    };
  }

  return { check };
}
