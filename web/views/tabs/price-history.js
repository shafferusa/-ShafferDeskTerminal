// Price history tab of the instrument-detail workspace (also "Marks and history" for contracts): the server's
// historical prices for a chosen range and interval, as a chart (inline SVG in the ledger-paper design system, both
// themes) or a table, with OHLC and volume where supplied, corporate-action annotations placed on the bars, the
// adjusted and unadjusted series identified (and switchable only when the server supplies both), the basis of the
// change shown over the range, and gaps, short coverage and unavailable intervals said plainly. Nothing is filled in,
// interpolated or aggregated here: a bar the server did not send is not drawn.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { fmtNum, fmtPriceUnits, fmtQty, get, isNum, useStore } from '../../lib/core.js';
import { Button, Empty, Missing, Notice, Seg, Select, Signed } from '../../lib/ui.js';
import { DATASETS } from '../workspace-model.js';
import { DatasetPanel, registerTabContent, useDataset } from '../workspace.js';
import { coverageOf, findGaps, isScaleEvent, placeAnnotations, rangePerformance, seriesChoice } from './tabs-model.js';

export const RANGES = [['1m', '1 month', 31], ['3m', '3 months', 92], ['6m', '6 months', 183], ['1y', '1 year', 366], ['5y', '5 years', 1827], ['max', 'All available', null]];
export const INTERVALS = [['1d', 'Daily'], ['1wk', 'Weekly'], ['1mo', 'Monthly']];
const INTERVAL_WORD = { '1d': 'daily', '1wk': 'weekly', '1mo': 'monthly' };
const TYPE_LABEL = { cash_dividend: 'Dividend', dividend: 'Dividend', split: 'Split', reverse_split: 'Reverse split', buyback: 'Share buyback', rights: 'Rights issue', merger: 'Merger', spin_off: 'Spin-off', spinoff: 'Spin-off', stock_dividend: 'Stock dividend' };
const TYPE_MARK = { cash_dividend: 'D', dividend: 'D', split: 'S', reverse_split: 'S', stock_dividend: 'S', buyback: 'B', rights: 'R', merger: 'M', spin_off: 'O', spinoff: 'O' };
const annLabel = (a) => (a.label && a.label !== a.type ? a.label : `${TYPE_LABEL[a.type] || String(a.type || 'Corporate action').replace(/_/g, ' ')}${a.ratio ? ` ${a.ratio.num}:${a.ratio.den}` : ''}${isNum(a.amount) ? ` ${fmtNum(a.amount, 4)}` : ''}`);
const PLACEMENT = { on: 'on its date', next: 'no bar on its date: marked on the next bar', before: 'before the first bar shown: not on the chart', after: 'after the last bar shown: not on the chart' };

/** The existing price-history route, wrapped as an envelope, while /api/server/history is not served. */
export const historyFallback = (sel, q) => get(`/api/instruments/${sel.id}/history`, { from: q.from, to: q.to, interval: q.interval }).then((h) => ({
  state: h.available ? (h.bars?.length ? 'available' : 'unavailable') : 'awaiting', items: h.available ? h.bars : undefined,
  data: { adjusted: null, adjustmentBasis: null, currency: h.currency || null, interval: q.interval, annotations: [] },
  source: h.source ? { label: h.source, fixture: false } : null, message: h.available ? null : 'Historical prices come from Shaffer MarketData.', olderRoute: true,
}));
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * The price history panel. The research date (asOf) ends the range; history is dated, so it is asked by date range,
 * never "as known then", and the panel says what that means for adjustments and corrections.
 */
