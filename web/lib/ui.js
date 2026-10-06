// Shared interface components. Every price is shown through <Price>, which always carries its
// provenance chip (source, time, status); a missing value is drawn as a dash, never as zero.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { DASH, fmtAge, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, isNum, parseNum, tone as toneOf, useStore } from './core.js';

export { html };

// ---- basics ------------------------------------------------------------------------------------------
export function Button({ kind = '', small, busy, disabled, onClick, title, type = 'button', children }) {
  return html`<button type=${type} class=${`btn ${kind} ${small ? 'small' : ''}`} disabled=${disabled || busy} onClick=${onClick} title=${title}>${busy ? 'Working…' : children}</button>`;
}
export function Field({ label, hint, error, span, children }) {
  return html`<div class=${`field ${span === 2 ? 'span-2' : span === 'all' ? 'span-all' : ''}`}>
    ${label && html`<label>${label}</label>`}${children}
    ${error ? html`<div class="err">${error}</div>` : hint ? html`<div class="hint">${hint}</div>` : null}
  </div>`;
}
export function Text({ value, onInput, placeholder, type = 'text', disabled, list, autofocus }) {
  const ref = useRef(null);
  useEffect(() => { if (autofocus && ref.current) ref.current.focus(); }, []);
  return html`<input ref=${ref} type=${type} value=${value ?? ''} placeholder=${placeholder} disabled=${disabled} list=${list} onInput=${(e) => onInput(e.target.value)} />`;
}
/** Numeric text box. Keeps what the user typed; reports a number or null. */
export function Num({ value, onInput, placeholder, disabled, step, cls = '' }) {
  const [raw, setRaw] = useState(value === null || value === undefined ? '' : String(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current && parseNum(raw) !== value) setRaw(value === null || value === undefined ? '' : String(value));
    last.current = value;
  }, [value]);
  return html`<input class=${`num ${cls}`} type="text" inputmode="decimal" value=${raw} placeholder=${placeholder} disabled=${disabled} step=${step}
    onInput=${(e) => { setRaw(e.target.value); const n = parseNum(e.target.value); last.current = n; onInput(n); }} />`;
}
export function Select({ value, onChange, options, disabled, placeholder }) {
  const groups = new Map();
  for (const o of options) {
    const g = o.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(o);
  }
  const opt = (o) => html`<option value=${o.value} selected=${String(o.value) === String(value ?? '')} disabled=${o.disabled}>${o.label}</option>`;
  return html`<select disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>
    ${placeholder !== undefined && html`<option value="" selected=${value === '' || value === null || value === undefined}>${placeholder}</option>`}
    ${[...groups].map(([g, list]) => (g ? html`<optgroup label=${g}>${list.map(opt)}</optgroup>` : list.map(opt)))}
  </select>`;
}
export function Seg({ value, onChange, options }) {
  return html`<div class="seg" role="group">${options.map((o) => html`<button type="button" class=${o.value === value ? 'on' : ''} disabled=${o.disabled} title=${o.title} onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`;
}
export function Check({ checked, onChange, children, disabled }) {
  return html`<label class="check"><input type="checkbox" checked=${Boolean(checked)} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />${children}</label>`;
}
export function Tabs({ tabs, value, onChange }) {
  return html`<div class="tabs" role="tablist">${tabs.map((t) => html`<button role="tab" aria-selected=${t.id === value} class=${t.id === value ? 'on' : ''} onClick=${() => onChange(t.id)}>
    ${t.label}${t.alert ? html`<span class="count">${t.alert}</span>` : isNum(t.count) && t.count > 0 ? html`<span class="n">${t.count}</span>` : null}</button>`)}</div>`;
}
export function Pill({ tone = '', title, children }) {
  return html`<span class=${`pill ${tone}`} title=${title}>${children}</span>`;
}
export function Notice({ tone = '', children }) {
  return html`<div class=${`notice ${tone}`}>${children}</div>`;
}
export function KV({ rows }) {
  return html`<dl class="kv">${rows.filter(Boolean).map(([k, v]) => html`<dt>${k}</dt><dd>${v ?? DASH}</dd>`)}</dl>`;
}
export function Stat({ label, value, sub, cls = '' }) {
  return html`<div class="stat"><span class="k">${label}</span><span class=${`v ${cls}`}>${value}</span>${sub ? html`<span class="s">${sub}</span>` : null}</div>`;
}
export function Empty({ title, children }) {
  return html`<div class="empty">${title && html`<strong>${title}</strong>`}${children}</div>`;
}
export function Panel({ title, actions, flush, children, note }) {
  return html`<section class="panel">
    ${(title || actions) && html`<header><h3>${title}</h3>${note && html`<span class="note">${note}</span>`}<span class="grow"></span>${actions}</header>`}
    <div class=${`body ${flush ? 'flush' : ''}`}>${children}</div>
  </section>`;
}

// ---- awaiting / missing ---------------------------------------------------------------------------------
/** The waiting state shown wherever a Shaffer service has not been connected yet. */
export function Awaiting({ what, children, compact }) {
  const msg = useStore((s) => s.status?.data?.awaitingMessage) || 'Awaiting Shaffer data connection';
  return html`<div class="awaiting" style=${compact ? 'padding:8px 11px' : ''}><span class="mark" aria-hidden="true"></span><div>
    <strong>${msg}</strong>${what && html`<div class="why">${what}</div>`}${children}</div></div>`;
}
export function Missing({ reason }) {
  return html`<span class="missing" title=${reason || 'Not available'}>${DASH}</span>`;
}

// ---- prices ------------------------------------------------------------------------------------------------
const GLYPH = {
  'real-time': html`<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>`,
  delayed: html`<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M5 1a4 4 0 0 1 0 8z" fill="currentColor" /></svg>`,
  'end-of-day': html`<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>`,
  indicative: html`<svg viewBox="0 0 10 10"><path d="M5 1l4 4-4 4-4-4z" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>`,
  'model-derived': html`<svg viewBox="0 0 10 10"><path d="M1 8c3 0 2-6 5-6h3M3 5h4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>`,
  reconstructed: html`<svg viewBox="0 0 10 10"><path d="M8.5 5a3.5 3.5 0 1 1-1-2.5M8.5 1v2h-2" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>`,
  manual: html`<svg viewBox="0 0 10 10"><path d="M1.5 8.5l1-3 4.5-4.5 2 2-4.5 4.5z" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>`,
  simulated: html`<svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M1 6l5-5M4 9l5-5" stroke="currentColor" stroke-width="1.2" /></svg>`,
};
const SHORT = { 'real-time': 'Real-time', delayed: 'Delayed', 'end-of-day': 'End of day', indicative: 'Indicative', 'model-derived': 'Model', reconstructed: 'Reconstructed', manual: 'Manual', simulated: 'Simulated' };

