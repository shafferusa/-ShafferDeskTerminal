// Tests of the test matrix harness itself: that it cannot open a database it did not create, that
// fixtures are demo-only and labelled, that the integrity check and the comparison really fail when
// something is wrong, and that a failing step stops its scenario without marking the rest as run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { httpClient } from './drivers/api.mjs';
import { openEngineTerminal } from './drivers/engine.mjs';
import { clientDriver, setupThroughClient, actThroughClient } from './lib/actions.mjs';
import { diff, mergeExpect, Shown } from './lib/compare.mjs';
import { addBusinessDays, commission, money, newYorkDate } from './lib/calc.mjs';
import { runScenario } from './lib/runner.mjs';
import { assertSandbox, createSandbox, destroySandbox, REPO_ROOT } from './lib/sandbox.mjs';
import { startServer } from './lib/server.mjs';
import { loadSpecs, validateSpec } from './lib/specs.mjs';

const START = '2026-03-02T15:00:00.000Z';
const specs = await loadSpecs({ product: 'common_stock' });
const common = specs[0];

test('harness: a sandbox is a fresh marked directory, and nothing else can be opened', async () => {
  const sb = createSandbox('guard');
  try {
    assert.ok(existsSync(sb.dir));
    assert.equal(assertSandbox(sb), sb);
    // The repository's own data directory, by path.
    const repoData = { dir: resolve(REPO_ROOT, 'data'), dbFile: resolve(REPO_ROOT, 'data', 'terminal.db') };
    assert.throws(() => assertSandbox(repoData), /did not create/);
    await assert.rejects(() => openEngineTerminal({ sandbox: repoData, at: START }), /did not create/);
    await assert.rejects(() => startServer(repoData), /did not create/);
    assert.equal(existsSync(resolve(REPO_ROOT, 'data', 'matrix.db')), false);
    // A directory somebody else made, even with a marker file copied into it.
    const foreign = mkdtempSync(join(tmpdir(), 'sdt-matrix-foreign-'));
    try {
      writeFileSync(join(foreign, '.sdt-matrix-sandbox'), JSON.stringify({ nonce: 'guess', pid: process.pid }));
      assert.throws(() => assertSandbox({ dir: foreign, dbFile: join(foreign, 'matrix.db') }), /not created by this run/);
    } finally { rmSync(foreign, { recursive: true, force: true }); }
    // A database path that points outside its own sandbox.
    assert.throws(() => assertSandbox({ ...sb, dbFile: resolve(REPO_ROOT, 'data', 'terminal.db') }), /did not create/);
    assert.throws(() => assertSandbox(null), /no sandbox/);
  } finally { destroySandbox(sb); }
  assert.equal(existsSync(sb.dir), false, 'destroying a sandbox removes it');
  assert.throws(() => assertSandbox(sb), /not created by this run/);
});

test('harness: the sandbox base cannot be inside the repository', () => {
  const before = process.env.SDT_MATRIX_TMP;
  process.env.SDT_MATRIX_TMP = resolve(REPO_ROOT, 'data', 'matrix-tmp');
  try {
    assert.throws(() => createSandbox('inside'), /inside the repository/);
    assert.equal(existsSync(resolve(REPO_ROOT, 'data', 'matrix-tmp')), false, 'nothing was created there');
  } finally { if (before === undefined) delete process.env.SDT_MATRIX_TMP; else process.env.SDT_MATRIX_TMP = before; }
});