export function PriceHistory({ inst, sel, asOf, intervalFor, title = 'Price history' }) {
  const [range, setRange] = useState('6m');
  const [interval, setInterval] = useState('1d');
  const [wanted, setWanted] = useState('unadjusted');
  const [view, setView] = useState('chart');
  const [style, setStyle] = useState('close');
  const [noInterval, setNoInterval] = useState({});
  const status = useStore((s) => s.status);
  const end = asOf ? new Date(`${asOf}T23:59:59Z`) : new Date(status?.now || Date.now());
  const days = RANGES.find((r) => r[0] === range)?.[2];
  const q = { from: days ? isoDay(new Date(end.getTime() - days * 86400e3)) : undefined, to: isoDay(end), interval };
  const every = intervalFor?.('history');
  // Both series are asked for: the switch is offered only when the server supplies both (never manufactured here).
  const un = useDataset(sel, 'history', { query: { ...q, adjusted: '0' }, fallback: historyFallback, interval: every, asOf: false });
  const ad = useDataset(sel, 'historyAdjusted', { path: DATASETS.history.path(sel.id), query: { ...q, adjusted: '1' }, interval: every, asOf: false });
  const choice = seriesChoice({ un, adj: ad, wanted });
  const shown = choice.show === 'adjusted' ? ad : un;
  const ds = { ...shown, key: 'history', label: 'Price history', refresh: () => { un.refresh(); ad.refresh(); } };
  // An interval the server answered as unavailable is marked in the list (for this instrument).
  useEffect(() => {
    const miss = un.env?.coverage?.missing || [];
    if (un.state === 'unavailable' && miss.some((m) => String(m) === `interval ${interval}`)) setNoInterval((s) => (s[interval] ? s : { ...s, [interval]: true }));
  }, [un.env]);
  const ohlc = (shown.env?.items || []).some((b) => isNum(b.open) && isNum(b.high) && isNum(b.low));
  return html`<div class="stack e1-history" data-testid="price-history">
    <div class="e1-hbar" data-testid="history-controls">
      <label class="e1-ctl"><span class="ws-lbl">Range</span><${Select} value=${range} onChange=${setRange} options=${RANGES.map(([v, l]) => ({ value: v, label: l }))} /></label>
      <label class="e1-ctl"><span class="ws-lbl">Interval</span><${Select} value=${interval} onChange=${setInterval} options=${INTERVALS.map(([v, l]) => ({ value: v, label: noInterval[v] ? `${l} (not supplied)` : l }))} /></label>
      <span class="e1-ctl" data-testid="series-control"><span class="ws-lbl">Series</span>${choice.switchable
        ? html`<${Seg} value=${choice.show} onChange=${setWanted} options=${[{ value: 'unadjusted', label: 'Unadjusted', title: 'Prices as traded' }, { value: 'adjusted', label: 'Adjusted', title: 'Adjusted by the server for corporate actions' }]} />`
        : html`<span class="e1-series" title=${choice.why || ''}>${shown.state === 'loading' ? 'Loading' : choice.show === 'adjusted' ? 'Adjusted only' : un.state === 'awaiting' ? 'Awaiting' : hasAny(un) ? 'Unadjusted only' : 'None supplied'}</span>`}</span>
      <span class="e1-ctl"><span class="ws-lbl">Show</span><${Seg} value=${view} onChange=${setView} options=${[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} /></span>
      ${view === 'chart' ? html`<span class="e1-ctl"><span class="ws-lbl">Bars</span><${Seg} value=${ohlc ? style : 'close'} onChange=${setStyle} options=${[{ value: 'close', label: 'Close' }, { value: 'ohlc', label: 'OHLC', disabled: !ohlc, title: ohlc ? 'Open, high, low and close of each bar' : 'The server supplied no open, high and low for these bars' }]} /></span>` : null}
    </div>
    ${choice.why && !choice.switchable && hasAny(shown) ? html`<p class="note e1-why" data-testid="series-why">${choice.why}</p>` : null}
    ${asOf ? html`<div class="ws-asof" data-testid="history-asof">Research date ${asOf}: bars up to that date. Price history is dated, so it is asked by date range, not as it was known then: ${choice.show === 'adjusted' ? `this adjusted series includes adjustments for corporate actions after ${asOf}, and` : ''} corrections the source made later are included.</div>` : null}
    <${DatasetPanel} ds=${ds} title=${title} what=${`Historical prices for ${inst.symbol || inst.name} from Shaffer MarketData`}>
      ${(env) => html`<${HistoryBody} env=${env} inst=${inst} q=${q} range=${range} view=${view} style=${ohlc ? style : 'close'} />`}<//>
  </div>`;
}
const hasAny = (d) => (d.env?.items || []).some((b) => isNum(b.close));

