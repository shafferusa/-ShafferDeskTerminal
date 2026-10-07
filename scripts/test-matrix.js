// Writes docs/TEST-MATRIX.md and docs/test-matrix.json: the product test matrix.
//   npm run matrix
//
// Three sources, and nothing else:
//   - the product catalog (server/core/catalog.js) and the execution templates (server/core/templates.js):
//     every one of them gets a row, whether or not anything tests it;
//   - the scenario specs (test/matrix/specs/<family>.mjs): what is specified for a product, step by step;
//   - the results files (test/matrix/results/<level>.json): what actually ran, and how it ended.
//
// A status is only ever read from a results file, by test id. A product with no spec is "not yet
// specified". A step with no result at a level is "not run" at that level, also when the spec changed
// after the last run. Nothing is inferred from another product, another level or another step.

import { writeFileSync } from 'node:fs';
import { catalogSummary } from '../server/core/catalog.js';
import { TEMPLATES } from '../server/core/templates.js';
import { readResults } from '../test/matrix/lib/results.mjs';
import { LEVELS, specKey, testId } from '../test/matrix/lib/runner.mjs';
import { loadSpecs } from '../test/matrix/lib/specs.mjs';

const LEVEL_NAMES = { engine: 'Engine', api: 'API', browser: 'Browser' };
const SUPPORT = { full: 'Full lifecycle', partial: 'Partly manual', manual: 'Manual inputs', planned: 'Not implemented' };
const STATUSES = ['passed', 'failed', 'blocked', 'unsupported'];
const levels = Object.keys(LEVELS);

const { products, families } = catalogSummary();
const specs = await loadSpecs();
const specOf = new Map(specs.map((s) => [specKey(s), s]));
const results = Object.fromEntries(levels.map((l) => [l, readResults(l)]));

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const list = (x) => [].concat(x ?? []).join('; ');
const seconds = (ms) => (ms === undefined || ms === null ? '' : `${(ms / 1000).toFixed(1)} s`);

/** The rows of one scenario: setup, one row per action the steps cover, steps that cover no action, the restart check. */
function rowsOf(spec) {
  const key = specKey(spec);
  const rows = [];
  const byAction = new Map();
  const add = (action, step) => {
    if (!byAction.has(action)) { byAction.set(action, { action, steps: [] }); rows.push(byAction.get(action)); }
    byAction.get(action).steps.push(step);
  };
  add('set up: Book, Account, funding, instrument registration, fixtures', { id: 'setup' });
  for (const st of spec.steps) {
    const covers = [].concat(st.covers || []);
    if (!covers.length) add('market data or clock move (no product action)', st);
    for (const c of covers) add(c, st);
  }
  add('restart: persistence of everything above', { id: 'restart' });
  return rows.map((row) => {
    const out = { action: row.action, steps: row.steps.map((s) => s.id), notes: [] };
    for (const st of row.steps) if (st.status) out.notes.push(`${st.id}: ${st.status} by design. ${st.reason}`);
    for (const level of levels) {
      const tests = row.steps.map((st) => {
        const id = testId(level, spec, st.id);
        const r = results[level].results[id];
        return { id, status: r ? r.status : 'not run', ms: r ? r.ms : null, message: r && r.status === 'failed' ? r.message : undefined };
      });
      const count = {};
      for (const t of tests) count[t.status] = (count[t.status] || 0) + 1;
      const kinds = Object.keys(count);
      out[level] = { status: kinds.length === 1 ? kinds[0] : 'mixed', summary: kinds.length === 1 ? kinds[0] : [...STATUSES, 'not run'].filter((s) => count[s]).map((s) => `${s} ${count[s]}`).join(', '), tests };
      for (const t of tests) if (t.status === 'failed') out.notes.push(`${t.id} failed: ${String(t.message || '').split('\n')[0]}`);
    }
    out.key = key;
    return out;
  });
}

