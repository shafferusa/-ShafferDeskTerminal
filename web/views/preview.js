// Trade preview and confirmation.
//
// Every package (a single ticket, a strategy template, a hedge, a close/roll/resize, a financing
// arrangement) passes through this dialog. It shows each leg with its estimated fill and the fill
// model that produced it, the cash / margin / collateral / funding requirements, the payoff, and
// every check. Legs are editable; an edited package must be re-checked before it can be confirmed.
// One explicit confirmation submits the package. The confirmation token can be used only once.
import { html, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, isNum, post, toast } from '../lib/core.js';
import { Button, Check, Checks, ErrorNote, Modal, Money, Notice, Num, PayoffChart, Pill, Price, Prov, PURPOSE_LABEL, Select, Table } from '../lib/ui.js';

const ORDER_TYPES = [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }, { value: 'stop_limit', label: 'Stop limit' }];
const TIFS = [{ value: 'day', label: 'Day' }, { value: 'gtc', label: 'Until cancelled' }];

function TermsList({ details }) {
  if (!details?.length) return null;
  return html`<dl class="terms">${details.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl>`;
}

function LegRow({ leg, edit, onEdit, onRemove, canRemove }) {
  const [open, setOpen] = useState(leg.instrument?.draft && !['option'].includes(leg.instrument.family));
  const e = { ...leg, ...edit };
  const p = leg.price;
  const set = (patch) => onEdit(leg.n, patch);
  const hasTerms = leg.instrument?.details?.length > 0;
  return html`<tr>
    <td><span class="leg-n">${leg.n}</span>${leg.dependsOn?.length ? html`<div class="dep">after ${leg.dependsOn.join(', ')}</div>` : null}</td>
    <td class="wrap">
      <div class="strong">${leg.label}</div>
      <div class="sub">${leg.kindLabel}${leg.instrument ? `, ${leg.instrument.name}` : ''}${leg.instrument?.draft ? ', new contract' : ''}</div>
      ${leg.hedgeFamily ? html`<div class="sub">${leg.hedgeFamily}${leg.riskAddressed ? `: ${leg.riskAddressed}` : ''}${leg.sizingBasis ? `, sized by ${leg.sizingBasis}` : ''}${isNum(leg.hedgeRatio) ? `, ratio ${leg.hedgeRatio}` : ''}</div>` : null}
      ${leg.note ? html`<div class="sub">${leg.note}</div>` : null}
      ${(leg.econNotes || []).slice(0, open ? 9 : 1).map((n) => html`<div class="sub">${n}</div>`)}
      ${hasTerms ? html`<button class="btn link small" onClick=${() => setOpen(!open)}>${open ? 'Hide contract terms' : 'Show contract terms'}</button>` : null}
      ${open && hasTerms ? html`<${TermsList} details=${leg.instrument.details} />` : null}
      ${leg.terms && open && !hasTerms ? html`<${TermsList} details=${leg.terms} />` : null}
    </td>
    <td class="r">
      ${['trade', 'borrow_sec', 'loan', 'repo_open', 'lend_sec', 'repay', 'return_sec', 'recall_sec', 'link'].includes(leg.kind)
        ? html`<${Num} cls="mini" value=${e.qty} onInput=${(v) => set({ qty: v })} />` : fmtQty(leg.qty)}
      <div class="sub">${leg.qtyLabel}</div>
      ${isNum(leg.deliverableUnits) && leg.instrument?.family === 'option' ? html`<div class="sub">${fmtQty(leg.deliverableUnits)} per contract</div>` : null}
    </td>
    <td>
      ${leg.kind === 'trade' ? html`
        <${Select} value=${e.orderType} onChange=${(v) => set({ orderType: v })} options=${ORDER_TYPES} />
        ${['limit', 'stop_limit'].includes(e.orderType) ? html`<div class="row" style="margin-top:4px"><span class="sub">limit</span><${Num} cls="mini" value=${e.limitPrice} onInput=${(v) => set({ limitPrice: v })} /></div>` : null}
        ${['stop', 'stop_limit'].includes(e.orderType) ? html`<div class="row" style="margin-top:4px"><span class="sub">stop</span><${Num} cls="mini" value=${e.stopPrice} onInput=${(v) => set({ stopPrice: v })} /></div>` : null}
        <div style="margin-top:4px"><${Select} value=${e.tif} onChange=${(v) => set({ tif: v })} options=${TIFS} /></div>` : html`<span class="muted">${leg.kindLabel}</span>`}
    </td>
    <td class="wrap" style="min-width:200px">
      ${leg.kind === 'trade' ? html`
        <div>${isNum(p?.estimate) ? html`<span class="price"><span class="v">${fmtPrice(p.estimate)}</span></span>` : html`<span class="missing" title=${p?.reason || ''}>no executable price</span>`}
          ${p?.observation ? html` <${Prov} obs=${p.observation} />` : null}</div>
        <div class="sub">${p?.label}${isNum(p?.reference) && p?.reference !== p?.estimate ? `, reference ${fmtPrice(p.reference)}` : ''}</div>
        ${p?.note ? html`<div class="sub">${p.note}</div>` : null}
        ${p && !p.executable && p.reason ? html`<div class="sub" style="color:var(--amber)">${p.reason}</div>` : null}
        ${leg.indicative ? html`<div class="sub">Indicative terms: ${fmtPrice(leg.indicative.value)} (${leg.indicative.status}, ${leg.indicative.source}). Not an executable quote.
          <button class="btn link small" onClick=${() => set({ statedPrice: leg.indicative.value })}>Use as my stated fill price</button></div>` : null}
        <div class="row" style="margin-top:4px"><span class="sub">state a fill price</span><${Num} cls="mini" value=${e.statedPrice} onInput=${(v) => set({ statedPrice: v })} placeholder="none" /></div>` : null}
      ${leg.kind === 'borrow_sec' ? html`
        ${leg.borrowInfo?.source ? html`<div><${Pill} tone=${leg.borrowInfo.available ? 'ok' : 'bad'}>${leg.borrowInfo.available ? 'available' : 'unavailable'}<//> fee ${fmtNum((leg.borrowInfo.feeRate || 0) * 100, 3)}% a year</div>
          <div class="sub">${leg.borrowInfo.source}${isNum(leg.borrowInfo.quantityAvailable) ? `, ${fmtQty(leg.borrowInfo.quantityAvailable)} available` : ''}${isNum(leg.borrowInfo.dailyCost) ? `, about ${fmtMoney(leg.borrowInfo.dailyCost, leg.currency)} a day` : ''}</div>` : html`<div class="sub" style="color:var(--amber)">No borrow availability data. State your assumption:</div>`}
        ${!leg.borrowInfo?.observation ? html`<div class="row" style="margin-top:4px">
          <${Check} checked=${e.borrow?.available !== false && e.borrow?.feeRate != null} onChange=${(v) => set({ borrow: { ...(e.borrow || {}), available: v, feeRate: e.borrow?.feeRate ?? 0.005 } })}>available<//>
          <span class="sub">fee (decimal a year)</span><${Num} cls="mini" value=${e.borrow?.feeRate ?? null} onInput=${(v) => set({ borrow: { ...(e.borrow || {}), feeRate: v, available: e.borrow?.available ?? true } })} placeholder="0.005" /></div>` : null}` : null}
      ${leg.kind === 'funding' ? html`<div>From ${leg.fundingInfo?.from?.name || 'Treasury'}</div><div class="sub">${fmtMoney(leg.fundingInfo?.available, leg.currency)} available there. A transfer does not convert currency.</div>` : null}
      ${leg.kind === 'reserve' ? html`<div>${fmtMoney(leg.reserve?.amount, leg.reserve?.ccy)} stays in the Account but cannot be used elsewhere.</div>` : null}
      ${leg.kind === 'link' ? html`<div>Existing position of ${fmtQty(leg.existing?.qty)}${isNum(leg.existing?.avgCost) ? ` at average cost ${fmtPrice(leg.existing.avgCost)}` : ''}</div><div class="sub">Nothing is bought or sold.</div>` : null}
      ${['loan', 'repo_open', 'lend_sec'].includes(leg.kind) && isNum(leg.dailyCost) ? html`<div class="sub">About ${fmtMoney(leg.dailyCost, leg.currency)} of interest a day</div>` : null}
    </td>
    <td class="nowrap">${leg.settleDate || ''}</td>
    <td class="r nowrap">
      ${isNum(leg.cash) ? html`<${Money} value=${leg.cash} ccy=${leg.currency} signed />` : leg.kind === 'trade' ? html`<span class="missing" title="Needs a price">—</span>` : ''}
      ${(leg.otherCash || []).map((o) => html`<div><${Money} value=${o.amount} ccy=${o.ccy} signed /></div>`)}
      ${leg.accrued ? html`<div class="sub">incl. accrued ${fmtMoney(leg.accrued, leg.currency)}</div>` : null}
      ${leg.feeTotal ? html`<div class="sub">fees ${fmtMoney(leg.feeTotal, leg.currency)}</div>` : null}
    </td>
    <td class="r nowrap">
      ${isNum(leg.notional) ? html`<div title=${leg.notionalBasis || ''}>${fmtMoney(leg.notional, leg.currency)}</div>` : ''}
      ${leg.initialMargin ? html`<div class="sub">margin ${fmtMoney(leg.initialMargin, leg.currency)}</div>` : null}
      ${leg.shortCollateral ? html`<div class="sub">collateral top-up ${fmtMoney(leg.shortCollateral.topUp, leg.currency)}</div><div class="sub">margin hold ${fmtMoney(leg.shortCollateral.marginHold, leg.currency)}</div>` : null}
    </td>
    <td>${canRemove ? html`<button class="x" title="Remove this leg" onClick=${() => onRemove(leg.n)}>×</button>` : null}</td>
  </tr>`;
}

