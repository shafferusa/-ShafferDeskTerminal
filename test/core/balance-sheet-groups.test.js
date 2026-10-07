// Balance sheet with many Accounts: the "Accounts, combined" column.
//
// The worksheet can collapse its Account columns into one. That column is `accountsCombined` on the
// balance-sheet response. These tests check it against figures worked out by hand, against what an
// Accounts-only scope reports, and that every line still adds up to the scope total.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade } from '../helpers.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const loanLeg = (ccy, qty) => ({
  kind: 'loan', action: 'borrow_cash', qty, purpose: 'financing',
  contract: { productId: 'unsecured_loan', name: `${ccy} loan`, marketView: ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH', venueType: 'otc', tradingCcy: ccy, terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.06, maturity: '2026-09-01', counterparty: 'Example Bank' } },
});
const amounts = (cell) => Object.fromEntries(cell.byCurrency.map((x) => [x.ccy, x.amount]));
/** Every row of a worksheet as [key, cells by unit, total, the Accounts-combined cell]. */
function rows(bs) {
  const g = bs.accountsCombined;
  return [
    ...bs.lines.map((l) => [l.key, l.cells, l.total, g?.lines[l.key]]),
    ['assets', bs.assets.cells, bs.assets.total, g?.assets], ['liabilities', bs.liabilities.cells, bs.liabilities.total, g?.liabilities],
    ['netAssets', bs.netAssets.cells, bs.netAssets.total, g?.netAssets],
    ...bs.representedBy.map((r) => [r.key, r.cells, r.total, g?.representedBy[r.key]]),
  ];
}

/** Treasury 2,000,000 USD; Alpha, Beta, Gamma funded; Delta empty; two Account borrowings; one Account-to-Account transfer; one purchase. */
async function manyAccounts() {
  const { app, inst } = makeApp();
  const { book, acct: alpha, treasury } = makeBook(app, { cash: 2_000_000, account: 500_000 });
  const [beta, gamma, delta] = ['Beta', 'Gamma', 'Delta'].map((name) => app.books.createAccount(book.id, { name }));
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: beta.id, ccy: 'USD', amount: 300_000 });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: gamma.id, ccy: 'USD', amount: 200_000 });
  pin(app, inst['USD/JPY'].id, 150);
  app.data.market.set('USD/JPY', { value: 150 }); app.data.market.set('JPY/USD', { value: 1 / 150 });
  await app.data.refresh({ pairs: ['JPY/USD'] });
  await trade(app, { bookId: book.id, unitId: alpha.id, template: 'custom', legs: [loanLeg('USD', 200_000)] });
  await trade(app, { bookId: book.id, unitId: beta.id, template: 'custom', legs: [loanLeg('JPY', 30_000_000)] });
  app.books.transfer({ bookId: book.id, fromUnitId: alpha.id, toUnitId: beta.id, ccy: 'USD', amount: 40_000, purpose: 'Account to Account' });
  pin(app, inst.ALFA.id, 50);
  await trade(app, { bookId: book.id, unitId: alpha.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000 });
  return { app, book, treasury, alpha, beta, gamma, delta };
}

