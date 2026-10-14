// Corporate actions tab of the instrument workspace (also the Distributions tab of a fund).
// Dividends, splits, buybacks, rights, mergers, spin-offs and other actions as Shaffer MarketData supplies them, with
// their dates and terms. Events already in the paper ledger are kept apart from informational ones: each server event
// is matched to the ledger's own records by its server event ID, else by instrument + type + ex-date (ca-model.js).
// "Record in the paper ledger" posts one event through the idempotent route (POST /api/server/corporate-actions/record):
// the same event delivered twice, or recorded twice, is posted once. Revisions are shown as revisions, never merged.
// Nothing here works out an entitlement: the ledger applies a recorded action to the positions held at its ex-date.
import { html, useState } from '../../vendor/preact-htm.js';
import { fmtTime, isNum, openOverlay, post, toast, toastError } from '../../lib/core.js';
import { Button, Empty, Missing, Modal, Notice, Pill } from '../../lib/ui.js';
import { DatasetPanel, registerTabContent, useDataset } from '../workspace.js';
import { caTypeLabel, eventTerms, ledgerTerms, matchCorporateActions, recordBlock, termsText } from './ca-model.js';

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const dateOr = (d, why) => (d ? html`<span class="nowrap">${day(d)}</span>` : html`<${Missing} reason=${why} />`);
const STATUS_TONE = { announced: 'pen', active: 'pen', completed: '', cancelled: 'bad', withdrawn: 'bad', revised: 'warn' };

function CorporateActionsTab({ inst, sel, asOf, book, intervalFor, title }) {
  const events = useDataset(sel, 'corporateActions', { interval: intervalFor?.('corporateActions') });
  const ledger = useDataset(sel, 'ledger', { query: { bookId: book.id }, live: true, asOf: false });
  const refreshAll = () => { events.refresh(); ledger.refresh(); };
  const label = title || 'Corporate actions';
  return html`<div class="stack" data-ws-inst=${inst.id} data-testid="ca-tab">
    <p class="note" style="margin:0">${label} supplied by the server are information. Recording one in ${book.name}'s paper ledger is a separate, explicit step, and the same event is never posted twice.</p>
    <${DatasetPanel} ds=${events} asOf=${asOf} title=${`${label} from the server`} what=${`${label} with their dates and terms, from Shaffer MarketData`}>
      ${(env) => html`<${ActionsBody} env=${env} ledger=${ledger} inst=${inst} book=${book} asOf=${asOf} onChanged=${refreshAll} />`}<//>
  </div>`;
}

