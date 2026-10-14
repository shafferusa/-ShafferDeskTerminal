// Option detail page (p1), listed and OTC: Contract terms, Chain (listed), Greeks and volatility.
//   - Underlying: linked to its own workspace; its financial statements are the underlying's, never the option's.
//   - Strike, expiry, exercise and settlement terms, multiplier and deliverable from the contract terms.
//   - Chain: the underlying's chain for this expiry from the existing chain route, with this contract marked.
//   - Greeks and implied volatility: only as supplied (market.optionGreeks), with their provider, model and time; the
//     chain's implied volatility for this strike is shown beside them with its own source. Nothing is calculated here.
//   - Contract price history is the History tab (this contract's own prices).
import { html, useState } from '../../../vendor/preact-htm.js';
import { fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, useLive, useStore } from '../../../lib/core.js';
import { Awaiting, Missing, Notice, Select, Table } from '../../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../../workspace.js';
import { daysBetween, detailRows, none, pageHref, RelatedPanel, sup, SupplyNote, Supplied, TermsBlock, ThisOne, val } from './common.js';

const RIGHT = { C: 'Call', P: 'Put' };
const SHOWN = ['Type', 'Deliverable per contract', 'Right', 'Strike', 'Expiration', 'Exercise', 'Settlement', 'Contract multiplier', 'Multiplier', 'Deliverable', 'Deliverable units per contract', 'Underlying'];

