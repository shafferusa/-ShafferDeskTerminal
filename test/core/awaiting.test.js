import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance } from '../helpers.js';

// The real (non-demo) Terminal before the Shaffer services are connected.
function live() {
  const t = makeApp({ demo: false });
  const { app } = t;
  const stock = app.instruments.create({ productId: 'common_stock', name: 'Example Corp', symbol: 'EXMP', marketView: 'US_CASH', venue: 'NYSE', venueCountry: 'US', tradingCcy: 'USD' });
  return { ...t, stock };
}

test('until connected, both ports report awaiting and nothing is fabricated', async () => {
  const { app, stock } = live();
  const d = app.data.describe();
  assert.equal(d.mode, 'shaffer');
  assert.equal(d.market.connection, 'awaiting');
  assert.equal(d.analytics.connection, 'awaiting');
  assert.equal(d.market.message, 'Awaiting Shaffer data connection');
  assert.ok(Object.values(d.market.datasets).every((x) => x.state === 'awaiting'));
  assert.ok(Object.values(d.analytics.datasets).every((x) => x.state === 'awaiting'));
  await app.data.refresh({ instruments: [stock], pairs: ['EUR/USD'], rateCodes: ['SOFR'] });
  assert.equal(app.data.price(stock.id), null, 'a missing price is null, never zero');
  assert.equal(app.data.fx('EUR', 'USD'), null);
  assert.equal(app.data.rate('SOFR'), null);
  assert.equal(app.data.borrowInfo(stock.id), null);
  assert.deepEqual(await app.data.market.search('apple'), { available: false, reason: 'awaiting-connection', message: 'Awaiting Shaffer data connection' });
  assert.equal((await app.data.analytics.signals({})).available, false);
  assert.equal((await app.data.analytics.instrumentAnalytics([stock])).get(stock.id), null);
  assert.equal((await app.data.analytics.hedge({})).available, false);
});

test('service addresses and refresh timings are configurable; credentials never leave the server', () => {
  const { app } = live();
  assert.throws(() => app.data.saveConnection({ marketDataUrl: 'not a url' }), /not a valid address/);
  assert.throws(() => app.data.saveConnection({ marketDataUrl: 'https://user:secret@md.example' }), /Do not put credentials/);
  app.data.saveConnection({ marketDataUrl: 'https://marketdata.shaffer.internal/api', analyticsUrl: 'https://lab.shaffer.internal' });
  app.data.saveRefresh({ quotesMs: 2000, engineTickMs: 1500 });
  const d = app.data.describe();
  assert.equal(d.connection.marketDataUrl, 'https://marketdata.shaffer.internal/api');
  assert.equal(d.refresh.quotesMs, 2000);
  assert.equal(JSON.stringify(d).includes('token'), false);
  // An address alone does not make the feed live: no contract has been supplied.
  assert.equal(d.market.connection, 'awaiting');
  assert.match(d.market.message, /service contract not yet supplied/);
});

test('without data a package can be previewed but nothing fills at an invented price', async () => {
  const { app, clock, stock } = live();
  const { book, acct } = makeBook(app);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, quantity: 100 });
  assert.equal(pv.legs[0].price.estimate, null);
  assert.equal(pv.legs[0].price.missing, true);
  assert.match(pv.checks.find((c) => c.code === 'no-price').message, /Awaiting Shaffer data connection/);
  assert.equal(pv.legs[0].cash, undefined, 'no cash figure is made up');
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, quantity: 100, legs: pv.legs, clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.orders[0].status, 'working');
  assert.match(r.strategy.orders[0].statusReason, /Awaiting Shaffer data connection: no price/);
  await advance(app, clock, 60_000, { ticks: 3 });
  assert.equal(app.packages.strategyView(r.strategy.id).orders[0].filledQty, 0);
  assert.equal(app.ledger.cash(acct.id, 'USD').settled, 500_000);
});

test('a manually entered price is labelled manual, drives a manual-mark fill, and is preserved on the fill', async () => {
  const { app, stock } = live();
  const { book, acct } = makeBook(app);
  const obs = app.data.enterManual({ kind: 'price', subject: stock.id, bid: 49.9, ask: 50.1, currency: 'USD', units: 'per share', note: 'broker screen' });
  assert.equal(obs.status, 'manual');
  assert.equal(obs.source, 'Manual entry');
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, quantity: 100 });
  const fill = s.orders[0].fills[0];
  assert.equal(fill.model, 'manual-mark');
  assert.equal(fill.price, 50.1);
  assert.equal(fill.priceObservation.id, obs.id, 'the exact manual observation used is kept with the fill');
  // A later manual price supersedes the first for valuation, but the fill still points at the original.
  app.data.enterManual({ kind: 'price', subject: stock.id, value: 55, currency: 'USD' });
  const pos = app.accounting.openPositions(book.id, acct.id).positions[0];
  assert.equal(pos.price, 55);
  assert.equal(pos.priceObs.status, 'manual');
  assert.equal(pos.priceObs.statusLabel, 'Manually entered');
  assert.equal(app.packages.strategyView(s.id).orders[0].fills[0].priceObservation.ask, 50.1);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM observations WHERE subject = ?', stock.id).n, 2, 'both entries are retained');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('unpriced positions and missing FX are reported as missing, and NAV is flagged incomplete', async () => {
  const { app, stock } = live();
  const { book, acct } = makeBook(app);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: stock.id, qty: 100, statedPrice: 40 }] });
  const op = app.accounting.openPositions(book.id, acct.id);
  assert.equal(op.positions[0].price, null);
  assert.equal(op.positions[0].mv, null);
  assert.equal(op.positions[0].unrealized, null);
  assert.equal(op.positions[0].missingReason, 'Awaiting Shaffer data connection');
  assert.equal(op.nav.complete, false);
  assert.equal(op.nav.unpriced.length, 1);
  assert.equal(op.nav.value, 500_000, 'the unpriced position is carried at cost, and says so');
  const pnl = app.accounting.pnl(book.id, acct.id);
  assert.equal(pnl.unrealized.complete, false);
  assert.equal(pnl.complete, false);
  // A foreign-currency deposit with no FX rate: local balance is known, USD equivalent is not.
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'EUR', amount: 1000 });
  const bookNav = app.accounting.overview(book.id);
  assert.equal(bookNav.navComplete, false);
  assert.deepEqual(bookNav.fxMissing, ['EUR']);
  app.data.enterManual({ kind: 'fx', subject: 'EUR/USD', value: 1.1 });
  assert.equal(app.accounting.overview(book.id).fxMissing.length, 0);
});

