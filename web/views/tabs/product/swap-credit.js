// Swap and credit-contract detail pages (p1): Legs and terms (swaps), Protection terms (credit default swaps),
// Schedules, Marks and history (swaps, credit default swaps, forwards and OTC options).
//   - Reference exposure: the rates, or the reference asset of a return or price leg (linked to its workspace).
//   - Pay and receive terms per leg as written; entering the opposite side reverses every leg.
//   - Schedules per leg from the contract and its payment calendar, with the next payment; what the paper engine has
//     scheduled in this Book.
//   - Financing (the funding leg of a return swap), collateral terms and the agreement, from the contract.
//   - Marks: the mark in use with its kind, the marks entered by hand, the marks supplied by the server
//     (market.otcMarks, dealer, clearing or model, with provenance), and the history of marks recorded.
import { html } from '../../../vendor/preact-htm.js';
import { fmtNum, fmtTime, get, isNum, useLive } from '../../../lib/core.js';
import { Missing, Pill, Table } from '../../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../../workspace.js';
import { PriceHistory } from '../price-history.js';
import { detailRow, detailRows, ManualMarks, MarkInUse, none, pageHref, pct, PointsChart, RelatedPanel, ScheduledPanel, SupplyNote, TermsBlock, useFacts, val } from './common.js';

const LEG_TYPE = { fixed: 'Fixed', float: 'Floating', ois: 'Overnight index (compounded)', return: 'Total or price return', price: 'Price', cap: 'Cap', floor: 'Floor' };
const EXPOSURE = new Set(['return', 'price']);
const legRate = (l) => (l.type === 'fixed' ? pct(l.rate) : l.index ? `${l.index}${isNum(l.spread) && l.spread ? ` ${l.spread > 0 ? '+' : '-'} ${fmtNum(Math.abs(l.spread) * 100, 2)}%` : ''}${isNum(l.strike) ? `, strike ${fmtNum(l.strike * 100, 3)}%` : ''}` : l.fixedPrice !== undefined && l.fixedPrice !== null ? `fixed price ${l.fixedPrice}` : '');
const freq = (l) => (l.months ? `every ${l.months} month${l.months > 1 ? 's' : ''}` : 'at maturity');

/** Instruments named by the legs (reference assets), for their links. */
function useLegRefs(legs) {
  const ids = [...new Set((legs || []).map((l) => l.underlyingId).filter(Boolean))];
  const r = useLive(async () => Promise.all(ids.map((id) => get(`/api/instruments/${id}`).catch(() => null))), [ids.join()], { interval: false });
  return new Map((r.data || []).filter(Boolean).map((i) => [i.id, i]));
}