function ActionsBody({ env, ledger, inst, book, asOf, onChanged }) {
  const items = env.items || [];
  const ledgerReady = ['available', 'stale', 'incomplete'].includes(ledger.state);
  const rows = ledgerReady ? ledger.env?.data?.recordedCorporateActions || [] : [];
  const m = matchCorporateActions(items, rows, inst.id);
  const ledgerNote = ledger.state === 'loading' ? 'Reading the paper ledger…'
    : !ledgerReady ? `The paper ledger could not be read (${ledger.env?.error?.message || ledger.error?.message || ledger.state}), so events are not split into processed and informational, and none can be recorded. Choose Refresh to try again.` : null;
  if (!items.length && !m.ledgerOnly.length) return html`<${Empty} title=${`No corporate actions for ${inst.symbol || inst.name}`}>${env.message || 'The server lists no dividends, splits or other actions for this instrument.'}<//>`;
  return html`<div class="stack">
    ${ledgerNote ? html`<${Notice} tone=${ledger.state === 'loading' ? '' : 'warn'}>${ledgerNote}<//>` : null}
    ${ledgerReady ? html`
      <section class="ca-sec" data-testid="ca-processed">
        <h4>In the paper ledger <span class="muted small">(${m.processed.length})</span></h4>
        <p class="note">Recorded in ${book.name}'s ledger, matched to the server event by its event ID, or by instrument, type and ex-date. The ledger applies a recorded action to the positions held at the open of the ex-date.</p>
        ${m.processed.length ? html`<${EventTable} rows=${m.processed} kind="processed" />` : html`<div class="muted small">None of these events is recorded in the paper ledger yet.</div>`}
      </section>
      <section class="ca-sec" data-testid="ca-informational">
        <h4>Informational, not in the paper ledger <span class="muted small">(${m.informational.length})</span></h4>
        <p class="note">${asOf ? `Shown as of ${asOf}. Return to current information to record an event in the paper ledger.` : 'Shown for information. A cash dividend or split can be recorded in the paper ledger; other actions are informational, and their effects are recorded by hand as a manual adjustment.'}</p>
        ${m.informational.length ? html`<${EventTable} rows=${m.informational} kind="informational" inst=${inst} book=${book} asOf=${asOf} onChanged=${onChanged} />` : html`<div class="muted small">Every event listed is in the paper ledger.</div>`}
      </section>
      ${m.ledgerOnly.length ? html`<section class="ca-sec" data-testid="ca-ledger-only">
        <h4>In the paper ledger with no matching server event <span class="muted small">(${m.ledgerOnly.length})</span></h4>
        <p class="note">Entered by hand or from an earlier delivery; the server's current list has no event of the same type on the same ex-date.</p>
        <${LedgerOnly} rows=${m.ledgerOnly} />
      </section>` : null}`
    : html`<${EventTable} rows=${[...m.processed, ...m.informational]} kind="unknown" />`}
    ${env.note ? html`<p class="note" style="margin:0">${env.note}</p>` : null}
  </div>`;
}

function Dates({ ev }) {
  return html`<div class="ca-dates"><span>Ex-date ${dateOr(ev.exDate, 'No ex-date supplied')}</span>
    ${ev.recordDate ? html`<span>record ${day(ev.recordDate)}</span>` : null}${ev.payDate ? html`<span>pay ${day(ev.payDate)}</span>` : null}
    ${ev.effectiveDate ? html`<span>effective ${day(ev.effectiveDate)}</span>` : null}
    ${ev.announcedAt ? html`<span class="muted" title=${ev.announcedAt}>announced ${day(ev.announcedAt)}</span>` : null}</div>`;
}
function Terms({ ev }) {
  const t = eventTerms(ev);
  return html`<div>${ev.terms || html`<span class="muted">No terms text supplied</span>`}</div>
    <div class="sub">${isNum(t.amount) || isNum(t.num) ? termsText(t) : ev.type === 'cash_dividend' ? html`<${Missing} reason="No amount supplied" /> amount not supplied` : 'no amount or ratio'}${ev.newInstrument ? `, new instrument ${ev.newInstrument.symbol || ev.newInstrument.name || ''}` : ''}</div>`;
}
function Revisions({ r }) {
  if (!r.revisions.length) return null;
  return html`<div class="ca-rev" data-testid="ca-revision">${r.revisions.map((x) => html`<div><${Pill} tone="warn">revision<//> ${
    x.by === 'server' ? html`Revised by the server${x.at ? ` on ${day(x.at)}` : ''}${x.previous ? `; previously ${termsText(x.previous)}` : ''}${x.supersedes ? `; supersedes event ${x.supersedes}` : ''}${x.note ? `. ${x.note}` : ''}.`
      : x.by === 'terms' ? html`Revises event ${x.previousEventId || '(no event ID)'}, which stated ${termsText(x.previous)}. Both are listed.`
        : html`The ledger recorded ${termsText(x.ledger)}; the server now states ${termsText(x.server)}. The ledger is not changed by it: record a correction by hand if it applies.`}</div>`)}</div>`;
}
function Delivered({ ev }) {
  return ev.deliveries > 1 ? html`<div class="sub" data-testid="ca-deliveries">Delivered ${ev.deliveries} times by the server, listed once (idempotency key <span class="mono">${ev.idempotencyKey}</span>)</div>` : null;
}

function EventTable({ rows, kind, inst, book, asOf, onChanged }) {
  return html`<div class="tablewrap"><table class="ledger ca-table"><colgroup><col style="width:24%" /><col style="width:18%" /><col style="width:31%" /><col style="width:27%" /></colgroup><thead><tr>
      <th>Action</th><th>Dates</th><th>Terms</th><th>${kind === 'processed' ? 'Paper ledger' : kind === 'informational' ? 'Paper ledger' : 'Status'}</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr key=${r.ev.idempotencyKey || r.ev.eventId} data-ca-event=${r.ev.eventId || ''}>
      <td data-label="Action" class="wrap"><div class="strong">${caTypeLabel(r.ev.type)}</div>${r.ev.status ? html`<${Pill} tone=${STATUS_TONE[r.ev.status] || ''} title="Status as supplied by the server">${r.ev.status}<//>` : null}
        <div class="sub mono" title="Server event ID">${r.ev.eventId || 'no event ID'}</div><${Delivered} ev=${r.ev} /></td>
      <td data-label="Dates"><${Dates} ev=${r.ev} /></td>
      <td data-label="Terms" class="wrap"><${Terms} ev=${r.ev} /><${Revisions} r=${r} /></td>
      <td data-label="Paper ledger" class="wrap">${kind === 'processed' ? html`<${LedgerCell} r=${r} />` : kind === 'informational' ? html`<${RecordCell} ev=${r.ev} inst=${inst} book=${book} asOf=${asOf} onChanged=${onChanged} />` : html`<span class="muted">Not known: the paper ledger was not read</span>`}</td>
    </tr>`)}</tbody></table></div>`;
}

