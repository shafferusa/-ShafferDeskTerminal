// Financial statements tab of the instrument-detail workspace (#/instrument/<id>/statements).
// Income statement, balance sheet and cash flow statement as the Shaffer server supplies them (GET /api/server/statements):
// quarterly or annual periods side by side with the line labels pinned while the columns scroll, every line the server
// supplies, and per column the fiscal period, what it covers (a date, a quarter, year to date, a fiscal year, TTM), the
// filing date, source and basis; per cell a mark where its basis differs from its column's. A restated period is
// followed by its originally reported values. Year-to-date cash flows are shown as filed; the only derivation offered is
// the difference between consecutive year-to-date figures (statements-model.js guards it), shown apart and labelled as
// derived in the Terminal, not a model input. Growth, margins and ratios are shown only as the server supplies them; the
// Terminal's own comparison is optional, labelled and kept in its own table.
import { html, useMemo, useState } from '../../vendor/preact-htm.js';
import { fmtNum } from '../../lib/core.js';
import { Button, Check, Missing, Notice, Pill, Seg, Select } from '../../lib/ui.js';
import { DATASETS } from '../workspace-model.js';
import { DatasetPanel, pageHref, registerTabContent, useDataset } from '../workspace.js';
import {
  annualVsTtm, BASIS_MARK, forQuery, cellBasis, cellValue, columnsOf, comparisons, coverText, DERIVED_LABEL, isNum, KIND_LABEL, lineUnits, periodName, restatementPairs,
  STATEMENTS, suppliedMetrics, ytdDifferences, ytdNotice,
} from './statements-model.js';

