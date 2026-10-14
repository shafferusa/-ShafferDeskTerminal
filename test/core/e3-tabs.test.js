// e3 tabs of the instrument workspace: the corporate-action matching (web/views/tabs/ca-model.js) on hand-made
// records and on the real routes (fixture delivery twice -> recorded once -> shown as processed), and the paper-ledger
// records the My positions and trades tab reads (GET /api/server/ledger/:id) against the Accounting positions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade } from '../helpers.js';
import { createApi } from '../../server/api.js';
import { matchCorporateActions, recordBlock, termsText, eventTerms } from '../../web/views/tabs/ca-model.js';

const route = (api, method, path, { query = {}, body = {} } = {}) => {
  const m = api.match(method, path);
  assert.ok(m && !m.methodNotAllowed, `route ${method} ${path}`);
  return m.handler({ params: m.params, query, body, req: { headers: {} } });
};

const ev = (o) => ({ eventId: null, type: 'cash_dividend', exDate: '2026-05-08', amount: 0.55, currency: 'USD', ratio: null, recorded: null, announcedAt: '2026-04-01T00:00:00Z', ...o });
const row = (o) => ({ id: 'CA-1', instrument_id: 'EQ-1', type: 'cash_dividend', ex_date: '2026-05-08', amount: 0.55, ccy: 'USD', ratio_num: null, ratio_den: null, status: 'pending', created_at: '2026-05-01T10:00:00Z', applied_at: null, note: null, ...o });

test('matching: by the server event ID first (the ledger link, or the event ID in the record note)', () => {
  const m = matchCorporateActions([
    ev({ eventId: 'E1', recorded: { caId: 'CA-9', status: 'applied', at: '2026-05-02T08:00:00Z' } }),
    ev({ eventId: 'E2', exDate: '2026-08-07' }),
  ], [
    row({ id: 'CA-9', status: 'applied', applied_at: '2026-05-22T00:00:00Z' }),
    row({ id: 'CA-7', ex_date: '2026-08-07', note: 'Recorded from server event E2; idempotency key srv:E2', created_at: '2026-08-01T09:00:00Z' }),
  ], 'EQ-1');
  assert.equal(m.processed.length, 2);
  assert.equal(m.informational.length, 0);
  const e1 = m.processed.find((r) => r.ev.eventId === 'E1');
  assert.equal(e1.matchedBy, 'event-id');
  assert.equal(e1.ledger.id, 'CA-9');
  assert.equal(e1.recordedAt, '2026-05-02T08:00:00Z'); // the link's time, not the record's created_at
  assert.equal(e1.appliedAt, '2026-05-22T00:00:00Z');
  const e2 = m.processed.find((r) => r.ev.eventId === 'E2');
  assert.equal(e2.matchedBy, 'event-id');
  assert.equal(e2.recordedAt, '2026-08-01T09:00:00Z');
});

test('matching: else by instrument + type + ex-date; another instrument, type or date does not match', () => {
  const m = matchCorporateActions([
    ev({ eventId: 'E1' }), // matches the hand-entered record
    ev({ eventId: 'E3', exDate: '2026-11-06' }), // no record on that date
    ev({ eventId: 'E4', type: 'split', ratio: { num: 2, den: 1 }, amount: null }), // same date, other type
  ], [
    row({ id: 'CA-1', note: 'Entered by hand' }),
    row({ id: 'CA-X', instrument_id: 'EQ-OTHER', ex_date: '2026-11-06' }),
    row({ id: 'CA-C', ex_date: '2026-11-06', status: 'cancelled' }),
  ], 'EQ-1');
  assert.deepEqual(m.processed.map((r) => [r.ev.eventId, r.matchedBy, r.ledger.id]), [['E1', 'instrument-type-ex-date', 'CA-1']]);
  assert.deepEqual(m.informational.map((r) => r.ev.eventId), ['E3', 'E4']);
  assert.deepEqual(m.ledgerOnly.map((r) => r.id), []); // the other instrument's and the cancelled record are not this list's
});

test('matching: one ledger record matches one event; an unmatched record is listed apart', () => {
  const m = matchCorporateActions([ev({ eventId: 'A' }), ev({ eventId: 'B', announcedAt: '2026-04-02T00:00:00Z' })], [row({ id: 'CA-1' }), row({ id: 'CA-2', ex_date: '2025-01-01' })], 'EQ-1');
  assert.equal(m.processed.length, 1);
  assert.equal(m.informational.length, 1);
  assert.deepEqual(m.ledgerOnly.map((r) => r.id), ['CA-2']);
});

