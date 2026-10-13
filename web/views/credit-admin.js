// Events recorded by hand on a credit default swap (s3): credit events of a single name, an index constituent, a basket
// name or a tranche's index; an ABS CDS's pay-as-you-go events; a loan CDS cancelled on refinancing. Shown in the
// instrument form's "Lifecycle events recorded by hand" (web/views/registry.js). Each asks for a review first; the
// engine (server/products/credit.js) settles every holder of the contract, in every Book.
import { html, useState } from '../vendor/preact-htm.js';
import { bump, fmtNum, isNum, post, toast } from '../lib/core.js';
import { Button, ErrorNote, Field, Notice, Num, Select, Text } from '../lib/ui.js';

const GRID = 'grid-template-columns:repeat(auto-fill,minmax(200px,1fr))';
const pct = (x, dp = 2) => `${fmtNum(x * 100, dp)}%`;
const EVENT_LABEL = {
  bankruptcy: 'Bankruptcy', failure_to_pay: 'Failure to pay', restructuring: 'Restructuring', repudiation_moratorium: 'Repudiation/moratorium',
  obligation_acceleration: 'Obligation acceleration', governmental_intervention: 'Governmental intervention', failure_to_pay_principal: 'Failure to pay principal',
  writedown: 'Writedown', distressed_ratings_downgrade: 'Distressed ratings downgrade',
};
const SETTLE_LABEL = { auction: 'Cash, at the auction final price', cash: 'Cash, at a stated recovery', physical: 'Physical, simulated on paper' };
const PAYGO_LABEL = {
  writedown: 'Writedown (seller pays)', principal_shortfall: 'Principal shortfall (seller pays)', interest_shortfall: 'Interest shortfall (seller pays)',
  writedown_reimbursement: 'Writedown reimbursement (buyer pays)', interest_reimbursement: 'Interest shortfall reimbursement (buyer pays)', amortization: 'Amortization of the reference obligation (no payment)',
};
const EMPTY = { eventType: '', eventDate: '', recovery: null, settlement: '', entity: '', weight: null, settleDate: '', kind: '', amount: null, date: '', note: '' };

