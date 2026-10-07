// Hedge workflow screens.
//
// Shaffer Hedge runs in Analytics Lab. It selects hedge structures, sizes their legs and decides
// which existing hedges apply to an exposure. The Terminal's part, shown here, is to say truthfully
// where a request stands (incomplete, awaiting connection, ready for analysis, recommendation
// ready, executing, executed, dismissed, closed, failed), where a recommendation came from, when it
// was received, which version produced it and whether the exposure it was computed against is
// still the exposure held; to let an incomplete request be completed and saved; to show every
// leg's figures before execution; and to run confirmed paper execution through the normal package
// engine. Nothing in this file chooses or sizes a hedge, and nothing is executed on receipt.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, toast, toastError, useLive } from '../lib/core.js';
import { Awaiting, Button, Checks, Empty, ErrorNote, Field, KV, Missing, Money, Notice, Num, Pill, Prov, Select, Text } from '../lib/ui.js';
import { expectedOf, PreviewModal } from './preview.js';

export const OBJECTIVES = [
  { value: 'downside_protection', label: 'Downside protection' }, { value: 'upside_protection_short', label: 'Upside protection for shorts' },
  { value: 'market_sector_reduction', label: 'Market / sector exposure reduction' }, { value: 'currency_protection', label: 'Currency protection' },
  { value: 'rate_protection', label: 'Rate protection' }, { value: 'credit_protection', label: 'Credit protection' },
  { value: 'volatility_protection', label: 'Volatility protection' }, { value: 'server_defined', label: 'Other (defined by the Strategy on the server)' },
];
export const SCOPES = [{ value: 'trade', label: 'This trade' }, { value: 'strategy_package', label: 'Strategy package' }, { value: 'account', label: 'Account' }, { value: 'book', label: 'Book' }];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.value, s.label]));
const TRIGGER = { post_trade: 'Requested automatically after your fill', strategy_page: 'Requested from the Strategy page', review: 'Requested because the hedged exposure changed', manual: 'Requested by hand' };
const notSupplied = html`<${Missing} reason="Not supplied by Shaffer Hedge" />`;
const val = (x, unit) => (isNum(x) ? `${fmtNum(x, Math.abs(x) >= 100 ? 0 : 2, { sign: false })}${unit ? ` ${unit}` : ''}` : x ? String(x) : notSupplied);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- state, source and freshness ------------------------------------------------------------------------
const STATE = {
  incomplete: ['warn', 'incomplete request'], awaiting_connection: ['', 'awaiting connection'], ready_for_analysis: ['pen', 'ready for analysis'],
  recommendation_ready: ['ok', 'recommendation ready'], executing: ['pen', 'executing'], executed: ['ok', 'executed'], dismissed: ['', 'dismissed'],
  closed: ['', 'closed'], error: ['bad', 'failed'], superseded: ['', 'replaced'],
};
/** How the source of a recommendation is named wherever it appears. A fixture is never called Shaffer Hedge. */
export const sourceWords = (src) => (!src ? '' : src.kind === 'demo-fixture' ? 'demo fixture, not Shaffer Hedge' : src.kind === 'test-fixture' ? 'test fixture, not Shaffer Hedge' : 'Shaffer Hedge');
const isStale = (r) => r.state === 'recommendation_ready' && r.freshness?.status === 'stale';

/** The one state a request is in. `r` is a request or its short form (queue row, position, strategy). */
export function StatePill({ r }) {
  const [tone, words] = STATE[r.state] || ['', r.stateLabel || r.state];
  return html`<span class=${`pill ${isStale(r) ? 'warn' : tone}`} data-state=${r.state} title=${r.message || ''}>${isStale(r) ? 'recommendation stale' : words}</span>`;
}
/** Whether the request can be answered right now, stated apart from whether it is complete. */
export function connectionWords(c) {
  if (!c) return '';
  if (c.reachable) return c.fixture ? `${c.kind === 'demo-fixture' ? 'The demo fixture' : 'The test fixture'} is answering hedge requests, not Shaffer Hedge` : 'Shaffer Hedge can be reached';
  return 'Shaffer Hedge cannot be reached: awaiting connection';
}
/** Source, received time, version and freshness of a stored recommendation. */
export function SourceFacts({ r, stacked }) {
  const s = r.source;
  if (!s) return null;
  const f = r.freshness;
  const parts = [
    s.kind === 'shaffer-hedge' ? 'Shaffer Hedge' : html`<span class="pill warn" title="Fixture data standing in for the service. It is not Shaffer Hedge output.">${sourceWords(s)}</span>`,
    `received ${fmtTime(s.receivedAt)}`,
    html`version ${s.version ? s.version : html`<span class="missing" title="The service did not supply a model, run or version id">not supplied</span>`}`,
    f ? (f.status === 'stale' ? html`<span class="pill warn" title=${f.changes.join(' ')}>stale</span>` : html`<span title="The position, the hedges held and the scope are unchanged since it was received">current</span>`) : null,
    f?.cached ? html`<span class="muted">${f.cachedNote}</span>` : null,
  ].filter(Boolean);
  return html`<span class="hsrc">${parts.map((x, i) => html`${i ? (stacked ? html`<br />` : ', ') : ''}${x}`)}</span>`;
}

// ---- investment Strategies ------------------------------------------------------------------------------------
/** An investment Strategy reference as it reads everywhere: a listed Strategy with its ID, or a typed name marked unresolved. */
export function StrategyRef({ s, missing = 'Not set' }) {
  if (!s || (!s.name && !s.id)) return html`<${Missing} reason=${missing} />`;
  const resolved = s.resolved === true && Boolean(s.id);
  return html`<span class="stratref">${s.name || s.id}${resolved
    ? html` <span class="muted small" title=${`Stable ID from ${s.source || 'Analytics Lab'}${s.version ? `, version ${s.version}` : ''}`}>${s.id}</span>`
    : html` <span class="pill warn" title=${s.note || 'A name typed while the Strategy list was not available. It is not an ID and is not treated as one.'}>unresolved name</span>`}</span>`;
}

/**
 * Choose the investment Strategy. With the list from Analytics Lab available the choice is a listed
 * Strategy and its ID is what is stored. Without it a name can be typed; it is kept as typed and
 * marked unresolved. An exact-name match is offered, and applied only when the user confirms it.
 * value / onChange: { id, name, resolved: true } | { id: null, name, resolved: false } | null
 */