test('revisions: stated by the server, a second event with other terms, and terms that differ from the ledger', () => {
  const m = matchCorporateActions([
    ev({ eventId: 'R0', exDate: '2026-02-06', amount: 0.5, announcedAt: '2026-01-01T00:00:00Z' }),
    ev({ eventId: 'R1', exDate: '2026-02-06', amount: 0.55, announcedAt: '2026-01-10T00:00:00Z' }),
    ev({ eventId: 'S1', exDate: '2026-03-01', revisedAt: '2026-02-20T00:00:00Z', previous: { amount: 0.4, currency: 'USD' } }),
    ev({ eventId: 'L1', exDate: '2026-04-01', amount: 0.6, recorded: { caId: 'CA-L', status: 'pending', at: '2026-03-25T00:00:00Z' } }),
  ], [row({ id: 'CA-L', ex_date: '2026-04-01', amount: 0.55 })], 'EQ-1');
  const by = (id) => [...m.processed, ...m.informational].find((r) => r.ev.eventId === id);
  assert.deepEqual(by('R0').revisions, []);
  assert.equal(by('R1').revisions[0].by, 'terms');
  assert.equal(by('R1').revisions[0].previousEventId, 'R0');
  assert.equal(by('R1').revisions[0].previous.amount, 0.5);
  assert.equal(by('S1').revisions[0].by, 'server');
  assert.equal(by('S1').revisions[0].previous.amount, 0.4);
  const l1 = by('L1').revisions.find((x) => x.by === 'ledger');
  assert.equal(l1.ledger.amount, 0.55);
  assert.equal(l1.server.amount, 0.6);
});

test('recordBlock: only cash dividends and splits with their terms can be recorded', () => {
  assert.equal(recordBlock(ev({})), null);
  assert.equal(recordBlock(ev({ type: 'split', amount: null, ratio: { num: 2, den: 1 } })), null);
  assert.match(recordBlock(ev({ type: 'buyback', amount: null })), /informational/);
  assert.match(recordBlock(ev({ type: 'merger' })), /cash dividends and splits only/);
  assert.match(recordBlock(ev({ amount: null })), /No cash amount/);
  assert.match(recordBlock(ev({ type: 'split', amount: null, ratio: null })), /No split ratio/);
  assert.equal(termsText(eventTerms(ev({}))), '0.55 USD per share');
  assert.equal(termsText(eventTerms(ev({ type: 'split', amount: null, ratio: { num: 2, den: 1 } }))), '2-for-1');
});

test('real routes: the event delivered twice is recorded once and then matched as processed by its event ID', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const { book } = makeBook(app);
  const id = inst.ALFA.id;
  const list = await route(api, 'GET', `/api/server/corporate-actions/${id}`);
  const dup = list.items.find((x) => x.deliveries === 2);
  assert.ok(dup, 'the fixture delivers one event twice and the route lists it once');
  const before = await route(api, 'GET', `/api/server/ledger/${id}`, { query: { bookId: book.id } });
  let m = matchCorporateActions(list.items, before.data.recordedCorporateActions, id);
  assert.equal(m.processed.length, 0);
  assert.ok(m.informational.some((r) => r.ev.eventId === dup.eventId));
  // Recorded through the idempotent route, twice (the second delivery), and the screen's request again.
  const r1 = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dup.eventId } });
  const r2 = await route(api, 'POST', '/api/server/corporate-actions/record', { body: { instrumentId: id, eventId: dup.eventId } });
  assert.equal(r1.recorded, true);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.caId, r1.caId);
  const relist = await route(api, 'GET', `/api/server/corporate-actions/${id}`, { query: { fresh: '1' } });
  const after = await route(api, 'GET', `/api/server/ledger/${id}`, { query: { bookId: book.id } });
  assert.equal(after.data.recordedCorporateActions.filter((x) => x.ex_date === dup.exDate && x.type === 'cash_dividend').length, 1);
  m = matchCorporateActions(relist.items, after.data.recordedCorporateActions, id);
  const p = m.processed.find((r) => r.ev.eventId === dup.eventId);
  assert.ok(p, 'shown as processed');
  assert.equal(p.matchedBy, 'event-id');
  assert.equal(p.ledger.id, r1.caId);
  assert.ok(p.recordedAt);
  assert.equal(m.processed.length, 1);
  assert.equal(m.ledgerOnly.length, 0);
});

test('ledger interface: positions match the Accounting positions; packages carry their financing legs', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const { book, acct } = makeBook(app);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 40 });
  const led = await route(api, 'GET', `/api/server/ledger/${inst.ALFA.id}`, { query: { bookId: book.id } });
  assert.equal(led.source.label, 'Terminal paper ledger');
  const acc = await route(api, 'GET', `/api/books/${book.id}/accounting/positions`, { query: {} });
  const accRows = (acc.rows || acc.items || acc.positions).filter((p) => p.instrument.id === inst.ALFA.id);
  const key = (p) => `${p.positionId}|${p.qty}|${p.avgCost}`;
  assert.deepEqual(led.data.positions.map(key).sort(), accRows.map(key).sort());
  // long 100 and short 40 held apart, in the one Account
  assert.deepEqual(led.data.holdings.map((h) => [h.long, h.short, h.net]), [[100, 40, 60]]);
  const short = led.data.strategies.find((s) => s.legs.some((l) => l.qty < 0 && l.instrument.id === inst.ALFA.id));
  assert.ok(short.legs.some((l) => l.financing), 'the short package lists its securities borrow as a financing leg');
  assert.ok(led.data.history.some((e) => e.type === 'trade.fill'));
});
