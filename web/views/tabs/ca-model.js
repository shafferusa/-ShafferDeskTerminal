// Corporate actions tab: the plain logic, with no screen code, so the engine tests can load it (test/core/e3-tabs.test.js).
//
//   matchCorporateActions(events, ledgerRows, instrumentId)
//     Splits the server's corporate-action events (GET /api/server/corporate-actions/:id, one row per event) into
//     those already in the paper ledger and those that are informational only, by matching each event to the ledger's
//     own corporate-action records (GET /api/server/ledger/:id, data.recordedCorporateActions):
//       1. by the server event ID: the link the ledger keeps when an event is recorded (event.recorded.caId), or the
//          event ID written in the ledger record's note;
//       2. else by instrument + type + ex-date (a record entered by hand, or recorded before the link existed).
//     Each ledger record matches one event at most. Ledger records no event matches are returned apart.
//     Revisions are flagged, never merged: one the server states (revision / revisedAt / supersedes / previous), a
//     second event with the same type and ex-date but other terms, and an event whose terms differ from what the
//     ledger recorded (the ledger is not changed by it).
//
// Nothing here posts anything or works out an entitlement: recording goes through the idempotent server route.

export const CA_TYPE_LABEL = {
  cash_dividend: 'Cash dividend', stock_dividend: 'Stock dividend', special_dividend: 'Special dividend', split: 'Split', reverse_split: 'Reverse split',
  buyback: 'Buyback', rights: 'Rights issue', rights_issue: 'Rights issue', merger: 'Merger', acquisition: 'Acquisition', spinoff: 'Spin-off', spin_off: 'Spin-off',
  tender: 'Tender offer', name_change: 'Name change', delisting: 'Delisting', other: 'Other action',
};
export const caTypeLabel = (t) => CA_TYPE_LABEL[t] || (t ? String(t).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unstated type');
/** The ledger's own types (core/corpactions.js): only these can be recorded; the rest stay informational. */
export const LEDGER_TYPES = ['cash_dividend', 'split'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const near = (a, b) => (a === null || a === undefined) && (b === null || b === undefined) ? true : isNum(a) && isNum(b) && Math.abs(a - b) < 1e-9;

/** The economic terms of a server event, for comparison: amount, currency, ratio. */
export function eventTerms(ev) {
  return { amount: isNum(ev?.amount) ? ev.amount : null, currency: ev?.currency || null, num: isNum(ev?.ratio?.num) ? ev.ratio.num : null, den: isNum(ev?.ratio?.den) ? ev.ratio.den : null };
}
/** The terms of a ledger record (corporate_actions row). */
export function ledgerTerms(row) {
  return { amount: isNum(row?.amount) ? row.amount : null, currency: row?.ccy || null, num: isNum(row?.ratio_num) ? row.ratio_num : null, den: isNum(row?.ratio_den) ? row.ratio_den : null };
}
export const sameTerms = (a, b) => near(a.amount, b.amount) && near(a.num, b.num) && near(a.den, b.den) && (!a.currency || !b.currency || a.currency === b.currency);
/** Terms in words: "0.55 USD per share", "2-for-1". */
export function termsText(t) {
  const bits = [];
  if (isNum(t.amount)) bits.push(`${t.amount}${t.currency ? ` ${t.currency}` : ''} per share`);
  if (isNum(t.num) && isNum(t.den)) bits.push(`${t.num}-for-${t.den}`);
  return bits.join(', ') || 'no amount or ratio stated';
}

function serverRevision(ev) {
  if (ev.revision === 'revised' || ev.status === 'revised' || ev.revisedAt || ev.supersedes || ev.previous) {
    return { by: 'server', at: ev.revisedAt || null, supersedes: ev.supersedes || null, previous: ev.previous ? eventTerms(ev.previous) : null, note: ev.revisionNote || null };
  }
  return null;
}

/**
 * @param events     server events (each { eventId, type, exDate, amount, currency, ratio, recorded: { caId, status, at } | null, ... })
 * @param ledgerRows ledger records ({ id, instrument_id, type, ex_date, amount, ccy, ratio_num, ratio_den, status, created_at, applied_at, note, source })
 * @returns {{ processed: Row[], informational: Row[], ledgerOnly: object[] }}
 *   Row: { ev, ledger, matchedBy: 'event-id' | 'instrument-type-ex-date' | null, recordedAt, appliedAt, status, revisions: [] }
 */
export function matchCorporateActions(events = [], ledgerRows = [], instrumentId = null) {
  const rows = (ledgerRows || []).filter((r) => r && r.status !== 'cancelled' && (!instrumentId || !r.instrument_id || r.instrument_id === instrumentId));
  const used = new Set();
  const out = (events || []).map((ev) => ({ ev, ledger: null, matchedBy: null, recordedAt: null, appliedAt: null, status: null, revisions: [] }));
  // 1. by the server event ID
  for (const r of out) {
    const ev = r.ev;
    let row = ev.recorded?.caId ? rows.find((x) => x.id === ev.recorded.caId) : null;
    if (!row && ev.eventId) row = rows.find((x) => !used.has(x.id) && typeof x.note === 'string' && x.note.includes(`server event ${ev.eventId}`));
    if (row && !used.has(row.id)) { used.add(row.id); r.ledger = row; r.matchedBy = 'event-id'; }
    else if (ev.recorded?.caId) { r.matchedBy = 'event-id'; } // the link exists; the record itself is outside this list
  }
  // 2. by instrument + type + ex-date: same terms first, then any
  for (const pass of ['same', 'any']) {
    for (const r of out) {
      if (r.matchedBy) continue;
      const ev = r.ev;
      const cands = rows.filter((x) => !used.has(x.id) && x.type === ev.type && x.ex_date === ev.exDate);
      const row = pass === 'same' ? cands.find((x) => sameTerms(ledgerTerms(x), eventTerms(ev))) : cands[0];
      if (row) { used.add(row.id); r.ledger = row; r.matchedBy = 'instrument-type-ex-date'; }
    }
  }
  for (const r of out) {
    if (!r.matchedBy) continue;
    r.recordedAt = r.ev.recorded?.at || r.ledger?.created_at || null;
    r.appliedAt = r.ledger?.applied_at || null;
    r.status = r.ledger?.status || r.ev.recorded?.status || null;
  }
  // Revisions.
  for (const r of out) {
    const s = serverRevision(r.ev);
    if (s) r.revisions.push(s);
    if (r.ledger && !sameTerms(ledgerTerms(r.ledger), eventTerms(r.ev))) {
      r.revisions.push({ by: 'ledger', ledger: ledgerTerms(r.ledger), server: eventTerms(r.ev), note: 'The server now states other terms than the ledger recorded. The ledger is not changed by it.' });
    }
  }
  const groups = new Map();
  for (const r of out) {
    const k = `${r.ev.type}|${r.ev.exDate}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = g.slice().sort((a, b) => String(a.ev.announcedAt || '').localeCompare(String(b.ev.announcedAt || '')));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if (!sameTerms(eventTerms(prev.ev), eventTerms(sorted[i].ev))) sorted[i].revisions.push({ by: 'terms', previousEventId: prev.ev.eventId || null, previous: eventTerms(prev.ev), note: 'Another event with the same type and ex-date states other terms.' });
    }
  }
  return {
    processed: out.filter((r) => r.matchedBy),
    informational: out.filter((r) => !r.matchedBy),
    ledgerOnly: rows.filter((x) => !used.has(x.id) && !out.some((r) => r.ev.recorded?.caId === x.id)),
  };
}

/** Why an informational event cannot be recorded, or null when it can. */
export function recordBlock(ev) {
  if (!LEDGER_TYPES.includes(ev?.type)) return `${caTypeLabel(ev?.type)}: informational. The paper ledger records cash dividends and splits only; record any effect as a manual adjustment.`;
  if (ev.recordable === false) return 'The server marks this event as not recordable.';
  if (ev.type === 'cash_dividend' && !(isNum(ev.amount) && ev.amount > 0)) return 'No cash amount per share is stated, so it cannot be recorded.';
  if (ev.type === 'split' && !(isNum(ev.ratio?.num) && isNum(ev.ratio?.den))) return 'No split ratio is stated, so it cannot be recorded.';
  if (!ev.exDate) return 'No ex-date is stated, so it cannot be recorded.';
  if (ev.status === 'cancelled' || ev.status === 'withdrawn') return 'The event is cancelled.';
  return null;
}
