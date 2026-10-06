import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, ledgerImbalance } from '../helpers.js';

test('a Book has one Treasury and many Accounts; capital goes through Treasury', () => {
  const { app } = makeApp();
  const book = app.books.createBook({ name: 'Main', reportingCcy: 'USD' });
  assert.equal(book.units.length, 1);
  assert.equal(book.units[0].kind, 'treasury');
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'USD', amount: 1_000_000 });
  const a = app.books.createAccount(book.id, { name: 'Alpha' });
  const b = app.books.createAccount(book.id, { name: 'Beta' });
  assert.throws(() => app.books.createAccount(book.id, { name: 'Alpha' }), /already has an Account/);
  assert.throws(() => app.books.createAccount(book.id, { name: 'Treasury' }), /reserved/);
  const tr = app.books.treasuryOf(book.id);
  app.books.transfer({ bookId: book.id, fromUnitId: tr.id, toUnitId: a.id, ccy: 'USD', amount: 300_000, purpose: 'funding' });
  app.books.transfer({ bookId: book.id, fromUnitId: a.id, toUnitId: b.id, ccy: 'USD', amount: 50_000 });
  app.books.transfer({ bookId: book.id, fromUnitId: b.id, toUnitId: tr.id, ccy: 'USD', amount: 10_000 });
  assert.equal(app.ledger.cash(tr.id, 'USD').settled, 710_000);
  assert.equal(app.ledger.cash(a.id, 'USD').settled, 250_000);
  assert.equal(app.ledger.cash(b.id, 'USD').settled, 40_000);
  assert.deepEqual(ledgerImbalance(app), []);
  // Internal transfers net to zero across the Book: consolidated NAV is the capital contributed.
  const ov = app.accounting.overview(book.id);
  assert.equal(ov.nav, 1_000_000);
  assert.equal(ov.units.reduce((s, u) => s + u.nav, 0), 1_000_000);
});

test('transfers cannot overdraw, cross Books, or convert currency', () => {
  const { app } = makeApp();
  const one = makeBook(app, { name: 'One' });
  const two = makeBook(app, { name: 'Two' });
  assert.throws(() => app.books.transfer({ bookId: one.book.id, fromUnitId: one.acct.id, toUnitId: one.treasury.id, ccy: 'USD', amount: 600_000 }), /available/);
  assert.throws(() => app.books.transfer({ bookId: one.book.id, fromUnitId: one.treasury.id, toUnitId: two.acct.id, ccy: 'USD', amount: 10 }), /different Book/);
  // No EUR is held: a transfer never converts USD into EUR.
  assert.throws(() => app.books.transfer({ bookId: one.book.id, fromUnitId: one.treasury.id, toUnitId: one.acct.id, ccy: 'EUR', amount: 10 }), /available/);
  assert.throws(() => app.books.capital({ bookId: one.book.id, type: 'withdrawal', ccy: 'USD', amount: 600_000 }), /available to withdraw/);
});

test('P&L separates capital flows from investment performance', () => {
  const { app } = makeApp();
  const { book, acct } = makeBook(app);
  const bookPnl = app.accounting.pnl(book.id, 'book');
  assert.equal(bookPnl.capital.contributions, 1_000_000);
  assert.equal(bookPnl.investmentPnl, 0);
  assert.equal(bookPnl.nav.end, 1_000_000);
  const acctPnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(acctPnl.capital.internalIn, 500_000);
  assert.equal(acctPnl.capital.contributions, 0);
  assert.equal(acctPnl.nav.end, 500_000);
});

test('reversing a transfer keeps the original and records the correction', () => {
  const { app } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  const { eventId } = app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: 'USD', amount: 1000 });
  const r = app.accounting.reverseEvent(eventId, { note: 'wrong account' });
  const hist = app.accounting.history(book.id, 'book').events;
  const original = hist.find((e) => e.id === eventId);
  const reversal = hist.find((e) => e.id === r.eventId);
  assert.ok(original, 'original event is still in the trail');
  assert.equal(reversal.correctsEventId, eventId);
  assert.deepEqual(original.correctedBy, [r.eventId]);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 500_000);
  assert.throws(() => app.accounting.reverseEvent(eventId), /already been corrected/);
});
