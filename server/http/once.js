// Repeated requests: a mutating request that carries a client token takes effect once.
//
// A duplicate click, a retry after a lost connection and a retry after the Terminal was restarted all
// look the same to the server: the same instruction arriving again. A client that wants "once"
// sends a token with the request (body field `clientToken`, or the `Idempotency-Key` header):
//
//   first time     the request runs; its answer is stored under the token (table request_tokens)
//   same again     the stored answer is returned with `duplicate: true`; nothing runs
//   another body   refused (409 token_reused): a token names one request
//
// For a handler that answers synchronously (deposits, transfers, adjustments, events recorded by
// hand, corporate actions: everything that posts to the ledger directly) the effect and the
// stored answer commit in one database transaction, so a crash can never leave one without the
// other. For an asynchronous handler the answer is stored when it completes, and a second request
// with the same token that arrives meanwhile waits for the first and gets its answer.
// A refused request stores nothing, so it can be corrected and sent again under the same token.
//
// A request without a token is a new instruction every time, as before.
// The confirmation of a package (POST /api/strategies) has its own token, one per preview, and is
// not handled here; read-only POST routes (previews, connection test) and the engine take none.

import { createHash } from 'node:crypto';
import { AppError } from '../core/util.js';

const EXEMPT = new Set([
  'POST /api/strategies', // its own confirmation token (packages.submit)
  'POST /api/strategies/preview', 'POST /api/strategies/:id/preview-action', 'POST /api/hedge/requests/:id/preview', 'POST /api/data/test', // read-only
  'POST /api/engine/tick', 'POST /api/demo/advance', // an engine cycle is idempotent by construction and must always run
]);
const KEEP_DAYS = 14;
const TOKEN_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** JSON with object keys in a fixed order, so equal requests hash equally. */
function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
const toJson = (x) => JSON.stringify(x ?? { ok: true }, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v));

/** Wrap the router's mutating routes registered after this call. */
export function guardRepeats(router, app) {
  const { db } = app;
  const inFlight = new Map(); // token -> promise of the first request's answer (asynchronous handlers only)
  try { db.run('DELETE FROM request_tokens WHERE created_at < ?', new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString()); } catch { /* pruning is best effort */ }

  const store = (token, route, hash, answer) => db.run('INSERT OR IGNORE INTO request_tokens (token, route, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)', token, route, hash, toJson(answer), new Date().toISOString());
  const replay = (row, hash) => {
    if (row.request_hash !== hash) throw new AppError('This request token was already used for a different request. Nothing was done.', { status: 409, code: 'token_reused' });
    return { ...JSON.parse(row.response), duplicate: true };
  };

  function once(name, ctx, handler) {
    const given = ctx.req?.headers?.['idempotency-key'] ?? ctx.body?.clientToken ?? null;
    if (given === null || given === undefined || given === '') return handler(ctx);
    const token = String(given);
    if (!TOKEN_RE.test(token)) throw new AppError('The request token must be 8 to 128 letters, digits, dots, dashes, underscores or colons.', { status: 400, code: 'token_invalid' });
    const { clientToken, ...body } = ctx.body || {};
    const route = `${name} ${stable(ctx.params || {})}`;
    const hash = createHash('sha256').update(`${route}\n${stable(body)}`).digest('hex');
    const seen = db.get('SELECT request_hash, response FROM request_tokens WHERE token = ?', token);
    if (seen) return replay(seen, hash);
    if (inFlight.has(token)) {
      const first = inFlight.get(token);
      if (first.hash !== hash) throw new AppError('This request token was already used for a different request. Nothing was done.', { status: 409, code: 'token_reused' });
      return first.promise.then((answer) => ({ ...JSON.parse(toJson(answer)), duplicate: true }));
    }
    const run = () => handler({ ...ctx, body });
    // Synchronous handlers: the effect and the stored answer commit together (or neither does).
    let pending = null;
    const out = db.tx(() => {
      const res = run();
      if (res && typeof res.then === 'function') { pending = res; return null; }
      store(token, route, hash, res);
      return res;
    });
    if (!pending) return out;
    const promise = pending.then((answer) => { store(token, route, hash, answer); return answer; }).finally(() => inFlight.delete(token));
    inFlight.set(token, { hash, promise });
    return promise;
  }

  for (const [register, method] of [['post', 'POST'], ['put', 'PUT'], ['delete', 'DELETE']]) {
    const add = router[register];
    router[register] = (pattern, handler) => add(pattern, EXEMPT.has(`${method} ${pattern}`) ? handler : (ctx) => once(`${method} ${pattern}`, ctx, handler));
  }
  return router;
}
