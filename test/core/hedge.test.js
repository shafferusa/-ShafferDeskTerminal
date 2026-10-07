import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });
// A complete hedge context. Without it a request is stored as incomplete and is not sent or answered.
const CTX = { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };
const EXP = '2026-03-20';
// The scripted TEST FIXTURE stands in for Shaffer Hedge only; requests, previews, execution and the ledger are real.
const optSpec = (und, strike, right) => ({ underlyingId: und.id, expiration: EXP, strike, right, multiplier: 100, deliverableUnits: 100, exercise: 'american', settlement: 'physical' });
const svcPut = (und, strike, contracts) => ({ role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action: 'buy', option: optSpec(und, strike, 'P'), quantity: contracts });
const svcPackage = (legs, id = 'scripted-1') => ({ id, label: 'Scripted package', recommended: true, legs });
const buy = (app, book, acct, und, qty, extra = {}) => trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: und.id, quantity: qty, origin: 'marketplace', ...CTX, ...extra });
const confirm = (app, pv) => app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true });

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
  assert.match(full.message, /^Awaiting Shaffer data connection\. The request is complete and stored/);
  assert.equal(full.state, 'awaiting_connection');
  assert.equal(bare.state, 'incomplete');
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
  assert.equal(q.proposedLegs[0].relation, 'template');
  assert.ok(Array.isArray(q.exposures.positions) && Array.isArray(q.hedgesHeld) && Array.isArray(q.linkedProtection));
  assert.equal(q.existingHedges, undefined, 'the request no longer asserts that every hedge in the Account protects the trade');
  assert.deepEqual(q.investmentStrategy, { id: null, name: 'Quality Compounders', resolved: false, source: null, version: null, note: null }, 'a typed name stays explicitly unresolved');
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
  assert.equal(h.response.source.kind, 'demo-fixture');
  assert.equal(h.source.label, 'Demo fixture, not Shaffer Hedge');
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
  assert.equal(again.request.linkedProtection.length, 1, 'protection linked to the position is reported so it is not duplicated');
  assert.equal(again.request.primary.quantity, 150);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a TRS hedge leg carries its full contract into the ticket; dismissing leaves the primary in place', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace', ...CTX });
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
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.KAIJ.id, quantity: 1000, origin: 'marketplace', ...CTX });
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
  // The request id is stored on the hedge leg only; the primary leg of the same confirmation does not carry it.
  const stored = app.orders.forStrategy(out.strategy.id);
  assert.deepEqual(stored.map((o) => [o.leg_no, o.data.purpose, o.data.hedgeLinkId, o.data.protectsLegs || null]), [[1, 'primary', null, null], [2, 'hedge', r.id, [1]]]);
  assert.deepEqual(app.packages.strategyView(out.strategy.id).hedge.links.legs.map((l) => [l.legNo, l.text]), [[2, `Hedge leg of request ${r.id}, protects leg 1 (buy 1,000 ALFA)`]]);
  void clock;
  assert.deepEqual(ledgerImbalance(app), []);
});

// ---- request state, completeness and connection -----------------------------------------------------------------

test('an incomplete request is stored and shown but not sent; completing and saving it sends it, in place', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.hedge.setScript({ responses: [{ version: 'model-9', packages: [svcPackage([svcPut(inst.ALFA, 180, 3)])] }] });
  // A direct Marketplace buy with no investment Strategy, holding period or objective.
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  assert.equal(h.state, 'incomplete');
  assert.equal(h.stateLabel, 'Incomplete request');
  assert.deepEqual(h.missing, ['investment Strategy', 'hedge objective', 'intended holding period']);
  // Completeness and connection are two separate facts, both reported.
  assert.equal(h.complete, false);
  assert.deepEqual([h.connection.reachable, h.connection.kind], [true, 'test-fixture']);
  assert.equal(h.response, null);
  assert.equal(h.source, null);
  assert.match(h.message, /incomplete: investment Strategy, hedge objective, intended holding period still needed\. It is stored and has not been sent\./);
  assert.equal(app.hedge.scriptView().used, 0, 'the service was not asked');
  await advance(app, clock, 10 * 60e3, { ticks: 3 });
  assert.deepEqual(await app.hedge.refreshWaiting({ force: true }), []);
  assert.equal(app.hedge.scriptView().used, 0, 'still not sent, however long it waits');
  assert.equal(app.hedge.queue(book.id).items[0].state, 'incomplete', 'it is in the review queue');
  // Saving part of the context keeps it incomplete, and says what is left.
  let c = await app.hedge.complete(h.id, { investmentStrategy: { name: 'Core Equity' } });
  assert.equal(c.state, 'incomplete');
  assert.deepEqual(c.missing, ['hedge objective', 'intended holding period']);
  assert.equal(app.hedge.scriptView().used, 0);
  // "Other, defined by the Strategy on the server" is a valid objective. Complete: sent, answered, same request.
  c = await app.hedge.complete(h.id, { holdingPeriod: { days: 45 }, objective: { type: 'server_defined' } });
  assert.equal(c.id, h.id);
  assert.equal(c.state, 'recommendation_ready');
  assert.deepEqual(c.missing, []);
  assert.equal(c.request.objective.label, 'Other (defined by the Strategy on the server)');
  assert.equal(c.request.holdingPeriod.days, 45);
  assert.deepEqual([c.request.investmentStrategy.name, c.request.investmentStrategy.resolved, c.request.investmentStrategy.id], ['Core Equity', false, null]);
  assert.equal(app.hedge.scriptView().used, 1, 'sent exactly once');
  assert.equal(app.hedge.list(book.id).length, 1);
  // The context is saved on the position's strategy instance as well, so every screen agrees.
  const v = app.packages.strategyView(s.id);
  assert.equal(v.holdingPeriod.days, 45);
  assert.equal(v.investmentStrategy.name, 'Core Equity');
  assert.equal(app.orders.forStrategy(s.id).length, 1, 'nothing was traded');
});