// ---- per-viewer view choices (a convenience: the page works without storage) --------------------------------------------
const PREF_KEY = 'sdt.ws.statements';
const loadPrefs = () => { try { return JSON.parse(sessionStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; } };
const savePrefs = (p) => { try { sessionStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* per-tab convenience */ } };
const DEFAULTS = { statement: 'income', period: 'quarterly', qCount: 8, aCount: 5, originals: true, ttm: true, derive: false, compare: false };
const Q_COUNTS = [4, 8, 12], A_COUNTS = [3, 5, 10];

function usePrefs() {
  const [p, setP] = useState(() => ({ ...DEFAULTS, ...loadPrefs() }));
  const set = (patch) => setP((cur) => { const next = { ...cur, ...patch }; savePrefs(next); return next; });
  return [p, set];
}

const STATEMENT_LABEL = Object.fromEntries(STATEMENTS);

const MARK_TITLE = { restated: 'Restated: the originally reported value is kept in the column beside it', derived: 'Derived by the server from other reported lines', normalized: 'Normalized by the server (not as reported)', original: 'As originally reported, before the restatement' };

export function StatementsTab({ inst, sel, asOf, intervalFor }) {
  const [p, set] = usePrefs();
  const count = p.period === 'annual' ? p.aCount : p.qCount;
  const wantTtm = p.period === 'annual' && p.statement !== 'balance' && p.ttm;
  const q = { statement: p.statement, period: p.period, periods: count };
  // Asked at: an answer older than the current choice (another statement or period) is never drawn under it.
  const askedAt = useMemo(() => Date.now(), [sel, JSON.stringify(q)]);
  const main = forQuery(useDataset(sel, 'statements', { query: q, interval: intervalFor?.('statements') }), askedAt);
  // The TTM is its own request (its own answer, state and source), never mixed into the annual answer.
  const ttm0 = useDataset(sel, 'statementsTtm', { path: DATASETS.statements.path(sel.id), query: { statement: p.statement, period: 'ttm' }, enabled: wantTtm, asOf: true, interval: intervalFor?.('statements') });
  const ttmAskedAt = useMemo(() => Date.now(), [sel, p.statement, wantTtm]);
  const ttm = { ...forQuery(ttm0, ttmAskedAt), label: 'Trailing twelve months' };
  const env = main.env;
  const related = env?.related?.underlying;
  return html`<div class="stack st-tab" data-ws-inst=${inst.id}>
    <div class="toolbar st-tools" role="group" aria-label="Statement and periods">
      <${Seg} value=${p.statement} onChange=${(v) => set({ statement: v })} options=${STATEMENTS.map(([value, label]) => ({ value, label }))} />
      <${Seg} value=${p.period} onChange=${(v) => set({ period: v })} options=${[{ value: 'quarterly', label: 'Quarterly' }, { value: 'annual', label: 'Annual' }]} />
      <label class="st-count"><span class="lbl">Periods</span><${Select} value=${String(count)} onChange=${(v) => set(p.period === 'annual' ? { aCount: Number(v) } : { qCount: Number(v) })} options=${(p.period === 'annual' ? A_COUNTS : Q_COUNTS).map((n) => ({ value: String(n), label: `${n} side by side` }))} /></label>
    </div>
    <div class="toolbar st-opts" role="group" aria-label="What to show">
      <span class="lbl">Show</span>
      <${Check} checked=${p.originals} onChange=${(v) => set({ originals: v })}>Originally reported beside restated<//>
      ${p.period === 'annual' && p.statement !== 'balance' ? html`<${Check} checked=${p.ttm} onChange=${(v) => set({ ttm: v })}>Supplied TTM<//>` : null}
      <${Check} checked=${p.compare} onChange=${(v) => set({ compare: v })}>Terminal comparison<//>
    </div>
    ${related ? html`<${Notice}>Financial statements belong to the issuer: see <a href=${pageHref(related.terminalId, 'statements')}>${related.symbol}</a>. ${related.note || ''}<//>` : null}
    <${DatasetPanel} ds=${main} asOf=${asOf} flush title=${`${STATEMENT_LABEL[p.statement]}, ${p.period}`}
      note=${p.statement === 'balance' ? 'Values at each date' : 'Values over each period'}
      what=${`${STATEMENT_LABEL[p.statement]} (${p.period}) from Shaffer MarketData`}>
      ${(e) => html`<${StatementBody} env=${e} p=${p} set=${set} count=${count} asOf=${asOf} inst=${inst} />`}<//>
    ${main.state === 'unavailable' && p.period === 'quarterly' && (env?.coverage?.missing || []).some((m) => /quarter/i.test(m))
      ? html`<div class="row st-hint"><span class="note">The server supplies annual statements only for this issuer.</span> <${Button} small onClick=${() => set({ period: 'annual' })}>Show annual statements<//></div>` : null}
    ${wantTtm ? html`<${DatasetPanel} ds=${ttm} asOf=${asOf} flush title="Trailing twelve months, as supplied" note="The server's figure, kept apart from the fiscal years"
      what="Trailing-twelve-month figures from Shaffer MarketData">${(e) => html`<${TtmBody} env=${e} annual=${env?.data} p=${p} />`}<//>` : null}
    ${p.compare ? html`<${ComparisonPanel} data=${['available', 'stale', 'incomplete'].includes(main.state) ? env?.data : null} p=${p} />` : null}
  </div>`;
}

// ---- the statement grid --------------------------------------------------------------------------------------------------
function StatementBody({ env, p, set, count, asOf, inst }) {
  const data = env?.data;
  if (!data || !Array.isArray(data.periods) || !data.periods.length) return html`<div class="st-pad"><p class="note">The server's answer holds no periods for this statement.</p></div>`;
  const cols = columnsOf(data, { count, showOriginals: p.originals });
  const notice = p.period === 'quarterly' ? ytdNotice(data) : null;
  const relabelled = cols.filter((c) => c.relabelled);
  const pairs = restatementPairs(data);
  const metrics = suppliedMetrics(data);
  const lines = data.lines || [];
  return html`<div>
    <div class="st-pad stack">
      <div class="small st-facts">
        <span><b>${data.currency || html`<${Missing} reason="The server does not state the statement currency" />`}</b>, ${data.units || html`<${Missing} reason="The server does not state the units" />`}${lines.some((l) => l.units && l.units !== data.units) ? ' (lines in other units say so beside their label)' : ''}.</span>
        <span>${data.statement === 'balance' ? 'Balance sheet: each column is a value at the date shown.' : 'Each column covers the period shown; standalone quarters and year-to-date figures are named apart.'}</span>
        ${asOf ? html`<span>As filed on or before ${asOf}${env.pointInTime?.note ? `: ${env.pointInTime.note.replace(/^As filed on the date:\s*/i, '')}` : '; restatements made later are not applied.'}</span>` : null}
      </div>
      ${data.note ? html`<p class="note" style="margin:0">${data.note} <span class="muted">(server note)</span></p>` : null}
      ${notice ? html`<${Notice} tone="warn"><b>Year-to-date figures.</b> The server supplies ${notice.ytd.join(', ')} as year to date, not as standalone quarters, and they are shown as filed.${notice.quarterAlso.length ? ` ${notice.quarterAlso.join(', ')} ${notice.quarterAlso.length > 1 ? 'are' : 'is'} three months and also ${notice.quarterAlso.length > 1 ? 'their' : 'its'} own year to date.` : ''}
        <div style="margin-top:6px"><${Check} checked=${p.derive} onChange=${(v) => set({ derive: v })}>Show the difference between consecutive YTD figures (${DERIVED_LABEL})<//></div><//>` : null}
      ${relabelled.length ? html`<${Notice} tone="warn">${relabelled.map((c) => periodName(c.period)).join(', ')}: called a quarter by the server but covering ${relabelled[0].months} months, so shown as year to date.<//>` : null}
      ${pairs.length && !p.originals ? html`<${Notice}>${pairs.map((r) => r.name).join(', ')} ${pairs.length > 1 ? 'were' : 'was'} restated. The originally reported values are hidden; tick "Originally reported beside restated" to see them.<//>` : null}
    </div>
    <${Grid} data=${data} cols=${cols} lines=${lines} inst=${inst} />
    <${Legend} cols=${cols} lines=${lines} />
    ${p.derive && notice ? html`<${DerivedQuarters} data=${data} />` : null}
    <div class="st-pad"><${Metrics} metrics=${metrics} data=${data} /></div>
  </div>`;
}

/** Digits to show for a line: those its values carry (at most 2), so 4,727.0 and 1.12 read as supplied. */
function lineDp(line, extra = []) {
  let dp = 0;
  for (const v of [...Object.values(line.values || {}), ...Object.values(line.original || {}), ...extra]) {
    if (!isNum(v)) continue;
    const s = String(v); const i = s.indexOf('.');
    if (i >= 0 && !/e/i.test(s)) dp = Math.max(dp, s.length - i - 1);
  }
  return Math.min(dp, 2) || (Object.values(line.values || {}).some((v) => isNum(v) && Math.abs(v) < 100 && !Number.isInteger(v)) ? 2 : 1);
}

function ColHead({ c, data }) {
  const pd = c.period;
  const restated = c.role === 'current' && pd.basis === 'restated';
  return html`<th class=${`r st-c ${c.role === 'original' ? 'st-orig' : ''} ${restated ? 'st-restated' : ''}`} scope="col" data-st-col=${c.id} data-st-kind=${c.kind}>
    <div class="st-pn">${c.role === 'original' ? 'As originally reported' : periodName(pd)}</div>
    <div class="st-k">${c.role === 'original' ? periodName(pd) : KIND_LABEL[c.kind]}</div>
    ${c.kind === 'instant' ? html`<div class="st-d">at ${pd.end || '?'}</div>` : html`<div class="st-d">${isNum(c.months) ? `${c.months} months` : 'length not stated'}${c.kind === 'ytd' ? ' to date' : ''}</div><div class="st-d" title=${coverText(pd, data.statement)}>${pd.start || '?'} to ${pd.end || '?'}</div>`}
    <div class="st-d">${c.role === 'original' ? `filed ${c.filingDate || '?'}` : pd.filingDate ? `filed ${pd.filingDate}` : html`filed <${Missing} reason="No filing date supplied" />`}</div>
    <div class="st-d">${pd.source || html`<${Missing} reason="No source supplied" />`}</div>
    ${(pd.currency && pd.currency !== data.currency) || (pd.units && pd.units !== data.units) ? html`<div class="st-d"><b>${pd.currency || data.currency}, ${pd.units || data.units}</b></div>` : null}
    <div class="st-b">${c.role === 'original' ? html`<${Pill} title="The values as first filed; the restatement does not overwrite them">original</${Pill}>`
      : restated ? html`<${Pill} tone="warn" title=${`Restated${pd.restatedAt ? ` on ${pd.restatedAt}` : ''}; first filed ${pd.original?.filingDate || pd.filingDate || '?'}`}>restated${pd.restatedAt ? ` ${pd.restatedAt}` : ''}<//>`
        : html`<${Pill} tone=${pd.basis === 'derived' || pd.basis === 'normalized' ? 'pen' : ''} title=${pd.basis === 'derived' && c.kind === 'ttm' ? 'Worked out by the server from its quarterly figures' : ''}>${pd.basis || 'basis not stated'}<//>`}
      ${c.relabelled ? html` <${Pill} tone="warn" title="Called a quarter by the server, but it covers more than three months">year to date<//>` : null}</div>
  </th>`;
}

function Grid({ data, cols, lines, inst }) {
  if (!lines.length) return html`<div class="st-pad"><p class="note">The server's answer has periods but no line items.</p></div>`;
  return html`<div class="st-scroll" tabindex="0" aria-label=${`${STATEMENT_LABEL[data.statement] || 'Statement'} for ${inst.symbol || inst.name}: scroll sideways for more periods`}>
    <table class="ledger st-grid" data-testid="st-grid">
      <thead><tr><th class="st-l" scope="col">Line item<div class="st-d">${data.currency || ''}${data.units ? `, ${data.units}` : ''}</div></th>${cols.map((c) => html`<${ColHead} c=${c} data=${data} />`)}</tr></thead>
      <tbody>${lines.map((l) => {
        const dp = lineDp(l);
        const u = lineUnits(l, data);
        return html`<tr class=${l.level === 0 ? 'st-total' : ''} data-st-line=${l.key}>
          <th class="st-l" scope="row"><span class=${`st-lab lv${Math.min(l.level || 0, 3)}`}>${l.label || l.key}</span>${u && u !== data.units ? html`<span class="st-u">${u}</span>` : null}${l.basis && l.basis !== 'reported' ? html`<span class="st-u">${l.basis} by the server</span>` : null}</th>
          ${cols.map((c) => {
            const v = cellValue(l, c, data);
            const b = cellBasis(l, c);
            const colBasis = c.role === 'original' ? 'original' : c.basis === 'restated' ? 'reported' : c.basis;
            const mark = b !== colBasis && BASIS_MARK[b] ? BASIS_MARK[b] : c.role === 'original' && v.has ? 'o' : null;
            return html`<td class=${`r ${c.role === 'original' ? 'st-orig' : ''}`} data-st-cell=${`${l.key}:${c.id}`} data-st-basis=${b}>${v.has ? html`<span title=${mark ? MARK_TITLE[b] : ''}>${fmtNum(v.value, dp)}</span>` : html`<${Missing} reason=${v.why} />`}${mark ? html`<sup class="st-m" title=${MARK_TITLE[b]}>${mark}</sup>` : html`<sup class="st-m sp"></sup>`}</td>`;
          })}
        </tr>`;
      })}</tbody>
    </table></div>`;
}

function Legend({ cols, lines }) {
  const has = new Set();
  for (const l of lines) for (const c of cols) { const b = cellBasis(l, c); if (BASIS_MARK[b]) has.add(b); }
  const items = [['restated', 'r'], ['original', 'o'], ['derived', 'd'], ['normalized', 'n']].filter(([b]) => has.has(b));
  return html`<div class="st-pad st-legend small">${items.length ? html`Marks: ${items.map(([b, m], i) => html`${i ? ', ' : ''}<sup class="st-m">${m}</sup> ${MARK_TITLE[b].split(':')[0].toLowerCase()}`)}. ` : null}A dash is a value the server did not supply (hover for the reason); it is never shown as zero.</div>`;
}

// ---- year-to-date differences (the one derivation, opt-in and apart) -----------------------------------------------------
function DerivedQuarters({ data }) {
  const d = ytdDifferences(data);
  const lines = data.lines || [];
  return html`<section class="st-derived" data-testid="st-derived">
    <div class="st-pad"><h4>Standalone quarters from year-to-date figures <${Pill} tone="warn">${DERIVED_LABEL}</${Pill}></h4>
      <p class="note" style="margin:4px 0 0">Each column is a later year-to-date figure minus the one before it, offered only when both are of the same fiscal year, start on the same date, are three months apart, and share currency, units and basis. The server did not supply these values.</p></div>
    ${d.derived.length ? html`<div class="st-scroll"><table class="ledger st-grid st-dgrid">
      <thead><tr><th class="st-l" scope="col">Line item<div class="st-d">${data.currency}, ${data.units}</div></th>${d.derived.map((x) => html`<th class="r st-c" scope="col" data-st-col=${x.key}><div class="st-pn">${x.name}</div><div class="st-k">derived quarter</div><div class="st-d">${x.start} to ${x.end}</div><div class="st-d">${periodName(data.periods.find((q) => q.key === x.later))} YTD minus ${periodName(data.periods.find((q) => q.key === x.earlier))}${data.periods.find((q) => q.key === x.earlier)?.periodType === 'quarter' ? '' : ' YTD'}</div></th>`)}</tr></thead>
      <tbody>${lines.map((l) => html`<tr class=${l.level === 0 ? 'st-total' : ''}><th class="st-l" scope="row"><span class=${`st-lab lv${Math.min(l.level || 0, 3)}`}>${l.label}</span></th>
        ${d.derived.map((x) => html`<td class="r">${isNum(x.values[l.key]) ? fmtNum(x.values[l.key], lineDp(l, [x.values[l.key]])) : html`<${Missing} reason=${x.why[l.key] || 'Not derived'} />`}</td>`)}</tr>`)}</tbody></table></div>`
      : html`<div class="st-pad"><p class="note">No pair of year-to-date figures in this answer meets those conditions.</p></div>`}
    ${d.refused.length ? html`<div class="st-pad small"><b>Not derived:</b> ${d.refused.map((r, i) => html`${i ? '; ' : ''}${periodName(data.periods.find((q) => q.key === r.later))}: ${r.reason}`)}</div>` : null}
  </section>`;
}

// ---- server-supplied metrics, and the Terminal's own comparison ------------------------------------------------------------
function Metrics({ metrics, data }) {
  if (!metrics.length) return html`<p class="note st-nometrics" style="margin:0">The server supplies no growth, margin, ratio or normalized figures with this statement. None are worked out here as model inputs.</p>`;
  const keys = (data.periods || []).map((p) => p.key);
  return html`<div data-testid="st-metrics"><h4 style="margin:0 0 4px">As supplied by the server: growth, margins, ratios and normalized metrics</h4>
    <div class="tablewrap"><table class="ledger tight"><thead><tr><th>Metric</th>${keys.map((k) => html`<th class="r">${periodName(data.periods.find((p) => p.key === k))}</th>`)}</tr></thead>
    <tbody>${metrics.map((m) => html`<tr><td>${m.label}<div class="sub">${m.group}${m.units ? `, ${m.units}` : ''}${m.basis ? `, ${m.basis}` : ''}</div></td>
      ${m.values ? keys.map((k) => html`<td class="r">${isNum(m.values[k]) ? fmtNum(m.values[k], 2) : html`<${Missing} reason=${m.nulls[k] || 'Not supplied for this period'} />`}</td>`)
        : html`<td class="r" colspan=${keys.length}>${isNum(m.value) ? fmtNum(m.value, 2) : html`<${Missing} reason="Not supplied" />`}</td>`}</tr>`)}</tbody></table></div></div>`;
}

function ComparisonPanel({ data, p }) {
  const c = data ? comparisons(data) : null;
  const rows = c ? c.rows.filter((r) => r.ok) : [];
  return html`<section class="panel" data-testid="st-compare"><header><h3>Terminal comparison</h3><span class="note">Worked out in the Terminal for reading only, not supplied by the server and not a model input</span></header>
    <div class=${`body ${rows.length ? 'flush' : ''}`}>${!data ? html`<p class="note" style="margin:0">Shown once the statement above is available.</p>`
      : !rows.length ? html`<p class="note" style="margin:0">No period in this answer has the same period a year earlier of the same kind, length, currency, units and basis${p.period === 'quarterly' ? '; choose 8 or 12 periods to include the year before' : ''}.</p>`
        : html`<div class="st-pad small">Change against the same period a year earlier: (this period − the earlier one) ÷ |the earlier one| × 100, from the supplied values above. Year-to-date figures are compared only with year-to-date figures of the same length.</div>
        <div class="st-scroll"><table class="ledger st-grid"><thead><tr><th class="st-l" scope="col">Line item<div class="st-d">percent change</div></th>${rows.map((r) => html`<th class="r st-c" scope="col"><div class="st-pn">${r.name}</div><div class="st-d">against ${r.againstName}</div></th>`)}</tr></thead>
          <tbody>${(data.lines || []).map((l) => html`<tr><th class="st-l" scope="row"><span class=${`st-lab lv${Math.min(l.level || 0, 3)}`}>${l.label}</span></th>${rows.map((r) => html`<td class="r">${isNum(r.values[l.key]) ? `${fmtNum(r.values[l.key], 1, { sign: true })}%` : html`<${Missing} reason=${r.why[l.key]} />`}</td>`)}</tr>`)}</tbody></table></div>
        ${c.rows.some((r) => !r.ok) ? html`<div class="st-pad small muted">Not compared: ${c.rows.filter((r) => !r.ok).map((r) => `${r.name} (${r.reason.replace(/\.$/, '').toLowerCase()})`).join('; ')}.</div>` : null}`}</div></section>`;
}

// ---- TTM -------------------------------------------------------------------------------------------------------------
function TtmBody({ env, annual, p }) {
  const data = env?.data;
  if (!data?.periods?.length) return html`<div class="st-pad"><p class="note">The server's answer holds no trailing-twelve-month figure.</p></div>`;
  const r = annualVsTtm(annual || null, data);
  const cols = columnsOf(data, { showOriginals: p.originals });
  return html`<div>
    <div class="st-pad small">${r.ttm ? `Supplied by the server for ${r.ttm.start} to ${r.ttm.end}${r.ttm.filingDate ? `, as of the filing of ${r.ttm.filingDate}` : ''}. It is not a fiscal year and is not compared with the annual figures here.` : 'The server marks no column as trailing twelve months.'}${r.note ? ` ${r.note}` : ''}</div>
    <${Grid} data=${data} cols=${cols} lines=${data.lines || []} inst=${{ symbol: 'TTM' }} />
    <${Legend} cols=${cols} lines=${data.lines || []} />
  </div>`;
}

registerTabContent('statements', StatementsTab);
