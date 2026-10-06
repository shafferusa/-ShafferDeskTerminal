// Strategy instance drawer.
//
// One strategy instance (package) with everything linked under its ID: every leg with its status
// and reason, each fill with the price and FX observations that were used for it, the positions
// with their lifecycle actions, the cash held against it, and its audit events. When a required
// leg failed while others filled, the residual exposure is stated and the recovery actions are
// offered; the package is never described as complete in that state. Closing, resizing, rolling,
// retrying and unwinding all go through the trade preview. Hedges are requested from Shaffer
// Hedge; nothing is chosen, sized or traded here without that preview and confirmation.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, currentBook, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, toast, toastError, useLive } from '../lib/core.js';
import { Button, Check, Drawer, Empty, ErrorNote, Field, KV, Missing, Modal, Money, Notice, Num, OrderStatus, Panel, Pill, Price, Prov, PURPOSE_LABEL, Select, StrategyStatus, Table, Text } from '../lib/ui.js';
import { openInstrument, openPreviewAction } from './instrument.js';
import { openHedgeFor, openHedgeRequest } from './hedge.js';

const NOTIONAL_FAMILIES = ['future', 'forward', 'swap', 'cds'];
const FINANCING_FAMILIES = ['loan', 'repo', 'secloan'];
const ACTIVE = ['pending', 'working', 'partial'];
const HOLD_LABEL = { option_margin: 'Cash reserved against short options', exercise_cash: 'Exercise cash for short puts', short_margin: 'Margin held against a short position' };
const TRIGGER = { post_trade: 'After a fill', strategy_page: 'From the Strategy page', review: 'Exposure changed', manual: 'By hand' };
const REQUEST_TONE = { executed: 'ok', received: 'pen', awaiting: 'warn', error: 'bad' };
const CASHFLOW = [['dividend', 'Dividend'], ['coupon', 'Coupon'], ['interest', 'Interest income'], ['return_of_capital', 'Return of capital (lowers cost)'], ['capital_call', 'Capital call (raises cost)'], ['fee', 'Fee'], ['commission', 'Commission'], ['realized', 'Realized P&L'], ['borrow', 'Securities-borrow cost'], ['funding', 'Funding expense'], ['lending', 'Securities-lending income']];
const LIFECYCLE = {
  exercise: { title: 'Exercise', button: 'Record exercise', done: 'Exercise recorded.', note: 'Exercises a long option now. The option position is reduced and the underlying, or its cash value, is delivered at the strike.' },
  assign: { title: 'Early assignment', button: 'Record assignment', done: 'Assignment recorded.', note: 'Simulates the holder exercising against this short option. It never happens by itself before expiration.' },
  barrier: { title: 'Barrier event', button: 'Record barrier event', done: 'Barrier event recorded.', note: 'Records that the barrier was touched. The option is settled at expiration with the barrier taken into account.' },
  redeem: { title: 'Early redemption', button: 'Record early redemption', done: 'Early redemption recorded.', note: 'Issuer call, investor put or tender at a stated price. Accrued interest to today is paid with it.' },
  recall: { title: 'Lender recall', button: 'Record lender recall', done: 'Lender recall recorded.', note: 'The lender asks for the borrowed securities back. Cover the short or arrange a new borrow by the deadline; otherwise a buy-in is forced on that date.' },
  cashflow: { title: 'Manual cash flow', button: 'Record cash flow', done: 'Cash flow recorded.', note: 'A cash amount received or paid on this position that the engine does not generate. Positive is cash received, negative is cash paid.' },
};
const words = (s) => String(s || '').replace(/[._]/g, ' ');
const sentence = (s) => words(s).replace(/^\w/, (c) => c.toUpperCase());
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const unitLabel = (u) => (u.kind === 'treasury' ? 'Treasury' : u.name);
const instName = (i) => (i ? i.symbol || i.name : '');
const link = (label, onClick, title) => html`<a href="javascript:void 0" title=${title} onClick=${onClick}>${label}</a>`;
const group = (o) => (o.purpose === 'reserve' ? 'financing' : o.purpose || 'primary');
/** A timestamp as [date, time with seconds], so it can sit on two lines. */
const when = (iso) => { const t = fmtTime(iso, { seconds: true }); const i = t.lastIndexOf(', '); return i > 0 ? [t.slice(0, i), t.slice(i + 2)] : [t]; };

export function openStrategy(id) {
  if (!id) return;
  openOverlay((close) => html`<${StrategyDrawer} id=${id} onClose=${close} />`);
}