test('the demo fixture does not answer an incomplete request either, and labels what it does answer', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 300, origin: 'marketplace' });
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  assert.equal(h.state, 'incomplete');
  assert.equal(h.response, null, 'no packages from the fixture for an incomplete request');
  assert.equal(app.hedge.queue(book.id).items[0].packages, 0);
  const c = await app.hedge.complete(h.id, { investmentStrategy: { id: 'DEMO-IS-002' }, holdingPeriod: { days: 30 }, objective: { type: 'downside_protection' } });
  assert.equal(c.state, 'recommendation_ready');
  assert.deepEqual({ kind: c.source.kind, label: c.source.label, version: c.source.version }, { kind: 'demo-fixture', label: 'Demo fixture, not Shaffer Hedge', version: 'demo-fixture-2' });
  assert.equal(c.response.fixture, true);
  const row = app.hedge.queue(book.id).items[0];
  assert.deepEqual([row.state, row.source.kind, row.source.label, row.packages > 0], ['recommendation_ready', 'demo-fixture', 'Demo fixture, not Shaffer Hedge', true]);
  // The top bar's facts: Analytics Lab itself is still awaiting; the fixture is what answers hedge requests.
  const svc = app.hedge.serviceStatus();
  assert.deepEqual([svc.analytics, svc.kind, svc.reachable, svc.fixture], ['awaiting', 'demo-fixture', true, true]);
});

test('request states: awaiting connection, ready for analysis, recommendation ready, executing, executed, dismissed, failed', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.data.setSetting('demo.hedgeFixture', false); // nothing can answer
  const s = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  const id = app.hedge.prompts(book.id)[0].id;
  let h = app.hedge.get(id);
  assert.deepEqual([h.state, h.complete, h.connection.reachable], ['awaiting_connection', true, false]);
  // The service becomes reachable: complete, reachable, not yet answered.
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcPut(inst.ALFA, 180, 3)])] }] });
  h = app.hedge.get(id);
  assert.deepEqual([h.state, h.stateLabel, h.connection.reachable], ['ready_for_analysis', 'Ready for analysis', true]);
  await advance(app, clock, 3000);
  h = app.hedge.get(id);
  assert.equal(h.state, 'recommendation_ready');
  assert.equal(app.orders.forStrategy(s.id).length, 1, 'receiving the recommendation executed nothing');
  // Confirmed with a limit far below the market: the leg works, the request is "executing".
  let pv = await app.hedge.previewPackage(id, 'scripted-1');
  pv = await app.hedge.previewPackage(id, 'scripted-1', { legs: pv.legs.map((l) => ({ ...l, orderType: 'limit', limitPrice: 0.01, tif: 'gtc' })) });
  const out = await confirm(app, pv);
  const leg = out.strategy.orders.find((o) => o.submission === pv.token);
  assert.equal(leg.status, 'working');
  assert.equal(app.hedge.get(id).state, 'executing');
  assert.deepEqual(app.hedge.queue(book.id).items.map((x) => [x.id, x.state]), [[id, 'executing']]);
  // The working leg is cancelled without a fill: confirmed but nothing executed is a failure, not an executed hedge.
  app.orders.cancel(leg.id);
  h = app.hedge.get(id);
  assert.equal(h.state, 'error');
  assert.match(h.message, /confirmed, but none of its legs executed/);
  // A new request for the same position, executed at the market: "executed".
  const second = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, trigger: 'manual' });
  assert.notEqual(second.id, id);
  assert.equal(second.state, 'recommendation_ready');
  await confirm(app, await app.hedge.previewPackage(second.id, 'scripted-1'));
  assert.equal(app.hedge.get(second.id).state, 'executed');
  await assert.rejects(app.hedge.complete(second.id, { holdingPeriod: { days: 5 } }), /is executed; its context can no longer be changed/);
  // A failed call to the service, then a dismissal.
  app.hedge.setScript({ responses: [{ error: 'Model run timed out.' }] });
  const third = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, trigger: 'review' });
  assert.deepEqual([third.state, third.message], ['error', 'Model run timed out.']);
  assert.equal(app.hedge.dismiss(third.id).state, 'dismissed');
  assert.deepEqual(app.hedge.queue(book.id).items, []);
  assert.deepEqual(ledgerImbalance(app), []);
});

// ---- source and freshness --------------------------------------------------------------------------------------