function SwapTerms({ inst, sel }) {
  const t = inst.terms || {};
  const legs = t.legs || [];
  const refs = useLegRefs(legs);
  const hasExposure = legs.some((l) => EXPOSURE.has(l.type));
  const role = (l) => (EXPOSURE.has(l.type) ? 'Reference exposure' : hasExposure && ['float', 'ois', 'fixed'].includes(l.type) ? 'Financing leg' : 'Rate leg');
  const refOf = (l) => { const i = l.underlyingId && refs.get(l.underlyingId); return i ? html`<a href=${pageHref(i.id)}>${i.symbol || i.name}</a>` : l.underlyingName || null; };
  const exposure = hasExposure ? legs.filter((l) => EXPOSURE.has(l.type)).map((l) => html`<div>${l.side === 'pay' ? 'Pays' : 'Receives'} the ${l.passDividends ? 'total' : 'price'} return on ${refOf(l) || html`<${Missing} reason="Reference asset not recorded" />`} (${l.ccy})</div>`)
    : html`Interest rates: ${[...new Set(legs.map((l) => (l.type === 'fixed' ? `fixed ${l.ccy}` : l.index)).filter(Boolean))].join(' against ')}`;
  const basis = t.collateralBasis;
  const rows = [
    ['Reference exposure', exposure],
    ['Effective', val(t.effective)], ['Maturity', val(t.maturity)], ['Counterparty', val(t.counterparty, 'Not recorded')],
    ['Notional', `${inst.qtyLabel} (the quantity of a trade); marked ${inst.priceUnits}`],
    ['Financing', hasExposure ? html`The ${legs.filter((l) => !EXPOSURE.has(l.type)).map((l) => `leg ${l.id}`).join(' and ') || 'other leg'} funds the reference exposure; the Book's own financing of a position is under My positions and trades.` : 'No funding leg: a rate swap exchanges interest only. Margin and collateral are funded from cash (My positions and trades shows the Book\'s financing).'],
    ['Collateral terms', html`${detailRow(inst, 'Collateral terms') || html`<${Missing} reason="No collateral basis recorded" />`}${basis?.type === 'agreement' ? html`<div class="sub"><a href="#/treasury/collateral">Open the agreement under Treasury, Collateral</a></div>` : ''}`],
    ...detailRows(inst, ['Collateral terms', 'Effective', 'Maturity', 'Counterparty', ...legs.map((l) => `Leg ${l.id}`)]),
  ];
  return html`<div class="stack" data-testid="swap-terms">
    <section class="panel"><header><h3>Legs as written</h3><span class="note">Entering the opposite side reverses every leg</span></header>
      <div class="body"><${Table} cls="tight p1-legs" rows=${legs} rowKey=${(l) => l.id} empty=${{ title: 'No legs recorded' }} columns=${[
        { label: 'Leg', render: (l) => l.id }, { label: 'Side', render: (l) => html`<b>${l.side === 'pay' ? 'Pay' : 'Receive'}</b>` },
        { label: 'Type', render: (l) => LEG_TYPE[l.type] || l.type }, { label: 'Rate, index or reference', render: (l) => (EXPOSURE.has(l.type) ? refOf(l) || html`<${Missing} />` : legRate(l) || html`<${Missing} />`) },
        { label: 'Currency', render: (l) => l.ccy }, { label: 'Paid', render: (l) => html`${freq(l)}${l.paymentLag ? html`<div class="sub">${l.paymentLag} business days after the period ends</div>` : ''}` },
        { label: 'Day count', render: (l) => l.dayCount || html`<span class="muted small">n/a</span>` },
        { label: 'Notional', align: 'r', render: (l) => (isNum(l.notionalFactor) && l.notionalFactor !== 1 ? `x ${l.notionalFactor}` : 'x 1') },
        { label: 'Role', render: (l) => html`<span class="small">${role(l)}</span>` },
        { label: 'As written in the contract', render: (l) => html`<span class="small muted">${detailRow(inst, `Leg ${l.id}`) || ''}</span>` }]} /></div></section>
    <div class="ws-cols"><${TermsBlock} title="Contract terms" rows=${rows} testid="swap-contract" /><div class="stack"><${RelatedPanel} inst=${inst} sel=${sel} />
      <p class="note">A swap is a bilateral contract with no issuer: a reference asset's own data stays on its workspace.</p></div></div>
  </div>`;
}

function CdsTerms({ inst, sel }) {
  const t = inst.terms || {};
  const rows = [
    ['Reference entity', val(t.referenceEntity, 'Not recorded')], ['Seniority', val(t.seniority, 'Not recorded')],
    ['Effective', val(t.effective)], ['Maturity', val(t.maturity)],
    ['Counterparty', val(t.counterparty, 'Not recorded')],
    ['Notional', `${inst.qtyLabel}; marked ${inst.priceUnits}`],
    t.creditEvent ? ['Credit event', html`<${Pill} tone="warn">recorded ${t.creditEvent.date}<//>`] : null,
    ...detailRows(inst, ['Reference entity', 'Reference', 'Seniority', 'Effective', 'Maturity', 'Counterparty']),
  ];
  return html`<div class="stack" data-testid="cds-terms"><div class="ws-cols"><${TermsBlock} title="Protection terms" rows=${rows} testid="cds-contract" />
    <div class="stack"><${RelatedPanel} inst=${inst} sel=${sel} />
      <p class="note">The reference entity's statements are its own, not this contract's. Spreads and default probabilities are not computed here.</p></div></div></div>`;
}

