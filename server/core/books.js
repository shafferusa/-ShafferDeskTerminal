// Books, Treasury and Accounts.
//
//   Book -> Treasury + Accounts
//
// Treasury holds the Book's unallocated cash, funding arrangements and collateral inventory.
// Accounts are funded from Treasury and hold their own positions, cash, liabilities and
// transactions. Cash and collateral are never pooled across Books, and a transfer never converts
// currency (a conversion is a separate FX trade).

import { j, pj } from '../db/db.js';
import { BOOK_DEFAULTS, mergeSettings } from './defaults.js';
import { AppError, CCY_RE, money, need, newId, num } from './util.js';

export function createBooks(app) {
  const { db, clock, ledger } = app;

  const parseBook = (b) => b && { ...b, settings: mergeSettings(BOOK_DEFAULTS, pj(b.settings, {})), settingsOverrides: pj(b.settings, {}) };

  function createBook({ name, reportingCcy = 'USD' }) {
    const nm = String(name || '').trim();
    need(nm, 'A Book needs a name.');
    need(CCY_RE.test(reportingCcy), 'Reporting currency must be a three-letter currency code.');
    need(!db.get('SELECT 1 FROM books WHERE name = ?', nm), `A Book named "${nm}" already exists.`, { status: 409 });
    const now = clock.now().toISOString();
    const id = newId('BK');
    return db.tx(() => {
      db.run('INSERT INTO books (id, name, reporting_ccy, settings, created_at) VALUES (?, ?, ?, ?, ?)', id, nm, reportingCcy, '{}', now);
      const treasuryId = newId('TR');
      db.run('INSERT INTO units (id, book_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)', treasuryId, id, 'treasury', 'Treasury', now);
      ledger.post({ bookId: id, unitId: treasuryId, type: 'book.created', summary: `Book "${nm}" created with reporting currency ${reportingCcy}`, data: { reportingCcy } });
      return getBook(id);
    });
  }

  function createAccount(bookId, { name }) {
    const book = requireBook(bookId);
    const nm = String(name || '').trim();
    need(nm, 'An Account needs a name.');
    need(nm.toLowerCase() !== 'treasury', '"Treasury" is reserved for the Book\'s Treasury.');
    need(!db.get('SELECT 1 FROM units WHERE book_id = ? AND name = ?', bookId, nm), `This Book already has an Account named "${nm}".`, { status: 409 });
    const id = newId('AC');
    return db.tx(() => {
      db.run('INSERT INTO units (id, book_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)', id, bookId, 'account', nm, clock.now().toISOString());
      ledger.post({ bookId, unitId: id, type: 'account.created', summary: `Account "${nm}" created in Book "${book.name}"` });
      return getUnit(id);
    });
  }

  const listBooks = () => db.all('SELECT * FROM books WHERE archived_at IS NULL ORDER BY created_at').map((b) => ({ ...parseBook(b), units: unitsOf(b.id) }));
  const unitsOf = (bookId) => db.all(`SELECT * FROM units WHERE book_id = ? ORDER BY CASE kind WHEN 'treasury' THEN 0 ELSE 1 END, created_at`, bookId);
  function getBook(id) {
    const b = parseBook(db.get('SELECT * FROM books WHERE id = ?', id));
    return b ? { ...b, units: unitsOf(id) } : null;
  }
  function requireBook(id) {
    const b = getBook(id);
    if (!b) throw new AppError('Book not found.', { status: 404 });
    return b;
  }
  const getUnit = (id) => db.get('SELECT * FROM units WHERE id = ?', id) || null;
  function requireUnit(id, bookId) {
    const u = getUnit(id);
    if (!u) throw new AppError('Treasury or Account not found.', { status: 404 });
    if (bookId && u.book_id !== bookId) throw new AppError('That Treasury or Account belongs to a different Book.', { status: 400 });
    return u;
  }
  const treasuryOf = (bookId) => db.get(`SELECT * FROM units WHERE book_id = ? AND kind = 'treasury'`, bookId);
  const settingsOf = (bookId) => requireBook(bookId).settings;

  function updateSettings(bookId, patch) {
    const book = requireBook(bookId);
    const merged = mergeSettings(book.settingsOverrides, patch || {});
    // Validate that every leaf that should be numeric is a finite, non-negative number.
    const check = (def, val, path) => {
      if (def !== null && typeof def === 'object') {
        for (const k of Object.keys(val || {})) if (k in def) check(def[k], val[k], `${path}.${k}`);
      } else if (typeof def === 'number') {
        need(typeof val === 'number' && Number.isFinite(val) && val >= 0, `Setting ${path.slice(1)} must be a non-negative number.`);
      } else if (typeof def === 'boolean') {
        need(typeof val === 'boolean', `Setting ${path.slice(1)} must be true or false.`);
      }
    };
    check(BOOK_DEFAULTS, merged, '');
    return db.tx(() => {
      db.run('UPDATE books SET settings = ? WHERE id = ?', j(merged), bookId);
      ledger.post({ bookId, unitId: treasuryOf(bookId).id, type: 'book.settings', summary: 'Book paper-desk assumptions changed', data: { patch } });
      return getBook(bookId);
    });
  }

  function renameBook(bookId, name) {
    requireBook(bookId);
    const nm = String(name || '').trim();
    need(nm, 'A Book needs a name.');
    need(!db.get('SELECT 1 FROM books WHERE name = ? AND id <> ?', nm, bookId), `A Book named "${nm}" already exists.`, { status: 409 });
    db.run('UPDATE books SET name = ? WHERE id = ?', nm, bookId);
    return getBook(bookId);
  }

  /** External capital in or out of the Book. Always through Treasury. */
  function capital({ bookId, type, ccy, amount, note }) {
    const book = requireBook(bookId);
    need(type === 'deposit' || type === 'withdrawal', 'Capital movement must be a deposit or a withdrawal.');
    need(CCY_RE.test(ccy || ''), 'Enter a three-letter currency code.');
    const amt = money(num(amount), ccy);
    need(amt > 0, 'Enter a positive amount.');
    const treasury = treasuryOf(bookId);
    if (type === 'withdrawal') {
      const c = ledger.cash(treasury.id, ccy);
      need(c.availableToWithdraw >= amt, `Treasury has ${fmt(c.availableToWithdraw, ccy)} available to withdraw; ${fmt(amt, ccy)} requested.`, { code: 'insufficient_cash' });
    }
    const signed = type === 'deposit' ? amt : -amt;
    const eventId = ledger.post({
      bookId, unitId: treasury.id, type: `capital.${type}`,
      summary: `${type === 'deposit' ? 'Capital contribution' : 'Capital withdrawal'} of ${fmt(amt, ccy)} ${type === 'deposit' ? 'into' : 'from'} Treasury${note ? ` (${note})` : ''}`,
      data: { ccy, amount: amt, note: note || null },
      entries: [
        { account: 'cash', ccy, amount: signed },
        { account: 'capital', ccy, amount: -signed },
      ],
    });
    return { eventId, book: book.id };
  }

  /**
   * Internal cash transfer inside one Book: Treasury -> Account funding, Account -> Treasury
   * return, or Account -> Account. Same currency on both sides; no conversion.
   */
  function transfer({ bookId, fromUnitId, toUnitId, ccy, amount, purpose, strategyId, orderId }) {
    requireBook(bookId);
    const from = requireUnit(fromUnitId, bookId);
    const to = requireUnit(toUnitId, bookId);
    need(from.id !== to.id, 'Source and destination must be different.');
    need(CCY_RE.test(ccy || ''), 'Enter a three-letter currency code.');
    const amt = money(num(amount), ccy);
    need(amt > 0, 'Enter a positive amount.');
    const c = ledger.cash(from.id, ccy);
    need(c.availableToWithdraw >= amt, `${from.name} has ${fmt(c.availableToWithdraw, ccy)} of settled ${ccy} available; ${fmt(amt, ccy)} requested.`, { code: 'insufficient_cash' });
    const type = from.kind === 'treasury' ? 'transfer.funding' : to.kind === 'treasury' ? 'transfer.return' : 'transfer.internal';
    const label = type === 'transfer.funding' ? 'Treasury funding' : type === 'transfer.return' ? 'Return to Treasury' : 'Transfer between Accounts';
    const eventId = ledger.post({
      bookId, unitId: from.id, type, strategyId, orderId,
      summary: `${label}: ${fmt(amt, ccy)} from ${from.name} to ${to.name}${purpose ? ` (${purpose})` : ''}`,
      data: { ccy, amount: amt, fromUnitId: from.id, toUnitId: to.id, from: from.name, to: to.name, purpose: purpose || null },
      entries: [
        { unitId: from.id, account: 'cash', ccy, amount: -amt },
        { unitId: from.id, account: 'internal', ccy, amount: amt },
        { unitId: to.id, account: 'cash', ccy, amount: amt },
        { unitId: to.id, account: 'internal', ccy, amount: -amt },
      ],
    });
    return { eventId };
  }

  /**
   * Units of an accounting scope inside ONE Book: 'book' (Treasury and every Account), 'treasury',
   * 'accounts' (every Account), one unit id, or several unit ids separated by commas.
   * A scope never reaches outside its Book.
   */
  function scopeUnits(bookId, scope = 'book') {
    const units = unitsOf(bookId);
    if (!scope || scope === 'book') return units;
    if (scope === 'treasury') return units.filter((u) => u.kind === 'treasury');
    if (scope === 'accounts') return units.filter((u) => u.kind === 'account');
    const ids = [...new Set(String(scope).split(',').map((x) => x.trim()).filter(Boolean))];
    const picked = ids.map((id) => units.find((x) => x.id === id));
    if (!picked.length || picked.some((u) => !u)) throw new AppError('Unknown accounting scope: it must name Treasury or Accounts of this Book.', { status: 404 });
    // Keep the Book's own order: Treasury first, then Accounts as created.
    return units.filter((u) => picked.includes(u));
  }

  return { createBook, createAccount, listBooks, getBook, requireBook, getUnit, requireUnit, treasuryOf, unitsOf, settingsOf, updateSettings, renameBook, capital, transfer, scopeUnits };
}

export function fmt(amount, ccy) {
  const dp = ['JPY', 'KRW'].includes(ccy) ? 0 : 2;
  return `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })} ${ccy}`;
}
