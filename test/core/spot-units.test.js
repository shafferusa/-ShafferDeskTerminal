// Spot assets are held and quoted in their own units, and an indivisible certificate trades in whole lots.
// Found by the c1 matrix scenarios for the spot family: before the fix every spot asset was "Units" quoted "per
// unit" whatever the product, and 10.5 emissions allowances could be bought (the quantity step was 1e-8 whatever
// the lot size).
//
// By hand: a 1 kg gold bar quoted per troy ounce, multiplier 32.1507466 troy ounces per kilogram: 2 kg at 2,300.00
// per troy ounce cost 2 x 2,300 x 32.1507466 = 147,893.43.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook } from '../helpers.js';

test('a spot asset carries its quantity unit and price unit, and the multiplier converts between them', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const bar = app.instruments.create({ productId: 'precious_metal', name: 'Gold kilobar, 995 fine', symbol: 'AU-KB', venueType: 'otc', domicile: 'GB', marketView: 'FOREIGN_CASH', tradingCcy: 'USD', multiplier: 32.1507466, terms: { quantityUnit: 'kilograms', priceUnits: 'USD per troy ounce' } });
  const view = app.instruments.toView(bar);
  assert.equal(view.qtyLabel, 'Kilograms');
  assert.equal(view.priceUnits, 'USD per troy ounce');
  app.data.enterManual({ kind: 'price', subject: bar.id, value: 2300, bid: 2299, ask: 2300, currency: 'USD' });
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: bar.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: bar.id, qty: 2 }] });
  assert.equal(pv.legs[0].cash, -147_893.43);
});

test('an emissions allowance with lot size 1 refuses a fractional quantity', async () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const eua = app.instruments.create({ productId: 'emissions_allowance', name: 'Test EUA', symbol: 'T-EUA', venueType: 'exchange', venueCountry: 'DE', tradingCcy: 'EUR', terms: { lotSize: 1 } });
  app.data.enterManual({ kind: 'price', subject: eua.id, value: 70, currency: 'EUR' });
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: eua.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: eua.id, qty: 10.5 }] });
  assert.ok(pv.checks.some((c) => c.code === 'qty-step' && /multiple of 1/.test(c.message)));
});
