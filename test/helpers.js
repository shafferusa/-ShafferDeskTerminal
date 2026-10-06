// Test harness: an in-memory Terminal on the deterministic demo feed with a controllable clock.

import { createApp } from '../server/app.js';
import { createClock } from '../server/core/clock.js';
import { seedDemoInstruments } from '../server/data/demo-seed.js';

export const START = '2026-03-02T15:00:00.000Z'; // Monday 10:00 New York

export function makeApp({ demo = true, at = START } = {}) {
  const clock = createClock();
  clock.freeze(at);
  const config = {
    demo, host: '127.0.0.1', port: 0, dataDir: ':memory:', dbFile: ':memory:', password: '',
    connectionEnv: {}, credentials: { header: 'Authorization', token: '', hasToken: false }, engine: { autoStart: false },
  };
  const app = createApp({ config, clock });
  const inst = demo ? seedDemoInstruments(app) : {};
  return { app, clock, inst };
}

/** A funded Book with one Account. */
export function makeBook(app, { cash = 1_000_000, account = 500_000, name = 'Test Book' } = {}) {
  const book = app.books.createBook({ name, reportingCcy: 'USD' });
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'USD', amount: cash });
  const acct = app.books.createAccount(book.id, { name: 'Alpha' });
  const treasury = app.books.treasuryOf(book.id);
  if (account) app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: 'USD', amount: account, purpose: 'test funding' });
  return { book: app.books.getBook(book.id), acct, treasury };
}

/** Preview then confirm a package; returns the strategy view. */
export async function trade(app, input) {
  const pv = await app.packages.preview(input);
  if (pv.blocking) {
    const err = new Error(`Preview blocked: ${pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | ')}`);
    err.preview = pv;
    throw err;
  }
  const r = await app.packages.submit({ ...input, legs: pv.legs, clientToken: pv.token, confirm: true });
  return r.strategy;
}

/** Sum of every ledger entry: must be zero per unit per currency. */
export function ledgerImbalance(app) {
  return app.db.all('SELECT unit_id, ccy, ROUND(SUM(amount), 4) AS s FROM entries GROUP BY unit_id, ccy HAVING ABS(SUM(amount)) > 0.005');
}

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

/** Advance the clock and run engine cycles, like leaving the Terminal running. */
export async function advance(app, clock, ms, { ticks = 1 } = {}) {
  clock.advance(ms);
  let last;
  for (let i = 0; i < ticks; i++) last = await app.engine.tick();
  return last;
}

/** Jump to a wall-clock instant and run one cycle. */
export async function goTo(app, clock, iso) {
  clock.freeze(iso);
  return app.engine.tick();
}