test('a recommendation carries its source, received time and version; freshness is derived from current exposure', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.hedge.setScript({ responses: [{ version: 'run-2026-03-02a', packages: [svcPackage([svcPut(inst.ALFA, 180, 3)])] }] });
  const s = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  const received = clock.now().toISOString();
  const id = app.hedge.prompts(book.id)[0].id;
  let h = app.hedge.get(id);
  assert.deepEqual(h.source, { kind: 'test-fixture', label: 'Test fixture (scripted, not Shaffer Hedge)', version: 'run-2026-03-02a', receivedAt: received, exposureAsOf: received });
  assert.deepEqual(h.freshness, { status: 'current', changes: [], sourceReachable: true, cached: false, cachedNote: null });
  assert.equal(h.canExecute, true);
  // The same facts on the queue row, the position row and the strategy.
  const q = app.hedge.queue(book.id).items[0];
  assert.deepEqual([q.source.kind, q.source.version, q.source.receivedAt, q.freshness.status], ['test-fixture', 'run-2026-03-02a', received, 'current']);
  const pos = app.accounting.openPositions(book.id, acct.id).positions[0];
  assert.deepEqual([pos.hedgeRequest.id, pos.hedgeRequest.state, pos.hedgeRequest.source.version, pos.hedgeRequest.freshness.status], [id, 'recommendation_ready', 'run-2026-03-02a', 'current']);
  assert.deepEqual(app.packages.strategyView(s.id).hedge.requests.map((r) => [r.id, r.source.kind, r.freshness.status]), [[id, 'test-fixture', 'current']]);

  // The position doubles (300 -> 600). The stored recommendation was computed for 300: stale, and it says what changed.
  const grow = await app.packages.previewAction(s.id, 'resize', { factor: 2 });
  await confirm(app, grow);
  h = app.hedge.get(id);
  assert.equal(h.freshness.status, 'stale');
  assert.deepEqual(h.freshness.changes, ['The position is now long 600 ALFA; the recommendation was computed for 300.']);
  assert.equal(h.canExecute, false);
  assert.equal(h.state, 'recommendation_ready', 'still a recommendation, but not executable');
  // A stale recommendation cannot be executed: the preview blocks, and so does a confirmation sent anyway.
  const before = app.orders.forStrategy(s.id).length;
  const pv = await app.hedge.previewPackage(id, 'scripted-1');
  assert.equal(pv.blocking, 1);
  assert.match(pv.checks.find((c) => c.code === 'hedge-stale').message, /stale and cannot be executed until it is refreshed against current exposure\. The position is now long 600 ALFA/);
  await assert.rejects(confirm(app, pv), (err) => err.code === 'preview_failed' && /stale/.test(err.message));
  assert.equal(app.orders.forStrategy(s.id).length, before, 'nothing was submitted');
  // Refreshed in place against current exposure: same request, current again, executable.
  clock.advance(60e3);
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcPut(inst.ALFA, 180, 6)])] }] });
  h = await app.hedge.refresh(id);
  assert.equal(h.id, id);
  assert.equal(h.request.primary.quantity, 600);
  assert.equal(h.freshness.status, 'current');
  assert.equal(h.source.version, null, 'the service gave no version this time: shown as not supplied, never invented');
  assert.equal(h.source.receivedAt, clock.now().toISOString());
  assert.equal(app.hedge.list(book.id).length, 1);
  // The source becomes unreachable: what is stored is a cached copy and says so. It is still current.
  app.hedge.setScript({ available: false, responses: [] });
  h = app.hedge.get(id);
  assert.deepEqual([h.freshness.status, h.freshness.cached, h.freshness.sourceReachable, h.freshness.cachedNote], ['current', true, false, 'Cached: the test fixture is not reachable now.']);
  assert.equal(h.connection.reachable, false);
  const out = await confirm(app, await app.hedge.previewPackage(id, 'scripted-1'));
  assert.equal(out.strategy.positions.find((p) => p.family === 'option').qty, 6);
  assert.equal(app.hedge.get(id).state, 'executed');
  // Executed once: the same recommendation cannot be executed a second time under a new confirmation.
  const again = await app.hedge.previewPackage(id, 'scripted-1');
  assert.match(again.checks.find((c) => c.code === 'hedge-stale').message, /was already executed/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('freshness looks at hedges that could protect the exposure: one fully committed to another position does not make it stale', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190); pin(app, inst.BRVO.id, 30);
  const a = await buy(app, book, acct, inst.ALFA, 300);
  const b = await buy(app, book, acct, inst.BRVO, 300);
  await advance(app, clock, 1000);
  const ra = app.hedge.openForStrategy(a.id).id, rb = app.hedge.openForStrategy(b.id).id;
  assert.deepEqual([app.hedge.get(ra).freshness.status, app.hedge.get(rb).freshness.status], ['current', 'current']);
  // B's hedge is executed: 3 puts x 100 = 300 units, all of it committed to B's 300 shares. Nothing is left for A.
  const pv = await app.hedge.previewPackage(rb, 'demo-protective');
  assert.equal(pv.legs[0].qty, 3);
  await confirm(app, pv);
  assert.equal(app.hedge.get(ra).freshness.status, 'current', 'a hedge put on for another position, with no capacity left, changes nothing for this one');
  assert.equal(app.hedge.get(ra).canExecute, true);
  // An ALFA put then appears in the Account, tied to nothing: it could apply to A, so A's recommendation no longer rests on current facts.
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: inst.ALFA.id, legs: [{ kind: 'trade', action: 'buy', qty: 1, purpose: 'hedge', option: optSpec(inst.ALFA, 180, 'P') }] });
  const h = app.hedge.get(ra);
  assert.equal(h.freshness.status, 'stale');
  assert.deepEqual(h.freshness.changes, ['Hedges held in scope changed: 1 added.']);
});

