// Protection allocation: what counts as protection for a position, and what does not.
//
// The "service" here is the scripted TEST FIXTURE (app.hedge.setScript): it stands in for Shaffer
// Hedge / Analytics Lab only. Requests, previews, execution, positions, allocations and the ledger
// are the real engine. Expected numbers are worked out by hand in the comments beside them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo } from '../helpers.js';

const EXP = '2026-03-20';
const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });
// A complete hedge context: without it a request is stored as incomplete and never sent.
const CTX = { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };
// Demo listed options: 100 units per contract (multiplier 100, deliverable 100 shares).
const optSpec = (und, strike, right) => ({ underlyingId: und.id, expiration: EXP, strike, right, multiplier: 100, deliverableUnits: 100, exercise: 'american', settlement: 'physical' });
/** A hedge leg as the service would return it. */
const svcOption = (und, strike, right, contracts, action = 'buy') => ({ role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action, option: optSpec(und, strike, right), quantity: contracts, sizingBasis: 'scripted', riskAddressed: 'Price' });
const svcPackage = (legs, id = 'scripted-1') => ({ id, label: 'Scripted package', recommended: true, legs });
/** A hedge leg entered by hand as its own package: it has no primary beside it. */
const ownOption = (und, strike, right, contracts) => ({ kind: 'trade', action: 'buy', qty: contracts, purpose: 'hedge', option: optSpec(und, strike, right) });
const buy = (app, book, acct, und, qty, extra = {}) => trade(app, { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: und.id, quantity: qty, origin: 'marketplace', ...CTX, ...extra });
const rows = (app, book, acct) => app.accounting.openPositions(book.id, acct.id).positions;
const rowOf = (app, book, acct, pred) => rows(app, book, acct).find(pred);
const stock = (und, strategyId) => (p) => p.instrument.id === und.id && (!strategyId || p.strategyId === strategyId);
const isOpt = (right) => (p) => p.family === 'option' && app0(p).terms.right === right;
let APP = null;
const app0 = (p) => APP.instruments.get(p.instrument.id);
/** Preview and confirm a package of a hedge request, as "Execute now" does. */
async function execute(app, requestId, packageId, opts = {}) {
  const pv = await app.hedge.previewPackage(requestId, packageId, opts);
  assert.equal(pv.blocking, 0, pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | '));
  return app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true });
}
const activeUnits = (app, hedgePositionId) => app.db.get(`SELECT COALESCE(SUM(units), 0) AS u FROM protection_allocations WHERE hedge_position_id = ? AND status = 'active'`, hedgePositionId).u;

test('an unrelated hedge in the Account is not counted: "Protection assessment unavailable." until assessed, "unrelated" after', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.data.setSetting('demo.hedgeFixture', false); // nothing answers hedge requests yet
  // Two BRVO puts held as a hedge by themselves: nothing ties them to any position.
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: inst.BRVO.id, legs: [ownOption(inst.BRVO, 24, 'P', 2)] });
  const s = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  const put = rowOf(app, book, acct, (p) => p.family === 'option');
  let alfa = rowOf(app, book, acct, stock(inst.ALFA));
  // Exposure is 300 shares. The BRVO puts have a capacity of 2 x 100 = 200 units, but nobody has
  // said they apply to ALFA, so protected = 0 and remaining = 300 - 0 = 300.
  assert.equal(alfa.protection.assessmentText, 'Protection assessment unavailable.');
  assert.equal(alfa.protection.assessment, 'unavailable');
  assert.deepEqual(alfa.protection.unassessed.map((u) => [u.hedgePositionId, u.capacity]), [[put.positionId, 200]]);
  assert.equal(alfa.protection.protectedUnits, 0);
  assert.equal(alfa.protection.remainingUnits, 300);
  assert.deepEqual(alfa.protection.linked, []);
  // The request sends the puts as context, tagged with what is known: nothing.
  const h = app.hedge.get(app.hedge.openForStrategy(s.id).id);
  assert.equal(h.state, 'awaiting_connection');
  assert.deepEqual(h.request.linkedProtection, [], 'no hedge is asserted to protect the new trade');
  assert.deepEqual(h.request.hedgesHeld.map((x) => [x.positionId, x.relation, x.capacity.units, x.capacityLeft]), [[put.positionId, 'unassessed', 200, 200]]);
  assert.equal(h.request.exposures.positions.length, 2, 'the Account\'s positions still go as context');
  // The preview does not treat the unassessed puts as protection either: a hedge package sized to the full 300 is fine.
  app.hedge.setScript({ responses: [{ version: 'run-41', packages: [svcPackage([svcOption(inst.ALFA, 180, 'P', 3)])], protection: { unrelated: [{ hedgePositionId: put.positionId, note: 'Different underlying.' }] } }] });
  await app.hedge.refreshWaiting({ force: true });
  const ready = app.hedge.get(h.id);
  assert.equal(ready.state, 'recommendation_ready');
  assert.equal(ready.source.kind, 'test-fixture');
  const pv = await app.hedge.previewPackage(h.id, 'scripted-1');
  assert.equal(pv.blocking, 0);
  assert.deepEqual(pv.protection.prior, [], 'nothing is already protecting the position');
  // The service judged the puts unrelated: the position now says so, and is still unprotected.
  alfa = rowOf(app, book, acct, stock(inst.ALFA));
  assert.equal(alfa.protection.assessmentText, null);
  assert.equal(alfa.protection.assessment, 'assessed');
  assert.deepEqual(alfa.protection.unrelated.map((u) => [u.hedgePositionId, u.note, u.source.kind, u.source.version]), [[put.positionId, 'Different underlying.', 'test-fixture', 'run-41']]);
  assert.deepEqual(alfa.protection.unassessed, []);
  assert.equal(alfa.protection.remainingUnits, 300);
  assert.equal(app.orders.forStrategy(s.id).length, 1, 'receiving the recommendation traded nothing');
});

