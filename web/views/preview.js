// Trade preview and confirmation.
//
// Every package (a single ticket, a strategy template, a hedge, a close/roll/resize, a financing
// arrangement) passes through this dialog. It shows each leg with its estimated fill and the fill
// model that produced it, the cash / margin / collateral / funding requirements, the payoff, and
// every check. Legs are editable; an edited package must be re-checked before it can be confirmed.
// One explicit confirmation submits the package. The confirmation token can be used only once.
//
// A confirmation sends back the figures that are on screen (the preview's `confirmation` snapshot:
// every leg and every package total). The server prices the legs again and refuses the confirmation
// if a leg or a total has moved beyond the Book's tolerances, or a term has changed. The dialog then
// shows what changed, was and now, on the new figures, and asks for a new confirmation of them.
// Below 1100 px the leg table turns into one block per leg, so no column is clipped; the package
// totals and the confirmation controls stay in the footer, which never scrolls away.
import { html, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, isNum, openOverlay, post, toast } from '../lib/core.js';
import { Button, Check, Checks, ErrorNote, Field, Modal, Money, Notice, Num, PayoffChart, Pill, Price, Prov, PURPOSE_LABEL, Select, Table, Text } from '../lib/ui.js';
import { ContractFields, draftToContract } from '../lib/contracts.js';

const ORDER_TYPES = [{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }, { value: 'stop_limit', label: 'Stop limit' }];
const TIFS = [{ value: 'day', label: 'Day' }, { value: 'gtc', label: 'Until cancelled' }];

function TermsList({ details }) {
  if (!details?.length) return null;
  return html`<dl class="terms">${details.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl>`;
}

/**
 * What is on screen, sent with a confirmation so the server can refuse it if anything has moved:
 * the preview's own snapshot of every leg and every package total (`pv.confirmation`), plus the
 * cash required per currency in the older form.
 */
export const expectedOf = (pv) => ({ ...(pv.confirmation || {}), cash: Object.fromEntries(Object.values(pv.totals.cash || {}).map((r) => [r.ccy, r.required])) });

const TOLERANCE_ROWS = [['legPricePct', 'leg price', '%'], ['legAmountPct', 'leg amounts', '%'], ['packageCashPct', 'package totals', '%'], ['grossCashPct', 'gross cash and notional', '%'], ['maxPreviewAgeSec', 'preview age', ' s']];
/** The Book's confirmation tolerances, in words. */
function tolerancesText(t) {
  if (!t) return '';
  return TOLERANCE_ROWS.map(([k, label, unit]) => (k === 'maxPreviewAgeSec' && !t[k] ? `${label} not limited` : `${label} ${t[k]}${unit}`)).join(', ');
}
/** One figure of a change list, drawn in its own unit. */
function changeValue(c, x) {
  if (x === null || x === undefined) return html`<span class="muted">none</span>`;
  if (c.unit === 'money') return fmtMoney(x, c.ccy);
  if (c.unit === 'price') return fmtPrice(x);
  if (c.unit === 'qty') return fmtQty(x);
  if (c.unit === 'rate') return `${fmtNum(x * 100, 3)}%`;
  if (c.unit === 'percent') return `${x}%`;
  if (c.unit === 'seconds') return `${x} s`;
  return String(x);
}
/**
 * What changed between the figures that were confirmed and the new pricing: one row per changed
 * figure, per leg and per package total, with what it was and what it is now.
 */
