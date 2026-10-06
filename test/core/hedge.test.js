import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });

test('a hedge request carries the full context, not just a ticker and a quantity', async () => {
  const { app, inst } = makeApp({ demo: false });
  const stock = app.instruments.create({ productId: 'common_stock', name: 'Example Corp', symbol: 'EXMP', marketView: 'US_CASH', venue: 'NYSE', tradingCcy: 'USD', externalIds: { shaffer: 'SHF-000123' } });
  const { book, acct } = makeBook(app);
  void inst;
  const bare = await app.hedge.request({ bookId: book.id, unitId: acct.id, instrumentId: stock.id, quantity: 500, direction: 'long', trigger: 'strategy_page' });
  assert.equal(bare.status, 'awaiting');
  assert.deepEqual(bare.missing, ['investment Strategy', 'hedge objective', 'intended holding period']);
  assert.match(bare.message, /incomplete.*Awaiting Shaffer data connection/);
  assert.equal(bare.response, null, 'no hedge is invented while awaiting');
  const full = await app.hedge.request({
    bookId: book.id, unitId: acct.id, instrumentId: stock.id, quantity: 500, direction: 'long', trigger: 'strategy_page', scope: { type: 'trade' },
    investmentStrategy: { name: 'Quality Compounders' }, holdingPeriod: { days: 90 }, objective: { type: 'downside_protection', settings: { maxPremiumPct: 2 } },
    proposedLegs: [{ role: 'put', purpose: 'hedge', kind: 'trade', action: 'buy', qty: 5, option: { underlyingId: stock.id, expiration: '2026-06-19', strike: 45, right: 'P' } }],
  });
  const q = full.request;
  assert.deepEqual(full.missing, []);
  assert.equal(full.message, 'Awaiting Shaffer data connection');
  assert.equal(q.primary.instrument.shafferId, 'SHF-000123');
  assert.equal(q.primary.direction, 'long');
  assert.equal(q.primary.quantity, 500);
  assert.equal(q.primary.status, 'proposed');
  assert.deepEqual(q.account, { id: acct.id, name: 'Alpha', kind: 'account' });
  assert.equal(q.investmentStrategy.name, 'Quality Compounders');
  assert.equal(q.holdingPeriod.days, 90);
  assert.equal(q.objective.type, 'downside_protection');
  assert.deepEqual(q.objective.settings, { maxPremiumPct: 2 });
  assert.equal(q.proposedLegs[0].isProtection, true, 'protection already in the template is passed along');
  assert.ok(Array.isArray(q.exposures.positions) && Array.isArray(q.existingHedges));
  assert.equal(q.scope.type, 'trade');
});

test('demo fixture: post-trade hedge prompt, multi-family packages, Execute through the normal checks, linked legs', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  // A direct Marketplace trade.
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace', investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } });
  assert.equal(s.status, 'open');
  await advance(app, clock, 1000);
  const prompts = app.hedge.prompts(book.id);
  assert.equal(prompts.length, 1, 'the hedge request was made automatically after the fill');
  const h = prompts[0];
  assert.equal(h.trigger, 'post_trade');
  assert.equal(h.request.primary.status, 'filled');
  assert.equal(h.request.primary.quantity, 300, 'uses the actual filled position');
  assert.equal(h.status, 'received');
  assert.equal(h.response.fixture, true);
  assert.match(h.response.source, /Demo fixture \(not Shaffer Hedge\)/);
  const families = new Set(h.response.packages.flatMap((p) => p.legs.map((l) => l.hedgeFamily)));
  assert.ok(families.has('Options') && families.has('Futures and forwards') && families.has('Total-return and equity swaps'), 'not an options-only popup');
  const rec = h.response.packages.find((p) => p.recommended);
  assert.equal(rec.id, h.response.recommendedId);
  // Preview the recommended package: normal quotes / funding / per-leg checks apply.
  const pv = await app.hedge.previewPackage(h.id, rec.id);
  assert.equal(pv.blocking, 0);
  assert.equal(pv.attachTo, s.id, 'the hedge attaches to the primary strategy instance');
  assert.equal(pv.legs[0].purpose, 'hedge');
  assert.equal(pv.legs[0].qty, 3);
  const r = await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'hedge', legs: pv.legs, clientToken: pv.token, confirm: true, hedgeLinkId: h.id, hedgePackageId: rec.id });
  const put = r.strategy.positions.find((p) => p.family === 'option');
  assert.equal(put.purpose, 'hedge');
  assert.equal(put.hedgeLinkId, h.id);
  assert.equal(r.strategy.positions.find((p) => p.family === 'equity').purpose, 'primary');
  assert.equal(app.hedge.get(h.id).status, 'executed');
  assert.equal(app.hedge.prompts(book.id).length, 0);
  // Changing the primary exposure flags the hedge for review; nothing is traded automatically.
  const half = await app.packages.previewAction(s.id, 'close', { fraction: 0.5, positionIds: [r.strategy.positions.find((p) => p.family === 'equity').positionId] });
  await app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: s.id, intent: 'close', legs: half.legs, clientToken: half.token, confirm: true });
  const v = app.packages.strategyView(s.id);
  assert.equal(v.hedge.review.needed, true);
  assert.equal(v.positions.find((p) => p.family === 'option').qty, 3, 'the hedge was not silently resized');
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'hedge.review'));
  const again = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, trigger: 'review', objective: { type: 'downside_protection' } });
  assert.equal(again.request.existingHedges.length, 1, 'protection already held is reported so it is not duplicated');
  assert.equal(again.request.primary.quantity, 150);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a TRS hedge leg carries its full contract into the ticket; dismissing leaves the primary in place', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  const pv = await app.hedge.previewPackage(h.id, 'demo-trs');
  const d = Object.fromEntries(pv.legs[0].instrument.details);
  assert.match(d['Leg A'], /Pay total return on ALFA/);
  assert.match(d['Leg B'], /Receive SIM-ON \+ 0\.50% USD, every 3 months/);
  assert.ok(d.Effective && d.Maturity && d.Counterparty && d['Collateral terms']);
  assert.equal(pv.legs[0].notional, 57_000);
  assert.equal(pv.legs[0].price.executable, false, 'indicative terms are not an executable quote');
  assert.equal(pv.legs[0].indicative.status, 'indicative');
  const dis = app.hedge.dismiss(h.id);
  assert.equal(dis.status, 'dismissed');
  const v = app.packages.strategyView(s.id);
  assert.equal(v.status, 'open');
  assert.equal(v.positions.length, 1);
});