test('partial coverage: a put linked to part of the position leaves the difference exposed', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcOption(inst.ALFA, 180, 'P', 3)])] }] });
  const s = await buy(app, book, acct, inst.ALFA, 500);
  await advance(app, clock, 1000);
  const h = app.hedge.prompts(book.id)[0];
  assert.equal(h.state, 'recommendation_ready');
  await execute(app, h.id, 'scripted-1');
  const put = rowOf(app, book, acct, (p) => p.family === 'option');
  let alfa = rowOf(app, book, acct, stock(inst.ALFA));
  // 3 contracts x 100 = 300 units of capacity against 500 shares: 300 protected, 500 - 300 = 200 remaining.
  assert.deepEqual(alfa.protection.linked.map((a) => [a.hedgePositionId, a.units, a.basis, a.requestId]), [[put.positionId, 300, 'explicit_link', h.id]]);
  assert.equal(alfa.protection.protectedUnits, 300);
  assert.equal(alfa.protection.remainingUnits, 200);
  assert.equal(alfa.protection.assessmentText, null);
  // Shared identifiers: the hedge leg names its request and what it protects; the position names its protection.
  assert.deepEqual(put.relationships.map((r) => r.text), [`Hedge leg of request ${h.id}, protects Long 500 ALFA (300 units)`]);
  assert.ok(alfa.relationships.some((r) => r.kind === 'hedged_by' && r.positionId === put.positionId && /Protected by Long 3 ALFA .*\(300 units\)/.test(r.text)));
  assert.equal(put.strategyId, s.id, 'one strategy instance id ties the hedge leg to the primary');
  assert.deepEqual([put.hedgeOf.capacity.units, put.hedgeOf.allocatedUnits, put.hedgeOf.capacityLeft], [300, 300, 0]);
  // The position is cut to 200 shares: the same 3 puts now cover all of it, with 300 - 200 = 100 units of capacity unused.
  const cut = await app.packages.previewAction(s.id, 'close', { positionIds: [alfa.positionId], qty: 300 });
  await app.packages.submit({ ...cut.input, legs: cut.legs, clientToken: cut.token, confirm: true });
  alfa = rowOf(app, book, acct, stock(inst.ALFA));
  assert.equal(alfa.qty, 200);
  assert.equal(alfa.protection.protectedUnits, 200);
  assert.equal(alfa.protection.remainingUnits, 0);
  assert.equal(rowOf(app, book, acct, (p) => p.family === 'option').hedgeOf.capacityLeft, 100);
  // The rest of the position is sold: the link is released, and the puts are left as a hedge that protects nothing.
  const rest = await app.packages.previewAction(s.id, 'close', { positionIds: [alfa.positionId], qty: 200 });
  await app.packages.submit({ ...rest.input, legs: rest.legs, clientToken: rest.token, confirm: true });
  const left = rowOf(app, book, acct, (p) => p.family === 'option');
  assert.deepEqual([left.qty, left.hedgeOf.allocatedUnits, left.hedgeOf.allocations.length], [3, 0, 0]);
  assert.deepEqual({ ...app.db.get('SELECT status, reason FROM protection_allocations WHERE hedge_position_id = ?', put.positionId) }, { status: 'released', reason: 'The protected position was closed.' });
  assert.deepEqual(left.relationships.map((r) => r.text), [`Hedge leg of request ${h.id}, not allocated to a position`]);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a shared hedge is allocated by the service across two positions; capacity is never counted twice', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.data.setSetting('demo.hedgeFixture', false);
  // 4 ALFA puts held as an Account hedge: capacity 4 x 100 = 400 units.
  const hs = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: inst.ALFA.id, legs: [ownOption(inst.ALFA, 180, 'P', 4)] });
  const a = await buy(app, book, acct, inst.ALFA, 300);
  const b = await buy(app, book, acct, inst.ALFA, 200);
  await advance(app, clock, 1000);
  const put = rowOf(app, book, acct, (p) => p.family === 'option');
  const posA = rowOf(app, book, acct, stock(inst.ALFA, a.id)), posB = rowOf(app, book, acct, stock(inst.ALFA, b.id));
  const ra = app.hedge.openForStrategy(a.id), rb = app.hedge.openForStrategy(b.id);
  assert.notEqual(ra.id, rb.id, 'each primary has its own request');
  assert.equal(posA.protection.assessmentText, 'Protection assessment unavailable.');

  // The service allocates 300 of the 400 units to position A.
  app.hedge.setScript({ responses: [{ version: 'run-1', packages: [], protection: { allocations: [{ hedgePositionId: put.positionId, units: 300, basis: 'shared', note: 'Same underlying.' }] } }] });
  const va = await app.hedge.refresh(ra.id);
  assert.deepEqual(va.protection.results.map((r) => [r.status, r.units]), [['active', 300]]);
  let A = rowOf(app, book, acct, stock(inst.ALFA, a.id)), B = rowOf(app, book, acct, stock(inst.ALFA, b.id));
  assert.deepEqual(A.protection.shared.map((x) => [x.hedgePositionId, x.units, x.source.kind, x.source.version]), [[put.positionId, 300, 'test-fixture', 'run-1']]);
  assert.equal(A.protection.remainingUnits, 0, '300 shares, 300 units allocated');
  // B sees the puts as allocated elsewhere, with 400 - 300 = 100 units of capacity left. Nothing is counted for B.
  assert.deepEqual(B.protection.elsewhere.map((x) => [x.hedgePositionId, x.allocatedUnits, x.capacityLeft]), [[put.positionId, 300, 100]]);
  assert.equal(B.protection.protectedUnits, 0);
  assert.equal(B.protection.remainingUnits, 200);
  assert.equal(B.protection.assessmentText, null, 'the hedge has been assessed (for A); B is simply not covered by it');

  // The service then tries to allocate 200 to B: 300 + 200 = 500 > 400. Rejected, with the arithmetic, and shown as rejected.
  app.hedge.setScript({ responses: [{ version: 'run-2', packages: [], protection: { allocations: [{ hedgePositionId: put.positionId, units: 200 }] } }] });
  const over = await app.hedge.refresh(rb.id);
  assert.equal(over.protection.results[0].status, 'rejected');
  assert.match(over.protection.results[0].reason, /would allocate 200 units of Long 4 ALFA .*, but only 100 of its 400 units of capacity are left \(300 to Long 300 ALFA\)\. Capacity is never counted twice\./);
  B = rowOf(app, book, acct, stock(inst.ALFA, b.id));
  assert.equal(B.protection.protectedUnits, 0);
  assert.equal(B.protection.rejected.length, 1);
  assert.equal(activeUnits(app, put.positionId), 300);

  // 100 fits exactly: 300 + 100 = 400 = capacity. B: 200 - 100 = 100 remaining.
  app.hedge.setScript({ responses: [{ version: 'run-3', packages: [], protection: { allocations: [{ hedgePositionId: put.positionId, units: 100 }] } }] });
  await app.hedge.refresh(rb.id);
  B = rowOf(app, book, acct, stock(inst.ALFA, b.id));
  assert.deepEqual(B.protection.shared.map((x) => x.units), [100]);
  assert.equal(B.protection.remainingUnits, 100);
  assert.deepEqual(B.protection.rejected, [], 'the newer answer to the same request replaces the rejected one');
  assert.equal(activeUnits(app, put.positionId), 400);
  assert.equal(rowOf(app, book, acct, (p) => p.family === 'option').hedgeOf.capacityLeft, 0);
  assert.ok(rowOf(app, book, acct, (p) => p.family === 'option').relationships.some((r) => /Shared protection identified by Test fixture .*, protects Long 300 ALFA \(300 units\)/.test(r.text)));

  // Nothing is allocated across Books, and a hedge that is not held cannot be allocated.
  const other = makeBook(app, { name: 'Other Book' });
  const foreign = await trade(app, { bookId: other.book.id, unitId: other.acct.id, template: 'custom', underlyingId: inst.ALFA.id, legs: [ownOption(inst.ALFA, 180, 'P', 1)] });
  const foreignPut = foreign.positions[0].positionId;
  app.hedge.setScript({ responses: [{ packages: [], protection: { allocations: [{ hedgePositionId: foreignPut, units: 50 }, { hedgePositionId: 'POS-NOPE', units: 10 }, { hedgePositionId: put.positionId, units: 100 }] } }] });
  const mixed = await app.hedge.refresh(rb.id);
  assert.match(mixed.protection.results[0].reason, /another Book .* Nothing is allocated across Books\./);
  assert.match(mixed.protection.results[1].reason, /which the Terminal does not hold/);
  assert.equal(mixed.protection.results[2].status, 'active', 'a valid allocation in the same answer still stands');
  assert.equal(activeUnits(app, foreignPut), 0);

  // The Account hedge is closed: every allocation from it is released and both positions are unprotected again.
  const closeIt = await app.packages.previewAction(hs.id, 'close', {});
  await app.packages.submit({ ...closeIt.input, legs: closeIt.legs, clientToken: closeIt.token, confirm: true });
  A = rowOf(app, book, acct, stock(inst.ALFA, a.id)); B = rowOf(app, book, acct, stock(inst.ALFA, b.id));
  assert.equal(A.protection.remainingUnits, 300);
  assert.equal(B.protection.remainingUnits, 200);
  assert.deepEqual(app.db.all(`SELECT status, reason FROM protection_allocations WHERE hedge_position_id = ? AND status <> 'rejected' ORDER BY status`, put.positionId).map((r) => r.status).filter((x) => x === 'active'), []);
  assert.ok(app.db.all(`SELECT reason FROM protection_allocations WHERE hedge_position_id = ? AND status = 'released'`, put.positionId).some((r) => r.reason === 'The hedge position was closed.'));
  // A closed hedge cannot be allocated afterwards, and A's recommendation is now stale.
  app.hedge.setScript({ responses: [{ packages: [], protection: { allocations: [{ hedgePositionId: put.positionId, units: 100 }] } }] });
  const late = await app.hedge.refresh(rb.id);
  assert.match(late.protection.results[0].reason, /The hedge position ALFA .* is closed\./);
  const staleA = app.hedge.get(ra.id);
  assert.equal(staleA.freshness.status, 'stale');
  assert.match(staleA.freshness.changes.join(' '), /Hedges held in scope changed: 1 closed or expired/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('opposite-direction exposure: a put linked to a long does not protect a short in the same name', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 1_000_000 });
  pin(app, inst.ALFA.id, 190);
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcOption(inst.ALFA, 180, 'P', 3)])] }] });
  const long = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  await execute(app, app.hedge.openForStrategy(long.id).id, 'scripted-1');
  app.hedge.setScript({ responses: [] });
  const short = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 200 });
  await advance(app, clock, 1000);
  const put = rowOf(app, book, acct, isOpt('P'));
  let sh = rowOf(app, book, acct, (p) => p.instrument.id === inst.ALFA.id && p.qty < 0);
  assert.equal(sh.qty, -200);
  // The put is fully used by the long (3 x 100 = 300 units on 300 shares) and protects nothing else.
  assert.equal(rowOf(app, book, acct, stock(inst.ALFA, long.id)).protection.remainingUnits, 0);
  assert.deepEqual(sh.protection.linked, []);
  assert.equal(sh.protection.protectedUnits, 0);
  assert.equal(sh.protection.remainingUnits, 200);
  assert.deepEqual(sh.protection.elsewhere.map((x) => [x.hedgePositionId, x.capacityLeft, x.allocatedTo[0].label]), [[put.positionId, 0, 'Long 300 ALFA']]);
  assert.equal(app.accounting.openPositions(book.id, acct.id).holdings.find((x) => x.instrument.id === inst.ALFA.id).net, 100, 'gross holdings stay gross: long 300, short 200');
  // A put bought as a hedge leg inside the SHORT's own strategy instance is not counted for it either:
  // a put covers long units. It is held, unallocated, so the short's assessment is unavailable.
  const addPut = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: short.id, intent: 'adjust', legs: [ownOption(inst.ALFA, 185, 'P', 2)] });
  await app.packages.submit({ ...addPut.input, legs: addPut.legs, clientToken: addPut.token, confirm: true });
  sh = rowOf(app, book, acct, (p) => p.instrument.id === inst.ALFA.id && p.qty < 0);
  assert.equal(sh.protection.protectedUnits, 0);
  assert.equal(sh.protection.remainingUnits, 200);
  assert.equal(sh.protection.assessmentText, 'Protection assessment unavailable.');
  // Two calls in the short's strategy instance do cover it: 2 x 100 = 200 units of the 200 short.
  const addCall = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: short.id, intent: 'adjust', legs: [ownOption(inst.ALFA, 200, 'C', 2)] });
  await app.packages.submit({ ...addCall.input, legs: addCall.legs, clientToken: addCall.token, confirm: true });
  sh = rowOf(app, book, acct, (p) => p.instrument.id === inst.ALFA.id && p.qty < 0);
  assert.deepEqual(sh.protection.linked.map((x) => [x.units, x.basis]), [[200, 'template']]);
  assert.equal(sh.protection.remainingUnits, 0);
  // The securities borrow is financing for the short, by stored identifiers, and asked for no hedge of its own.
  const borrow = rowOf(app, book, acct, (p) => p.family === 'secloan');
  assert.deepEqual(borrow.relationships.map((r) => [r.kind, r.text, r.positionId]), [['finances', 'Securities borrow for Short 200 ALFA', sh.positionId]]);
  assert.equal(app.hedge.list(book.id).filter((r) => r.strategyId === short.id).length, 0, 'a Strategy-page short asks for no post-trade hedge; its borrow and hedge legs ask for none either');
  assert.deepEqual(ledgerImbalance(app), []);
});

