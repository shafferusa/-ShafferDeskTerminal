// Bond detail page (p1): Overview and terms, Schedules, Ratings and covenants.
//   - Issuer: linked to the issuer's equity workspace for its financials (Related); never shown as the bond's own.
//   - Coupon, maturity, quote convention and redemption from the contract terms (the Terminal's registry).
//   - Accrued interest: the Terminal's paper engine (contract arithmetic from the coupon schedule), labelled as such.
//   - Yield and spread: only as supplied by the server (market.yieldSpread), with the price it was struck on and when.
//   - Schedules: coupons and redemption from the contract; call and put schedules as registered; what the paper engine
//     has scheduled in this Book.
//   - Ratings and covenants: as supplied (market.ratingsCovenants).
import { html } from '../../../vendor/preact-htm.js';
import { fmtNum, fmtPriceUnits, fmtQty, fmtTime, isNum } from '../../../lib/core.js';
import { Missing, Notice, Pill, Table } from '../../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../../workspace.js';
import { detailRow, detailRows, none, RelatedPanel, ScheduledPanel, sup, SupplyNote, Supplied, TermsBlock, useFacts, val } from './common.js';

const COUPON_WORDS = { fixed: 'Fixed', float: 'Floating', zero: 'Zero coupon (discount)' };
const SHOWN = ['Coupon', 'Payments per year', 'Maturity', 'Day count', 'Redemption', 'Issue date', 'Minimum denomination', 'Issuer call', 'Holder put'];

