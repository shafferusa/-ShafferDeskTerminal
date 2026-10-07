// Disposable Terminal server process for the API and browser levels.
//
// Starts `server/index.js --demo` on a free port with its database inside a sandbox, and refuses
// to continue unless the server itself reports that database path. The engine timer is off
// (SDT_ENGINE=off): every engine cycle is an explicit request (POST /api/engine/tick, or a clock
// move), which is the same function the timer calls, so a scenario's state never changes under
// the reader. The process is stopped by its PID only.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { assertSandbox, REPO_ROOT } from './sandbox.mjs';

const START_TIMEOUT_MS = 20_000;

export async function startServer(sandbox, { demo = true, port: wantPort = 0 } = {}) {
  assertSandbox(sandbox);
  const env = {};
  // The server must not inherit a data directory, a service address or a credential from the caller.
  for (const [k, v] of Object.entries(process.env)) if (!/^(SDT_|SHAFFER_)/.test(k) && k !== 'PORT' && k !== 'HOST') env[k] = v;
  Object.assign(env, { SDT_DATA_DIR: sandbox.dir, SDT_DB_FILE: sandbox.dbFile, SDT_ENGINE: 'off', SDT_HOST: '127.0.0.1' });
  // Port 0 lets the system pick a free port. A restart asks for the port it had, so the browser's origin stays the same.
  const args = ['--disable-warning=ExperimentalWarning', resolve(REPO_ROOT, 'server/index.js'), `--port=${wantPort}`, ...(demo ? ['--demo'] : [])];
  const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let exited = null;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const stop = () => new Promise((done) => {
    if (exited) return done(exited);
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 4000);
    child.once('exit', () => { clearTimeout(hard); done(exited); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(hard); done(exited); }
  });

  const started = Date.now();
  let port = null, database = null;
  while (Date.now() - started < START_TIMEOUT_MS) {
    port ??= /listening on http:\/\/[^:\s]+:(\d+)/.exec(out)?.[1] ?? null;
    database ??= /^Database: (.+)$/m.exec(out)?.[1]?.trim() ?? null;
    if (port && database) break;
    if (exited) throw new Error(`The test server exited before it was ready (${JSON.stringify(exited)}):\n${out}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!port || !database) { await stop(); throw new Error(`The test server did not report its port and database in time:\n${out}`); }
  if (resolve(database) !== resolve(sandbox.dbFile)) {
    await stop();
    throw new Error(`The test server opened ${database}, not the sandbox database ${sandbox.dbFile}. Stopped it.`);
  }
  return { url: `http://127.0.0.1:${port}`, port: Number(port), pid: child.pid, database, demo, stop, logs: () => out, exited: () => exited };
}