test('expired protection is released at expiry and the position is unprotected again', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcOption(inst.ALFA, 180, 'P', 3)])] }] });
  const s = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  await execute(app, app.hedge.openForStrategy(s.id).id, 'scripted-1');
  const put = rowOf(app, book, acct, (p) => p.family === 'option');
  assert.equal(rowOf(app, book, acct, stock(inst.ALFA)).protection.remainingUnits, 0, '3 x 100 units on 300 shares');
  // Expiration day: ALFA closes at 195, above the 180 strike, so the puts expire worthless.
  app.data.market.set(`${inst.ALFA.id}@${EXP}`, { value: 195 });
  await goTo(app, clock, `${EXP}T21:30:00.000Z`);
  const alfa = rowOf(app, book, acct, stock(inst.ALFA));
  assert.equal(rowOf(app, book, acct, (p) => p.family === 'option'), undefined, 'the puts are gone');
  assert.deepEqual(alfa.protection.linked, []);
  assert.equal(alfa.protection.protectedUnits, 0);
  assert.equal(alfa.protection.remainingUnits, 300);
  const al = app.db.get('SELECT status, reason, units FROM protection_allocations WHERE hedge_position_id = ?', put.positionId);
  assert.deepEqual({ ...al }, { status: 'expired', reason: `The hedge expired on ${EXP}.`, units: 300 });
  assert.equal(app.packages.strategyView(s.id).hedge.review.needed, true, 'the strategy is flagged for a hedge review; nothing is traded');
  // An expired hedge cannot be allocated by a later assessment.
  app.hedge.setScript({ responses: [] });
  const again = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, trigger: 'review' });
  app.hedge.setScript({ responses: [{ packages: [], protection: { allocations: [{ hedgePositionId: put.positionId, units: 300 }] } }] });
  const v = await app.hedge.refresh(again.id);
  assert.match(v.protection.results[0].reason, /expired on 2026-03-20/);
  assert.equal(rowOf(app, book, acct, stock(inst.ALFA)).protection.remainingUnits, 300);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('protection already in a template (collar): a hedge package requested afterwards is measured against what remains', async () => {
  const { app, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app, { cash: 2_000_000, account: 1_000_000 });
  pin(app, inst.ALFA.id, 190);
  const s = await trade(app, { bookId: book.id, unitId: acct.id, template: 'long_collar', underlyingId: inst.ALFA.id, quantity: 1000, options: { expiration: EXP, strikes: { put: 180, call: 200 } }, origin: 'strategy_page', ...CTX });
  const alfa = rowOf(app, book, acct, stock(inst.ALFA));
  const put = rowOf(app, book, acct, isOpt('P')), call = rowOf(app, book, acct, isOpt('C'));
  // The collar's own put: 10 contracts x 100 = 1,000 units on 1,000 shares. The written call is not protection.
  assert.deepEqual(alfa.protection.linked.map((x) => [x.hedgePositionId, x.units, x.basis]), [[put.positionId, 1000, 'template']]);
  assert.equal(alfa.protection.remainingUnits, 0);
  assert.deepEqual(put.relationships.map((r) => r.text), ['Protection from the execution template, protects Long 1,000 ALFA (1,000 units)']);
  assert.deepEqual(call.relationships.map((r) => r.text), ['Hedge leg, a written option: not counted as protection']);
  assert.equal(app.hedge.list(book.id).length, 0, 'a Strategy package with its protection included asks for no post-trade hedge');
  // A hedge is then requested for the position. The request states the collar's legs as linked.
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcOption(inst.ALFA, 175, 'P', 10)])] }] });
  const h = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: s.id, trigger: 'manual', objective: { type: 'downside_protection' } });
  assert.deepEqual(h.request.linkedProtection.map((x) => [x.positionId, x.allocatedUnits]).sort(), [[call.positionId, 0], [put.positionId, 1000]].sort());
  assert.deepEqual(h.request.hedgesHeld.map((x) => x.relation), ['linked', 'linked']);
  // Adding 10 more puts (1,000 units) to a position with 1,000 - 1,000 = 0 units unprotected is blocked until it is deliberate.
  const blocked = await app.hedge.previewPackage(h.id, 'scripted-1');
  const chk = blocked.checks.find((c) => c.code === 'extra-protection');
  assert.equal(chk.level, 'error');
  assert.match(chk.message, /from the execution template \(1,000 units\)/);
  assert.match(chk.message, /exposure in ALFA is 1,000 units, of which 1,000 are already protected, leaving 0; the package adds puts on 1,000/);
  const deliberate = await app.hedge.previewPackage(h.id, 'scripted-1', { extraProtection: true });
  assert.equal(deliberate.blocking, 0);
  assert.equal(deliberate.checks.find((c) => c.code === 'extra-protection').level, 'warning');
});

