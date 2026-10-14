// Analytics and risk tab of the instrument workspace: the completed outputs Analytics Lab supplies for this instrument
// and the investment Strategy chosen in the header (first Strategy: SP3E). For SP3E: EFS, Sector Score, Equity Score,
// Fundamental and Realistic Fair Value with their Gaps (and the reference price each gap was computed against),
// uncertainty, timing eligibility, outlier flags, sizing and Hedge outputs; with the run ID and version, calculation
// time, input-data cutoff, horizon and availability. The list of runs marks historical runs as historical; one is
// shown for research and never as a current recommendation. Nothing is computed here: every figure is the server's,
// and a value the server does not supply is shown as missing with its reason.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { fmtNum, fmtPriceUnits, fmtTime, isNum } from '../../lib/core.js';
import { Button, Empty, KV, Missing, Notice, Pill, Signed } from '../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../workspace.js';

const KNOWN = new Set(['strategyId', 'strategyName', 'runId', 'version', 'calculatedAt', 'inputCutoff', 'horizon', 'historical', 'current', 'availability', 'efs', 'sectorScore', 'equityScore',
  'fundamentalFairValue', 'realisticFairValue', 'fairValueCurrency', 'fairValueUnits', 'fundamentalGapPct', 'realisticGapPct', 'gapReference', 'uncertainty', 'timingEligibility', 'outlierFlags', 'sizing', 'hedge', 'instrumentId', 'ids', 'nulls']);
const num = (x) => fmtNum(x, Number.isInteger(x) ? 0 : 2);
const words = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

function AnalyticsTab({ inst, sel, asOf, strategy, intervalFor }) {
  const [runId, setRunId] = useState('');
  useEffect(() => setRunId(''), [strategy?.id, inst.id]);
  const sid = strategy?.id || '';
  const runs = useDataset(sel, 'analyticsRuns', { query: { strategyId: sid }, enabled: Boolean(sid), interval: intervalFor?.('analyticsRuns') });
  const out = useDataset(sel, 'analytics', { query: { strategyId: sid, runId: runId || undefined }, enabled: Boolean(sid), interval: intervalFor?.('analytics') });
  if (!sid) {
    return html`<div class="stack" data-ws-inst=${inst.id} data-testid="an-tab"><${Notice}><b>Choose an investment Strategy in the header.</b> Analytics are asked for that Strategy's ID only and never blended across Strategies.<//></div>`;
  }
  const runList = runs.env?.items || [];
  const current = runList.find((r) => r.current) || null;
  return html`<div class="stack" data-ws-inst=${inst.id} data-testid="an-tab">
    <p class="note" style="margin:0">Completed outputs supplied by Analytics Lab for ${strategy.name || sid} (${sid}). The Terminal computes none of them; a figure the server does not supply is shown as missing.</p>
    ${asOf ? html`<${Notice} tone="warn">Research date ${asOf}: the outputs shown are the runs available then. They are historical and are not current recommendations.<//>` : null}
    <${DatasetPanel} ds=${out} asOf=${asOf} title=${`Outputs of ${strategy.name || sid}`} what=${`Completed outputs of ${strategy.name || sid} for ${inst.symbol || inst.name} from Shaffer Analytics Lab`}>
      ${(env) => html`<${Outputs} env=${env} inst=${inst} strategy=${strategy} current=${current} asOf=${asOf} />`}<//>
    <${DatasetPanel} ds=${runs} asOf=${asOf} title="Runs" note="Each completed run of this Strategy for this instrument" flush>
      ${(env) => html`<${Runs} items=${env.items || []} shown=${out.env?.data?.runId || runId} onShow=${setRunId} />`}<//>
  </div>`;
}

function Runs({ items, shown, onShow }) {
  if (!items.length) return html`<${Empty} title="No runs listed">The server lists no completed run of this Strategy for this instrument.<//>`;
  return html`<div class="tablewrap"><table class="ledger ca-table" data-testid="an-runs"><thead><tr><th>Run</th><th>Version</th><th>Calculated</th><th>Input data cutoff</th><th>Horizon</th><th>Standing</th><th></th></tr></thead>
    <tbody>${items.map((r) => html`<tr key=${r.runId} class=${r.runId === shown ? 'an-sel' : ''} data-run=${r.runId} data-historical=${r.historical ? '1' : '0'}>
      <td class="mono" data-label="Run">${r.runId}</td><td data-label="Version">${r.version || html`<${Missing} reason="Not supplied" />`}</td>
      <td data-label="Calculated">${r.calculatedAt ? fmtTime(r.calculatedAt) : html`<${Missing} reason="Not supplied" />`}</td>
      <td data-label="Input data cutoff">${r.inputCutoff ? fmtTime(r.inputCutoff) : html`<${Missing} reason="Not supplied" />`}</td>
      <td data-label="Horizon">${r.horizon || html`<${Missing} reason="Not supplied" />`}</td>
      <td data-label="Standing">${r.historical ? html`<${Pill} tone="warn" title="An earlier run: for research, not a current recommendation">historical<//>` : r.current ? html`<${Pill} tone="ok">current<//>` : html`<${Pill}>standing not stated<//>`}</td>
      <td class="r">${r.runId === shown ? html`<span class="small muted">Shown above</span>` : html`<${Button} small onClick=${() => onShow(r.runId)}>Show this run<//>`}</td></tr>`)}</tbody></table></div>`;
}

