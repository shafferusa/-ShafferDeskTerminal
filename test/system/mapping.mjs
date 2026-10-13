// Prints the level mapping of the system suite into test/system/README.md, between the markers
// <!-- system-mapping:start --> and <!-- system-mapping:end -->, with the statuses of the last recorded results
// (test/matrix/results/system-{engine,api,browser}.json, or SDT_MATRIX_RESULTS).
//
//   node --disable-warning=ExperimentalWarning test/system/mapping.mjs          write the table, print the counts
//   node --disable-warning=ExperimentalWarning test/system/mapping.mjs --check  only check the mapping (exit 1 if incomplete)
//
// The same table is the "System behaviour" section of docs/TEST-MATRIX.md (scripts/test-matrix.js).

import { readFileSync, writeFileSync } from 'node:fs';
import { AREAS, loadCases, readSystemResults } from './lib/kit.mjs';
import { mappingCounts, mappingMarkdown, MAP_LEVELS } from './lib/mapping.mjs';

const cases = await loadCases(); // throws when the mapping is incomplete
const results = Object.fromEntries(MAP_LEVELS.map((l) => [l, readSystemResults(l)]));
const n = mappingCounts(cases, results);
for (const l of MAP_LEVELS) console.log(`${l.padEnd(8)} ${n[l].run} run + ${n[l].reasons} not applicable = ${n[l].cases}; passed ${n[l].passed}, failed ${n[l].failed}, not run ${n[l].notRun}`);
if (process.argv.includes('--check')) process.exit(0);

const file = new URL('./README.md', import.meta.url);
const START = '<!-- system-mapping:start -->';
const END = '<!-- system-mapping:end -->';
const text = readFileSync(file, 'utf8');
const a = text.indexOf(START), b = text.indexOf(END);
if (a < 0 || b < a) throw new Error(`test/system/README.md has no ${START} ... ${END} block.`);
const block = `${START}\n<!-- Written by test/system/mapping.mjs from the cases and the results files; do not edit by hand. -->\n\n${mappingMarkdown(cases, results, { heading: '###', areas: AREAS })}${END}`;
writeFileSync(file, text.slice(0, a) + block + text.slice(b + END.length));
console.log('test/system/README.md: mapping table written.');
