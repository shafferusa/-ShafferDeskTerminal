// System suite kit: what a case is, how one is run at a level, and where its result is recorded.
//
// A case is data plus one function per level it applies to:
//
//   { id, title, proves, expected, world?, levels: { engine, api, browser } }
//
// `expected` is the safe behaviour, written before the case was first run. `levels.<level>` is either the
// function that runs the case at that level or a sentence saying why the case does not apply there.
// The function receives (w, c): `w` is a World (lib/world.mjs: a disposable Terminal and helpers), `c`
// collects checks. A case passes when every check held, no request ended in a server error (5xx) and
// the function did not throw. Nothing in a case adjusts its expectation to what the Terminal did.
//
// Test ids are SE:<area>:<case>, SA:<area>:<case>, SB:<area>:<case>. Results go to
// test/matrix/results/system-{engine,api,browser}.json (SDT_MATRIX_RESULTS moves the directory).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { commitStamp, RESULTS_DIR } from '../../matrix/lib/results.mjs';
import { openWorld } from './world.mjs';

export const LEVEL_LETTER = { engine: 'SE', api: 'SA', browser: 'SB' };
export const LEVELS = ['engine', 'api', 'browser'];
export const AREAS = {
  refusals: 'Refusals and blocks',
  stress: 'Execution under stress',
  nodup: 'No duplicates, ever',
  history: 'History survives',
  isolation: 'Isolation',
  hedge: 'Hedge reconnection',
};
export const caseId = (level, area, id) => `${LEVEL_LETTER[level]}:${area}:${id}`;
const CASES_DIR = resolve(fileURLToPath(new URL('../cases', import.meta.url)));

/** Every case of every area file, in file order. `filter`: { area: 'a,b', case: 'x,y' }. */
export async function loadCases({ area, id } = {}) {
  const wantArea = area ? new Set(String(area).split(',')) : null;
  const wantCase = id ? new Set(String(id).split(',')) : null;
  const out = [];
  for (const file of readdirSync(CASES_DIR).filter((f) => f.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(resolve(CASES_DIR, file)).href);
    if (!AREAS[mod.area]) throw new Error(`${file}: unknown area "${mod.area}".`);
    const seen = new Set();
    for (const k of mod.default) {
      for (const f of ['id', 'title', 'proves', 'expected', 'levels']) if (!k[f]) throw new Error(`${file}: a case is missing "${f}" (${k.id || k.title || '?'}).`);
      if (!/^[a-z0-9-]+$/.test(k.id)) throw new Error(`${file}: case id "${k.id}" must be lower-case letters, digits and dashes.`);
      if (seen.has(k.id)) throw new Error(`${file}: case id "${k.id}" is used twice.`);
      seen.add(k.id);
      for (const l of LEVELS) if (typeof k.levels[l] !== 'function' && typeof k.levels[l] !== 'string') throw new Error(`${file}: case "${k.id}" must give a function or a reason for the ${l} level.`);
      if (wantArea && !wantArea.has(mod.area)) continue;
      if (wantCase && !wantCase.has(k.id)) continue;
      out.push({ ...k, area: mod.area, file });
    }
  }
  return out;
}

const show = (x) => { try { return typeof x === 'string' ? JSON.stringify(x) : JSON.stringify(x); } catch { return String(x); } };
const clip = (s, n = 600) => (String(s).length > n ? `${String(s).slice(0, n)}...` : String(s));

