// Browser level of the system suite: `npm run test:system:browser [-- --area=stress --case=double-click-transfer --headed --slow=150]`.
//
// Each case gets its own disposable server process and database and its own page of one Chromium.
// What the case is about (the refused action, the double click, the lost connection, the switch of
// Book) is done in the interface, by label; the Book and its activity are prepared through the API.
// Results go to test/matrix/results/system-browser.json; the screen of a case that stops is saved.

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { launchBrowser } from '../matrix/drivers/browser.mjs';
import * as cases from './lib/browser-cases.mjs';
import { caseId, loadCases, parseArgs, runCase, summaryLine, systemResultsFile, writeSystemResults } from './lib/kit.mjs';

const args = parseArgs();
const all = (await loadCases()).filter((k) => typeof k.levels.browser === 'function');
const chosen = (await loadCases(args)).filter((k) => typeof k.levels.browser === 'function');
if (!chosen.length) { console.error('No case matches.'); process.exit(2); }
const shotsDir = resolve(process.env.SDT_MATRIX_SHOTS || resolve(process.env.SDT_MATRIX_TMP || tmpdir(), 'sdt-system-shots'));
console.log(`System suite, browser level: ${chosen.length} case${chosen.length === 1 ? '' : 's'}, one disposable server and one page each. Screens of stopped cases: ${shotsDir}`);
const known = new Set(all.map((k) => caseId('browser', k.area, k.id)));
const browser = await launchBrowser(args);
const environment = { node: process.version, platform: process.platform, browser: `Chromium ${browser.version()}`, viewport: '1440x900', server: 'server/index.js --demo unless the case states normal mode' };
let failed = 0;
const started = Date.now();
try {
  for (const k of chosen) {
    const r = await runCase('browser', k, { browser, cases, shotsDir });
    console.log(summaryLine(r));
    if (r.status === 'failed') { failed++; console.log(`  Expected: ${k.expectedBrowser || k.expected}\n${r.message.split('\n').map((l) => `    ${l}`).join('\n')}`); }
    writeSystemResults('browser', [r], { known, environment });
  }
} finally {
  await browser.close().catch(() => {});
}
console.log(`${chosen.length} case${chosen.length === 1 ? '' : 's'} in ${((Date.now() - started) / 1000).toFixed(1)}s. ${failed ? `${failed} failed.` : 'No failures.'} Results: ${systemResultsFile('browser')}`);
process.exit(failed ? 1 : 0);