test('harness: fixtures are labelled "Test fixture", survive a restart, and exist only in demo mode', async () => {
  const sb = createSandbox('fixtures');
  const t = await openEngineTerminal({ sandbox: sb, at: START });
  try {
    const inst = await t.createInstrument({ productId: 'common_stock', name: 'Fixture Test Co.', symbol: 'FXTC', marketView: 'US_CASH', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
    const set = await t.fixture('quote', { instrumentId: inst.id, bid: 10, ask: 10.02, last: 10.01, bidSize: 100, askSize: 200 });
    assert.equal(set.observation.source, 'Test fixture');
    assert.equal(set.observation.status, 'simulated');
    assert.deepEqual([set.observation.bid, set.observation.ask, set.observation.value, set.observation.askSize], [10, 10.02, 10.01, 200]);
    assert.match(set.observation.assumptions[0], /Not a market quote/);
    await t.fixture('fx', { pair: 'USD/JPY', rate: 150 });
    await t.fixture('borrow', { instrumentId: inst.id, available: true, quantity: 500, feeRate: 0.02 });
    await assert.rejects(() => t.fixture('quote', { instrumentId: inst.id, bid: 11, ask: 10 }), /Bid cannot be above ask/);
    await assert.rejects(() => t.fixture('weather', {}), /Unknown fixture kind/);
    await t.restart();
    const after = (await t.fixtures()).fixtures;
    assert.equal(after.quotes[inst.id].ask, 10.02, 'the quote fixture is still in force after a restart');
    assert.equal(after.fx['USD/JPY'], 150);
    assert.equal(after.borrow[inst.id].feeRate, 0.02);
  } finally { await t.close(); destroySandbox(sb); }

  // The normal (non-demo) Terminal refuses every fixture call, in-process and over HTTP.
  const sb2 = createSandbox('fixtures-normal');
  const normal = await openEngineTerminal({ sandbox: sb2, at: START, demo: false });
  try {
    await assert.rejects(() => normal.fixture('fx', { pair: 'USD/JPY', rate: 150 }), (err) => err.status === 403);
  } finally { await normal.close(); destroySandbox(sb2); }
  const sb3 = createSandbox('fixtures-http');
  const server = await startServer(sb3, { demo: false });
  try {
    const call = httpClient(server.url);
    await assert.rejects(() => call('POST', '/api/demo/fixtures/quote', { instrumentId: 'x', last: 1 }), (err) => err.status === 403);
    await assert.rejects(() => call('GET', '/api/demo/fixtures'), (err) => err.status === 403);
    await assert.rejects(() => call('POST', '/api/demo/advance', { to: START }), (err) => err.status === 403);
    assert.equal((await call('GET', '/api/status')).demo, false);
  } finally { await server.stop(); destroySandbox(sb3); }
});

test('harness: the integrity check fails when stored rows are tampered with', async () => {
  const sb = createSandbox('integrity');
  const t = await openEngineTerminal({ sandbox: sb, at: START });
  try {
    const ctx = await setupThroughClient(t, common);
    await actThroughClient(t, ctx, common.steps[0]); // buy 200
    await t.tick();
    const clean = await t.integrity(ctx.bookId);
    assert.equal(clean.ok, true, clean.problems.join('\n'));
    assert.equal(clean.checks.length, 13);
    assert.deepEqual([clean.counts.fills, clean.counts.settlements, clean.counts.positions], [1, 1, 1]);

    // A second connection to the same sandbox database plays the part of a bug that writes bad rows.
    const raw = new DatabaseSync(assertSandbox(sb).dbFile);
    const failing = async () => (await t.integrity(ctx.bookId)).checks.filter((c) => !c.ok).map((c) => c.id);
    try {
      raw.exec(`INSERT INTO fills (id, order_id, ts, business_date, qty, price, gross, ccy, fees, fill_model, settle_date, event_id) SELECT 'F-DUPLICATE', order_id, ts, business_date, qty, price, gross, ccy, fees, fill_model, settle_date, event_id FROM fills LIMIT 1`);
      assert.deepEqual(await failing(), ['no-duplicate-fills']);
      raw.exec(`DELETE FROM fills WHERE id = 'F-DUPLICATE'`);
      assert.deepEqual(await failing(), []);

      raw.exec(`UPDATE entries SET amount = amount + 1 WHERE id = (SELECT id FROM entries WHERE account = 'pos' LIMIT 1)`);
      const broken = await failing();
      for (const id of ['events-balanced', 'trial-balance', 'positions-ledger']) assert.ok(broken.includes(id), `${id} should fail: ${broken}`);
      raw.exec(`UPDATE entries SET amount = amount - 1 WHERE id = (SELECT id FROM entries WHERE account = 'pos' LIMIT 1)`);
      assert.deepEqual(await failing(), []);

      raw.exec(`INSERT INTO settlements (id, book_id, unit_id, fill_id, order_id, instrument_id, strategy_id, position_id, kind, due_date, ccy, amount, accounts, status, created_at) SELECT 'STL-DUPLICATE', book_id, unit_id, fill_id, order_id, instrument_id, strategy_id, position_id, kind, due_date, ccy, amount, accounts, status, created_at FROM settlements LIMIT 1`);
      const dup = await failing();
      assert.ok(dup.includes('no-duplicate-settlements') && dup.includes('settlements-ledger'), String(dup));
      raw.exec(`DELETE FROM settlements WHERE id = 'STL-DUPLICATE'`);

      raw.exec(`UPDATE positions SET qty = qty + 5 WHERE book_id = '${ctx.bookId}'`);
      const qty = await failing();
      assert.ok(qty.includes('positions-ledger'), String(qty));
      raw.exec(`UPDATE positions SET qty = qty - 5 WHERE book_id = '${ctx.bookId}'`);
      assert.deepEqual(await failing(), []);
    } finally { raw.close(); }
  } finally { await t.close(); destroySandbox(sb); }
});

test('harness: a wrong expectation fails its step, and later steps are left without a result', async () => {
  const wrong = structuredClone({ ...common, steps: common.steps.map((s) => ({ ...s })) });
  // structuredClone drops nothing here: the common stock spec has no regular expressions.
  wrong.steps[1].expect.cash.account.USD.settled += 0.01; // one cent off after the first settlement
  const { results } = await runScenario(wrong, clientDriver('engine', openEngineTerminal));
  assert.deepEqual(results.map((r) => [r.step, r.status]), [['setup', 'passed'], ['open', 'passed'], ['settle-open', 'failed']]);
  assert.match(results[2].message, /cash\.account\.USD\.settled: expected 489995\.01, got 489995/);
  assert.equal(results[2].id, 'E:common_stock:settle-open');

  // An action declared unsupported that the Terminal performs anyway is a failure, not a pass.
  const lax = structuredClone({ ...common, steps: common.steps.slice(0, 1).map((s) => ({ ...s, status: 'unsupported', reason: 'pretend', expect: { refused: 'never' } })) });
  const r2 = (await runScenario(lax, clientDriver('engine', openEngineTerminal))).results;
  assert.equal(r2[1].status, 'failed');
  assert.match(r2[1].message, /did not refuse it/);
});

test('harness: an execution-template scenario runs through the same runner, with E:T:<template>:<step> ids', async () => {
  // The "long" template buying the common stock scenario's 200 shares is the same trade as that scenario's first
  // step, so its hand-worked expectations apply unchanged. This proves the template path of the harness; it is
  // not recorded as a result (the matrix lists every template as not yet specified until a spec file exists).
  const open = common.steps[0];
  const tpl = validateSpec({
    ...structuredClone({ ...common, productId: undefined }), template: 'long', family: 'templates', title: 'Long template on common stock',
    steps: [{ id: 'open', covers: 'open', action: 'package', as: 'lot', instrument: 'main', input: { template: 'long', underlyingId: '$inst:main', quantity: 200, origin: 'strategy' }, expect: structuredClone(open.expect) }],
  }, 'harness.test.js');
  const { results } = await runScenario(tpl, clientDriver('engine', openEngineTerminal));
  assert.deepEqual(results.map((r) => [r.id, r.status, r.message]), [['E:T:long:setup', 'passed', ''], ['E:T:long:open', 'passed', ''], ['E:T:long:restart', 'passed', '']]);
  assert.equal(results[1].template, 'long');
  assert.equal(results[1].product, null);
});

test('harness: comparison rules', () => {
  assert.deepEqual(diff({ a: 1.005 }, { a: 1.005, b: 2 }), []);
  assert.equal(diff({ a: 1.01 }, { a: 1.02 }).length, 1);
  assert.deepEqual(diff({ a: null }, {}), [], 'null expects a missing value');
  assert.equal(diff({ a: null }, { a: 0 }).length, 1, 'zero is not missing');
  assert.equal(diff({ list: [] }, { list: [{}] }).length, 1, 'lists are compared whole');
  assert.deepEqual(diff({ s: /^Bought 200/ }, { s: 'Bought 200 NFTW' }), []);
  // A screen shows 50.357 for an average cost of 50.356667: equal to the decimals shown, and no further.
  assert.deepEqual(diff({ p: 50.356667 }, { p: new Shown(50.357, 3, '50.357') }), []);
  assert.equal(diff({ p: 50.358 }, { p: new Shown(50.357, 3, '50.357') }).length, 1, 'one unit in the last shown decimal is a difference');
  assert.equal(diff({ p: 50.36 }, { p: 50.357 }).length, 1, 'a value read from the API is compared exactly');
  assert.equal(diff({ p: 12 }, { p: new Shown(null, 0, '—') }).length, 1, 'a dash on screen is not a number');
  assert.deepEqual(diff({ p: null }, { p: new Shown(null, 0, '—') }), []);
  assert.deepEqual(mergeExpect({ cash: { a: 1, b: 2 }, list: [1, 2] }, { cash: { b: 3 }, list: [9] }), { cash: { a: 1, b: 3 }, list: [9] });
});

test('harness: independent calculators against hand-worked examples', () => {
  assert.equal(money(390.625), 390.63); // half a cent rounds away from zero
  assert.equal(money(-18785.625), -18785.63);
  assert.equal(money(2875.392, 'JPY'), 2875);
  assert.equal(commission({ perUnit: 0.005, minimum: 1, bps: 0 }, 120, 6288), 1); // 0.60 raised to the minimum
  assert.equal(commission({ perUnit: 0, minimum: 0, bps: 5 }, 400, 9936), 4.97); // 4.968
  assert.equal(commission({ perUnit: 0, minimum: 5, bps: 10 }, 300, 3870), 5);
  assert.equal(newYorkDate('2026-03-03T22:30:00.000Z'), '2026-03-03'); // 17:30 in New York
  assert.equal(newYorkDate('2026-03-04T03:30:00.000Z'), '2026-03-03'); // 22:30 in New York, still the 3rd
  assert.equal(addBusinessDays('2026-03-06', 1), '2026-03-09'); // Friday to Monday
  assert.equal(addBusinessDays('2026-04-02', 2, ['2026-04-03', '2026-04-06']), '2026-04-08'); // over Good Friday and Easter Monday
  assert.equal(addBusinessDays('2026-03-18', 2, ['2026-03-20']), '2026-03-23'); // over the Tokyo equinox holiday
});
