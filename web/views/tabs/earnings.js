// Earnings tab of the instrument-detail workspace: the server's earnings calendar facts (upcoming and past releases,
// fiscal period, release date and time, confirmed or estimated, the actual reporting timestamp, revision status) with
// the reported results against consensus and the prior value, and the surprise, for every metric supplied (revenue,
// EPS and any other), plus the release documents through the Terminal's document proxy. Analytics Lab's earnings-window
// eligibility is a separate panel with its run and input cutoff: an analytical assessment, never mixed with the facts.
// EPS is company information here: showing it does not change SP3E's inputs.
import { html } from '../../vendor/preact-htm.js';
import { fmtNum, fmtPriceUnits, fmtTime, isNum } from '../../lib/core.js';
import { Missing, Notice, Pill, Signed } from '../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../workspace.js';
import { changeVsPrior, splitEarnings, surpriseOf } from './tabs-model.js';

export const EPS_SENTENCE = 'EPS is shown as company information; displaying it does not change SP3E\'s inputs.';
const KIND_LABEL = { release: 'Earnings release', presentation: 'Presentation', transcript: 'Transcript', report: 'Report' };
const isEps = (m) => /eps|per share/i.test(`${m.key} ${m.label} ${m.units}`);
const perShare = (m) => /per share/i.test(m.units || '') || isEps(m);
/** A metric value in its own units: per-share values to cents, amounts as supplied. */
const val = (m, v) => (isNum(v) ? (perShare(m) ? fmtPriceUnits(v) : fmtNum(v, Number.isInteger(v) ? 0 : 1)) : null);
const miss = (reason) => html`<${Missing} reason=${reason} />`;
const unitsOf = (m) => [m.units, m.currency && !String(m.units || '').includes(m.currency) ? m.currency : null].filter(Boolean).join(', ') || 'units not stated';
const docHref = (id) => `/api/server/documents/${encodeURIComponent(id)}`;

function DateStatus({ s }) {
  if (s === 'confirmed') return html`<${Pill} tone="ok" title="The company has confirmed this date">confirmed<//>`;
  if (s === 'estimated') return html`<${Pill} tone="warn" title="An estimate, not confirmed by the company">estimated<//>`;
  return html`<span class="muted small">confirmation not stated</span>`;
}
function Docs({ docs }) {
  if (!docs?.length) return html`<span class="muted small">none supplied</span>`;
  return html`<span class="e1-docs">${docs.map((d) => html`<a href=${docHref(d.id)} target="_blank" rel="noopener" title=${`Opens through the Terminal's document proxy (${d.id})`}>${d.title || KIND_LABEL[d.kind] || d.kind || 'Document'}</a>`)}</span>`;
}
function Revision({ e }) {
  if (e.revision === 'revised') return html`<${Pill} tone="warn">revised<//>${e.revisedAt ? html` <span class="small">${fmtTime(e.revisedAt)}</span>` : ''}${e.revisionNote ? html` <span class="muted">(${e.revisionNote})</span>` : ''}`;
  if (e.revision === 'original') return html`<span class="small">original</span>`;
  return html`<span class="muted small">not stated</span>`;
}

function EarningsTab({ inst, sel, asOf, strategy, intervalFor }) {
  const earnings = useDataset(sel, 'earnings', { interval: intervalFor?.('earnings') });
  const windowDs = useDataset(sel, 'earningsWindow', { query: strategy?.id ? { strategyId: strategy.id } : {}, interval: intervalFor?.('earningsWindow') });
  const runs = useDataset(sel, 'analyticsRuns', { query: strategy?.id ? { strategyId: strategy.id } : {}, asOf: false });
  return html`<div class="stack" data-testid="earnings-tab">
    <${DatasetPanel} ds=${earnings} title="Earnings calendar and results" note="Company information from Shaffer MarketData" asOf=${asOf} what="Earnings dates, reported results, consensus and release documents from Shaffer MarketData">
      ${(env) => html`<${EarningsBody} env=${env} inst=${inst} />`}<//>
    <${DatasetPanel} ds=${windowDs} title="Earnings-window eligibility" note="Analytics Lab assessment, apart from the calendar facts" asOf=${asOf} what="Earnings-window eligibility from Shaffer Analytics Lab">
      ${(env) => html`<${WindowBody} env=${env} runs=${runs} asOf=${asOf} />`}<//>
  </div>`;
}

