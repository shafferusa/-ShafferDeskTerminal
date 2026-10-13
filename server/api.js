// HTTP API used by the Terminal's screens.
//
// Screens never talk to a data service directly: every market fact and analytics output comes
// through app.data (the single data adapter), and every paper-accounting operation goes through
// the core modules. Service credentials never appear in any response.

import { FAMILIES, MARKET_TABS, MARKET_VIEWS, ASSET_CLASSES, ROUTING_BASES, catalogSummary, conventionRoute, getProduct, routingText, tabOf } from './core/catalog.js';
import { BOOK_DEFAULTS } from './core/defaults.js';
import { createIntegrity } from './core/integrity.js';
import { ACCOUNTS } from './core/ledger.js';
import { resolveSettlement, tradingDay } from './core/settlement.js';
import { TEMPLATES } from './core/templates.js';
import { AppError, isZero, need, num } from './core/util.js';
import { createFixtureControls } from './data/demo.js';
import { STATUS_LABEL } from './data/observation.js';
import { guardRepeats } from './http/once.js';
import { createRouter } from './http/router.js';
import { CALENDARS, COUNTRY_CALENDAR, CURRENCY_CALENDAR, getExtraHolidays, holidaysOf, setExtraHolidays } from './quant/calendar.js';
import { setBasketLevel } from './products/swap-partial.js'; // s3: basket level entered on a swap payment item

