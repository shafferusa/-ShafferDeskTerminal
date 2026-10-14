// Shared framework of the product-specific detail pages (p1): the pieces every family module uses.
//   - useFacts: the Terminal's own contract facts (GET /api/instruments/:id/contract-facts): schedules from the
//     contract terms, the paper engine's accrued interest, the lifecycle work scheduled in this Book
//   - TermsBlock / detailRows: contract terms with their provenance (the Terminal's instrument registry)
//   - sup(): a supplied server value, or missing with the server's reason; never zero, never computed here
//   - ScheduledPanel: what the paper engine has scheduled on this instrument in this Book
//   - RelatedPanel: the issuer or underlying, linked as such (its data stays its own)
//   - SupplyNote: the sentence every supplied-only panel carries
// Server datasets are drawn through DatasetPanel (workspace.js), so every envelope state, the research date and Refresh
// behave as on every other tab.
import { html } from '../../../vendor/preact-htm.js';
import { fmtNum, fmtTime, isNum } from '../../../lib/core.js';
import { Empty, KV, Missing, Pill, Price, Table } from '../../../lib/ui.js';
import { DatasetPanel, pageHref, Related, useDataset } from '../../workspace.js';
import { FAMILY_TABS } from '../../workspace-model.js';

export const REGISTRY = "From the contract terms in the Terminal's instrument registry";
export const relatedOf = (inst) => FAMILY_TABS[inst.family]?.related || null;
export { pageHref };

/** The Terminal's contract facts for this instrument and Book; current information (a research date does not apply). */
export function useFacts(sel, book) {
  return useDataset(sel, 'contractFacts', { query: { bookId: book?.id || '' }, live: true });
}

/** A value at `path` of a supplied record, formatted, or missing with the server's reason for it. */
export function sup(env, path, fmt = (v) => String(v), fallback = 'Not supplied by the server') {
  const v = path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), env?.data);
  if (v === null || v === undefined || v === '') return html`<${Missing} reason=${env?.nulls?.[path] || env?.nulls?.[path.split('.')[0]] || fallback} />`;
  return fmt(v);
}
/** A plain value or missing with a reason. */
export const val = (v, reason = 'Not recorded on the contract', fmt = (x) => String(x)) => (v === null || v === undefined || v === '' ? html`<${Missing} reason=${reason} />` : fmt(v));
export const pct = (x, dp = 3) => (isNum(x) ? `${fmtNum(x * 100, dp)}%` : html`<${Missing} reason="Not recorded" />`);
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);

/** The registry's describe rows (server/products/*.js `describe`) whose label matches, or that are not used elsewhere. */
export function detailRow(inst, label) {
  const r = (inst.details || []).find(([k]) => String(k).toLowerCase() === String(label).toLowerCase());
  return r ? r[1] : null;
}
export function detailRows(inst, skip = []) {
  const s = new Set(skip.map((x) => String(x).toLowerCase()));
  return (inst.details || []).filter(([k]) => !s.has(String(k).toLowerCase()));
}

/** Contract terms as labelled rows, with where they come from. */
export function TermsBlock({ title, note = REGISTRY, rows, intro, testid }) {
  return html`<section class="panel" data-testid=${testid}><header><h3>${title}</h3><span class="note">${note}</span></header>
    <div class="body">${intro ? html`<p class="note" style="margin-top:0">${intro}</p>` : null}<${KV} rows=${rows.filter(Boolean)} /></div></section>`;
}

/** The sentence a supplied-only panel carries: what the Terminal does not do with it. */
export function SupplyNote({ children }) {
  return html`<p class="note" style="margin:6px 0 0">${children}</p>`;
}

/** A supplied provider and time line ("Supplied by X, calculated at T"). */
export function Supplied({ by, at, label = 'calculated' }) {
  return html`<span class="small muted">Supplied by ${by || html`<${Missing} reason="The provider is not named" />`}, ${label} ${at ? fmtTime(at) : html`<${Missing} reason="No time supplied" />`}</span>`;
}

const TASK_LABEL = {
  'bond.coupon': 'Coupon', 'accrual.coupon': 'Coupon accrual', 'bond.redemption': 'Redemption', 'bond.recovery': 'Recovery distribution',
  'swap.payment': 'Leg payment', 'swap.maturity': 'Maturity', 'swap.notional': 'Notional exchange', 'swap.notional_exchange': 'Notional exchange', 'swap.dividend': 'Dividend pass-through', 'swap.pass_through': 'Pass-through',
  'option.expiry': 'Expiry', 'future.expiry': 'Final settlement', 'future.variation': 'Variation margin', 'cds.premium': 'Premium payment', 'cds.accrued': 'Premium accrual', 'cds.maturity': 'Maturity',
  'loan.interest': 'Interest payment', 'loan.maturity': 'Repayment at maturity', 'interest.payment': 'Interest payment', 'repo.end': 'Repurchase (end of term)', 'repo.coupon': 'Coupon on collateral',
  'secloan.fee': 'Lending fee', 'secloan.recall': 'Recall', 'forward.settlement': 'Settlement', 'forward.maturity': 'Maturity', 'manual.valuation': 'Valuation due', 'manual.distribution': 'Distribution',
};
export const taskLabel = (t) => TASK_LABEL[t] || String(t).replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The paper engine's scheduled lifecycle work on this instrument in this Book (Book records, not server data). */
export function ScheduledPanel({ facts, inst, book, asOf }) {
  return html`<${DatasetPanel} ds=${facts} title=${`Scheduled in ${book?.name || 'this Book'}`} note="The paper engine's own schedule for positions held" asOf=${asOf}
    what="The Terminal's schedule of lifecycle events for this instrument">
    ${(env) => html`<${Table} rows=${env.scheduled || []} rowKey=${(t) => t.id} empty=${{ title: `Nothing scheduled in ${book?.name || 'this Book'}`, children: `The paper engine schedules coupons, payments, expiry and maturity for positions this Book holds in ${inst.symbol || inst.name}.` }}
      columns=${[{ label: 'Due', render: (t) => t.dueDate }, { label: 'Event', render: (t) => html`${taskLabel(t.type)}${t.legId ? html` <span class="muted small">leg ${t.legId}</span>` : ''}` },
        { label: 'Held in', render: (t) => t.owner || html`<${Missing} />` },
        { label: 'Status', render: (t) => html`<${Pill} tone=${t.status === 'blocked' || t.status === 'failed' ? 'warn' : ''}>${t.status}<//>${t.blockedReason ? html`<div class="sub">${t.blockedReason}</div>` : ''}` }]} />`}<//>`;
}