test('the Accounts-combined column is the hand-computed sum of the Accounts, with the transfer between them cancelled', async () => {
  const { app, book, treasury, alpha, beta, gamma, delta } = await manyAccounts();
  const bs = app.accounting.balanceSheet(book.id, 'book');
  const g = bs.accountsCombined;
  assert.deepEqual([...g.members].sort(), [alpha.id, beta.id, gamma.id, delta.id].sort());

  // Settled cash. Alpha 500,000 + 200,000 borrowed - 40,000 sent = 660,000 USD. Beta 300,000 + 40,000 = 340,000 USD
  // and 30,000,000 JPY borrowed. Gamma 200,000 USD. Delta nothing. The purchase is unsettled, so no cash has left.
  // USD 660,000 + 340,000 + 200,000 = 1,200,000. In USD: 1,200,000 + 30,000,000 / 150 = 1,400,000.
  assert.deepEqual(amounts(g.lines.cash), { USD: 1_200_000, JPY: 30_000_000 });
  assert.equal(g.lines.cash.rc, 1_400_000);
  // Positions: 1,000 ALFA at 50 = 50,000 USD, and the same amount payable until settlement.
  assert.deepEqual(amounts(g.lines.positions), { USD: 50_000 });
  assert.deepEqual(amounts(g.lines.payable), { USD: 50_000 });
  // Cash borrowed: 200,000 USD and 30,000,000 JPY = 200,000 + 200,000 = 400,000 USD.
  assert.deepEqual(amounts(g.lines.borrowed), { USD: 200_000, JPY: 30_000_000 });
  assert.equal(g.lines.borrowed.rc, 400_000);
  // Assets 1,400,000 + 50,000 = 1,450,000. Liabilities 50,000 + 400,000 = 450,000. Net assets 1,000,000.
  assert.equal(g.assets.rc, 1_450_000);
  assert.equal(g.liabilities.rc, 450_000);
  assert.equal(g.netAssets.rc, 1_000_000);
  // Funding: Alpha 500,000 - 40,000 = 460,000; Beta 300,000 + 40,000 = 340,000; Gamma 200,000; Delta 0.
  // The 40,000 between Alpha and Beta cancels, leaving exactly what Treasury advanced: 1,000,000.
  const internal = bs.representedBy.find((r) => r.key === 'internal');
  assert.deepEqual([alpha, beta, gamma, delta].map((u) => internal.cells[u.id].rc), [460_000, 340_000, 200_000, 0]);
  assert.deepEqual(amounts(g.representedBy.internal), { USD: 1_000_000 });
  assert.equal(internal.cells[treasury.id].rc, -1_000_000);
  // No external capital in the Accounts and nothing earned or lost yet: 1,000,000 - 0 - 1,000,000 = 0.
  assert.equal(g.representedBy.capital.rc, 0);
  assert.equal(g.representedBy.results.rc, 0);
  for (const [key, , , cell] of rows(bs)) assert.equal(cell.complete, true, `${key} has every conversion rate`);

  // The Book total is untouched by the grouping: Treasury 1,000,000 USD cash, Accounts 1,400,000, liabilities 450,000.
  assert.equal(bs.lines.find((l) => l.key === 'cash').total.rc, 2_400_000);
  assert.equal(bs.netAssets.total.rc, 2_000_000);
});

test('the Accounts-combined column equals what an Accounts-only scope reports, at every scope', async () => {
  const { app, book, treasury, alpha, beta, gamma } = await manyAccounts();
  const same = (withGroup, only) => {
    const g = withGroup.accountsCombined;
    for (const l of withGroup.lines) {
      const there = only.lines.find((x) => x.key === l.key);
      // A line the Accounts have nothing on is absent from the Accounts-only sheet, and empty in the combined column.
      if (there) assert.deepEqual(g.lines[l.key], there.total, `line ${l.key}`);
      else assert.deepEqual(g.lines[l.key], { rc: 0, complete: true, byCurrency: [] }, `line ${l.key} is empty`);
    }
    for (const l of only.lines) assert.ok(g.lines[l.key], `line ${l.key} of the Accounts-only sheet is in the combined column`);
    assert.deepEqual(g.assets, only.assets.total);
    assert.deepEqual(g.liabilities, only.liabilities.total);
    assert.deepEqual(g.netAssets, only.netAssets.total);
    for (const r of only.representedBy) assert.deepEqual(g.representedBy[r.key], r.total, `represented by ${r.key}`);
  };
  same(app.accounting.balanceSheet(book.id, 'book'), app.accounting.balanceSheet(book.id, 'accounts'));
  // Treasury with two of the Accounts: the combined column is those two Accounts, nothing else.
  const part = app.accounting.balanceSheet(book.id, [treasury.id, alpha.id, beta.id].join(','));
  assert.deepEqual([...part.accountsCombined.members].sort(), [alpha.id, beta.id].sort());
  same(part, app.accounting.balanceSheet(book.id, [alpha.id, beta.id].join(',')));
  // Accounts only: the combined column is the scope total itself.
  const three = app.accounting.balanceSheet(book.id, [alpha.id, beta.id, gamma.id].join(','));
  same(three, three);
  // One Account, or Treasury alone: nothing to combine.
  assert.equal(app.accounting.balanceSheet(book.id, alpha.id).accountsCombined, null);
  assert.equal(app.accounting.balanceSheet(book.id, 'treasury').accountsCombined, null);
  assert.equal(app.accounting.balanceSheet(book.id, [treasury.id, alpha.id].join(',')).accountsCombined, null);
});