function Changes({ changes }) {
  if (!changes?.length) return null;
  const legs = [...new Set(changes.filter((c) => c.scope === 'leg').map((c) => c.n))].sort((a, b) => a - b);
  const groups = [...legs.map((n) => [`Leg ${n}: ${changes.find((c) => c.n === n).label}`, changes.filter((c) => c.scope === 'leg' && c.n === n)]),
    ...[...new Set(changes.filter((c) => c.scope === 'package').map((c) => c.label))].map((l) => [l, changes.filter((c) => c.scope === 'package' && c.label === l)])];
  return html`<section class="panel changed" data-testid="changes"><header><h3>What changed since you confirmed</h3><span class="note">${legs.length ? `${legs.length} leg${legs.length > 1 ? 's' : ''}` : 'No leg'}${changes.some((c) => c.scope === 'package') ? ', and the package totals' : ''}</span></header>
    <div class="body flush"><div class="tablewrap"><table class="ledger changes"><thead><tr><th>Figure</th><th class="r">Was</th><th class="r">Now</th><th class="r">Change</th><th class="r">Tolerance</th></tr></thead>
      <tbody>${groups.map(([title, rows]) => html`<tr class="group"><td colspan="5">${title}</td></tr>
        ${rows.map((c) => html`<tr><td class="wrap">${c.fieldLabel}${c.note ? html`<div class="sub">${c.note}</div>` : null}</td>
          <td class="r nowrap" data-label="Was">${changeValue(c, c.was)}</td><td class="r nowrap strong" data-label="Now">${changeValue(c, c.now)}</td>
          <td class="r nowrap" data-label="Change">${changeText(c)}</td>
          <td class="r nowrap muted" data-label="Tolerance">${isNum(c.tolerancePct) ? `${c.tolerancePct}%` : c.kind === 'term' ? 'none: a term' : ''}</td></tr>`)}`)}</tbody></table></div></div></section>`;
}
/** The size of a change: the signed difference in the figure's own unit, and its size in percent of what was displayed. */
function changeText(c) {
  if (c.kind === 'term' || !isNum(c.was) || !isNum(c.now)) return c.was === null || c.was === undefined ? 'new' : c.now === null || c.now === undefined ? 'gone' : 'changed';
  const d = c.now - c.was;
  const diff = c.unit === 'money' ? fmtMoney(d, c.ccy, { sign: true }) : c.unit === 'price' ? `${d > 0 ? '+' : '−'}${fmtPrice(Math.abs(d))}` : fmtNum(d, 2, { sign: true });
  return isNum(c.changePct) ? `${diff} (${fmtNum(Math.abs(c.changePct), 2)}%)` : diff;
}
/** "was 100.00" under a figure that changed since the last confirmation. */
function Was({ changes, field, unit }) {
  const c = (changes || []).find((x) => x.field === field);
  if (!c) return null;
  return html`<div class="was">was ${changeValue(unit ? { ...c, unit } : c, c.was)}</div>`;
}

/**
 * Full contract ticket for a leg that carries a new contract (a swap, forward, CDS, OTC option or
 * loan): every term can be read and changed here before the package is re-checked. A swap shows
 * its legs, benchmark and spread, schedules, currencies, counterparty and collateral.
 */
function ContractDialog({ leg, contract, onSave, onClose }) {
  const [d, setD] = useState({ ...contract, family: leg.instrument.family, terms: JSON.parse(JSON.stringify(contract.terms || {})) });
  return html`<${Modal} size="mid" title=${`Contract terms: ${contract.name}`} sub="Changes apply to this package only. Re-check the package afterwards; the contract is registered when the trade is confirmed." onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" onClick=${() => { onSave(draftToContract(d)); onClose(); }}>Use these terms<//>`}>
    <div class="grid-form">
      <${Field} label="Contract name" span=${2}><${Text} value=${d.name} onInput=${(v) => setD({ ...d, name: v })} /><//>
      <${Field} label="Currency"><${Text} value=${d.tradingCcy} onInput=${(v) => setD({ ...d, tradingCcy: v.toUpperCase() })} /><//>
      <${ContractFields} draft=${d} onChange=${setD} />
    </div><//>`;
}

