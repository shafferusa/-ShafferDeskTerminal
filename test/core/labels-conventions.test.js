// Labels and conventions from the findings list (BUGS.md): what a preview row says, in which currency, and in what order.
// Expected figures are worked out by hand in the comments. Real preview and engine; quotes are fixtures where needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, goTo } from '../helpers.js';

test('an FX forward with no rate yet: its notional is the base-currency amount, labelled in that currency, and kept out of the quote currency\'s gross notional', async () => {
  const { app } = makeApp({ demo: false }); // no feed: no forward rate can be estimated
  const { book, acct } = makeBook(app);
  const contract = { productId: 'fx_forward', name: 'JPY/USD forward', marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { forwardType: 'fx', base: 'JPY', quote: 'USD', valueDate: '2026-06-02', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' } } };
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', qty: 2_924_000, contract }] });
  const leg = pv.legs[0];
  assert.equal(leg.price?.estimate ?? null, null, 'no rate, so no estimate');
  assert.equal(leg.notional, 2_924_000);
  assert.equal(leg.notionalCcy, 'JPY', 'the 2,924,000 is yen, not dollars');
  // Gross notional by currency in the confirmation snapshot: 2,924,000 JPY; nothing added to USD.
  assert.equal(pv.confirmation.totals.JPY.grossNotional, 2_924_000);
  assert.equal(pv.confirmation.totals.USD?.grossNotional ?? 0, 0);
});

test('a swap trade is worded pay / receive with its legs, never buy / sell, in the preview and on the order', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'interest_rate_swap', name: 'IRS label', symbol: 'IRS-LBL', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-04', maturity: '2028-03-04', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' }, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'SIM-3M', spread: 0.0025, months: 3, dayCount: 'ACT/360' }] } };
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 10_000_000, statedPrice: 0, contract }] });
  assert.equal(pv.legs[0].label, 'Enter as written: pay fixed 4.000%, receive SIM-3M + 0.25% on 10,000,000 IRS-LBL');
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 10_000_000, statedPrice: 0, contract }] });
  assert.equal(s.orders[0].description ?? s.orders[0].label, 'Enter as written: pay fixed 4.000%, receive SIM-3M + 0.25% on 10,000,000 IRS-LBL');
  // Terminating part of it enters the opposite side: every leg's pay and receive swap over.
  const close = await app.packages.previewAction(s.id, 'close', { positionIds: [s.positions[0].positionId], qty: 4_000_000 });
  assert.equal(close.legs[0].label, 'Enter the opposite side: receive fixed 4.000%, pay SIM-3M + 0.25% on 4,000,000 IRS-LBL');
});

test('closing an exact notional: 10,000,000 of a 30,000,000 swap leaves 20,000,000, where a 33.3333% share would leave 20,000,010', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const contract = { productId: 'interest_rate_swap', name: 'IRS exact', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-04', maturity: '2028-03-04', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' }, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'SIM-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 30_000_000, statedPrice: 0, contract }] });
  const share = await app.packages.previewAction(s.id, 'close', { fraction: 0.333333 });
  assert.equal(share.legs[0].qty, 9_999_990, '30,000,000 x 0.333333 = 9,999,990: a share cannot state the notional exactly');
  const pv = await app.packages.previewAction(s.id, 'close', { positionIds: [s.positions[0].positionId], qty: 10_000_000 });
  assert.equal(pv.legs[0].qty, 10_000_000);
  await app.packages.submit({ ...pv.input, legs: pv.legs.map((l) => ({ ...l, statedPrice: 0 })), clientToken: pv.token, confirm: true });
  assert.equal(app.positions.get(s.positions[0].positionId).qty, 20_000_000);
});

test('a swap whose last payment waited for a fixing matures in the same engine pass in which that payment is made', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  // One period, 4 March to 4 June 2026, both legs paid at maturity; the float index has no fixing until one is entered by hand.
  const contract = { productId: 'interest_rate_swap', name: 'IRS late fixing', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD',
    terms: { effective: '2026-03-04', maturity: '2026-06-04', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' }, legs: [
      { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 0, dayCount: '30/360' },
      { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'NOFIX-3M', spread: 0, months: 0, dayCount: 'ACT/360' }] } };
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract }] });
  const pid = s.positions[0].positionId;
  // The order the finding describes: the maturity task is older than the payment it waits for (as when a payment is scheduled later).
  app.db.run(`UPDATE tasks SET created_at = '2026-03-03T15:00:00.000Z' WHERE type = 'swap.payment' AND position_id = ?`, pid);
  await goTo(app, clock, '2026-06-04T15:00:00.000Z'); // the payment date itself: one due date in the pass
  const status = () => Object.fromEntries(app.db.all(`SELECT type, status FROM tasks WHERE position_id = ? AND (type = 'swap.maturity' OR status <> 'done')`, pid).map((r) => [r.type, r.status]));
  assert.deepEqual(status(), { 'swap.payment': 'blocked', 'swap.maturity': 'blocked' });
  app.data.enterManual({ kind: 'rate', subject: 'NOFIX-3M', value: 5, forDate: '2026-03-04' });
  await app.engine.tick(); // one pass
  assert.deepEqual(status(), { 'swap.maturity': 'done' }, 'the payment is made and the swap matures in the same pass');
  assert.equal(app.positions.get(pid).qty, 0);
});

test('a listed option on a published index: no registry underlying, the index named, settled in cash on the level served under its code', async () => {
  const { app, clock } = makeApp();
  const { book, acct } = makeBook(app);
  const inst = app.instruments.create({ productId: 'index_option', name: 'SIMX 5000 call Mar 2026', symbol: 'SIMX-C5000', marketView: 'US_DERIV', venueType: 'exchange', tradingCcy: 'USD', multiplier: 100,
    terms: { right: 'C', strike: 5000, expiration: '2026-03-20', exercise: 'european', settlement: 'cash', underlyingDescription: 'Simulated index SIMX (published level)', fixingRate: 'SIMX-LEVEL', deliverable: { units: 100 } } });
  assert.equal(inst.underlying_id, null);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 2, statedPrice: 10, instrumentId: inst.id }] });
  const pid = s.positions[0].positionId;
  await goTo(app, clock, '2026-03-04T15:00:00.000Z'); // the premium has settled (T+1)
  const cashAfterBuy = app.ledger.balance(acct.id, 'cash', 'USD');
  // The published level on the expiration date: 5,050.  Cash settlement to the long: (5,050 - 5,000) x 100 x 2 = 10,000.
  app.data.enterManual({ kind: 'rate', subject: 'SIMX-LEVEL', value: 5050, forDate: '2026-03-20' });
  await goTo(app, clock, '2026-03-20T22:30:00.000Z');
  await goTo(app, clock, '2026-03-24T15:00:00.000Z');
  assert.equal(app.positions.get(pid).qty, 0, 'expired and settled');
  const settled = app.accounting.history(book.id, acct.id, { limit: 100 }).events.find((e) => /option/.test(e.type) && /settle|exercis|expir/i.test(e.summary));
  assert.ok(settled, 'a settlement event is recorded');
  assert.equal(Math.round((app.ledger.balance(acct.id, 'cash', 'USD') - cashAfterBuy) * 100) / 100, 10_000);
});