/** Collects the checks of one case. Nothing throws: every failed check is reported. */
export function createChecks() {
  const problems = [];
  const notes = [];
  let count = 0;
  const c = {
    problems, notes,
    get count() { return count; },
    ok(cond, label, detail) { count++; if (!cond) problems.push(detail ? `${label}: ${clip(detail)}` : label); return Boolean(cond); },
    eq(actual, expected, label) { count++; const ok = isDeepStrictEqual(actual, expected); if (!ok) problems.push(`${label}: expected ${clip(show(expected), 400)}, got ${clip(show(actual), 400)}`); return ok; },
    near(actual, expected, label, tol = 0.005) { count++; const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol; if (!ok) problems.push(`${label}: expected ${expected}, got ${show(actual)}`); return ok; },
    match(text, pattern, label) { count++; const ok = pattern instanceof RegExp ? pattern.test(String(text ?? '')) : String(text ?? '').includes(pattern); if (!ok) problems.push(`${label}: ${show(clip(text, 300))} does not match ${pattern}`); return ok; },
    /** A response from w.req() must be a refusal: not ok, a 4xx status (or the one stated), the stated code and wording. */
    refused(res, { status, code, text } = {}, label = 'refusal') {
      count++;
      if (!res || res.ok) { problems.push(`${label}: the Terminal did not refuse (it answered ${clip(show(res?.body), 200)})`); return false; }
      let ok = true;
      if (status ? res.status !== status : !(res.status >= 400 && res.status < 500)) { problems.push(`${label}: refused with status ${res.status}${status ? `, expected ${status}` : ', expected a 4xx'} (${res.error})`); ok = false; }
      if (code && res.code !== code) { problems.push(`${label}: refused with code ${res.code}, expected ${code} (${res.error})`); ok = false; }
      if (text && !(text instanceof RegExp ? text.test(res.error || '') : String(res.error || '').includes(text))) { problems.push(`${label}: refusal says ${show(res.error)}, expected it to match ${text}`); ok = false; }
      if (ok) notes.push(`${label}: "${clip(res.error, 220)}"`);
      return ok;
    },
    note(text) { notes.push(clip(text, 400)); },
    fail(label) { count++; problems.push(label); },
  };
  return c;
}

/**
 * Run one case at one level. Returns { id, area, case, title, status: passed | failed, message, ms, checks }.
 * `extra` is level specific: the browser level passes { browser } (one Chromium for the whole run).
 */
export async function runCase(level, kase, extra = {}) {
  const id = caseId(level, kase.area, kase.id);
  const fn = kase.levels[level];
  if (typeof fn !== 'function') throw new Error(`${id}: this case does not run at the ${level} level (${fn}).`);
  const started = Date.now();
  const c = createChecks();
  let w = null;
  try {
    w = await openWorld(level, { label: `${kase.area}-${kase.id}`, ...(kase.world || {}), ...extra });
    await fn(w, c);
    for (const e of w.serverErrors) c.fail(`server error: ${e}`);
    if (!c.count) c.fail('The case made no check.');
  } catch (err) {
    c.fail(`The case did not complete: ${err.stack || err.message || err}`);
  } finally {
    try { await w?.close(); } catch (err) { c.problems.push(`closing the world: ${err.message}`); }
  }
  const failed = c.problems.length > 0;
  return {
    id, area: kase.area, case: kase.id, title: kase.title, status: failed ? 'failed' : 'passed',
    message: failed ? c.problems.join('\n') : c.notes.join('\n'), ms: Date.now() - started, checks: c.count,
  };
}

// ---- results ------------------------------------------------------------------------------------------
export const systemResultsFile = (level) => resolve(RESULTS_DIR, `system-${level}.json`);
export function readSystemResults(level, dir = RESULTS_DIR) {
  const file = resolve(dir, `system-${level}.json`);
  if (!existsSync(file)) return { level, results: {} };
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { level, results: {} }; }
}
/**
 * Record results of one level. Entries of the cases that ran are replaced; entries of cases that no longer exist
 * at that level (`known`: every current id of the level) are removed; the rest are kept.
 */
export function writeSystemResults(level, results, { known = null, environment = {} } = {}) {
  const file = systemResultsFile(level);
  const data = readSystemResults(level);
  const commit = commitStamp();
  const at = new Date().toISOString();
  for (const r of results) data.results[r.id] = { status: r.status, message: r.message, ms: r.ms, checks: r.checks, area: r.area, case: r.case, title: r.title, commit, at };
  if (known) for (const id of Object.keys(data.results)) if (!known.has(id)) delete data.results[id];
  data.level = level;
  data.updatedAt = at;
  data.environment = environment;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`);
  renameSync(tmp, file);
  return data;
}

export const summaryLine = (r) => `${r.status === 'passed' ? 'passed' : 'FAILED'}  ${r.id.padEnd(46)} ${String(r.checks).padStart(3)} checks  ${(r.ms / 1000).toFixed(1)}s`;

/** `--area=a,b --case=x,y` (and for the browser: `--headed --slow=ms`). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { area: null, id: null, headed: false, slow: 0 };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'area') out.area = v;
    else if (k === 'case') out.id = v;
    else if (k === 'headed') out.headed = true;
    else if (k === 'slow') out.slow = Number(v) || 0;
    else throw new Error(`Unknown option ${a}. See test/system/README.md.`);
  }
  return out;
}