test('every line adds up: Treasury plus the Accounts combined plus eliminations is the total, in each currency', async () => {
  const { app, book, treasury } = await manyAccounts();
  const check = (bs) => {
    const g = bs.accountsCombined;
    for (const [key, cells, total, combined] of rows(bs)) {
      if (key === 'results') continue; // derived in the reporting currency only; checked below
      const sum = new Map();
      const add = (cell, sign = 1) => { for (const x of cell.byCurrency) sum.set(x.ccy, (sum.get(x.ccy) || 0) + sign * x.amount); };
      if (cells[treasury.id]) add(cells[treasury.id]);
      add(combined);
      // The members add up to the combined column.
      const members = new Map();
      for (const id of g.members) for (const x of cells[id].byCurrency) members.set(x.ccy, (members.get(x.ccy) || 0) + x.amount);
      assert.deepEqual(Object.fromEntries([...members].filter(([, a]) => a !== 0)), amounts(combined), `${key}: members add up to the combined column`);
      // Internal funding is the one eliminated line: what is left after the elimination is the total.
      const elim = bs.representedBy.find((r) => r.key === key)?.elimination;
      if (elim) for (const x of elim.byCurrency) sum.set(x.ccy, (sum.get(x.ccy) || 0) + x.amount);
      assert.deepEqual(Object.fromEntries([...sum].filter(([, a]) => a !== 0)), amounts(total), `${key}: columns add up to the total`);
    }
    // Results to date: net assets less capital less internal funding, in each column and in the combined column.
    const [capital, internal, results] = bs.representedBy;
    assert.equal(g.representedBy.results.rc, g.netAssets.rc - g.representedBy.capital.rc - g.representedBy.internal.rc);
    assert.equal(results.total.rc, bs.netAssets.total.rc - capital.total.rc - internal.total.rc);
  };
  check(app.accounting.balanceSheet(book.id, 'book'));
  check(app.accounting.balanceSheet(book.id, 'accounts'));
});

test('a missing conversion rate makes the combined cell incomplete too, with its local amounts kept', () => {
  // No market connection and no rate entered by hand: JPY cannot be converted into USD.
  const { app } = makeApp({ demo: false });
  const book = app.books.createBook({ name: 'No rates', reportingCcy: 'USD' });
  const treasury = app.books.treasuryOf(book.id);
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'USD', amount: 1_000_000 });
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'JPY', amount: 50_000_000 });
  const [a, b, c] = ['One', 'Two', 'Three'].map((name) => app.books.createAccount(book.id, { name }));
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: a.id, ccy: 'USD', amount: 100_000 });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: b.id, ccy: 'USD', amount: 50_000 });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: b.id, ccy: 'JPY', amount: 10_000_000 });
  const bs = app.accounting.balanceSheet(book.id, 'book');
  const cash = bs.lines.find((l) => l.key === 'cash');
  assert.equal(cash.cells[a.id].complete, true);
  assert.equal(cash.cells[b.id].complete, false);
  assert.equal(cash.cells[c.id].complete, true);
  const g = bs.accountsCombined;
  // 100,000 + 50,000 USD is known; the 10,000,000 JPY has no rate, so the cell has no final USD figure.
  assert.deepEqual(amounts(g.lines.cash), { USD: 150_000, JPY: 10_000_000 });
  assert.equal(g.lines.cash.complete, false);
  assert.equal(g.assets.complete, false);
  assert.equal(g.netAssets.complete, false);
  assert.equal(g.representedBy.internal.complete, false);
  assert.equal(g.representedBy.results.complete, false);
  assert.deepEqual(g, (() => { const only = app.accounting.balanceSheet(book.id, 'accounts'); return { members: g.members, lines: Object.fromEntries(only.lines.map((l) => [l.key, l.total])), assets: only.assets.total, liabilities: only.liabilities.total, netAssets: only.netAssets.total, representedBy: Object.fromEntries(only.representedBy.map((r) => [r.key, r.total])) }; })());
});
