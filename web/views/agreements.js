// Paper collateral agreements and OTC collateral of the selected Book.
//
// Collateral on a swap, credit default swap, forward or OTC option follows the basis its contract
// states: an agreement recorded here, position-level terms, or the explicit choice of no collateral.
// This component lists the agreements (create, edit, close), every OTC position with its basis,
// requirement, posted and received amounts and last movement, the netting sets that span several
// positions, the register of movements, and which agreement terms are simulated and which are only
// recorded. Treasury shows it for the whole Book; an Account page shows it for that Account.
// Everything here belongs to one Book: nothing is netted, posted or listed across Books.
import { html, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtQty, fmtTime, get, isNum, openOverlay, post, put, toast, toastError, useLive } from '../lib/core.js';
import { Button, Check, Empty, ErrorNote, Field, Missing, Modal, Money, Notice, Num, Panel, Pill, Price, Select, Table, Text } from '../lib/ui.js';
import { CollateralBasisFields } from '../lib/contracts.js';

const unitName = (u) => (u?.kind === 'treasury' ? 'Treasury' : u?.name || '');
// The instrument page is where a mark is entered by hand; loaded on demand, as the other screens do.
const openInst = async (id) => { try { (await import('./instrument.js')).openInstrument(id); } catch (err) { toastError(err); } };
const none = (text = 'none') => html`<span class="muted">${text}</span>`;
const amounts = (list, empty) => (list?.length ? list.map((x) => html`<div class="nowrap">${fmtMoney(x.amount, x.ccy)}</div>`) : none(empty));
const pct = (x) => (isNum(x) ? `${(x * 100).toFixed(2)}%` : '');
const CALL = { ok: ['ok', 'met'], failed: ['bad', 'call failed'], cannot_value: ['warn', 'cannot be valued'], not_valued_yet: ['', 'first valuation pending'], closed: ['', 'closed'] };
const CallPill = ({ status, reason }) => { const [tone, label] = CALL[status] || ['', status]; return html`<${Pill} tone=${tone} title=${reason || ''}>${label}<//>`; };
const KIND_SHORT = { bilateral: 'Bilateral', cleared: 'Cleared', uncollateralized: 'Uncollateralized' };
const KIND_HINT = {
  bilateral: 'A CSA-style agreement with one counterparty: independent amount, variation margin, threshold and minimum transfer as entered below.',
  cleared: 'Clearing terms for cleared OTC contracts: initial margin and daily variation margin with the clearing house or clearing broker. No threshold.',
  uncollateralized: 'An explicit paper assumption for this counterparty: nothing is posted and nothing is received on positions under it.',
};
const SCOPE_HINT = {
  position: 'Each position is called on its own mark.',
  account: 'The positions of one Account under this agreement are marked together, and one net amount moves.',
  shared: 'The positions of every covered Account are marked together. Needs a posting unit, and each movement records its allocation to each Account.',
};

// ---- create / edit ------------------------------------------------------------------------------------------

const blank = (book, unitId) => ({
  name: '', counterparty: '', kind: 'bilateral', unitIds: unitId ? [unitId] : [], postingUnitId: '', baseCcy: book.reportingCcy, postingCcy: book.reportingCcy, haircut: 0,
  nettingScope: 'position', threshold: 0, minimumTransfer: 0, iaType: 'none', iaPct: null, iaAmount: null, variationMargin: false, securities: '', recorded: {},
});
function fromView(a) {
  const t = a.terms;
  const cash = (t.eligible || []).find((e) => e.type === 'cash' && e.ccy === t.postingCcy);
  return {
    name: a.name, counterparty: a.counterparty, kind: a.kind, unitIds: [...a.unitIds], postingUnitId: a.postingUnitId || '', baseCcy: t.baseCcy, postingCcy: t.postingCcy, haircut: cash?.haircut || 0,
    nettingScope: t.nettingScope, threshold: t.threshold, minimumTransfer: t.minimumTransfer, iaType: t.independentAmount?.type || 'none', iaPct: t.independentAmount?.pct ?? null, iaAmount: t.independentAmount?.amount ?? null,
    variationMargin: Boolean(t.variationMargin), securities: (t.eligible || []).filter((e) => e.type === 'securities').map((e) => e.description).join('; '), recorded: { ...(t.recorded || {}) },
  };
}
const toBody = (f) => ({
  name: f.name, counterparty: f.counterparty, kind: f.kind, unitIds: f.unitIds, postingUnitId: f.kind === 'uncollateralized' ? null : f.postingUnitId || null,
  terms: {
    baseCcy: f.baseCcy, postingCcy: f.postingCcy, nettingScope: f.nettingScope, threshold: f.kind === 'cleared' ? 0 : f.threshold ?? 0, minimumTransfer: f.minimumTransfer ?? 0,
    independentAmount: f.iaType === 'pct' ? { type: 'pct', pct: f.iaPct } : f.iaType === 'fixed' ? { type: 'fixed', amount: f.iaAmount } : { type: 'none' },
    variationMargin: f.variationMargin,
    eligible: [{ type: 'cash', ccy: f.postingCcy, haircut: f.haircut ?? 0 }, ...(f.securities.trim() ? [{ type: 'securities', description: f.securities.trim() }] : [])],
    recorded: f.recorded,
  },
});

