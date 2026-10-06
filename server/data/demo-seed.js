// Seeds the isolated demo database with the fictional demo instruments and one funded Book.
// Runs once, only in demo mode (and in tests). The real paper database is never seeded.

import { thirdFriday } from '../quant/calendar.js';
import { ymd } from '../quant/dates.js';
import { DEMO_BONDS, DEMO_FUTURES, DEMO_UNIVERSE } from './demo.js';

export function seedDemoInstruments(app) {
  const have = new Set(app.instruments.list({ limit: 2000 }).map((i) => i.symbol));
  const out = {};
  for (const u of DEMO_UNIVERSE) {
    if (have.has(u.symbol)) { out[u.symbol] = app.instruments.list({ q: u.symbol }).find((i) => i.symbol === u.symbol); continue; }
    out[u.symbol] = app.instruments.create({
      productId: u.product, name: u.name, symbol: u.symbol, marketView: u.view, venue: u.venue, venueType: 'exchange', domicile: u.domicile || null, underlyingGeo: u.underlyingGeo || u.domicile || null,
      issuer: u.name.replace(' (demo)', ''), tradingCcy: u.ccy, terms: u.lot ? { lotSize: u.lot } : {}, refSource: 'demo',
    }, { actor: 'demo' });
  }
  for (const [pair, view] of [['EUR/USD', 'FOREIGN_CASH'], ['GBP/USD', 'FOREIGN_CASH'], ['USD/JPY', 'FOREIGN_CASH']]) {
    if (have.has(pair)) { out[pair] = app.instruments.list({ family: 'fx' }).find((i) => i.symbol === pair); continue; }
    const [base, quote] = pair.split('/');
    out[pair] = app.instruments.create({ productId: 'fx_spot', name: `${pair} spot (demo)`, symbol: pair, marketView: view, venueType: 'otc', tags: ['US_CASH'], tradingCcy: quote, terms: { base, quote, settleDays: 2 }, refSource: 'demo' }, { actor: 'demo' });
  }
  for (const [sym, b] of Object.entries(DEMO_BONDS)) {
    if (have.has(sym)) { out[sym] = app.instruments.list({ family: 'bond' }).find((i) => i.symbol === sym); continue; }
    out[sym] = app.instruments.create({ productId: b.product, name: b.name, symbol: sym, marketView: b.view, venueType: 'otc', issuer: b.name.split(' 4')[0].split(' 5')[0], domicile: 'US', tradingCcy: b.ccy, terms: b.terms, refSource: 'demo' }, { actor: 'demo' });
  }
  const today = app.clock.today();
  const { y } = ymd(today);
  for (const [root, spec] of Object.entries(DEMO_FUTURES)) {
    const exps = [];
    for (let yy = y; exps.length < 3 && yy < y + 3; yy++) for (const mm of [3, 6, 9, 12]) { const tf = thirdFriday(yy, mm); if (tf > today && exps.length < 3) exps.push(tf); }
    for (const exp of exps) {
      const symbol = `${root} ${exp.slice(0, 7)}`;
      if (have.has(symbol)) { out[symbol] = app.instruments.list({ family: 'future' }).find((i) => i.symbol === symbol); continue; }
      const und = out[spec.underlying];
      out[symbol] = app.instruments.create({
        productId: 'equity_index_future', name: `${spec.name} ${exp.slice(0, 7)}`, symbol, marketView: spec.view, venue: spec.venue, venueType: 'exchange', underlyingId: und?.id || null,
        tradingCcy: spec.ccy, multiplier: spec.multiplier, terms: { root, expiration: exp, tickSize: spec.tickSize, initialMargin: spec.initialMargin, settlement: spec.settlement, priceUnits: 'index points' }, refSource: 'demo',
      }, { actor: 'demo' });
    }
  }
  return out;
}

export function seedDemoBook(app) {
  if (app.books.listBooks().length) return null;
  const book = app.books.createBook({ name: 'Demo Book', reportingCcy: 'USD' });
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'USD', amount: 5000000, note: 'Demo starting capital' });
  const eq = app.books.createAccount(book.id, { name: 'Equity Long/Short' });
  const macro = app.books.createAccount(book.id, { name: 'Global Macro' });
  const tr = app.books.treasuryOf(book.id);
  app.books.transfer({ bookId: book.id, fromUnitId: tr.id, toUnitId: eq.id, ccy: 'USD', amount: 1500000, purpose: 'Initial funding' });
  app.books.transfer({ bookId: book.id, fromUnitId: tr.id, toUnitId: macro.id, ccy: 'USD', amount: 1000000, purpose: 'Initial funding' });
  return app.books.getBook(book.id);
}

export function seedDemoWatchlists(app, insts) {
  for (const view of ['US_CASH', 'US_DERIV', 'FOREIGN_CASH', 'FOREIGN_DERIV']) {
    const lists = app.instruments.watchlists(view);
    if (lists[0].items.length) continue;
    for (const i of Object.values(insts)) {
      if (i && i.market_view === view) app.instruments.addToWatchlist(lists[0].id, i.id);
    }
  }
}
