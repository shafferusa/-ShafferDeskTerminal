// Engine level of the product test matrix: every spec in test/matrix/specs, run in-process against
// the real engine and ledger on a disposable database. One node:test per product scenario.
// Results are written to test/matrix/results/engine.json for the matrix (npm run matrix).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openEngineTerminal } from './drivers/engine.mjs';
import { clientDriver } from './lib/actions.mjs';
import { writeResults } from './lib/results.mjs';
import { runScenario } from './lib/runner.mjs';
import { loadSpecs } from './lib/specs.mjs';

const specs = await loadSpecs({ family: process.env.SDT_MATRIX_FAMILY, product: process.env.SDT_MATRIX_PRODUCT });
const done = [];

for (const spec of specs) {
  test(`matrix E: ${spec.productId || `template ${spec.template}`} (${spec.title})`, async () => {
    const { results, ms } = await runScenario(spec, clientDriver('engine', openEngineTerminal));
    done.push({ spec, results, ms });
    const failed = results.filter((r) => r.status === 'failed');
    assert.equal(failed.length, 0, failed.map((r) => `${r.id}\n${r.message}`).join('\n\n'));
    assert.equal(results.length, spec.steps.length + 2, 'every step ran, with setup and the restart check');
  });
}

after(() => {
  if (done.length) writeResults('engine', done, { environment: { node: process.version, platform: process.platform } });
});