function CashTable({ cash }) {
  const rows = Object.values(cash || {});
  if (!rows.length) return html`<p class="note">No cash moves at trade for this package.</p>`;
  const line = (label, key, opts = {}) => rows.some((r) => r[key]) ? html`<tr><td>${label}</td>${rows.map((r) => html`<td class="r">${r[key] ? fmtMoney(opts.neg ? -r[key] : r[key], r.ccy, { sign: opts.sign }) : ''}</td>`)}</tr>` : null;
  return html`<table class="ledger"><thead><tr><th></th>${rows.map((r) => html`<th class="r">${r.ccy}</th>`)}</tr></thead><tbody>
    ${line('Purchases', 'purchases')}${line('Sale proceeds', 'proceeds')}${line('Short-sale proceeds (restricted)', 'restrictedProceeds')}
    ${line('Fees and commissions', 'fees')}${line('Margin', 'margin')}${line('Collateral top-up', 'collateral')}${line('Reserved against short options', 'reserved')}
    ${line('Financing received', 'financingIn')}${line('Financing paid out', 'financingOut')}
    <tr><td class="strong">Cash required</td>${rows.map((r) => html`<td class="r strong">${fmtMoney(r.required, r.ccy)}</td>`)}</tr>
    <tr><td>Available to trade now</td>${rows.map((r) => html`<td class="r">${fmtMoney(r.available, r.ccy)}</td>`)}</tr>
    <tr><td>Shortfall</td>${rows.map((r) => html`<td class=${`r ${r.shortfall > 0 ? 'loss strong' : ''}`}>${r.shortfall > 0 ? fmtMoney(r.shortfall, r.ccy) : 'none'}</td>`)}</tr>
  </tbody></table>`;
}

