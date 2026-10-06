// Corporate actions: cash dividends (and other cash distributions) and stock splits.
//
// Corporate actions are facts owned by Shaffer MarketData. When that connection supplies them
// they are recorded here automatically; until then they are entered by hand. Either way the
// entitlement is computed from the position held at the open of the ex-date.

import { fmt } from './books.js';
import { ISO_DATE_RE, isZero, money, need, newId, num, qty8 } from './util.js';
import { fmtQty } from '../products/common.js';

export function createCorporateActions(app) {
  const { db, clock, ledger, positions, instruments, books } = app;

  function record({ instrumentId, type, exDate, payDate, amount, ccy, ratioNum, ratioDen, note, source = 'Manual entry', providerId = 'manual' }) {
    const inst = instruments.require(instrumentId);
    need(['cash_dividend', 'split'].includes(type), 'Corporate action type must be a cash dividend or a split. Record other actions as manual adjustments.');
    need(ISO_DATE_RE.test(exDate || ''), 'Ex-date is required (YYYY-MM-DD).');
    if (payDate) need(ISO_DATE_RE.test(payDate) && payDate >= exDate, 'Pay date must be on or after the ex-date.');
    if (type === 'cash_dividend') need(num(amount) > 0, 'Enter the cash amount per unit.');
    if (type === 'split') need(num(ratioNum) > 0 && num(ratioDen) > 0 && num(ratioNum) !== num(ratioDen), 'Enter the split ratio (for example 2 for 1).');
    const dupe = db.get(`SELECT id FROM corporate_actions WHERE instrument_id = ? AND type = ? AND ex_date = ? AND COALESCE(amount, 0) = COALESCE(?, 0) AND COALESCE(ratio_num, 0) = COALESCE(?, 0) AND status <> 'cancelled'`, instrumentId, type, exDate, num(amount), num(ratioNum));
    if (dupe) return { id: dupe.id, duplicate: true };
    const id = newId('CA');
    db.run(
      `INSERT INTO corporate_actions (id, instrument_id, type, ex_date, pay_date, amount, ccy, ratio_num, ratio_den, source, provider_id, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id, instrumentId, type, exDate, payDate || exDate, num(amount), ccy || inst.trading_ccy, num(ratioNum), num(ratioDen), source, providerId, note || null, clock.now().toISOString(),
    );
    return { id, duplicate: false };
  }

  /** Apply every recorded action whose effective date has arrived. */
  function process(today = clock.today()) {
    const due = db.all(`SELECT * FROM corporate_actions WHERE status = 'pending' AND (CASE WHEN type = 'split' THEN ex_date ELSE COALESCE(pay_date, ex_date) END) <= ? ORDER BY ex_date, created_at`, today);
    let n = 0;
    for (const ca of due) {
      db.tx(() => {
        if (ca.type === 'cash_dividend') applyDividend(ca);
        else applySplit(ca);
        db.run(`UPDATE corporate_actions SET status = 'applied', applied_at = ? WHERE id = ?`, clock.now().toISOString(), ca.id);
      });
      n++;
    }
    return n;
  }

  function applyDividend(ca) {
    const inst = instruments.get(ca.instrument_id);
    const ccy = ca.ccy || inst.trading_ccy;
    for (const p of positions.heldAround(inst.id)) {
      const q = positions.qtyAt(p.id, ca.ex_date, 'open');
      if (isZero(q)) continue;
      const book = books.getBook(p.book_id), unit = books.getUnit(p.unit_id);
      const gross = money(q * ca.amount, ccy);
      if (q > 0) {
        const wh = money(gross * ((book.settings.dividends.withholdingPct || 0) / 100), ccy);
        ledger.post({
          bookId: book.id, unitId: unit.id, type: 'dividend', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'engine',
          summary: `Dividend on ${fmtQty(q)} ${inst.symbol || inst.name}: ${fmt(gross, ccy)} (${ca.amount} per unit, ex-date ${ca.ex_date})${wh ? `, less ${fmt(wh, ccy)} withholding` : ''}${p.onloan_qty > 0 ? '; shares out on loan receive a manufactured payment' : ''}`,
          data: { corporateActionId: ca.id, perUnit: ca.amount, qty: q, exDate: ca.ex_date, payDate: ca.pay_date, source: ca.source },
          entries: [
            { account: 'cash', ccy, amount: money(gross - wh, ccy), positionId: p.id },
            { account: 'pnl.fee', ccy, amount: wh, positionId: p.id },
            { account: 'pnl.dividend', ccy, amount: -gross, positionId: p.id },
          ],
        });
      } else {
        // A short pays the dividend to the lender of the borrowed shares.
        ledger.post({
          bookId: book.id, unitId: unit.id, type: 'dividend.compensation', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'engine',
          summary: `Dividend compensation paid on ${fmtQty(-q)} borrowed ${inst.symbol || inst.name}: ${fmt(-gross, ccy)} (${ca.amount} per unit, ex-date ${ca.ex_date})`,
          data: { corporateActionId: ca.id, perUnit: ca.amount, qty: q, exDate: ca.ex_date, source: ca.source },
          entries: [
            { account: 'cash', ccy, amount: gross, positionId: p.id },
            { account: 'pnl.borrow', ccy, amount: -gross, positionId: p.id },
          ],
        });
      }
    }
    // Total-return swaps that pass dividends through.
    for (const row of db.all(`SELECT p.id FROM positions p JOIN instruments i ON i.id = p.instrument_id WHERE i.family = 'swap' AND ABS(p.qty) > 1e-9`)) {
      const sp = positions.get(row.id);
      const sinst = instruments.get(sp.instrument_id);
      app.products.get('swap').onCorporateAction(app, { ca, book: books.getBook(sp.book_id), unit: books.getUnit(sp.unit_id), inst: sinst, pos: sp });
    }
  }

  function applySplit(ca) {
    const inst = instruments.get(ca.instrument_id);
    const ratio = ca.ratio_num / ca.ratio_den;
    for (const p of positions.heldAround(inst.id)) {
      if (isZero(p.qty)) continue;
      const book = books.getBook(p.book_id), unit = books.getUnit(p.unit_id);
      const newQty = qty8(p.qty * ratio);
      ledger.post({
        bookId: book.id, unitId: unit.id, type: 'split', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, actor: 'engine',
        summary: `${ca.ratio_num}-for-${ca.ratio_den} split of ${inst.symbol || inst.name}: ${fmtQty(p.qty)} became ${fmtQty(newQty)}; cost basis unchanged`,
        data: { corporateActionId: ca.id, ratioNum: ca.ratio_num, ratioDen: ca.ratio_den, oldQty: p.qty, newQty },
      });
      positions.change(p, { dQty: newQty - p.qty, dPledged: p.pledged_qty * (ratio - 1), dOnLoan: p.onloan_qty * (ratio - 1) });
    }
    // Derivatives and borrows on the split security.
    for (const d of db.all(`SELECT * FROM instruments WHERE underlying_id = ? AND status = 'active'`, inst.id)) {
      const di = instruments.get(d.id);
      const holders = positions.heldAround(di.id).filter((p) => !isZero(p.qty));
      if (di.family === 'secloan') {
        for (const p of holders) positions.change(p, { dQty: qty8(p.qty * ratio) - p.qty });
        continue;
      }
      if (di.family === 'option' && Number.isInteger(ratio) && ratio > 1) {
        // Whole forward split: more contracts at a proportionally lower strike, same contract size.
        instruments.update(di.id, { terms: { ...di.terms, strike: di.terms.strike / ratio, adjustedFor: [...(di.terms.adjustedFor || []), ca.id] } }, { system: true });
        for (const p of holders) {
          positions.change(p, { dQty: qty8(p.qty * ratio) - p.qty });
          ledger.post({ bookId: p.book_id, unitId: p.unit_id, type: 'split.option_adjustment', instrumentId: di.id, strategyId: p.strategy_id, positionId: p.id, actor: 'engine', summary: `Option adjusted for the ${ca.ratio_num}-for-${ca.ratio_den} split of ${inst.symbol || inst.name}: contracts x${ratio}, strike divided by ${ratio}`, data: { corporateActionId: ca.id } });
        }
        continue;
      }
      if (holders.length) {
        for (const p of holders) {
          app.alerts.raise({ bookId: p.book_id, unitId: p.unit_id, level: 'error', code: 'split.manual', refType: 'position', refId: p.id, message: `${di.symbol || di.name} needs a manual contract adjustment for the ${ca.ratio_num}-for-${ca.ratio_den} split of ${inst.symbol || inst.name}. The Terminal only adjusts listed options for whole forward splits.` });
        }
      }
    }
  }

  /** Pull corporate actions for held instruments from the data connection (no-op until connected). */
  async function pull(today = clock.today()) {
    const last = app.data.getSetting('corpactions.pulledThrough', null);
    if (last === today) return 0;
    const held = new Map();
    for (const row of db.all(`SELECT DISTINCT instrument_id FROM positions WHERE ABS(qty) > 1e-9`)) {
      const i = instruments.get(row.instrument_id);
      if (i && ['equity', 'fund'].includes(i.family)) held.set(i.id, i);
    }
    for (const row of db.all(`SELECT DISTINCT i.underlying_id AS id FROM positions p JOIN instruments i ON i.id = p.instrument_id WHERE ABS(p.qty) > 1e-9 AND i.underlying_id IS NOT NULL`)) {
      const i = instruments.get(row.id);
      if (i && ['equity', 'fund'].includes(i.family)) held.set(i.id, i);
    }
    if (!held.size) { app.data.setSetting('corpactions.pulledThrough', today); return 0; }
    const from = last || today;
    const r = await app.data.market.corporateActions([...held.values()], { from, to: today });
    if (!r?.available) return 0;
    let n = 0;
    for (const it of r.items || []) {
      const res = record({ instrumentId: it.instrumentId, type: it.type, exDate: it.exDate, payDate: it.payDate, amount: it.amount, ccy: it.currency, ratioNum: it.ratioNum, ratioDen: it.ratioDen, source: r.source || 'Shaffer MarketData', providerId: r.providerId || 'shaffer-marketdata' });
      if (!res.duplicate) n++;
    }
    app.data.setSetting('corpactions.pulledThrough', today);
    return n;
  }

  const list = (instrumentId) => (instrumentId
    ? db.all('SELECT * FROM corporate_actions WHERE instrument_id = ? ORDER BY ex_date DESC', instrumentId)
    : db.all('SELECT * FROM corporate_actions ORDER BY ex_date DESC LIMIT 300'));

  return { record, process, pull, list };
}
