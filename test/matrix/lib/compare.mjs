// Comparison of expected values (literals from a spec) with what a driver observed.
//
// diff(expected, actual) returns a list of human-readable mismatches; an empty list is a match.
//   - Only keys present in `expected` are compared, so an expectation can be partial.
//   - Arrays are compared whole: same length, element by element, in the given order.
//   - Numbers must agree to 0.000001 (money is already rounded to the currency's minor unit, so this
//     is exact to the cent). A value read from a screen carries the number of decimals it was shown
//     with (see Shown) and must agree after rounding to that many decimals.
//   - `null` expects the value to be missing (null or undefined): "shown as missing, never as zero".
//   - A RegExp expects String(actual) to match; a string expects equality.

/** A number as displayed on a screen: its value and how many decimals were shown. */
export class Shown {
  constructor(value, dp, text) { this.value = value; this.dp = dp; this.text = text; }
  toJSON() { return this.value; }
}

const EPS = 1e-6;
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof RegExp) && !(x instanceof Shown);
const show = (x) => (x instanceof Shown ? `${x.value} (shown as "${x.text}")` : x instanceof RegExp ? String(x) : x === undefined ? 'nothing' : JSON.stringify(x));

export function numbersAgree(expected, actual) {
  if (actual instanceof Shown) {
    if (actual.value === null) return false;
    // The screen rounds to `dp` decimals: the expected figure must round to what is displayed.
    return Math.abs(expected - actual.value) <= 0.5 * 10 ** -actual.dp + EPS;
  }
  return typeof actual === 'number' && Math.abs(expected - actual) <= EPS;
}

export function diff(expected, actual, path = '') {
  const at = path || 'value';
  if (expected === undefined) return [];
  if (expected === null) {
    const a = actual instanceof Shown ? actual.value : actual;
    return a === null || a === undefined ? [] : [`${at}: expected to be missing, got ${show(actual)}`];
  }
  if (expected instanceof RegExp) return expected.test(String(actual instanceof Shown ? actual.text : actual ?? '')) ? [] : [`${at}: expected to match ${expected}, got ${show(actual)}`];
  if (typeof expected === 'number') return numbersAgree(expected, actual) ? [] : [`${at}: expected ${expected}, got ${show(actual)}`];
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected a list of ${expected.length}, got ${show(actual)}`];
    const out = [];
    if (actual.length !== expected.length) out.push(`${at}: expected ${expected.length} item${expected.length === 1 ? '' : 's'}, got ${actual.length}${actual.length ? `: ${JSON.stringify(actual)}` : ''}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) out.push(...diff(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }
  if (isPlain(expected)) {
    if (!isPlain(actual)) return [`${at}: expected ${JSON.stringify(expected)}, got ${show(actual)}`];
    const out = [];
    for (const k of Object.keys(expected)) out.push(...diff(expected[k], actual[k], path ? `${path}.${k}` : k));
    return out;
  }
  const a = actual instanceof Shown ? actual.text : actual;
  return expected === a ? [] : [`${at}: expected ${show(expected)}, got ${show(actual)}`];
}

/**
 * Merge a step's expectations into the running expected state. Plain objects merge key by key;
 * arrays and single values replace what was there. This is what lets a step state only what it changes
 * while the whole state is still checked after every step.
 */
export function mergeExpect(base, patch) {
  if (patch === undefined) return base;
  if (!isPlain(patch) || !isPlain(base)) return clone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeExpect(base[k], v);
  return out;
}

function clone(x) {
  if (Array.isArray(x)) return x.map(clone);
  if (isPlain(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clone(v)]));
  return x;
}

/** Strict equality of two observed states (used across a restart). Returns mismatches. */
export function same(before, after, path = '') {
  if (before instanceof Shown || after instanceof Shown) return (before?.text ?? before) === (after?.text ?? after) ? [] : [`${path}: was ${show(before)}, now ${show(after)}`];
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return [`${path}: was ${JSON.stringify(before)}, now ${JSON.stringify(after)}`];
    return before.flatMap((b, i) => same(b, after[i], `${path}[${i}]`));
  }
  if (isPlain(before) || isPlain(after)) {
    if (!isPlain(before) || !isPlain(after)) return [`${path}: was ${JSON.stringify(before)}, now ${JSON.stringify(after)}`];
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((k) => same(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (typeof before === 'number' && typeof after === 'number') return Math.abs(before - after) <= EPS ? [] : [`${path}: was ${before}, now ${after}`];
  return before === after ? [] : [`${path}: was ${show(before)}, now ${show(after)}`];
}
