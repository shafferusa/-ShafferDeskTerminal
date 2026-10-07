// API level of the product test matrix: `npm run test:api [-- --family=equity --product=adr]`.
//
// Each scenario gets its own disposable server process and database (lib/server.mjs) and is driven
// through the real HTTP routes. Results go to test/matrix/results/api.json.

import { openApiTerminal } from './drivers/api.mjs';
import { clientDriver } from './lib/actions.mjs';
import { parseArgs } from './lib/cli.mjs';
import { summaryLine, writeResults } from './lib/results.mjs';
import { runScenario } from './lib/runner.mjs';
import { loadSpecs } from './lib/specs.mjs';

const args = parseArgs();
const specs = await loadSpecs(args);
if (!specs.length) { console.error('No spec matches.'); process.exit(2); }
console.log(`API level: ${specs.length} scenario${specs.length === 1 ? '' : 's'}, one disposable server each.`);
const done = [];
let failed = 0;
for (const spec of specs) {
  const { results, ms } = await runScenario(spec, clientDriver('api', openApiTerminal));
  done.push({ spec, results, ms });
  console.log(summaryLine(spec, results, ms));
  for (const r of results.filter((x) => x.status === 'failed')) { failed++; console.log(`  FAILED ${r.id}\n${r.message.split('\n').map((l) => `    ${l}`).join('\n')}`); }
  writeResults('api', [{ spec, results, ms }], { environment: { node: process.version, platform: process.platform, server: 'server/index.js --demo, engine timer off' } });
}
const total = done.reduce((a, d) => a + d.ms, 0);
console.log(`${done.length} scenario${done.length === 1 ? '' : 's'} in ${(total / 1000).toFixed(1)}s. ${failed ? `${failed} step${failed === 1 ? '' : 's'} failed.` : 'No failures.'} Results: test/matrix/results/api.json`);
process.exit(failed ? 1 : 0);
