// Loads the product specs (test/matrix/specs/<family>.mjs) and checks that each one is complete
// enough to run and to appear in the matrix. A spec that fails these checks is a broken test, so the
// loader throws rather than skipping it.

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCTS, getProduct } from '../../../server/core/catalog.js';
import { TEMPLATES } from '../../../server/core/templates.js';

export const SPECS_DIR = resolve(fileURLToPath(new URL('../specs', import.meta.url)));
const STEP_ID = /^[a-z0-9][a-z0-9-]*$/;
const MATRIX_FIELDS = ['ticket', 'requiredFields', 'automaticInputs', 'manualInputs', 'settlement', 'lifecycle', 'accounting', 'collateral'];
const RESERVED_STEP_IDS = new Set(['setup', 'restart']);

export function validateSpec(spec, file) {
  const where = `${file}: ${spec?.productId || spec?.template || '(no productId)'}`;
  const bad = (msg) => { throw new Error(`Spec error in ${where}: ${msg}`); };
  if (spec.template) {
    if (!TEMPLATES.some((t) => t.id === spec.template)) bad(`"${spec.template}" is not an execution template.`);
  } else {
    const product = getProduct(spec.productId);
    if (!product) bad('productId is not in the catalog (server/core/catalog.js).');
    if (product.family !== spec.family) bad(`the catalog puts ${spec.productId} in family "${product.family}", but this file is for "${spec.family}".`);
  }
  if (!spec.title) bad('needs a title.');
  if (!spec.start || Number.isNaN(Date.parse(spec.start))) bad('needs `start`, the absolute instant the scenario begins at.');
  for (const f of MATRIX_FIELDS) if (spec.matrix?.[f] === undefined) bad(`matrix.${f} is missing. The matrix needs it for every product.`);
  const b = spec.book;
  if (!b?.name || !b.reportingCcy || !b.capital?.length || !b.account?.name || !b.account.funding) bad('book needs name, reportingCcy, capital and account { name, funding }.');
  const s = b.settings;
  if (!s?.fees || !s.fill || !s.settlement) bad('book.settings must state fees, fill and settlement explicitly, so expected figures come from the spec and not from defaults.');
  if (!spec.instruments || !Object.keys(spec.instruments).length) bad('needs at least one instrument.');
  for (const [key, d] of Object.entries(spec.instruments)) {
    if (!d.productId || !d.name || !d.marketView || !d.tradingCcy) bad(`instrument "${key}" needs productId, name, marketView and tradingCcy.`);
    if (!getProduct(d.productId)) bad(`instrument "${key}" has an unknown productId.`);
    if (s.fees[getProduct(d.productId).family] === undefined && !['loan', 'repo', 'secloan'].includes(getProduct(d.productId).family)) bad(`book.settings.fees does not state the fee schedule for the ${getProduct(d.productId).family} family (instrument "${key}").`);
  }
  // A product is tested with an instrument of exactly that product. Where no such instrument can exist (the contract
  // is entered on a ticket, or the product is a transaction rather than an instrument), the spec says so in `tradedOn`.
  if (!spec.template && !Object.values(spec.instruments).some((d) => d.productId === spec.productId) && !(typeof spec.tradedOn === 'string' && spec.tradedOn.length > 20)) bad(`no instrument is registered as ${spec.productId}. Register one, or state in \`tradedOn\` why this product has no registry instrument of its own.`);
  if (!Array.isArray(spec.steps) || !spec.steps.length) bad('needs steps.');
  const seen = new Set();
  for (const st of spec.steps) {
    if (!STEP_ID.test(st.id || '')) bad(`step id "${st.id}" must be lower-case letters, digits and dashes.`);
    if (RESERVED_STEP_IDS.has(st.id)) bad(`step id "${st.id}" is reserved for the runner.`);
    if (seen.has(st.id)) bad(`step id "${st.id}" is used twice.`);
    seen.add(st.id);
    if (!st.action) bad(`step "${st.id}" has no action.`);
    if (st.status !== undefined) {
      if (!['unsupported', 'blocked'].includes(st.status)) bad(`step "${st.id}": status can only be "unsupported" or "blocked".`);
      if (!st.reason) bad(`step "${st.id}" is ${st.status} and must give the reason.`);
      if (st.expect?.refused === undefined) bad(`step "${st.id}" is ${st.status} and must state expect.refused: what the Terminal says when it refuses.`);
    }
    if (st.covers !== undefined && ![].concat(st.covers).every((c) => typeof c === 'string' && c)) bad(`step "${st.id}": covers must be a matrix action name or a list of them.`);
  }
  return spec;
}

/** All specs, optionally filtered. Each carries `family` (from its file) and `file`. */
export async function loadSpecs({ family, product } = {}) {
  const out = [];
  const families = family ? String(family).split(',') : null;
  const products = product ? String(product).split(',') : null;
  const filtered = Boolean(families || products);
  for (const name of readdirSync(SPECS_DIR).filter((f) => f.endsWith('.mjs')).sort()) {
    // A run of everything is strict: a spec file that does not load, or a spec that is incomplete, is a broken
    // test and stops the run. A run filtered to some families or products only requires the specs it selects to
    // be sound, so one family being written does not stop another from being run.
    let mod;
    try { mod = await import(pathToFileURL(resolve(SPECS_DIR, name)).href); } catch (e) {
      if (!filtered) throw e;
      process.stderr.write(`[matrix] skipped ${name}: it does not load (${String(e.message).split('\n')[0]})\n`);
      continue;
    }
    if (!mod.family || !Array.isArray(mod.default)) {
      if (!filtered) throw new Error(`${name} must export \`family\` and a default array of specs.`);
      continue;
    }
    if (families && !families.includes(mod.family)) continue;
    for (const spec of mod.default) {
      if (products && !products.includes(spec.productId || `T:${spec.template}`)) continue;
      out.push(validateSpec({ ...spec, family: mod.family, file: name }, name));
    }
  }
  const ids = out.map((s) => s.productId || `T:${s.template}`);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new Error(`Two specs exist for ${dup}. One product, one scenario.`);
  return out;
}

export { PRODUCTS, TEMPLATES };