function BondTerms({ inst, detail, sel, asOf, book }) {
  const t = inst.terms || {};
  const facts = useFacts(sel, book);
  const ys = useDataset(sel, 'yieldSpread');
  const obs = detail?.observation;
  const rows = [
    ['Issuer', val(inst.issuer, 'No issuer recorded on the instrument')],
    ['Coupon', detailRow(inst, 'Coupon') || val(COUPON_WORDS[t.couponType], 'No coupon terms recorded')],
    ['Payments per year', t.couponType === 'zero' ? 'None (zero coupon)' : val(t.frequency)],
    ['Maturity', t.perpetual ? 'Perpetual (no maturity date)' : val(t.maturity, 'No maturity recorded')],
    ['Day count', val(t.dayCount)],
    ['Quote convention', html`${inst.priceUnits}, ${inst.tradingCcy}<div class="sub">Quoted clean: the accrued interest is paid on top of the price in every trade.</div>`],
    ['Quantity', `${inst.qtyLabel}${isNum(t.minDenomination) && t.minDenomination > 1 ? `, in multiples of ${fmtQty(t.minDenomination)}` : ''}`],
    ['Redemption', t.perpetual ? 'None scheduled' : `${isNum(t.redemption) ? t.redemption : 100}% of par${isNum(t.factor) && t.factor !== 1 ? ` on the current factor ${t.factor}` : ''}`],
    t.issueDate ? ['Issue date', t.issueDate] : null,
    ['Settlement convention', inst.settlement?.label || html`<${Missing} />`],
    ...detailRows(inst, SHOWN),
  ];
  return html`<div class="stack" data-testid="bond-terms">
    <div class="ws-cols">
      <${TermsBlock} title="Contract terms" rows=${rows} testid="bond-contract" />
      <div class="stack">
        <${DatasetPanel} ds=${facts} title="Accrued interest" note="The Terminal's paper engine, not server data" asOf=${asOf}
          what="Accrued interest worked out by the paper engine from the coupon schedule">
          ${(env) => { const a = env.accrued; if (!a) return none('No accrued interest', 'This instrument has no coupon schedule.');
            return html`<div class="stack"><div class="stats"><div class="stat"><span class="k">Per 100 face, to ${a.asOf}</span><span class="v" data-testid="bond-accrued">${isNum(a.per100) ? fmtNum(a.per100, 6) : html`<${Missing} reason=${a.reason || 'Not available'} />`}</span><span class="s">${inst.tradingCcy}</span></div></div>
              ${a.note ? html`<${Notice}>${a.note}<//>` : null}
              <${SupplyNote}>Worked out by the Terminal's paper engine from the coupon terms and day count: the figure trades and the ledger use. Contract arithmetic, not a valuation and not a server value.<//></div>`; }}<//>
        <${DatasetPanel} ds=${ys} title="Yield and spread" note="Only as supplied by the server" asOf=${asOf}
          what="Yield and spread are shown only when Shaffer MarketData supplies them with the price they were struck on">
          ${(env) => html`<div class="stack"><table class="ledger tight" data-testid="bond-yield"><tbody>
              <tr><td>Yield</td><td class="r">${sup(env, 'yield.value', (v) => `${fmtNum(v, 3)}%`)}</td><td class="small muted">${sup(env, 'yield.type', String, 'Type not stated')}, ${sup(env, 'yield.convention', String, 'Convention not stated')}</td></tr>
              <tr><td>Spread</td><td class="r">${sup(env, 'spread.valueBps', (v) => `${fmtNum(v, 0)} bp`)}</td><td class="small muted">${env.data?.spread ? html`${env.data.spread.type || 'type not stated'} over ${env.data.spread.benchmark?.name || html`<${Missing} reason="Benchmark not named" />`}` : ''}</td></tr>
              <tr><td>Struck on</td><td class="r">${sup(env, 'priceUsed.value', (v) => fmtPriceUnits(v, env.data?.priceUsed?.units || inst.priceUnits))}</td><td class="small muted">${env.data?.priceUsed?.side || ''}${env.data?.priceUsed?.timestamp ? `, ${fmtTime(env.data.priceUsed.timestamp)}` : ''}</td></tr>
            </tbody></table>
            <${Supplied} by=${env.data?.provider} at=${env.data?.calculatedAt} />
            ${isNum(env.data?.priceUsed?.value) && isNum(obs?.value) && Math.abs(env.data.priceUsed.value - obs.value) > 1e-9 ? html`<${Notice} tone="warn">Struck on ${fmtPriceUnits(env.data.priceUsed.value, inst.priceUnits)}, not on the current market price ${fmtPriceUnits(obs.value, inst.priceUnits)} in the header: it is not recalculated here.<//>` : null}
            <${SupplyNote}>The Terminal does not compute yields or spreads; a missing value stays missing.<//></div>`}<//>
        <${RelatedPanel} inst=${inst} sel=${sel} />
      </div>
    </div>
  </div>`;
}

function BondSchedule({ inst, sel, asOf, book }) {
  const facts = useFacts(sel, book);
  const sched = (rows, label) => html`<${Table} cls="tight" rows=${rows} rowKey=${(r) => r.date} empty=${{ title: `No ${label} schedule in the contract terms` }}
    columns=${[{ label: 'From', render: (r) => r.date }, { label: 'Price', align: 'r', render: (r) => `${fmtNum(r.price, 3)}% of par` }]} />`;
  return html`<div class="stack" data-testid="bond-schedule">
    <${DatasetPanel} ds=${facts} title="Coupons and redemption" note="From the contract terms and the payment calendar" asOf=${asOf}
      what="Coupon and redemption dates worked out from the contract terms">
      ${(env) => { const c = env.coupons; if (!c) return none('No schedule', env.error || 'The contract terms give no coupon schedule.');
        const rows = [...c.rows.map((r) => ({ ...r, kind: 'Coupon' })), ...(c.redemption?.date ? [{ kind: 'Redemption', accrualEnd: c.redemption.date, payDate: c.redemption.payDate, redemption: c.redemption }] : [])];
        return html`<${Table} cls="tight" rows=${rows} rowKey=${(r) => `${r.kind}${r.accrualEnd}`} empty=${{ title: 'No coupons left', children: c.type === 'zero' ? 'A zero-coupon bond pays only its redemption.' : 'Every coupon has been paid.' }}
          columns=${[{ label: 'Event', render: (r) => r.kind }, { label: 'Period ends', render: (r) => r.accrualEnd }, { label: 'Paid on', render: (r) => r.payDate },
            { label: 'Per 100 face', align: 'r', render: (r) => (r.redemption ? `${fmtNum(r.redemption.pricePct, 3)}${r.redemption.factor !== 1 ? ` x factor ${r.redemption.factor}` : ''}` : isNum(r.per100) ? fmtNum(r.per100, 6) : html`<${Missing} reason=${r.reason || 'Not fixed by the contract'} /> <span class="small muted">${r.reason || ''}</span>`) }]} />
          <div class="small muted" style="margin-top:6px">${c.remaining !== null ? `${c.remaining} coupon${c.remaining === 1 ? '' : 's'} left${c.rows.length < c.remaining ? `, the next ${c.rows.length} listed` : ''}. ` : 'Perpetual: the next coupons are listed. '}${c.type === 'float' ? 'A floating coupon is known only once its fixing is supplied. ' : ''}Payment dates follow the ${c.calendar} calendar. Contract arithmetic, not a forecast.${c.calledOn ? ` Called and redeemed on ${c.calledOn}.` : ''}</div>`; }}<//>
    <div class="ws-cols">
      <${DatasetPanel} ds=${facts} title="Call and put schedules" note="As registered on the contract" asOf=${asOf}>
        ${(env) => html`<div class="stack"><h4 style="margin:0">Issuer call</h4>${sched(env.coupons?.calls || [], 'call')}<h4 style="margin:0">Holder put</h4>${sched(env.coupons?.puts || [], 'put')}
          <${SupplyNote}>A call or a put is exercised by hand (Edit, lifecycle). The Terminal does not decide whether it will be.<//></div>`}<//>
      <${ScheduledPanel} facts=${facts} inst=${inst} book=${book} asOf=${asOf} />
    </div>
  </div>`;
}

function BondCredit({ sel, asOf }) {
  const rc = useDataset(sel, 'ratingsCovenants');
  return html`<div class="stack" data-testid="bond-credit">
    <${DatasetPanel} ds=${rc} title="Ratings and covenants" asOf=${asOf} what="Agency ratings and the covenants of the issue from Shaffer MarketData">
      ${(env) => { const d = env.data || {};
        return html`<div class="stack">
          <p class="note" style="margin:0">${d.scope === 'issuer' ? html`Ratings of the issuer <b>${d.ratedEntity?.name || ''}</b>, not of this issue.` : d.scope === 'issue' ? html`Ratings of this issue (issuer ${d.ratedEntity?.name || html`<${Missing} />`}).` : html`Scope of the ratings: <${Missing} reason="Not stated by the server" />`}</p>
          ${Array.isArray(d.ratings) ? html`<${Table} cls="tight" rows=${d.ratings} rowKey=${(r) => `${r.agency}${r.scale}`} empty=${{ title: 'No ratings supplied' }} columns=${[
            { label: 'Agency', render: (r) => r.agency }, { label: 'Scale', render: (r) => html`<span class="small">${r.scale || html`<${Missing} />`}</span>` }, { label: 'Rating', render: (r) => html`<b>${r.rating}</b>` },
            { label: 'Outlook', render: (r) => r.outlook || html`<${Missing} reason="No outlook supplied" />` },
            { label: 'Watch', render: (r) => (r.watch ? html`<${Pill} tone="warn">${r.watch}<//>` : html`<span class="muted small">none</span>`) },
            { label: 'Last action', render: (r) => html`${r.action || html`<${Missing} />`}<div class="sub">${r.ratedAt || ''}</div>` }]} />` : html`<${Missing} reason=${env.nulls?.ratings || 'Ratings not supplied'} />`}
          <h4 style="margin:4px 0 0">Covenants</h4>
          ${Array.isArray(d.covenants) ? (d.covenants.length ? html`<${Table} cls="tight" rows=${d.covenants} rowKey=${(c) => c.key || c.label} columns=${[
            { label: 'Covenant', render: (c) => html`<b>${c.label}</b><div class="sub">${c.text || ''}</div>` }, { label: 'Threshold', render: (c) => c.threshold || html`<span class="muted small">none stated</span>` },
            { label: 'Status', render: (c) => c.status || html`<${Missing} reason="Not supplied" />` }]} />` : none('No covenants listed', d.covenantsNote || 'The server lists no covenants for this issue.'))
            : html`<p class="small"><${Missing} reason=${env.nulls?.covenants || 'Covenants not supplied'} /> Covenants are not supplied.</p>`}
          <${SupplyNote}>As supplied by the server. Ratings and covenant status are facts reported by agencies and issuers; the Terminal adds no assessment of its own.<//>
        </div>`; }}<//>
  </div>`;
}

registerTabContent('bond-terms', BondTerms);
registerTabContent('bond-schedule', BondSchedule);
registerTabContent('bond-credit', BondCredit);