export function createApi(app) {
  // Every mutating route below takes an optional client token (body `clientToken` or the Idempotency-Key header):
  // the same request sent again under the same token is answered from the first one and does nothing (http/once.js).
  const r = guardRepeats(createRouter(), app);
  const { db, books, instruments, positions } = app;
  const lastQuoteRefresh = new Map();
  const analyticsCache = new Map();

  async function freshQuotes(insts) {
    const now = app.clock.ms();
    const maxAge = app.data.getRefresh().quotesMs;
    const stale = insts.filter((i) => now - (lastQuoteRefresh.get(i.id) || 0) >= maxAge * 0.9);
    if (stale.length) {
      const und = stale.map((i) => (i.underlying_id ? instruments.get(i.underlying_id) : null)).filter(Boolean);
      const otc = stale.filter((i) => ['swap', 'cds', 'forward', 'otcoption', 'bond'].includes(i.family));
      await app.data.refresh({ instruments: [...stale, ...und], sessions: stale, valuations: otc });
      for (const i of stale) lastQuoteRefresh.set(i.id, now);
    }
  }

  // `strategyId` (optional): the investment Strategy the fair values are asked for. It is passed to Analytics Lab as a
  // second argument and cached apart; a service that ignores it answers as before.
  async function analyticsFor(insts, strategyId = null) {
    const now = app.clock.ms();
    const maxAge = app.data.getRefresh().analyticsMs;
    const key = (i) => (strategyId ? `${i.id}|${strategyId}` : i.id);
    const need2 = insts.filter((i) => !analyticsCache.has(key(i)) || now - analyticsCache.get(key(i)).at >= maxAge);
    if (need2.length) {
      const m = strategyId ? await app.data.analytics.instrumentAnalytics(need2, { strategyId }) : await app.data.analytics.instrumentAnalytics(need2);
      for (const i of need2) analyticsCache.set(key(i), { at: now, value: m.get(i.id) ?? null });
    }
    return new Map(insts.map((i) => [i.id, analyticsCache.get(key(i))?.value ?? null]));
  }

  const touchStrategy = (sid) => { if (sid) { app.packages.recomputeHolds(sid); app.packages.refreshStrategy(sid); } };

  // ---- status and data connection -------------------------------------------------------------------
  r.get('/api/status', () => ({
    name: 'Shaffer Desk Terminal', version: '0.1.0', demo: app.config.demo, now: app.clock.now().toISOString(), today: app.clock.today(), clockSimulated: app.clock.simulated,
    data: app.data.describe(), engine: app.engine.status(), statusLabels: STATUS_LABEL, marketViews: MARKET_VIEWS, families: FAMILIES, accounts: ACCOUNTS, calendars: CALENDARS,
    counts: { books: db.get('SELECT COUNT(*) AS n FROM books').n, instruments: db.get('SELECT COUNT(*) AS n FROM instruments').n },
    simulatedOnly: 'All orders, borrowing, lending, funding, collateral movements and settlements are simulated. This Terminal does not connect to real-money execution.',
  }));
  // demoHedgeFixture: whether the canned demo hedge fixture answers hedge requests (demo mode only; null otherwise).
  // hedgeService: who answers hedge requests right now (kind, label, reachable), stated apart from the Analytics Lab connection.
  r.get('/api/data', () => ({ ...app.data.describe(), demoHedgeFixture: app.config.demo ? Boolean(app.data.getSetting('demo.hedgeFixture', true)) : null, hedgeService: app.hedge.serviceStatus() }));
  r.put('/api/data/connection', ({ body }) => { app.data.saveConnection(body); return app.data.describe(); });
  r.put('/api/data/refresh', ({ body }) => { app.data.saveRefresh(body); return app.data.describe(); });
  r.post('/api/data/test', async ({ body }) => {
    const port = body.port === 'analytics' ? app.data.analytics : app.data.market;
    return { port: body.port === 'analytics' ? 'analytics' : 'market', result: await port.testConnection(), data: app.data.describe() };
  });

  r.get('/api/catalog', () => catalogSummary());

  // ---- settlement calendars ----------------------------------------------------------------------------
  const calendarsView = () => {
    const y = Number(app.clock.today().slice(0, 4));
    const extra = getExtraHolidays();
    return {
      year: y, currencyCalendars: CURRENCY_CALENDAR, countryCalendars: COUNTRY_CALENDAR,
      calendars: Object.values(CALENDARS).map((c) => ({ ...c, holidays: ['WEEKEND', 'ALLDAYS'].includes(c.id) ? [] : [...holidaysOf(c.id, y), ...holidaysOf(c.id, y + 1)], extra: extra[c.id] || [] })),
      note: 'Rule-based calendars. One-off closures are not known to them: add those as extra holidays. Shaffer MarketData replaces these when it supplies market calendars.',
    };
  };
  r.get('/api/calendars', () => calendarsView());
  r.put('/api/calendars/:id/holidays', ({ params, body }) => {
    need(CALENDARS[params.id] && params.id !== 'ALLDAYS', 'Unknown calendar.', { status: 404 });
    const dates = [...new Set((body.dates || []).map((d) => String(d).trim()).filter(Boolean))].sort();
    // A real calendar date: 2026-02-31 parses, but does not survive a round trip.
    for (const d of dates) need(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, `"${d}" is not a date in the form YYYY-MM-DD.`);
    const all = { ...getExtraHolidays(), [params.id]: dates };
    if (!dates.length) delete all[params.id];
    app.data.setSetting('calendars.extraHolidays', all);
    setExtraHolidays(all);
    return calendarsView();
  });
  // Read-only: the default paper-desk assumptions, so Settings can show which values a Book has changed.
  r.get('/api/defaults', () => ({ book: BOOK_DEFAULTS }));
  r.get('/api/templates', () => ({ templates: TEMPLATES, hedge: { objectives: app.hedge.objectives(), scopes: app.hedge.scopes(), families: app.hedge.families() } }));

  // ---- instruments ---------------------------------------------------------------------------------------
  /**
   * What a Book currently holds, by instrument: { instrumentId -> { net, long, short, units: [{unitId, name, kind, qty, long, short}] } }.
   * Shown wherever a ticker is typed, so a holding can be checked without leaving the ticket.
   */
  function holdingsOf(bookId) {
    const out = new Map();
    const book = bookId ? books.getBook(bookId) : null;
    if (!book) return out;
    const names = new Map(book.units.map((u) => [u.id, u]));
    for (const p of positions.list({ unitIds: book.units.map((u) => u.id) })) {
      if (isZero(p.qty)) continue;
      const h = out.get(p.instrument_id) || { net: 0, long: 0, short: 0, units: [] };
      h.net += p.qty;
      if (p.qty > 0) h.long += p.qty; else h.short += -p.qty;
      const u = names.get(p.unit_id);
      let row = h.units.find((x) => x.unitId === p.unit_id);
      if (!row) { row = { unitId: p.unit_id, name: u.kind === 'treasury' ? 'Treasury' : u.name, kind: u.kind, qty: 0, long: 0, short: 0 }; h.units.push(row); }
      row.qty += p.qty;
      if (p.qty > 0) row.long += p.qty; else row.short += -p.qty;
      out.set(p.instrument_id, h);
    }
    return out;
  }
  const withHoldings = (bookId) => {
    const held = holdingsOf(bookId);
    return (inst) => ({ ...instruments.toView(inst), holdings: bookId ? held.get(inst.id) || null : undefined });
  };

  // A contract written for one Book (a loan, a repo, a securities loan, a swap or other OTC contract under that
  // Book's collateral terms) is that Book's own record although it sits in the registry. A list, a search or a
  // page asked for on behalf of another Book does not show it. A contract nobody has traded yet is open to all.
  const BOOK_CONTRACT_FAMILIES = new Set(['loan', 'repo', 'secloan', 'swap', 'cds', 'forward', 'otcoption']);
  const ofAnotherBook = (inst, bookId) => {
    if (!bookId || !BOOK_CONTRACT_FAMILIES.has(inst.family)) return false;
    const owners = db.all('SELECT book_id FROM orders WHERE instrument_id = ? UNION SELECT book_id FROM positions WHERE instrument_id = ?', inst.id, inst.id).map((x) => x.book_id);
    return owners.length > 0 && !owners.includes(bookId);
  };
  const visibleTo = (bookId) => (inst) => !ofAnotherBook(inst, bookId);
  const requireVisible = (id, bookId) => {
    const inst = instruments.require(id);
    need(!ofAnotherBook(inst, bookId), 'This contract belongs to another Book.', { status: 404 });
    return inst;
  };

  // `marketplace=1` adds the contract facts a Marketplace row shows that are not in the registry row: a bond's accrued
  // interest per 100 face to today, worked out by the bond engine from the coupon schedule (contract arithmetic, not a
  // valuation). `tab` keeps only one product-family tab (catalog.js MARKET_TABS).
  const bondPlugin = () => app.products.get('bond');
  const marketFacts = (inst) => {
    if (inst.family !== 'bond') return null;
    let ai = null;
    try { ai = bondPlugin().accruedAmount(inst, 100, app.clock.today()); } catch { ai = null; }
    return { accruedPer100: Number.isFinite(ai) ? ai : null, accruedAsOf: app.clock.today() };
  };
  r.get('/api/instruments', ({ query }) => ({
    items: instruments.list({ view: query.view, family: query.family, productId: query.productId, q: query.q, underlyingId: query.underlyingId, includeArrangements: query.arrangements === '1', limit: query.limit })
      .filter((i) => !query.tagView || i.market_view === query.tagView || i.tags.includes(query.tagView)).filter(visibleTo(query.bookId))
      .filter((i) => !query.tab || tabOf(i.product_id) === query.tab)
      .map((i) => { const v = withHoldings(query.bookId)(i); return query.marketplace === '1' ? { ...v, market: marketFacts(i) } : v; }),
  }));
  /**
   * What the routing convention gives a draft, before it is registered (the registration form shows it):
   * { view, basis, text } or { view: null, reason } when the view must be chosen by hand.
   */
  r.get('/api/instruments/routing', ({ query }) => {
    const product = getProduct(query.productId);
    need(product, 'Choose a product type from the catalog.');
    const und = query.underlyingId ? instruments.get(query.underlyingId) : null;
    const facts = { product, venueType: query.venueType || 'exchange', venueCountry: query.venueCountry || null, jurisdiction: query.jurisdiction || null, domicile: query.domicile || null, underlying: und, requestedView: query.marketView || null };
    const conv = conventionRoute(facts);
    if (!conv) return { view: null, basis: null, reason: `${product.name} is exchange-listed but no listing-venue country is recorded. Enter the venue country, state the jurisdiction, or choose the view by hand.` };
    return { view: conv.view, basis: conv.basis, basisLabel: ROUTING_BASES[conv.basis], text: routingText({ ...conv, venue: query.venue, venueCountry: facts.venueCountry, jurisdiction: facts.jurisdiction, domicile: facts.domicile, underlying: und, family: product.family, venueType: facts.venueType }) };
  });
  r.post('/api/instruments', ({ body }) => instruments.toView(instruments.create(body)));
  r.get('/api/instruments/:id', ({ params, query }) => withHoldings(query.bookId)(requireVisible(params.id, query.bookId)));
  r.put('/api/instruments/:id', ({ params, body }) => instruments.toView(instruments.update(params.id, body)));
  r.get('/api/instruments/:id/detail', async ({ params, query }) => {
    const inst = requireVisible(params.id, query.bookId);
    await freshQuotes([inst]);
    const an = await analyticsFor([inst]);
    const held = query.bookId ? app.valuation.positionsOf(books.unitsOf(query.bookId).map((u) => u.id), { instrumentId: inst.id }) : [];
    const unitName = query.bookId ? new Map(books.unitsOf(query.bookId).map((u) => [u.id, u.name])) : new Map();
    const und = inst.underlying_id ? instruments.get(inst.underlying_id) : null;
    // How a trade done today would settle in this Book: the convention (instrument, else the Book's assumption),
    // the date it gives and the settlement calendar it was counted on. The ticket shows it and may override it.
    const bookRow = query.bookId ? books.getBook(query.bookId) : null;
    // `trading`: whether the instrument's market is open today by its trading calendar. On a closed day an order
    // stays working and is matched on `trading.next`; the settlement shown is counted from that day.
    const trading = tradingDay(inst, app.clock.today());
    const stl = bookRow && !instruments.isArrangement(inst) ? resolveSettlement(app, { inst, book: bookRow, tradeDate: trading.next }) : null;
    return {
      trading,
      settlement: stl ? { tradeDate: trading.next, date: stl.date, lag: stl.lag, basis: stl.basis, label: stl.label, calendar: stl.calendar, configurable: instruments.toView(inst).settlement.configurable, reason: instruments.toView(inst).settlement.reason, maxLag: instruments.toView(inst).settlement.maxLag } : null,
      instrument: instruments.toView(inst), observation: app.data.present(app.data.price(inst.id)), underlyingObservation: und ? app.data.present(app.data.price(und.id)) : null,
      session: app.data.session(inst.id), borrow: ['equity', 'bond'].includes(inst.family) ? app.data.borrowInfo(inst.id) : null,
      analytics: an.get(inst.id), analyticsState: app.data.analytics.state(), marketState: app.data.market.state(),
      positions: held.map((p) => ({ ...p, owner: unitName.get(p.unitId), strategy: p.strategyId ? { id: p.strategyId, name: app.packages.getStrategyRow(p.strategyId)?.name } : null })),
      corporateActions: app.corpactions.list(inst.id), derivatives: instruments.list({ underlyingId: inst.id, limit: 200 }).filter(visibleTo(query.bookId)).map(instruments.toView),
      manualEntries: db.all(`SELECT id, kind, value, bid, ask, as_of, for_date, note, superseded_by FROM observations WHERE subject = ? AND origin = 'manual-entry' ORDER BY id DESC LIMIT 20`, inst.id),
    };
  });
  // Read-only: the settlement date of a trade done today, for a stated date (?date=) or lag (?lag=) or neither.
  // Returns { date, lag, basis, label, calendar, stated, standard, conflicts: [{ code, message }] }; a conflict is what the preview would block on.
  r.get('/api/instruments/:id/settlement', ({ params, query }) => {
    need(query.bookId, 'bookId is required.');
    const stated = query.date ? { date: query.date } : query.lag !== undefined && query.lag !== '' ? { lag: query.lag } : null;
    // Counted from the day an order placed now would be matched: today, or the next trading day when the market is closed today.
    const inst = instruments.require(params.id);
    const tradeDate = tradingDay(inst, app.clock.today()).next;
    return { tradeDate, ...resolveSettlement(app, { inst, book: books.requireBook(query.bookId), tradeDate, stated }) };
  });
  r.get('/api/instruments/:id/history', async ({ params, query }) => app.data.market.history(instruments.require(params.id), { from: query.from, to: query.to, interval: query.interval || '1d' }));
  r.get('/api/instruments/:id/chain', async ({ params, query }) => {
    const und = instruments.require(params.id);
    const res = await app.data.market.optionChain(und, { expiration: query.expiration });
    const registered = instruments.list({ underlyingId: und.id, family: 'option', limit: 2000 }).map(instruments.toView);
    return { ...res, registered, awaitingMessage: app.data.describe().awaitingMessage };
  });
  r.get('/api/instruments/:id/contracts', async ({ params, query }) => {
    const und = instruments.require(params.id);
    const res = await app.data.market.contracts(und, { family: query.family || 'future' });
    return { ...res, registered: instruments.list({ underlyingId: und.id, family: query.family || 'future' }).map(instruments.toView), awaitingMessage: app.data.describe().awaitingMessage };
  });

  r.get('/api/quotes', async ({ query }) => {
    const ids = String(query.ids || '').split(',').filter(Boolean).slice(0, 300);
    const insts = ids.map((id) => instruments.get(id)).filter(Boolean);
    await freshQuotes(insts);
    const an = await analyticsFor(insts, query.strategyId || null);
    const out = {};
    for (const i of insts) out[i.id] = { observation: app.data.present(app.data.price(i.id)), session: app.data.session(i.id), analytics: an.get(i.id) };
    return { quotes: out, market: app.data.market.state().connection, analytics: app.data.analytics.state().connection, awaitingMessage: app.data.describe().awaitingMessage, at: app.clock.now().toISOString() };
  });

  r.post('/api/observations', ({ body }) => {
    const obs = app.data.enterManual(body);
    app.engine.emit({ type: 'changed', summary: { manual: 1 } });
    return app.data.present(obs);
  });
  r.get('/api/observations', ({ query }) => ({
    items: db.all(`SELECT * FROM observations WHERE origin = 'manual-entry' ${query.subject ? 'AND subject = ?' : ''} ORDER BY id DESC LIMIT 200`, ...(query.subject ? [query.subject] : [])),
  }));
  r.get('/api/fx', async ({ query }) => {
    const pairs = String(query.pairs || '').split(',').filter(Boolean).slice(0, 60);
    await app.data.refresh({ pairs });
    const out = {};
    for (const p of pairs) { const [a, b] = p.split('/'); const q = app.data.fx(a, b); out[p] = q ? { rate: q.rate, observation: q.obs ? app.data.present(q.obs) : null } : null; }
    return { fx: out, awaitingMessage: app.data.describe().awaitingMessage };
  });
  r.get('/api/rates', async ({ query }) => {
    const codes = String(query.codes || '').split(',').filter(Boolean).slice(0, 40);
    await app.data.refresh({ rateCodes: codes });
    const out = {};
    for (const c of codes) out[c] = app.data.present(app.data.rate(c));
    return { rates: out, awaitingMessage: app.data.describe().awaitingMessage };
  });

  r.get('/api/search', async ({ query }) => {
    const q = String(query.q || '').trim();
    const local = q ? instruments.list({ q, view: query.view, limit: 40 }).filter(visibleTo(query.bookId)).map(instruments.toView) : [];
    const ref = q ? await app.data.market.search(q, { limit: 20, marketView: query.view }) : { available: false, reason: 'empty' };
    return { registry: local, reference: ref, awaitingMessage: app.data.describe().awaitingMessage };
  });

  // ---- watchlists ---------------------------------------------------------------------------------------------
  r.get('/api/watchlists', ({ query }) => ({ items: instruments.watchlists(query.view || 'US_CASH') }));
  r.post('/api/watchlists', ({ body }) => ({ id: instruments.createWatchlist(body) }));
  r.put('/api/watchlists/:id', ({ params, body }) => { instruments.renameWatchlist(params.id, body.name); return { ok: true }; });
  r.delete('/api/watchlists/:id', ({ params }) => { instruments.deleteWatchlist(params.id); return { ok: true }; });
  r.post('/api/watchlists/:id/items', ({ params, body }) => { instruments.addToWatchlist(params.id, body.instrumentId); return { ok: true }; });
  r.delete('/api/watchlists/:id/items/:instrumentId', ({ params }) => { instruments.removeFromWatchlist(params.id, params.instrumentId); return { ok: true }; });

  // ---- books -----------------------------------------------------------------------------------------------------
  const bookView = (b) => ({ id: b.id, name: b.name, reportingCcy: b.reporting_ccy, settings: b.settings, settingsOverrides: b.settingsOverrides, createdAt: b.created_at, units: b.units.map((u) => ({ id: u.id, name: u.name, kind: u.kind, createdAt: u.created_at })) });
  r.get('/api/books', () => ({ items: books.listBooks().map(bookView) }));
  r.post('/api/books', ({ body }) => bookView(books.createBook(body)));
  r.get('/api/books/:id', ({ params }) => ({ book: bookView(books.requireBook(params.id)), overview: app.accounting.overview(params.id) }));
  r.put('/api/books/:id', ({ params, body }) => {
    if (body.name !== undefined) books.renameBook(params.id, body.name);
    if (body.settings) books.updateSettings(params.id, body.settings);
    return bookView(books.requireBook(params.id));
  });
  r.post('/api/books/:id/accounts', ({ params, body }) => books.createAccount(params.id, body));
  r.post('/api/books/:id/capital', ({ params, body }) => books.capital({ ...body, bookId: params.id }));
  r.post('/api/books/:id/transfers', ({ params, body }) => books.transfer({ ...body, bookId: params.id }));
  r.get('/api/books/:id/treasury', async ({ params }) => { await refreshBook(params.id); return app.accounting.treasury(params.id); });
  r.get('/api/books/:id/alerts', ({ params }) => ({ items: app.alerts.open(params.id) }));
  r.post('/api/alerts/:id/dismiss', ({ params }) => { app.alerts.dismiss(Number(params.id)); return { ok: true }; });

  /** Refresh prices and FX for everything a Book holds, respecting the refresh interval. */
  async function refreshBook(bookId) {
    const book = books.requireBook(bookId);
    const ids = book.units.map((u) => u.id);
    const held = new Map();
    for (const p of positions.list({ unitIds: ids })) {
      if (isZero(p.qty)) continue;
      const i = instruments.get(p.instrument_id);
      held.set(i.id, i);
    }
    await freshQuotes([...held.values()]);
    // Currencies of ledger balances and of open positions' values (fw: a EUR contract held with no EUR cash still needs
    // a current EUR rate, or the NAV is flagged provisional on a stale one while a current rate is available).
    const ccys = new Set([...app.ledger.currencies(ids), ...[...held.values()].map((i) => i.trading_ccy).filter(Boolean)]);
    const pairs = [...ccys].filter((c) => c !== book.reporting_ccy).map((c) => `${c}/${book.reporting_ccy}`);
    // The interval is per set of pairs: a currency that has just appeared in the Book (cash received from an exchange)
    // is refreshed at once, not left on whatever observation of it happens to be cached.
    const key = `fx:${bookId}:${[...pairs].sort().join(',')}`;
    const now = app.clock.ms();
    if (pairs.length && now - (lastQuoteRefresh.get(key) || 0) >= app.data.getRefresh().fxMs * 0.9) {
      await app.data.refresh({ pairs });
      lastQuoteRefresh.set(key, now);
    }
  }

  r.get('/api/books/:id/accounting/:tab', async ({ params, query }) => {
    await refreshBook(params.id);
    const scope = query.scope || 'book';
    switch (params.tab) {
      case 'pnl': return app.accounting.pnl(params.id, scope, { from: query.from, to: query.to });
      case 'positions': return app.accounting.openPositions(params.id, scope);
      case 'balance': return app.accounting.balanceSheet(params.id, scope);
      case 'borrowings': return { scope, items: app.accounting.borrowings(params.id, scope) };
      case 'pending': return app.accounting.pending(params.id, scope);
      case 'failed': return app.accounting.failed(params.id, scope);
      case 'history': return app.accounting.history(params.id, scope, { type: query.type, q: query.q, from: query.from, to: query.to, before: query.before, limit: query.limit, includeAccruals: query.accruals === '1', strategyId: query.strategyId, instrumentId: query.instrumentId });
      default: throw new AppError('Unknown accounting tab.', { status: 404 });
    }
  });
  r.get('/api/books/:id/nav-history', ({ params, query }) => ({ items: app.accounting.navHistory(params.id, query.scope || 'book') }));
  r.post('/api/books/:id/adjustments', ({ params, body }) => app.accounting.manualAdjustment({ ...body, bookId: params.id }));
  r.post('/api/events/:id/reverse', ({ params, body }) => app.accounting.reverseEvent(Number(params.id), body));

  // ---- strategies and orders ----------------------------------------------------------------------------------------
  r.post('/api/strategies/preview', ({ body }) => app.packages.preview(body));
  r.post('/api/strategies', async ({ body }) => {
    const out = await app.packages.submit(body);
    app.engine.emit({ type: 'changed', summary: { submitted: 1 } });
    return out;
  });
  r.get('/api/strategies', ({ query }) => {
    need(query.bookId, 'bookId is required.');
    const units = books.scopeUnits(query.bookId, query.scope || 'book').map((u) => u.id);
    return { items: app.packages.listStrategies({ bookId: query.bookId, unitIds: units, status: query.status }) };
  });
  r.get('/api/strategies/:id', async ({ params, query }) => {
    const s = app.packages.requireStrategy(params.id);
    // Asked for on behalf of a Book (a screen of the selected Book): another Book's strategy instance is not found.
    need(!query.bookId || s.book_id === query.bookId, 'This strategy instance belongs to another Book.', { status: 404 });
    const held = positions.list({ unitIds: [s.unit_id], strategyId: s.id }).map((p) => instruments.get(p.instrument_id));
    await freshQuotes(held);
    return app.packages.strategyView(params.id);
  });
  r.post('/api/strategies/:id/preview-action', ({ params, body }) => app.packages.previewAction(params.id, body.action, body));
  r.post('/api/strategies/:id/action', ({ params, body }) => {
    const out = app.packages.applyAction(params.id, body.action);
    app.engine.emit({ type: 'changed', summary: { action: body.action } });
    return out;
  });
  r.post('/api/orders/:id/cancel', ({ params }) => {
    const o = app.orders.cancel(params.id);
    return app.packages.orderView(o);
  });

  // ---- lifecycle by hand ---------------------------------------------------------------------------------------------
  // s3: `fetched` once the data an exercise or a pass-through needs has been asked for (every other action stays synchronous).
  const positionLifecycle = ({ params, body }, fetched = false) => {
    const pos = positions.get(params.id);
    need(pos, 'Position not found.', { status: 404 });
    const inst = instruments.get(pos.instrument_id);
    const plugin = app.products.get(inst.family);
    const book = books.getBook(pos.book_id), unit = books.getUnit(pos.unit_id);
    const ctx = { book, unit, inst, pos };
    // A number of contracts stated for an exercise or an assignment follows the instrument's own quantity step:
    // listed contracts are whole, so "1.5 contracts" is refused instead of leaving half a contract behind.
    if (['exercise', 'assign'].includes(body.action) && body.contracts !== undefined && body.contracts !== null && body.contracts !== '') {
      const n = num(body.contracts);
      const step = plugin.qtyStep ? plugin.qtyStep(inst) : 1;
      need(n !== null && n > 0, 'Enter the number of contracts as a positive number.');
      need(!(step >= 1) || Math.abs(n / step - Math.round(n / step)) < 1e-9, `The number of contracts must be a multiple of ${step}.`);
    }
    // s3: an exercise or a loan pass-through needs the fixings accrued on (and a loan's starting close): ask for them first.
    if (!fetched && ['call_exercise', 'put_exercise', 'pass_through'].includes(body.action) && plugin.lifecycleNeeds) return app.data.refresh(plugin.lifecycleNeeds(app, ctx)).then(() => positionLifecycle({ params, body }, true));
    const out = db.tx(() => {
      let result;
      switch (body.action) {
        case 'exercise': need(plugin.exercise, 'This position cannot be exercised.'); result = plugin.exercise(app, { ...ctx, contracts: body.contracts, price: body.price }); break;
        // OTC options: a credit event knocking out a credit-default swaption; the observed extreme of a lookback.
        case 'knockout': need(plugin.knockOut, 'A knock-out applies to credit-default swaptions.'); result = plugin.knockOut(app, { ...ctx, note: body.note }); break;
        case 'extreme': need(plugin.recordExtreme, 'An observed extreme applies to lookback options.'); result = plugin.recordExtreme(app, { ...ctx, value: body.value, date: body.date, note: body.note }); break;
        case 'assign': need(plugin.assign, 'Assignment does not apply to this position.'); result = plugin.assign(app, { ...ctx, contracts: body.contracts }); break;
        case 'redeem': need(plugin.redeemEarly, 'Early redemption does not apply to this position.'); result = plugin.redeemEarly(app, { ...ctx, price: body.price, face: body.face, label: body.label }); break;
        // A holder's put and a conversion or exchange into shares, recorded by hand (server/products/bond.js).
        case 'put': case 'convert': case 'draw': // b4: a draw on a delayed-draw loan
          // Only debt securities record these here; any other family answers as before (an unknown lifecycle action).
          if (inst.family !== 'bond' || !plugin.positionEvent) throw new AppError(`Unknown lifecycle action "${body.action}".`);
          result = plugin.positionEvent(app, { ...ctx, action: body.action, body }); break;
        // s3: a callable or puttable swap's right exercised on one of its dates; a loan TRS's pass-through (server/products/swap-partial.js).
        case 'call_exercise': case 'put_exercise': need(plugin.exerciseTermination, 'An exercise of a call or put applies to callable and puttable swaps.'); result = plugin.exerciseTermination(app, ctx, { by: body.by }); break;
        case 'pass_through': need(plugin.passThrough, 'A pass-through applies to a loan total-return swap.'); result = plugin.passThrough(app, ctx, { kind: body.kind, amount: body.amount, share: body.share, price: body.price, note: body.note }); break;
        case 'recall': need(plugin.recall, 'A lender recall does not apply to this position.'); result = plugin.recall(app, { ...ctx, qty: body.qty, days: num(body.days) ?? 2 }); break;
        // r1: a repo's collateral changed by agreement (margin call met, excess returned, substitution).
        case 'collateral': need(plugin.collateralChange, 'A collateral change applies to repos and reverse repos.'); result = plugin.collateralChange(app, { ...ctx, change: body.change, qty: body.qty, positionId: body.positionId, instrumentId: body.instrumentId }); break;
        case 'cashflow': result = app.accounting.manualCashflow({ positionId: pos.id, category: body.category, amount: body.amount, note: body.note }); break;
        // fw: early termination of a forward at an amount agreed with the counterparty (server/products/fx.js, forward.terminate).
        case 'terminate': need(plugin.terminate, 'Early termination at a stated amount applies to forwards.'); result = plugin.terminate(app, { ...ctx, amount: body.amount, qty: body.qty, settleDate: body.settleDate || null }); break;
        // fw: the pool allocated to a TBA mortgage contract, recorded by hand before settlement (forward.allocate).
        case 'allocate': need(plugin.allocate, 'A pool allocation applies to TBA mortgage contracts.'); result = plugin.allocate(app, { ...ctx, instrumentId: body.instrumentId }); break;
        // Physical delivery of goods is not simulated for a spot asset: the Terminal moves no goods. Say so plainly.
        // A future's delivery notice: the plugin decides from the contract's own settlement terms (simulated on paper
        // for a physically delivered contract with a configured deliverable; refused with the specific reason otherwise).
        case 'deliver': if (plugin.deliver) { result = plugin.deliver(app, { ...ctx, contracts: body.contracts }); break; }
          throw new AppError(inst.family === 'spot'
          ? `Physical delivery is not simulated for ${inst.symbol || inst.name}: the Terminal moves no goods. Record delivery, storage and transport costs as manual cash flows on the position, and the goods leaving as a sale at the agreed price (or at 0.00 when they are consumed or lost).`
          : 'Physical delivery does not apply to this position.', { code: 'delivery_not_simulated' });
        case 'barrier': {
          need(inst.terms.barrier, 'This option has no barrier.');
          need(!pos.data.barrierHit, `The barrier event is already recorded on this position (${pos.data.barrierHitAt || 'earlier'}). It is recorded once.`);
          positions.setData(pos, { barrierHit: true, barrierHitAt: app.clock.now().toISOString() });
          const eventId = app.ledger.post({ bookId: book.id, unitId: unit.id, type: 'option.barrier_event', instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, summary: `Barrier event recorded on ${inst.symbol || inst.name}: ${inst.terms.barrier.type} at ${inst.terms.barrier.level}${body.note ? `. ${body.note}` : ''}`, data: { barrier: inst.terms.barrier } });
          result = { eventId };
          break;
        }
        // m1: the manual workflow of a holding or contract valued by hand (products/manual.js): valuations, capital calls,
        // distributions, redemptions, loss events, final settlement from a realised value, and the rest.
        default:
          if (inst.family === 'manual' && plugin.manualEvents(inst).includes(body.action)) { result = plugin.manualEvent(app, ctx, body); break; }
          if (inst.family === 'manual') throw new AppError(`"${body.action}" is not recorded for ${inst.symbol || inst.name}. It records: ${plugin.manualEvents(inst).join(', ')}, and manual cash flows.`);
          throw new AppError(`Unknown lifecycle action "${body.action}".`);
      }
      const fresh = positions.get(pos.id);
      if (plugin.onPositionChange) plugin.onPositionChange(app, { book, unit, inst: instruments.get(inst.id), pos: fresh });
      touchStrategy(pos.strategy_id);
      if (app.hedge && ['exercise', 'assign', 'redeem'].includes(body.action)) app.hedge.flagReview(pos.strategy_id, fresh.data.purpose === 'hedge' ? 'A hedge was exercised, assigned or redeemed' : 'The primary position changed');
      return result;
    });
    app.engine.emit({ type: 'changed', summary: { lifecycle: body.action } });
    return { ok: true, result: out, strategy: pos.strategy_id ? app.packages.strategyView(pos.strategy_id) : null };
  };
  r.post('/api/positions/:id/lifecycle', (req) => positionLifecycle(req));
  r.post('/api/instruments/:id/lifecycle', ({ params, body }) => {
    const inst = instruments.require(params.id);
    const plugin = app.products.get(inst.family);
    const out = db.tx(() => {
      switch (body.action) {
        case 'credit_event': {
          // b4: a credit-linked note's reference entity (server/products/bond.js, creditEvent).
          if (inst.family === 'bond') return plugin.manualEvent(app, { inst, action: 'credit_event', body });
          need(plugin.creditEvent, 'A credit event applies to credit default swaps.');
          // s3: the event's type, date, settlement method, defaulted name (basket, index) and settlement date are passed on.
          const ce = plugin.creditEvent(app, { inst, recovery: body.recovery, weight: body.weight, eventType: body.eventType, eventDate: body.eventDate, settlement: body.settlement, entity: body.entity, settleDate: body.settleDate, note: body.note });
          // A credit-default swaption on this contract that knocks out on a credit event ends with it, nothing paid.
          const otc = app.products.get('otcoption');
          for (const o of instruments.list({ family: 'otcoption' }).filter((i) => i.underlying_id === inst.id && i.terms.knockOutOnCredit)) {
            for (const p of positions.heldAround(o.id)) {
              if (isZero(p.qty)) continue;
              const b = books.getBook(p.book_id), u = books.getUnit(p.unit_id);
              otc.knockOut(app, { book: b, unit: u, inst: o, pos: p, note: `Credit event recorded on ${inst.symbol || inst.name}` });
              otc.onPositionChange(app, { book: b, unit: u, inst: o, pos: positions.get(p.id) });
              touchStrategy(p.strategy_id);
            }
          }
          return ce;
        }
        // s3: an ABS CDS's pay-as-you-go events, and a loan CDS cancelled on refinancing (server/products/credit.js).
        case 'paygo': need(plugin.paygo, 'Pay-as-you-go events apply to ABS credit default swaps.'); return plugin.paygo(app, { inst, kind: body.kind, amount: body.amount, date: body.date, note: body.note });
        case 'cancel': need(plugin.cancelOnRefinancing, 'Cancellation on refinancing applies to loan credit default swaps.'); return plugin.cancelOnRefinancing(app, { inst, date: body.date, note: body.note });
        case 'paydown': {
          need(plugin.paydown, 'A principal paydown applies to debt securities.');
          const holder = positions.heldAround(inst.id)[0];
          return plugin.paydown(app, { book: holder ? books.getBook(holder.book_id) : null, unit: holder ? books.getUnit(holder.unit_id) : null, inst, newFactor: body.newFactor, effective: body.effective, payDate: body.payDate, scheduledFactor: body.scheduledFactor, note: body.note });
        }
        // Debt-security events recorded by hand: an index ratio, an issuer call, a write-down or loss allocation (server/products/bond.js).
        case 'index_ratio': case 'call': case 'writedown':
        // b4: structured group B (senior tranche balance of a sequential CMO class, ...).
        case 'senior_balance': case 'pik': case 'observation': case 'reprice': case 'recovery':
          need(inst.family === 'bond' && plugin.manualEvent, 'This event applies to debt securities.'); return plugin.manualEvent(app, { inst, action: body.action, body });
        case 'suspend_coupon': need(inst.family === 'bond' && plugin.suspendCoupons, 'Coupon suspension applies to debt securities.'); return plugin.suspendCoupons(app, { inst, suspended: Boolean(body.suspended) });
        case 'set_rate': {
          need(['repo', 'loan'].includes(inst.family), 'A rate reset applies to loans and repos.');
          const fixed = plugin.checkSetRate ? plugin.checkSetRate(inst) : null; // r1: a buy/sell-back's forward price is fixed
          need(!fixed, fixed);
          const rate = num(body.rate);
          need(rate !== null && Math.abs(rate) <= 1, 'Enter the new rate as a decimal (0.045 = 4.5%).');
          for (const p of positions.heldAround(inst.id)) {
            if (isZero(p.qty)) continue;
            const b = books.getBook(p.book_id), u = books.getUnit(p.unit_id);
            plugin.eod(app, { book: b, unit: u, inst, pos: p, date: app.clock.today() });
            app.ledger.post({ bookId: b.id, unitId: u.id, type: 'rate.reset', instrumentId: inst.id, strategyId: p.strategy_id, positionId: p.id, summary: `Rate on ${inst.name} reset to ${(rate * 100).toFixed(3)}%`, data: { from: inst.terms.rate, to: rate } });
          }
          instruments.update(inst.id, { terms: { ...inst.terms, rateType: 'fixed', rate } }, { system: true });
          return { rate };
        }
        default: throw new AppError(`Unknown lifecycle action "${body.action}".`);
      }
    });
    for (const p of positions.heldAround(inst.id)) touchStrategy(p.strategy_id);
    app.engine.emit({ type: 'changed', summary: { lifecycle: body.action } });
    return { ok: true, result: out };
  });
  // The input an option's expiry item waits for, entered by hand: `amount`, the total settlement amount due to the holder;
  // or, for a basket or spread option, `value`, the composite's value at expiry, from which the payoff is worked out.
  r.post('/api/tasks/:id/settlement-amount', ({ params, body }) => {
    const t = app.tasks.get(params.id);
    need(t, 'Lifecycle item not found.', { status: 404 });
    // s3: the level of an equity basket at a reset, entered by hand on the payment item of its return leg.
    if (t.type === 'swap.payment') return setBasketLevel(app, t, body.value);
    if (body.value !== undefined && body.value !== null && body.value !== '') {
      need(t.type === 'option.expiry', 'A settlement value is entered on the expiry item of an option.');
      const inst = instruments.get(t.instrument_id);
      need(inst && ['basket', 'spread'].includes(inst.terms.optionType), 'A settlement value is entered for a basket or spread option; other options settle against their fixing or a settlement amount.');
      const value = num(body.value);
      need(value !== null && (inst.terms.optionType === 'spread' || value > 0), inst.terms.optionType === 'spread' ? 'Enter the spread value at expiry as a number (it can be negative).' : 'Enter the basket value at expiry as a positive number.');
      app.tasks.setData(t.id, { ...t.data, settlementValue: value, settlementValueAt: app.clock.now().toISOString() });
      return { ok: true };
    }
    const amount = num(body.amount);
    need(amount !== null && amount >= 0, 'Enter the total settlement amount due to the option holder (zero if it expired worthless).');
    app.tasks.setData(t.id, { ...t.data, manualAmount: amount });
    return { ok: true };
  });
  r.get('/api/corporate-actions', ({ query }) => ({ items: app.corpactions.list(query.instrumentId).map((c) => ({ ...c, instrument: app.valuation.lite(instruments.get(c.instrument_id)) })) }));
  r.post('/api/corporate-actions', ({ body }) => app.corpactions.record(body));

  // ---- analytics and hedge -----------------------------------------------------------------------------------------------
  r.get('/api/analytics/signals', async ({ query }) => ({ ...(await app.data.analytics.signals({ bookId: query.bookId })), state: app.data.analytics.state(), awaitingMessage: app.data.describe().awaitingMessage }));
  // Investment Strategies: the list Analytics Lab supplies (stable IDs), plus every Strategy reference in use in the Book
  // (`inUse`: resolved by ID, or a typed name that stays unresolved, with a suggested match the user may confirm).
  r.get('/api/analytics/strategies', ({ query }) => app.hedge.strategiesView(query.bookId));
  r.post('/api/analytics/strategies/resolve', async ({ body }) => {
    const out = await app.hedge.resolveStrategyName({ bookId: body.bookId, name: body.name, id: body.id });
    app.engine.emit({ type: 'changed', summary: { strategyResolved: out.strategies + out.requests } });
    return out;
  });
  // Who would answer a hedge request right now (Shaffer Hedge, or in demo mode a labelled fixture), separate from the Analytics Lab connection.
  r.get('/api/hedge/service', () => app.hedge.serviceStatus());
  r.post('/api/hedge/requests', ({ body }) => app.hedge.request(body));
  r.get('/api/hedge/requests', ({ query }) => ({ items: app.hedge.list(query.bookId) }));
  r.get('/api/hedge/requests/:id', ({ params }) => { const v = app.hedge.get(params.id); need(v, 'Hedge request not found.', { status: 404 }); return v; });
  // Complete or change the request's context (investment Strategy, holding period, objective, scope) and save it. Same request id.
  r.post('/api/hedge/requests/:id/complete', async ({ params, body }) => {
    const out = await app.hedge.complete(params.id, { investmentStrategy: body.investmentStrategy, holdingPeriod: body.holdingPeriod, objective: body.objective, scope: body.scope });
    app.engine.emit({ type: 'changed', summary: { hedgeRequest: 1 } });
    return out;
  });
  // Ask again for one request against the exposure as it is now (in place). Never executes anything.
  r.post('/api/hedge/requests/:id/refresh', async ({ params }) => {
    const out = await app.hedge.refresh(params.id);
    app.engine.emit({ type: 'changed', summary: { hedgeRefreshed: 1 } });
    return out;
  });
  // The protection picture of a Book's units: hedges with capacity and allocations, and each position's protection. One Book only.
  r.get('/api/books/:id/protection', ({ params }) => ({
    units: books.requireBook(params.id).units.map((u) => { const v = app.protection.forUnit(u.id); return { id: u.id, name: u.name, kind: u.kind, hedges: v.hedges, positions: [...v.byPosition].map(([positionId, x]) => ({ positionId, ...x })) }; }),
    capacityRules: app.protection.CAPACITY_RULES,
  }));
  // collateral: { [legNo]: basis } chosen for an OTC leg; statedPrices: { [legNo]: price } for a leg with no executable quote.
  r.post('/api/hedge/requests/:id/preview', ({ params, body }) => app.hedge.previewPackage(params.id, body.packageId, { legs: body.legs, extraProtection: body.extraProtection, collateral: body.collateral, statedPrices: body.statedPrices }));
  r.post('/api/hedge/requests/:id/dismiss', ({ params }) => app.hedge.dismiss(params.id));
  r.post('/api/hedge/requests/:id/seen', ({ params }) => { app.hedge.markSeen(params.id); return { ok: true }; });
  r.get('/api/hedge/prompts', ({ query }) => ({ items: query.bookId ? app.hedge.prompts(query.bookId) : [] }));
  r.get('/api/hedge/queue', ({ query }) => { need(query.bookId, 'bookId is required.'); return app.hedge.queue(query.bookId); });
  r.post('/api/hedge/refresh', async () => ({ refreshed: await app.hedge.refreshWaiting({ force: true }) }));

  // ---- collateral agreements and OTC collateral -----------------------------------------------------------------------------
  // Every route is under its Book: an agreement, a position or a call of another Book is refused, not found.
  const collateralChanged = () => app.engine.emit({ type: 'changed', summary: { collateral: 1 } });
  r.get('/api/books/:id/agreements', ({ params }) => {
    books.requireBook(params.id);
    return { items: app.agreements.list(params.id).map(app.agreements.view) };
  });
  r.post('/api/books/:id/agreements', ({ params, body }) => {
    const a = app.agreements.create(params.id, body);
    collateralChanged();
    return app.agreements.view(a);
  });
  r.get('/api/books/:id/agreements/:agreementId', ({ params }) => app.agreements.view(app.agreements.requireAgreement(params.agreementId, books.requireBook(params.id).id)));
  r.put('/api/books/:id/agreements/:agreementId', ({ params, body }) => {
    const a = app.agreements.update(params.agreementId, { ...body, bookId: books.requireBook(params.id).id });
    collateralChanged();
    return app.agreements.view(a);
  });
  r.post('/api/books/:id/agreements/:agreementId/close', ({ params }) => {
    const a = app.agreements.close(params.agreementId, { bookId: books.requireBook(params.id).id });
    collateralChanged();
    return app.agreements.view(a);
  });
  // Agreements, OTC positions with their basis and requirement, netting sets, movements and failed calls of a scope.
  r.get('/api/books/:id/collateral', async ({ params, query }) => { await refreshBook(params.id); return app.agreements.bookView(params.id, query.scope || 'book'); });
  // Try failed collateral calls again now (the engine also does so each cycle). Delivers only what is still missing.
  r.post('/api/books/:id/collateral/retry', ({ params }) => {
    const delivered = app.agreements.retryFailed(books.requireBook(params.id).id);
    if (delivered) collateralChanged();
    return { delivered };
  });
  // Record the collateral basis of a position that has none on record (one opened before bases were required).
  r.put('/api/books/:id/positions/:positionId/collateral-basis', ({ params, body }) => {
    const pos = positions.get(params.positionId);
    need(pos && pos.book_id === books.requireBook(params.id).id, 'Position not found in this Book.', { status: 404 });
    const out = app.agreements.setPositionBasis(pos.id, body.basis || body);
    collateralChanged();
    return out;
  });

  // ---- engine ---------------------------------------------------------------------------------------------------------------
  r.post('/api/engine/tick', async () => app.engine.tick());
  r.post('/api/demo/advance', async ({ body }) => {
    need(app.config.demo, 'The clock can only be moved in demo mode.', { status: 403 });
    if (body.to) app.clock.set(body.to);
    else {
      const ms = num(body.ms);
      need(ms > 0 && ms <= 400 * 86400e3, 'Advance by a positive amount of time (at most 400 days).');
      app.clock.advance(ms);
    }
    app.data.setSetting('demo.clockOffsetMs', Math.round(app.clock.ms() - Date.now()));
    lastQuoteRefresh.clear();
    const summary = await app.engine.tick();
    return { now: app.clock.now().toISOString(), today: app.clock.today(), summary };
  });
  r.post('/api/demo/hedge-fixture', async ({ body }) => {
    need(app.config.demo, 'Demo only.', { status: 403 });
    app.data.setSetting('demo.hedgeFixture', Boolean(body.enabled));
    // Turning the fixture on plays the part of the service reconnecting: waiting requests are refreshed.
    const refreshed = body.enabled ? await app.hedge.refreshWaiting() : [];
    app.engine.emit({ type: 'changed', summary: { hedgeRefreshed: refreshed.length, hedgeService: 1 } });
    return { enabled: Boolean(body.enabled), refreshed, service: app.hedge.serviceStatus() };
  });
  // Demo only: a scripted "service" for tests and the browser harness. It answers hedge requests with the responses
  // given (packages and a protection assessment), in order, and can supply a Strategy list. Everything it returns is
  // stamped test-fixture. Body: { responses: [HedgeResponse | { error }], strategies?: [{ id, name }], available?: boolean,
  // repeat?: boolean } to load, or { clear: true } to remove it.
  r.get('/api/demo/hedge-script', () => { need(app.config.demo, 'Demo only.', { status: 403 }); return app.hedge.scriptView(); });
  r.post('/api/demo/hedge-script', async ({ body }) => {
    need(app.config.demo, 'Demo only.', { status: 403 });
    app.hedge.setScript(body);
    // Loading a script plays the part of the service coming up (or going away): waiting requests are refreshed, nothing is traded.
    const refreshed = await app.hedge.refreshWaiting();
    app.engine.emit({ type: 'changed', summary: { hedgeRefreshed: refreshed.length, hedgeService: 1 } });
    return { script: app.hedge.scriptView(), refreshed, service: app.hedge.serviceStatus() };
  });

  // ---- test matrix: controlled fixtures (demo only) and the read-only integrity check ---------------------------------------
  // Fixtures stand in for the Shaffer services with values a test states. Demo mode only (403 otherwise);
  // every observation they produce is labelled "Test fixture". See createFixtureControls in data/demo.js.
  const fixtures = createFixtureControls(app);
  fixtures.restore();
  r.get('/api/demo/fixtures', () => fixtures.list());
  r.post('/api/demo/fixtures/:kind', async ({ params, body }) => {
    const out = await fixtures.apply(params.kind, body);
    lastQuoteRefresh.clear();
    app.engine.emit({ type: 'changed', summary: { fixture: params.kind } });
    return out;
  });
  // Read-only: do the Book's stored events, fills, settlements and positions still agree with each other
  // and with its accounting views? Checks and duplicate keys are documented in core/integrity.js.
  const integrity = createIntegrity(app);
  r.get('/api/books/:id/integrity', async ({ params }) => { await refreshBook(params.id); return integrity.check(params.id); });

  return r;
}