test('a hedge held in the Account is protection for a new trade only after the service allocates it', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 190);
  app.data.setSetting('demo.hedgeFixture', false);
  await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', underlyingId: inst.ALFA.id, legs: [ownOption(inst.ALFA, 180, 'P', 4)] });
  const s = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  const put = rowOf(app, book, acct, (p) => p.family === 'option');
  const id = app.hedge.openForStrategy(s.id).id;
  // Unassessed: a package of 3 puts for the 300 shares is not a duplicate of anything.
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcOption(inst.ALFA, 185, 'P', 3)])] }] });
  await app.hedge.refresh(id);
  let pv = await app.hedge.previewPackage(id, 'scripted-1');
  assert.equal(pv.blocking, 0);
  assert.ok(!pv.checks.some((c) => c.code === 'extra-protection'));
  // The service now allocates 300 of the Account puts' 400 units to the position and still proposes 3 puts:
  // exposure 300, already protected 300, leaving 0, the package adds 300. That is a duplicate and is stopped.
  app.hedge.setScript({ responses: [{ packages: [svcPackage([svcOption(inst.ALFA, 185, 'P', 3)])], protection: { allocations: [{ hedgePositionId: put.positionId, units: 300 }] } }] });
  await app.hedge.refresh(id);
  pv = await app.hedge.previewPackage(id, 'scripted-1');
  const chk = pv.checks.find((c) => c.code === 'extra-protection');
  assert.equal(chk.level, 'error');
  assert.match(chk.message, /shared protection identified by Test fixture \(scripted, not Shaffer Hedge\) \(300 units\)/);
  assert.match(chk.message, /of which 300 are already protected, leaving 0; the package adds puts on 300/);
});