// ---- reconnection -------------------------------------------------------------------------------------------------

test('reconnection refreshes waiting requests against current exposure: a position that grew, one that shrank, one that was closed', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 1_000_000 });
  pin(app, inst.ALFA.id, 190); pin(app, inst.BRVO.id, 30); pin(app, inst.CHRL.id, 50);
  app.data.setSetting('demo.hedgeFixture', false);
  const grew = await buy(app, book, acct, inst.ALFA, 300);
  const shrank = await buy(app, book, acct, inst.BRVO, 400);
  const closed = await buy(app, book, acct, inst.CHRL, 200);
  await advance(app, clock, 1000);
  const idOf = (s) => app.hedge.list(book.id).find((r) => r.strategyId === s.id).id;
  const ids = [idOf(grew), idOf(shrank), idOf(closed)];
  assert.deepEqual(ids.map((id) => app.hedge.get(id).state), ['awaiting_connection', 'awaiting_connection', 'awaiting_connection']);
  // While waiting: 300 -> 600 (doubled), 400 -> 100 (300 sold), 200 -> 0 (closed).
  await confirm(app, await app.packages.previewAction(grew.id, 'resize', { factor: 2 }));
  await confirm(app, await app.packages.previewAction(shrank.id, 'close', { positionIds: [shrank.positions[0].positionId], qty: 300 }));
  await confirm(app, await app.packages.previewAction(closed.id, 'close', {}));
  const ordersBefore = [grew, shrank, closed].map((s) => app.orders.forStrategy(s.id).length);
  // The service comes up.
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcPut(inst.ALFA, 180, 1)])] }] });
  await advance(app, clock, 3000);
  const [g, sh, cl] = ids.map((id) => app.hedge.get(id));
  assert.deepEqual([g.state, g.request.primary.quantity, g.freshness.status], ['recommendation_ready', 600, 'current']);
  assert.deepEqual([sh.state, sh.request.primary.quantity, sh.freshness.status], ['recommendation_ready', 100, 'current']);
  assert.equal(cl.state, 'closed');
  assert.match(cl.message, /^The position this request was for was closed on 2026-03-02 before a recommendation arrived\. Nothing was sent after that\.$/);
  assert.equal(cl.response, null);
  assert.equal(app.hedge.scriptView().used, 2, 'two requests were sent; the closed one was not');
  assert.equal(app.hedge.list(book.id).length, 3, 'refreshed in place: no new requests');
  assert.deepEqual([grew, shrank, closed].map((s) => app.orders.forStrategy(s.id).length), ordersBefore, 'receiving recommendations executed nothing');
  assert.deepEqual(app.alerts.open(book.id).filter((a) => a.code === 'hedge.ready').map((a) => a.ref_id).sort(), [g.id, sh.id].sort());
  assert.deepEqual(app.hedge.queue(book.id).items.map((x) => x.id).sort(), [g.id, sh.id].sort(), 'the closed request needs no decision');
  await assert.rejects(app.hedge.refresh(cl.id), /is closed and cannot be refreshed/);
  await assert.rejects(app.hedge.complete(cl.id, { holdingPeriod: { days: 10 } }), /is closed/);
  // A recommendation that was ready when its position was closed is closed too, and cannot be executed.
  await confirm(app, await app.packages.previewAction(grew.id, 'close', {}));
  await advance(app, clock, 1000);
  const gone = app.hedge.get(g.id);
  assert.equal(gone.state, 'closed');
  assert.match(gone.message, /closed on 2026-03-02\. It can no longer be executed\./);
  const pv = await app.hedge.previewPackage(g.id, 'scripted-1');
  assert.ok(pv.blocking >= 1);
  assert.match(pv.checks.find((c) => c.code === 'hedge-stale').message, /is closed/);
  assert.deepEqual(ledgerImbalance(app), []);
});

// ---- shared identifiers, idempotency ----------------------------------------------------------------------------