function Payoff({ payoff, netPremium }) {
  if (!payoff) return html`<p class="note">No payoff view for this package.</p>`;
  const bound = (m) => (m?.unbounded ? html`<span class="loss strong">Unbounded</span>` : isNum(m?.value) ? html`${fmtNum(m.value, 0, { sign: true })}${m.approximate ? ' (approx.)' : ''}` : '—');
  return html`<div class="stack">
    ${netPremium ? html`<div>Net ${netPremium.type}: <b>${fmtMoney(Math.abs(netPremium.amount), netPremium.ccy)}</b>${netPremium.complete ? '' : ' (incomplete: a leg has no price)'}</div>` : null}
    ${payoff.type === 'expiry-payoff' ? html`
      <${PayoffChart} points=${payoff.points} breakevens=${payoff.breakevens} reference=${payoff.referencePrice} currency=${payoff.currency} />
      <dl class="kv">
        <dt>At expiration</dt><dd>${payoff.asOfExpiry}${isNum(payoff.daysToExpiry) ? ` (${payoff.daysToExpiry} days)` : ''}</dd>
        <dt>Break-even</dt><dd>${payoff.breakevens.length ? payoff.breakevens.map((b) => fmtPrice(b)).join(' and ') : 'none in range'}</dd>
        <dt>Maximum gain</dt><dd class="gain">${payoff.maxGain?.unbounded ? html`Unbounded${payoff.maxGain.note ? html` <span class="sub">${payoff.maxGain.note}</span>` : ''}` : bound(payoff.maxGain)}</dd>
        <dt>Maximum loss</dt><dd>${bound(payoff.maxLoss)}${payoff.maxLoss?.note ? html` <span class="sub">${payoff.maxLoss.note}</span>` : ''}</dd>
      </dl>` : null}
    ${payoff.type === 'scenarios' ? html`
      <table class="ledger"><thead><tr><th>Scenario</th><th class="r">Profit / loss</th></tr></thead><tbody>
        ${payoff.rows.map((r) => html`<tr><td>${r.label}</td><td class="r">${Object.entries(r.pnl).map(([ccy, v]) => html`<div class=${v > 0 ? 'gain' : v < 0 ? 'loss' : ''}>${fmtMoney(v, ccy, { sign: true })}</div>`)}</td></tr>`)}
      </tbody></table>
      <dl class="kv">
        <dt>Net exposure</dt><dd>${Object.entries(payoff.netExposure).map(([c, v]) => fmtMoney(v, c, { sign: true })).join(', ')}</dd>
        <dt>Maximum gain</dt><dd>${payoff.maxGain?.unbounded ? payoff.maxGain.note || 'No fixed maximum' : html`${bound(payoff.maxGain)} <span class="sub">${payoff.maxGain?.note || ''}</span>`}</dd>
        <dt>Maximum loss</dt><dd>${payoff.maxLoss?.unbounded ? html`<span class="loss strong">Unbounded</span>` : bound(payoff.maxLoss)} <span class="sub">${payoff.maxLoss?.note || ''}</span></dd>
      </dl>` : null}
    ${payoff.type === 'none' ? html`<p class="note">${payoff.note}</p>` : null}
    ${(payoff.assumptions || []).map((a) => html`<div class="sub muted">${a}</div>`)}
  </div>`;
}

