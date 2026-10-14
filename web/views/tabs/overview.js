// Overview tab of the instrument-detail workspace for equities and issuer-linked securities: the company and issuer
// (business description, sector classifications, country, size) kept apart from this listing (exchange, symbol,
// market capitalization, shares outstanding, identifiers and quotation), financial highlights, next earnings and the
// chosen Strategy's server analytics. Every figure carries its units, its as-of date and its source; a field the server
// did not supply is named with the reason, never left blank or shown as zero. With a research date, only what the
// server can answer as of that date is shown; current information is offered separately and marked as current.
import { html, useState } from '../../vendor/preact-htm.js';
import { fmtNum, fmtPriceUnits, fmtQty, fmtTime, isNum } from '../../lib/core.js';
import { Button, Missing, Notice, Pill, Signed } from '../../lib/ui.js';
import { DATASETS } from '../workspace-model.js';
import { DatasetPanel, pageHref, registerTabContent, Related, TermsPanel, useDataset } from '../workspace.js';
import { profileRows, words } from './tabs-model.js';

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const compact = (v) => (Math.abs(v) >= 1e12 ? `${fmtNum(v / 1e12, 2)} tn` : Math.abs(v) >= 1e9 ? `${fmtNum(v / 1e9, 2)} bn` : Math.abs(v) >= 1e6 ? `${fmtNum(v / 1e6, 1)} m` : null);
const srcOf = (env) => env?.source?.label || (typeof env?.source === 'string' ? env.source : null);
// One dataset drawn in several panels: each panel gets its own data-ws-dataset name (profile.listing, ...).
const part = (ds, name) => ({ ...ds, key: `profile.${name}` });
const tabHref = (id, tab, asOf) => `${pageHref(id, tab)}${asOf ? `/asof/${asOf}` : ''}`;