/** Provenance chip: status, with source, timestamp, currency, units and freshness on hover. */
export function Prov({ obs }) {
  if (!obs) return null;
  const stale = obs.freshness === 'stale';
  const lines = [
    `${obs.statusLabel || obs.status}${obs.delayMinutes ? ` (${obs.delayMinutes} min)` : ''}${stale ? ', stale' : ''}`,
    `Source: ${obs.source}`,
    obs.asOf ? `As of ${fmtTime(obs.asOf, { seconds: true })}${isNum(obs.ageSec) ? ` (${fmtAge(obs.ageSec)})` : ''}` : null,
    obs.forDate ? `For date ${obs.forDate}` : null,
    obs.currency ? `Currency: ${obs.currency}` : null,
    obs.units ? `Units: ${obs.units}` : null,
    ...(obs.assumptions || []),
  ].filter(Boolean).join('\n');
  return html`<span class=${`prov ${obs.status} ${stale ? 'stale' : ''}`} title=${lines}>${GLYPH[obs.status]}${SHORT[obs.status] || obs.status}</span>`;
}
/** A price with its provenance. `value` overrides which number of the observation is shown. */
export function Price({ obs, value, chip = true, reason }) {
  const v = value !== undefined ? value : obs ? (obs.value ?? null) : null;
  if (!isNum(v)) return html`<${Missing} reason=${reason || (obs ? 'No value in this observation' : undefined)} />`;
  return html`<span class="price"><span class="v">${fmtPrice(v)}</span>${chip && obs ? html` <${Prov} obs=${obs} />` : null}</span>`;
}
export function Money({ value, ccy, signed, bare, reason }) {
  if (!isNum(value)) return html`<${Missing} reason=${reason} />`;
  return html`<span class=${signed ? toneOf(value) : ''}>${fmtMoney(value, ccy, { sign: signed, bare })}</span>`;
}
export function Signed({ value, dp = 2, suffix = '' }) {
  if (!isNum(value)) return html`<${Missing} />`;
  return html`<span class=${toneOf(value)}>${fmtNum(value, dp, { sign: true })}${suffix}</span>`;
}