test('one request per primary: re-running any step, a financing leg or a hedge leg never creates another', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app); // the Account holds 500,000 USD
  pin(app, inst.ALFA.id, 190);
  // 3,000 ALFA at 190 = 570,000: 70,000 more than the Account holds, so the package carries a loan leg.
  const s = await buy(app, book, acct, inst.ALFA, 3000, { financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } });
  assert.deepEqual(s.orders.map((o) => [o.legNo, o.kind, o.purpose]), [[1, 'loan', 'financing'], [2, 'trade', 'primary']]);
  await advance(app, clock, 1000);
  const all = () => app.hedge.list(book.id);
  assert.equal(all().length, 1, 'one request, for the primary; none for the financing leg');
  const id = all()[0].id;
  assert.deepEqual([all()[0].strategyId, all()[0].request.primary.instrument.symbol, all()[0].request.primary.quantity], [s.id, 'ALFA', 3000]);
  // Stored identifiers tie the loan to the position it funds.
  const rows = app.accounting.openPositions(book.id, acct.id).positions;
  const loan = rows.find((p) => p.family === 'loan'), stock = rows.find((p) => p.family === 'equity');
  assert.deepEqual(loan.relationships.map((r) => [r.kind, r.text, r.positionId, r.strategyInstanceId]), [['finances', 'Financing for Long 3,000 ALFA', stock.positionId, s.id]]);
  assert.ok(stock.relationships.some((r) => r.kind === 'financed_by' && r.positionId === loan.positionId && r.text === `Financed by cash borrowing of 70,000 USD, borrowing ${loan.positionId}`));
  assert.equal(app.accounting.borrowings(book.id, acct.id)[0].id, loan.positionId, 'the borrowing register uses the same id');
  assert.deepEqual(app.packages.strategyView(s.id).hedge.links.legs.map((l) => [l.legNo, l.text]), [[1, 'Financing for leg 2 (buy 3,000 ALFA)']]);
  // Re-running every step that could ask again.
  app.hedge.onStrategyChange(s.id, 'working', 'open');
  await app.hedge.processQueue();
  await advance(app, clock, 60e3, { ticks: 3 });
  const again = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, scope: { type: 'trade' }, trigger: 'post_trade' });
  const byHand = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, trigger: 'manual' });
  assert.deepEqual([again.id, byHand.id], [id, id], 'the open request is reused in place');
  assert.equal(all().length, 1);
  // A borrowing made directly from a Marketplace has no primary exposure: no request.
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', origin: 'marketplace', ...CTX, legs: [{ kind: 'loan', action: 'borrow_cash', qty: 10_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'USD loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-09-02', counterparty: 'Simulated lender' } } }] });
  await advance(app, clock, 1000, { ticks: 2 });
  assert.equal(all().length, 1, 'a financing position asks for no hedge of its own');
  // Executing the hedge creates hedge legs; they ask for nothing, and the automatic step stays done.
  const pv = await app.hedge.previewPackage(id, 'demo-protective');
  assert.equal(pv.legs[0].qty, 30, 'the demo fixture sized 30 contracts for 3,000 shares (illustrative)');
  await confirm(app, pv);
  await advance(app, clock, 1000, { ticks: 2 });
  app.hedge.onStrategyChange(s.id, 'working', 'open');
  await app.hedge.processQueue();
  const after = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, scope: { type: 'trade' }, trigger: 'post_trade' });
  assert.equal(after.id, id, 'the post-trade request is made once per position');
  assert.equal(all().length, 1);
  const legs = app.packages.strategyView(s.id).hedge.links.legs;
  assert.deepEqual(legs.map((l) => [l.legNo, l.text]), [[1, 'Financing for leg 2 (buy 3,000 ALFA)'], [3, `Hedge leg of request ${id}`]]);
  assert.deepEqual(ledgerImbalance(app), []);
});

// ---- investment Strategies by stable ID -----------------------------------------------------------------------------