export function CreditAdmin({ inst, onChanged }) {
  const t = inst.terms || {};
  const name = inst.symbol || inst.name;
  const pid = inst.productId || inst.product_id;
  const structure = { credit_basket_swap: 'basket', cds_index_tranche: 'tranche', cds_index: 'index', abs_cds: 'abs', loan_cds: 'loan' }[pid] || 'single';
  const factor = isNum(t.indexFactor) ? t.indexFactor : 1;
  const [v, setV] = useState(EMPTY);
  const [step, setStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => { setV({ ...v, ...patch }); setStep(null); };
  const review = (s) => { setError(null); if (s.invalid) { setStep(null); setError(new Error(s.invalid)); } else setStep(s); };
  const run = async () => {
    setBusy(true); setError(null);
    try {
      await post(`/api/instruments/${inst.id}/lifecycle`, { action: step.action, ...step.body });
      toast(step.done); setStep(null); setV(EMPTY);
      bump(); await onChanged();
    } catch (err) { setError(err); }
    setBusy(false);
  };
  const button = (label, make) => html`<div class="field" style="justify-content:flex-start;padding-top:19px"><div><${Button} disabled=${busy} onClick=${() => review(make())}>${label}<//></div></div>`;
  const methods = ['auction', 'cash', ...(t.settlement === 'physical' ? ['physical'] : [])];
  const defaulted = (t.defaults || []).filter((d) => d.entity).map((d) => d.entity.toLowerCase());

  const creditEvent = () => {
    const R = v.recovery;
    if (!v.eventType) return { invalid: 'Choose the kind of credit event.' };
    if (!isNum(R) || R < 0 || R > 1) return { invalid: 'Enter the recovery rate (the auction final price, or the stated recovery) as a decimal between 0 and 1 (0.4 = 40%).' };
    if (structure === 'basket' && !v.entity) return { invalid: 'Choose the reference entity of the basket that defaulted.' };
    if ((structure === 'index' || structure === 'tranche') && !(v.weight > 0 && v.weight <= 1)) return { invalid: 'Enter the defaulted name\'s weight as a share of the original index notional (0.008 = 1/125).' };
    const method = v.settlement || (t.settlement === 'physical' ? 'physical' : t.settlement || 'auction');
    const when = v.eventDate || 'today';
    const settleWhen = v.settleDate ? `, settling on ${v.settleDate}` : ', settled today';
    const body = { eventType: v.eventType, eventDate: v.eventDate || undefined, recovery: R, settlement: method, entity: v.entity || undefined, weight: isNum(v.weight) ? v.weight : undefined, settleDate: v.settleDate || undefined };
    const accrued = `less the premium accrued from the start of the current period to the event date (${t.convention === 'standard' ? 'included' : 'excluded'}; refunded where a coupon already covered days after it)`;
    let text;
    if (structure === 'basket') {
      const count = (t.defaults || []).length + 1;
      text = count < t.nth ? `${EVENT_LABEL[v.eventType]} of ${v.entity} on ${when}: the ${count}${count === 1 ? 'st' : count === 2 ? 'nd' : count === 3 ? 'rd' : 'th'} default in the basket of ${name}. Protection is on default number ${t.nth}: it is recorded, nothing is paid, and the contract goes on.`
        : `${EVENT_LABEL[v.eventType]} of ${v.entity} on ${when} triggers ${name} (default number ${t.nth}). Every holder, in every Book, settles in full: protection buyers receive ${pct(1 - R, 1)} of their notional (${SETTLE_LABEL[method].toLowerCase()})${settleWhen}, ${accrued}; sellers pay the same. The contract then ends.`;
    } else if (structure === 'index') {
      text = `${EVENT_LABEL[v.eventType]} of ${v.entity || 'a constituent'} of ${name} on ${when}, weight ${pct(v.weight, 4)} of the original notional. Every holder, in every Book, settles protection on that part: buyers receive ${pct(1 - R, 1)} of it (${SETTLE_LABEL[method].toLowerCase()})${settleWhen}, ${accrued}; sellers pay the same. The index factor falls from ${factor} to ${fmtNum(factor - v.weight, 6)} and the contract goes on on the rest.`;
    } else if (structure === 'tranche') {
      text = `${EVENT_LABEL[v.eventType]} of ${v.entity || 'a constituent'} of the index under ${name} on ${when}, weight ${pct(v.weight, 4)}: the index loss rises by ${pct(v.weight * (1 - R), 4)} from ${pct(t.indexLoss || 0, 4)}. The part of it inside the tranche (${pct(t.attachment)} to ${pct(t.detachment)}) writes the tranche down and is paid to protection buyers${settleWhen}, ${accrued}; below the attachment point the tranche is untouched; at the detachment point it is exhausted and ends.`;
    } else {
      text = `${EVENT_LABEL[v.eventType]} of ${t.referenceEntity} on ${when}. Every holder of ${name}, in every Book, settles now: protection buyers receive ${pct(1 - R, 1)} of their notional${factor !== 1 ? ` outstanding (factor ${factor})` : ''} (${SETTLE_LABEL[method].toLowerCase()})${settleWhen}, ${accrued}; protection sellers pay the same. ${method === 'physical' ? `The deliverable obligation (${t.deliverable}) is delivered on paper against par: simulated, the Terminal moves no securities. ` : ''}The contract then ends for every holder and its remaining premium payments are cancelled.`;
    }
    return { action: 'credit_event', body, confirm: 'Record credit event', done: 'Credit event recorded.', text };
  };
  const paygo = () => {
    if (!v.kind) return { invalid: 'Choose the pay-as-you-go event.' };
    if (v.kind === 'amortization' ? !(isNum(v.amount) && v.amount >= 0 && v.amount < factor) : !(v.amount > 0)) return { invalid: v.kind === 'amortization' ? `Enter the reference obligation's new factor, below the current ${factor}.` : 'Enter the amount per 100 of original notional.' };
    const text = v.kind === 'amortization'
      ? `The reference obligation of ${name} (${t.referenceObligation}) amortizes: the factor falls from ${factor} to ${v.amount}${v.date ? ` on ${v.date}` : ''}. Nothing is paid for it; every holder, in every Book, settles the premium accrued on the amortized part and pays premium on the rest from then on.`
      : `${PAYGO_LABEL[v.kind]} of ${v.amount} per 100 of original notional on ${name}${v.date ? ` (${v.date})` : ''}: every holder, in every Book, ${/reimbursement/.test(v.kind) ? 'protection buyers pay it to sellers' : 'protection sellers pay it to buyers'}${['writedown', 'principal_shortfall'].includes(v.kind) ? `; the factor falls from ${factor} to ${fmtNum(factor - v.amount / 100, 6)} and the premium accrued on that part is settled` : v.kind === 'writedown_reimbursement' ? `; the factor rises from ${factor} to ${fmtNum(factor + v.amount / 100, 6)}` : ''}.`;
    return { action: 'paygo', body: { kind: v.kind, amount: v.amount, date: v.date || undefined }, confirm: 'Record pay-as-you-go event', done: 'Pay-as-you-go event recorded.', text };
  };
  const cancel = () => ({ action: 'cancel', body: { date: v.date || undefined, note: v.note || undefined }, confirm: 'Record cancellation', done: 'Cancellation recorded.',
    text: `${name} is cancelled${v.date ? ` on ${v.date}` : ' today'}: the reference loans of ${t.referenceEntity} were repaid and not replaced. Every holder, in every Book, settles the premium accrued to the cancellation date; no protection is paid; the contract ends.` });

  if (t.ended) return html`<p class="note">${name} ended on ${t.ended.date}: ${t.ended.reason}. No further event is recorded on it.</p>`;
  return html`<div class="stack" style="gap:8px">
    <div class="grid-form" style=${GRID}>
      <${Field} label="Kind of credit event"><${Select} value=${v.eventType} onChange=${(x) => set({ eventType: x })} placeholder="Choose…" options=${(t.creditEvents || []).map((e) => ({ value: e, label: EVENT_LABEL[e] || e }))} /><//>
      <${Field} label="Event date" hint="When it happened. Today if empty."><${Text} type="date" value=${v.eventDate} onInput=${(x) => set({ eventDate: x })} /><//>
      <${Field} label="Recovery rate or auction final price (decimal)" hint="0.4 = 40%. From the auction or the settlement, not assumed."><${Num} value=${v.recovery} onInput=${(x) => set({ recovery: x })} /><//>
      <${Field} label="Settled by" hint=${t.settlement === 'physical' ? `Physical: ${t.deliverable}` : 'Physical settlement only where the terms say so'}><${Select} value=${v.settlement || (t.settlement === 'physical' ? 'physical' : t.settlement || 'auction')} onChange=${(x) => set({ settlement: x })} options=${methods.map((m) => ({ value: m, label: SETTLE_LABEL[m] }))} /><//>
      ${structure === 'basket' ? html`<${Field} label="Defaulted name" hint=${`Protection on default number ${t.nth}; ${(t.defaults || []).length} recorded so far`}><${Select} value=${v.entity} onChange=${(x) => set({ entity: x })} placeholder="Choose…" options=${(t.basket || []).filter((b) => !defaulted.includes(b.toLowerCase())).map((b) => ({ value: b, label: b }))} /><//>` : null}
      ${structure === 'index' || structure === 'tranche' ? html`<${Field} label="Defaulted name" hint="The constituent, for the record"><${Text} value=${v.entity} onInput=${(x) => set({ entity: x })} /><//>
        <${Field} label="Weight of the defaulted name" hint=${structure === 'index' ? `Share of the original index notional (0.008 = 1/125). Index factor now ${factor}.` : 'Its weight in the index (0.04 = 1/25)'}><${Num} value=${v.weight} onInput=${(x) => set({ weight: x })} /><//>` : null}
      <${Field} label="Settles on" hint="Optional: a later settlement date. Today if empty."><${Text} type="date" value=${v.settleDate} onInput=${(x) => set({ settleDate: x })} /><//>
      ${button('Review credit event', creditEvent)}
    </div>
    ${structure === 'abs' ? html`<div class="grid-form" style=${GRID}>
      <${Field} label="Pay-as-you-go event" span=${2}><${Select} value=${v.kind} onChange=${(x) => set({ kind: x })} placeholder="Choose…" options=${Object.entries(PAYGO_LABEL).map(([value, label]) => ({ value, label }))} /><//>
      <${Field} label=${v.kind === 'amortization' ? 'New factor of the reference obligation' : 'Amount per 100 of original notional'} hint=${`Factor now ${factor}`}><${Num} value=${v.amount} onInput=${(x) => set({ amount: x })} /><//>
      <${Field} label="Pay-as-you-go date" hint="Today if empty"><${Text} type="date" value=${v.date} onInput=${(x) => set({ date: x })} /><//>
      ${button('Review pay-as-you-go event', paygo)}</div>` : null}
    ${structure === 'loan' && t.cancellable ? html`<div class="grid-form" style=${GRID}>
      <${Field} label="Cancellation date" hint="The refinancing date. Today if empty."><${Text} type="date" value=${v.date} onInput=${(x) => set({ date: x })} /><//>
      <${Field} label="Cancellation note" span=${2} hint="Optional, kept in the history"><${Text} value=${v.note} onInput=${(x) => set({ note: x })} /><//>
      ${button('Review cancellation', cancel)}</div>` : null}
    ${error ? html`<div><${ErrorNote} error=${error} /></div>` : null}
    ${step ? html`<div><${Notice} tone="warn"><b>Confirm before this is recorded.</b> ${step.text}
      <div class="row" style="margin-top:8px"><${Button} kind="primary" busy=${busy} onClick=${run}>${step.confirm}<//><${Button} disabled=${busy} onClick=${() => setStep(null)}>Cancel<//></div><//></div>` : null}
  </div>`;
}