function EarningsBody({ env, inst }) {
  const { upcoming, past } = splitEarnings(env.items || []);
  if (!upcoming.length && !past.length) return html`<p class="note" style="margin:0">The server answered with no earnings releases for ${inst.symbol || inst.name}.</p>`;
  const nulls = (e, k) => e.nulls?.[k] || env.nulls?.[k];
  return html`<div class="stack">
    <div data-testid="earnings-upcoming"><h4 class="e1-h4">Upcoming</h4>
      ${upcoming.length ? html`<div class="tablewrap"><table class="ledger tight">
        <thead><tr><th>Fiscal period</th><th>Period end</th><th>Release</th><th>Date</th><th>Consensus</th></tr></thead>
        <tbody>${upcoming.map((e) => html`<tr data-period=${e.fiscalPeriod}><td><b>${e.fiscalPeriod || miss('Not supplied')}</b></td><td>${e.periodEnd || miss('Not supplied')}</td>
          <td>${e.releaseAt ? fmtTime(e.releaseAt) : miss('No release date supplied')}</td><td><${DateStatus} s=${e.dateStatus} /></td>
          <td class="wrap">${(e.metrics || []).map((m, i) => html`${i ? html`<br />` : ''}${m.label}: ${isNum(m.consensus) ? html`${val(m, m.consensus)} <span class="muted small">${unitsOf(m)}</span>` : html`${miss(nulls(e, 'consensus') || 'Not supplied')} <span class="muted small">${nulls(e, 'consensus') || 'not supplied'}</span>`}`)}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="note" style="margin:0">No upcoming release supplied by the server.</p>`}</div>
    <div data-testid="earnings-past"><h4 class="e1-h4">Reported</h4>
      ${past.length ? html`<div class="tablewrap"><table class="ledger tight e1-earn">
        <thead><tr><th>Metric</th><th class="r">Reported</th><th class="r">Consensus</th><th class="r">Prior</th><th class="r" title="(reported − prior) ÷ |prior|, worked out here">Change vs prior</th><th class="r">Surprise</th><th class="r">Surprise %</th><th>Units</th></tr></thead>
        <tbody>${past.map((e) => html`<tr class="group e1-grouprow" data-period=${e.fiscalPeriod}><td colspan="8">
            <b>${e.fiscalPeriod || 'Fiscal period not supplied'}</b>${e.periodEnd ? html` <span class="muted">period ended ${e.periodEnd}</span>` : ''}
            <span class="e1-gfacts">Release ${e.releaseAt ? fmtTime(e.releaseAt) : miss('Not supplied')} <${DateStatus} s=${e.dateStatus} />. Reported ${e.reportedAt ? fmtTime(e.reportedAt, { seconds: true }) : html`${miss('No reporting timestamp supplied')} <span class="muted">no reporting timestamp supplied</span>`}. Revision: <${Revision} e=${e} />. Documents: <${Docs} docs=${e.documents} /></span></td></tr>
          ${(e.metrics || []).map((m) => { const s = surpriseOf(m); const c = changeVsPrior(m); return html`<tr data-metric=${m.key}>
            <td>${m.label || m.key}${isEps(m) ? html` <span class="muted small" title=${EPS_SENTENCE}>company information</span>` : ''}</td>
            <td class="r">${val(m, m.reported) ?? miss('Not reported')}</td><td class="r">${val(m, m.consensus) ?? miss(nulls(e, 'consensus') || 'No consensus supplied')}</td><td class="r">${val(m, m.prior) ?? miss('No prior value supplied')}</td>
            <td class="r">${isNum(c.pct) ? html`<span title="(reported − prior) ÷ |prior| × 100, worked out here"><${Signed} value=${c.pct} suffix="%" /><sup class="muted">c</sup></span>` : miss(c.why)}</td>
            <td class="r">${isNum(s.value) ? html`<span title=${s.basis === 'supplied' ? 'As supplied by the server' : 'Reported − consensus, worked out here'}><${Signed} value=${s.value} dp=${perShare(m) ? 2 : 1} />${s.basis === 'computed' ? html`<sup class="muted">c</sup>` : ''}</span>` : miss(s.why || 'Not supplied')}</td>
            <td class="r">${isNum(s.pct) ? html`<span title=${s.basis === 'supplied' ? 'As supplied by the server' : 'Surprise ÷ |consensus| × 100, worked out here'}><${Signed} value=${s.pct} suffix="%" />${s.basis === 'computed' ? html`<sup class="muted">c</sup>` : ''}</span>` : miss(s.why || 'Not supplied')}</td>
            <td class="small">${unitsOf(m)}</td></tr>`; })}`)}</tbody>
      </table></div>` : html`<p class="note" style="margin:0">No reported release supplied by the server${env.pointInTime?.requested ? ' up to the research date' : ''}.</p>`}</div>
    <p class="note" style="margin:0" data-testid="eps-note">${EPS_SENTENCE} Reported, consensus, prior and surprise figures are as supplied by the server${env.source?.label ? ` (${env.source.label})` : ''}; "Change vs prior" and any figure marked <sup>c</sup> is worked out here from the values shown, in the same units. Times are Eastern. Documents open through the Terminal's document proxy, never from the source directly.</p>
    ${env.pagination?.nextCursor || env.pagination?.totalPages > 1 ? html`<p class="note" style="margin:0">More releases are available on the server (${env.pagination.totalItems ?? 'more'} in all).</p>` : null}
  </div>`;
}

/** Analytics Lab's earnings-window eligibility, with the run it came from and that run's input cutoff. */
function WindowBody({ env, runs, asOf }) {
  const d = env.data || {};
  const run = (runs.env?.items || []).find((r) => r.runId && r.runId === d.runId) || null;
  const cutoff = d.inputCutoff || run?.inputCutoff || null;
  const nul = (k) => env.nulls?.[k] || 'Not supplied by Analytics Lab.';
  return html`<div class="stack" data-testid="earnings-window">
    <div class="e1-elig"><span class="ws-lbl">Eligibility</span>
      <span class="v">${d.eligible === true ? 'Eligible' : d.eligible === false ? 'Not eligible' : html`${miss(nul('eligible'))} <span class="small muted">${nul('eligible')}</span>`}</span>
      ${d.reason ? html`<span class="small">${d.reason}</span>` : null}</div>
    <dl class="kv">
      <dt>Earnings window</dt><dd>${d.window?.from || d.window?.to ? `${d.window.from || '?'} to ${d.window.to || '?'}` : html`${miss(nul('window'))} ${nul('window')}`}</dd>
      <dt>Basis</dt><dd>${d.basis || html`${miss(nul('basis'))} <span class="muted">${nul('basis')}</span>`}</dd>
      <dt>Run</dt><dd>${d.runId || html`${miss(nul('runId'))} ${nul('runId')}`}${run?.version ? html` <span class="muted small">version ${run.version}</span>` : ''}${run ? html` ${run.current ? html`<${Pill} tone="ok">current run<//>` : html`<${Pill} tone="warn">historical run<//>`}` : ''}</dd>
      <dt>Calculated</dt><dd>${d.calculatedAt ? fmtTime(d.calculatedAt) : html`${miss(nul('calculatedAt'))} ${nul('calculatedAt')}`}</dd>
      <dt>Input-data cutoff</dt><dd>${cutoff ? html`${fmtTime(cutoff)}${!d.inputCutoff ? html` <span class="muted small">from the runs list for ${d.runId}</span>` : ''}` : html`${miss('Not supplied')} <span class="muted">${runs.state === 'loading' ? 'Looking up the run' : 'Not supplied with the eligibility, and the run is not in the runs list'}</span>`}</dd>
    </dl>
    ${asOf || run?.current === false ? html`<${Notice} tone="warn">An assessment from ${d.calculatedAt ? fmtTime(d.calculatedAt) : 'an earlier run'}: shown for research, not a current recommendation.<//>` : null}
    <p class="note" style="margin:0">Supplied by Analytics Lab and passed through as stated: the Terminal does not work out eligibility. The calendar facts it rests on are in the panel above; the two are kept apart.</p>
  </div>`;
}

registerTabContent('earnings', EarningsTab);
