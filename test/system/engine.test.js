// Engine level of the system suite (failure, recovery and isolation): every case in test/system/cases
// that applies at engine level, run in-process against the real engine, ledger and route handlers on
// a disposable database. Part of `npm test`. One node:test per case.
//
//   SDT_SYSTEM_AREA=refusals,stress   SDT_SYSTEM_CASE=cash-trade   run a subset
//
// Results are written to test/matrix/results/system-engine.json (see test/system/README.md).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { caseId, loadCases, runCase, writeSystemResults } from './lib/kit.mjs';

const all = await loadCases();
const chosen = await loadCases({ area: process.env.SDT_SYSTEM_AREA, id: process.env.SDT_SYSTEM_CASE });
const done = [];

for (const k of chosen.filter((x) => typeof x.levels.engine === 'function')) {
  test(`system ${caseId('engine', k.area, k.id)}: ${k.title}`, async () => {
    const r = await runCase('engine', k);
    done.push(r);
    assert.equal(r.status, 'passed', `${r.id}\nExpected: ${k.expected}\n${r.message}`);
  });
}

after(() => {
  const known = new Set(all.filter((x) => typeof x.levels.engine === 'function').map((x) => caseId('engine', x.area, x.id)));
  if (done.length) writeSystemResults('engine', done, { known, environment: { node: process.version, platform: process.platform, engine: 'in-process, frozen clock, explicit cycles' } });
});
