// Browser level of the product test matrix:
//   npm run test:browser [-- --family=equity --product=adr --workers=1 --headed --slow=150]
//
// Each scenario gets its own disposable server process and database and its own browser page, and is
// driven through the interface (drivers/browser.mjs). One browser per worker; one worker by default.
// Results go to test/matrix/results/browser.json.

import { browserDriver, defaultShotsDir, launchBrowser } from './drivers/browser.mjs';
import { parseArgs, pool } from './lib/cli.mjs';
import { summaryLine, writeResults } from './lib/results.mjs';
import { runScenario } from './lib/runner.mjs';
import { loadSpecs } from './lib/specs.mjs';

const args = parseArgs();
const specs = await loadSpecs(args);
if (!specs.length) { console.error('No spec matches.'); process.exit(2); }
const workers = Math.min(args.workers, specs.length);
console.log(`Browser level: ${specs.length} scenario${specs.length === 1 ? '' : 's'}, ${workers} worker${workers === 1 ? '' : 's'}. Screens of failed steps: ${defaultShotsDir()}`);
const browsers = [];
let failed = 0;
const startedAll = Date.now();
try {
  for (let i = 0; i < workers; i++) browsers.push(await launchBrowser(args));
  const idle = [...browsers];
  await pool(specs, workers, async (spec) => {
    const browser = idle.pop();
    const driver = browserDriver(browser, { shotsDir: defaultShotsDir() });
    try {
      const { results, ms } = await runScenario(spec, driver, {
        log: (r) => { if (process.env.SDT_MATRIX_VERBOSE) console.log(`  ${r.status.padEnd(11)} ${r.id} ${r.ms}ms`); },
      });
      console.log(summaryLine(spec, results, ms));
      for (const r of results.filter((x) => x.status === 'failed')) { failed++; console.log(`  FAILED ${r.id}\n${r.message.split('\n').map((l) => `    ${l}`).join('\n')}`); }
      writeResults('browser', [{ spec, results, ms }], { environment: { node: process.version, platform: process.platform, browser: `Chromium ${browser.version()}`, viewport: '1440x900', server: 'server/index.js --demo, engine timer off' } });
    } finally { idle.push(browser); }
  });
} finally {
  for (const b of browsers) await b.close().catch(() => {});
}
console.log(`${specs.length} scenario${specs.length === 1 ? '' : 's'} in ${((Date.now() - startedAll) / 1000).toFixed(1)}s. ${failed ? `${failed} step${failed === 1 ? '' : 's'} failed.` : 'No failures.'} Results: test/matrix/results/browser.json`);
process.exit(failed ? 1 : 0);