function LegRow({ leg, edit, onEdit, onRemove, canRemove, changes }) {
  const [open, setOpen] = useState(leg.instrument?.draft && !['option'].includes(leg.instrument.family));
  const [stating, setStating] = useState(Boolean(leg.settle));
  const stl = leg.settlement, cal = leg.calendar;
  // Margin or independent amount this leg posts (positive) or gets back (negative). The server gives it as
  // initialMargin when the leg is priced and always as the change in the independent amount under the agreement.
  const indep = leg.collateral?.independent;
  const held = isNum(leg.initialMargin) ? leg.initialMargin : isNum(indep?.delta) ? indep.delta : 0;
  const heldCcy = isNum(leg.initialMargin) ? leg.currency : indep?.ccy || leg.currency;
  const e = { ...leg, ...edit };
  const p = leg.price;
  const set = (patch) => onEdit(leg.n, patch);
  const hasTerms = leg.instrument?.details?.length > 0;
  return html`<tr class=${changes?.length ? 'moved' : ''}>
    <td data-label="Leg"><span class="leg-n">${leg.n}</span>${leg.dependsOn?.length ? html`<div class="dep">after ${leg.dependsOn.join(', ')}</div>` : null}</td>
    <td class="wrap" data-label="What">
      <div class="strong">${leg.label}</div>
      <div class="sub">${leg.kindLabel}${leg.instrument ? `, ${leg.instrument.name}` : ''}${leg.instrument?.draft ? ', new contract' : ''}</div>
      ${leg.hedgeFamily ? html`<div class="sub">${leg.hedgeFamily}${leg.riskAddressed ? `: ${leg.riskAddressed}` : ''}${leg.sizingBasis ? `, sized by ${leg.sizingBasis}` : ''}${isNum(leg.hedgeRatio) ? `, ratio ${leg.hedgeRatio}` : ''}</div>` : null}
      ${leg.note ? html`<div class="sub">${leg.note}</div>` : null}
      ${(leg.econNotes || []).slice(0, open ? 9 : 1).map((n) => html`<div class="sub">${n}</div>`)}
      ${hasTerms ? html`<button class="btn link small" onClick=${() => setOpen(!open)}>${open ? 'Hide contract terms' : 'Show contract terms'}</button>` : null}
      ${leg.contract ? html` <button class="btn link small" onClick=${() => openOverlay((close) => html`<${ContractDialog} leg=${leg} contract=${e.contract || leg.contract} onClose=${close} onSave=${(c) => set({ contract: c })} />`)}>Edit contract terms</button>` : null}
      ${edit?.contract ? html`<div class="sub" style="color:var(--amber)">Contract terms changed. Re-check to see them applied.</div>` : null}
      ${open && hasTerms ? html`<${TermsList} details=${leg.instrument.details} />` : null}
      ${leg.terms && open && !hasTerms ? html`<${TermsList} details=${leg.terms} />` : null}
      ${cal?.flag ? html`<div class="calflag"><${Pill} tone="warn">${cal.flag === 'weekends-only' ? 'weekends-only calendar' : 'approximate calendar'}<//> ${cal.flagText}</div>` : null}
      ${(changes || []).filter((c) => ['leg', 'quoteStatus', 'quoteFreshness', 'executable', 'priceModel', 'orderType', 'borrow.available', 'borrow.source', 'financing.rateType', 'financing.referenceRate', 'financing.maturity', 'financing.from', 'agreement.basis', 'agreement.agreementId', 'agreement.variation'].includes(c.field)).map((c) => html`<div class="was">${c.fieldLabel}: was ${changeValue(c, c.was)}, now ${changeValue(c, c.now)}${c.note ? `. ${c.note}` : ''}</div>`)}
    </td>
    <td class="r" data-label="Quantity">
      ${['trade', 'borrow_sec', 'loan', 'repo_open', 'lend_sec', 'repay', 'return_sec', 'recall_sec', 'link'].includes(leg.kind)
        ? html`<${Num} cls="mini" value=${e.qty} onInput=${(v) => set({ qty: v })} />` : fmtQty(leg.qty)}
      <div class="sub">${leg.qtyLabel}</div>
      ${isNum(leg.deliverableUnits) && leg.instrument?.family === 'option' ? html`<div class="sub">${fmtQty(leg.deliverableUnits)} per contract</div>` : null}
      <${Was} changes=${changes} field="qty" />
    </td>
    <td data-label="Order">
      ${leg.kind === 'trade' ? html`
        <${Select} value=${e.orderType} onChange=${(v) => set({ orderType: v })} options=${ORDER_TYPES} />
        ${['limit', 'stop_limit'].includes(e.orderType) ? html`<div class="row" style="margin-top:4px"><span class="sub">limit</span><${Num} cls="mini" value=${e.limitPrice} onInput=${(v) => set({ limitPrice: v })} /></div>` : null}
        ${['stop', 'stop_limit'].includes(e.orderType) ? html`<div class="row" style="margin-top:4px"><span class="sub">stop</span><${Num} cls="mini" value=${e.stopPrice} onInput=${(v) => set({ stopPrice: v })} /></div>` : null}
        <div style="margin-top:4px"><${Select} value=${e.tif} onChange=${(v) => set({ tif: v })} options=${TIFS} /></div>` : html`<span class="muted">${leg.kindLabel}</span>`}
    </td>
    <td class="wrap fillcell" data-label="Estimated fill">
      ${leg.kind === 'trade' ? html`
        <div>${isNum(p?.estimate) ? html`<span class="price"><span class="v">${fmtPrice(p.estimate)}</span></span>` : html`<span class="missing" title=${p?.reason || ''}>no executable price</span>`}
          ${p?.observation ? html` <${Prov} obs=${p.observation} />` : null}</div>
        <${Was} changes=${changes} field="price" />
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
          <span class="sub">fee (decimal a year)</span><${Num} cls="mini" value=${e.borrow?.feeRate ?? null} onInput=${(v) => set({ borrow: { ...(e.borrow || {}), feeRate: v, available: e.borrow?.available ?? true } })} placeholder="0.005" /></div>` : null}
        <${Was} changes=${changes} field="borrow.feeRate" />` : null}
      ${leg.kind === 'funding' ? html`<div>From ${leg.fundingInfo?.from?.name || 'Treasury'}</div><div class="sub">${fmtMoney(leg.fundingInfo?.available, leg.currency)} available there. A transfer does not convert currency.</div>` : null}
      ${leg.kind === 'reserve' ? html`<div>${fmtMoney(leg.reserve?.amount, leg.reserve?.ccy)} stays in the Account but cannot be used elsewhere.</div>` : null}
      ${leg.kind === 'link' ? html`<div>Existing position of ${fmtQty(leg.existing?.qty)}${isNum(leg.existing?.avgCost) ? ` at average cost ${fmtPrice(leg.existing.avgCost)}` : ''}</div><div class="sub">Nothing is bought or sold.</div>` : null}
      ${['loan', 'repo_open', 'lend_sec'].includes(leg.kind) && isNum(leg.dailyCost) ? html`<div class="sub">About ${fmtMoney(leg.dailyCost, leg.currency)} of interest a day</div>` : null}
      ${leg.financing && isNum(leg.financing.rate) ? html`<div class="sub">Rate ${fmtNum(leg.financing.rate * 100, 3)}% ${leg.financing.rateType || ''}${leg.financing.maturity ? `, to ${leg.financing.maturity}` : ''}</div>` : null}
      ${leg.financing?.referenceRate ? html`<div class="sub">${leg.financing.referenceRate} + ${fmtNum((leg.financing.spread || 0) * 100, 2)}%${isNum(leg.financing.fixing) ? `, fixing ${leg.financing.fixing}%` : ''}</div>` : null}
      ${['repay', 'repo_close'].includes(leg.kind) && leg.financing ? html`<div>Principal ${fmtMoney(leg.financing.principal, leg.currency)}</div><div class="sub">${leg.financing.interest ? `plus interest of ${fmtMoney(leg.financing.interest, leg.currency)} accrued to today, settled with it` : leg.financing.full ? 'no interest is outstanding' : 'a part repayment: interest stays on its schedule'}</div>` : null}
      <${Was} changes=${changes} field="financing.rate" /><${Was} changes=${changes} field="financing.fixing" /><${Was} changes=${changes} field="financing.dailyCost" />
    </td>
    <td class="settlecell" data-label="Settles">
      <div class="nowrap">${leg.settleDate || ''}</div>
      ${stl ? html`<div class="sub">${stl.basis === 'transaction-date' || stl.basis === 'transaction-lag' ? html`<b>Stated for this trade</b>${isNum(stl.lag) && !stl.conflict ? ` (${stl.lag === 0 ? 'same day' : `T+${stl.lag}`})` : ''}` : stl.basis === 'instrument' ? `${stl.label}, set on the instrument` : stl.basis === 'book' ? `${stl.label}, Book default` : stl.label}</div>
        <div class="sub" title=${cal?.settlement?.label || ''}>on ${stl.calendarId}</div>` : null}
      ${leg.trading && !leg.trading.open ? html`<div class="sub" style="color:var(--amber)">Market closed today on ${leg.trading.calendarId}: matched ${leg.trading.tradeDate}</div>` : null}
      <${Was} changes=${changes} field="settleDate" />
      ${leg.kind === 'trade' && stl && stl.basis !== 'product' ? html`${stating ? html`<div class="settle-edit">
          <label class="sub">date<input type="date" value=${e.settle?.date || ''} onInput=${(ev) => set({ settle: ev.target.value ? { date: ev.target.value } : null })} /></label>
          <label class="sub">or lag<${Num} cls="mini" value=${e.settle?.lag ?? null} onInput=${(v) => set({ settle: v === null ? null : { lag: v } })} placeholder="days" /></label>
          <button class="btn link small" onClick=${() => { set({ settle: null }); setStating(false); }}>Use the convention</button></div>`
        : html`<button class="btn link small" onClick=${() => setStating(true)}>State a settlement</button>`}` : null}
    </td>
    <td class="r amt" data-label="Cash">
      ${isNum(leg.cash) ? html`<div class="nowrap"><${Money} value=${leg.cash} ccy=${leg.currency} signed /></div>` : leg.kind === 'trade' ? html`<span class="missing" title="Needs a price">—</span>` : ''}
      ${(leg.otherCash || []).map((o) => html`<div class="nowrap"><${Money} value=${o.amount} ccy=${o.ccy} signed /></div>`)}
      ${leg.accrued ? html`<div class="sub">incl. accrued ${fmtMoney(leg.accrued, leg.currency)}</div>` : null}
      ${leg.feeTotal ? html`<div class="sub">fees ${fmtMoney(leg.feeTotal, leg.currency)}</div>` : null}
      <${Was} changes=${changes} field="cash" /><${Was} changes=${changes} field="fees" /><${Was} changes=${changes} field="financing.amount" />
    </td>
    <td class="r amt" data-label="Notional, margin">
      ${isNum(leg.notional) ? html`<div class="nowrap" title=${leg.notionalBasis || ''}>${fmtMoney(leg.notional, leg.currency)}</div>` : ''}
      ${held > 0 ? html`<div class="sub">margin ${fmtMoney(held, heldCcy)}</div>` : null}
      ${held < 0 ? html`<div class="sub" data-testid="released">${leg.instrument?.family === 'future' ? 'margin released' : 'collateral returned'} ${fmtMoney(-held, heldCcy)}</div>
        <div class="sub">${leg.instrument?.family === 'future' ? 'Initial margin held for the contracts this leg closes comes back to free cash.' : 'The independent amount held for the part of the position this leg closes comes back to free cash.'}</div>` : null}
      ${leg.shortCollateral ? html`<div class="sub">collateral top-up ${fmtMoney(leg.shortCollateral.topUp, leg.currency)}</div><div class="sub">margin hold ${fmtMoney(leg.shortCollateral.marginHold, leg.currency)}</div>` : null}
      <${Was} changes=${changes} field="notional" /><${Was} changes=${changes} field="margin" /><${Was} changes=${changes} field="collateral.topUp" /><${Was} changes=${changes} field="agreement.independent" />
    </td>
    <td class="rm">${canRemove ? html`<button class="x" title="Remove this leg" onClick=${() => onRemove(leg.n)}>×</button>` : null}</td>
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
  // After a refused confirmation: what changed (was / now), and whether the new figures have been acknowledged.
  const [changes, setChanges] = useState([]);
  const [reviewed, setReviewed] = useState(false);
  const dirty = Object.keys(edits).length > 0 || removed.length > 0;
  const prot = pv.protection;
  const needsAck = Boolean(prot?.needsAcknowledgement && !prot.acknowledged);

  const editedLegs = () => {
    const keep = pv.legs.filter((l) => !removed.includes(l.n));
    const renum = new Map(keep.map((l, i) => [l.n, i + 1]));
    return keep.map((l) => ({ ...l, ...(edits[l.n] || {}), n: renum.get(l.n), dependsOn: (l.dependsOn || []).filter((d) => renum.has(d)).map((d) => renum.get(d)) }));
  };
  const recheck = async (more = {}) => {
    setBusy(true); setError(null);
    try {
      // The legs now on screen are the package: financing sized automatically for the first preview
      // is already among them (or was removed on purpose), so it is not sized and added again.
      const next = await post('/api/strategies/preview', { ...pv.input, ...extra, ...more, financing: null, legs: editedLegs(), clientToken: pv.token });
      setPv(next); setEdits({}); setRemoved([]); setChanges([]); setReviewed(false);
    } catch (err) { setError(err); }
    setBusy(false);
  };
  const confirm = async () => {
    if (busy || done) return; // one confirmation, one submission
    setBusy(true); setError(null);
    try {
      // Exactly the legs displayed, with every figure displayed: the server prices them again and
      // refuses the confirmation if a leg or a total has moved away from what is on screen.
      const out = await post('/api/strategies', { ...pv.input, ...extra, legs: pv.legs, clientToken: pv.token, confirm: true, expected: expectedOf(pv) });
      setDone(true);
      bump();
      const s = out.strategy;
      const working = s.orders.filter((o) => ['pending', 'working', 'partial'].includes(o.status)).length;
      const dead = s.orders.filter((o) => ['rejected', 'cancelled', 'expired'].includes(o.status) && o.submission === pv.token).length;
      toast(out.duplicate ? 'This package was already submitted; showing the original.' : dead ? `${s.name}: ${dead} leg${dead > 1 ? 's' : ''} did not execute. Check the strategy.` : working ? `${s.name} submitted. ${working} leg${working > 1 ? 's are' : ' is'} working.` : `${s.name} executed.`, dead ? 'err' : working ? 'warn' : 'ok', 6000);
      onDone?.(s, out);
      onClose();
    } catch (err) {
      // Refused: show the new figures and what changed. Nothing is confirmed again without a new click.
      if (err.details?.preview) { setPv(err.details.preview); setEdits({}); setRemoved([]); setChanges(err.details.changes || []); setReviewed(false); }
      setError(err);
      setBusy(false);
    }
  };

  const groups = [['primary', 'Primary legs'], ['hedge', 'Hedge legs'], ['financing', 'Financing and reservations']];
  const legs = pv.legs.filter((l) => !removed.includes(l.n));
  const columns = ['', 'Leg', 'Quantity', 'Order', 'Estimated fill', 'Settles', 'Cash', 'Notional, margin', ''];
  const mustReview = changes.length > 0 && !dirty;
  const totals = Object.values(pv.totals.cash || {});
  return html`<${Modal} size="wide" onClose=${onClose} title=${`Preview: ${pv.name}`}
    sub=${`${pv.unit.name} in ${pv.book.name}, ${pv.templateName}${pv.attachTo ? ', added to the existing strategy' : ''}, ${legs.length} leg${legs.length > 1 ? 's' : ''}`}
    footer=${html`
      <div class="pv-totals" data-testid="totals">${totals.length ? totals.map((t) => html`<span class="nowrap">Cash required <b>${fmtMoney(t.required, t.ccy)}</b>${t.shortfall > 0 ? html`, <span class="loss strong">short ${fmtMoney(t.shortfall, t.ccy)}</span>` : ''}</span>`) : html`<span>No cash moves at trade</span>`}
        <span class="note">Simulated execution. Nothing is sent to a real market.</span></div>
      <span class="grow"></span>
      ${mustReview ? html`<${Check} checked=${reviewed} onChange=${setReviewed}>I have checked the new figures<//>` : null}
      <${Button} onClick=${onClose}>Cancel<//>
      ${dirty ? html`<${Button} kind="primary" busy=${busy} onClick=${() => recheck()}>Re-check edited package<//>`
        : html`<${Button} kind="primary" busy=${busy} disabled=${pv.blocking > 0 || !legs.length || done || (mustReview && !reviewed)} onClick=${confirm} title=${pv.blocking ? 'Resolve the blocking checks first' : mustReview && !reviewed ? 'Check the new figures first' : ''}>${mustReview ? 'Confirm the new figures' : confirmLabel}<//>`}`}>
    <div class="stack">
      ${banner}
      ${changes.length ? html`<${Notice} tone="warn"><b>Nothing was submitted.</b> The package was priced again when you confirmed, and it no longer matches what was displayed. The figures below are the new ones. Check what changed, then confirm again or cancel.<//>
        <${Changes} changes=${changes} />` : html`<${ErrorNote} error=${error} />`}
      ${changes.length && error && !error.details?.changes?.length ? html`<${ErrorNote} error=${error} />` : null}
      ${dirty ? html`<${Notice} tone="warn">You changed the package. Re-check it before confirming; the figures below are from before your changes.<//>` : null}
      ${needsAck ? html`<${Notice} tone="warn"><b>Protection is already in place.</b> ${prot.prior.map((x) => x.label).join('; ')}. The hedge package adds ${prot.added.map((x) => x.label).join('; ')}. ${prot.explain}
        <div class="row" style="margin-top:6px"><${Button} small busy=${busy} onClick=${() => recheck({ extraProtection: true })}>Add this protection deliberately<//><span class="note">or remove the added hedge legs below and re-check.</span></div><//>` : null}
      <${Checks} checks=${pv.checks.filter((k) => !(needsAck && k.code === 'extra-protection'))} />
      <div class="note">One snapshot: every figure below was priced together at ${fmtTime(pv.generatedAt, { date: false, seconds: true })}. Cash required is the sum of the legs' purchases, fees, margin, collateral and reservations.</div>
      ${pv.confirmation ? html`<div class="note" data-testid="tolerances">Confirming executes these figures only. If a figure has moved by more than this Book's tolerances when you confirm (${tolerancesText(pv.confirmation.tolerances)}), or a term such as a settlement date, quote status, financing rate or borrow availability has changed, nothing is submitted and the changes are shown. The tolerances are set under <a href="#/settings" onClick=${onClose}>Settings</a>.</div>` : null}
      <div class="tablewrap"><table class="ledger legs pv-legs margin">
        <thead><tr>${columns.map((c, i) => html`<th class=${i === 2 || i >= 6 ? 'r' : ''}>${c}</th>`)}</tr></thead>
        <tbody>${groups.map(([key, label]) => {
          const mine = legs.filter((l) => (l.purpose === 'reserve' ? 'financing' : l.purpose) === key);
          if (!mine.length) return null;
          return html`<tr class="group"><td colspan="9">${label}${key === 'financing' ? html` <span class="sub" style="font-weight:400">obligations, shown apart from the legs that carry price or risk</span>` : ''}</td></tr>
            ${mine.map((l) => html`<${LegRow} key=${`${pv.generatedAt}-${l.n}`} leg=${l} edit=${edits[l.n]} canRemove=${allowRemove && legs.length > 1} changes=${changes.filter((c) => c.scope === 'leg' && c.n === l.n)}
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
// `Changes` draws a refusal's change list (err.details.changes) as was / now; other dialogs that confirm a preview can reuse it.
export { Table, Changes };