/** A value by its kind; a missing one says so in words. */
function Value({ r }) {
  const v = r.value;
  if (v === null || v === undefined || v === '') return html`<span class="e1-miss" data-missing=${r.key}><${Missing} reason=${r.why} /> ${/^not supplied/i.test(r.why || '') ? r.why : `Not supplied: ${r.why}`}</span>`;
  if (r.kind === 'classifications') return html`${v.map((c, i) => html`${i ? html`<br />` : ''}${c.label}${c.code ? html` <span class="muted small">${c.code}${isNum(c.level) ? `, level ${c.level}` : ''}${c.scheme ? `, ${c.scheme}` : ''}</span>` : ''}`)}`;
  if (r.kind === 'id') return html`<span class="mono">${v}</span>`;
  if (r.kind === 'money' || r.kind === 'count') return html`${fmtQty(v)}${compact(v) ? html` <span class="muted small">(${compact(v)})</span>` : ''}${r.note ? html`<div class="sub">${r.note}</div>` : ''}`;
  if (isNum(v)) return fmtNum(v, Number.isInteger(v) ? 0 : 2);
  return String(v);
}
/** Field, value, units, as of and source, one row per field. */
function FieldTable({ rows, env, testid }) {
  const src = srcOf(env);
  return html`<div class="tablewrap"><table class="ledger tight e1-fields" data-testid=${testid}>
    <thead><tr><th>Field</th><th>Value</th><th>Units</th><th>As of, source</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr data-field=${r.key}><td>${r.label}</td><td class="e1-v">${html`<${Value} r=${r} />`}</td>
      <td>${r.units || html`<span class="muted small">${r.kind === 'number' && r.value !== null ? 'not stated' : ''}</span>`}</td>
      <td class="small" title=${r.asOf ? `As of ${r.asOf}` : ''}>${r.src === 'terminal' ? 'Terminal registry' : html`${day(r.asOf) || html`<${Missing} reason="No date supplied" />`}, ${src || 'source not stated'}`}</td></tr>`)}</tbody>
  </table></div>`;
}

function OverviewTab({ inst, detail, sel, asOf, strategy, intervalFor, reference: headRef, related }) {
  const [showCurrent, setShowCurrent] = useState(false);
  const pit = useDataset(sel, 'profile', { interval: intervalFor?.('profile') });
  // Current profile in an as-of view only on request, and marked as current (never in place of the dated answer).
  const unsupported = Boolean(asOf) && pit.env?.pointInTime?.supported === false;
  const cur = useDataset(sel, 'profileCurrent', { path: DATASETS.profile.path(sel.id), asOf: false, enabled: unsupported && showCurrent, interval: intervalFor?.('profile') });
  const usingCurrent = unsupported && showCurrent;
  const prof = usingCurrent ? { ...cur, key: 'profile', label: 'Company and listing profile' } : pit;
  const panelAsOf = usingCurrent ? '' : asOf;
  const ref = useDataset(sel, 'reference', { asOf: false });
  const analytics = useDataset(sel, 'analytics', { query: { strategyId: strategy?.id || '' }, enabled: Boolean(strategy?.id), interval: intervalFor?.('analytics') });
  const env = prof.env;
  const rows = profileRows(env?.data, { nulls: env?.nulls || {}, asOf: env?.asOf || null });
  const issuerName = env?.data?.issuer?.name || inst.issuer || 'the issuer';
  const lst = env?.data?.listing;
  const swap = unsupported ? html`<${Button} small onClick=${() => setShowCurrent(!showCurrent)} title="The server contract has no point-in-time profile">${showCurrent ? 'Hide current information' : 'Show current information'}<//>` : null;
  return html`<div class="stack" data-testid="overview-tab">
    <p class="note e1-scope">Company and issuer information belongs to ${issuerName}, whichever of its securities is held. Listing information belongs to ${inst.symbol || inst.name}${lst?.exchange ? ` on ${lst.exchange}` : inst.venue ? ` on ${inst.venue}` : ''} only.</p>
    ${usingCurrent ? html`<div data-testid="overview-current"><${Notice} tone="warn"><b>Current information, not as of ${asOf}.</b> The server contract has no point-in-time company profile, so these panels show what is known now${env?.asOf ? ` (server as of ${day(env.asOf)})` : ''}. Later revisions are included.<//></div>` : null}
    <div class="ws-cols">
      <${DatasetPanel} ds=${prof} title="Company and issuer" note="The issuer's own information" asOf=${panelAsOf} actions=${swap} what="Business description, sector classifications and company facts from Shaffer MarketData">
        ${(e) => html`<div data-testid="overview-issuer">${e.data?.issuer?.description ? html`<p class="e1-desc">${e.data.issuer.description}</p>` : html`<p class="e1-desc e1-miss" data-missing="issuer.description"><${Missing} reason="Not supplied" /> Business description not supplied: ${e.nulls?.['issuer.description'] || 'the server sent none'}.</p>`}
          <${FieldTable} rows=${rows.issuer} env=${e} testid="issuer-fields" /></div>`}<//>
      <div class="stack">
        <${DatasetPanel} ds=${part(prof, 'nextEarnings')} title="Next earnings" asOf=${panelAsOf} what="The next earnings date from Shaffer MarketData">
          ${(e) => { const n = e.data?.nextEarnings; return html`<div data-testid="overview-next-earnings">${n?.date ? html`<div class="e1-elig"><span class="v">${n.date}</span>${n.dateStatus ? html`<${Pill} tone=${n.dateStatus === 'confirmed' ? 'ok' : 'warn'}>${n.dateStatus}<//>` : html`<span class="muted small">confirmation not stated</span>`}</div>`
            : html`<p class="e1-miss" style="margin:0"><${Missing} reason="Not supplied" /> Next earnings date not supplied: ${e.nulls?.nextEarnings || 'the server sent none for this issuer'}.</p>`}
            <p class="small" style="margin:0">As of ${day(e.asOf) || 'an unstated date'}, ${srcOf(e) || 'source not stated'}. Results, consensus and release documents are on the <a href=${tabHref(inst.id, 'earnings', asOf)}>Earnings</a> tab.</p></div>`; }}<//>
        <${AnalyticsSummary} ds=${analytics} strategy=${strategy} inst=${inst} asOf=${asOf} />
      </div>
    </div>
    <div class="cols-2 e1-cols">
      <${DatasetPanel} ds=${part(prof, 'listing')} title="This listing" note=${`${inst.symbol || inst.name}, not the issuer`} asOf=${panelAsOf} what="Exchange, symbol, market capitalization and shares outstanding from Shaffer MarketData">
        ${(e) => html`<div data-testid="overview-listing">${e.data?.listing ? html`<${FieldTable} rows=${rows.listing} env=${e} testid="listing-fields" />`
          : html`<p class="e1-miss" style="margin:0" data-missing="listing"><${Missing} reason="Not supplied" /> No listing record: ${e.nulls?.listing || 'the server supplied none for this issuer'}. Exchange, market capitalization and shares outstanding are therefore not shown.</p>`}</div>`}<//>
      <${DatasetPanel} ds=${part(prof, 'highlights')} title="Financial highlights" note="As supplied by the server" asOf=${panelAsOf} what="Financial highlights from Shaffer MarketData">
        ${(e) => html`<div data-testid="overview-highlights">${rows.highlights.length ? html`<${FieldTable} rows=${rows.highlights} env=${e} testid="highlight-fields" />`
          : html`<p class="e1-miss" style="margin:0" data-missing="highlights"><${Missing} reason="Not supplied" /> No financial highlights supplied${e.nulls?.highlights ? `: ${e.nulls.highlights}` : ''}.</p>`}
          <p class="note" style="margin:8px 0 0">The full statements are on the <a href=${tabHref(inst.id, 'statements', asOf)}>Financial statements</a> tab. Nothing here is worked out by the Terminal.</p></div>`}<//>
    </div>
    <div class="ws-cols">
      <${DatasetPanel} ds=${ref} title="Identifiers and quotation" note="This listing, current reference record" asOf=${asOf} what="Stable server, issuer and contract IDs, quote convention and units from Shaffer MarketData">
        ${(e) => { const d = e.data || {}; const r = (key, label, value, kind = 'text', units = null) => ({ key: `reference.${key}`, label, value: value ?? null, kind, units, asOf: e.asOf, why: e.nulls?.[key] || 'Not in the reference record.' });
          return html`<${FieldTable} testid="reference-fields" env=${e} rows=${[{ ...r('terminal', 'Terminal ID', inst.id, 'id'), src: 'terminal' }, r('server', 'Server instrument ID', d.ids?.server, 'id'), r('issuer', 'Issuer ID', d.ids?.issuer, 'id'),
            r('venue', 'Venue', d.venue), r('currency', 'Quotation currency', d.currency), r('quoteConvention', 'Quote convention', d.quoteConvention), r('multiplier', 'Multiplier', d.multiplier, 'number', 'shares per unit')]} />`; }}<//>
      <div class="stack"><${Related} inst=${inst} related=${related} reference=${headRef || ref} /><${TermsPanel} inst=${inst} detail=${detail} /></div>
    </div>
  </div>`;
}

/** The chosen Strategy's completed server outputs, summarised; the Analytics and risk tab has the rest. */
function AnalyticsSummary({ ds, strategy, inst, asOf }) {
  if (!strategy?.id) return html`<section class="panel" data-testid="overview-analytics"><header><h3>Server analytics</h3></header><div class="body"><p class="note" style="margin:0">Choose an investment Strategy in the header to see its server analytics for ${inst.symbol || inst.name}. Outputs are asked for one Strategy at a time and never blended.</p></div></section>`;
  return html`<${DatasetPanel} ds=${ds} title=${`Analytics, ${strategy.name || strategy.id}`} asOf=${asOf} what=${`Completed ${strategy.name || strategy.id} outputs from Shaffer Analytics Lab`}>
    ${(e) => {
      const a = e.data || {};
      const nul = (k) => e.nulls?.[k] || 'Not supplied by Analytics Lab.';
      const px = (v, k) => (isNum(v) ? html`${fmtPriceUnits(v, a.fairValueUnits)} <span class="muted small">${a.fairValueCurrency || 'currency not stated'}, ${a.fairValueUnits || 'units not stated'}</span>` : html`<span class="e1-miss"><${Missing} reason=${nul(k)} /> ${nul(k)}</span>`);
      const gp = (v, k) => (isNum(v) ? html`<${Signed} value=${v} suffix="%" /> <span class="muted small">as supplied${a.gapReference && isNum(a.gapReference.price) ? `, against ${fmtPriceUnits(a.gapReference.price, a.gapReference.units)} at calculation time` : ''}</span>` : html`<span class="e1-miss"><${Missing} reason=${nul(k)} /> ${nul(k)}</span>`);
      const sc = (v, k) => (isNum(v) ? fmtNum(v, Number.isInteger(v) ? 0 : 2) : html`<span class="e1-miss"><${Missing} reason=${nul(k)} /> ${nul(k)}</span>`);
      const hist = a.historical || Boolean(asOf);
      return html`<div class="stack" data-testid="overview-analytics">
        ${hist ? html`<${Notice} tone="warn">Historical run${a.calculatedAt ? ` of ${fmtTime(a.calculatedAt)}` : ''}: shown for research, not a current recommendation.<//>` : null}
        <dl class="kv">
          <dt>Run</dt><dd>${a.runId || html`<${Missing} reason="Not supplied" />`}${a.version ? html` <span class="muted small">version ${a.version}</span>` : ''}</dd>
          <dt>Calculated</dt><dd>${a.calculatedAt ? fmtTime(a.calculatedAt) : html`<${Missing} reason="Not supplied" />`}</dd>
          <dt>Input-data cutoff</dt><dd>${a.inputCutoff ? fmtTime(a.inputCutoff) : html`<${Missing} reason="Not supplied" />`}</dd>
          <dt>Horizon</dt><dd>${a.horizon || html`<${Missing} reason="Not supplied" />`}</dd>
          <dt>Fundamental fair value</dt><dd>${px(a.fundamentalFairValue, 'fundamentalFairValue')}</dd>
          <dt>Fundamental gap</dt><dd>${gp(a.fundamentalGapPct, 'fundamentalGapPct')}</dd>
          <dt>Realistic fair value</dt><dd>${px(a.realisticFairValue, 'realisticFairValue')}</dd>
          <dt>Realistic gap</dt><dd>${gp(a.realisticGapPct, 'realisticGapPct')}</dd>
          <dt>EFS</dt><dd>${sc(a.efs, 'efs')}</dd><dt>Sector Score</dt><dd>${sc(a.sectorScore, 'sectorScore')}</dd><dt>Equity Score</dt><dd>${sc(a.equityScore, 'equityScore')}</dd>
          <dt>Timing eligibility</dt><dd>${a.timingEligibility ? html`${a.timingEligibility.eligible === true ? 'Eligible' : a.timingEligibility.eligible === false ? 'Not eligible' : 'Not stated'}${a.timingEligibility.reason ? html` <span class="muted small">${a.timingEligibility.reason}</span>` : ''}` : html`<span class="e1-miss"><${Missing} reason=${nul('timingEligibility')} /> ${nul('timingEligibility')}</span>`}</dd>
          <dt>Outlier flags</dt><dd>${Array.isArray(a.outlierFlags) ? (a.outlierFlags.length ? a.outlierFlags.map(words).join(', ') : 'None') : html`<${Missing} reason=${nul('outlierFlags')} />`}</dd>
        </dl>
        <p class="note" style="margin:0">Completed Analytics Lab outputs, passed through as supplied: the Terminal works out none of them. Sizing, uncertainty and Hedge outputs are on the <a href=${tabHref(inst.id, 'analytics', asOf)}>Analytics and risk</a> tab.</p></div>`;
    }}<//>`;
}

registerTabContent('overview', OverviewTab);
