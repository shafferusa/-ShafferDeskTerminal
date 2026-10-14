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
import { Empty, KV, Missing, Pill, Table } from '../../../lib/ui.js';
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
