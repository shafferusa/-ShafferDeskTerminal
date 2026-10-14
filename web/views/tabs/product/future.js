// Futures detail page (p1): Contract terms and margin, Curve and contract months.
//   - Contract month, multiplier, tick size and value, settlement and delivery terms (physical with its deliverable,
//     or cash) from the contract terms; the underlying linked to its own workspace.
//   - Margin: the Book's paper clearing terms (the initial margin registered on the contract, which the paper engine
//     posts), labelled as such, beside the exchange's requirement when the server supplies it.
//   - Curve: the prices of the contract months as supplied (market.futuresCurve), this contract marked; nothing is
//     interpolated or computed. The months registered in the Terminal are listed apart.
import { html } from '../../../vendor/preact-htm.js';
import { fmtMoney, fmtPriceUnits, fmtQty, fmtTime, get, isNum, useLive } from '../../../lib/core.js';
import { Missing, Notice, Table } from '../../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../../workspace.js';
import { detailRow, detailRows, pageHref, PointsChart, RelatedPanel, sup, SupplyNote, TermsBlock, ThisOne, val } from './common.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const contractMonth = (exp) => (exp && /^\d{4}-\d{2}/.test(exp) ? `${MONTHS[Number(exp.slice(5, 7)) - 1]} ${exp.slice(0, 4)}` : null);
const SHOWN = ['Contract multiplier', 'Expiration', 'Settlement', 'Tick size', 'Tick value', 'Initial margin per contract', 'Deliverable units per contract', 'Deliverable grade', 'Delivery location', 'First notice day'];

function FutureTerms({ inst, sel, asOf }) {
  const t = inst.terms || {};
  const und = inst.underlying;
  const m = useDataset(sel, 'exchangeMargin');
  const physical = t.settlement === 'physical' && !t.perpetual;
  const rows = [
    ['Underlying', und ? html`<a href=${pageHref(und.id)}><span class="sym">${und.symbol || und.name}</span></a> <span class="muted small">${und.symbol ? und.name : ''}</span>` : val(null, 'No underlying registered')],
    ['Contract month', t.perpetual ? 'Perpetual (no expiry)' : val(contractMonth(t.expiration), 'No expiry recorded')],
    ['Last trading day', t.perpetual ? 'None' : val(t.expiration, 'No expiry recorded')],
    ['Multiplier', isNum(inst.multiplier) ? `${fmtQty(inst.multiplier)} x the price per contract` : val(null)],
    ['Tick size', isNum(t.tickSize) ? `${t.tickSize} ${inst.priceUnits}` : val(null, 'No tick size recorded')],
    ['Tick value', detailRow(inst, 'Tick value') || val(null, 'Needs a tick size')],
    ['Price quoted', `${inst.priceUnits}, ${inst.tradingCcy}`],
    ['Settlement', physical ? html`Physical delivery${und ? html` of <a href=${pageHref(und.id)}>${und.symbol || und.name}</a>` : ''}<div class="sub">${detailRow(inst, 'Settlement') || ''}</div>` : 'Cash settled against the final settlement price'],
    physical ? ['Deliverable', html`${isNum(t.delivery?.units) ? `${fmtQty(t.delivery.units)} units per contract` : html`<${Missing} reason="Deliverable units not recorded" />`}${t.delivery?.grade ? `, grade ${t.delivery.grade}` : ''}${t.delivery?.location ? `, at ${t.delivery.location}` : ''}`] : null,
    physical ? ['First notice day', val(t.delivery?.firstNotice, 'Not recorded')] : null,
    ...detailRows(inst, SHOWN),
  ];
  return html`<div class="stack" data-testid="fut-terms"><div class="ws-cols">
    <${TermsBlock} title="Contract terms" rows=${rows} testid="fut-contract" />
    <div class="stack">
      <section class="panel" data-testid="fut-book-margin"><header><h3>Margin: the Book's clearing terms</h3><span class="note">Registered on the contract; the paper engine posts it</span></header>
        <div class="body"><div class="stats"><div class="stat"><span class="k">Initial margin per contract</span><span class="v">${isNum(t.initialMargin) ? fmtMoney(t.initialMargin, inst.tradingCcy) : html`<${Missing} reason="No initial margin registered: none is posted" />`}</span><span class="s">${inst.tradingCcy}</span></div></div>
          <${SupplyNote}>Paper clearing terms of this Terminal: posted when a position opens and released when it closes; profit and loss settles daily as variation margin against the settlement price. Change it on the instrument (Edit).<//></div></section>
      <${DatasetPanel} ds=${m} title="Exchange margin" note="As supplied by the server" asOf=${asOf} what="The clearing house's margin requirement from Shaffer MarketData">
        ${(env) => html`<div class="stack"><table class="ledger tight"><tbody>
            <tr><td>Initial, per contract</td><td class="r" data-testid="fut-exch-initial">${sup(env, 'initial', (v) => fmtMoney(v, env.data?.currency || inst.tradingCcy))}</td></tr>
            <tr><td>Maintenance, per contract</td><td class="r">${sup(env, 'maintenance', (v) => fmtMoney(v, env.data?.currency || inst.tradingCcy))}</td></tr>
            <tr><td>Clearing house</td><td class="r">${sup(env, 'clearingHouse')}</td></tr>
            <tr><td>Effective from</td><td class="r">${sup(env, 'effectiveDate')}</td></tr>
          </tbody></table>${env.data?.notes ? html`<div class="small muted">${env.data.notes}</div>` : null}
          ${isNum(env.data?.initial) && isNum(t.initialMargin) && env.data.initial !== t.initialMargin ? html`<${Notice}>The paper engine posts the ${fmtMoney(t.initialMargin, inst.tradingCcy)} registered on the contract, not this figure.<//>` : null}</div>`}<//>
      <${RelatedPanel} inst=${inst} sel=${sel} />
    </div></div></div>`;
}