/**
 * What the current Book already holds in an instrument. Long and short are separate positions and
 * are always shown gross, with the net beside them: "Long 200 | Short 100 | Net +100". The net is
 * never presented as the holding. With `detail`, each owning Account or Treasury is listed.
 * h: { net, long, short, units: [{ name, long, short, qty }] } | null (not held) | undefined (unknown: draws nothing)
 */
export function Holdings({ h, detail = false, label = 'Held' }) {
  if (h === undefined) return null;
  if (!h || !h.units?.length) return html`<span class="held none">${detail ? 'Not held in this Book' : 'not held'}</span>`;
  const signed = (q) => `${q > 0 ? '+' : q < 0 ? '−' : ''}${fmtQty(Math.abs(q))}`;
  const gross = (x) => {
    const net = x.net ?? x.qty ?? x.long - x.short;
    if (x.long > 0 && x.short > 0) return html`<span class="long">Long ${fmtQty(x.long)}</span> | <span class="short">Short ${fmtQty(x.short)}</span> | <span class="net">Net ${signed(net)}</span>`;
    return x.long > 0 ? html`<span class="long">Long ${fmtQty(x.long)}</span>` : html`<span class="short">Short ${fmtQty(x.short)}</span>`;
  };
  const words = (x) => (x.long > 0 && x.short > 0 ? `Long ${fmtQty(x.long)} | Short ${fmtQty(x.short)} | Net ${signed(x.net ?? x.qty ?? x.long - x.short)}` : x.long > 0 ? `Long ${fmtQty(x.long)}` : `Short ${fmtQty(x.short)}`);
  if (!detail) return html`<span class="held" title=${h.units.map((u) => `${u.name}: ${words(u)}`).join('\n')}>${gross(h)}</span>`;
  return html`<span class="held">${label}: ${h.units.map((u, i) => html`${i ? '; ' : ''}<b>${u.name}</b> ${gross(u)}`)}</span>`;
}
/**
 * A net asset value with its standing. When a price or a conversion rate behind it is missing or
 * not current the figure is marked provisional, and the affected items are named.
 * nav: { value, complete, provisional, affected: [{ detail }] }
 */
export function NavValue({ nav, ccy, cls = '' }) {
  if (!nav) return html`<${Missing} />`;
  const why = (nav.affected || []).map((a) => a.detail).join('\n');
  return html`<span class=${cls}>${fmtMoney(nav.value, ccy)}${nav.provisional ? html` <span class="pill warn" title=${why || 'A price or conversion rate behind this figure is missing or not current.'}>provisional</span>` : null}</span>`;
}
/** The items that make a NAV provisional, as a list. Draws nothing when the figure is final. */
export function NavAffected({ nav }) {
  if (!nav?.provisional || !nav.affected?.length) return null;
  return html`<div class="notice warn"><b>Provisional.</b> This figure rests on ${nav.affected.length} item${nav.affected.length > 1 ? 's' : ''} without a current mark:
    <ul style="margin:4px 0 0;padding-left:18px">${nav.affected.map((a) => html`<li>${a.detail}</li>`)}</ul></div>`;
}
/** Holdings summary from a list of positions ({ owner, unitId, qty }), as the instrument detail returns them. */
export function holdingsFromPositions(positions) {
  const units = [];
  for (const p of positions || []) {
    if (!p.qty) continue;
    let row = units.find((u) => u.unitId === p.unitId);
    if (!row) { row = { unitId: p.unitId, name: p.owner, qty: 0, long: 0, short: 0 }; units.push(row); }
    row.qty += p.qty;
    if (p.qty > 0) row.long += p.qty; else row.short -= p.qty;
  }
  if (!units.length) return null;
  const sum = (k) => units.reduce((a, u) => a + u[k], 0);
  return { net: sum('qty'), long: sum('long'), short: sum('short'), units };
}