/** What one level says about one scenario as a whole. Read from the step results, not from the run summary. */
function levelOf(spec, level) {
  const ids = ['setup', ...spec.steps.map((s) => s.id), 'restart'].map((s) => testId(level, spec, s));
  const got = ids.map((id) => results[level].results[id]?.status || 'not run');
  const count = Object.fromEntries([...STATUSES, 'not run'].map((s) => [s, got.filter((g) => g === s).length]));
  const run = results[level].runs[specKey(spec)] || null;
  let status;
  if (count['not run'] === ids.length) status = 'not run';
  else if (count.failed) status = 'failed';
  else if (count['not run']) status = 'incomplete';
  else status = 'complete';
  return { status, steps: ids.length, ...count, notRun: count['not run'], ms: status === 'not run' ? null : run?.ms ?? null, at: run?.at ?? null, commit: run?.commit ?? null };
}

function describe(spec) {
  const out = { specified: true, specFile: `test/matrix/specs/${spec.file}`, title: spec.title, tradedOn: spec.tradedOn || null, start: spec.start, matrix: spec.matrix, rows: rowsOf(spec), levels: {} };
  for (const level of levels) out.levels[level] = levelOf(spec, level);
  return out;
}
const NOT_SPECIFIED = { specified: false, rows: [], levels: Object.fromEntries(levels.map((l) => [l, { status: 'not run' }])) };

// ---- data ------------------------------------------------------------------------------------------
const familyIds = [...new Set(products.map((p) => p.family))];
const data = {
  about: 'Generated by `npm run matrix` (scripts/test-matrix.js) from the catalog, the specs in test/matrix/specs and the results in test/matrix/results. Do not edit by hand.',
  results: Object.fromEntries(levels.map((l) => [l, { file: `test/matrix/results/${l}.json`, updatedAt: results[l].updatedAt || null }])),
  summary: null,
  families: familyIds.map((id) => ({
    id, label: families[id]?.label || id,
    products: products.filter((p) => p.family === id).map((p) => ({ id: p.id, name: p.name, group: p.group, support: p.support, pricing: p.pricing, ...(specOf.has(p.id) ? describe(specOf.get(p.id)) : NOT_SPECIFIED) })),
  })),
  templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, group: t.group, legs: t.legs, ...(specOf.has(`T:${t.id}`) ? describe(specOf.get(`T:${t.id}`)) : NOT_SPECIFIED) })),
};

const allProducts = data.families.flatMap((f) => f.products);
const tally = (items, level) => {
  const out = { specifiedSteps: 0, passed: 0, failed: 0, blocked: 0, unsupported: 0, notRun: 0, complete: 0, failedScenarios: 0, incomplete: 0, scenariosNotRun: 0 };
  for (const it of items.filter((x) => x.specified)) {
    const lv = it.levels[level];
    out.specifiedSteps += lv.steps;
    for (const s of STATUSES) out[s] += lv[s];
    out.notRun += lv.notRun;
    if (lv.status === 'complete') out.complete++;
    else if (lv.status === 'failed') out.failedScenarios++;
    else if (lv.status === 'incomplete') out.incomplete++;
    else out.scenariosNotRun++;
  }
  return out;
};
// Results whose test id no longer belongs to any spec step: they are ignored, and counted so that it is visible.
const known = new Set(specs.flatMap((s) => levels.flatMap((l) => ['setup', ...s.steps.map((x) => x.id), 'restart'].map((id) => testId(l, s, id)))));
data.summary = {
  products: { catalog: allProducts.length, specified: allProducts.filter((p) => p.specified).length, notYetSpecified: allProducts.filter((p) => !p.specified).length },
  templates: { catalog: data.templates.length, specified: data.templates.filter((t) => t.specified).length, notYetSpecified: data.templates.filter((t) => !t.specified).length },
  levels: Object.fromEntries(levels.map((l) => [l, { products: tally(allProducts, l), templates: tally(data.templates, l), ignoredResults: Object.keys(results[l].results).filter((id) => !known.has(id)).length }])),
};

// ---- document --------------------------------------------------------------------------------------
const cell = (lv) => (lv.status === 'complete' ? `complete, ${seconds(lv.ms)}` : lv.status === 'failed' ? `**FAILED** (${lv.failed} step${lv.failed === 1 ? '' : 's'})` : lv.status === 'incomplete' ? `incomplete (${lv.notRun} of ${lv.steps} not run)` : 'not run');
const rowCell = (r) => (r.status === 'failed' || /failed/.test(r.summary) ? `**${r.summary.toUpperCase()}**` : r.summary);
const S = data.summary;