test('a foreign position gets separate market and currency hedges in one package', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const jpy = inst['USD/JPY'];
  app.data.market.set(jpy.id, { bid: 150, ask: 150, value: 150 });
  app.data.market.set('USD/JPY', { value: 150 }); app.data.market.set('JPY/USD', { value: 1 / 150 });
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: jpy.id, qty: 100_000 }] });
  clock.freeze('2026-03-04T15:00:00.000Z'); await app.engine.tick();
  pin(app, inst.KAIJ.id, 3000);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.KAIJ.id, quantity: 1000, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  const combo = h.response.packages.find((p) => p.id === 'demo-combined');
  assert.deepEqual(combo.riskAddressed, ['Market exposure', 'Currency exposure']);
  assert.deepEqual(combo.legs.map((l) => l.hedgeFamily), ['Futures and forwards', 'Currency derivatives']);
  const pv = await app.hedge.previewPackage(h.id, combo.id);
  assert.equal(pv.legs[1].instrument.family, 'forward');
  assert.equal(pv.legs[1].action, 'sell');
});

test('Strategy page: the template is sent as proposed legs, and the chosen hedge package joins the same confirmation', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  const pkg = { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, targetNotional: 100_000, origin: 'strategy_page' };
  const ctx = { investmentStrategy: { name: 'Quality Compounders' }, holdingPeriod: { days: 60 }, objective: { type: 'downside_protection' } };
  const draft = await app.hedge.request({ bookId: book.id, unitId: acct.id, scope: { type: 'trade' }, trigger: 'strategy_page', instrumentId: inst.ALFA.id, notional: 100_000, ...ctx, package: pkg });
  const r = await app.hedge.request({ bookId: book.id, unitId: acct.id, scope: { type: 'trade' }, trigger: 'strategy_page', instrumentId: inst.ALFA.id, notional: 100_000, ...ctx, package: pkg });
  assert.equal(app.hedge.get(draft.id), null, 'an earlier draft that was never acted on is replaced, not accumulated');
  assert.equal(r.request.primary.quantity, 1000, 'the amount is the quantity the template resolves to');
  assert.equal(r.request.primary.direction, 'long');
  assert.equal(r.request.proposedLegs.length, 1);
  assert.deepEqual(r.missing, []);
  const put = r.response.packages.find((p) => p.id === 'demo-protective');
  assert.ok(put, 'the demo fixture proposes a protective put');

  const pv = await app.packages.preview({ ...pkg, ...ctx, hedgeLinkId: r.id, hedgePackageId: put.id, appendHedge: true });
  assert.equal(pv.legs.length, 2);
  assert.equal(pv.legs[1].purpose, 'hedge');
  assert.deepEqual(pv.legs[1].dependsOn, [1], 'the hedge follows the primary leg, so it is scaled to what fills');
  assert.equal(pv.input.appendHedge, undefined);
  // Re-checking or confirming sends the legs back; the hedge must not be added a second time.
  const again = await app.packages.preview({ ...pv.input, legs: pv.legs, clientToken: pv.token });
  assert.equal(again.legs.length, 2);

  // Only 400 of the 1,000 shares are on offer: the put order is cut to match the stock actually bought.
  app.data.market.set(inst.ALFA.id, { bid: 100, ask: 100, value: 100, bidSize: 400, askSize: 400 });
  const out = await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true });
  const [stock, hedge] = out.strategy.orders;
  assert.equal(stock.filledQty, 400);
  assert.ok(hedge.filledQty <= 4, 'protection never exceeds the filled exposure');
  assert.equal(app.hedge.get(r.id).status, 'executed');
  assert.equal(app.hedge.get(r.id).strategyId, out.strategy.id, 'the request is linked to the strategy instance');
  void clock;
  assert.deepEqual(ledgerImbalance(app), []);
});
