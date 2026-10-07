// Runs one product scenario against one driver and returns a result per step.
//
// For every step:
//   1. the driver performs the action (a trade is previewed, checked and confirmed);
//   2. one engine cycle runs, as the engine timer would;
//   3. the step's own expectations are compared: preview figures, execution result, new history events;
//   4. the step's state expectations are merged into the running expected state, and the WHOLE
//      expected state is compared with what the Terminal now shows (so a step states only what it
//      changes, and everything stated earlier is still re-checked);
//   5. the integrity report must be clean.
// After the last step the application is restarted and everything is read again: it must equal what
// was read before the restart, and still match the expected state.
//
// A step that fails ends the scenario: later steps are not run and get no result, so the matrix
// shows them as "not run". A step declared `status: 'unsupported'` or `'blocked'` passes only if the
// Terminal visibly refuses the action with the stated reason and nothing changes; it is then
// recorded with that status.

import { diff, mergeExpect, same } from './compare.mjs';
import { createSandbox, destroySandbox } from './sandbox.mjs';

export const LEVELS = { engine: 'E', api: 'A', browser: 'B' };
/** State sections every scenario must have stated by the end of its first trade step. */
export const REQUIRED_SECTIONS = ['cash', 'positions', 'pending', 'pnl', 'nav', 'balance'];

/** What a scenario is about: a catalog product id, or `T:<template id>` for an execution template. */
export const specKey = (spec) => (spec.template ? `T:${spec.template}` : spec.productId);
export const testId = (level, spec, stepId) => `${LEVELS[level]}:${specKey(spec)}:${stepId}`;

const matches = (pattern, text) => (pattern instanceof RegExp ? pattern.test(text) : String(text).includes(String(pattern)));
/** `refused` may be one pattern for every level, or { engine, api, browser } when a screen words it differently. */
const forLevel = (x, level) => (x && typeof x === 'object' && !(x instanceof RegExp) ? x[level] ?? x.api ?? x.engine : x);

function compareEvents(expected, actual) {
  const out = [];
  const brief = actual.map((e) => `${e.type} "${e.summary}"`);
  if (expected.length !== actual.length) out.push(`history: expected ${expected.length} new event${expected.length === 1 ? '' : 's'} (${expected.map((e) => e.type).join(', ') || 'none'}), got ${actual.length}${actual.length ? `: ${brief.join('; ')}` : ''}`);
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
    const e = expected[i], a = actual[i];
    if (e.type !== a.type) { out.push(`history[${i}]: expected a ${e.type} event, got ${brief[i]}`); continue; }
    if (e.summary !== undefined && !matches(e.summary, a.summary)) out.push(`history[${i}] (${e.type}): summary "${a.summary}" does not match ${e.summary}`);
    if (e.cash !== undefined) out.push(...diff(e.cash, a.cash, `history[${i}].cash`));
    if (e.owner !== undefined && e.owner !== a.owner) out.push(`history[${i}] (${e.type}): owned by ${a.owner}, expected ${e.owner}`);
    if (e.date !== undefined && e.date !== a.date) out.push(`history[${i}] (${e.type}): dated ${a.date}, expected ${e.date}`);
  }
  return out;
}

/**
 * @param spec    one product spec
 * @param driver  { level, setup, act, cycle, observe, newEvents, integrity, restart, close, screens? }
 * @returns {Promise<{results: Array, ms: number}>}
 */
