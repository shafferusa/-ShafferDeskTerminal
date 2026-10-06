// Shaffer Desk Terminal server: static front end + JSON API + simulation engine.
//
//   npm start        the real paper-trading Terminal (data/terminal.db)
//   npm run demo     isolated demo on a simulated feed (data/demo.db, port 8788)

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createApi } from './api.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AppError } from './core/util.js';
import { seedDemoBook, seedDemoInstruments, seedDemoWatchlists } from './data/demo-seed.js';
import { readJson, sendJson } from './http/router.js';

const WEB_ROOT = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export function startServer(config = loadConfig()) {
  const app = createApp({ config });
  if (config.demo) {
    const insts = seedDemoInstruments(app);
    seedDemoBook(app);
    seedDemoWatchlists(app, insts);
  }
  const api = createApi(app);

  function authorised(req) {
    if (!config.password) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const given = Buffer.from(Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'));
    const want = Buffer.from(config.password);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = normalize(join(WEB_ROOT, rel));
    if (!file.startsWith(WEB_ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) {
      // Client-side routes fall back to the app shell.
      if (!extname(rel)) rel = '/index.html';
      else { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    }
    const target = normalize(join(WEB_ROOT, rel));
    const st = statSync(target);
    const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Content-Length': st.size, ETag: etag, 'Cache-Control': 'no-cache' });
    createReadStream(target).pipe(res);
  }

  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const off = app.engine.subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { off(); clearInterval(ping); });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!authorised(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Shaffer Desk Terminal"', 'Content-Type': 'text/plain' });
        res.end('Password required');
        return;
      }
      if (url.pathname === '/api/stream') return stream(req, res);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
        return serveStatic(req, res, decodeURIComponent(url.pathname));
      }
      const m = api.match(req.method, url.pathname);
      if (!m) return sendJson(res, 404, { error: 'Not found' });
      if (m.methodNotAllowed) return sendJson(res, 405, { error: 'Method not allowed' });
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
      const out = await m.handler({ params: m.params, query: Object.fromEntries(url.searchParams), body, req });
      return sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
      console.error('[api]', req.method, url.pathname, err);
      return sendJson(res, 500, { error: 'The Terminal hit an unexpected error handling this request.', detail: String(err.message || err) });
    }
  });

  server.listen(config.port, config.host, () => {
    const addr = server.address();
    console.log(`Shaffer Desk Terminal ${config.demo ? '(DEMO: simulated feed, separate database) ' : ''}listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${addr.port}`);
    console.log(`Database: ${config.dbFile}`);
    if (!config.demo) console.log(`Market data: ${app.data.market.state().message}`);
  });
  if (config.engine.autoStart) app.engine.start();
  const shutdown = () => { app.engine.stop(); server.close(() => { try { app.db.close(); } catch { /* already closed */ } process.exit(0); }); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, server };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