function Schedules({ inst, sel, asOf, book }) {
  const facts = useFacts(sel, book);
  const periods = (rows, next) => html`<${Table} cls="tight" rows=${rows} rowKey=${(p) => `${p.start}${p.end}`} empty=${{ title: 'No payments left' }} columns=${[
    { label: 'Period', render: (p) => html`${p.start} to ${p.end} ${next && p.payDate === next.payDate && p.end === next.end ? html`<${Pill} tone="pen">next payment<//>` : ''}` }, { label: 'Paid on', render: (p) => p.payDate }]} />`;
  return html`<div class="stack" data-testid="swap-schedule">
    <${DatasetPanel} ds=${facts} title=${inst.family === 'cds' ? 'Premium schedule' : 'Payment schedule per leg'} note="From the contract terms and the payment calendar" asOf=${asOf}
      what="Payment dates worked out from the contract terms">
      ${(env) => (env.legs ? html`<div class="stack">${env.legs.map((l) => html`<div><h4 style="margin:4px 0">Leg ${l.id}: ${l.side === 'pay' ? 'pay' : 'receive'} ${LEG_TYPE[l.type]?.toLowerCase() || l.type} ${l.ccy}</h4>
            <div class="small" style="margin-bottom:4px">Next payment ${l.next ? html`<b>${l.next.payDate}</b> for ${l.next.start} to ${l.next.end}` : html`<${Missing} reason="No payment left" /> none left`}${l.remaining ? `, ${l.remaining} left` : ''}.</div>
            ${periods(l.periods, l.next)}</div>`)}
          <${SupplyNote}>Dates only: an amount is known when the period's fixing is in (floating legs) and is booked by the paper engine on the payment date. Accrual dates are not adjusted; payment dates follow the payment calendar.<//></div>`
        : env.premium ? html`<div class="stack"><div class="small">Running coupon ${pct(env.premium.coupon, 2)}. Next premium payment ${env.premium.next ? html`<b>${env.premium.next.payDate}</b>` : html`<${Missing} />`}, ${env.premium.remaining} left.</div>${periods(env.premium.periods, env.premium.next)}</div>`
          : none('No schedule', env.error || 'The contract terms give no payment schedule.'))}<//>
    <${ScheduledPanel} facts=${facts} inst=${inst} book=${book} asOf=${asOf} />
  </div>`;
}

function OtcMarks({ inst, detail, sel, asOf, intervalFor }) {
  const mk = useDataset(sel, 'otcMarks');
  return html`<div class="stack" data-testid="otc-marks">
    <div class="ws-cols"><${MarkInUse} inst=${inst} detail=${detail} /><${ManualMarks} inst=${inst} detail=${detail} title="Entered by hand" /></div>
    <${DatasetPanel} ds=${mk} title="Supplied marks" note="Dealer, clearing and model marks, each with its provider" asOf=${asOf} what="Marks for this contract supplied by the server">
      ${(env) => { const items = env.items || []; const byDate = items.filter((x) => isNum(x.value)).slice().reverse();
        return html`<div class="stack">
          ${byDate.length >= 2 ? html`<${PointsChart} points=${byDate.map((x) => ({ label: `${x.date.slice(5)} ${x.kind[0]}`, value: x.value }))} fmt=${(v) => fmtNum(v, 2)} height=${130} />` : null}
          <${Table} cls="tight" rows=${items} rowKey=${(x) => `${x.date}${x.kind}${x.provider}`} columns=${[
            { label: 'Mark date', render: (x) => x.date }, { label: 'Kind', render: (x) => html`<${Pill} tone=${x.kind === 'model' ? 'warn' : ''}>${x.kind}<//>` },
            { label: 'Value', align: 'r', render: (x) => (isNum(x.value) ? fmtNum(x.value, 4) : html`<${Missing} reason="Not supplied" />`) }, { label: 'Units', render: (x) => html`<span class="small">${x.units || html`<${Missing} />`}</span>` },
            { label: 'Provider', render: (x) => html`${x.provider || html`<${Missing} />`}<div class="sub">${x.method || ''}</div>` }, { label: 'Struck', render: (x) => (x.timestamp ? fmtTime(x.timestamp) : html`<${Missing} />`) }]} />
          <${SupplyNote}>Shown as supplied, newest first; the chart's letters are the kind (d dealer, c clearing, m model). A supplied mark is not used to value the Book until it is the mark in use; a model mark is a valuation, never a quote.<//></div>`; }}<//>
    <${PriceHistory} inst=${inst} sel=${sel} asOf=${asOf} intervalFor=${intervalFor} title="History of marks recorded" />
  </div>`;
}

registerTabContent('swap-terms', SwapTerms);
registerTabContent('cds-terms', CdsTerms);
registerTabContent('swap-schedule', Schedules);
registerTabContent('otc-marks', OtcMarks);