// ---- legs and fills ---------------------------------------------------------------------------------------
function ObsUsed({ obs, none }) {
  if (!obs) return none;
  const v = isNum(obs.value) ? obs.value : isNum(obs.bid) && isNum(obs.ask) ? (obs.bid + obs.ask) / 2 : null;
  const shown = !isNum(v) ? html`<${Missing} reason="No value in this observation" />` : obs.kind === 'fx' ? fmtNum(v, v < 0.1 ? 6 : 4) : obs.kind === 'price' ? fmtPrice(v) : fmtNum(v, 3);
  return html`<div class="nowrap"><span class="strong">${shown}</span> <${Prov} obs=${obs} /></div>
    ${isNum(obs.bid) && isNum(obs.ask) && obs.kind === 'price' ? html`<div class="sub nowrap">bid ${fmtPrice(obs.bid)}, ask ${fmtPrice(obs.ask)}</div>` : null}
    ${obs.kind !== 'price' && obs.kind !== 'fx' && obs.units ? html`<div class="sub">${obs.units}</div>` : null}
    <div class="sub">${obs.kind === 'fx' ? `${obs.subject}, ` : ''}${obs.source}</div><div class="sub">${when(obs.asOf).join(', ')}</div>`;
}
function Fills({ o, rc }) {
  const cell = 'white-space:normal;vertical-align:top';
  return html`<div class="stack" style="gap:6px">
    ${o.fills.length ? html`<table class="ledger"><thead><tr><th>Filled</th><th class="r">Quantity</th><th class="r">Price</th><th>Fill model</th><th>Observation used</th><th>FX observation used</th></tr></thead>
      <tbody>${o.fills.map((f) => html`<tr>
        <td style="vertical-align:top">${when(f.ts).map((x) => html`<div>${x}</div>`)}<div class="sub">${f.settleDate ? `settles ${f.settleDate}` : 'settles at once'}</div></td><td class="r" style=${cell}>${fmtQty(f.qty)}</td>
        <td class="r" style=${cell}>${isNum(f.price) ? html`${fmtPrice(f.price)}<div class="sub">${f.ccy}</div>` : html`<span class="muted" title="This leg is an arrangement, not a priced trade">no price</span>`}${(f.fees || []).map((x) => html`<div class="sub" title=${x.label}>${words(x.kind)} ${fmtMoney(x.amount, x.ccy)}</div>`)}</td>
        <td style=${`${cell};min-width:170px`}><div>${sentence(String(f.model || '').replace(/-/g, ' '))}</div>${f.note ? html`<div class="sub">${f.note}</div>` : null}</td>
        <td style=${cell}><${ObsUsed} obs=${f.priceObservation} none=${html`<span class="muted" title="No market observation was used: the price was stated, contractual, or the leg has no price">none used</span>`} /></td>
        <td style=${cell}><${ObsUsed} obs=${f.fxObservation} none=${!isNum(f.price) || !f.ccy ? html`<span class="muted">not applicable</span>` : f.ccy === rc ? html`<span class="muted">not needed: ${f.ccy} is the reporting currency</span>` : html`<${Missing} reason=${`No FX observation from ${f.ccy} to ${rc} was stored with this fill`} />`} /></td>
      </tr>`)}</tbody></table>` : html`<div class="note">${o.kind === 'trade' ? 'Nothing has filled on this leg.' : 'No fill is recorded for this leg.'}</div>`}
    ${o.settlements.length ? html`<div class="sub">Awaiting settlement: ${o.settlements.map((s, i) => html`${i ? '; ' : ''}${fmtMoney(s.amount, s.ccy, { sign: true })} due ${s.dueDate}${s.status !== 'pending' ? html` <span class="loss">(${s.status}${s.error ? `: ${s.error}` : ''})</span>` : ''}`)}</div>` : null}
    ${o.estimate && isNum(o.estimate.price) ? html`<div class="sub muted">Estimate at preview: ${fmtPrice(o.estimate.price)} (${String(o.estimate.model || '').replace(/-/g, ' ')}). Order ${o.id}, submitted ${fmtTime(o.createdAt)}.</div>` : html`<div class="sub muted">Order ${o.id}, submitted ${fmtTime(o.createdAt)}.</div>`}
  </div>`;
}
function Legs({ s, rc, after }) {
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState('');
  const cancel = async (o) => {
    setBusy(o.id);
    try { await post(`/api/orders/${o.id}/cancel`); toast(`Leg ${o.legNo} cancelled.`); after(); } catch (err) { toastError(err); }
    setBusy('');
  };
  const cancelAll = async () => {
    setBusy('all');
    try { await post(`/api/strategies/${s.id}/action`, { action: 'cancel_working' }); toast('Working legs cancelled.'); after(); } catch (err) { toastError(err); }
    setBusy('');
  };
  const instr = (o) => (o.kind !== 'trade' ? o.kindLabel : `${sentence(o.orderType || 'market')}${isNum(o.limitPrice) ? ` at ${fmtPrice(o.limitPrice)}` : ''}${isNum(o.stopPrice) ? `, stop ${fmtPrice(o.stopPrice)}` : ''}, ${o.tif === 'gtc' ? 'until cancelled' : 'day order'}${isNum(o.statedPrice) ? `, stated fill price ${fmtPrice(o.statedPrice)}` : ''}`);
  const row = (o) => html`<tr key=${o.id}>
      <td><span class="leg-n">${o.legNo}</span>${o.dependsOn?.length ? html`<div class="dep">after leg ${o.dependsOn.join(', ')}</div>` : null}</td>
      <td class="wrap"><div class="strong">${o.label}</div><div class="sub">${instr(o)}</div>
        ${o.intent && o.intent !== 'open' ? html`<div class="sub">Added to ${words(o.intent)}</div>` : null}
        ${isNum(o.resizedFrom) ? html`<div class="sub" style="color:var(--amber)">Resized from ${fmtQty(o.resizedFrom)} to ${fmtQty(o.qty)} to match what filled on leg ${o.dependsOn.join(', ')}</div>` : null}
        ${!o.required ? html`<div class="sub">Optional leg</div>` : null}</td>
      <td class="wrap" style="min-width:170px"><${OrderStatus} status=${o.status} />${o.resolved ? html` <span class="sub">dealt with</span>` : null}${o.statusReason ? html`<div class="sub">${o.statusReason}</div>` : null}
        ${o.reserved.filter((h) => h.amount).map((h) => html`<div class="sub">reserved ${fmtMoney(h.amount, h.ccy)}</div>`)}</td>
      <td class="r">${fmtQty(o.filledQty)} of ${fmtQty(o.qty)}${o.remainingQty > 0 ? html`<div class=${`sub ${ACTIVE.includes(o.status) ? '' : 'loss'}`}>${fmtQty(o.remainingQty)} ${ACTIVE.includes(o.status) ? 'remaining' : 'never traded'}</div>` : null}</td>
      <td class="r">${isNum(o.avgPrice) ? fmtPrice(o.avgPrice) : o.kind === 'trade' ? html`<${Missing} reason="Nothing has filled" />` : ''}</td>
      <td class="r">${ACTIVE.includes(o.status) ? html`<${Button} small kind="danger" busy=${busy === o.id} onClick=${() => cancel(o)}>Cancel leg<//> ` : null}
        <${Button} small onClick=${() => setOpen({ ...open, [o.id]: !open[o.id] })}>${open[o.id] ? 'Hide fills' : `Fills (${o.fills.length})`}<//></td>
    </tr>${open[o.id] ? html`<tr class="detail" key=${`f${o.id}`}><td colspan="6" style="background:var(--paper);padding:10px 12px 12px 30px;white-space:normal"><${Fills} o=${o} rc=${rc} /></td></tr>` : null}`;
  const groups = [['primary', 'Primary legs', ''], ['hedge', 'Hedge legs', ''], ['financing', 'Financing and reservations', 'obligations, shown apart from the legs that carry price or risk']];
  return html`<${Panel} title="Legs" note=${`${plural(s.orders.length, 'order')}, each with its own status`} flush
    actions=${s.actions.includes('cancel_working') ? html`<${Button} small kind="danger" busy=${busy === 'all'} onClick=${cancelAll}>Cancel working legs<//>` : null}>
    ${s.orders.length ? html`<div class="tablewrap"><table class="ledger legs margin"><thead><tr><th></th><th>Leg</th><th>Status</th><th class="r">Filled</th><th class="r">Average price</th><th></th></tr></thead>
      <tbody>${groups.map(([key, label, note]) => { const mine = s.orders.filter((o) => group(o) === key); return mine.length ? html`<tr class="group"><td colspan="6">${label}${note ? html` <span class="sub" style="font-weight:400">${note}</span>` : ''}</td></tr>${mine.map(row)}` : null; })}</tbody></table></div>`
      : html`<${Empty}>This strategy instance has no orders.<//>`}
  <//>`;
}