/**
 * props: preview (from the server), onClose, onDone(strategy), extra (fields merged into the submit),
 *        confirmLabel, allowRemove (legs may be dropped), banner (node shown above the legs)
 */
export function PreviewModal({ preview, onClose, onDone, extra = {}, confirmLabel = 'Confirm paper trade', allowRemove = true, banner }) {
  const [pv, setPv] = useState(preview);
  const [edits, setEdits] = useState({});
  const [removed, setRemoved] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const dirty = Object.keys(edits).length > 0 || removed.length > 0;

  const editedLegs = () => {
    const keep = pv.legs.filter((l) => !removed.includes(l.n));
    const renum = new Map(keep.map((l, i) => [l.n, i + 1]));
    return keep.map((l) => ({ ...l, ...(edits[l.n] || {}), n: renum.get(l.n), dependsOn: (l.dependsOn || []).filter((d) => renum.has(d)).map((d) => renum.get(d)) }));
  };
  const recheck = async () => {
    setBusy(true); setError(null);
    try {
      // The legs now on screen are the package: financing sized automatically for the first preview
      // is already among them (or was removed on purpose), so it is not sized and added again.
      const next = await post('/api/strategies/preview', { ...pv.input, ...extra, financing: null, legs: editedLegs(), clientToken: pv.token });
      setPv(next); setEdits({}); setRemoved([]);
    } catch (err) { setError(err); }
    setBusy(false);
  };
  const confirm = async () => {
    if (busy || done) return; // one confirmation, one submission
    setBusy(true); setError(null);
    try {
      const out = await post('/api/strategies', { ...pv.input, ...extra, legs: pv.legs, clientToken: pv.token, confirm: true });
      setDone(true);
      bump();
      const s = out.strategy;
      const working = s.orders.filter((o) => ['pending', 'working', 'partial'].includes(o.status)).length;
      const dead = s.orders.filter((o) => ['rejected', 'cancelled', 'expired'].includes(o.status) && o.submission === pv.token).length;
      toast(out.duplicate ? 'This package was already submitted; showing the original.' : dead ? `${s.name}: ${dead} leg${dead > 1 ? 's' : ''} did not execute. Check the strategy.` : working ? `${s.name} submitted. ${working} leg${working > 1 ? 's are' : ' is'} working.` : `${s.name} executed.`, dead ? 'err' : working ? 'warn' : 'ok', 6000);
      onDone?.(s, out);
      onClose();
    } catch (err) {
      if (err.details?.preview) { setPv(err.details.preview); setEdits({}); setRemoved([]); }
      setError(err);
      setBusy(false);
    }
  };

  const groups = [['primary', 'Primary legs'], ['hedge', 'Hedge legs'], ['financing', 'Financing and reservations']];
  const legs = pv.legs.filter((l) => !removed.includes(l.n));
  const columns = ['', 'Leg', 'Quantity', 'Order', 'Estimated fill', 'Settles', 'Cash', 'Notional', ''];
  return html`<${Modal} size="wide" onClose=${onClose} title=${`Preview: ${pv.name}`}
    sub=${`${pv.unit.name} in ${pv.book.name}, ${pv.templateName}${pv.attachTo ? ', added to the existing strategy' : ''}, ${legs.length} leg${legs.length > 1 ? 's' : ''}`}
    footer=${html`
      <span class="note">Simulated execution. Nothing is sent to a real market.</span><span class="grow"></span>
      <${Button} onClick=${onClose}>Cancel<//>
      ${dirty ? html`<${Button} kind="primary" busy=${busy} onClick=${recheck}>Re-check edited package<//>`
        : html`<${Button} kind="primary" busy=${busy} disabled=${pv.blocking > 0 || !legs.length || done} onClick=${confirm} title=${pv.blocking ? 'Resolve the blocking checks first' : ''}>${confirmLabel}<//>`}`}>
    <div class="stack">
      ${banner}
      <${ErrorNote} error=${error} />
      ${dirty ? html`<${Notice} tone="warn">You changed the package. Re-check it before confirming; the figures below are from before your changes.<//>` : null}
      <${Checks} checks=${pv.checks} />
      <div class="tablewrap"><table class="ledger legs margin">
        <thead><tr>${columns.map((c, i) => html`<th class=${i === 2 || i >= 6 ? 'r' : ''}>${c}</th>`)}</tr></thead>
        <tbody>${groups.map(([key, label]) => {
          const mine = legs.filter((l) => (l.purpose === 'reserve' ? 'financing' : l.purpose) === key);
          if (!mine.length) return null;
          return html`<tr class="group"><td colspan="9">${label}${key === 'financing' ? html` <span class="sub" style="font-weight:400">obligations, shown apart from the legs that carry price or risk</span>` : ''}</td></tr>
            ${mine.map((l) => html`<${LegRow} key=${`${pv.generatedAt}-${l.n}`} leg=${l} edit=${edits[l.n]} canRemove=${allowRemove && legs.length > 1}
              onEdit=${(n, patch) => setEdits((e) => ({ ...e, [n]: { ...(e[n] || {}), ...patch } }))} onRemove=${(n) => setRemoved((r) => [...r, n])} />`)}`;
        })}</tbody>
      </table></div>
      <div class="cols-2">
        <section class="panel"><header><h3>Cash, margin, collateral and funding</h3></header><div class="body flush"><${CashTable} cash=${pv.totals.cash} /></div>
          <div class="body small muted">${pv.totals.feeModel}${pv.totals.optionRequirement?.length ? ` Short options reserve ${pv.totals.optionRequirement.map((r) => fmtMoney(r.amount, r.ccy)).join(', ')}.` : ''}</div></section>
        <section class="panel"><header><h3>Payoff</h3></header><div class="body"><${Payoff} payoff=${pv.payoff} netPremium=${pv.totals.netPremium} /></div></section>
      </div>
    </div>
  <//>`;
}

/** Fetch a preview and open the dialog. Shows the error as a toast if the package cannot be built. */
export async function openPreview(input, { openOverlay, toastError, onDone, extra, confirmLabel, banner, path = '/api/strategies/preview' } = {}) {
  try {
    const pv = await post(path, input);
    openOverlay((close) => html`<${PreviewModal} preview=${pv} onClose=${close} onDone=${onDone} extra=${extra} confirmLabel=${confirmLabel} banner=${banner} />`);
    return pv;
  } catch (err) {
    toastError(err);
    return null;
  }
}
export { Table };