export function StrategyPicker({ value, onChange }) {
  const res = useLive(() => get('/api/analytics/strategies'), [], { interval: false });
  const d = res.data;
  if (!d) return html`<input disabled placeholder="Loading the Strategy list…" />`;
  const typed = value && value.resolved !== true ? value.name || '' : '';
  if (!d.available) {
    return html`<${Text} value=${typed || (value?.resolved ? value.name : '')} onInput=${(v) => onChange(v.trim() ? { id: null, name: v, resolved: false } : null)} placeholder="Type the Strategy's name" />
      <div class="hint">Strategy list: ${d.awaitingMessage}. A typed name is stored as an unresolved name until the list is available.</div>`;
  }
  const match = typed ? d.items.find((s) => s.name.toLowerCase() === typed.trim().toLowerCase()) : null;
  return html`<${Select} value=${value?.resolved ? value.id : ''} placeholder=${typed ? `Unresolved name: ${typed}` : 'Choose a Strategy'} options=${d.items.map((s) => ({ value: s.id, label: `${s.name} (${s.id})` }))}
      onChange=${(id) => { const s = d.items.find((x) => x.id === id); onChange(s ? { id: s.id, name: s.name, resolved: true, source: d.source?.label, version: s.version } : typed ? value : null); }} />
    <div class="hint">List supplied by ${d.source?.label || 'Analytics Lab'}. The Strategy's ID is stored and sent.
      ${typed ? html` "${typed}" was typed and is unresolved.${match ? html` <button type="button" class="btn link small" onClick=${() => onChange({ id: match.id, name: match.name, resolved: true, source: d.source?.label, version: match.version })}>Use the listed Strategy ${match.name} (${match.id})</button>` : ' Choose the listed Strategy it stands for.'}` : null}</div>`;
}
/** The reference a form sends: an ID when resolved, otherwise the typed name. */
export const strategyInput = (v) => (!v ? null : v.resolved && v.id ? { id: v.id, name: v.name, resolved: true, source: v.source || undefined, version: v.version ?? undefined } : v.name ? { name: v.name } : null);

// ---- what was sent -----------------------------------------------------------------------------------------------
const hedgeName = (h) => `${fmtQty(Math.abs(h.quantity))} ${h.instrument?.symbol || h.instrument?.name || 'hedge'}`;
const RELATION = { linked: 'linked to this position', shared: 'shared, allocated by the service', allocated_elsewhere: 'allocated to another position', unassessed: 'not assessed' };

/** What the Terminal sent: the facts a hedge request must carry. */
export function RequestSummary({ r }) {
  const q = r.request;
  const p = q.primary;
  const proposed = (q.proposedLegs || []).filter((l) => l.isProtection).length;
  const held = q.hedgesHeld || q.existingHedges || [];
  const linked = q.linkedProtection || [];
  const context = held.filter((h) => h.relation && h.relation !== 'linked');
  return html`<${KV} rows=${[
    ['Instrument', p?.instrument ? `${p.instrument.symbol || p.instrument.name}${p.instrument.symbol ? `, ${p.instrument.name}` : ''}` : html`<${Missing} reason="No single instrument for this scope" />`],
    p ? ['Direction and amount', `${p.direction === 'short' ? 'Short' : 'Long'} ${isNum(p.quantity) ? fmtQty(p.quantity) : ''}${isNum(p.notional) ? ` (${fmtMoney(p.notional, p.currency)} notional at the current mark${p.priceObservation && isNum(p.priceObservation.value) ? ` of ${fmtPrice(p.priceObservation.value)}` : ''})` : ''}${p.status === 'filled' ? `, filled at ${fmtPrice(p.averagePrice)}` : ', proposed'}`] : null,
    ['Book and Account', `${q.book.name} / ${q.account ? (q.account.kind === 'treasury' ? 'Treasury' : q.account.name) : 'whole Book'}`],
    ['Hedge scope', SCOPE_LABEL[q.scope.type] || q.scope.type],
    ['Investment Strategy', html`<${StrategyRef} s=${q.investmentStrategy} />`],
    ['Intended holding period', q.holdingPeriod?.days ? `${q.holdingPeriod.days} days` : q.holdingPeriod?.until || q.holdingPeriod?.label || html`<${Missing} reason="Not set" />`],
    ['Hedge objective', q.objective?.label || html`<${Missing} reason="Not set" />`],
    ['Linked protection', linked.length ? linked.map((h) => `${hedgeName(h)}${isNum(h.allocatedUnits) && h.allocatedUnits ? ` (${fmtQty(h.allocatedUnits)} units)` : h.capacity?.units === 0 ? ' (written option, not counted)' : ''}`).join(', ') : 'None'],
    proposed ? ['Protection in the template', `${plural(proposed, 'leg')}, sent as proposed protection`] : null,
    context.length ? ['Other hedges held', html`${context.map((h, i) => html`${i ? html`<br />` : null}${hedgeName(h)}: ${RELATION[h.relation] || h.relation}${h.relation === 'allocated_elsewhere' && isNum(h.capacityLeft) ? `, ${fmtQty(h.capacityLeft)} units of capacity left` : ''}`)}
      <div class="sub">Sent as context. Whether they apply to this exposure is for Analytics Lab to decide; they are not counted as protection here.</div>`] : null,
    ['Exposures sent', `${plural(q.exposures.positions.length, 'open position')} in the ${q.exposures.scope === 'book' ? 'Book' : 'Account'} (facts only; sensitivities are computed by Analytics Lab)`],
    ['Request', `${r.id}, ${fmtTime(r.createdAt)}${q.refreshedAt ? `, refreshed ${fmtTime(q.refreshedAt)}` : ''}`],
  ]} />`;
}

/** What the service said about existing hedges, and what the Terminal did with it after validating. */
function AssessmentResults({ r }) {
  const a = r.protection;
  if (!a || !(a.results || []).length) return null;
  const q = r.request;
  const label = (id) => { const h = (q.hedgesHeld || []).find((x) => x.positionId === id) || (q.exposures?.positions || []).find((x) => x.positionId === id); return h ? hedgeName(h) : id || 'a hedge'; };
  return html`<section class="panel"><header><h3>Protection assessment</h3></header><div class="body stack" style="gap:6px">
    <div class="note">From ${sourceWords(r.source)}, received ${fmtTime(r.source?.receivedAt)}. The Terminal validates and stores it; it does not compute it.${a.illustrative ? ' The fixture uses an illustrative rule.' : ''}</div>
    ${a.results.map((x) => (x.status === 'active' ? html`<div><${Pill} tone="ok">allocated<//> ${fmtQty(x.units)} units of ${label(x.hedgePositionId)} to this position</div>`
      : x.status === 'unrelated' ? html`<div><${Pill}>unrelated<//> ${label(x.hedgePositionId)}</div>`
        : html`<div><${Pill} tone="bad">rejected<//> ${x.verdict === 'unrelated' ? 'Verdict' : `Allocation of ${isNum(x.units) ? fmtQty(x.units) : 'unstated'} units`} for ${label(x.hedgePositionId)}. <span class="sub" style="display:block;white-space:normal">${x.reason}</span></div>`))}
  </div></section>`;
}

/** The state of a request that has no packages to show, in words. */
export function RequestState({ r }) {
  switch (r.state) {
    case 'incomplete': return html`<${Notice} tone="warn"><b>Incomplete request.</b> Still needed: ${r.missing.join(', ')}. It is stored and has not been sent. ${connectionWords(r.connection)}.<//>`;
    case 'awaiting_connection': return html`<${Awaiting} what="The request is complete and stored. It is sent when Shaffer Hedge can be reached, against the exposure as it is then, and the recommendation appears here and in the hedge review queue. The Terminal does not choose or size hedges itself." />`;
    case 'ready_for_analysis': return html`<${Notice}><b>Ready for analysis.</b> The request is complete. ${connectionWords(r.connection)}. It has not been answered yet: it is sent on the next engine cycle, or ask now.<//>`;
    case 'error': return html`<${Notice} tone="err"><b>Failed.</b> ${r.message}<//>`;
    case 'closed': return html`<${Notice}><b>Closed.</b> ${r.message}<//>`;
    case 'dismissed': return html`<${Notice}>This hedge request was dismissed. Request the hedge again to see current instructions.<//>`;
    case 'executed': return html`<${Notice} tone="ok">This hedge was executed and is linked to the position.<//>`;
    case 'executing': return html`<${Notice}>This hedge was confirmed. Some of its legs are still working; open the strategy to follow them.<//>`;
    case 'recommendation_ready': return r.response?.packages?.length ? null : html`<${Notice}>${r.message || 'No packages were returned for this request.'}<//>`;
    default: return null;
  }
}

