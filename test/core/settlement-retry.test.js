// fin: a failed settlement is attempted again only when something has changed (new cash in its currency, or a new
// business day of that currency). Idle engine cycles are not attempts: they are neither counted nor recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance } from '../helpers.js';

const MON = '2026-03-02T15:00:00.000Z', TUE = '2026-03-03T15:00:00.000Z', WED = '2026-03-04T15:00:00.000Z', THU = '2026-03-05T15:00:00.000Z';
const FRI = '2026-03-06T15:00:00.000Z', SAT = '2026-03-07T15:00:00.000Z', SUN = '2026-03-08T15:00:00.000Z', MON2 = '2026-03-09T15:00:00.000Z';
const MIN = 60e3;

test('a failed settlement counts an attempt only when new cash arrives or on a new business day, not every engine cycle', async () => {
  const { app, clock } = makeApp({ at: MON });
  const { book, acct, treasury } = makeBook(app, { account: 100_000 });
  const stock = app.instruments.create({ productId: 'common_stock', name: 'Retry Works Inc.', symbol: 'RTRY', marketView: 'US_CASH', venue: 'NYSE', venueCountry: 'US', tradingCcy: 'USD' });
  app.data.market.set(stock.id, { bid: 50.00, ask: 50.02, value: 50.01, bidSize: 1e6, askSize: 1e6 });
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { clock.advance(MIN); await app.engine.tick(); } };
  const goTo = async (iso) => { clock.freeze(iso); await app.engine.tick(); };
  const row = () => app.db.get(`SELECT * FROM settlements WHERE unit_id = ? AND amount < 0 AND due_date = '2026-03-04'`, acct.id);
  const failedTab = () => app.accounting.failed(book.id, 'book').settlementFailures;
  const cash = () => app.ledger.balance(acct.id, 'cash', 'USD');

  // The test Book charges no commission. Monday: buy 1,000 at 50.02 = 50,020, paid Tuesday: cash 100,000 - 50,020 = 49,980.
  const s1 = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, quantity: 1_000, origin: 'marketplace' });
  await goTo(TUE);
  assert.equal(cash(), 49_980);
  // Tuesday: sell the 1,000 at 50.00 settling T+4 (Monday 9 March): 50,000 receivable. Buy 1,800 at 50.02 = 90,036, due
  // Wednesday (allowed: 49,980 + 50,000 = 99,980 is available to trade).
  const close = await app.packages.previewAction(s1.id, 'close', { positionIds: [s1.positions[0].positionId], qty: 1_000, order: { orderType: 'market', tif: 'day', settle: { lag: 4 } } });
  await app.packages.submit({ ...close.input, legs: close.legs, clientToken: close.token, confirm: true });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, quantity: 1_800, origin: 'marketplace' });
  assert.equal(row().amount, -90_036);

  // Wednesday: the payment fails once (49,980 available, 90,036 due).
  await goTo(WED);
  let r = row();
  assert.deepEqual([r.status, r.attempts, r.last_attempt_at], ['failed', 1, WED]);
  assert.match(r.last_error, /49,980\.00 USD available, 90,036\.00 USD due/);
  // Ten more cycles on Wednesday with nothing changed: still one attempt, at the same time.
  await tick(10);
  r = row();
  assert.deepEqual([r.attempts, r.last_attempt_at], [1, WED], 'idle cycles are not attempts');
  // New cash in USD: Treasury funds 10,000. The next cycle attempts again (59,980 available, still short) and records it.
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: 'USD', amount: 10_000, purpose: 'test: new cash' });
  await tick();
  r = row();
  assert.deepEqual([r.status, r.attempts, r.last_attempt_at], ['failed', 2, new Date(Date.parse(WED) + 11 * MIN).toISOString()]);
  assert.match(r.last_error, /59,980\.00 USD available, 90,036\.00 USD due/);
  await tick(5);
  assert.equal(row().attempts, 2, 'nothing changed after that attempt');
  // Thursday and Friday are new business days: one attempt each, however many cycles run.
  await goTo(THU); await tick(5);
  assert.deepEqual([row().attempts, row().last_attempt_at], [3, THU]);
  await goTo(FRI); await tick(5);
  assert.deepEqual([row().attempts, row().last_attempt_at], [4, FRI]);
  // Saturday and Sunday are not US business days and no cash arrives: no attempt.
  await goTo(SAT); await tick(5); await goTo(SUN); await tick(5);
  assert.deepEqual([row().attempts, row().last_attempt_at], [4, FRI], 'no attempt at the weekend');
  // The Failed tab shows the attempts, the last attempt time and the reason.
  const [f] = failedTab();
  assert.deepEqual([f.attempts, f.lastAttemptAt, f.status], [4, FRI, 'failed']);
  assert.match(f.error, /59,980\.00 USD available, 90,036\.00 USD due/);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'settlement.failed' AND json_extract(data, '$.settlementId') = ?`, r.id).n, 1, 'the failure is posted once');

  // Monday: a new business day (attempt 5 fails: the payment is due earlier than the receipt and is tried first), then the
  // 50,000 proceeds arrive: new cash, so it is attempted and paid. Cash 59,980 + 50,000 - 90,036 = 19,944.
  await goTo(MON2); await tick();
  r = row();
  assert.deepEqual([r.status, r.attempts], ['settled', 5]);
  assert.equal(cash(), 19_944);
  assert.deepEqual(failedTab(), []);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM events WHERE type = 'settlement.pay' AND json_extract(data, '$.settlementId') = ?`, r.id).n, 1, 'paid exactly once');
  assert.deepEqual(ledgerImbalance(app), []);
});