function HistoryBody({ env, inst, q, range, view, style }) {
  const bars = (env.items || []).filter((b) => isNum(b.close) && b.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  const meta = env.data || {};
  const units = meta.units || inst.priceUnits;
  const ccy = meta.currency || inst.tradingCcy;
  if (!bars.length) {
    return html`<${Empty} title=${`No ${INTERVAL_WORD[q.interval] || q.interval} prices in this range`}>The server has no bars for ${q.from ? `${q.from} to ${q.to}` : `up to ${q.to}`}${env.coverage?.missing?.length ? ` (${env.coverage.missing.join(', ')})` : ''}. Nothing is drawn in their place: choose a longer range or another interval.<//>`;
  }
  const gaps = findGaps(bars, q.interval, env.coverage?.missing);
  const placed = placeAnnotations(bars, meta.annotations);
  const perf = rangePerformance(bars, { adjusted: typeof meta.adjusted === 'boolean' ? meta.adjusted : null, annotations: meta.annotations });
  const cov = coverageOf(bars, q.from, q.to);
  const series = meta.adjusted === true ? html`<b>Adjusted series</b>${meta.adjustmentBasis ? `: ${String(meta.adjustmentBasis).replace(/\.$/, '')}` : ', adjustment basis not stated by the server'}`
    : meta.adjusted === false ? html`<b>Unadjusted series</b>: ${String(meta.adjustmentBasis || 'prices as traded, not adjusted for splits or dividends').replace(/\.$/, '')}`
      : html`<b>Adjustment not stated</b>: the source does not say whether these prices are adjusted; treat the series as of unknown adjustment`;
  const divs = placed.filter((a) => a.index !== null && /dividend/.test(a.type || '') && !isScaleEvent(a)).length;
  return html`<div class="stack e1-hbody">
    <div class="small" data-testid="series-id">${series}. ${ccy}, ${units}. ${bars.length} ${INTERVAL_WORD[q.interval] || ''} bar${bars.length > 1 ? 's' : ''}, ${bars[0].date} to ${bars[bars.length - 1].date}.${env.olderRoute ? ' Served by the Terminal\'s existing history route until the server client route is available.' : ''}</div>
    ${cov.short ? html`<${Notice} tone="warn"><b>Insufficient coverage.</b> The server's history starts on ${cov.firstDate}, ${cov.missingDays} days after the start of the ${RANGES.find((r) => r[0] === range)?.[1].toLowerCase()} range (${q.from}). Nothing is filled in before it.<//>`
      : !q.from ? html`<p class="note" style="margin:0">All the history the server supplies for this instrument: ${cov.firstDate} to ${cov.lastDate}.</p>` : null}
    ${cov.endShort ? html`<${Notice}>The last bar is ${cov.lastDate}; the range runs to ${q.to}. No later bar was supplied.<//>` : null}
    ${gaps.some((g) => g.from) ? html`<div data-testid="history-gaps"><${Notice} tone="warn"><b>Gaps in the history.</b> ${gaps.filter((g) => g.from).map((g) => g.label).join('; ')}. They are left empty on the chart and in the table, not interpolated.<//></div>` : null}
    ${gaps.some((g) => !g.from) ? html`<div data-testid="history-missing"><${Notice} tone="warn"><b>Not in the server's answer:</b> ${gaps.filter((g) => !g.from).map((g) => g.label).join('; ')}.<//></div>` : null}
    ${view === 'chart' ? html`<${HistoryChart} bars=${bars} gaps=${gaps} placed=${placed} style=${style} units=${units} ccy=${ccy} label=${`${INTERVAL_WORD[q.interval] || ''} ${style === 'ohlc' ? 'open, high, low and close' : 'closes'} of ${inst.symbol || inst.name}, ${bars[0].date} to ${bars[bars.length - 1].date}, ${meta.adjusted === true ? 'adjusted' : meta.adjusted === false ? 'unadjusted' : 'adjustment not stated'}`} />`
      : html`<${HistoryTable} bars=${bars} gaps=${gaps} placed=${placed} units=${units} />`}
    <div class="small" data-testid="history-perf">Change over the range shown: ${isNum(perf.value) ? html`<b><${Signed} value=${perf.value} suffix="%" /></b>` : html`<${Missing} reason=${perf.why} /> <span class="muted">${perf.why}</span>`}
      ${perf.from ? html`<div class="muted">Basis: from the close of ${perf.from.date} (${fmtPriceUnits(perf.from.close, units)}) to the close of ${perf.to.date} (${fmtPriceUnits(perf.to.close, units)}), on the ${perf.series === 'unstated' ? 'series of unstated adjustment' : `${perf.series} series`}; (last close ÷ first close − 1) × 100, worked out here from the closes shown.${perf.priceOnly ? ` Price change only: ${divs ? `the ${divs} dividend${divs > 1 ? 's' : ''} in the range ${divs > 1 ? 'are' : 'is'} not included` : 'dividends are not included'}.` : ''}</div>` : null}</div>
    ${placed.length ? html`<div data-testid="history-annotations"><h4 class="e1-h4">Corporate actions in the range</h4><ul class="ws-ann">${placed.map((a) => html`<li><span class="e1-mark">${TYPE_MARK[a.type] || '•'}</span> ${a.date}: ${annLabel(a)} <span class="muted">(${PLACEMENT[a.placement]}${a.placement === 'next' ? `, ${a.barDate}` : ''})</span></li>`)}</ul></div>` : null}
    <p class="note" style="margin:0">Server market history, kept apart from the paper ledger: refreshing it never changes a fill or booked accounting.</p>
  </div>`;
}

// ---- chart -------------------------------------------------------------------------------------------------------------------
const dn = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400e3);
/** Up to n round tick values covering lo..hi. */
export function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
const fmtVol = (v) => (v >= 1e9 ? `${fmtNum(v / 1e9, 1)}bn` : v >= 1e6 ? `${fmtNum(v / 1e6, 1)}m` : v >= 1e3 ? `${fmtNum(v / 1e3, 0)}k` : fmtNum(v, 0));
/** Drawn at the width of its container (so text keeps its size), re-measured when the container resizes. */
function HistoryChart(props) {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setW(Math.round(el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return html`<div ref=${ref} class="e1-chartbox">${w ? html`<${ChartSvg} ...${props} width=${w} />` : null}</div>`;
}
function ChartSvg({ bars, gaps, placed, style, units, ccy, label, width }) {
  const vols = bars.some((b) => isNum(b.volume));
  const narrow = width < 520;
  const W = Math.max(300, width), PH = narrow ? 180 : 240, VH = vols ? 58 : 0, L = 58, R = 12, T = 18, B = 22;
  const H = T + PH + (vols ? 8 + VH : 0) + B;
  const x0 = dn(bars[0].date), x1 = dn(bars[bars.length - 1].date);
  const X = (d) => L + ((dn(d) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const lows = bars.map((b) => (style === 'ohlc' && isNum(b.low) ? b.low : b.close)), highs = bars.map((b) => (style === 'ohlc' && isNum(b.high) ? b.high : b.close));
  let lo = Math.min(...lows), hi = Math.max(...highs);
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
  lo -= pad; hi += pad;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * PH;
  const gapAfter = new Set(gaps.filter((g) => g.from).map((g) => g.from));
  const d = bars.map((b, i) => `${i === 0 || gapAfter.has(bars[i - 1].date) ? 'M' : 'L'}${X(b.date).toFixed(1)},${Y(b.close).toFixed(1)}`).join('');
  const slot = (W - L - R) / Math.max(1, x1 - x0 + 1);
  const tick = Math.max(1.2, Math.min(4, slot * 0.4));
  const vMax = vols ? Math.max(...bars.map((b) => (isNum(b.volume) ? b.volume : 0))) || 1 : 1;
  const vTop = T + PH + 8;
  const VY = (v) => vTop + VH - (v / vMax) * VH;
  const yt = niceTicks(lo, hi, narrow ? 3 : 5).filter((v) => v >= lo && v <= hi);
  const xi = [...new Set((narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => Math.round(f * (bars.length - 1))))];
  return html`<svg class="chart e1-chart" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${label} data-testid="history-chart">
    ${yt.map((v) => html`<line class="grid" x1=${L} x2=${W - R} y1=${Y(v)} y2=${Y(v)} /><text x=${L - 6} y=${Y(v) + 3.5} text-anchor="end">${fmtPriceUnits(v, units)}</text>`)}
    <text x=${L} y=${11}>${ccy}, ${units}</text>
    ${gaps.filter((g) => g.from).map((g) => html`<rect class="gap" x=${X(g.from)} y=${T} width=${Math.max(2, X(g.to) - X(g.from))} height=${PH + (vols ? 8 + VH : 0)}><title>${g.label}: no bars, nothing drawn</title></rect>`)}
    <line class="axis" x1=${L} y1=${T} x2=${L} y2=${T + PH} /><line class="axis" x1=${L} y1=${T + PH} x2=${W - R} y2=${T + PH} />
    ${style === 'ohlc' ? bars.map((b) => { const x = X(b.date); const up = b.close >= (isNum(b.open) ? b.open : b.close); return html`<g class=${up ? 'up' : 'down'}><line x1=${x} x2=${x} y1=${Y(isNum(b.high) ? b.high : b.close)} y2=${Y(isNum(b.low) ? b.low : b.close)} />${isNum(b.open) ? html`<line x1=${x - tick} x2=${x} y1=${Y(b.open)} y2=${Y(b.open)} />` : null}<line x1=${x} x2=${x + tick} y1=${Y(b.close)} y2=${Y(b.close)} /></g>`; })
      : html`<path class="line" d=${d} />`}
    ${vols ? html`<g class="vol">${bars.filter((b) => isNum(b.volume)).map((b) => html`<rect x=${X(b.date) - Math.max(0.6, slot * 0.35)} y=${VY(b.volume)} width=${Math.max(1.2, slot * 0.7)} height=${Math.max(0, vTop + VH - VY(b.volume))} />`)}</g>
      <text x=${L - 6} y=${vTop + 8} text-anchor="end">${fmtVol(vMax)}</text><text x=${L - 6} y=${vTop + VH} text-anchor="end">vol</text>` : null}
    ${placed.filter((a) => a.index !== null).map((a) => { const x = X(a.barDate); return html`<g class="ann" data-ann=${a.date}><title>${a.date}: ${annLabel(a)} (${PLACEMENT[a.placement]}${a.placement === 'next' ? `, ${a.barDate}` : ''})</title>
      <line x1=${x} x2=${x} y1=${T + 4} y2=${T + PH} /><rect x=${x - 6} y=${T - 8} width="12" height="12" rx="2" /><text x=${x} y=${T + 1.5} text-anchor="middle">${TYPE_MARK[a.type] || '•'}</text></g>`; })}
    ${xi.map((i, k) => html`<text x=${X(bars[i].date)} y=${H - 6} text-anchor=${k === 0 ? 'start' : k === xi.length - 1 ? 'end' : 'middle'}>${bars[i].date}</text>`)}
  </svg>`;
}

// ---- table ------------------------------------------------------------------------------------------------------------------
function HistoryTable({ bars, gaps, placed, units }) {
  const [all, setAll] = useState(false);
  const desc = bars.slice().reverse();
  const shown = all ? desc : desc.slice(0, 250);
  const gapAt = new Map(gaps.filter((g) => g.from).map((g) => [g.to, g]));
  const annAt = new Map();
  for (const a of placed) if (a.index !== null) annAt.set(a.barDate, [...(annAt.get(a.barDate) || []), a]);
  const cell = (v, f) => (isNum(v) ? f(v) : html`<${Missing} reason="Not supplied" />`);
  return html`<div class="tablewrap e1-htable" data-testid="history-table"><table class="ledger tight">
    <thead><tr><th>Date</th><th class="r">Open</th><th class="r">High</th><th class="r">Low</th><th class="r">Close</th><th class="r">Volume</th><th>Corporate action</th></tr></thead>
    <tbody>${shown.map((b) => html`<tr key=${b.date}><td>${b.date}</td>
        ${['open', 'high', 'low', 'close'].map((k) => html`<td class="r">${cell(b[k], (v) => fmtPriceUnits(v, units))}</td>`)}
        <td class="r">${cell(b.volume, fmtQty)}</td><td>${(annAt.get(b.date) || []).map((a, i) => html`${i ? '; ' : ''}${annLabel(a)}${a.placement === 'next' ? ` (ex-date ${a.date})` : ''}`)}</td></tr>
      ${gapAt.has(b.date) ? html`<tr class="e1-gaprow"><td colspan="7">${gapAt.get(b.date).label}: no bars from the source, nothing filled in.</td></tr>` : null}`)}</tbody>
  </table>${desc.length > shown.length ? html`<div class="e1-more"><${Button} small onClick=${() => setAll(true)}>Show all ${desc.length} bars<//></div>` : null}</div>`;
}

/** The tab: Price history for issuer securities, Marks and history for contracts. */
function HistoryTab({ inst, sel, asOf, intervalFor, tab }) {
  return html`<div class="stack"><${PriceHistory} inst=${inst} sel=${sel} asOf=${asOf} intervalFor=${intervalFor} title=${tab?.label || 'Price history'} />
    ${tab?.id === 'marks' ? html`<p class="note">Marks are shown with their kind (dealer, model or manual) in the header's price chip. A model mark from Analytics Lab is a valuation, never an executable quote.</p>` : null}</div>`;
}
registerTabContent('history', HistoryTab);
registerTabContent('marks', HistoryTab);
