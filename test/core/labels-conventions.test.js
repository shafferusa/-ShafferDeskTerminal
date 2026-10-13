// Labels and conventions from the findings list (BUGS.md): what a preview row says, in which currency, and in what order.
// Expected figures are worked out by hand in the comments. Real preview and engine; quotes are fixtures where needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade } from '../helpers.js';

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
