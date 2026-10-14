// Fund detail page (p1): Overview, NAV and fees; Holdings; NAV history. Distributions and Filings and reports (the
// fund's reports and documents) are the shared tabs.
//   - NAV with its date and currency, share class, fees and distribution policy: as supplied (market.fundFacts).
//   - Holdings and weights: as supplied (market.fundHoldings) with the report date and how much of the fund is listed;
//     a holding registered in the Terminal links to its own workspace (its data stays its own).
//   - Fund terms (manager, domicile, dealing and settlement) from the Terminal's registry.
import { html } from '../../../vendor/preact-htm.js';
import { fmtNum, fmtPrice, fmtQty, get, isNum, useLive } from '../../../lib/core.js';
import { Missing, Table } from '../../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../../workspace.js';
import { PriceHistory } from '../price-history.js';
import { detailRows, none, pageHref, sup, SupplyNote, TermsBlock, val } from './common.js';

const pctOf = (v) => `${fmtNum(v, 2)}%`;
const FEE_ROWS = [['ongoingChargePct', 'Ongoing charge', 'a year'], ['managementFeePct', 'Management fee', 'a year'], ['entryChargePct', 'Entry charge', 'of the amount dealt'], ['exitChargePct', 'Exit charge', 'of the amount dealt']];

function FundOverview({ inst, detail, sel, asOf }) {
  const f = useDataset(sel, 'fundFacts');
  const obs = detail?.observation;
  const dealing = inst.productId === 'mutual_fund' || inst.productId === 'money_market_fund' ? 'Dealt through the transfer agent at the next NAV after the order (never at a live quote)' : null;
  const rows = [
    ['Fund', inst.name], ['Manager or trust', val(inst.issuer, 'Not recorded')], ['Domicile', val(inst.domicile, 'Not recorded')],
    ['Dealt through', val(inst.venue, 'Not recorded')], dealing ? ['Dealing', dealing] : null,
    ['Settlement convention', inst.settlement?.label || html`<${Missing} />`], ['Units', `${inst.qtyLabel}, priced ${inst.priceUnits} in ${inst.tradingCcy}`],
    ...detailRows(inst, []),
  ];
  return html`<div class="stack" data-testid="fund-overview"><div class="ws-cols">
    <${DatasetPanel} ds=${f} title="NAV, fees and fund facts" note="As supplied by the server" asOf=${asOf} what="NAV and its date, share class, fees and distribution policy from Shaffer MarketData">
      ${(env) => html`<div class="stack">
        <div class="stats"><div class="stat"><span class="k">NAV per share</span><span class="v" data-testid="fund-nav">${sup(env, 'nav', (v) => fmtPrice(v))}</span><span class="s">${env.data?.navCurrency || ''}${env.data?.navDate ? `, NAV of ${env.data.navDate}` : ''}</span></div>
          <div class="stat"><span class="k">Share class</span><span class="v" style="font-size:14px">${sup(env, 'shareClass')}</span></div>
          <div class="stat"><span class="k">Net assets</span><span class="v" style="font-size:14px">${sup(env, 'netAssets', (v) => fmtQty(v))}</span></div></div>
        ${isNum(env.data?.nav) && isNum(obs?.value) && Math.abs(env.data.nav - obs.value) > 1e-9 ? html`<p class="small muted" style="margin:0">The header's current market price (${fmtPrice(obs.value)}, ${obs.source}) is a different observation from this NAV.</p>` : null}
        <h4 style="margin:4px 0 0">Fees</h4>
        <table class="ledger tight"><tbody>${FEE_ROWS.map(([k, label, per]) => html`<tr><td>${label}</td><td class="r">${sup(env, `fees.${k}`, pctOf)}</td><td class="small muted">${per}</td></tr>`)}
          <tr><td>Performance fee</td><td class="r">${sup(env, 'fees.performanceFee', String, 'None stated by the server')}</td><td></td></tr></tbody></table>
        <div class="small">Fee document of ${sup(env, 'fees.asOf', String, 'Date not supplied')}. Distribution policy: ${sup(env, 'distributionPolicy')}.</div>
        <${SupplyNote}>Fees are shown as the fund states them; the Terminal does not deduct them from the NAV or the paper P&L. Distributions are under Distributions, reports under Filings and reports.<//></div>`}<//>
    <${TermsBlock} title="Fund terms" rows=${rows} testid="fund-terms" />
  </div></div>`;
}

function FundHoldings({ sel, asOf }) {
  const h = useDataset(sel, 'fundHoldings');
  const reg = useLive(() => get('/api/instruments', { limit: 500 }), [], { interval: false });
  const bySym = new Map((reg.data?.items || []).filter((i) => i.symbol).map((i) => [i.symbol, i]));
  return html`<div class="stack" data-testid="fund-holdings">
    <${DatasetPanel} ds=${h} title="Holdings and weights" note="As reported by the fund through the server" asOf=${asOf} what="Holdings and their weights from Shaffer MarketData">
      ${(env) => { const items = env.items || []; const d = env.data || {};
        const listed = items.reduce((a, x) => a + (isNum(x.weightPct) ? x.weightPct : 0), 0);
        if (!items.length) return none('No holdings listed', 'The server answered with no holdings for this fund.');
        return html`<div class="stack">
          <p class="small" style="margin:0">Portfolio as of <b>${items[0].holdingsDate || d.holdingsDate || html`<${Missing} reason="Report date not supplied" />`}</b>${isNum(d.holdingsCount) ? `, ${items.length} of ${d.holdingsCount} holdings listed` : ''}${isNum(d.coveragePct) ? `, ${fmtNum(d.coveragePct, 1)}% of net assets (as supplied)` : ''}.${d.note ? ` ${d.note}` : ''}</p>
          <${Table} cls="tight" rows=${items} rowKey=${(x) => x.name} columns=${[
            { label: 'Holding', render: (x) => { const i = x.symbol && bySym.get(x.symbol); return i ? html`<a href=${pageHref(i.id)}>${x.name}</a>` : x.name; } },
            { label: 'Asset class', render: (x) => x.assetClass || html`<${Missing} />` },
            { label: 'Weight', align: 'r', render: (x) => (isNum(x.weightPct) ? pctOf(x.weightPct) : html`<${Missing} reason="Weight not supplied" />`) },
            { label: 'Quantity', align: 'r', render: (x) => (isNum(x.quantity) ? fmtQty(x.quantity) : html`<${Missing} reason="Not supplied" />`) },
            { label: 'Market value', align: 'r', render: (x) => (isNum(x.marketValue) ? fmtQty(x.marketValue) : html`<${Missing} reason="Not supplied" />`) }]} />
          <div class="small muted">The weights listed add up to ${fmtNum(listed, 1)}% (worked out here from the weights shown; the rest of the fund is not listed). A holding registered in the Terminal links to its own workspace: its data is its own, not the fund's.</div>
        </div>`; }}<//>
  </div>`;
}

function FundNav({ inst, sel, asOf, intervalFor }) {
  return html`<div class="stack" data-testid="fund-nav-history"><${PriceHistory} inst=${inst} sel=${sel} asOf=${asOf} intervalFor=${intervalFor} title="NAV history" />
    <p class="note">The history of the fund's published price (NAV) as the server supplies it; distributions lower the NAV on their ex-dates.</p></div>`;
}

registerTabContent('fund-overview', FundOverview);
registerTabContent('fund-holdings', FundHoldings);
registerTabContent('fund-nav', FundNav);
