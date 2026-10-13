// The level mapping of the system suite: for every case, at every level, either the test that runs there or the
// precise reason it does not, with the test ids that cover what a user sees instead.
//
// The rules (checkMapping), enforced by every runner before anything runs (loadCases in kit.mjs):
//   1. Each case gives, for each of the three levels, a function (it runs there) or a reason (a sentence).
//   2. A reason is a sentence of at least 30 characters, not a placeholder.
//   3. Every test id a reason names (SE:<area>:<case>, SA:..., SB:..., "SE/SA:..." for both, a trailing * for a
//      family of cases) must exist and run at that level.
//   4. A case that runs at the engine or API level but not in the browser must name, in its browser reason, at least
//      one SB:... test that covers what the user sees of it. A case runs at one level at least.
//
// mappingMarkdown() prints the table (case, what it proves, engine / API / browser id and status or the reason) with
// the counts per level; test/system/mapping.mjs writes it into test/system/README.md, scripts/test-matrix.js into
// the "System behaviour" section of docs/TEST-MATRIX.md.

export const MAP_LEVELS = ['engine', 'api', 'browser'];
const LETTER = { engine: 'SE', api: 'SA', browser: 'SB' };
const LEVEL_OF = { SE: 'engine', SA: 'api', SB: 'browser' };
const NAME = { engine: 'Engine', api: 'API', browser: 'Browser' };
const REF = /\b((?:S[EAB]\/)*S[EAB]):([a-z]+):([a-z0-9-]+\*?)/g;

const runs = (k, level) => typeof k.levels?.[level] === 'function';
const reasonOf = (k, level) => (typeof k.levels?.[level] === 'string' ? k.levels[level].trim() : null);

/** The test ids a reason names: [{ level, area, id, pattern, text }]. */
export function referencesIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(REF)) {
    for (const letter of m[1].split('/')) out.push({ level: LEVEL_OF[letter], area: m[2], id: m[3], text: `${letter}:${m[2]}:${m[3]}` });
  }
  return out;
}

/** The cases a reference resolves to (a trailing * matches every case id that starts with what precedes it). */
function resolveRef(ref, cases) {
  const star = ref.id.endsWith('*');
  const stem = star ? ref.id.slice(0, -1) : ref.id;
  return cases.filter((k) => k.area === ref.area && (star ? k.id.startsWith(stem) : k.id === stem));
}

/** Every breach of the rules above, as sentences. Empty when the mapping is complete. */
export function checkMapping(cases) {
  const problems = [];
  for (const k of cases) {
    const where = `${k.area}:${k.id}`;
    if (!MAP_LEVELS.some((l) => runs(k, l))) problems.push(`${where}: runs at no level.`);
    for (const l of MAP_LEVELS) {
      if (runs(k, l)) continue;
      const reason = reasonOf(k, l);
      if (reason === null) { problems.push(`${where}: the ${l} level has neither a test nor a reason.`); continue; }
      if (reason.length < 30) problems.push(`${where}: the ${l} reason "${reason}" is not a sentence that explains why (30 characters at least).`);
      const refs = referencesIn(reason);
      for (const ref of refs) {
        const hit = resolveRef(ref, cases);
        if (!hit.length) problems.push(`${where}: the ${l} reason names ${ref.text}, which is not a case.`);
        else if (!hit.some((h) => runs(h, ref.level))) problems.push(`${where}: the ${l} reason names ${ref.text}, which does not run at the ${ref.level} level.`);
      }
      if (l === 'browser' && (runs(k, 'engine') || runs(k, 'api')) && !refs.some((r) => r.level === 'browser')) {
        problems.push(`${where}: runs at the ${runs(k, 'api') ? 'API' : 'engine'} level but not in the browser, and its browser reason names no SB:... test that covers what the user sees.`);
      }
    }
  }
  return problems;
}

/** Per level: how many cases run there, how many give a reason, and the statuses of those that run. */
export function mappingCounts(cases, results = {}) {
  const out = {};
  for (const l of MAP_LEVELS) {
    const ran = cases.filter((k) => runs(k, l));
    const st = { passed: 0, failed: 0, notRun: 0 };
    for (const k of ran) {
      const r = results[l]?.results?.[`${LETTER[l]}:${k.area}:${k.id}`];
      if (!r) st.notRun++; else if (r.status === 'passed') st.passed++; else st.failed++;
    }
    out[l] = { cases: cases.length, run: ran.length, reasons: cases.length - ran.length, ...st, updatedAt: results[l]?.updatedAt || null };
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/**
 * The mapping table in Markdown. `results`: { engine, api, browser } as read by readSystemResults (a level that was
 * never run shows "not run"). `heading`: the Markdown heading prefix of the sub-sections ('###' by default).
 */
export function mappingMarkdown(cases, results = {}, { heading = '###', areas = {} } = {}) {
  const n = mappingCounts(cases, results);
  const apiNoBrowser = cases.filter((k) => runs(k, 'api') && !runs(k, 'browser'));
  const browserOnly = cases.filter((k) => runs(k, 'browser') && !runs(k, 'api'));
  let md = `${cases.length} cases. Each declares, at each level, the test that runs there or the precise reason it does not; `
    + 'the runners refuse to start when a level has neither, when a reason names a test that does not exist or does not run at that level, '
    + 'or when a case that runs at engine or API level names no browser test covering what the user sees of it (test/system/lib/mapping.mjs).\n\n';
  md += '| Level | Cases | Run at this level | Not applicable (reason given) | Passed | Failed | Not run | Results as of |\n|---|---:|---:|---:|---:|---:|---:|---|\n';
  for (const l of MAP_LEVELS) md += `| ${NAME[l]} | ${n[l].cases} | ${n[l].run} | ${n[l].reasons} | ${n[l].passed} | ${n[l].failed} | ${n[l].notRun} | ${n[l].updatedAt || 'never run'} |\n`;
  md += `\nEach row adds up: run + not applicable = ${cases.length} at every level; passed + failed + not run = run. `
    + `${apiNoBrowser.length} of the ${n.api.run} API cases have no browser run of their own; each names the browser test(s) that cover what the user sees of it (the Browser column below). `
    + `${browserOnly.length} browser cases have no API run (a click, a dialog or a screen is a browser matter; the routes behind them are covered by the tests their API reason names).\n\n`;
  const status = (l, k) => {
    const id = `${LETTER[l]}:${k.area}:${k.id}`;
    const r = results[l]?.results?.[id];
    return `\`${id}\` ${r ? (r.status === 'passed' ? 'passed' : `**${r.status}**`) : 'not run'}`;
  };
  const cell = (l, k) => (runs(k, l) ? status(l, k) : `not applicable: ${esc(reasonOf(k, l))}`);
  for (const area of [...new Set(cases.map((k) => k.area))]) {
    md += `${heading} ${esc(areas[area] || area)}\n\n| Case | What it proves | Engine | API | Browser |\n|---|---|---|---|---|\n`;
    for (const k of cases.filter((x) => x.area === area)) md += `| \`${k.area}:${k.id}\` ${esc(k.title)} | ${esc(k.proves)} | ${cell('engine', k)} | ${cell('api', k)} | ${cell('browser', k)} |\n`;
    md += '\n';
  }
  return md;
}