function FutureCurve({ inst, sel, asOf }) {
  const curve = useDataset(sel, 'futuresCurve');
  const undId = inst.underlying?.id;
  const reg = useLive(() => (undId ? get(`/api/instruments/${undId}/contracts`, { family: 'future' }) : null), [undId], { interval: false });
  const months = (reg.data?.registered || []).slice().sort((a, b) => String(a.terms?.expiration || '9999') < String(b.terms?.expiration || '9999') ? -1 : 1);
  return html`<div class="stack" data-testid="fut-curve">
    <${DatasetPanel} ds=${curve} title="Curve across contract months" note="The prices supplied for each month; nothing interpolated" asOf=${asOf} what="Prices of the contract months from Shaffer MarketData">
      ${(env) => { const pts = (env.items || []).filter((x) => isNum(x.price));
        return html`<div class="stack">
          ${pts.length >= 2 ? html`<${PointsChart} points=${pts.map((x) => ({ label: x.contractMonth || x.expiration, value: x.price, mine: x.expiration === inst.terms?.expiration }))} />` : html`<p class="small muted">${pts.length ? 'One month supplied: no curve to draw.' : 'No prices supplied for the months.'}</p>`}
          <${Table} cls="tight" rows=${env.items || []} rowKey=${(x) => x.expiration} columns=${[
            { label: 'Month', render: (x) => html`${contractMonth(x.expiration) || x.contractMonth} ${x.expiration === inst.terms?.expiration ? html`<${ThisOne} />` : ''}` },
            { label: 'Expiry', render: (x) => x.expiration }, { label: 'Price', align: 'r', render: (x) => (isNum(x.price) ? fmtPriceUnits(x.price, x.units || inst.priceUnits) : html`<${Missing} reason=${env.nulls?.price || 'No price supplied for this month'} />`) },
            { label: 'Kind', render: (x) => x.priceType || html`<${Missing} />` }, { label: 'Time', render: (x) => (x.timestamp ? fmtTime(x.timestamp) : html`<${Missing} />`) },
            { label: 'Open interest', align: 'r', render: (x) => (isNum(x.openInterest) ? fmtQty(x.openInterest) : html`<${Missing} reason=${env.nulls?.openInterest || 'Not supplied'} />`) }]} />
          <${SupplyNote}>Points as supplied, in ${(env.items || [])[0]?.units || inst.priceUnits}. The Terminal draws them and works out nothing between them.<//></div>`; }}<//>
    <section class="panel"><header><h3>Contract months registered in the Terminal</h3><span class="note">The instrument registry, on ${inst.underlying?.symbol || 'this underlying'}</span></header>
      <div class="body">${!undId ? html`<p class="small muted">No underlying registered, so no other months are linked.</p>` : !reg.data ? html`<div class="ws-loading">Loading…</div>` : html`<${Table} cls="tight" rows=${months} rowKey=${(i) => i.id} empty=${{ title: 'No other months registered' }} columns=${[
        { label: 'Contract', render: (i) => html`<a href=${pageHref(i.id)}>${i.symbol || i.name}</a> ${i.id === inst.id ? html`<${ThisOne} />` : ''}` },
        { label: 'Month', render: (i) => (i.terms?.perpetual ? 'Perpetual' : contractMonth(i.terms?.expiration) || '') }, { label: 'Multiplier', align: 'r', render: (i) => fmtQty(i.multiplier) },
        { label: 'Initial margin (Book terms)', align: 'r', render: (i) => (isNum(i.terms?.initialMargin) ? fmtMoney(i.terms.initialMargin, i.tradingCcy) : html`<${Missing} reason="Not registered" />`) }]} />`}</div></section>
  </div>`;
}

registerTabContent('fut-terms', FutureTerms);
registerTabContent('fut-curve', FutureCurve);
