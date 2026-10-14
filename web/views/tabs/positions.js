// My positions and trades tab of the instrument workspace: the selected Book's own paper records for this instrument,
// read from the server client's ledger interface only (GET /api/server/ledger/:id?bookId=, never remote):
// holdings by Account with long and short apart, the valued positions (the same figures as Accounting, Positions),
// linked strategy packages with their hedge and financing legs, hedge requests and allocations, open orders, fills,
// recorded corporate actions and the accounting history. They are labelled as local paper records and kept apart from
// the server's market history: refreshing market data never changes them, and a research date does not apply.
import { html } from '../../vendor/preact-htm.js';
import { fmtPriceUnits, fmtQty, fmtTime, isNum } from '../../lib/core.js';
import { Empty, Missing, Money, Pill, PURPOSE_LABEL } from '../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../workspace.js';

const OPEN = new Set(['pending', 'working', 'partial']);
const openStrategy = async (id) => { const m = await import('../strategy-detail.js'); m.openStrategy(id); };
const openHedge = async (id) => { const m = await import('../hedge.js'); m.openHedgeRequest(id); };
const trade = async (id) => { const m = await import('../instrument.js'); m.openInstrument(id, { tab: 'trade' }); };
const link = (label, onClick, title) => html`<a href="javascript:void 0" title=${title} onClick=${(e) => { e.preventDefault(); onClick(); }}>${label}</a>`;
const words = (s) => String(s || '').replace(/[._]+/g, ' ');

function PositionsTab({ inst, sel, asOf, book, intervalFor }) {
  const ledger = useDataset(sel, 'ledger', { query: { bookId: book.id }, live: true, asOf: false, interval: intervalFor?.('ledger') });
  return html`<div class="stack" data-ws-inst=${inst.id} data-testid="pos-tab">
    <p class="note e3-local" style="margin:0"><b>Local paper records of ${book.name}.</b> Kept by this Terminal, apart from the server's market history, and never changed by it.${asOf ? ` They are current: the research date ${asOf} does not apply to them.` : ''}</p>
    <${DatasetPanel} ds=${ledger} asOf=${asOf} title="My positions and trades" note="Paper ledger of this Book" what="The paper ledger's own record of this instrument">
      ${(env) => html`<${Records} d=${env.data || {}} inst=${inst} book=${book} />`}<//>
  </div>`;
}