// ---- positions and lifecycle ---------------------------------------------------------------------------------
function lifecycleFor(p, terms) {
  const a = [];
  if (['option', 'otcoption'].includes(p.family)) a.push(p.qty > 0 ? 'exercise' : 'assign');
  if (p.family === 'otcoption' && terms?.barrier && !p.data?.barrierHit) a.push('barrier');
  if (p.family === 'bond') a.push('redeem');
  if (p.family === 'secloan' && p.qty > 0) a.push('recall');
  if (!FINANCING_FAMILIES.includes(p.family)) a.push('cashflow');
  return a;
}
function LifecycleDialog({ p, action, terms, onClose, onDone }) {
  const L = LIFECYCLE[action];
  const size = Math.abs(p.qty);
  const [f, setF] = useState({ contracts: size, qty: size, face: size, price: null, days: null, label: '', category: 'dividend', amount: null, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setF({ ...f, ...patch });
  const body = { exercise: { contracts: f.contracts }, assign: { contracts: f.contracts }, barrier: { note: f.note }, redeem: { price: f.price, face: f.face, label: f.label || undefined }, recall: { qty: f.qty, days: f.days ?? undefined }, cashflow: { category: f.category, amount: f.amount, note: f.note } }[action];
  const ready = { exercise: f.contracts > 0, assign: f.contracts > 0, barrier: true, redeem: isNum(f.price) && f.price >= 0 && f.face > 0, recall: f.qty > 0, cashflow: isNum(f.amount) && f.amount !== 0 }[action];
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post(`/api/positions/${p.positionId}/lifecycle`, { action, ...body });
      toast(`${L.done}${r.result?.due ? ` The securities are due back by ${r.result.due}.` : ''}`);
      onDone(); onClose();
    } catch (err) { setError(err); setBusy(false); }
  };
  const european = terms?.exercise === 'european';
  return html`<${Modal} title=${`${L.title}: ${instName(p.instrument)}`} sub=${`${p.direction} ${fmtQty(size)}. Recorded now as a simulated lifecycle event; it cannot be undone from here.`} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!ready} onClick=${go}>${L.button}<//>`}>
    <div class="stack"><${ErrorNote} error=${error} /><p class="note" style="margin:0">${L.note}</p>
      ${['exercise', 'assign'].includes(action) && european ? html`<${Notice} tone="warn">This option is European. It can only be ${action === 'exercise' ? 'exercised' : 'assigned'} at expiration${terms.expiration ? ` (${terms.expiration})` : ''}.<//>` : null}
      ${action === 'barrier' && terms?.barrier ? html`<${Notice}>Barrier: ${words(terms.barrier.type)} at ${fmtPrice(terms.barrier.level)}.<//>` : null}
      <div class="grid-form">
        ${['exercise', 'assign'].includes(action) ? html`<${Field} label=${action === 'exercise' ? 'Contracts to exercise' : 'Contracts assigned'} hint=${`Up to ${fmtQty(size)}`}><${Num} value=${f.contracts} onInput=${(v) => set({ contracts: v })} /><//>` : null}
        ${action === 'redeem' ? html`<${Field} label="Redemption price (% of par)"><${Num} value=${f.price} onInput=${(v) => set({ price: v })} /><//>
          <${Field} label="Face amount redeemed" hint=${`Up to ${fmtQty(size)}`}><${Num} value=${f.face} onInput=${(v) => set({ face: v })} /><//>
          <${Field} label="Label" hint="Optional, for the history" span=${2}><${Text} value=${f.label} onInput=${(v) => set({ label: v })} placeholder="For example: issuer call" /><//>` : null}
        ${action === 'recall' ? html`<${Field} label="Quantity recalled" hint=${`Up to ${fmtQty(size)}`}><${Num} value=${f.qty} onInput=${(v) => set({ qty: v })} /><//>
          <${Field} label="Business days to return" hint="Leave empty for the standard two"><${Num} value=${f.days} onInput=${(v) => set({ days: v })} placeholder="2" /><//>` : null}
        ${action === 'cashflow' ? html`<${Field} label="Kind of cash flow" span=${2}><${Select} value=${f.category} onChange=${(v) => set({ category: v })} options=${CASHFLOW.map(([value, label]) => ({ value, label }))} /><//>
          <${Field} label=${`Amount (${p.ccy})`} hint="Negative for cash paid"><${Num} value=${f.amount} onInput=${(v) => set({ amount: v })} /><//>` : null}
        ${['cashflow', 'barrier'].includes(action) ? html`<${Field} label="Note" span="all" hint="Optional, kept in the history"><${Text} value=${f.note} onInput=${(v) => set({ note: v })} /><//>` : null}
      </div></div><//>`;
}
function valueCell(p) {
  if (NOTIONAL_FAMILIES.includes(p.family)) return html`${isNum(p.notional) ? fmtMoney(p.notional, p.ccy) : html`<${Missing} reason=${p.missingReason || 'Needs a price'} />`}<div class="sub">notional</div>${p.marginPosted ? html`<div class="sub">margin ${fmtMoney(p.marginPosted, p.ccy)}</div>` : null}`;
  if (p.ledgerCarried) return html`${fmtMoney(isNum(p.carrying) ? p.carrying : p.notional, p.ccy)}<div class="sub">${p.family === 'secloan' ? 'value of the securities' : 'principal outstanding'}</div>`;
  return html`<${Money} value=${p.mv} ccy=${p.ccy} reason=${p.missingReason} />${['option', 'otcoption'].includes(p.family) && isNum(p.notional) ? html`<div class="sub">notional ${fmtMoney(p.notional, p.ccy)}</div>` : null}`;
}
function Positions({ s, rc, after }) {
  const optionIds = s.positions.filter((p) => ['option', 'otcoption'].includes(p.family)).map((p) => p.instrument.id);
  const terms = useLive(async () => Object.fromEntries(await Promise.all(optionIds.map(async (id) => [id, (await get(`/api/instruments/${id}`)).terms]))), [optionIds.join(',')], { interval: false });
  const [pick, setPick] = useState(0); // remounts the action menus so they return to their placeholder
  const act = (p, action) => { setPick((n) => n + 1); openOverlay((close) => html`<${LifecycleDialog} p=${p} action=${action} terms=${terms.data?.[p.instrument.id]} onClose=${close} onDone=${after} />`); };
  const closeable = s.actions.includes('close');
  const extra = (p) => [
    p.restrictedCash ? `restricted cash ${fmtMoney(p.restrictedCash, p.ccy)}` : null, p.pledgedQty ? `pledged ${fmtQty(p.pledgedQty)}` : null, p.onLoanQty ? `on loan ${fmtQty(p.onLoanQty)}` : null,
    p.accrued ? `accrued ${fmtMoney(p.accrued, p.ccy, { sign: true })}` : null, p.recall ? html`<span class="loss">recalled ${fmtQty(p.recall.qty)}, due back ${p.recall.dueDate}</span>` : null,
    p.data?.barrierHit ? `barrier event recorded ${fmtTime(p.data.barrierHitAt)}` : null,
  ].filter(Boolean);
  return html`<${Panel} title="Positions" note=${s.positions.length ? 'What this strategy instance holds now' : ''} flush>
    <${Table} margin rows=${s.positions} rowKey=${(p) => p.positionId} columns=${[
      { label: 'Position and role', render: (p) => html`<div class="sym clip" style="max-width:200px">${link(instName(p.instrument), () => openInstrument(p.instrument.id), p.instrument.name)}</div>
        <div class="sub"><${Pill} tone=${p.purpose === 'hedge' ? 'pen' : p.purpose === 'financing' ? 'warn' : ''}>${PURPOSE_LABEL[p.purpose] || p.purpose}<//></div>${extra(p).map((x) => html`<div class="sub">${x}</div>`)}` },
      { label: 'Quantity', align: 'r', render: (p) => html`${fmtQty(p.qty)}<div class=${`sub ${p.direction === 'long' ? 'gain' : p.direction === 'short' ? 'loss' : ''}`} style="white-space:normal;max-width:84px;margin-left:auto">${p.direction}</div>` },
      { label: 'Current market price', align: 'r', render: (p) => (p.ledgerCarried ? '' : html`<${Price} obs=${p.priceObs} value=${p.price} reason=${p.missingReason || 'No price available'} />
        <div class="sub">${p.family === 'future' ? 'last settlement' : p.family === 'forward' ? 'dealt price' : 'average cost'} ${isNum(p.avgCost) ? fmtPrice(p.avgCost) : html`<${Missing} reason="No cost basis" />`}</div>`) },
      { label: 'Value or notional', align: 'r', title: 'Market value. Futures, forwards and swaps show their notional and the margin posted instead.', render: valueCell },
      { label: 'Unrealized', align: 'r', render: (p) => (p.ledgerCarried ? '' : html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed bare reason=${p.missingReason} />
        ${p.ccy !== rc && !p.missing ? html`<div class="sub"><${Money} value=${p.unrealizedRc} ccy=${rc} signed reason=${`No FX rate from ${p.ccy} to ${rc}`} /></div>` : null}`) },
      { label: '', align: 'r', render: (p) => { const acts = lifecycleFor(p, terms.data?.[p.instrument.id]); return html`<div class="row" style="flex-wrap:nowrap;justify-content:flex-end;gap:6px">
        ${acts.length ? html`<div key=${pick} style="width:104px" title="Record a lifecycle event on this position"><${Select} value="" placeholder="Lifecycle" onChange=${(v) => v && act(p, v)} options=${acts.map((a) => ({ value: a, label: LIFECYCLE[a].title }))} /></div>` : null}
        ${closeable ? html`<${Button} small onClick=${() => openPreviewAction(s.id, 'close', { positionIds: [p.positionId] }, { onDone: after })}>Close<//>` : null}</div>`; } },
    ]} empty=${{ title: 'No open positions', children: s.status === 'closed' ? 'This strategy instance is closed. Its legs and history remain below.' : s.status === 'failed' ? 'No leg executed, so nothing is held.' : 'Positions appear once a leg fills.' }} />
  <//>`;
}

// ---- residual exposure and recovery ------------------------------------------------------------------------------
function AcceptDialog({ s, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { await post(`/api/strategies/${s.id}/action`, { action: 'accept' }); toast('Accepted as it stands. The position no longer matches its template.', 'warn'); onDone(); onClose(); } catch (err) { setError(err); setBusy(false); }
  };
  return html`<${Modal} title="Accept the position as it stands" sub=${s.name} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Keep it flagged<//><${Button} kind="primary" busy=${busy} onClick=${go}>Accept as it stands<//>`}>
    <div class="stack"><${ErrorNote} error=${error} />
      <p style="margin:0">${plural(s.residual.length, 'required leg')} did not execute and will not be retried. The strategy keeps what did fill:</p>
      <ul style="margin:0;padding-left:18px">${s.positions.map((p) => html`<li>${p.direction} ${fmtQty(Math.abs(p.qty))} ${instName(p.instrument)}</li>`)}</ul>
      <${Notice} tone="warn">The failed legs are marked as dealt with and the strategy is recorded as no longer matching its ${s.templateName} template. Nothing is traded.<//></div><//>`;
}
function Residual({ s, after }) {
  if (s.status === 'attention') {
    return html`<section class="panel" style="border-color:var(--loss)"><header style="border-left:3px solid var(--loss)"><h3>Residual exposure</h3><span class="note">This package is not complete</span></header><div class="body stack">
      <${Notice} tone="err"><b>${plural(s.residual.length, 'required leg')} did not execute while other legs did.</b> The positions below are held without the rest of the ${s.templateName} package.<//>
      <div class="cols-2">
        <div><h4 style="margin-bottom:4px">Did not execute</h4>${s.residual.map((r) => html`<div style="margin-bottom:6px"><span class="leg-n">${r.legNo}</span> <span class="strong">${r.label}</span> <${OrderStatus} status=${r.status} />
          <div class="sub muted">${r.reason || 'No reason was recorded'}. ${r.filledQty > 0 ? `${fmtQty(r.filledQty)} of ${fmtQty(r.qty)} filled; ${fmtQty(r.qty - r.filledQty)} did not.` : `None of the ${fmtQty(r.qty)} filled.`}</div></div>`)}</div>
        <div><h4 style="margin-bottom:4px">What remains</h4>${s.positions.length ? s.positions.map((p) => html`<div>${p.direction} <b>${fmtQty(Math.abs(p.qty))}</b> ${instName(p.instrument)} <span class="sub muted">${isNum(p.mv) && !p.ledgerCarried ? `${fmtMoney(p.mv, p.ccy)} at the current price` : p.ledgerCarried ? words(PURPOSE_LABEL[p.purpose] || '').toLowerCase() : 'no price'}</span></div>`) : html`<span class="muted">No open position.</span>`}</div>
      </div>
      <div class="row">
        ${s.actions.includes('retry') ? html`<${Button} kind="primary" onClick=${() => openPreviewAction(s.id, 'retry', {}, { onDone: after })}>Retry the failed legs<//>` : null}
        ${s.actions.includes('unwind') ? html`<${Button} onClick=${() => openPreviewAction(s.id, 'unwind', {}, { onDone: after })}>Unwind what filled<//>` : null}
        ${s.actions.includes('accept') ? html`<${Button} onClick=${() => openOverlay((close) => html`<${AcceptDialog} s=${s} onClose=${close} onDone=${after} />`)}>Accept as it stands<//>` : null}
        <span class="note">Retry and unwind open a preview first. Accepting trades nothing.</span>
      </div></div></section>`;
  }
  const working = s.orders.filter((o) => ACTIVE.includes(o.status)).length;
  if (working) return html`<${Notice} tone="warn"><b>In progress, not complete.</b> ${plural(working, 'leg is', 'legs are')} still working or waiting. ${s.positions.length ? 'What has filled so far is listed under Positions.' : 'Nothing has filled yet.'}<//>`;
  if (s.status === 'failed') return html`<${Notice} tone="err"><b>No leg executed.</b> Nothing is held and no cash moved. The reason for each leg is in the table below.<//>`;
  if (s.note) return html`<${Notice}>${s.note}<//>`;
  return null;
}

// ---- manage: close, resize, roll, add legs -------------------------------------------------------------------------
function RollDialog({ s, onClose, onDone }) {
  const rollable = s.positions.filter((p) => ['option', 'future'].includes(p.family));
  const firstKind = rollable.some((p) => p.family === 'option') ? 'option' : 'future';
  const [sel, setSel] = useState(rollable.filter((p) => p.family === firstKind).map((p) => p.positionId));
  const [exp, setExp] = useState('');
  const [strike, setStrike] = useState(null);
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const picked = rollable.filter((p) => sel.includes(p.positionId));
  const options = picked.filter((p) => p.family === 'option'), futures = picked.filter((p) => p.family === 'future');
  const undId = options[0]?.instrument.underlyingId || '';
  const chain = useLive(() => (undId ? get(`/api/instruments/${undId}/chain`, { expiration: exp }) : null), [undId, exp], { interval: false });
  const months = useLive(() => get('/api/instruments', { family: 'future', limit: 500 }), [], { interval: false });
  const has = Boolean(chain.data?.available);
  const one = options.length === 1 ? options[0] : null;
  const roots = new Set(futures.map((p) => p.instrument.terms.root).filter(Boolean));
  const monthOptions = (months.data?.items || []).filter((i) => !futures.some((p) => p.instrument.id === i.id) && (!roots.size || roots.has(i.terms.root)));
  const ready = picked.length > 0 && (!options.length || exp) && (!futures.length || month);
  const go = async () => {
    setBusy(true);
    const pv = await openPreviewAction(s.id, 'roll', { positionIds: sel, newExpiration: options.length ? exp : undefined, newStrike: one && isNum(strike) ? strike : undefined, newInstrumentId: futures.length ? month : undefined }, { onDone });
    setBusy(false);
    if (pv) onClose();
  };
  return html`<${Modal} size="mid" title=${`Roll positions of ${s.name}`} sub="Each rolled position is closed and reopened in the new contract, in one package with one confirmation." onClose=${onClose}
    footer=${html`<span class="note">Nothing is submitted until you confirm the preview.</span><span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!ready} onClick=${go}>Preview roll<//>`}>
    <div class="stack">
      <${Field} label="Positions to roll">${rollable.map((p) => html`<div><${Check} checked=${sel.includes(p.positionId)} onChange=${(v) => setSel(v ? [...sel, p.positionId] : sel.filter((x) => x !== p.positionId))}>
        ${p.direction} ${fmtQty(Math.abs(p.qty))} ${instName(p.instrument)} <span class="muted small">${p.family === 'option' ? `expires ${p.instrument.terms.expiration}` : p.instrument.terms.expiration ? `last trading day ${p.instrument.terms.expiration}` : ''}</span><//></div>`)}<//>
      ${options.length ? html`<div class="grid-form" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <${Field} label="New expiration" hint=${has ? `From the option chain (${chain.data.chain.source})` : chain.data ? 'No option chain is available. Enter the date.' : ''}>
          ${has ? html`<${Select} value=${exp} onChange=${setExp} placeholder="Choose…" options=${chain.data.chain.expirations.map((e) => ({ value: e, label: e }))} />` : html`<${Text} type="date" value=${exp} onInput=${setExp} />`}<//>
        ${one ? html`<${Field} label="New strike" hint=${`Leave empty to keep ${fmtPrice(one.instrument.terms.strike)}`}>
          ${has && exp ? html`<${Select} value=${strike ?? ''} onChange=${(v) => setStrike(v === '' ? null : Number(v))} placeholder=${`Keep ${fmtPrice(one.instrument.terms.strike)}`} options=${chain.data.chain.strikes.map((k) => ({ value: k, label: fmtPrice(k) }))} />` : html`<${Num} value=${strike} onInput=${setStrike} placeholder=${String(one.instrument.terms.strike)} />`}<//>`
          : html`<div class="field"><label>Strikes</label><div class="note" style="padding-top:6px">Each option keeps its strike. Roll one option alone to change its strike.</div></div>`}
      </div>` : null}
      ${futures.length ? html`<${Field} label="Contract month to roll into" hint="Contract months come from the registry until Shaffer MarketData supplies derivative contract data.">
        <${Select} value=${month} onChange=${setMonth} placeholder=${monthOptions.length ? 'Choose a contract month' : 'No other contract month is registered'} options=${monthOptions.map((i) => ({ value: i.id, label: `${i.symbol || i.name}${i.terms.expiration ? `, last trading day ${i.terms.expiration}` : ''}` }))} /><//>` : null}
    </div><//>`;
}
function Manage({ s, after, onClose }) {
  const [pct, setPct] = useState(100);
  const [factor, setFactor] = useState(null);
  const can = (a) => s.actions.includes(a);
  if (!['close', 'resize', 'roll', 'add_legs'].some(can)) return null;
  const inline = 'display:flex;gap:6px;align-items:center';
  return html`<${Panel} title="Manage" note="Every change opens the trade preview. Nothing is submitted until you confirm it.">
    <div class="grid-form" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">
      ${can('close') ? html`<${Field} label="Close, share of every position (%)" hint="100 closes the whole strategy instance">
        <div style=${inline}><div style="width:84px"><${Num} value=${pct} onInput=${setPct} /></div><${Button} disabled=${!(pct > 0 && pct <= 100)} onClick=${() => openPreviewAction(s.id, 'close', { fraction: pct / 100 }, { onDone: after })}>Preview close<//></div><//>` : null}
      ${can('resize') ? html`<${Field} label="Resize, multiple of the current size" hint="0.5 halves every leg, 2 doubles it">
        <div style=${inline}><div style="width:84px"><${Num} value=${factor} onInput=${setFactor} placeholder="1" /></div><${Button} disabled=${!(factor > 0) || factor === 1} onClick=${() => openPreviewAction(s.id, 'resize', { factor }, { onDone: after })}>Preview resize<//></div><//>` : null}
      ${can('roll') || can('add_legs') ? html`<${Field} label="Change the legs" hint=${can('roll') ? 'Roll moves option or futures positions to a new contract' : 'Add legs to this strategy instance on the Strategy page'}>
        <div style=${inline}>${can('roll') ? html`<${Button} onClick=${() => openOverlay((close) => html`<${RollDialog} s=${s} onClose=${close} onDone=${after} />`)}>Roll<//>` : null}
          ${can('add_legs') ? html`<${Button} onClick=${() => { location.hash = `#/strategy/attach/${s.id}`; onClose(); }}>Add legs<//>` : null}</div><//>` : null}
    </div><//>`;
}

// ---- holds, hedge, history ----------------------------------------------------------------------------------------------
function Holds({ s }) {
  const rows = [...s.holds.map((h) => ({ ...h, what: HOLD_LABEL[h.kind] || sentence(h.kind), note: h.note && h.note !== HOLD_LABEL[h.kind] ? h.note : '' })),
    ...s.orders.flatMap((o) => o.reserved.filter((h) => h.amount).map((h) => ({ ...h, what: `Reserved for working leg ${o.legNo}`, note: o.label })))].filter((h) => h.amount);
  return html`<${Panel} title="Holds and reservations" note="Cash that stays in the Account but cannot be used elsewhere" flush>
    <${Table} rows=${rows} columns=${[{ label: 'Held for', render: (h) => html`${h.what}${h.note ? html`<div class="sub">${h.note}</div>` : null}` }, { label: 'Amount', align: 'r', render: (h) => html`<span class="strong">${fmtMoney(h.amount, h.ccy)}</span>` }]}
      empty=${{ children: 'Nothing is reserved against this strategy instance. Cash is held here when it writes options or carries a short position.' }} /><//>`;
}
function Hedge({ s, after }) {
  if (!s.hedge) return null;
  const { review, requests } = s.hedge;
  const hedges = s.positions.filter((p) => p.purpose === 'hedge');
  const can = s.actions.includes('hedge');
  return html`<${Panel} title="Hedge" note="Instructions come from Shaffer Hedge in Analytics Lab" flush=${false}>
    <div class="stack">
      ${review?.needed ? html`<div class="notice warn" style="border-left-width:5px;padding:10px 12px"><div class="strong" style="font-size:14px">Hedge review needed: ${String(review.reason || 'the hedged exposure changed').replace(/^./, (c) => c.toLowerCase())}</div>
        <div style="margin:3px 0 8px">The hedges linked to this strategy instance may no longer match its exposure${review.since ? ` (flagged ${fmtTime(review.since)})` : ''}. Nothing has been traded.</div>
        <${Button} kind="primary" onClick=${() => openHedgeFor(s, { trigger: 'review', onDone: after })}>Request updated hedge instructions<//></div>`
        : can ? html`<div class="row"><${Button} onClick=${() => openHedgeFor(s, { onDone: after })}>Request a hedge<//><span class="note">${hedges.length ? `${plural(hedges.length, 'hedge position')} linked to this strategy instance.` : 'No hedge is linked to this strategy instance.'}</span></div>` : html`<p class="note" style="margin:0">A hedge can be requested while the strategy instance holds a position.</p>`}
      <p class="note" style="margin:0">A request opens the packages returned for it. Executing one still goes through its own preview and confirmation.</p>
      ${requests.length ? html`<${Table} rows=${requests} rowKey=${(r) => r.id} columns=${[
        { label: 'Earlier requests', render: (r) => html`${fmtTime(r.createdAt)}<div class="sub">${r.id}</div>` },
        { label: 'Why', render: (r) => TRIGGER[r.trigger] || sentence(r.trigger) },
        { label: 'Outcome', cls: 'wrap', render: (r) => html`<${Pill} tone=${REQUEST_TONE[r.status] || ''}>${r.status === 'awaiting' ? 'awaiting connection' : r.status}<//>${r.selectedPackage ? html`<div class="sub">package ${r.selectedPackage}</div>` : r.message ? html`<div class="sub">${r.message}</div>` : null}` },
        { label: 'Packages', align: 'r', render: (r) => r.packages },
        { label: '', align: 'r', render: (r) => html`<${Button} small onClick=${() => openHedgeRequest(r.id, { onDone: after })}>Open request<//>` },
      ]} />` : null}
    </div><//>`;
}
function History({ s, onClose }) {
  const res = useLive(() => get(`/api/books/${s.bookId}/accounting/history`, { scope: 'book', strategyId: s.id, limit: 40 }), [s.id, s.bookId]);
  const d = res.data;
  return html`<${Panel} title="History" note="Audit events of this strategy instance, newest first" flush
    actions=${html`<${Button} small onClick=${() => { location.hash = `#/accounting/history/${s.unit.id}`; onClose(); }}>Open the full history<//>`}>
    ${!d ? html`<${Empty}>${res.error ? res.error.message : 'Loading…'}<//>` : html`<${Table} rows=${d.events} rowKey=${(e) => e.id} columns=${[
      { label: 'Time', render: (e) => html`${fmtTime(e.ts)}<div class="sub">#${e.id}</div>` },
      { label: 'Event', render: (e) => sentence(e.type) },
      { label: 'What happened', cls: 'wrap', render: (e) => html`${e.summary}${e.correctsEventId ? html`<div class="sub">Corrects event #${e.correctsEventId}</div>` : null}${e.correctedBy.length ? html`<div class="sub">Corrected by event #${e.correctedBy.join(', #')}</div>` : null}` },
      { label: 'Cash effect', align: 'r', render: (e) => (e.cash.length ? e.cash.map((c) => html`<div><${Money} value=${c.amount} ccy=${c.ccy} signed /></div>`) : '') },
    ]} empty=${{ children: 'No events are recorded for this strategy instance yet.' }} />
    ${d.more ? html`<div class="body small muted" style="border-top:1px solid var(--rule)">Older events are in the full history. Daily accruals are left out here.</div>` : null}`}
  <//>`;
}

// ---- drawer -------------------------------------------------------------------------------------------------------------
function StrategyDrawer({ id, onClose }) {
  const res = useLive(() => get(`/api/strategies/${id}`), [id]);
  const s = res.data;
  const after = () => { bump(); res.reload(); };
  useEffect(() => { if (res.error && !s) toastError(res.error); }, [Boolean(res.error)]);
  if (!s) return html`<${Drawer} wide title="Strategy instance" onClose=${onClose}>${res.error ? html`<${Notice} tone="err">${res.error.message}<//>` : html`<${Empty}>Loading…<//>`}<//>`;
  const rc = currentBook()?.reportingCcy || 'USD';
  const missing = (reason) => html`<${Missing} reason=${reason} />`;
  const hp = s.holdingPeriod;
  const state = s.status === 'attention' ? 'Not complete: a required leg did not execute' : s.status === 'failed' ? 'No leg executed' : !s.complete ? 'Not complete: legs are still working' : s.status === 'closed' ? 'Closed' : 'All required legs executed';
  return html`<${Drawer} wide onClose=${onClose} title=${s.name} sub=${`${s.templateName}, held in ${unitLabel(s.unit)}`} actions=${html`<${StrategyStatus} status=${s.status} />${s.hedge?.review?.needed ? html`<${Pill} tone="warn">hedge review<//>` : null}`}>
    <div class="stack">
      <div class="cols-2">
        <${KV} rows=${[['Strategy instance', s.id], ['Template', s.templateName], ['Account', unitLabel(s.unit)], ['Status', html`<${StrategyStatus} status=${s.status} /> <span class="sub muted">${state}</span>`],
          s.underlying ? ['Underlying', link(instName(s.underlying), () => openInstrument(s.underlying.id), s.underlying.name)] : null]} />
        <${KV} rows=${[['Investment Strategy', s.investmentStrategy?.name || missing('Not set for this strategy instance')],
          ['Holding period', hp?.days ? `${hp.days} days` : hp?.until ? `until ${hp.until}` : hp?.label || missing('Not set for this strategy instance')],
          ['Created', fmtTime(s.createdAt)], ['Closed', s.closedAt ? fmtTime(s.closedAt) : html`<span class="muted">${s.status === 'failed' ? 'Never opened' : 'Still open'}</span>`], s.signalRef ? ['Signal', s.signalRef] : null]} />
      </div>
      <${ErrorNote} error=${res.error} />
      <${Residual} s=${s} after=${after} />
      <${Legs} s=${s} rc=${rc} after=${after} />
      <${Positions} s=${s} rc=${rc} after=${after} />
      <${Manage} s=${s} after=${after} onClose=${onClose} />
      <${Holds} s=${s} />
      <${Hedge} s=${s} after=${after} />
      <${History} s=${s} onClose=${onClose} />
    </div><//>`;
}