test('a short needs borrow data or a stated assumption; neither is assumed', async () => {
  const { app, stock } = live();
  const { book, acct } = makeBook(app);
  app.data.enterManual({ kind: 'price', subject: stock.id, value: 50, currency: 'USD' });
  const base = { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: stock.id, quantity: 100 };
  const pv = await app.packages.preview(base);
  assert.ok(pv.blocking);
  assert.match(pv.checks.find((c) => c.code === 'borrow-unknown').message, /no borrow availability data.*Awaiting Shaffer data connection.*State a borrow assumption/i);
  const s = await trade(app, { ...base, borrow: { available: true, feeRate: 0.01 } });
  assert.equal(s.status, 'open');
  assert.match(s.orders[0].fills[0].note, /Stated assumption \(manually entered\)/);
});

test('analytics fields stay missing; fair value is never used as a price', async () => {
  const { app, stock } = live();
  const m = await app.data.analytics.instrumentAnalytics([stock]);
  assert.equal(m.get(stock.id), null);
  // Even if a model valuation arrives for an OTC instrument it is a mark, not an executable quote.
  const { book, acct } = makeBook(app);
  app.data._cache.set(`mark|${stock.id}`, { kind: 'price', subject: stock.id, value: 77, bid: null, ask: null, status: 'model-derived', source: 'Shaffer Analytics Lab', providerId: 'shaffer-analytics', asOf: app.clock.now().toISOString(), receivedAt: app.clock.now().toISOString(), assumptions: [], extra: {} });
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: stock.id, quantity: 10 });
  assert.equal(pv.legs[0].price.executable, false);
  assert.match(pv.legs[0].price.reason, /model-derived value.*not an executable quote/);
});

// ---- server client (docs/SERVER-CLIENT.md): every dataset awaits until the contract is supplied ----------------

test('server client: every dataset of the market and analytics interfaces reports awaiting with its operation name', async () => {
  const { app, stock } = live();
  const { SERVER_DATASETS } = await import('../../server/data/ports.js');
  const book = makeBook(app).book;
  const S = app.data.server;
  const paramsFor = (ds) => ({ search: { q: 'EXMP' }, quotes: { instruments: [stock] }, fx: { pairs: ['EUR/USD'] }, rates: { codes: ['SOFR'] }, documents: { docId: 'D1' }, ledger: { instrument: stock, bookId: book.id } }[ds] || { instrument: stock });
  for (const [ds, def] of Object.entries(SERVER_DATASETS)) {
    const env = await S.call(ds, paramsFor(ds), { requestId: `r-${ds}` });
    if (def.interface === 'ledger') {
      assert.equal(env.state, 'available', 'the paper ledger is local and always answers');
      assert.equal(env.source.kind, 'terminal-ledger');
      continue;
    }
    assert.equal(env.state, 'awaiting', ds);
    assert.equal(env.operation, def.operation);
    assert.ok(env.message.startsWith('Awaiting Shaffer data connection'), env.message);
    assert.ok(env.message.includes(def.operation), `the message names ${def.operation}`);
    assert.equal(env.requestId, `r-${ds}`);
    assert.equal(env.items, undefined, 'nothing is fabricated');
    assert.equal(env.data, undefined);
  }
  const st = S.state();
  assert.equal(st.mode, 'shaffer');
  for (const [ds, d] of Object.entries(st.datasets)) if (d.interface !== 'ledger') assert.equal(d.state, 'awaiting', ds);
});

test('server client: an address without a contract mapping still awaits, and no request leaves the Terminal', async () => {
  const { app, stock } = live();
  app.data.saveConnection({ gatewayUrl: 'https://gateway.shaffer.internal/api' });
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; throw new Error('no network in tests'); };
  try {
    const env = await app.data.server.call('statements', { instrument: stock, statement: 'income', period: 'annual' });
    assert.equal(env.state, 'awaiting');
    assert.match(env.message, /market\.statements: not yet mapped in shaffer-contract\.js/);
    const an = await app.data.server.call('analytics', { instrument: stock, strategyId: 'SP3E' });
    assert.match(an.message, /analytics\.instrumentAnalytics: not yet mapped/);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = orig;
  }
  // The credential never appears in any state the browser can read
  assert.equal(JSON.stringify(app.data.server.state()).includes('secret'), false);
});