/** The issuer or the underlying, linked to its own workspace. */
export function RelatedPanel({ inst, sel }) {
  const reference = useDataset(sel, 'reference', { asOf: false });
  return html`<${Related} inst=${inst} related=${relatedOf(inst)} reference=${reference} />`;
}

/** A small "this contract" marker for a row of a list of contracts. */
export const ThisOne = () => html`<${Pill} tone="pen" title="The contract this page is about">this contract<//>`;

/** Empty list with what belongs there. */
export const none = (title, children) => html`<${Empty} title=${title}>${children}<//>`;

/**
 * Supplied points (a futures curve, forward points) as dots at their own positions, labelled, with no line between
 * them: the Terminal interpolates nothing. points: [{ label, value, mine }]
 */
export function PointsChart({ points, fmt = (v) => fmtNum(v, 2), height = 150 }) {
  const pts = points.filter((p) => isNum(p.value));
  if (pts.length < 2) return null;
  // Narrow drawings for few points, so the labels stay legible when the panel is narrow.
  const W = Math.max(320, 110 * pts.length), H = height, padX = 48, top = 26, bottom = 30;
  const lo = Math.min(...pts.map((p) => p.value)), hi = Math.max(...pts.map((p) => p.value));
  const span = hi - lo || Math.abs(hi) || 1;
  const x = (i) => padX + (i * (W - 2 * padX)) / (pts.length - 1);
  const y = (v) => top + (1 - (v - lo) / span) * (H - top - bottom);
  return html`<svg class="p1-points" viewBox=${`0 0 ${W} ${H}`} style=${`max-width:${W}px`} role="img" aria-label="Supplied points, not joined">
    <line x1=${padX - 20} x2=${W - padX + 20} y1=${H - bottom + 6} y2=${H - bottom + 6} class="axis" />
    ${pts.map((p, i) => html`<g><title>${p.label}: ${fmt(p.value)}${p.mine ? ' (this contract)' : ''}</title>
      <circle cx=${x(i)} cy=${y(p.value)} r=${p.mine ? 6 : 4} class=${p.mine ? 'mine' : ''} />
      <text x=${x(i)} y=${y(p.value) - 10} text-anchor="middle" class="v">${fmt(p.value)}</text>
      <text x=${x(i)} y=${H - 8} text-anchor="middle" class="l">${p.label}</text></g>`)}
  </svg>`;
}

/** The mark or price in use for this instrument (the header's observation), with its provenance chip. */
export function MarkInUse({ inst, detail }) {
  const obs = detail?.observation;
  return html`<section class="panel" data-testid="mark-in-use"><header><h3>Mark in use</h3><span class="note">What values the Book's positions now</span></header><div class="body">
    ${obs ? html`<div class="stats"><div class="stat"><span class="k">${inst.priceUnits}</span><span class="v"><${Price} obs=${obs} units=${inst.priceUnits} /></span><span class="s">${obs.source}, ${fmtTime(obs.asOf, { seconds: true })}</span></div></div>`
      : html`<p class="small" style="margin:0"><${Missing} reason="No mark recorded" /> No mark yet: positions in it are unpriced and every total that rests on them is provisional.</p>`}
    <p class="note" style="margin:6px 0 0">The chip says what kind of value it is (dealer, model, manual or simulated). A model value from Analytics Lab is a valuation, never an executable quote.</p></div></section>`;
}

/** Marks or prices entered by hand in the Terminal (the Terminal's own records), newest first. */
export function ManualMarks({ inst, detail, title = 'Marks entered by hand' }) {
  const rows = detail?.manualEntries || [];
  const enter = async () => { const m = await import('../../instrument.js'); m.openInstrument(inst.id, { tab: 'overview' }); };
  return html`<section class="panel" data-testid="manual-marks"><header><h3>${title}</h3><span class="note">The Terminal's own records, with who supersedes whom</span><span class="grow"></span>
      <button class="btn small" onClick=${enter} title="Open the quick overview, where a value is entered by hand">Enter a value by hand</button></header>
    <div class="body"><${Table} cls="tight" rows=${rows} rowKey=${(m) => m.id} empty=${{ title: 'None entered', children: 'A value entered by hand is kept here with its date and note, and labelled as manual wherever it is used.' }} columns=${[
      { label: 'Entered', render: (m) => fmtTime(m.as_of) }, { label: 'Value', align: 'r', render: (m) => (isNum(m.value) ? fmtNum(m.value, 4) : html`<${Missing} />`) },
      { label: 'For', render: (m) => (m.for_date ? m.for_date : 'current') }, { label: 'Status', render: (m) => (m.superseded_by ? html`<span class="muted">superseded</span>` : 'in use') },
      { label: 'Note', render: (m) => html`<span class="small">${m.note || ''}</span>` }]} /></div></section>`;
}
