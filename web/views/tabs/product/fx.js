// FX detail page (p1): Overview and conventions, Rates and curves.
//   - Base and quote currencies, the quotation direction, both currencies' payment calendars, the trading calendar and
//     the value-date convention from the Terminal's registry and calendars (with the value date of a trade today).
//   - Rates: the pair's rate as supplied (market.fx), with its direction, time and status; the forward curve only as
//     supplied (market.fxCurve). The Terminal inverts nothing and computes no forward.
import { html } from '../../../vendor/preact-htm.js';
import { fmtNum, fmtTime, isNum } from '../../../lib/core.js';
import { Missing, Pill, Table } from '../../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../../workspace.js';
import { detailRows, PointsChart, SupplyNote, TermsBlock, val } from './common.js';

function FxOverview({ inst, detail }) {
  const t = inst.terms || {};
  const cal = inst.calendar || {};
  const cc = cal.payment?.currencyCalendars || {};
  const stl = detail?.settlement;
  const calRow = (ccy) => (cc[ccy] ? `${cc[ccy]} (payment calendar of ${ccy})` : html`<${Missing} reason=${`No built-in calendar for ${ccy}: weekends only`} /> <span class="small muted">no built-in calendar for ${ccy}</span>`);
  const rows = [
    ['Base currency', val(t.base)], ['Quote currency', val(t.quote)],
    ['Quotation direction', t.base && t.quote ? html`${t.quote} per 1 ${t.base}<div class="sub">A price of 1.2500 means 1 ${t.base} costs 1.2500 ${t.quote}. Buying the pair buys ${t.base} and sells ${t.quote}.</div>` : val(null)],
    ['Calendar of the base currency', t.base ? calRow(t.base) : val(null)],
    ['Calendar of the quote currency', t.quote ? calRow(t.quote) : val(null)],
    ['Trading calendar', cal.trading ? `${cal.trading.label} (${cal.trading.id})` : val(null)],
    ['Value-date convention', html`Spot, T+${isNum(t.settleDays) ? t.settleDays : '?'} business days on the joint calendar ${cal.settlement?.id || ''}${cal.settlement?.label ? html`<div class="sub">${cal.settlement.label}</div>` : ''}`],
    ['Value date of a trade today', stl ? html`${stl.date} <span class="muted small">(trade date ${stl.tradeDate}, ${stl.label})</span>` : html`<${Missing} reason="Worked out once a Book is chosen" />`],
    ...detailRows(inst, ['Base currency', 'Quote currency', 'Spot settlement']),
  ];
  return html`<div class="stack" data-testid="fx-overview">
    ${cal.flag ? html`<div><${Pill} tone="warn">${cal.flagLabel || cal.flag}<//> <span class="small">${cal.flagText}</span></div>` : null}
    <${TermsBlock} title="Pair and conventions" note="The Terminal's registry and calendars" rows=${rows} testid="fx-terms" />
  </div>`;
}

function FxRates({ inst, sel, asOf }) {
  const t = inst.terms || {};
  const pair = t.base && t.quote ? `${t.base}/${t.quote}` : '';
  const fx = useDataset(sel, 'fx', { query: { pairs: pair }, enabled: Boolean(pair) });
  const curve = useDataset(sel, 'fxCurve');
  return html`<div class="stack" data-testid="fx-rates"><div class="ws-cols">
    <${DatasetPanel} ds=${fx} title="Rate" note="As supplied, with its direction" asOf=${asOf} what="The pair's rate from Shaffer MarketData">
      ${(env) => { const r = (env.items || []).find((x) => x.pair === pair) || (env.items || [])[0];
        return r ? html`<div class="stack"><table class="ledger tight"><tbody>
            <tr><td>Rate</td><td class="r" data-testid="fx-rate">${isNum(r.rate) ? fmtNum(r.rate, 5) : html`<${Missing} reason=${r.nulls?.rate || 'No rate supplied'} />`}</td><td class="small muted">${r.direction || html`<${Missing} reason="Direction not stated" />`}</td></tr>
            <tr><td>Bid / ask</td><td class="r">${isNum(r.bid) ? `${fmtNum(r.bid, 5)} / ${fmtNum(r.ask, 5)}` : html`<${Missing} reason="No bid or ask supplied" />`}</td><td></td></tr>
            <tr><td>Time</td><td class="r">${r.timestamp ? fmtTime(r.timestamp, { seconds: true }) : html`<${Missing} />`}</td><td class="small muted">${r.status || ''}</td></tr></tbody></table>
          <${SupplyNote}>The rate is shown in the direction supplied. Its inverse is not worked out here.<//></div>` : html`<p class="small muted">No rate for ${pair}.</p>`; }}<//>
    <${DatasetPanel} ds=${curve} title="Forward curve" note="Forward points as supplied" asOf=${asOf} what="Forward points by tenor from Shaffer MarketData">
      ${(env) => html`<div class="stack"><${PointsChart} points=${(env.items || []).map((x) => ({ label: x.tenor, value: x.forwardPoints }))} fmt=${(v) => fmtNum(v, 1)} height=${130} />
        <${Table} cls="tight" rows=${env.items || []} rowKey=${(x) => x.tenor} columns=${[
          { label: 'Tenor', render: (x) => x.tenor }, { label: 'Value date', render: (x) => x.valueDate || html`<${Missing} reason="Not supplied" />` },
          { label: 'Forward points', align: 'r', render: (x) => (isNum(x.forwardPoints) ? fmtNum(x.forwardPoints, 2) : html`<${Missing} reason="Not supplied" />`) },
          { label: 'Outright', align: 'r', render: (x) => (isNum(x.outright) ? fmtNum(x.outright, 5) : html`<${Missing} reason=${env.nulls?.outright || 'Not supplied'} />`) }]} />
        <div class="small muted">Points in ${(env.items || [])[0]?.pointsUnits || html`<${Missing} reason="Units not stated" />`}.${env.data?.note ? ` ${env.data.note}` : ''}</div>
        <${SupplyNote}>An outright forward is shown only when supplied: the Terminal does not add points to spot or build a curve.<//></div>`}<//>
  </div></div>`;
}

registerTabContent('fx-overview', FxOverview);
registerTabContent('fx-rates', FxRates);