/** Packages returned for the request, recommended first. */
export function PackageList({ response, selected, onSelect, allowNone }) {
  const list = [...response.packages].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  const src = response.source && typeof response.source === 'object' ? response.source : { kind: response.fixture ? 'demo-fixture' : 'shaffer-hedge' };
  const item = (id, title, sub, pills) => html`<button type="button" key=${id} class=${`hpkg ${selected === id ? 'on' : ''}`} onClick=${() => onSelect(id)} aria-pressed=${selected === id}>
    <div class="row" style="gap:6px;flex-wrap:wrap"><b>${title}</b>${pills}</div>${sub ? html`<div class="sub muted small" style="white-space:normal">${sub}</div>` : null}</button>`;
  return html`<div class="stack" style="gap:6px">
    ${allowNone ? item('', 'No hedge with this package', 'The primary trade goes ahead on its own.') : null}
    ${list.map((p) => item(p.id, p.label, p.intendedProtection || (p.riskAddressed || []).join(', '),
      html`${p.recommended ? html`<${Pill} tone="ok">recommended<//>` : html`<${Pill}>alternative<//>`}${src.kind !== 'shaffer-hedge' ? html`<${Pill} tone="warn" title="Fixture data, not Shaffer Hedge output">${src.kind === 'test-fixture' ? 'test fixture' : 'demo fixture'}<//>` : null}`))}
  </div>`;
}

// ---- legs ------------------------------------------------------------------------------------------------------------
const F = ({ k, children, sub }) => html`<div class="hf"><span class="k">${k}</span><span class="v">${children}</span>${sub ? html`<span class="s">${sub}</span>` : null}</div>`;
const none = html`<span class="muted">none</span>`;

/**
 * One leg as a block of labelled figures: quantity, quote or indicative terms, premium or price,
 * fees, margin, collateral, financing requirement and notional. The fields wrap to the width
 * available, so nothing is cut off on a narrow screen.
 */