function OptionTerms({ inst, detail, sel }) {
  const t = inst.terms || {};
  const today = useStore((s) => s.status?.today) || new Date().toISOString().slice(0, 10);
  const und = inst.underlying;
  const deliverable = t.deliverable?.shares ?? t.deliverable?.units ?? null;
  const dte = t.expiration ? daysBetween(today, t.expiration) : null;
  const uo = detail?.underlyingObservation;
  const rows = [
    ['Underlying', und ? html`<a href=${pageHref(und.id)}><span class="sym">${und.symbol || und.name}</span></a> <span class="muted small">${und.symbol ? und.name : ''}</span>${uo && isNum(uo.value) ? html`<div class="sub">Underlying price ${fmtPrice(uo.value)} ${uo.currency || ''} (${uo.source}): the underlying's, shown for reference</div>` : ''}` : val(t.underlyingName, 'No underlying registered')],
    ['Right', html`${val(RIGHT[t.right] || t.right, 'Not recorded')}${t.optionType && t.optionType !== 'vanilla' ? html` <span class="muted small">${t.optionType}</span>` : ''}`],
    ['Strike', isNum(t.strike) ? `${fmtPrice(t.strike)} ${inst.tradingCcy}` : val(null, 'No strike recorded')],
    ['Expiry', t.expiration ? html`${t.expiration}${isNum(dte) ? html` <span class="muted small">${dte >= 0 ? `${dte} calendar days from today` : 'expired'}</span>` : ''}` : val(null, 'No expiry recorded')],
    ['Exercise', val(t.exercise ? `${t.exercise[0].toUpperCase()}${t.exercise.slice(1)}` : null, 'Exercise style not recorded')],
    ['Settlement', t.settlement === 'cash' ? 'Cash settled' : t.settlement === 'physical' ? html`Physical delivery of the underlying${und ? html` (<a href=${pageHref(und.id)}>${und.symbol || und.name}</a>)` : ''}` : val(t.settlement, 'Settlement not recorded')],
    ['Multiplier', isNum(inst.multiplier) ? html`${fmtQty(inst.multiplier)} <span class="muted small">premium paid = price x ${fmtQty(inst.multiplier)} per contract</span>` : val(null)],
    ['Deliverable', isNum(deliverable) ? `${fmtQty(deliverable)} units of the underlying per contract${isNum(t.deliverable?.cash) ? ` plus ${t.deliverable.cash} in cash` : ''}` : t.settlement === 'cash' ? 'None (cash settled)' : val(null, 'Deliverable not recorded')],
    ['Premium quoted', `${inst.priceUnits}, ${inst.tradingCcy}`],
    ...detailRows(inst, SHOWN),
  ];
  return html`<div class="stack" data-testid="opt-terms"><div class="ws-cols">
    <${TermsBlock} title="Contract terms" rows=${rows} testid="opt-contract" />
    <div class="stack"><${RelatedPanel} inst=${inst} sel=${sel} />
      <p class="note">Earnings, statements, filings and news are the underlying's: they are on its workspace, not on this contract's.</p></div>
  </div></div>`;
}

/** The underlying's chain for this expiry, this contract marked. */
function OptionChain({ inst }) {
  const t = inst.terms || {};
  const undId = inst.underlying?.id;
  const [exp, setExp] = useState(t.expiration || '');
  const res = useLive(() => (undId ? get(`/api/instruments/${undId}/chain`, { expiration: exp }) : null), [undId, exp]);
  if (!undId) return none('No underlying registered', 'This contract has no registered underlying, so there is no chain to show.');
  const d = res.data;
  if (!d) return html`<div class="ws-loading">Loading the chain…</div>`;
  const reg = (d.registered || []).filter((i) => !t.expiration || i.terms?.expiration === (d.chain?.expiration || exp));
  const mine = (row, right) => row && row.strike === t.strike && right === t.right && (d.chain?.expiration || exp) === t.expiration;
  const cell = (row, right) => (row ? html`<span class=${mine(row, right) ? 'strong' : ''}>${fmtPrice(row.bid)} / ${fmtPrice(row.ask)}</span>${mine(row, right) ? html` <${ThisOne} />` : ''}` : '');
  return html`<div class="stack" data-testid="opt-chain">
    <section class="panel"><header><h3>Chain of ${inst.underlying.symbol || inst.underlying.name}</h3><span class="note">The underlying's listed options; this contract marked</span><span class="grow"></span>
      ${d.available ? html`<div style="width:170px"><${Select} value=${d.chain.expiration} onChange=${setExp} options=${d.chain.expirations.map((e) => ({ value: e, label: e }))} /></div>` : null}</header>
      <div class=${`body ${d.available ? 'flush' : ''}`}>
        ${d.available ? html`
          ${t.expiration && !d.chain.expirations.includes(t.expiration) ? html`<div class="body"><${Notice} tone="warn">This contract's expiry ${t.expiration} is not in the chain supplied for ${inst.underlying.symbol}: it cannot be marked.<//></div>` : null}
          <div class="tablewrap"><table class="ledger tight"><thead><tr><th class="r">Call bid / ask</th><th class="r">IV</th><th class="c">Strike</th><th class="r">Put bid / ask</th><th class="r">IV</th></tr></thead><tbody>
            ${d.chain.strikes.map((k) => { const c = d.chain.calls.find((x) => x.strike === k), p = d.chain.puts.find((x) => x.strike === k);
              const hit = mine(c, 'C') || mine(p, 'P');
              return html`<tr class=${hit ? 'ws-mine' : ''} data-mine=${hit ? '1' : undefined}><td class="r">${cell(c, 'C')}</td><td class="r sub">${c && isNum(c.iv) ? `${fmtNum(c.iv * 100, 1)}%` : ''}</td><td class="c">${fmtPrice(k)}</td><td class="r">${cell(p, 'P')}</td><td class="r sub">${p && isNum(p.iv) ? `${fmtNum(p.iv * 100, 1)}%` : ''}</td></tr>`; })}
          </tbody></table></div>
          <div class="small muted" style="padding:8px 12px">Underlying ${fmtPrice(d.chain.underlying.price)} ${d.chain.underlying.currency}. Source: ${d.chain.source} (${d.chain.status}). Implied volatility is shown where the source supplies it.</div>`
          : html`<${Awaiting} compact what="Option chains are derivative contract data from Shaffer MarketData. The contracts registered on this underlying are listed below." />`}
      </div></section>
    <section class="panel"><header><h3>Registered contracts on ${inst.underlying.symbol || inst.underlying.name}</h3><span class="note">The Terminal's instrument registry${t.expiration ? `, expiry ${d.chain?.expiration || exp}` : ''}</span></header>
      <div class="body flush"><${Table} cls="tight" rows=${reg} rowKey=${(i) => i.id} empty=${{ title: 'No contract registered for this expiry' }} columns=${[
        { label: 'Contract', render: (i) => html`<a href=${pageHref(i.id)}>${i.symbol || i.name}</a> ${i.id === inst.id ? html`<${ThisOne} />` : ''}` },
        { label: 'Right', render: (i) => RIGHT[i.terms?.right] || '' }, { label: 'Strike', align: 'r', render: (i) => fmtPrice(i.terms?.strike) },
        { label: 'Multiplier', align: 'r', render: (i) => fmtQty(i.multiplier) }]} /></div></section>
  </div>`;
}

const GREEK_ROWS = [['delta', 'Delta', 3], ['gamma', 'Gamma', 4], ['theta', 'Theta', 4], ['vega', 'Vega', 4], ['rho', 'Rho', 4]];
function OptionGreeks({ inst, sel, asOf }) {
  const t = inst.terms || {};
  const g = useDataset(sel, 'optionGreeks');
  const undId = inst.family === 'option' ? inst.underlying?.id : null;
  const chain = useLive(() => (undId && t.expiration ? get(`/api/instruments/${undId}/chain`, { expiration: t.expiration }) : null), [undId, t.expiration], { interval: false });
  const row = chain.data?.available ? (t.right === 'P' ? chain.data.chain.puts : chain.data.chain.calls).find((x) => x.strike === t.strike && chain.data.chain.expiration === t.expiration) : null;
  return html`<div class="stack" data-testid="opt-greeks">
    <${DatasetPanel} ds=${g} title="Greeks and implied volatility" note="Only as supplied, with the provider and time" asOf=${asOf}
      what="Greeks and implied volatility of this contract from Shaffer MarketData">
      ${(env) => html`<div class="stack"><table class="ledger tight"><thead><tr><th>Measure</th><th class="r">Value</th><th>Units</th></tr></thead><tbody>
          <tr><td>Implied volatility</td><td class="r" data-testid="opt-iv">${sup(env, 'impliedVol', (v) => `${fmtNum(v * 100, 2)}%`)}</td><td class="small muted">per annum</td></tr>
          ${GREEK_ROWS.map(([k, label, dp]) => html`<tr><td>${label}</td><td class="r">${sup(env, k, (v) => fmtNum(v, dp))}</td><td class="small muted">${env.data?.units?.[k] || ''}</td></tr>`)}
        </tbody></table>
        <div class="small">Model: ${sup(env, 'model', String, 'Model not named')}${isNum(env.data?.underlyingPrice) ? `, underlying at ${fmtPrice(env.data.underlyingPrice)}` : ''}${isNum(env.data?.optionPrice) ? `, option at ${fmtPrice(env.data.optionPrice)}` : ''}</div>
        <${Supplied} by=${env.data?.provider} at=${env.data?.calculatedAt} />
        ${env.data?.note ? html`<${Notice}>${env.data.note}<//>` : null}
        <${SupplyNote}>Shown as supplied for this contract. The Terminal does not calculate Greeks or implied volatility, and they do not change how a paper order is filled.<//></div>`}<//>
    ${undId ? html`<section class="panel"><header><h3>Implied volatility in the chain</h3><span class="note">A second source, shown apart</span></header><div class="body">
      ${!chain.data ? html`<div class="ws-loading">Loading…</div>` : row && isNum(row.iv) ? html`<div class="small">${fmtNum(row.iv * 100, 2)}% for the ${t.strike} ${RIGHT[t.right]?.toLowerCase()} in the chain of ${inst.underlying.symbol} (${chain.data.chain.source}, ${chain.data.chain.status}${chain.data.chain.asOf ? `, ${fmtTime(chain.data.chain.asOf)}` : ''}).</div>`
        : html`<div class="small"><${Missing} reason="The chain supplies no implied volatility for this strike" /> The chain supplies no implied volatility for this contract.</div>`}</div></section>` : null}
  </div>`;
}

registerTabContent('opt-terms', OptionTerms);
registerTabContent('opt-chain', OptionChain);
registerTabContent('opt-greeks', OptionGreeks);