function Outputs({ env, inst, strategy, current, asOf }) {
  const a = env.data;
  if (!a) return html`<${Empty} title=${`${strategy.name || strategy.id} has no outputs for ${inst.symbol || inst.name}`}>${env.message || 'The server supplied no completed output.'}<//>`;
  const nulls = env.nulls || a.nulls || {};
  const miss = (k, fallback = 'Not supplied by Analytics Lab') => html`<${Missing} reason=${nulls[k] || fallback} />`;
  const val = (k, f = num) => (isNum(a[k]) ? f(a[k]) : miss(k));
  const ccy = a.fairValueCurrency, units = a.fairValueUnits;
  const fv = (k) => (isNum(a[k]) ? html`${fmtPriceUnits(a[k], units || '')} <span class="muted small">${ccy || ''}</span>` : miss(k));
  const ref = a.gapReference;
  const refText = ref && isNum(ref.price) ? `against the reference price ${fmtPriceUnits(ref.price, ref.units || units || '')} ${ref.currency || ccy || ''} at calculation time, not the current market price` : 'reference price not supplied: the gap is shown as the server states it';
  const gap = (k) => (isNum(a[k]) ? html`<${Signed} value=${a[k]} suffix="%" />` : miss(k, 'No Gap % supplied for this basis'));
  const u = a.uncertainty;
  const range = (r) => (r && isNum(r.low) && isNum(r.high) ? `${fmtPriceUnits(r.low, units || '')} to ${fmtPriceUnits(r.high, units || '')}` : null);
  const te = a.timingEligibility;
  const sz = a.sizing, hg = a.hedge;
  const flags = Array.isArray(a.outlierFlags) ? a.outlierFlags : null;
  const historical = Boolean(a.historical) || (current && a.runId && current.runId !== a.runId);
  const cell = (k, v, s, attr) => html`<div class="an-cell" data-an=${attr || ''}><span class="k">${k}</span><span class="v">${v}</span>${s ? html`<span class="s">${s}</span>` : null}</div>`;
  const extra = Object.entries(a).filter(([k, v]) => !KNOWN.has(k) && (v === null || typeof v !== 'object'));
  return html`<div class="stack" data-run=${a.runId || ''} data-historical=${historical ? '1' : '0'}>
    ${historical ? html`<div class="an-hist" data-testid="an-historical"><b>Historical run${a.calculatedAt ? `, calculated ${fmtTime(a.calculatedAt)}` : ''}.</b> Shown for research only: it is not a current recommendation and is not used for trading.${current && current.runId !== a.runId ? ` The current run is ${current.runId}.` : asOf ? ` Runs after ${asOf} are not shown.` : ''}</div>`
      : html`<div class="small"><${Pill} tone="ok">current run<//> The latest completed run the server reports for this Strategy.</div>`}
    <${KV} rows=${[
      ['Strategy', html`${a.strategyName || strategy.name || ''} <span class="mono">${a.strategyId || strategy.id}</span>`],
      ['Run and version', html`<span class="mono">${a.runId || '—'}</span>, version ${a.version || env.version || html`<${Missing} reason="Not supplied" />`}`],
      ['Calculated', a.calculatedAt ? html`<span title=${a.calculatedAt}>${fmtTime(a.calculatedAt)}</span>` : miss('calculatedAt')],
      ['Input data cutoff', a.inputCutoff ? html`<span title=${a.inputCutoff}>${fmtTime(a.inputCutoff)}</span>` : miss('inputCutoff')],
      ['Horizon', a.horizon || miss('horizon')],
      ['Availability', a.availability ? words(a.availability) : env.state === 'incomplete' ? `Incomplete: ${(env.missingFields || []).join(', ')}` : miss('availability', 'Not stated')],
    ]} />
    <div class="an-grid" data-testid="an-grid">
      ${cell('EFS', val('efs'), null, 'efs')}${cell('Sector Score', val('sectorScore'), null, 'sectorScore')}${cell('Equity Score', val('equityScore'), null, 'equityScore')}
      ${cell('Fundamental Fair Value', fv('fundamentalFairValue'), range(u?.fundamental) ? `uncertainty ${range(u.fundamental)}` : null, 'fundamentalFairValue')}
      ${cell('Fundamental Gap %', gap('fundamentalGapPct'), isNum(a.fundamentalGapPct) ? refText : null, 'fundamentalGapPct')}
      ${cell('Realistic Fair Value', fv('realisticFairValue'), range(u?.realistic) ? `uncertainty ${range(u.realistic)}` : null, 'realisticFairValue')}
      ${cell('Realistic Gap %', gap('realisticGapPct'), isNum(a.realisticGapPct) ? refText : null, 'realisticGapPct')}
      ${cell('Uncertainty', u ? (isNum(u.confidence) ? `confidence ${fmtNum(u.confidence * (u.confidence <= 1 ? 100 : 1), 0)}%` : 'ranges only') : miss('uncertainty'), u && !range(u.realistic) && !range(u.fundamental) ? 'no ranges supplied' : u && !range(u.realistic) ? 'no Realistic range supplied' : null, 'uncertainty')}
      ${cell('Timing eligibility', te ? (te.eligible === true ? 'Eligible' : te.eligible === false ? 'Not eligible' : html`<${Missing} reason="Not stated" />`) : miss('timingEligibility'), te?.reason || null, 'timingEligibility')}
      ${cell('Outlier flags', flags ? (flags.length ? flags.map((f) => words(f)).join(', ') : 'None flagged') : miss('outlierFlags'), null, 'outlierFlags')}
      ${cell('Sizing', sz && isNum(sz.suggestedWeightPct) ? `${num(sz.suggestedWeightPct)}% suggested` : miss('sizing'), sz ? [isNum(sz.maxWeightPct) ? `maximum ${num(sz.maxWeightPct)}%` : null, sz.basis ? `of ${sz.basis}` : null].filter(Boolean).join(' ') : null, 'sizing')}
      ${cell('Hedge', hg ? (hg.recommended === true ? 'Hedge recommended' : hg.recommended === false ? 'No hedge recommended' : html`<${Missing} reason="Not stated" />`) : miss('hedge'), hg ? [hg.objective ? `objective ${hg.objective}` : null, hg.note].filter(Boolean).join('. ') : null, 'hedge')}
    </div>
    ${extra.length ? html`<div><h4 style="margin:4px 0">Other fields supplied</h4><${KV} rows=${extra.map(([k, v]) => [words(k), v === null ? miss(k) : typeof v === 'number' ? num(v) : String(v)])} /></div>` : null}
    <p class="note" style="margin:0">Fair values are in ${ccy || 'an unstated currency'}, ${units || 'unstated units'}. They are valuations, never executable quotes. A hedge output is information: a hedge is asked for and confirmed through the Hedge action, never executed from here.</p>
  </div>`;
}

registerTabContent('analytics', (p) => html`<${AnalyticsTab} ...${p} />`);
export { AnalyticsTab };
