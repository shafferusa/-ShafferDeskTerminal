// Client core: API calls, shared state, live-reload hooks and number formatting.
import { useEffect, useRef, useState } from '../vendor/preact-htm.js';

// ---- API ------------------------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
export async function api(path, { method = 'GET', body, query } = {}) {
  let url = path;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const s = q.toString();
    if (s) url += `?${s}`;
  }
  let res;
  try {
    res = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('The Terminal server is not reachable. Check that it is still running.', { status: 0 });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, { status: res.status, code: data?.code, details: data?.details });
  return data;
}
export const get = (path, query) => api(path, { query });
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const put = (path, body) => api(path, { method: 'PUT', body: body ?? {} });
export const del = (path) => api(path, { method: 'DELETE' });

// ---- shared state -----------------------------------------------------------------------------------
const state = { status: null, books: [], bookId: load('sdt.book'), tick: 0, toasts: [], overlay: [], theme: load('sdt.theme') || '' };
const subs = new Set();
function load(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function save(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode */ } }
export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const fn of subs) fn(state);
}
export const getState = () => state;
export function useStore(selector = (s) => s) {
  const [, force] = useState(0);
  const last = useRef(selector(state));
  useEffect(() => {
    const fn = (s) => {
      const next = selector(s);
      if (next !== last.current) { last.current = next; force((n) => n + 1); }
    };
    subs.add(fn);
    return () => subs.delete(fn);
  }, []);
  last.current = selector(state);
  return last.current;
}
export const bump = () => setState((s) => ({ tick: s.tick + 1 }));
export function setBook(id) { save('sdt.book', id); setState({ bookId: id }); bump(); }
export function setTheme(t) {
  save('sdt.theme', t);
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  setState({ theme: t });
}
export function currentBook() { return state.books.find((b) => b.id === state.bookId) || state.books[0] || null; }

let toastId = 0;
export function toast(message, tone = 'ok', ms = 4500) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
export const toastError = (err) => toast(err?.message || String(err), 'err', 7000);

/** Open something on top of the page (modal or drawer). Returns a close function. */
export function openOverlay(render) {
  const id = ++toastId;
  const close = () => setState((s) => ({ overlay: s.overlay.filter((o) => o.id !== id) }));
  setState((s) => ({ overlay: [...s.overlay, { id, render: () => render(close) }] }));
  return close;
}

export async function refreshStatus() {
  const [status, books] = await Promise.all([get('/api/status'), get('/api/books')]);
  const bookId = books.items.some((b) => b.id === state.bookId) ? state.bookId : books.items[0]?.id || '';
  setState({ status, books: books.items, bookId });
  return status;
}

/**
 * Load data and keep it current: reloads when dependencies change, when the engine reports a
 * change, and on the refresh interval. Returns { data, error, loading, reload }.
 */
export function useLive(fetcher, deps = [], { interval = true } = {}) {
  const [box, setBox] = useState({ data: null, error: null, loading: true });
  const tick = useStore((s) => s.tick);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = (quiet) => {
    const n = ++seq.current;
    if (!quiet) setBox((b) => ({ ...b, loading: true }));
    Promise.resolve().then(fetcher).then(
      (data) => { if (alive.current && n === seq.current) setBox({ data, error: null, loading: false }); },
      (error) => { if (alive.current && n === seq.current) setBox((b) => ({ data: b.data, error, loading: false })); },
    );
  };
  useEffect(() => { run(false); }, deps);
  useEffect(() => { if (tick) run(true); }, [tick]);
  useEffect(() => {
    if (!interval) return undefined;
    const ms = state.status?.data?.refresh?.uiPollMs || 4000;
    const t = setInterval(() => { if (!document.hidden) run(true); }, ms);
    return () => clearInterval(t);
  }, deps);
  return { ...box, reload: () => run(true) };
}

// ---- formatting ---------------------------------------------------------------------------------------
const ZERO_DP = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'IDR']);
export const DASH = '—';
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
export function fmtNum(x, dp = 2, { sign = false } = {}) {
  if (!isNum(x)) return DASH;
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (x < 0) return `−${s}`;
  return sign && x > 0 ? `+${s}` : s;
}
export const ccyDp = (ccy) => (ZERO_DP.has(ccy) ? 0 : 2);
export function fmtMoney(x, ccy, opts = {}) {
  if (!isNum(x)) return DASH;
  return `${fmtNum(x, ccyDp(ccy), opts)}${opts.bare ? '' : ccy ? ` ${ccy}` : ''}`;
}
export function fmtQty(x) {
  if (!isNum(x)) return DASH;
  const a = Math.abs(x);
  const s = a.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 2 : 6 });
  return x < 0 ? `−${s}` : s;
}
export function fmtPrice(x) {
  if (!isNum(x)) return DASH;
  const a = Math.abs(x);
  const dp = a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 3 : 5;
  return fmtNum(x, dp);
}
export const fmtPct = (x, dp = 2, opts) => (isNum(x) ? `${fmtNum(x, dp, opts)}%` : DASH);
export function fmtAge(sec) {
  if (!isNum(sec)) return '';
  if (sec < 90) return `${Math.round(sec)}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
const NY = 'America/New_York';
export function fmtTime(iso, { date = true, seconds = false } = {}) {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const opts = { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false };
  if (seconds) opts.second = '2-digit';
  if (date) { opts.year = 'numeric'; opts.month = 'short'; opts.day = '2-digit'; }
  return `${d.toLocaleString('en-US', opts)} ET`;
}
export const fmtDate = (iso) => iso || DASH;
export const tone = (x) => (isNum(x) && x !== 0 ? (x > 0 ? 'gain' : 'loss') : '');
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const parseNum = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
export const VIEW_LABEL = { US_CASH: 'US Based', US_DERIV: 'US Derivatives', FOREIGN_CASH: 'Foreign Based', FOREIGN_DERIV: 'Foreign Derivatives' };
