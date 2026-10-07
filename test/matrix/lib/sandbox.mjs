// Disposable data directories for the test matrix.
//
// The harness may only ever open a database that it created itself, in this process, inside a
// fresh temporary directory. Everything that opens a database (the in-process engine driver, the
// disposable server) takes a Sandbox object from createSandbox(); there is no way to hand them a
// path. assertSandbox() is called again right before each open and refuses:
//   - a directory this process did not create (no in-memory record, or a marker that does not match),
//   - anything inside the repository (so never the repo's data/ directory),
//   - anything outside the temporary base directory.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const MARKER = '.sdt-matrix-sandbox';
const PREFIX = 'sdt-matrix-';
const mine = new Map(); // dir -> nonce, for sandboxes created by this process

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);

/** Base directory for sandboxes: SDT_MATRIX_TMP if set, otherwise the system temporary directory. */
function baseDir() {
  const base = resolve(process.env.SDT_MATRIX_TMP || tmpdir());
  const refuse = (where) => { throw new Error(`Test matrix refuses to work inside the repository (${where}). Set SDT_MATRIX_TMP to a directory outside it.`); };
  // Checked before anything is created, and again on the real path in case a link points back into the repository.
  if (inside(base, REPO_ROOT)) refuse(base);
  mkdirSync(base, { recursive: true });
  const real = realpathSync(base);
  if (inside(real, realpathSync(REPO_ROOT))) refuse(real);
  return real;
}

/** Create a fresh, empty, marked directory. `label` only makes the name readable. */
export function createSandbox(label = 'run') {
  const dir = mkdtempSync(join(baseDir(), `${PREFIX}${String(label).replace(/[^a-z0-9_-]/gi, '_').slice(0, 40)}-`));
  const nonce = randomBytes(12).toString('hex');
  writeFileSync(join(dir, MARKER), JSON.stringify({ nonce, pid: process.pid, createdAt: new Date().toISOString() }));
  mine.set(dir, nonce);
  return { dir, dbFile: join(dir, 'matrix.db'), label };
}

/** Throws unless `sandbox` is a live directory created by createSandbox() in this process. */
export function assertSandbox(sandbox) {
  const fail = (why) => { throw new Error(`Test matrix refuses to open a database it did not create: ${why}`); };
  if (!sandbox || typeof sandbox.dir !== 'string' || typeof sandbox.dbFile !== 'string') fail('no sandbox was given.');
  const nonce = mine.get(sandbox.dir);
  if (!nonce) fail(`${sandbox.dir} was not created by this run.`);
  if (!existsSync(sandbox.dir)) fail(`${sandbox.dir} no longer exists.`);
  const real = realpathSync(sandbox.dir);
  if (inside(real, realpathSync(REPO_ROOT))) fail(`${real} is inside the repository.`);
  if (!inside(real, baseDir())) fail(`${real} is outside the temporary directory.`);
  if (!real.split(sep).pop().startsWith(PREFIX)) fail(`${real} is not a test-matrix directory.`);
  let marker = null;
  try { marker = JSON.parse(readFileSync(join(real, MARKER), 'utf8')); } catch { /* handled below */ }
  if (!marker || marker.nonce !== nonce) fail(`${real} does not carry this run's marker.`);
  if (resolve(dirname(sandbox.dbFile)) !== resolve(sandbox.dir)) fail(`${sandbox.dbFile} is not inside its sandbox.`);
  return sandbox;
}

/** Remove a sandbox and everything in it. Refuses anything assertSandbox() refuses. */
export function destroySandbox(sandbox) {
  if (!sandbox || !mine.has(sandbox.dir)) return;
  if (existsSync(sandbox.dir)) { assertSandbox(sandbox); rmSync(sandbox.dir, { recursive: true, force: true }); }
  mine.delete(sandbox.dir);
}