export async function runScenario(spec, driver, { log = () => {} } = {}) {
  const level = driver.level;
  const results = [];
  const record = (stepId, status, message, ms, step) => {
    const r = { id: testId(level, spec, stepId), product: spec.productId || null, template: spec.template || null, family: spec.family, step: stepId, covers: [].concat(step?.covers || []), status, message: message || '', ms: Math.round(ms) };
    results.push(r);
    log(r);
    return r;
  };
  const started = Date.now();
  const sandbox = createSandbox(`${level}-${specKey(spec).replace(/[^a-z0-9_]+/gi, '-')}`);
  let expected = {};
  let ctx = null;

  /** Everything that must hold after a step. Returns the list of mismatches. */
  const verify = async (step, { events = true } = {}) => {
    const problems = [];
    const state = await driver.observe(ctx);
    problems.push(...diff(expected, state));
    let ev = [];
    if (events) {
      ev = await driver.newEvents(ctx);
      problems.push(...compareEvents(step?.expect?.events || [], ev));
    }
    const integ = await driver.integrity(ctx);
    if (!integ.ok) problems.push(...integ.problems.map((p) => `integrity ${p}`));
    // Browser level only: what the screens display, against the spec and against the API's version of the same state.
    if (driver.screens) problems.push(...await driver.screens(ctx, { expected, state, events: ev, step }));
    return { problems, state, integ };
  };

  try {
    // ---- setup -----------------------------------------------------------------------------------------
    let t0 = Date.now();
    try {
      ctx = await driver.setup(spec, sandbox);
      expected = mergeExpect(expected, spec.expectAtStart || {});
      const v = await verify(null, { events: false });
      if (v.problems.length) { record('setup', 'failed', v.problems.join('\n'), Date.now() - t0); return { results, ms: Date.now() - started }; }
      record('setup', 'passed', '', Date.now() - t0);
    } catch (err) {
      record('setup', 'failed', `Setup did not complete: ${err.stack || err.message}`, Date.now() - t0);
      return { results, ms: Date.now() - started };
    }

    // ---- steps -----------------------------------------------------------------------------------------
    let seenTrade = false;
    for (const step of spec.steps) {
      t0 = Date.now();
      const refusalExpected = step.status === 'unsupported' || step.status === 'blocked';
      try {
        const out = await driver.act(ctx, step);
        await driver.cycle(ctx);
        const problems = [];
        if (refusalExpected) {
          if (!out.refusal) problems.push(`The spec says this is ${step.status} (${step.reason || 'no reason given'}), but the Terminal did not refuse it.`);
          else if (!matches(forLevel(step.expect.refused, level), out.refusal.message)) problems.push(`Refused, but not for the stated reason. Terminal said: "${out.refusal.message}"; expected ${forLevel(step.expect.refused, level)}`);
        } else if (out.refusal) problems.push(`The Terminal refused this step at the ${out.refusal.where}: ${out.refusal.message}`);
        if (step.expect?.preview !== undefined) problems.push(...diff(step.expect.preview, out.preview, 'preview'));
        if (step.expect?.result !== undefined) problems.push(...diff(step.expect.result, out.result, 'result'));
        if (out.problems?.length) problems.push(...out.problems);
        const { preview, result, refused, events, ...stateExpect } = step.expect || {};
        expected = mergeExpect(expected, stateExpect);
        if (!refusalExpected && ['ticket', 'close', 'resize', 'package'].includes(step.action) && !seenTrade) {
          seenTrade = true;
          const missing = REQUIRED_SECTIONS.filter((k) => expected[k] === undefined);
          if (missing.length) problems.push(`The spec has not stated ${missing.join(', ')} by its first trade. Every scenario states these sections (see README).`);
        }
        const v = await verify(step);
        problems.push(...v.problems);
        if (problems.length) { record(step.id, 'failed', problems.join('\n'), Date.now() - t0, step); return { results, ms: Date.now() - started }; }
        record(step.id, refusalExpected ? step.status : 'passed', refusalExpected ? `${step.reason ? `${step.reason} ` : ''}Terminal: "${out.refusal.message}"` : '', Date.now() - t0, step);
      } catch (err) {
        record(step.id, 'failed', `Step did not complete: ${err.stack || err.message}`, Date.now() - t0, step);
        return { results, ms: Date.now() - started };
      }
    }

    // ---- restart and persistence --------------------------------------------------------------------------
    t0 = Date.now();
    try {
      const before = await verify(null, { events: false });
      await driver.restart(ctx);
      const after = await verify({ expect: { events: [] } });
      const problems = [...after.problems, ...same(before.state, after.state, 'after restart'), ...same(before.integ.counts, after.integ.counts, 'after restart: stored rows')];
      record('restart', problems.length ? 'failed' : 'passed', problems.join('\n'), Date.now() - t0, { covers: ['restart'] });
    } catch (err) {
      record('restart', 'failed', `Restart check did not complete: ${err.stack || err.message}`, Date.now() - t0, { covers: ['restart'] });
    }
    return { results, ms: Date.now() - started };
  } finally {
    try { await driver.close(); } catch { /* the sandbox is removed regardless */ }
    destroySandbox(sandbox);
  }
}