test('a hedge with no unit measure: an explicit link is named but not counted; a service allocation must state the capacity', async () => {
  const { app, clock, inst } = makeApp(); APP = app;
  const { book, acct } = makeBook(app, { cash: 3_000_000, account: 2_000_000 });
  pin(app, inst.ALFA.id, 190);
  pin(app, inst.BRVO.id, 30);
  const fut = app.instruments.list({ family: 'future' }).filter((f) => f.terms.root === 'S5').sort((x, y) => (x.terms.expiration < y.terms.expiration ? -1 : 1))[0];
  await app.data.refresh({ instruments: [fut] });
  // A future executed from the position's own hedge request: linked, no unit measure.
  app.hedge.setScript({ responses: [{ packages: [svcPackage([{ role: 'hedge', hedgeFamily: 'Futures and forwards', kind: 'trade', action: 'sell', instrumentId: fut.id, quantity: 1 }])] }] });
  const a = await buy(app, book, acct, inst.ALFA, 300);
  await advance(app, clock, 1000);
  await execute(app, app.hedge.openForStrategy(a.id).id, 'scripted-1');
  const A = rowOf(app, book, acct, stock(inst.ALFA, a.id));
  const linkedFut = rowOf(app, book, acct, (p) => p.family === 'future');
  assert.deepEqual(A.protection.linked.map((x) => [x.hedgePositionId, x.units, x.basis]), [[linkedFut.positionId, null, 'explicit_link']]);
  assert.equal(A.protection.unmeasured.length, 1);
  assert.equal(A.protection.protectedUnits, 0, 'not counted in units');
  assert.equal(A.protection.remainingUnits, 300);
  assert.equal(linkedFut.hedgeOf.capacity.units, null);
  assert.match(linkedFut.hedgeOf.capacity.note, /no unit measure in the Terminal/);
  // A second position, and a second future held as an Account hedge by itself.
  app.hedge.setScript({ responses: [] });
  const own = await trade(app, { bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'sell', instrumentId: fut.id, qty: 2, purpose: 'hedge' }] });
  const b = await buy(app, book, acct, inst.BRVO, 1000);
  await advance(app, clock, 1000);
  const ownFut = own.positions[0].positionId;
  const rb = app.hedge.openForStrategy(b.id).id;
  // Without a stated capacity the allocation is rejected; so is an allocation of the future that is linked without units.
  app.hedge.setScript({ responses: [{ packages: [], protection: { allocations: [{ hedgePositionId: ownFut, units: 600 }, { hedgePositionId: linkedFut.positionId, units: 100, capacity: 500 }] } }] });
  let v = await app.hedge.refresh(rb);
  assert.match(v.protection.results[0].reason, /has no unit measure in the Terminal, and the allocation does not state the hedge capacity/);
  assert.match(v.protection.results[1].reason, /explicitly linked to Long 300 ALFA without a unit measure/);
  // With a stated capacity of 1,000 units, 600 are allocated; a further 500 for A would make 1,100 > 1,000.
  app.hedge.setScript({ responses: [{ packages: [], protection: { allocations: [{ hedgePositionId: ownFut, units: 600, capacity: 1000 }] } }] });
  v = await app.hedge.refresh(rb);
  assert.equal(v.protection.results[0].status, 'active');
  const B = rowOf(app, book, acct, stock(inst.BRVO, b.id));
  assert.equal(B.protection.protectedUnits, 600);
  assert.equal(B.protection.remainingUnits, 400, '1,000 shares less 600 units allocated');
  app.hedge.setScript({ responses: [] });
  const ra = await app.hedge.request({ bookId: book.id, unitId: acct.id, strategyId: a.id, trigger: 'review' });
  app.hedge.setScript({ responses: [{ packages: [], protection: { allocations: [{ hedgePositionId: ownFut, units: 500, capacity: 1000 }] } }] });
  v = await app.hedge.refresh(ra.id);
  assert.match(v.protection.results[0].reason, /would allocate 500 units .* only 400 of its 1,000 units of capacity are left/);
  assert.deepEqual(ledgerImbalance(app), []);
});