test('investment Strategies use the service\'s IDs; a typed name stays unresolved until the user confirms a match', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190); pin(app, inst.BRVO.id, 30);
  // Demo mode: the labelled fixture supplies a small fictional list with IDs. Analytics Lab itself stays awaiting.
  let list = await app.hedge.strategiesView(book.id);
  assert.equal(list.available, true);
  assert.deepEqual(list.source, { kind: 'demo-fixture', label: 'Demo fixture, not Analytics Lab' });
  assert.deepEqual(list.items.map((x) => [x.id, x.name]), [['DEMO-IS-001', 'Quality Compounders'], ['DEMO-IS-002', 'Core Equity'], ['DEMO-IS-003', 'Global Macro Carry']]);
  assert.equal(list.state.connection, 'awaiting');
  // One position chosen by ID, one with a typed name that happens to equal a listed name.
  const byId = await buy(app, book, acct, inst.ALFA, 100, { investmentStrategy: { id: 'DEMO-IS-001' } });
  const typed = await buy(app, book, acct, inst.BRVO, 100, { investmentStrategy: { name: 'core equity' } });
  await advance(app, clock, 1000);
  const reqOf = (s) => app.hedge.list(book.id).find((r) => r.strategyId === s.id);
  assert.deepEqual(reqOf(byId).request.investmentStrategy, { id: 'DEMO-IS-001', name: 'Quality Compounders', resolved: true, source: 'Demo fixture, not Analytics Lab', version: 'demo-1', note: null });
  assert.deepEqual(reqOf(typed).request.investmentStrategy, { id: null, name: 'core equity', resolved: false, source: null, version: null, note: null }, 'an exact name match is never applied by itself');
  // The match is suggested, for the user to confirm.
  list = await app.hedge.strategiesView(book.id);
  const use = list.inUse.find((x) => x.name === 'core equity');
  assert.deepEqual([use.resolved, use.suggestion, use.strategyInstances, use.hedgeRequests], [false, { id: 'DEMO-IS-002', name: 'Core Equity' }, 1, 1]);
  assert.equal(list.inUse.find((x) => x.id === 'DEMO-IS-001').suggestion, null);
  // An ID that is not in the list is not accepted as an ID.
  const bad = await app.hedge.strategyRef({ id: 'NOT-LISTED', name: 'Something' });
  assert.deepEqual([bad.id, bad.resolved, bad.note], [null, false, 'ID NOT-LISTED is not in the Strategy list supplied by Demo fixture, not Analytics Lab.']);
  await assert.rejects(app.hedge.resolveStrategyName({ bookId: book.id, name: 'core equity', id: 'NOT-LISTED' }), /is not in the list/);
  // The user confirms: every use of that name in the Book takes the ID; the stored ID is what is sent from then on.
  const done = await app.hedge.resolveStrategyName({ bookId: book.id, name: 'core equity', id: 'DEMO-IS-002' });
  assert.deepEqual([done.strategies, done.requests, done.resolved.id, done.resolved.resolvedFrom], [1, 1, 'DEMO-IS-002', 'core equity']);
  assert.deepEqual([reqOf(typed).request.investmentStrategy.id, reqOf(typed).request.investmentStrategy.name, reqOf(typed).request.investmentStrategy.resolved], ['DEMO-IS-002', 'Core Equity', true]);
  const sv = app.packages.strategyView(typed.id);
  assert.deepEqual([sv.hedge.investmentStrategy.id, sv.hedge.investmentStrategy.resolved], ['DEMO-IS-002', true]);
  // The execution template is a separate thing from the investment Strategy.
  assert.deepEqual([sv.template, sv.templateName], ['long', 'Long']);
  // With the list unavailable a typed name stays unresolved, an ID given without a list is not trusted,
  // and a reference resolved earlier keeps its ID and says where it came from.
  app.data.setSetting('demo.hedgeFixture', false);
  list = await app.hedge.strategiesView(book.id);
  assert.equal(list.available, false);
  assert.deepEqual(await app.hedge.strategyRef({ name: 'Typed Later' }), { id: null, name: 'Typed Later', resolved: false });
  assert.deepEqual(await app.hedge.strategyRef({ id: 'DEMO-IS-003' }), { id: null, name: 'DEMO-IS-003', resolved: false });
  const kept = await app.hedge.strategyRef(app.packages.getStrategyRow(byId.id).params.investmentStrategy.resolved ? app.packages.getStrategyRow(byId.id).params.investmentStrategy : reqOf(byId).request.investmentStrategy);
  assert.deepEqual([kept.id, kept.resolved, kept.source], ['DEMO-IS-001', true, 'Demo fixture, not Analytics Lab']);
  await assert.rejects(app.hedge.resolveStrategyName({ bookId: book.id, name: 'x', id: 'DEMO-IS-001' }), /The Strategy list is not available: Awaiting Shaffer data connection/);
});

test('normal mode: the Strategy list is awaiting, hedge requests wait, and no fixture can be loaded', async () => {
  const { app } = makeApp({ demo: false });
  const stock = app.instruments.create({ productId: 'common_stock', name: 'Example Corp', symbol: 'EXMP', marketView: 'US_CASH', venue: 'NYSE', tradingCcy: 'USD' });
  const { book, acct } = makeBook(app);
  const list = await app.hedge.strategiesView(book.id);
  assert.deepEqual([list.available, list.items, list.source], [false, [], null]);
  const r = await app.hedge.request({ bookId: book.id, unitId: acct.id, instrumentId: stock.id, quantity: 100, direction: 'long', trigger: 'manual', investmentStrategy: { id: 'S-1', name: 'Typed' }, holdingPeriod: { days: 30 }, objective: { type: 'downside_protection' } });
  assert.deepEqual([r.state, r.complete, r.connection.reachable, r.connection.kind, r.connection.fixture], ['awaiting_connection', true, false, 'shaffer-hedge', false]);
  assert.deepEqual([r.request.investmentStrategy.id, r.request.investmentStrategy.resolved], [null, false], 'an ID is not accepted while the list is unavailable');
  assert.throws(() => app.hedge.setScript({ responses: [] }), /only be loaded in demo mode/);
  assert.equal(app.hedge.serviceStatus().script, null);
});

// ---- what a recommendation leaves to the desk: collateral basis of an OTC leg, and a fill price ----------------------