function LegCard({ leg }) {
  const p = leg.price;
  const fee = leg.feeTotal || 0;
  const ia = leg.collateral?.independent;
  const sc = leg.shortCollateral;
  const fin = leg.financing;
  const collateral = ia && isNum(ia.delta) ? ia.delta : sc ? sc.topUp : null;
  // An OTC contract's independent amount is collateral: when the leg's margin figure is that same amount it is shown once, as collateral.
  const sameMoney = ia && isNum(ia.delta) && leg.initialMargin && Math.abs(ia.delta - leg.initialMargin) < 0.005;
  const margin = (sameMoney ? 0 : leg.initialMargin || 0) + (sc?.marginHold || 0);
  // A future pays no premium: the cash that moves at trade is its margin, shown under Margin and not as a price paid.
  const marginOnly = !ia && leg.initialMargin > 0 && isNum(leg.cash) && Math.abs(Math.abs(leg.cash) - leg.initialMargin) < 0.005;
  return html`<div class="hleg" data-leg=${leg.n}>
    <div class="hleg-head"><span class="leg-n">${leg.n}</span>
      <div class="grow"><div class="strong">${leg.label}</div>
        <div class="sub">${leg.purpose === 'financing' ? 'Financing' : leg.hedgeFamily || leg.kindLabel}${leg.riskAddressed ? `, addresses ${String(leg.riskAddressed).toLowerCase()}` : ''}${leg.dependsOn?.length ? `, after leg ${leg.dependsOn.join(', ')}` : ''}</div>
        ${leg.sizingBasis || isNum(leg.hedgeRatio) ? html`<div class="sub">Sized by ${leg.sizingBasis || 'the ratio supplied'}${isNum(leg.hedgeRatio) ? `, ratio ${leg.hedgeRatio}` : ''}</div>` : null}</div></div>
    <div class="hleg-fields">
      <${F} k="Quantity" sub=${leg.qtyLabel}>${fmtQty(leg.qty)}<//>
      <${F} k="Quote or indicative terms" sub=${html`${p?.label || (leg.kind === 'trade' ? '' : leg.kindLabel)}${leg.indicative ? html`${p?.label ? html`<br />` : null}Indicative ${fmtPrice(leg.indicative.value)} (${leg.indicative.status}, ${leg.indicative.source}). Not an executable quote.` : null}`}>
        ${leg.kind !== 'trade' ? html`<span class="muted">not quoted</span>` : isNum(p?.estimate) ? html`<span class="price"><span class="v">${fmtPrice(p.estimate)}</span></span>${p?.observation ? html` <${Prov} obs=${p.observation} />` : null}` : html`<span class="missing" title=${p?.reason || ''}>no executable quote</span>`}<//>
      <${F} k="Premium or price" sub=${marginOnly ? 'no premium; margin is posted instead' : isNum(leg.cash) ? (leg.cash < 0 ? 'paid at trade' : leg.cash > 0 ? 'received at trade' : 'no cash at trade') : ''}>
        ${marginOnly ? none : isNum(leg.cash) ? html`<${Money} value=${leg.cash} ccy=${leg.currency} signed />` : leg.kind === 'trade' && !leg.initialMargin ? html`<${Missing} reason="Needs a price" />` : none}<//>
      <${F} k="Fees">${fee ? fmtMoney(-fee, leg.currency, { sign: true }) : none}<//>
      <${F} k="Margin" sub=${!margin ? '' : sc ? 'margin hold against the short' : 'initial margin to post'}>${margin ? fmtMoney(margin, leg.currency) : none}<//>
      <${F} k="Collateral" sub=${ia ? `independent amount${leg.collateral?.basis?.label ? `, ${String(leg.collateral.basis.label).replace(/^./, (c) => c.toLowerCase())}` : ''}` : sc ? 'top-up on the short-sale proceeds' : ''}>${isNum(collateral) && collateral ? fmtMoney(collateral, ia?.ccy || leg.currency) : none}<//>
      <${F} k="Financing requirement" sub=${fin && isNum(fin.rate) ? `rate ${fmtNum(fin.rate * 100, 3)}% ${fin.rateType || ''}${fin.maturity ? `, to ${fin.maturity}` : ''}` : leg.borrowInfo ? `${leg.borrowInfo.source || 'borrow'}${isNum(leg.borrowInfo.dailyCost) ? `, about ${fmtMoney(leg.borrowInfo.dailyCost, leg.currency)} a day` : ''}` : isNum(leg.dailyCost) ? `about ${fmtMoney(leg.dailyCost, leg.currency)} a day` : ''}>
        ${fin && isNum(fin.amount) ? fmtMoney(Math.abs(fin.amount), fin.ccy || leg.currency) : leg.borrowInfo ? `${fmtQty(leg.borrowInfo.needed)} to borrow` : none}<//>
      <${F} k="Notional">${isNum(leg.notional) ? fmtMoney(leg.notional, leg.currency) : none}<//>
    </div>
    ${leg.instrument?.details?.length ? html`<details open=${Boolean(leg.instrument.draft) && leg.instrument.family !== 'option'}><summary class="note">Contract terms</summary><dl class="terms">${leg.instrument.details.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl></details>` : null}
  </div>`;
}

/**
 * Cost and cash requirement of the package. Every figure is taken from the legs as the Terminal
 * priced them in ONE snapshot, so the lines add up to the total and match what would be confirmed.
 */
function CostTable({ pv }) {
  const rows = Object.values(pv.totals.cash || {});
  if (!rows.length) return html`<p class="note">No cash moves at trade for this package.</p>`;
  const optionLegs = pv.legs.filter((l) => l.kind === 'trade' && ['option', 'otcoption'].includes(l.instrument?.family) && isNum(l.cash));
  const premPaid = (ccy) => optionLegs.filter((l) => l.currency === ccy && l.cash < 0).reduce((a, l) => a - l.cash, 0);
  const premRecv = (ccy) => optionLegs.filter((l) => l.currency === ccy && l.cash > 0).reduce((a, l) => a + l.cash, 0);
  const line = (label, f, opts = {}) => (rows.some((r) => Math.abs(f(r)) > 0.004) || opts.always ? html`<tr class=${opts.strong ? 'strong' : ''}><td class="wrap">${label}</td>${rows.map((r) => html`<td class="r">${Math.abs(f(r)) > 0.004 || opts.always ? fmtMoney(f(r), r.ccy) : ''}</td>`)}</tr>` : null);
  return html`<div class="tablewrap"><table class="ledger"><thead><tr><th>From the legs above, one snapshot</th>${rows.map((r) => html`<th class="r">${r.ccy}</th>`)}</tr></thead><tbody>
    ${line('Option premiums paid', (r) => premPaid(r.ccy))}
    ${line('Other purchases', (r) => r.purchases - premPaid(r.ccy))}
    ${line('Fees and commissions', (r) => r.fees)}
    ${line('Margin and collateral to post', (r) => r.margin + r.collateral)}
    ${line('Cash reserved against written options', (r) => r.reserved)}
    ${line('Cash required', (r) => r.required, { always: true, strong: true })}
    ${line('Option premiums received', (r) => premRecv(r.ccy))}
    ${line('Other sale proceeds', (r) => r.proceeds - premRecv(r.ccy))}
    ${line('Available to trade now', (r) => r.available, { always: true })}
    <tr><td>Shortfall</td>${rows.map((r) => html`<td class=${`r ${r.shortfall > 0 ? 'loss strong' : ''}`}>${r.shortfall > 0 ? fmtMoney(r.shortfall, r.ccy) : 'none'}</td>`)}</tr>
  </tbody></table></div>`;
}

/** The totals that stay in view while the legs scroll: one line per currency, from the same snapshot. */
function TotalsBar({ pv, loading }) {
  if (!pv) return html`<div class="hedge-totals"><span class="muted">${loading ? 'Pricing the legs…' : 'No priced package to total.'}</span></div>`;
  const rows = Object.values(pv.totals.cash || {});
  return html`<div class="hedge-totals" data-testid="hedge-totals">
    ${rows.length ? rows.map((r) => html`<div class="ht-row">
      <span class="ht"><span class="k">Cash required</span><b>${fmtMoney(r.required, r.ccy)}</b></span>
      <span class="ht"><span class="k">Fees</span>${fmtMoney(r.fees, r.ccy)}</span>
      <span class="ht"><span class="k">Margin and collateral</span>${fmtMoney(r.margin + r.collateral, r.ccy)}</span>
      <span class="ht"><span class="k">Available</span>${fmtMoney(r.available, r.ccy)}</span>
      <span class="ht"><span class="k">Shortfall</span><span class=${r.shortfall > 0 ? 'loss strong' : ''}>${r.shortfall > 0 ? fmtMoney(r.shortfall, r.ccy) : 'none'}</span></span>
    </div>`) : html`<span class="muted">No cash moves at trade for this package.</span>`}
    <span class="ht-note">${plural(pv.legs.length, 'leg')}, one snapshot at ${fmtTime(pv.generatedAt, { date: false, seconds: true })}${pv.blocking ? html`, <span class="loss strong">${plural(pv.blocking, 'blocking item')}</span>` : ''}</span>
  </div>`;
}

/** One package: what the service said about it, and what the Terminal found when it priced and validated the legs. */
export function PackageDetail({ pkg, pv, loading, error, onRefresh, onAcknowledge }) {
  const c = pkg.costs;
  // The estimate that came with the recommendation is kept apart from the Terminal's own figures.
  const est = c ? [['premiums', c.premiums], ['upfront cash', c.upfrontCash], ['expected ongoing cost', c.expectedOngoing], ['margin', c.margin], ['collateral', c.collateral], ['borrowing', c.borrowing], ['funding', c.funding]].filter(([, v]) => isNum(v) && v !== 0) : [];
  const prot = pv?.protection;
  return html`<div class="stack">
    <${KV} rows=${[
      ['Risk addressed', pkg.riskAddressed?.length ? pkg.riskAddressed.join(', ') : notSupplied],
      ['Intended protection', pkg.intendedProtection || notSupplied],
      ['Horizon', pkg.horizon?.until ? `Until ${pkg.horizon.until}` : pkg.horizon?.days ? `${pkg.horizon.days} days` : notSupplied],
      ['Upside surrendered', pkg.upsideSurrendered || notSupplied],
      ['Valuation and availability', pkg.valuation ? `${pkg.valuation.source}${pkg.valuation.status ? ` (${pkg.valuation.status})` : ''}${pkg.valuation.asOf ? `, ${fmtTime(pkg.valuation.asOf)}` : ''}${pkg.valuation.availability ? `. ${pkg.valuation.availability}` : ''}` : notSupplied],
    ]} />
    ${pkg.exposure?.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Exposure measure</th><th class="r">Before</th><th class="r">After</th><th class="r">Residual</th><th>Basis risk</th></tr></thead><tbody>
      ${pkg.exposure.map((e) => html`<tr><td>${e.measure}</td><td class="r">${val(e.before, e.unit)}</td><td class="r">${val(e.after, e.unit)}</td><td class="r">${val(e.residual, e.unit)}</td><td class="wrap">${e.basisRisk || notSupplied}</td></tr>`)}
    </tbody></table></div>` : null}
    ${pkg.scenarios?.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Scenario</th><th class="r">Unhedged</th><th class="r">Hedged</th></tr></thead><tbody>
      ${pkg.scenarios.map((s) => html`<tr><td>${s.label}</td><td class="r">${val(s.unhedged, s.unit)}</td><td class="r">${val(s.hedged, s.unit)}</td></tr>`)}</tbody></table></div>` : null}
    ${(pkg.notes || []).map((n) => html`<div class="note">${n}</div>`)}
    <div class="row" style="flex-wrap:wrap"><h4>Legs, priced and checked by the Terminal</h4><span class="grow"></span>
      ${pv ? html`<span class="note">One snapshot, priced at ${fmtTime(pv.generatedAt, { date: false, seconds: true })}</span>` : null}
      ${onRefresh ? html`<${Button} small busy=${loading} onClick=${onRefresh}>Refresh prices<//>` : null}</div>
    <${ErrorNote} error=${error} />
    ${!pv ? (error ? null : html`<${Empty}>${loading ? 'Pricing the legs…' : ''}<//>`) : html`
      <div class="hlegs" data-testid="hedge-legs">${pv.legs.map((l) => html`<${LegCard} key=${l.n} leg=${l} />`)}</div>
      <${CostTable} pv=${pv} />
      ${est.length ? html`<div class="note">Estimate that came with the recommendation${c.basis ? ` (${c.basis})` : ''}: ${est.map(([k, v]) => `${k} ${fmtMoney(v, c.currency)}`).join(', ')}. It was made when the package was proposed and is for comparison only: the figures above are the ones a confirmation would use.</div>` : null}
      ${prot?.needsAcknowledgement && !prot.acknowledged && onAcknowledge ? html`<${Notice} tone="warn"><b>Protection is already in place.</b> ${prot.prior.map((x) => x.label).join('; ')}. ${prot.explain}
        <div style="margin-top:6px"><${Button} small onClick=${onAcknowledge}>Add this protection deliberately<//></div><//>` : null}
      <${Checks} checks=${pv.checks.filter((k) => !(k.code === 'extra-protection' && k.level === 'error' && onAcknowledge) && k.code !== 'hedge-stale')} />`}
  </div>`;
}

/** Load the Terminal's priced, validated view of one proposed package. `reload` prices it again; `set` replaces it. */
export function usePackagePreview(requestId, packageId, stamp = '') {
  const [box, setBox] = useState({ pv: null, error: null, loading: false });
  const [extra, setExtra] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => { setExtra(false); }, [requestId, packageId]);
  useEffect(() => {
    if (!requestId || !packageId) { setBox({ pv: null, error: null, loading: false }); return undefined; }
    let live = true;
    setBox((b) => ({ pv: n ? b.pv : null, error: null, loading: true }));
    post(`/api/hedge/requests/${requestId}/preview`, { packageId, extraProtection: extra || undefined }).then(
      (pv) => { if (live) setBox({ pv, error: null, loading: false }); },
      (error) => { if (live) setBox({ pv: null, error, loading: false }); });
    return () => { live = false; };
  }, [requestId, packageId, extra, n, stamp]);
  return { ...box, reload: () => setN((x) => x + 1), acknowledge: () => setExtra(true), set: (pv) => setBox({ pv, error: null, loading: false }) };
}

// ---- completing a request ------------------------------------------------------------------------------------------
/**
 * Investment Strategy, intended holding period, hedge objective and scope: what a request needs
 * before it can be sent. "Save request" stores it under the same request; when it is complete and
 * the service can be reached it is sent, otherwise it waits.
 */
function CompletionForm({ r, onSaved, main }) {
  const q = r.request;
  const [ctx, setCtx] = useState({ strategy: q.investmentStrategy || null, days: q.holdingPeriod?.days ?? null, objective: q.objective?.type || '', scope: q.scope.type });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // When the stored request changes under the form (saved, refreshed), the form follows it. Not on first
  // display: what has been typed since the form opened must never be reset by a late effect.
  const shown = useRef(`${r.id}|${r.updatedAt}`);
  useEffect(() => {
    const key = `${r.id}|${r.updatedAt}`;
    if (shown.current === key) return;
    shown.current = key;
    setCtx({ strategy: q.investmentStrategy || null, days: q.holdingPeriod?.days ?? null, objective: q.objective?.type || '', scope: q.scope.type });
  }, [r.id, r.updatedAt]);
  const same = (a, b) => (a?.resolved ? a.id : a?.name || '') === (b?.resolved ? b.id : b?.name || '') && Boolean(a?.resolved) === Boolean(b?.resolved);
  const changed = !same(ctx.strategy, q.investmentStrategy) || (ctx.days ?? null) !== (q.holdingPeriod?.days ?? null) || ctx.objective !== (q.objective?.type || '') || ctx.scope !== q.scope.type;
  const left = [!ctx.strategy?.name && !ctx.strategy?.id ? 'investment Strategy' : '', !ctx.objective ? 'hedge objective' : '', !(ctx.days > 0) && !q.holdingPeriod?.until && !q.holdingPeriod?.label ? 'intended holding period' : ''].filter(Boolean);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const next = await post(`/api/hedge/requests/${r.id}/complete`, {
        investmentStrategy: strategyInput(ctx.strategy), holdingPeriod: ctx.days ? { days: ctx.days } : undefined, objective: ctx.objective ? { type: ctx.objective } : undefined, scope: { type: ctx.scope },
      });
      toast(next.state === 'incomplete' ? `Request saved. Still needed: ${next.missing.join(', ')}.` : next.state === 'recommendation_ready' ? 'Request saved and sent. A recommendation came back.' : next.state === 'awaiting_connection' ? 'Request saved. It is complete and waits for Shaffer Hedge.' : 'Request saved.', next.state === 'incomplete' ? 'warn' : 'ok', 6000);
      bump();
      onSaved(next);
    } catch (err) { setError(err); }
    setBusy(false);
  };
  return html`<div class=${main ? 'hcomplete main' : 'hcomplete'} data-testid="hedge-complete-form">
    ${main ? html`<h3>Complete the request</h3><p class="note" style="margin:0">A hedge request needs these before it can be sent. Fill them in and save; the request keeps its place on the position and in the review queue.</p>` : null}
    <${ErrorNote} error=${error} />
    <div class="grid-form">
      <${Field} label="Investment Strategy" span=${2}><${StrategyPicker} value=${ctx.strategy} onChange=${(v) => setCtx({ ...ctx, strategy: v })} /><//>
      <${Field} label="Intended holding period (days)"><${Num} value=${ctx.days} onInput=${(v) => setCtx({ ...ctx, days: v })} /><//>
      <${Field} label="Hedge objective" span=${2}><${Select} value=${ctx.objective} onChange=${(v) => setCtx({ ...ctx, objective: v })} options=${OBJECTIVES} placeholder="Choose an objective" /><//>
      <${Field} label="Scope"><${Select} value=${ctx.scope} onChange=${(v) => setCtx({ ...ctx, scope: v })} options=${SCOPES} /><//>
    </div>
    <div class="row" style="flex-wrap:wrap"><${Button} kind=${main ? 'primary' : ''} busy=${busy} disabled=${!changed} onClick=${save}>Save request<//>
      <span class="note">${left.length ? `After saving, still needed: ${left.join(', ')}.` : r.connection?.reachable ? 'Complete. Saving sends it for analysis.' : 'Complete. Saving stores it; it is sent when Shaffer Hedge can be reached.'}</span></div>
  </div>`;
}

