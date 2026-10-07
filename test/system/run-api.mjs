// API level of the system suite: `npm run test:system:api [-- --area=refusals --case=cash-trade]`.
//
// Each case gets its own disposable server process and database (the product matrix's
// lib/server.mjs) and is driven through the real HTTP routes. The cases that need it start the
// server with the engine timer running, kill it without warning, and start it again on the same
// database. Results go to test/matrix/results/system-api.json.

import { caseId, loadCases, parseArgs, runCase, summaryLine, systemResultsFile, writeSystemResults } from './lib/kit.mjs';

const args = parseArgs();
const all = (await loadCases()).filter((k) => typeof k.levels.api === 'function');
const chosen = (await loadCases(args)).filter((k) => typeof k.levels.api === 'function');
if (!chosen.length) { console.error('No case matches.'); process.exit(2); }
console.log(`System suite, API level: ${chosen.length} case${chosen.length === 1 ? '' : 's'}, one disposable server each (more where a case says so).`);
const known = new Set(all.map((k) => caseId('api', k.area, k.id)));
const environment = { node: process.version, platform: process.platform, server: 'server/index.js --demo unless the case states normal mode; engine timer off unless the case turns it on' };
let failed = 0;
const started = Date.now();
for (const k of chosen) {
  const r = await runCase('api', k);
  console.log(summaryLine(r));
  if (r.status === 'failed') { failed++; console.log(`  Expected: ${k.expected}\n${r.message.split('\n').map((l) => `    ${l}`).join('\n')}`); }
  writeSystemResults('api', [r], { known, environment });
}
console.log(`${chosen.length} case${chosen.length === 1 ? '' : 's'} in ${((Date.now() - started) / 1000).toFixed(1)}s. ${failed ? `${failed} failed.` : 'No failures.'} Results: ${systemResultsFile('api')}`);
process.exit(failed ? 1 : 0);
