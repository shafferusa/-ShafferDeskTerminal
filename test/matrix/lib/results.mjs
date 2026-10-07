// Results files: test/matrix/results/<level>.json. They are the evidence the matrix cites.
//
//   { level, results: { "<test id>": { status, message, ms, commit, at, product, family, step, covers } }, runs: { "<product>": { at, ms, commit, ... } } }
//
// status is passed | failed | blocked | unsupported. A test that did not run has no entry: the
// matrix shows it as "not run". When a product is run again, all of its earlier entries at that
// level are removed first, so a step that no longer runs cannot keep an old "passed".

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS, specKey } from './runner.mjs';
import { REPO_ROOT } from './sandbox.mjs';

// SDT_MATRIX_RESULTS points a run at another results directory (for example while several people are working
// on different families at once). The matrix document is generated from the directory in the repository.
export const RESULTS_DIR = process.env.SDT_MATRIX_RESULTS ? resolve(process.env.SDT_MATRIX_RESULTS) : resolve(fileURLToPath(new URL('../results', import.meta.url)));
export const resultsFile = (level) => resolve(RESULTS_DIR, `${level}.json`);

/** The commit the tree is at, with "+changes" when files differ from it. */
export function commitStamp() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'server', 'web', 'test/matrix/specs', 'test/matrix/lib', 'test/matrix/drivers'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    return dirty ? `${head}+changes` : head;
  } catch { return 'unknown'; }
}

export function readResults(level) {
  const file = resultsFile(level);
  if (!existsSync(file)) return { level, results: {}, runs: {} };
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { level, results: {}, runs: {} }; }
}

/**
 * Record the outcome of scenarios at one level. `scenarios` is [{ spec, results, ms }].
 * Entries of the products that ran are replaced; other products keep theirs.
 */
export function writeResults(level, scenarios, { environment = {} } = {}) {
  const file = resultsFile(level);
  const data = readResults(level);
  const commit = commitStamp();
  const at = new Date().toISOString();
  for (const { spec, results, ms } of scenarios) {
    const prefix = `${LEVELS[level]}:${specKey(spec)}:`;
    for (const id of Object.keys(data.results)) if (id.startsWith(prefix)) delete data.results[id];
    for (const r of results) data.results[r.id] = { status: r.status, message: r.message, ms: r.ms, commit, at, product: r.product, template: r.template, family: r.family, step: r.step, covers: r.covers };
    const count = (s) => results.filter((r) => r.status === s).length;
    data.runs[specKey(spec)] = { at, commit, ms, family: spec.family, steps: spec.steps.length + 2, ran: results.length, passed: count('passed'), failed: count('failed'), blocked: count('blocked'), unsupported: count('unsupported'), environment };
  }
  data.level = level;
  data.updatedAt = at;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  renameSync(tmp, file);
  return data;
}

/** One line per scenario for a terminal. */
export function summaryLine(spec, results, ms) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const total = spec.steps.length + 2;
  const notRun = total - results.length;
  return `${String(specKey(spec)).padEnd(24)} passed ${String(n('passed')).padStart(2)}  failed ${n('failed')}  blocked ${n('blocked')}  unsupported ${n('unsupported')}  not run ${notRun}  ${(ms / 1000).toFixed(1)}s`;
}
