// A very small HTTP router: method + path patterns with :params, JSON in and out.

import { AppError } from '../core/util.js';

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, path) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

export async function readJson(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new AppError('Request body is too large.', { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('Request body is not valid JSON.', { status: 400 });
  }
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