function Records({ d, inst, book }) {
  const positions = d.positions || [];
  const holdings = d.holdings || [];
  const strategies = d.strategies || [];
  const orders = d.orders || [];
  const fills = d.fills || [];
  const sname = new Map(strategies.map((s) => [s.id, s.name]));
  const openOrders = orders.filter((o) => OPEN.has(o.status));
  const byId = new Map(orders.map((o) => [o.id, o]));
  const units = inst.priceUnits || '';
  return html`<div class="stack">
    <section class="e3-sec" data-testid="pos-holdings"><h4>Holdings by Account</h4>
      ${holdings.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Held in</th><th class="r">Long</th><th class="r">Short</th><th class="r">Net</th><th></th></tr></thead><tbody>
        ${holdings.map((h) => html`<tr data-unit=${h.unitId}><td>${h.owner || h.unitId}</td><td class="r">${h.long ? fmtQty(h.long) : ''}</td><td class="r">${h.short ? fmtQty(h.short) : ''}</td><td class="r">${fmtQty(h.net)}</td>
          <td class="r"><a href=${`#/accounting/positions/${h.unitId}`}>Open in Accounting</a></td></tr>`)}</tbody></table></div>`
        : html`<${Empty} title=${`${book.name} holds no position in ${inst.symbol || inst.name}`}>Use Trade to open one. <button class="btn link small" onClick=${() => trade(inst.id)}>Trade</button><//>`}
    </section>
    ${positions.length ? html`<section class="e3-sec" data-testid="pos-positions"><h4>Positions</h4><p class="note">Valued as in Accounting, Positions: average cost from the ledger, market value on the Terminal's current price.</p>
      <div class="tablewrap"><table class="ledger"><thead><tr><th>Held in</th><th>Strategy package</th><th class="r">Long</th><th class="r">Short</th><th class="r">Average cost</th><th class="r">Market value</th><th class="r">Unrealized</th><th>Protection and links</th></tr></thead><tbody>
        ${positions.map((p) => html`<tr data-position=${p.positionId}>
          <td>${p.owner}</td><td>${p.strategyId ? link(sname.get(p.strategyId) || p.strategyId, () => openStrategy(p.strategyId), 'Open the strategy drawer') : html`<span class="muted">none</span>`}${p.purpose && p.purpose !== 'primary' ? html` <${Pill}>${PURPOSE_LABEL[p.purpose] || p.purpose}<//>` : ''}</td>
          <td class="r" data-col="long">${p.qty > 0 ? fmtQty(p.qty) : ''}</td><td class="r" data-col="short">${p.qty < 0 ? fmtQty(-p.qty) : ''}</td>
          <td class="r">${isNum(p.avgCost) ? fmtPriceUnits(p.avgCost, p.priceUnits || units) : html`<${Missing} reason="No average cost for this position" />`}</td>
          <td class="r"><${Money} value=${p.mv} ccy=${p.ccy} reason=${p.missingReason} /></td><td class="r"><${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} /></td>
          <td class="wrap small">${p.protection && p.protection.protectedUnits > 0 ? html`<div>protected ${fmtQty(p.protection.protectedUnits)} of ${fmtQty(p.protection.exposureUnits)} units</div>` : p.protection?.assessment === 'unavailable' ? html`<div>Protection assessment unavailable.</div>` : null}
            ${(p.relationships || []).map((r) => html`<div data-relation=${r.kind}>${r.text}</div>`)}${p.hedgeOf ? html`<div>Held as a hedge</div>` : null}</td></tr>`)}</tbody></table></div></section>` : null}
    <section class="e3-sec" data-testid="pos-packages"><h4>Strategy packages, hedges and financing</h4>
      ${strategies.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Package</th><th>Status</th><th>Legs</th><th>Financing legs</th><th>Hedges</th></tr></thead><tbody>
        ${strategies.map((s) => { const fin = s.legs.filter((l) => l.financing); const main = s.legs.filter((l) => !l.financing); return html`<tr data-strategy=${s.id}>
          <td>${link(s.name, () => openStrategy(s.id), 'Open the strategy drawer')}<div class="sub">${s.owner || ''}, opened ${fmtTime(s.createdAt)}</div></td><td>${words(s.status)}</td>
          <td class="wrap small">${main.length ? main.map((l) => html`<div>${l.instrument?.symbol || l.instrument?.name}: ${fmtQty(l.qty)} ${l.direction || ''}${l.purpose && l.purpose !== 'primary' ? ` (${(PURPOSE_LABEL[l.purpose] || l.purpose).toLowerCase()})` : ''}</div>`) : html`<span class="muted">no open legs</span>`}</td>
          <td class="wrap small" data-col="financing">${fin.length ? fin.map((l) => html`<div>${l.instrument?.symbol || l.instrument?.name}: ${fmtQty(Math.abs(l.qty))} ${l.direction || ''}</div>`) : html`<span class="muted">none</span>`}</td>
          <td class="wrap small">${s.hedgeRequests.length ? s.hedgeRequests.map((h) => html`<div>${link(`Hedge request ${h.id}`, () => openHedge(h.id), 'Open the hedge popup')}, ${words(h.status)}, ${fmtTime(h.created_at)}</div>`) : html`<span class="muted">none requested</span>`}</td></tr>`; })}</tbody></table></div>`
        : html`<div class="muted small">No strategy package holds this instrument.</div>`}
      ${(d.allocations || []).length ? html`<h4 style="margin-top:10px">Hedge allocations</h4><div class="tablewrap"><table class="ledger" data-testid="pos-allocations"><thead><tr><th>Hedge</th><th>Protects</th><th class="r">Units</th><th class="r">Capacity</th><th>Basis</th><th>Status</th></tr></thead><tbody>
        ${d.allocations.map((a) => html`<tr><td>${a.hedge?.symbol || a.hedge?.name || a.hedge_position_id}</td><td>${a.protected?.symbol || a.protected?.name || a.protected_position_id}<div class="sub">${a.side}, ${a.owner || ''}</div></td>
          <td class="r">${isNum(a.units) ? fmtQty(a.units) : html`<span class="muted">linked, no unit measure</span>`}</td><td class="r">${isNum(a.capacity) ? fmtQty(a.capacity) : ''}</td><td>${words(a.basis)}${a.request_id ? html`<div class="sub">${link(a.request_id, () => openHedge(a.request_id), 'Open the hedge popup')}</div>` : ''}</td><td>${a.status}${a.reason ? html`<div class="sub">${a.reason}</div>` : ''}</td></tr>`)}</tbody></table></div>` : null}
    </section>
    <section class="e3-sec" data-testid="pos-orders"><h4>Open orders <span class="muted small">(${openOrders.length})</span></h4>
      ${openOrders.length ? html`<${OrderTable} rows=${openOrders} sname=${sname} units=${units} />` : html`<div class="muted small">No working paper order on this instrument.</div>`}
    </section>
    <section class="e3-sec" data-testid="pos-fills"><h4>Fills <span class="muted small">(${fills.length})</span></h4>
      ${fills.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Filled</th><th>Held in</th><th>Order</th><th class="r">Quantity</th><th class="r">Price</th><th class="r">Gross</th><th>Settles</th><th>How filled</th></tr></thead><tbody>
        ${fills.map((f) => html`<tr><td class="nowrap">${fmtTime(f.ts, { seconds: true })}</td><td>${f.owner || ''}</td><td>${byId.get(f.order_id) ? `${words(byId.get(f.order_id).action)}${byId.get(f.order_id).kind !== 'trade' ? ` (${words(byId.get(f.order_id).kind)})` : ''}` : ''}</td><td class="r">${fmtQty(f.qty)}</td>
          <td class="r">${isNum(f.price) ? fmtPriceUnits(f.price, units) : html`<${Missing} reason="No trade price on this fill (a securities borrow is not a purchase)" />`}</td><td class="r"><${Money} value=${f.gross} ccy=${f.ccy} reason="No cash amount on this fill" /></td><td>${f.settle_date || ''}</td><td class="small">${words(f.fill_model)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="muted small">No fills on this instrument in ${book.name}.</div>`}
      ${orders.length > openOrders.length ? html`<details><summary class="note">All paper orders on this instrument (${orders.length})</summary><${OrderTable} rows=${orders} sname=${sname} units=${units} /></details>` : null}
    </section>
    <section class="e3-sec" data-testid="pos-history"><h4>Accounting history</h4>
      ${(d.history || []).length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>When</th><th>Event</th><th>Held in</th><th class="r">Cash</th></tr></thead><tbody>
        ${d.history.map((e) => html`<tr data-event=${e.id}><td class="nowrap">${fmtTime(e.ts)}<div class="sub">business date ${e.businessDate}</div></td><td class="wrap">${e.summary}<div class="sub">${words(e.type)}${e.strategyId ? html`, ${link(sname.get(e.strategyId) || e.strategyId, () => openStrategy(e.strategyId))}` : ''}${e.correctedBy?.length ? ', corrected' : ''}</div></td>
          <td>${e.owner || ''}</td><td class="r">${(e.cash || []).map((c) => html`<div><${Money} value=${c.amount} ccy=${c.ccy} signed /></div>`)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="muted small">No accounting event on this instrument yet.</div>`}
      <p class="note" style="margin:4px 0 0">${d.historyMore ? 'The latest 50 events are listed. ' : ''}The full trail, with every entry, is under <a href="#/accounting/history">Accounting, History</a>.${(d.recordedCorporateActions || []).length ? ` ${d.recordedCorporateActions.length} corporate action${d.recordedCorporateActions.length > 1 ? 's are' : ' is'} recorded in the ledger for this instrument (Corporate actions tab).` : ''}</p>
    </section>
  </div>`;
}

function OrderTable({ rows, sname, units }) {
  return html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Order</th><th>Held in</th><th>Status</th><th class="r">Quantity</th><th class="r">Filled</th><th class="r">Average price</th><th>Placed</th></tr></thead><tbody>
    ${rows.map((o) => html`<tr data-order=${o.id}><td>${words(o.action)} ${words(o.kind) !== 'trade' ? `(${words(o.kind)})` : ''}, ${o.order_type}${isNum(o.limit_price) ? ` ${fmtPriceUnits(o.limit_price, units)}` : ''}<div class="sub">${link(sname.get(o.strategy_id) || o.strategy_id, () => openStrategy(o.strategy_id), 'Open the strategy drawer')}</div></td>
      <td>${o.owner || ''}</td><td>${words(o.status)}${o.status_reason ? html`<div class="sub">${o.status_reason}</div>` : ''}</td><td class="r">${fmtQty(o.qty)}</td><td class="r">${fmtQty(o.filled_qty)}</td>
      <td class="r">${isNum(o.avg_price) ? fmtPriceUnits(o.avg_price, units) : html`<span class="muted">no fill yet</span>`}</td><td class="nowrap">${fmtTime(o.created_at)}</td></tr>`)}</tbody></table></div>`;
}

registerTabContent('positions', (p) => html`<${PositionsTab} ...${p} />`);
export { PositionsTab };