let md = `# Product test matrix

Generated by \`npm run matrix\` from three sources: the product catalog and execution templates, the scenario
specs in \`test/matrix/specs/\`, and the results the test runs wrote to \`test/matrix/results/\`. The same content as
data is in \`docs/test-matrix.json\`. How the harness works, and how to add a family, is in \`test/matrix/README.md\`.

**How to read it**

- Every catalog product and every execution template has a row. A product with no scenario is **not yet specified**.
- A scenario is a list of steps on one fictional instrument of exactly that product, in its own disposable database.
  After every step the cash buckets, positions, pending obligations, P&L, net asset value, balance sheet,
  borrowings and new history rows must equal figures worked out by hand in the spec, and the integrity check must be
  clean. At the end the application is restarted and everything is read again.
- The same scenario runs at three levels: **Engine** (in-process, \`npm test\`), **API** (HTTP against a disposable
  server, \`npm run test:api\`) and **Browser** (the interface in Chromium against a disposable server, with every
  Accounting screen read back and compared with both the API and the spec, \`npm run test:browser\`).
- Test ids are \`E:<product>:<step>\`, \`A:<product>:<step>\` and \`B:<product>:<step>\` (\`E:T:<template>:<step>\` for a
  template). The tables give the step names; put the level letter and the product id in front.
- Statuses come only from the results files. **passed**: the step ran and every figure matched. **blocked** and
  **unsupported**: the spec declares that the Terminal does not allow the action (blocked: not in this state;
  unsupported: not at all, it is recorded by hand instead), and the test asserted that the Terminal refused it
  visibly, with the stated reason, and that nothing changed. **failed**: a figure did not match; the scenario stops
  there. **not run**: no result at that level, because the level was not run for the product, an earlier step failed,
  or the spec changed after the last run. Nothing is counted as tested because another product shares its engine.

## Summary

| | In the catalog | Specified | Not yet specified |
|---|---:|---:|---:|
| Products | ${S.products.catalog} | ${S.products.specified} | ${S.products.notYetSpecified} |
| Execution templates | ${S.templates.catalog} | ${S.templates.specified} | ${S.templates.notYetSpecified} |

Steps of the specified product scenarios, by level and status:

| Level | Results as of | Steps specified | Passed | Failed | Blocked (asserted) | Unsupported (asserted) | Not run |
|---|---|---:|---:|---:|---:|---:|---:|
${levels.map((l) => { const t = S.levels[l].products; return `| ${LEVEL_NAMES[l]} | ${data.results[l].updatedAt || 'never run'} | ${t.specifiedSteps} | ${t.passed} | ${t.failed} | ${t.blocked} | ${t.unsupported} | ${t.notRun} |`; }).join('\n')}

Product scenarios, by level:

| Level | Every step run, none failed | With a failed step | Partly run | Not run | Not yet specified |
|---|---:|---:|---:|---:|---:|
${levels.map((l) => { const t = S.levels[l].products; return `| ${LEVEL_NAMES[l]} | ${t.complete} | ${t.failedScenarios} | ${t.incomplete} | ${t.scenariosNotRun} | ${S.products.notYetSpecified} |`; }).join('\n')}

By engine family:

| Family | Products | Specified | Engine complete | API complete | Browser complete |
|---|---:|---:|---:|---:|---:|
${data.families.map((f) => `| ${esc(f.label)} (\`${f.id}\`) | ${f.products.length} | ${f.products.filter((p) => p.specified).length} | ${levels.map((l) => f.products.filter((p) => p.specified && p.levels[l].status === 'complete').length).join(' | ')} |`).join('\n')}
| **Total** | **${S.products.catalog}** | **${S.products.specified}** | ${levels.map((l) => `**${S.levels[l].products.complete}**`).join(' | ')} |
${levels.some((l) => S.levels[l].ignoredResults) ? `\nResults ignored because their step is no longer in any spec: ${levels.map((l) => `${LEVEL_NAMES[l]} ${S.levels[l].ignoredResults}`).join(', ')}.\n` : ''}
`;

for (const f of data.families) {
  const done = f.products.filter((p) => p.specified);
  const todo = f.products.filter((p) => !p.specified);
  md += `## ${f.label} (\`${f.id}\`)\n\n${f.products.length} product${f.products.length === 1 ? '' : 's'}, ${done.length} specified${done.length ? ` in ${[...new Set(done.map((p) => `\`${p.specFile}\``))].join(', ')}` : ''}.\n\n`;
  if (done.length) {
    md += `### Scenarios\n\n| Product | Scenario | Steps | Engine | API | Browser |\n|---|---|---:|---|---|---|\n`;
    for (const p of done) md += `| ${esc(p.name)} (\`${p.id}\`) | ${esc(p.title)}${p.tradedOn ? `. ${esc(p.tradedOn)}` : ''} | ${p.levels.engine.steps} | ${levels.map((l) => cell(p.levels[l])).join(' | ')} |\n`;
    md += `\n### Ticket, inputs and behaviour\n\n| Product | Ticket and required fields | Automatic inputs | Manual inputs | Settlement and lifecycle events | Accounting and collateral |\n|---|---|---|---|---|---|\n`;
    for (const p of done) {
      const m = p.matrix;
      md += `| \`${p.id}\` | ${esc(m.ticket)}. Required: ${esc(list(m.requiredFields))} | ${esc(list(m.automaticInputs))} | ${esc(list(m.manualInputs)) || 'none'} | ${esc(m.settlement)}. ${esc(m.lifecycle)} | ${esc(m.accounting)}. Collateral: ${esc(m.collateral)} |\n`;
    }
    md += `\n### Product by action\n\n| Product | Action | Steps (test ids) | Engine | API | Browser | Notes |\n|---|---|---|---|---|---|---|\n`;
    for (const p of done) for (const r of p.rows) md += `| \`${p.id}\` | ${esc(r.action)} | ${r.steps.map((s) => `\`${s}\``).join(' ')} | ${levels.map((l) => rowCell(r[l])).join(' | ')} | ${esc(r.notes.join(' '))} |\n`;
    md += '\n';
  }
  if (todo.length) {
    md += `${done.length ? '### Not yet specified\n\n' : ''}| Product | Catalog support | Scenario | Engine | API | Browser |\n|---|---|---|---|---|---|\n`;
    for (const p of todo) md += `| ${esc(p.name)} (\`${p.id}\`) | ${SUPPORT[p.support] || p.support} | not yet specified | not run | not run | not run |\n`;
    md += '\n';
  }
}