// A scripted total-return swap leg on `notional` of ALFA. `terms` adds to the contract terms (for example a collateral basis).
const svcSwap = (und, notional, terms = {}) => ({
  role: 'hedge', hedgeFamily: 'Total-return and equity swaps', kind: 'trade', action: 'buy', quantity: notional,
  contract: {
    productId: 'equity_trs', name: `TRS on ${und.symbol} (scripted)`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', underlyingId: und.id,
    terms: {
      effective: '2026-03-02', maturity: '2026-09-02', counterparty: 'Scripted dealer', initialPrices: { A: 200 },
      legs: [{ id: 'A', side: 'pay', type: 'return', ccy: 'USD', months: 3, underlyingId: und.id, passDividends: true, resetNotional: false }, { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'SIM-ON', spread: 0.005, months: 3, dayCount: 'ACT/360' }],
      ...terms,
    },
  },
  indicative: { value: 0, status: 'indicative', source: 'Test fixture' },
});
const coll = (pv, n = 1) => pv.hedge.completion.legs.find((l) => l.n === n).collateral;
const errorCodes = (pv) => pv.checks.filter((c) => c.level === 'error').map((c) => c.code);

test('an OTC hedge leg with no collateral basis stated waits for the desk to choose one; each choice is validated and nothing is assumed', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  // The "service" proposes a swap on 100,000 (500 ALFA at 200) and a put, and states no collateral terms for the swap.
  app.hedge.setScript({ responses: [{ version: 'run-7', packages: [svcPackage([svcSwap(inst.ALFA, 100_000), svcPut(inst.ALFA, 180, 1)])] }] });
  const s = await buy(app, book, acct, inst.ALFA, 500);
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];

  // As received: blocked, with the reason, and the two things only the desk can supply are named.
  const bare = await app.hedge.previewPackage(h.id, 'scripted-1');
  assert.deepEqual(errorCodes(bare), ['collateral-basis']);
  assert.match(bare.checks.find((c) => c.code === 'collateral-basis').message, /states no collateral terms\. Choose a collateral agreement, enter position-level terms, or choose "Uncollateralized \(paper assumption\)"/);
  assert.deepEqual(bare.hedge.completion.missing.map((m) => [m.leg, m.what]), [[1, 'collateral'], [1, 'price']]);
  assert.deepEqual([coll(bare).origin, coll(bare).statedByService, coll(bare).needsChoice, coll(bare).canChoose, coll(bare).basis], ['none', false, true, true, null]);
  assert.equal(bare.hedge.completion.legs[1].collateral, null, 'a listed option has no collateral basis to choose');
  assert.equal(bare.totals.cash.USD.margin, 0, 'no collateral figure is invented');

  // Explicitly uncollateralized: allowed, nothing is posted.
  const none = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'uncollateralized' } } });
  assert.deepEqual(errorCodes(none), []);
  assert.deepEqual([coll(none).origin, coll(none).label, coll(none).independent.delta, coll(none).needsChoice], ['chosen', 'Uncollateralized (paper assumption)', 0, false]);
  assert.equal(none.totals.cash.USD.margin, 0);
  assert.deepEqual(none.hedge.completion.missing.map((m) => m.what), ['price'], 'the swap still has no executable quote');

  // Position-level terms. 5% of 100,000 = 5,000; a fixed amount is taken as stated.
  const pct = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'position', independentAmount: { type: 'pct', pct: 0.05 } } } });
  assert.deepEqual([coll(pct).label, coll(pct).independent.delta, pct.totals.cash.USD.margin], ['Position-level terms', 5_000, 5_000]);
  const fixed = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'position', independentAmount: { type: 'fixed', amount: 2_500 }, variationMargin: true, threshold: 1_000 } } });
  assert.deepEqual([coll(fixed).independent.delta, coll(fixed).variationMargin, coll(fixed).basis.threshold], [2_500, true, 1_000]);

  // An agreement of this Book that covers the Account. 8% of 100,000 = 8,000.
  const csa = app.agreements.create(book.id, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [acct.id], terms: { independentAmount: { type: 'pct', pct: 0.08 } } });
  const under = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'agreement', agreementId: csa.id } } });
  assert.deepEqual(errorCodes(under), []);
  assert.deepEqual([coll(under).origin, coll(under).basis, coll(under).independent.delta], ['chosen', { type: 'agreement', agreementId: csa.id }, 8_000]);
  assert.match(coll(under).label, /^CSA Dealer A \(bilateral/);

  // Agreements that cannot be used are refused by the preview with the reason, and the choice stays open.
  const tsyOnly = app.agreements.create(book.id, { name: 'CSA Treasury only', counterparty: 'Dealer B', kind: 'bilateral', unitIds: [treasury.id], terms: {} });
  const uncovered = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'agreement', agreementId: tsyOnly.id } } });
  assert.deepEqual(errorCodes(uncovered), ['collateral-not-covered']);
  assert.deepEqual([coll(uncovered).needsChoice, /does not cover Alpha/.test(coll(uncovered).problem)], [true, true]);
  const other = makeBook(app, { name: 'Other Book' });
  const foreign = app.agreements.create(other.book.id, { name: 'CSA elsewhere', counterparty: 'Dealer C', kind: 'bilateral', unitIds: [other.acct.id], terms: {} });
  const crossed = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'agreement', agreementId: foreign.id } } });
  assert.deepEqual(errorCodes(crossed), ['collateral-other-book'], 'collateral never crosses Books');
  assert.equal(coll(crossed).needsChoice, true);
  const ghost = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'agreement', agreementId: 'AGR-NOPE' } } });
  assert.deepEqual(errorCodes(ghost), ['collateral-basis']);
  assert.match(coll(ghost).problem, /does not exist/);

  // A choice that is not a basis, or is aimed at the wrong leg, is refused outright.
  const bad = (collateral, re) => assert.rejects(app.hedge.previewPackage(h.id, 'scripted-1', { collateral }), re);
  await bad({ 1: { type: 'position', independentAmount: { type: 'pct', pct: 1.5 } } }, /Leg 1: The independent amount is a share of notional between 0 and 1/);
  await bad({ 1: { type: 'agreement' } }, /Leg 1: Choose the collateral agreement this contract falls under/);
  await bad({ 1: { type: 'house rules' } }, /Leg 1: Choose the collateral basis/);
  await bad({ 2: { type: 'uncollateralized' } }, /Leg 2 is not an OTC contract/);
  await bad({ 3: { type: 'uncollateralized' } }, /this package has no leg 3/);
  await assert.rejects(app.hedge.previewPackage(h.id, 'scripted-1', { statedPrices: { 1: -1 } }), /Leg 1: a stated fill price is a number, zero or more/);

  // Completed (agreement, swap entered at zero upfront) and executed exactly as displayed.
  const pv = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'agreement', agreementId: csa.id } }, statedPrices: { 1: 0 } });
  assert.deepEqual([pv.blocking, pv.hedge.completion.missing], [0, []]);
  assert.deepEqual([pv.legs[0].statedPrice, pv.legs[0].price.executable, pv.legs[0].contract.terms.collateralBasis], [0, true, { type: 'agreement', agreementId: csa.id }]);
  assert.ok(!pv.checks.some((c) => c.code === 'no-price'));
  const out = await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation });
  assert.equal(out.strategy.id, s.id, 'the hedge joins the primary position\'s strategy instance');
  const swap = out.strategy.positions.find((p) => p.family === 'swap');
  assert.deepEqual([swap.purpose, swap.marginPosted], ['hedge', 8_000]);
  assert.equal(app.ledger.balance(acct.id, 'cash.margin', 'USD'), 8_000);
  assert.deepEqual([app.positions.get(swap.positionId).data.collateralBasis.type, app.positions.get(swap.positionId).data.collateralBasis.agreementId], ['agreement', csa.id], 'the chosen basis is on record for the position');
  // Linked to the request and the primary through stored identifiers; resets are scheduled for both swap legs.
  const mine = app.orders.forStrategy(s.id).filter((o) => o.submission === pv.token);
  assert.deepEqual(mine.map((o) => [o.status, o.data.hedgeLinkId]), [['filled', h.id], ['filled', h.id]]);
  assert.equal(app.hedge.get(h.id).state, 'executed');
  assert.ok(app.hedge.forStrategy(s.id).links.legs.some((l) => l.hedgeRequestId === h.id && new RegExp(`^Hedge leg of request ${h.id}`).test(l.text)));
  const resets = app.tasks.open([acct.id]).filter((t) => t.type === 'swap.payment' && t.position_id === swap.positionId);
  assert.ok(resets.length >= 2, 'a payment is scheduled for the return leg and for the financing leg');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a collateral basis stated by the service is shown as stated and validated; choosing another replaces it openly', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 200);
  // First answer: the service names an agreement the Book does not have. Second: it states "uncollateralized".
  app.hedge.setScript({ responses: [
    { packages: [svcPackage([svcSwap(inst.ALFA, 100_000, { collateralBasis: { type: 'agreement', agreementId: 'AGR-SERVICE-1' } })])] },
    { packages: [svcPackage([svcSwap(inst.ALFA, 100_000, { collateralBasis: { type: 'uncollateralized' } })])] },
  ] });
  await buy(app, book, acct, inst.ALFA, 500);
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  const unusable = await app.hedge.previewPackage(h.id, 'scripted-1');
  assert.deepEqual(errorCodes(unusable), ['collateral-basis']);
  assert.deepEqual([coll(unusable).origin, coll(unusable).statedByService, coll(unusable).needsChoice, coll(unusable).basis], ['recommendation', true, true, { type: 'agreement', agreementId: 'AGR-SERVICE-1' }]);
  assert.match(coll(unusable).problem, /The collateral agreement named on this contract does not exist/);
  // The desk replaces it with its own terms: 10% of 100,000 = 10,000. The origin says so.
  const replaced = await app.hedge.previewPackage(h.id, 'scripted-1', { collateral: { 1: { type: 'position', independentAmount: { type: 'pct', pct: 0.1 } } } });
  assert.deepEqual([errorCodes(replaced), coll(replaced).origin, coll(replaced).replacesStated, coll(replaced).independent.delta], [[], 'chosen', true, 10_000]);

  clock.advance(60e3);
  await app.hedge.refresh(h.id);
  const stated = await app.hedge.previewPackage(h.id, 'scripted-1');
  assert.deepEqual(errorCodes(stated), []);
  assert.deepEqual([coll(stated).origin, coll(stated).statedByService, coll(stated).needsChoice, coll(stated).label, coll(stated).independent.delta], ['recommendation', true, false, 'Uncollateralized (paper assumption)', 0]);
  assert.deepEqual(stated.hedge.completion.missing.map((m) => m.what), ['price']);
});