/** Record a new agreement, or change one. Terms that define the netting sets are fixed while positions are open under it. */
export function AgreementDialog({ book, agreement, unitId, meta, onClose, onDone }) {
  const editing = Boolean(agreement);
  const locked = editing && agreement.inUse;
  const [f, setF] = useState(() => (agreement ? fromView(agreement) : blank(book, unitId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => { setError(null); setF((x) => ({ ...x, ...patch })); };
  const collateralized = f.kind !== 'uncollateralized';
  const toggleUnit = (id, on) => set({ unitIds: on ? [...new Set([...f.unitIds, id])] : f.unitIds.filter((x) => x !== id) });
  const save = async () => {
    setBusy(true);
    try {
      const out = editing ? await put(`/api/books/${book.id}/agreements/${agreement.id}`, toBody(f)) : await post(`/api/books/${book.id}/agreements`, toBody(f));
      toast(editing ? 'Changes saved. They apply from the next valuation.' : 'Agreement recorded.');
      bump(); onDone?.(out); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const recordedOnly = (meta?.recordedOnly || []).filter((r) => r.key !== 'securitiesCollateral');
  return html`<${Modal} title=${editing ? `Change ${agreement.name}` : 'New collateral agreement'} size="mid" onClose=${onClose}
    sub=${`A paper agreement of ${book.name}. It belongs to this Book alone and covers only its Treasury and Accounts.`}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} onClick=${save}>${editing ? 'Save changes' : 'Record agreement'}<//>`}>
    <div class="stack">
      ${locked ? html`<${Notice} tone="warn">Positions are open under this agreement. Its kind, currencies, netting scope and posting unit stay as they are until those positions end. Amounts and thresholds can change, and apply from the next valuation.<//>` : null}
      <div class="grid-form">
        <${Field} label="Agreement name" span=${2}><${Text} value=${f.name} onInput=${(v) => set({ name: v })} placeholder="CSA with Dealer A" autofocus=${!editing} /><//>
        <${Field} label="Counterparty" span=${2} hint=${f.kind === 'cleared' ? 'The clearing house, or the clearing broker' : undefined}><${Text} value=${f.counterparty} onInput=${(v) => set({ counterparty: v })} /><//>
        <${Field} label="Kind" span=${2} hint=${KIND_HINT[f.kind]}><${Select} value=${f.kind} disabled=${locked} onChange=${(v) => set({ kind: v })} options=${Object.entries(meta?.kinds || {}).map(([value, label]) => ({ value, label }))} /><//>
        <${Field} label="Covers" span=${2} hint="Only the units ticked here can open positions under it">
          <div class="row">${book.units.map((u) => html`<${Check} checked=${f.unitIds.includes(u.id)} onChange=${(on) => toggleUnit(u.id, on)}>${unitName(u)}<//>`)}</div><//>
      </div>
      ${collateralized ? html`<h4>Terms that are simulated</h4>
      <div class="grid-form">
        <${Field} label=${f.kind === 'cleared' ? 'Initial margin' : 'Independent amount'}><${Select} value=${f.iaType} onChange=${(v) => set({ iaType: v })} options=${[{ value: 'none', label: 'None' }, { value: 'pct', label: 'Share of notional' }, { value: 'fixed', label: 'Fixed amount per position' }]} /><//>
        ${f.iaType === 'pct' ? html`<${Field} label="Share of notional (decimal)" hint="0.05 = 5%"><${Num} value=${f.iaPct} onInput=${(v) => set({ iaPct: v })} /><//>` : null}
        ${f.iaType === 'fixed' ? html`<${Field} label=${`Amount per position (${f.baseCcy})`}><${Num} value=${f.iaAmount} onInput=${(v) => set({ iaAmount: v })} /><//>` : null}
        <${Field} label="Variation margin" span=${2}><${Check} checked=${f.variationMargin} onChange=${(v) => set({ variationMargin: v })}>Exchanged each end of day against the mark<//><//>
        <${Field} label=${`Threshold (${f.baseCcy})`} hint=${f.kind === 'cleared' ? 'A cleared agreement has none' : 'No call while the net mark is inside it'}><${Num} value=${f.kind === 'cleared' ? 0 : f.threshold} disabled=${f.kind === 'cleared'} onInput=${(v) => set({ threshold: v })} /><//>
        <${Field} label=${`Minimum transfer (${f.baseCcy})`} hint="Smaller transfers are not made, in either direction"><${Num} value=${f.minimumTransfer} onInput=${(v) => set({ minimumTransfer: v })} /><//>
        <${Field} label="Base currency" hint="Of the threshold, the minimum transfer and the exposure"><${Text} value=${f.baseCcy} disabled=${locked} onInput=${(v) => set({ baseCcy: v.toUpperCase() })} /><//>
        <${Field} label="Collateral currency" hint="Eligible cash, posted and received"><${Text} value=${f.postingCcy} disabled=${locked} onInput=${(v) => set({ postingCcy: v.toUpperCase() })} /><//>
        <${Field} label="Haircut (decimal)" hint="On the collateral currency. 0.08 = 8%."><${Num} value=${f.haircut} onInput=${(v) => set({ haircut: v })} /><//>
        <${Field} label="Netting scope" span=${2} hint=${SCOPE_HINT[f.nettingScope]}><${Select} value=${f.nettingScope} disabled=${locked} onChange=${(v) => set({ nettingScope: v })} options=${Object.entries(meta?.nettingScopes || {}).map(([value, label]) => ({ value, label }))} /><//>
        <${Field} label="Posted and received by" span=${2} hint=${f.postingUnitId ? 'A shared arrangement: this unit posts and holds the collateral for every covered unit, and each movement records what is allocated to each Account.' : 'No sharing: each covered unit posts from, and holds in, its own cash.'}>
          <${Select} value=${f.postingUnitId} disabled=${locked} onChange=${(v) => set({ postingUnitId: v })} placeholder="Each covered unit, for itself" options=${book.units.map((u) => ({ value: u.id, label: `${unitName(u)}, for all covered units` }))} /><//>
      </div>
      <details open=${Boolean(f.securities) || Object.keys(f.recorded).length > 0}><summary class="note">Terms that are recorded, not simulated</summary>
        <div class="note" style="margin:6px 0 8px">Kept on the agreement and shown wherever it appears, labelled "recorded, not simulated". They change nothing in the paper books.</div>
        <div class="grid-form">
          <${Field} label="Securities accepted as collateral" span=${2} hint="Only cash is posted and received"><${Text} value=${f.securities} onInput=${(v) => set({ securities: v })} placeholder="For example: US Treasuries at a 2% haircut" /><//>
          ${recordedOnly.map((r) => html`<${Field} label=${r.label} span=${2} hint=${r.note}><${Text} value=${f.recorded[r.key] || ''} onInput=${(v) => set({ recorded: { ...f.recorded, [r.key]: v } })} /><//>`)}
        </div></details>` : html`<${Notice}>Positions under this agreement post nothing and receive nothing, whatever their mark. Each one shows "Uncollateralized (paper assumption)" as its basis.<//>`}
      <${ErrorNote} error=${error} />
    </div>
  <//>`;
}

/** Every term of one agreement, each marked as simulated or as recorded only. */
function TermsDialog({ agreement: a, onClose }) {
  return html`<${Modal} title=${a.name} sub=${`${a.kindLabel} with ${a.counterparty}${a.status === 'closed' ? '. Closed.' : ''}`} onClose=${onClose} footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Close<//>`}>
    <div class="stack">
      <div class="note">Covers ${a.units.map(unitName).join(', ')}.${a.postingUnit ? ` Collateral is posted and received by ${unitName(a.postingUnit)} for all of them (a shared arrangement).` : ' Each covered unit posts and receives for itself.'}</div>
      <${Table} rows=${a.termRows} columns=${[
        { label: 'Term', render: (r) => r.label },
        { label: 'As agreed', cls: 'wrap', render: (r) => html`${r.value}${r.note ? html`<div class="sub">${r.note}</div>` : null}` },
        { label: 'In the paper books', render: (r) => (r.simulated ? html`<${Pill} tone="ok">simulated<//>` : html`<${Pill} tone="warn">recorded, not simulated<//>`) },
      ]} />
    </div><//>`;
}

/** Record the basis of a position that has none on record. */
function BasisDialog({ book, position: p, onClose, onDone }) {
  const [basis, setBasis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    try { await put(`/api/books/${book.id}/positions/${p.positionId}/collateral-basis`, { basis }); toast('Collateral basis recorded.'); bump(); onDone?.(); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return html`<${Modal} title="Record the collateral basis" sub=${`${p.instrument.symbol || p.instrument.name}, held by ${unitName(p.unit)}. Until a basis is recorded the position is treated as uncollateralized.`} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!basis?.type} onClick=${save}>Record basis<//>`}>
    <div class="stack"><div class="grid-form"><${CollateralBasisFields} value=${basis} onChange=${(b) => { setError(null); setBasis(b); }} ccy=${p.ccy} unitId=${p.unit.id} /></div>
      <div class="note">The basis stays as recorded for the life of the position. Any independent amount it calls for is posted at once, and variation margin starts at the next end-of-day pass.</div>
      <${ErrorNote} error=${error} /></div><//>`;
}

// ---- the desk --------------------------------------------------------------------------------------------------

function Agreements({ book, v, unit, reload }) {
  const openForm = (agreement) => openOverlay((close) => html`<${AgreementDialog} book=${book} agreement=${agreement} unitId=${unit?.id} meta=${v} onClose=${close} onDone=${reload} />`);
  const openTerms = (a) => openOverlay((close) => html`<${TermsDialog} agreement=${a} onClose=${close} />`);
  const closeIt = async (a) => {
    try { await post(`/api/books/${book.id}/agreements/${a.id}/close`); toast('Agreement closed.'); bump(); reload(); } catch (err) { toastError(err); }
  };
  return html`<${Panel} title="Collateral agreements" note=${unit ? `Paper agreements of ${book.name} that cover ${unit.name}` : `Paper agreements of ${book.name}. Each belongs to this Book alone.`} flush
    actions=${html`<${Button} small kind="primary" onClick=${() => openForm(null)}>New agreement<//>`}>
    <${Table} rows=${v.agreements} rowKey=${(a) => a.id} cls="fit" columns=${[
      { label: 'Agreement', render: (a) => html`<div style="min-width:150px"><div class="strong">${a.name}</div><div class="sub">${a.counterparty}</div></div>` },
      { label: 'Kind', render: (a) => html`<${Pill} tone=${a.kind === 'uncollateralized' ? '' : 'pen'} title=${a.kindLabel}>${KIND_SHORT[a.kind] || a.kindLabel}<//>${a.status === 'closed' ? html` <${Pill}>closed<//>` : null}` },
      { label: 'Covers', render: (a) => html`${a.units.map(unitName).join(', ')}${a.postingUnit ? html`<div class="sub">shared: posted and received by ${unitName(a.postingUnit)}</div>` : null}` },
      { label: 'Terms', cls: 'wrap', render: (a) => { const rec = a.termRows.filter((r) => !r.simulated).length; return html`<div class="coll-sentence two">${a.summary}</div><div class="sub"><a href="javascript:void 0" onClick=${() => openTerms(a)}>All terms</a>${rec ? html` <${Pill} tone="warn">${rec} recorded, not simulated<//>` : null}</div>`; } },
      { label: 'Open positions', align: 'r', render: (a) => a.openPositions || none('0') },
      { label: 'Posted', align: 'r', title: 'Collateral this Book has posted under the agreement. Still its own asset.', render: (a) => amounts(a.posted) },
      { label: 'Held', align: 'r', title: 'Collateral received from the counterparty: restricted cash, owed back', render: (a) => amounts(a.received) },
      { label: '', align: 'r', render: (a) => html`<div class="row" style="justify-content:flex-end;flex-wrap:nowrap">
        ${a.status === 'active' ? html`<${Button} small onClick=${() => openForm(a)}>Change<//><${Button} small disabled=${a.inUse} title=${a.inUse ? 'Positions are open, or collateral is held, under this agreement' : 'No new position can be opened under a closed agreement'} onClick=${() => closeIt(a)}>Close agreement<//>` : null}</div>` },
    ]} empty=${{ title: unit ? `No agreement covers ${unit.name}` : 'No agreements are recorded in this Book', children: 'Record an agreement with New agreement, then choose it as the collateral basis on a swap, credit default swap, forward or OTC option. A contract can also carry its own position-level terms, or be explicitly uncollateralized.' }} />
  <//>`;
}

function Positions({ book, v, unit, reload }) {
  const recordBasis = (p) => openOverlay((close) => html`<${BasisDialog} book=${book} position=${p} onClose=${close} onDone=${reload} />`);
  const by = (who, p) => (who && who.id !== p.unit.id ? html`<div class="sub">by ${unitName(who)}</div>` : null);
  const cols = [
    { label: 'Position', render: (p) => html`<div class="sym" style="min-width:150px;max-width:230px"><a href="javascript:void 0" title=${`${p.instrument.name}. Open the contract: its terms, and where its mark is entered by hand.`} onClick=${() => openInst(p.instrument.id)}>${p.instrument.symbol || p.instrument.name}</a></div><div class="sub">${unitName(p.unit)}, ${fmtQty(Math.abs(p.qty))} ${p.direction}</div>` },
    { label: 'Collateral basis', cls: 'wrap', render: (p) => html`<div>${p.basis.flagged ? html`<${Pill} tone="warn">${p.basis.problem ? 'terms cannot be used' : 'no terms recorded'}<//> ` : null}${p.basis.label}</div>
      ${p.basis.flagged ? html`<div class="sub">${p.basis.problem ? `${p.basis.problem} ` : ''}Treated as uncollateralized.${p.basis.type === 'none' && !p.basis.problem ? html` <a href="javascript:void 0" onClick=${() => recordBasis(p)}>Record its basis</a>` : null}</div>` : html`<div class="sub coll-sentence two" title=${p.basis.sentence || ''}>${p.basis.counterparty ? `${p.basis.counterparty}. ` : ''}${p.basis.type === 'uncollateralized' ? 'Nothing is posted or received.' : p.basis.sentence || ''}</div>`}
      ${p.basis.recordedOnly.length ? html`<div class="sub"><${Pill} tone="warn" title=${p.basis.recordedOnly.map((r) => `${r.label}: ${r.value}`).join('\n')}>${p.basis.recordedOnly.length} recorded, not simulated<//></div>` : null}` },
    { label: 'Mark', align: 'r', render: (p) => html`<${Price} obs=${p.mark.observation} value=${p.mark.price} reason="No mark is available. Variation margin cannot be valued without one." /><div class="sub"><${Money} value=${p.mark.mv} ccy=${p.ccy} signed reason="Needs a mark" /></div>` },
    { label: 'Independent amount', align: 'r', title: 'Required under the terms, and what is posted now', render: (p) => (!p.independent ? none('none') : p.independent.terms.type === 'none' && !p.independent.held ? none('none')
      : html`<div class="nowrap">${isNum(p.independent.required) ? fmtMoney(p.independent.required, p.independent.ccy) : html`<${Missing} reason=${p.independent.reason} />`} required</div>
        <div class="sub nowrap">${fmtMoney(p.independent.held, p.independent.ccy)} posted ${p.independent.status !== 'ok' ? html`<${CallPill} status=${p.independent.status} reason=${p.independent.reason} />` : null}</div>${by(p.independent.holder, p)}`) },
    { label: 'Variation margin', align: 'r', title: 'From the last end-of-day valuation of its netting set', render: (p) => (!p.variation ? none(p.basis.flagged || p.basis.type === 'uncollateralized' ? 'none' : 'not exchanged')
      : html`<div class="nowrap">${p.variation.posted ? html`${fmtMoney(p.variation.posted, p.variation.ccy)} posted` : p.variation.received ? html`${fmtMoney(p.variation.received, p.variation.ccy)} held` : 'nothing posted or held'} <${CallPill} status=${p.variation.status} reason=${p.variation.reason} /></div>
        <div class="sub">${p.variation.positionsInSet > 1 ? `netting set of ${p.variation.positionsInSet} positions, ` : ''}${isNum(p.variation.exposure) ? html`marked at <${Money} value=${p.variation.exposure} ccy=${p.variation.baseCcy} signed />` : 'not marked yet'}${p.variation.asOf ? ` on ${p.variation.asOf}` : ''}</div>
        ${p.variation.pending ? html`<div class="sub loss">${fmtMoney(p.variation.pending, p.variation.ccy)} call outstanding</div>` : null}${by(p.variation.holder, p)}`) },
    { label: 'Last movement', title: 'Positive: posted by this Book, or collateral it held and gave back. Negative: returned to this Book, or received from the counterparty. Hover a row for the full entry.',
      render: (p) => (p.lastMovement ? html`<div class="nowrap" title=${p.lastMovement.summary}>${p.lastMovement.businessDate}</div><div class="sub nowrap" title=${p.lastMovement.summary}>${p.lastMovement.kind === 'independent' ? 'independent' : 'variation'} ${fmtMoney(p.lastMovement.amount, p.lastMovement.ccy, { sign: true })}</div>` : none('none')) },
  ];
  return html`<${Panel} title="OTC positions and their collateral" note="Swaps, credit default swaps, forwards and OTC options, each with the basis that applies to it" flush>
    <${Table} margin cls="fit" rows=${v.positions} rowKey=${(p) => p.positionId} columns=${cols}
      empty=${{ title: unit ? `${unit.name} has no open OTC positions` : 'No OTC positions are open in this Book', children: 'A swap, credit default swap, forward or OTC option appears here when it fills, with its collateral basis, what the terms require and what has moved.' }} />
  <//>`;
}

function Sets({ v }) {
  const sets = v.sets.filter((s) => s.nettingScope !== 'position');
  if (!sets.length) return null;
  return html`<${Panel} title="Netting sets" note="Where several positions are marked together and one net amount moves" flush>
    <${Table} rows=${sets} rowKey=${(s) => s.key} columns=${[
      { label: 'Agreement', render: (s) => html`<div class="strong">${s.agreement?.name || 'Position-level terms'}</div><div class="sub">${s.nettingScope === 'shared' ? 'shared across Accounts' : 'inside one Account'}</div>` },
      { label: 'Positions', cls: 'wrap', render: (s) => s.positions.map((p) => html`<div class="nowrap">${p.name}: ${isNum(p.mvBase) ? fmtMoney(p.mvBase, s.baseCcy, { sign: true }) : 'no mark'}</div>`) },
      { label: 'Net mark', align: 'r', render: (s) => html`<${Money} value=${s.exposure} ccy=${s.baseCcy} signed reason="A position in the set has no mark" /><div class="sub">threshold ${fmtMoney(s.threshold, s.baseCcy)}</div>` },
      { label: 'Posted', align: 'r', render: (s) => (s.posted ? fmtMoney(s.posted, s.ccy) : none()) },
      { label: 'Held', align: 'r', render: (s) => (s.received ? fmtMoney(s.received, s.ccy) : none()) },
      { label: 'Moved by', render: (s) => unitName(s.holder) },
      { label: 'Allocated to', cls: 'wrap', title: 'How the balance is attributed to each Account whose positions it collateralises', render: (s) => (s.allocations.length ? s.allocations.map((a) => html`<div class="nowrap">${unitName(a.unit)}: ${fmtMoney(Math.abs(a.amount), s.ccy)}</div>`) : none()) },
      { label: 'Status', render: (s) => html`<${CallPill} status=${s.status} reason=${s.reason} />${s.asOf ? html`<div class="sub">${s.asOf}</div>` : null}` },
    ]} /><//>`;
}

function Movements({ v, unit }) {
  return html`<${Panel} title="Collateral movements" note="Every movement is one balanced ledger event that names its agreement and the mark it was called on" flush>
    <${Table} rows=${v.movements.slice(0, 60)} rowKey=${(m) => m.id} columns=${[
      { label: 'Date', render: (m) => html`<div class="nowrap">${m.businessDate}</div><div class="sub nowrap">${fmtTime(m.ts, { date: false })}</div>` },
      { label: 'Kind', render: (m) => (m.kind === 'independent' ? 'Independent amount' : 'Variation margin') },
      { label: 'Under', render: (m) => m.agreement?.name || html`<span class="muted">Position-level terms</span>` },
      { label: 'Moved by', render: (m) => unitName(m.holder) },
      { label: 'Allocated to', render: (m) => unitName(m.allocatedTo) },
      { label: 'Change', align: 'r', title: 'Positive: collateral this Book posted, or collateral it held and gave back. Negative: collateral returned to this Book, or received from the counterparty.', render: (m) => html`<span class="nowrap">${fmtMoney(m.amount, m.ccy, { sign: true })}</span>` },
      { label: 'What happened', cls: 'wrap', render: (m) => html`<div class="coll-sentence" title=${m.summary}>${m.summary}</div><div class="sub">event #${m.eventId}</div>` },
    ]} empty=${{ title: 'No collateral has moved', children: 'An independent amount moves when a position opens, changes size or ends. Variation margin moves at the end-of-day pass, when the mark calls for it.' }} />
    ${v.movements.length ? html`<div class="small muted" style="padding:8px 12px">The same events are in ${unit ? html`<a href=${`#/accounting/history/${unit.id}`}>this Account's history</a>` : html`<a href="#/accounting/history">the Book's history</a>`}, with their entries and the observation each mark came from.${v.movements.length > 60 ? ' The 60 most recent are listed here.' : ''}</div>` : null}<//>`;
}

function Supported({ v }) {
  return html`<${Panel} title="What is simulated, and what is only recorded">
    <div class="cols-2">
      <div><h4>Simulated from the configured terms</h4><ul class="coll-list">${v.simulated.map((s) => html`<li>${s}</li>`)}</ul></div>
      <div><h4>Recorded, not simulated</h4><ul class="coll-list">${v.recordedOnly.map((r) => html`<li><b>${r.label}.</b> ${r.note}</li>`)}</ul></div>
    </div>
    <div class="note" style="margin-top:8px">${v.futuresNote} Securities pledged under repos and loans, and cash collateral on securities lent, are part of those arrangements and are listed under Borrowings and lending.</div><//>`;
}

/**
 * The collateral desk of a Book (Treasury) or of one Account.
 * unit: the Account to show; omitted for the whole Book.
 */
export function CollateralDesk({ book, unit }) {
  const scope = unit ? unit.id : 'book';
  const res = useLive(() => get(`/api/books/${book.id}/collateral`, { scope }), [book.id, scope]);
  const [busy, setBusy] = useState(false);
  const v = res.data;
  if (!v) return res.error ? html`<${ErrorNote} error=${res.error} />` : html`<div class="note">Loading collateral…</div>`;
  const retry = async () => {
    setBusy(true);
    try { const r = await post(`/api/books/${book.id}/collateral/retry`); toast(r.delivered ? `${r.delivered} failed call${r.delivered > 1 ? 's' : ''} delivered.` : 'No failed call could be delivered: the cash is still not there.', r.delivered ? 'ok' : 'err'); bump(); res.reload(); } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  // Amounts another unit posts or holds for an Account, one line per pair, with what each is made of.
  const memo = [];
  for (const m of v.totals.allocatedByOthers.filter((x) => !unit || x.unit.id === unit.id)) {
    const side = m.amount > 0 ? 'posted' : 'held';
    let row = memo.find((x) => x.holder.id === m.holder.id && x.unit.id === m.unit.id && x.ccy === m.ccy && x.side === side);
    if (!row) { row = { holder: m.holder, unit: m.unit, ccy: m.ccy, side, total: 0, independent: 0, variation: 0 }; memo.push(row); }
    row.total += Math.abs(m.amount); row[m.kind] += Math.abs(m.amount);
  }
  // An Account with no agreement, no OTC position and no history: one panel says so, with the way in.
  if (unit && !v.agreements.length && !v.positions.length && !v.movements.length && !memo.length) {
    return html`<${Panel} title="Collateral agreements" note=${`None covers ${unit.name} yet`} flush actions=${html`<${Button} small kind="primary" onClick=${() => openOverlay((close) => html`<${AgreementDialog} book=${book} unitId=${unit.id} meta=${v} onClose=${close} onDone=${res.reload} />`)}>New agreement<//>`}>
      <${Empty} title=${`${unit.name} has no OTC positions and no collateral agreement`}>A swap, credit default swap, forward or OTC option states its collateral basis on the ticket: an agreement of this Book, position-level terms, or "Uncollateralized (paper assumption)". Record an agreement here to make it available.<//><//>`;
  }
  const failed = v.failures.filter((f) => f.status === 'failed'), unvalued = v.failures.filter((f) => f.status === 'cannot_value');
  const flagged = v.positions.filter((p) => p.basis.flagged);
  return html`<div class="stack">
    ${failed.length ? html`<${Notice} tone="err"><div class="row" style="flex-wrap:nowrap;align-items:flex-start"><div class="grow"><b>${failed.length} collateral call${failed.length > 1 ? 's' : ''} failed.</b> Nothing was funded in its place. Each is retried every engine cycle and delivers only what is still missing.
      <ul class="coll-list">${failed.map((f) => html`<li>${f.reason}</li>`)}</ul></div><${Button} small busy=${busy} onClick=${retry}>Retry failed calls<//></div><//>` : null}
    ${unvalued.length ? html`<${Notice} tone="warn"><b>${unvalued.length} requirement${unvalued.length > 1 ? 's' : ''} cannot be valued.</b> No call is made on a missing mark or rate, and what is already posted or held stays where it is.
      <ul class="coll-list">${unvalued.map((f) => html`<li>${f.reason}</li>`)}</ul><//>` : null}
    ${flagged.length ? html`<${Notice} tone="warn"><b>${flagged.length} position${flagged.length > 1 ? 's have' : ' has'} no collateral terms recorded.</b> ${flagged.length > 1 ? 'They are' : 'It is'} treated as uncollateralized until a basis is recorded on the position below.<//>` : null}
    <section class="panel"><div class="body" style="padding:9px 4px 8px"><div class="stats">
      <div class="stat"><span class="k">Collateral posted${unit ? ` by ${unit.name}` : ''}</span><span class="v">${amounts(v.totals.posted.map((x) => ({ ...x })).reduce((acc, x) => { const hit = acc.find((y) => y.ccy === x.ccy); if (hit) hit.amount += x.amount; else acc.push({ ccy: x.ccy, amount: x.amount }); return acc; }, []), 'None')}</span><span class="s">Its own asset, not spendable while posted</span></div>
      <div class="stat"><span class="k">Collateral held from counterparties</span><span class="v">${amounts(v.totals.received.reduce((acc, x) => { const hit = acc.find((y) => y.ccy === x.ccy); if (hit) hit.amount += x.amount; else acc.push({ ccy: x.ccy, amount: x.amount }); return acc; }, []), 'None')}</span><span class="s">Restricted cash, owed back. Never buying power</span></div>
      <div class="stat"><span class="k">Agreements</span><span class="v">${v.agreements.filter((a) => a.status === 'active').length}</span><span class="s">Active${unit ? `, covering ${unit.name}` : ' in this Book'}</span></div>
      <div class="stat"><span class="k">OTC positions</span><span class="v">${v.positions.length}</span><span class="s">${flagged.length ? `${flagged.length} without terms on record` : 'Each with its basis on record'}</span></div>
    </div></div></section>
    ${memo.length ? html`<${Notice}><b>Posted or held on ${unit ? `${unit.name}'s` : 'an Account\'s'} behalf under a shared agreement.</b> These amounts are on the balance sheet of the unit that moved them, once. They are listed here as allocations, not as a second balance.
      <ul class="coll-list">${memo.map((m) => html`<li>${unitName(m.holder)} ${m.side === 'posted' ? 'has posted' : 'holds'} ${fmtMoney(m.total, m.ccy)} for ${unitName(m.unit)}${m.independent && m.variation ? ` (${fmtMoney(m.independent, m.ccy, { bare: true })} independent amount, ${fmtMoney(m.variation, m.ccy, { bare: true })} variation margin)` : m.independent ? ' (independent amount)' : ' (variation margin)'}</li>`)}</ul><//>` : null}
    <${Agreements} book=${book} v=${v} unit=${unit} reload=${res.reload} />
    <${Positions} book=${book} v=${v} unit=${unit} reload=${res.reload} />
    <${Sets} v=${v} />
    <${Movements} v=${v} unit=${unit} />
    ${unit ? null : html`<${Supported} v=${v} />`}
  </div>`;
}

export default CollateralDesk;