md += `## Execution templates\n\n${S.templates.catalog} templates, ${S.templates.specified} specified. A template scenario is a spec with \`template: '<id>'\` in \`test/matrix/specs/templates.mjs\`; its test ids are \`E:T:<template>:<step>\` and so on.\n\n| Template | Group | Legs | Scenario | Engine | API | Browser |\n|---|---|---|---|---|---|---|\n`;
for (const t of data.templates) md += `| ${esc(t.name)} (\`${t.id}\`) | ${esc(t.group)} | ${esc(t.legs)} | ${t.specified ? esc(t.title) : 'not yet specified'} | ${levels.map((l) => (t.specified ? cell(t.levels[l]) : 'not run')).join(' | ')} |\n`;
const tplRows = data.templates.filter((t) => t.specified);
if (tplRows.length) {
  md += `\n### Template by action\n\n| Template | Action | Steps (test ids) | Engine | API | Browser | Notes |\n|---|---|---|---|---|---|---|\n`;
  for (const t of tplRows) for (const r of t.rows) md += `| \`${t.id}\` | ${esc(r.action)} | ${r.steps.map((s) => `\`${s}\``).join(' ')} | ${levels.map((l) => rowCell(r[l])).join(' | ')} | ${esc(r.notes.join(' '))} |\n`;
}

writeFileSync(new URL('../docs/TEST-MATRIX.md', import.meta.url), md);
writeFileSync(new URL('../docs/test-matrix.json', import.meta.url), `${JSON.stringify(data, null, 1)}\n`);
console.log(`docs/TEST-MATRIX.md and docs/test-matrix.json written: ${S.products.catalog} products (${S.products.specified} specified), ${S.templates.catalog} templates (${S.templates.specified} specified).`);
for (const l of levels) {
  const t = S.levels[l].products;
  console.log(`  ${LEVEL_NAMES[l].padEnd(8)} steps: passed ${t.passed}, failed ${t.failed}, blocked ${t.blocked}, unsupported ${t.unsupported}, not run ${t.notRun}. Scenarios complete: ${t.complete} of ${S.products.specified}.`);
}