/**
 * The Hedge popup. Opens after a direct Marketplace fill (Workflow 2), and from a strategy when a
 * hedge is requested or needs review. It shows the request's state, its source and freshness, the
 * form to complete it when it is incomplete, and the packages with every leg's figures. Totals and
 * the Execute, Inspect and Dismiss controls stay in view while the legs scroll. Dismissing leaves
 * the primary position unchanged.
 */
export function HedgePopup({ request, onClose, onDone }) {
  const [r, setR] = useState(request);
  const q = r.request;
  const packages = r.response?.packages || [];
  const [sel, setSel] = useState(r.response?.recommendedId || packages[0]?.id || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const ready = r.state === 'recommendation_ready' && packages.length > 0;
  const pkg = ready ? packages.find((p) => p.id === sel) || packages[0] : null;
  const box = usePackagePreview(r.id, pkg?.id, `${r.updatedAt}|${r.freshness?.status}`);
  const open = ['incomplete', 'awaiting_connection', 'ready_for_analysis', 'recommendation_ready', 'error'].includes(r.state) && ['awaiting', 'received', 'error'].includes(r.status);
  const stale = r.freshness?.status === 'stale';

  // The state moves on by itself (the service answers, the position changes): keep the popup current.
  const live = useLive(() => get(`/api/hedge/requests/${r.id}`), [r.id]);
  useEffect(() => {
    const d = live.data;
    if (!d || busy) return;
    if (d.updatedAt !== r.updatedAt || d.state !== r.state || d.freshness?.status !== r.freshness?.status || d.connection?.reachable !== r.connection?.reachable) adopt(d);
  }, [live.data]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  function adopt(next) {
    setR(next);
    const list = next.response?.packages || [];
    if (!list.some((p) => p.id === sel)) setSel(next.response?.recommendedId || list[0]?.id || '');
  }
  const act = async (name, fn) => { setBusy(name); setError(null); try { await fn(); } catch (err) { setError(err); } setBusy(''); };
  const refresh = () => act('refresh', async () => { adopt(await post(`/api/hedge/requests/${r.id}/refresh`)); bump(); });
  const again = () => act('again', async () => {
    const next = await post('/api/hedge/requests', { bookId: r.bookId, unitId: r.unitId, strategyId: r.strategyId || undefined, scope: { type: q.scope.type }, trigger: 'manual',
      instrumentId: q.primary?.instrument?.terminalId, direction: q.primary?.direction, quantity: q.primary?.quantity,
      investmentStrategy: strategyInput(q.investmentStrategy), holdingPeriod: q.holdingPeriod, objective: q.objective?.type ? { type: q.objective.type } : null });
    adopt(next); bump();
  });
  const dismiss = async () => {
    setBusy('dismiss');
    try { if (open) await post(`/api/hedge/requests/${r.id}/dismiss`); bump(); onClose(); } catch (err) { setError(err); setBusy(''); }
  };
  const done = (s) => { bump(); onDone?.(s); onClose(); };
  const inspect = (pv, banner) => openOverlay((close) => html`<${PreviewModal} preview=${pv} onClose=${close} onDone=${done} confirmLabel="Confirm hedge" banner=${banner} />`);
  // Execute now submits the package exactly as it is displayed: the same legs, under the same
  // confirmation token, together with the cash requirement on screen. The server validates quotes,
  // exposure, funding and collateral again; if anything blocks, or prices have moved away from what
  // is displayed, nothing is submitted and the updated figures are shown instead. A stale
  // recommendation is refused by the server until it has been refreshed.
  const execute = async () => {
    const pv = box.pv;
    if (busy || !pv || stale) return;
    const review = pv.checks.filter((k) => k.level !== 'info');
    if (review.length) { inspect(pv, html`<${Notice} tone="warn">${plural(review.length, 'item')} ${review.length > 1 ? 'need' : 'needs'} a decision before this hedge can be submitted. Deal with ${review.length > 1 ? 'them' : 'it'} here, then confirm.<//>`); return; }
    setBusy('execute'); setError(null);
    try {
      const out = await post('/api/strategies', { ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: expectedOf(pv) });
      const working = out.strategy.orders.filter((o) => ['pending', 'working', 'partial'].includes(o.status) && o.submission === pv.token).length;
      toast(working ? `Hedge submitted. ${plural(working, 'leg')} ${working > 1 ? 'are' : 'is'} working.` : 'Hedge executed and linked to the position.', working ? 'warn' : 'ok', 6000);
      done(out.strategy);
      return;
    } catch (err) {
      if (err.details?.preview) box.set(err.details.preview);
      setError(err);
    }
    setBusy('');
  };

  const title = q.primary?.instrument ? `Hedge for ${q.primary.direction === 'short' ? 'short' : 'long'} ${q.primary.instrument.symbol || q.primary.instrument.name}` : `Hedge for ${q.account?.name || q.book.name}`;
  return html`<div class="scrim" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class="modal wide hedge-modal" role="dialog" aria-modal="true" aria-label=${title} data-testid="hedge-popup" data-state=${r.state}>
      <header><div class="grow"><h2>${title}</h2><div class="note">${TRIGGER[r.trigger] || ''}, request ${r.id}</div></div><button class="x" aria-label="Close" onClick=${onClose}>×</button></header>
      <div class="hedge-status" data-testid="hedge-status">
        <${StatePill} r=${r} />
        <span class="hs-fact">${r.complete ? 'Request complete' : html`<b>Request incomplete</b>: ${r.missing.join(', ')} needed`}</span>
        <span class="hs-fact">${connectionWords(r.connection)}</span>
        ${r.source ? html`<span class="hs-fact hs-src">Recommendation from <${SourceFacts} r=${r} /></span>` : null}
      </div>
      <div class="body">
        <div class="stack">
          <${ErrorNote} error=${error} />
          ${stale ? html`<${Notice} tone="warn"><b>This recommendation is stale.</b> ${r.freshness.changes.join(' ')} It cannot be executed until it is refreshed against current exposure.
            <div style="margin-top:6px"><${Button} small kind="primary" busy=${busy === 'refresh'} onClick=${refresh}>Refresh against current exposure<//></div><//>` : null}
          <div class="hedge-split">
            <div class="stack">
              ${r.state === 'incomplete' ? html`<${RequestState} r=${r} /><${CompletionForm} r=${r} onSaved=${adopt} main />`
    : ready ? html`<${PackageDetail} pkg=${pkg} pv=${box.pv} loading=${box.loading} error=${box.error} onRefresh=${open ? box.reload : null} onAcknowledge=${open ? box.acknowledge : null} />`
      : html`<${RequestState} r=${r} />
        ${r.state === 'ready_for_analysis' || r.state === 'error' ? html`<div class="row"><${Button} kind="primary" busy=${busy === 'refresh'} onClick=${refresh}>${r.state === 'error' ? 'Ask again now' : 'Ask now'}<//><span class="note">Nothing is traded when the answer arrives.</span></div>` : null}
        ${['dismissed', 'closed', 'executed', 'error'].includes(r.state) && r.strategyId && !open ? html`<div class="row"><${Button} busy=${busy === 'again'} onClick=${again}>Request the hedge again<//></div>` : null}
        ${open ? html`<p class="note">You can still add protection by hand: open the position's strategy and choose Add legs, or build a package on the Strategy page with "hedge an existing position".</p>` : null}`}
            </div>
            <div class="stack">
              ${ready ? html`<section class="panel"><header><h3>Packages</h3></header><div class="body"><${PackageList} response=${r.response} selected=${pkg?.id} onSelect=${setSel} /></div></section>` : null}
              <${AssessmentResults} r=${r} />
              <section class="panel"><header><h3>${r.response ? 'What was sent' : r.state === 'incomplete' ? 'What will be sent' : 'What is stored to send'}</h3></header><div class="body stack">
                <${RequestSummary} r=${r} />
                ${open && r.state !== 'incomplete' ? html`<details><summary class="note">Change the request</summary><div style="margin-top:8px"><${CompletionForm} r=${r} onSaved=${adopt} /></div></details>` : null}
              </div></section>
            </div>
          </div>
        </div>
      </div>
      ${ready ? html`<${TotalsBar} pv=${box.pv} loading=${box.loading} />` : null}
      <footer>
        <span class="note hedge-foot-note">${ready ? 'Closing this leaves the primary position exactly as it is.' : open ? 'The request stays on the position and in the hedge review queue.' : ''}</span><span class="grow"></span>
        ${open && ready ? html`<${Button} busy=${busy === 'dismiss'} onClick=${dismiss}>Dismiss, no hedge<//>` : html`<${Button} onClick=${onClose}>Close<//>`}
        ${open && !ready ? html`<${Button} busy=${busy === 'dismiss'} onClick=${dismiss} title="Remove this request from the review queue">Withdraw the request<//>` : null}
        ${ready && open ? html`<${Button} disabled=${!box.pv} onClick=${() => inspect(box.pv)}>Inspect or edit<//>
          <${Button} kind="primary" busy=${busy === 'execute'} disabled=${Boolean(busy) || box.loading || !box.pv || stale} title=${stale ? 'Refresh the recommendation against current exposure first' : ''} onClick=${execute}>Execute now<//>` : null}
      </footer>
    </div></div>`;
}

/**
 * Hedge review queue of the selected Book: requests that are incomplete, waiting or answered and
 * not yet acted on, hedges still executing, and hedged positions whose exposure has changed. Each
 * row says the state, whether the request is complete, whether the service can be reached, and for
 * a recommendation its source, received time, version and freshness.
 */
export function HedgeQueue({ book, compact }) {
  const res = useLive(() => get('/api/hedge/queue', { bookId: book.id }), [book.id]);
  const [busy, setBusy] = useState(false);
  const d = res.data;
  if (!d || (!d.items.length && !d.reviews.length)) return compact ? null : html`<p class="note">Nothing is waiting for a hedge decision in this Book.</p>`;
  const refresh = async () => { setBusy(true); try { const out = await post('/api/hedge/refresh'); toast(out.refreshed.length ? `${plural(out.refreshed.length, 'request')} refreshed against current exposure.` : d.canAnswer ? 'Nothing new came back.' : `${d.awaitingMessage}. The requests stay in the queue.`, out.refreshed.length ? 'ok' : 'warn'); bump(); } catch (err) { toastError(err); } setBusy(false); };
  const openStrategy = async (id) => { const m = await import('./strategy-detail.js'); m.openStrategy(id); };
  const waiting = d.items.some((x) => ['awaiting_connection', 'ready_for_analysis', 'error'].includes(x.state));
  const svc = d.service;
  return html`<section class="panel" data-testid="hedge-queue"><header><h3>Hedge review queue</h3><span class="note">Nothing here is traded until you confirm it</span><span class="grow"></span>
      <span class="note">${svc?.fixture ? html`<span class="pill warn" title="Fixture data standing in for the service">${svc.kind === 'demo-fixture' ? 'demo fixture answering' : 'test fixture answering'}</span> ` : null}Analytics Lab: ${d.analytics === 'connected' ? 'connected' : 'awaiting'}</span>
      ${waiting ? html`<${Button} small busy=${busy} onClick=${refresh}>Ask again now<//>` : null}</header>
    <div class="body flush"><div class="tablewrap"><table class="ledger margin"><thead><tr><th>Position</th><th>Held in</th><th>State</th><th>Source and freshness</th><th>Asked</th><th></th></tr></thead><tbody>
      ${d.items.map((x) => html`<tr key=${x.id} data-request=${x.id} data-state=${x.state}>
        <td class="wrap"><div class="strong">${x.primary ? `${x.primary.direction === 'short' ? 'Short' : 'Long'} ${fmtQty(x.primary.quantity)} ${x.primary.symbol || x.primary.name}` : `Scope: ${SCOPE_LABEL[x.scope.type] || x.scope.type}`}</div>
          ${x.strategy ? html`<div class="sub"><a href="javascript:void 0" onClick=${() => openStrategy(x.strategy.id)}>${x.strategy.name}</a></div>` : null}
          <div class="sub">Investment Strategy: <${StrategyRef} s=${x.investmentStrategy} missing="Not set" /></div></td>
        <td>${x.owner || book.name}</td>
        <td class="wrap" style="min-width:210px"><${StatePill} r=${x} />
          ${x.state === 'incomplete' ? html`<div class="sub">Needs ${x.missing.join(', ')}. Not sent.</div>` : null}
          ${x.state === 'recommendation_ready' ? html`<div class="sub">${plural(x.packages, 'package')}${x.packages ? '' : `. ${x.message || ''}`}${x.refreshedAt ? ', refreshed on current exposure' : ''}</div>` : null}
          ${x.state === 'error' ? html`<div class="sub">${x.message}</div>` : null}
          ${['incomplete', 'awaiting_connection', 'ready_for_analysis'].includes(x.state) ? html`<div class="sub">${connectionWords(x.connection)}</div>` : null}</td>
        <td class="wrap" style="min-width:220px">${x.source ? html`<${SourceFacts} r=${x} stacked />${x.freshness?.status === 'stale' ? html`<div class="sub">${x.freshness.changes.join(' ')}</div>` : null}` : html`<span class="muted">No recommendation yet</span>`}</td>
        <td class="nowrap">${fmtTime(x.createdAt)}</td>
        <td class="r"><${Button} small onClick=${() => openHedgeRequest(x.id)}>${x.state === 'incomplete' ? 'Complete' : x.state === 'recommendation_ready' ? 'Review' : 'Open'}<//></td></tr>`)}
      ${d.reviews.map((x) => html`<tr key=${`rv-${x.strategy.id}`}>
        <td class="wrap"><div class="strong"><a href="javascript:void 0" onClick=${() => openStrategy(x.strategy.id)}>${x.strategy.name}</a></div><div class="sub">${x.reason}</div></td>
        <td>${x.owner}</td><td><${Pill} tone="warn">exposure changed<//></td><td></td><td class="nowrap">${fmtTime(x.since)}</td>
        <td class="r"><${Button} small onClick=${() => openStrategy(x.strategy.id)}>Open the strategy<//></td></tr>`)}
    </tbody></table></div></div></section>`;
}

// ---- protection of a position ---------------------------------------------------------------------------------------
/**
 * What protects a position, in full: linked protection, shared protection identified by the
 * service (with its source and time), protection allocated elsewhere, unrelated hedges, and, when
 * hedges are held but nobody has assessed them, "Protection assessment unavailable." Remaining
 * exposure is computed only from allocations that exist.
 */
export function ProtectionDetail({ p }) {
  if (!p) return null;
  const basis = { explicit_link: 'linked through its hedge request', template: 'from the execution template' };
  const row = (tone, label, body) => html`<div class="prot-row"><${Pill} tone=${tone}>${label}<//><span>${body}</span></div>`;
  const any = p.linked.length || p.shared.length || p.elsewhere.length || p.unrelated.length || p.unassessed.length || p.rejected.length;
  return html`<div class="prot" data-assessment=${p.assessment}>
    ${p.linked.map((a) => row('ok', 'linked', html`${a.hedge}${a.units !== null ? `, ${fmtQty(a.units)} units` : ', no unit measure (named, not counted)'}, ${basis[a.basis] || a.basis}${a.requestId ? ` ${a.requestId}` : ''}`))}
    ${p.shared.map((a) => row('pen', 'shared', html`${a.hedge}, ${fmtQty(a.units)} units, identified by ${sourceWords(a.source)}${a.source?.version ? ` (version ${a.source.version})` : ''}, ${fmtTime(a.source?.receivedAt || a.since)}${a.stale ? '. The position changed since: ask for a new assessment' : ''}`))}
    ${p.elsewhere.map((e) => row('', 'allocated elsewhere', html`${e.hedge}: ${e.allocatedTo.map((t) => `${t.units !== null ? `${fmtQty(t.units)} units` : 'linked'} to ${t.label}`).join(', ')}${isNum(e.capacityLeft) ? `; ${fmtQty(e.capacityLeft)} units of capacity left` : ''}`))}
    ${p.unrelated.map((u) => row('', 'unrelated', html`${u.hedge}, judged by ${sourceWords(u.source)}, ${fmtTime(u.at)}${u.note ? `. ${u.note}` : ''}`))}
    ${p.unassessed.length ? html`<div class="prot-row"><${Pill} tone="warn">not assessed<//><span><b>Protection assessment unavailable.</b> Held in the Account and not assessed for this position: ${p.unassessed.map((u) => u.hedge).join(', ')}. Not counted.</span></div>` : null}
    ${p.rejected.map((x) => row('bad', 'rejected', html`Allocation of ${isNum(x.units) ? fmtQty(x.units) : 'unstated'} units of ${x.hedge} from ${sourceWords(x.source)}. ${x.reason}`))}
    ${!any ? html`<div class="muted">No protection is linked or allocated to this position.</div>` : null}
    <div class="prot-rem">Exposure ${fmtQty(p.exposureUnits)} units, protected ${fmtQty(p.protectedUnits)}, remaining <b>${fmtQty(p.remainingUnits)}</b>${p.unmeasured.length ? `. Also linked without a unit measure: ${p.unmeasured.join(', ')}` : ''}. Only allocations are counted.</div>
  </div>`;
}
/** The same picture as plain text, for a tooltip. */
export function protectionText(p) {
  if (!p) return '';
  const lines = [
    ...p.linked.map((a) => `Linked: ${a.hedge}${a.units !== null ? `, ${fmtQty(a.units)} units` : ', no unit measure'}${a.requestId ? `, request ${a.requestId}` : ', from the execution template'}`),
    ...p.shared.map((a) => `Shared: ${a.hedge}, ${fmtQty(a.units)} units, identified by ${sourceWords(a.source)}, ${fmtTime(a.source?.receivedAt || a.since)}`),
    ...p.elsewhere.map((e) => `Allocated elsewhere: ${e.hedge}${isNum(e.capacityLeft) ? `, ${fmtQty(e.capacityLeft)} units of capacity left` : ''}`),
    ...p.unrelated.map((u) => `Unrelated: ${u.hedge}, judged by ${sourceWords(u.source)}`),
    ...(p.unassessed.length ? [`Protection assessment unavailable. Not assessed: ${p.unassessed.map((u) => u.hedge).join(', ')}`] : []),
    ...p.rejected.map((x) => `Rejected allocation: ${x.hedge}. ${x.reason}`),
    `Exposure ${fmtQty(p.exposureUnits)} units, protected ${fmtQty(p.protectedUnits)}, remaining ${fmtQty(p.remainingUnits)}. Only allocations are counted.`,
  ];
  return lines.join('\n');
}
/** One line for a position row. */
export function protectionWords(p) {
  if (!p) return null;
  if (p.assessment === 'unavailable') return { tone: 'warn', text: 'Protection assessment unavailable.' };
  if (p.protectedUnits > 0) return { tone: p.remainingUnits > 0 ? 'pen' : 'ok', text: `protected ${fmtQty(p.protectedUnits)} of ${fmtQty(p.exposureUnits)} units` };
  if (p.unmeasured.length) return { tone: 'pen', text: 'hedge linked, no unit measure' };
  if (p.assessment === 'assessed') return { tone: '', text: 'no protection allocated' };
  return null;
}

/** Request hedge instructions for an existing strategy's position and open the popup. One request per position: an open one is reused. */
export async function openHedgeFor(strategy, { trigger = 'manual', scope = 'trade', onDone } = {}) {
  try {
    const r = await post('/api/hedge/requests', {
      bookId: strategy.bookId, unitId: strategy.unit.id, strategyId: strategy.id, scope: { type: scope }, trigger,
      investmentStrategy: strategyInput(strategy.hedge?.investmentStrategy || strategy.investmentStrategy), holdingPeriod: strategy.holdingPeriod, objective: strategy.params?.hedgeObjective || null,
    });
    openOverlay((close) => html`<${HedgePopup} request=${r} onClose=${close} onDone=${onDone} />`);
    return r;
  } catch (err) { toastError(err); return null; }
}

/** Reopen a stored hedge request. */
export async function openHedgeRequest(id, { onDone } = {}) {
  try {
    const r = await get(`/api/hedge/requests/${id}`);
    openOverlay((close) => html`<${HedgePopup} request=${r} onClose=${close} onDone=${onDone} />`);
  } catch (err) { toastError(err); }
}