// ---- tables ----------------------------------------------------------------------------------------------------
/**
 * columns: [{ key, label, align: 'r'|'c', render(row), title, cls }]
 * rows may include { _group: 'label' } rows to draw a group heading.
 */
export function Table({ columns, rows, rowKey, onRowClick, empty, margin, footer, cls = '' }) {
  if (!rows || !rows.length) return empty ? html`<${Empty} ...${typeof empty === 'string' ? { title: empty } : empty} />` : null;
  return html`<div class="tablewrap"><table class=${`ledger ${margin ? 'margin' : ''} ${cls}`}>
    <thead><tr>${columns.map((c) => html`<th class=${c.align || ''} title=${c.title}>${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((row, i) => (row._group !== undefined
      ? html`<tr class="group" key=${`g${i}`}><td colspan=${columns.length}>${row._group}</td></tr>`
      : html`<tr key=${rowKey ? rowKey(row) : i} class=${onRowClick ? 'click' : ''} onClick=${onRowClick ? () => onRowClick(row) : undefined}>
          ${columns.map((c) => html`<td class=${`${c.align || ''} ${c.cls || ''}`}>${c.render ? c.render(row) : row[c.key] ?? DASH}</td>`)}</tr>`))}</tbody>
    ${footer && html`<tfoot>${footer}</tfoot>`}
  </table></div>`;
}

// ---- overlays ------------------------------------------------------------------------------------------------------
export function Modal({ title, sub, onClose, size = '', children, footer }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return html`<div class="scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`modal ${size}`} role="dialog" aria-modal="true" aria-label=${title}>
      <header><div class="grow"><h2>${title}</h2>${sub && html`<div class="note">${sub}</div>`}</div><button class="x" aria-label="Close" onClick=${onClose}>×</button></header>
      <div class="body">${children}</div>
      ${footer && html`<footer>${footer}</footer>`}
    </div></div>`;
}
export function Drawer({ title, sub, onClose, wide, children, actions }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return html`<div class="drawer-scrim" onClick=${onClose}></div>
    <aside class=${`drawer ${wide ? 'wide' : ''}`} role="dialog" aria-label=${title}>
      <header><div class="grow"><h2>${title}</h2>${sub && html`<div class="note">${sub}</div>`}</div>${actions}<button class="x" aria-label="Close" onClick=${onClose}>×</button></header>
      <div class="body">${children}</div>
    </aside>`;
}
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return html`<div class="toasts" aria-live="polite">${toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.tone}`}>${t.message}</div>`)}</div>`;
}
export function Overlays() {
  const overlay = useStore((s) => s.overlay);
  return overlay.map((o) => html`<div key=${o.id}>${o.render()}</div>`);
}
/** Lists blocking errors, warnings and notes from a preview or validation. */
export function Checks({ checks }) {
  if (!checks?.length) return null;
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...checks].sort((a, b) => order[a.level] - order[b.level]);
  return html`<ul class="checks">${sorted.map((c) => html`<li><${Notice} tone=${c.level === 'error' ? 'err' : c.level === 'warning' ? 'warn' : ''}>${c.level === 'error' ? html`<b>Blocks submission. </b>` : null}${c.message}<//></li>`)}</ul>`;
}
export function ErrorNote({ error }) {
  if (!error) return null;
  return html`<${Notice} tone="err">${error.message || String(error)}<//>`;
}