function LedgerCell({ r }) {
  const st = r.status;
  return html`<div data-testid="ca-recorded"><b>Recorded in the ledger on ${r.recordedAt ? html`<span title=${r.recordedAt}>${fmtTime(r.recordedAt)}</span>` : html`<${Missing} reason="The record does not state when" />`}</b></div>
    <div class="sub">${st === 'applied' ? `Applied to the positions held${r.appliedAt ? ` on ${fmtTime(r.appliedAt)}` : ''}` : st === 'pending' ? 'Waiting for its date: applied on the pay date (a split on its ex-date)' : st ? `Ledger status ${st}` : ''}</div>
    <div class="sub">${r.matchedBy === 'event-id' ? 'Matched by the server event ID' : 'Matched by instrument, type and ex-date'}${r.ledger ? html`, ledger record <span class="mono">${r.ledger.id}</span>` : ''}</div>`;
}

function RecordCell({ ev, inst, book, asOf, onChanged }) {
  const block = recordBlock(ev);
  if (block) return html`<span class="small">${block}</span>`;
  if (asOf) return html`<span class="small muted">Not recorded. Recording is done on current information.</span>`;
  return html`<div class="small" style="margin-bottom:4px">Not recorded in the paper ledger.</div>
    <${Button} small onClick=${() => confirmRecord({ ev, inst, book, onChanged })} title="Record this event once in the paper ledger">Record in the paper ledger<//>`;
}

function confirmRecord({ ev, inst, book, onChanged }) {
  openOverlay((close) => html`<${RecordModal} ev=${ev} inst=${inst} book=${book} onClose=${close} onChanged=${onChanged} />`);
}
function RecordModal({ ev, inst, book, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const t = eventTerms(ev);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await post('/api/server/corporate-actions/record', { instrumentId: inst.id, eventId: ev.eventId, bookId: book.id });
      if (r.duplicate) toast(`Already recorded in the paper ledger (record ${r.caId}); not posted again.`, 'ok');
      else toast('Recorded in the paper ledger.');
      onClose();
      onChanged?.();
    } catch (err) { toastError(err); setBusy(false); }
  };
  return html`<${Modal} title=${`Record ${caTypeLabel(ev.type).toLowerCase()} of ${inst.symbol || inst.name}`} size="mid" onClose=${onClose}
    footer=${html`<${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} onClick=${go}>Record in the paper ledger<//>`}>
    <div class="stack">
      <dl class="kv"><dt>Event</dt><dd><span class="mono">${ev.eventId}</span></dd><dt>Terms</dt><dd>${termsText(t)}${ev.terms ? html`<div class="sub">${ev.terms}</div>` : null}</dd>
        <dt>Ex-date</dt><dd>${ev.exDate}</dd>${ev.payDate ? html`<dt>Pay date</dt><dd>${ev.payDate}</dd>` : null}<dt>Source</dt><dd>${ev.source || 'Shaffer MarketData'}</dd></dl>
      <p>This records the event in the paper ledger of every Book that holds ${inst.symbol || inst.name}. Positions held at the open of the ex-date receive it ${ev.type === 'split' ? 'on the ex-date' : 'on the pay date'}; nothing is posted before then.</p>
      <p class="note">It is recorded once, under the key <span class="mono">${ev.idempotencyKey || `srv:${ev.eventId}`}</span>. A second delivery of the same event, or recording it again, does not post twice.</p>
    </div><//>`;
}

function LedgerOnly({ rows }) {
  return html`<div class="tablewrap"><table class="ledger ca-table"><colgroup><col style="width:24%" /><col style="width:18%" /><col style="width:31%" /><col style="width:27%" /></colgroup><thead><tr><th>Action</th><th>Dates</th><th>Terms</th><th>Paper ledger</th></tr></thead>
    <tbody>${rows.map((x) => html`<tr key=${x.id}><td data-label="Action"><div class="strong">${caTypeLabel(x.type)}</div><div class="sub mono">${x.id}</div></td>
      <td data-label="Dates"><div class="ca-dates"><span>Ex-date ${x.ex_date}</span>${x.pay_date && x.pay_date !== x.ex_date ? html`<span>pay ${x.pay_date}</span>` : null}</div></td>
      <td data-label="Terms" class="wrap">${termsText(ledgerTerms(x))}<div class="sub">${x.source}${x.note ? `, ${x.note}` : ''}</div></td>
      <td data-label="Paper ledger" class="wrap"><b>Recorded in the ledger on ${fmtTime(x.created_at)}</b><div class="sub">${x.status === 'applied' ? `Applied on ${fmtTime(x.applied_at)}` : `Ledger status ${x.status}`}</div></td></tr>`)}</tbody></table></div>`;
}

registerTabContent('actions', (p) => html`<${CorporateActionsTab} ...${p} />`);
registerTabContent('distributions', (p) => html`<${CorporateActionsTab} ...${p} title="Distributions" />`);
export { CorporateActionsTab };
