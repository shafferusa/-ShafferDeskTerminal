import { randomBytes, randomUUID } from 'node:crypto';

/** Short, sortable-ish, human-readable IDs: PREFIX-xxxxxxxx */
export function newId(prefix) {
  return `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;
}
export const uuid = () => randomUUID();

const ZERO_DP = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'IDR', 'PYG', 'UGX', 'XAF', 'XOF']);
const THREE_DP = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'TND']);

/** Minor-unit decimals of a currency. */
export function ccyDecimals(ccy) {
  if (ZERO_DP.has(ccy)) return 0;
  if (THREE_DP.has(ccy)) return 3;
  return 2;
}

export function round(x, dp = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const a = Math.abs(x);
  // Exponent-string rounding avoids binary artefacts such as 1.005 -> 1.00
  let r = Number(`${Math.round(Number(`${a}e${dp}`))}e-${dp}`);
  if (!Number.isFinite(r)) r = Math.round(a * 10 ** dp) / 10 ** dp;
  return x < 0 ? -r + 0 : r;
}

/** Round a money amount to the currency's minor unit. */
export const money = (x, ccy = 'USD') => round(x, ccyDecimals(ccy));

/** Quantities are kept to 8 decimals (enough for crypto units). */
export const qty8 = (x) => round(x, 8);

export const isZero = (x, eps = 1e-9) => Math.abs(x || 0) < eps;
export const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
export const num = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number(String(x).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Error carrying an HTTP status and a machine code. Thrown for user-facing validation failures. */
export class AppError extends Error {
  constructor(message, { status = 400, code = 'invalid', details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const fail = (message, opts) => {
  throw new AppError(message, opts);
};
export const need = (cond, message, opts) => {
  if (!cond) throw new AppError(message, opts);
};

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    let g = m.get(k);
    if (!g) m.set(k, (g = []));
    g.push(x);
  }
  return m;
}

export const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

export const CCY_RE = /^[A-Z]{3}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