// ---- charts ------------------------------------------------------------------------------------------------------------
/** Payoff at expiry: profit above the zero line, loss below, break-evens marked. */
export function PayoffChart({ points, breakevens = [], reference, currency }) {
  if (!points?.length) return null;
  const W = 560, H = 210, L = 58, R = 12, T = 12, B = 26;
  const xs = points.map((p) => p.s), ys = points.map((p) => p.pnl);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const pad = (y1 - y0) * 0.08 || 1;
  y0 -= pad; y1 += pad;
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)},${Y(p.pnl).toFixed(1)}`).join('');
  const area = (sel) => {
    const pts = points.map((p) => `${X(p.s).toFixed(1)},${Y(sel(p.pnl)).toFixed(1)}`).join(' L');
    return `M${X(x0)},${Y(0)} L${pts} L${X(x1)},${Y(0)} Z`;
  };
  const ticks = [y1 - pad, 0, y0 + pad].filter((v, i, a) => a.indexOf(v) === i);
  const xt = [x0, (x0 + x1) / 2, x1];
  return html`<svg class="chart" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="Payoff at expiration">
    <path class="gainfill" d=${area((v) => Math.max(v, 0))} /><path class="lossfill" d=${area((v) => Math.min(v, 0))} />
    <line class="axis" x1=${L} y1=${T} x2=${L} y2=${H - B} /><line class="zero" x1=${L} y1=${Y(0)} x2=${W - R} y2=${Y(0)} />
    ${ticks.map((v) => html`<text x=${L - 6} y=${Y(v) + 3.5} text-anchor="end">${fmtNum(v, 0, { sign: true })}</text>`)}
    ${xt.map((v) => html`<text x=${X(v)} y=${H - 8} text-anchor="middle">${fmtPrice(v)}</text>`)}
    ${isNum(reference) && reference >= x0 && reference <= x1 ? html`<line class="ref" x1=${X(reference)} y1=${T} x2=${X(reference)} y2=${H - B} /><text x=${X(reference) + 4} y=${T + 9}>now ${fmtPrice(reference)}</text>` : null}
    <path class="line" d=${d} />
    ${breakevens.filter((b) => b >= x0 && b <= x1).map((b) => html`<circle class="be" cx=${X(b)} cy=${Y(0)} r="3.5" />`)}
    <text x=${W - R} y=${T + 9} text-anchor="end">profit / loss${currency ? ` (${currency})` : ''} by underlying price</text>
  </svg>`;
}
export function LineChart({ bars, height = 150 }) {
  if (!bars?.length) return null;
  const W = 560, H = height, L = 46, R = 8, T = 8, B = 20;
  const ys = bars.map((b) => b.close);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = (i) => L + (i / (bars.length - 1 || 1)) * (W - L - R);
  const Y = (y) => T + (1 - (y - y0) / (y1 - y0 || 1)) * (H - T - B);
  const d = bars.map((b, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(b.close).toFixed(1)}`).join('');
  return html`<svg class="chart" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="Price history">
    <line class="axis" x1=${L} y1=${T} x2=${L} y2=${H - B} /><line class="axis" x1=${L} y1=${H - B} x2=${W - R} y2=${H - B} />
    <text x=${L - 5} y=${Y(y1) + 4} text-anchor="end">${fmtPrice(y1)}</text><text x=${L - 5} y=${Y(y0) + 3} text-anchor="end">${fmtPrice(y0)}</text>
    <text x=${L} y=${H - 5}>${bars[0].date}</text><text x=${W - R} y=${H - 5} text-anchor="end">${bars[bars.length - 1].date}</text>
    <path class="line" d=${d} />
  </svg>`;
}

// ---- status pills --------------------------------------------------------------------------------------------------------
const ORDER_TONE = { filled: 'ok', partial: 'pen', working: 'pen', pending: '', rejected: 'bad', cancelled: 'warn', expired: 'warn' };
export const OrderStatus = ({ status }) => html`<${Pill} tone=${ORDER_TONE[status] || ''}>${{ partial: 'partly filled', pending: 'waiting' }[status] || status}<//>`;
const STRAT_TONE = { open: 'ok', working: 'pen', partial: 'pen', attention: 'bad', failed: 'bad', closed: '' };
export const StrategyStatus = ({ status }) => html`<${Pill} tone=${STRAT_TONE[status] || ''}>${{ attention: 'needs attention', partial: 'in progress', working: 'working' }[status] || status}<//>`;
const SUPPORT_TONE = { full: 'ok', partial: 'warn', manual: 'warn', planned: '' };
export const Support = ({ level, note }) => html`<${Pill} tone=${SUPPORT_TONE[level] || ''} title=${note || ''}>${{ full: 'full lifecycle', partial: 'partly manual', manual: 'manual inputs', planned: 'not yet' }[level] || level}<//>`;
export const PURPOSE_LABEL = { primary: 'Primary', hedge: 'Hedge', financing: 'Financing', reserve: 'Reserve' };
