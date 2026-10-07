// Treasury of the selected Book.
//
// A Book has exactly one Treasury. It holds the Book's unallocated cash, its own borrowings,
// lending and collateral, and it funds the Accounts. This page keeps two things visibly apart:
// Treasury's own balances (what it holds and owes itself), and the Accounts it funds, whose
// balances belong to the Accounts and are shown here for oversight only. An Account may borrow
// directly: that borrowing is one record, on the Account's balance sheet, listed here as
// Account-originated, and counted once in the consolidated Book. It is never a Treasury liability.
//
// The cash tickets live here and are exported so the Account page opens the same ones: capital,
// transfers, currency conversion, borrow and convert, loans, repos and securities lending. Capital
// and transfers are recorded directly; everything that trades or borrows goes through the preview
// and its single confirmation. Book management (rename, create, select) is at #/books.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtQty, fmtTime, get, isNum, openOverlay, post, refreshStatus, setUnit, toast, toastError, useLive } from '../lib/core.js';
import { Awaiting, Button, Empty, ErrorNote, Field, Missing, Modal, Money, NavAffected, NavValue, Notice, Num, Panel, Pill, Price, Prov, Seg, Select, Stat, Table, Tabs, Text } from '../lib/ui.js';
import { ContractFields, draftToContract, newDraft, PositionPicker } from '../lib/contracts.js';
import { openPreview } from './preview.js';
import { CollateralDesk } from './agreements.js';

const TAB_IDS = ['cash', 'borrowings', 'collateral', 'holds', 'alerts'];
const CCY = /^[A-Z]{3}$/;
// When the borrowed currency is the quote currency of the pair, the amount of it a conversion uses
// depends on the fill price. This share is left unconverted so a small rate move between the
// preview and the fill does not leave the conversion short. Shown on the ticket; the amount is editable.
const RATE_HEADROOM = 0.001;
const unitName = (u) => (u?.kind === 'treasury' ? 'Treasury' : u?.name || '');
const treasuryOf = (book) => book.units.find((u) => u.kind === 'treasury');
const startUnit = (book, unitId) => book.units.find((u) => u.id === unitId)?.id || treasuryOf(book).id;
const viewFor = (ccy) => (ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH');
const plain = (name) => String(name || '').replace(/ \(.*\)$/, '');
const sum = (list) => list.reduce((a, x) => a + x, 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bare = (x, ccy) => html`<span class=${x === 0 ? 'muted' : ''}>${fmtMoney(x, ccy, { bare: true })}</span>`;
const none = (text = 'none') => html`<span class="muted">${text}</span>`;
const rcFirst = (rc) => (a, b) => (a === rc ? -1 : b === rc ? 1 : a < b ? -1 : 1);

/** Treasury, the Book overview and its alerts in one load. Tickets use it too, so the amounts they quote are current. */
function useBook(bookId) {
  return useLive(async () => {
    const treasury = await get(`/api/books/${bookId}/treasury`); // refreshes prices and FX first
    const [b, a] = await Promise.all([get(`/api/books/${bookId}`), get(`/api/books/${bookId}/alerts`)]);
    return { treasury, overview: b.overview, alerts: a.items };
  }, [bookId]);
}
const cashOf = (d, unitId, ccy) => d?.overview.units.find((u) => u.id === unitId)?.cash.find((c) => c.ccy === ccy) || null;
function availableText(d, unit, ccy, key = 'availableToWithdraw', what = 'available to withdraw') {
  if (!d || !unit || !CCY.test(ccy || '')) return '';
  const c = cashOf(d, unit.id, ccy);
  return c ? `${unitName(unit)} has ${fmtMoney(c[key], ccy)} ${what}.` : `${unitName(unit)} holds no ${ccy}.`;
}

/** Shared ticket behaviour: one busy flag, server errors shown inside the ticket, close and reload when done. */
function useTicket(onClose, onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const finish = (x) => { onDone?.(x); onClose(); };
  return {
    busy, error, setError,
    /** Spread on the form: an error is cleared as soon as something is edited. */
    form: { class: 'stack', onInput: () => setError(null), onChange: () => setError(null) },
    /** Record something directly (capital, transfer, rate): no market execution is involved. */
    async record(fn, done) {
      setBusy(true); setError(null);
      try { await fn(); toast(done); bump(); finish(); } catch (err) { setError(err); setBusy(false); }
    },
    /** Send a package to the preview. The ticket stays open underneath until the preview is confirmed. */
    async preview(input, opts = {}) {
      setBusy(true); setError(null);
      await openPreview(input, { openOverlay, toastError: setError, onDone: finish, ...opts });
      setBusy(false);
    },
  };
}
const foot = (t, onClose, label, go, disabled, note) => html`${note ? html`<span class="note">${note}</span>` : null}<span class="grow"></span>
  <${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${t.busy} disabled=${disabled} onClick=${go}>${label}<//>`;
/** Treasury or Account picker. `lock` fixes it (a ticket opened from an Account's page); `only` limits the list to one kind. */
const UnitPick = ({ book, value, onChange, skip, lock, only }) => html`<${Select} value=${value} onChange=${onChange} disabled=${lock} placeholder=${value ? undefined : 'Choose…'}
  options=${book.units.filter((u) => u.id !== skip && (!only || u.kind === only || u.id === value)).map((u) => ({ value: u.id, label: unitName(u) }))} />`;
const FIXED_HINT = 'Fixed to this Account.';
/** Who owes a borrowing. An Account's own borrowing is one record: on its balance sheet, in Treasury's oversight view, once in the Book. */
const owedBy = (unit) => (unit?.kind === 'account'
  ? `Borrowed by ${unit.name} and owed by ${unit.name}: the liability goes on this Account's balance sheet. Treasury sees the same record in its oversight view, labelled Account-originated, and the Book counts it once.`
  : 'Borrowed by Treasury and owed by Treasury: the liability goes on Treasury\'s own balance sheet and is counted once in the Book.');

// ---- small dialogs --------------------------------------------------------------------------------------
function NameDialog({ title, sub, label, initial = '', button, done, save, onClose, onDone }) {
  const [name, setName] = useState(initial);
  const t = useTicket(onClose, onDone);
  const go = () => t.record(() => save(name.trim()), done);
  return html`<${Modal} title=${title} sub=${sub} onClose=${onClose} footer=${foot(t, onClose, button, go, !name.trim() || name.trim() === initial)}>
    <div ...${t.form}><${ErrorNote} error=${t.error} /><${Field} label=${label}><${Text} value=${name} onInput=${setName} autofocus /><//></div><//>`;
}

/** External capital. It enters and leaves the Book through Treasury only, whichever page the ticket was opened from. */
export function CapitalDialog({ book, status, unitId, onClose, onDone }) {
  const res = useBook(book.id);
  const [f, setF] = useState({ type: 'deposit', ccy: book.reportingCcy, amount: null, note: '' });
  const t = useTicket(onClose, onDone);
  const dep = f.type === 'deposit';
  const acct = book.units.find((u) => u.id === unitId && u.kind === 'account');
  const go = () => t.record(() => post(`/api/books/${book.id}/capital`, { type: f.type, ccy: f.ccy, amount: f.amount, note: f.note.trim() || undefined }), dep ? 'Deposit recorded.' : 'Withdrawal recorded.');
  return html`<${Modal} title="Deposit or withdraw capital" sub="Capital enters and leaves the Book only through Treasury." onClose=${onClose}
    footer=${foot(t, onClose, dep ? 'Record deposit' : 'Record withdrawal', go, !(f.amount > 0) || !CCY.test(f.ccy))}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      ${acct ? html`<${Notice}>External capital is recorded in Treasury, not in ${acct.name}. Deposit it here, then fund ${acct.name} from Treasury with a transfer.<//>` : null}
      <div class="grid-form">
        <${Field} label="Movement" span=${2}><div><${Seg} value=${f.type} onChange=${(v) => setF({ ...f, type: v })} options=${[{ value: 'deposit', label: 'Deposit into Treasury' }, { value: 'withdrawal', label: 'Withdraw from Treasury' }]} /></div><//>
        <${Field} label="Currency" hint="Three-letter code"><${Text} value=${f.ccy} onInput=${(v) => setF({ ...f, ccy: v.toUpperCase().slice(0, 3) })} /><//>
        <${Field} label="Amount" span=${2} hint=${dep ? '' : availableText(res.data, treasuryOf(book), f.ccy)}><${Num} value=${f.amount} onInput=${(v) => setF({ ...f, amount: v })} /><//>
        <${Field} label="Note" span="all" hint="Optional. Kept with the entry in the Book's history."><${Text} value=${f.note} onInput=${(v) => setF({ ...f, note: v })} /><//>
      </div>
      <p class="note">Recorded on business date ${status.today}. Capital is not investment performance: Accounting reports it under capital flows, apart from P&L. To move cash to an Account afterwards, use Transfer cash.</p>
    </div><//>`;
}

/**
 * Cash between Treasury and Accounts, or between two Accounts. `unitId` fixes that side of the
 * transfer (the Account whose page opened the ticket); `accountsOnly` limits the other side to Accounts.
 */
export function TransferDialog({ book, status, from, to, unitId, accountsOnly, onClose, onDone }) {
  const res = useBook(book.id);
  // With one possible destination left (a Book with two Accounts), it is chosen already.
  const others = accountsOnly ? book.units.filter((u) => u.kind === 'account' && u.id !== (from || unitId)) : [];
  const [f, setF] = useState({ from: from || (unitId && unitId !== to ? unitId : treasuryOf(book).id), to: to || (others.length === 1 ? others[0].id : ''), ccy: '', amount: null, purpose: '' });
  const t = useTicket(onClose, onDone);
  const src = book.units.find((u) => u.id === f.from), dst = book.units.find((u) => u.id === f.to);
  const held = res.data?.overview.units.find((u) => u.id === f.from)?.cash || [];
  useEffect(() => {
    // Decide inside the update, on the latest state: a currency chosen in the same instant must not be overwritten.
    if (res.data) setF((x) => (held.some((c) => c.ccy === x.ccy) ? x : { ...x, ccy: (held.find((c) => c.ccy === book.reportingCcy) || held[0])?.ccy || '' }));
  }, [f.from, Boolean(res.data)]);
  const kind = !src || !dst ? '' : src.kind === 'treasury' ? 'Treasury funding' : dst.kind === 'treasury' ? 'a return to Treasury' : 'a transfer between Accounts';
  const have = held.find((c) => c.ccy === f.ccy);
  const lockFrom = Boolean(unitId) && f.from === unitId, lockTo = Boolean(unitId) && f.to === unitId && !lockFrom;
  const only = accountsOnly ? 'account' : undefined;
  const noOther = book.units.filter((u) => u.id !== unitId && (!only || u.kind === only)).length === 0;
  const go = () => t.record(() => post(`/api/books/${book.id}/transfers`, { fromUnitId: f.from, toUnitId: f.to, ccy: f.ccy, amount: f.amount, purpose: f.purpose.trim() || undefined }), 'Transfer recorded.');
  return html`<${Modal} title="Transfer cash" sub="Between Treasury and Accounts, or between two Accounts, inside this Book." onClose=${onClose}
    footer=${foot(t, onClose, 'Record transfer', go, !f.from || !f.to || !f.ccy || !(f.amount > 0))}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      <${Notice}>A transfer never converts currency: the same currency leaves the source and arrives at the destination. To change currency, use Convert currency, which is a separate spot FX trade.<//>
      ${book.units.length < 2 ? html`<${Notice} tone="warn">This Book has no Accounts yet, so there is nowhere to transfer to. Create one with New Account first.<//>`
        : accountsOnly && noOther ? html`<${Notice} tone="warn">This Book has no other Account to transfer to. Create one with New Account, or return the cash to Treasury.<//>` : null}
      <div class="grid-form">
        <${Field} label="Source" hint=${lockFrom ? FIXED_HINT : ''}><${UnitPick} book=${book} value=${f.from} lock=${lockFrom} only=${lockTo ? only : undefined} skip=${lockTo ? f.to : undefined} onChange=${(v) => setF({ ...f, from: v, to: f.to === v ? '' : f.to })} /><//>
        <${Field} label="Destination" hint=${lockTo ? FIXED_HINT : ''}><${UnitPick} book=${book} value=${f.to} lock=${lockTo} only=${lockFrom ? only : undefined} skip=${f.from} onChange=${(v) => setF({ ...f, to: v })} /><//>
        <${Field} label="Currency"><${Select} value=${f.ccy} onChange=${(v) => setF({ ...f, ccy: v })} placeholder=${held.length ? undefined : 'No cash held'} options=${held.map((c) => ({ value: c.ccy, label: c.ccy }))} /><//>
        <${Field} label="Amount" span=${2} hint=${have ? `${unitName(src)} has ${fmtMoney(have.availableToWithdraw, have.ccy)} available to withdraw${have.availableToWithdraw < have.settled ? ` (settled ${fmtMoney(have.settled, have.ccy)}, less payables and reservations)` : ''}.` : res.data ? `${unitName(src)} holds no cash to transfer.` : ''}>
          <${Num} value=${f.amount} onInput=${(v) => setF({ ...f, amount: v })} /><//>
        <${Field} label="Purpose" span="all" hint="Optional. Recorded with the transfer."><${Text} value=${f.purpose} onInput=${(v) => setF({ ...f, purpose: v })} placeholder="Why the cash is moving" /><//>
      </div>
      <p class="note">${kind && f.amount > 0 && f.ccy ? `Recorded on business date ${status.today} as ${kind}: ${fmtMoney(f.amount, f.ccy)} from ${unitName(src)} to ${unitName(dst)}.` : `Recorded on business date ${status.today} with its currency, amount, source, destination and purpose.`}
        ${' '}It is internal to the Book: Book totals are unchanged, and a borrowing stays with whoever owes it.</p>
    </div><//>`;
}

function RateDialog({ a, onClose, onDone }) {
  const [rate, setRate] = useState(null);
  const t = useTicket(onClose, onDone);
  const go = () => t.record(() => post(`/api/instruments/${a.instrument.id}/lifecycle`, { action: 'set_rate', rate }), 'Rate set.');
  const floating = a.rawTerms.rateType === 'floating';
  return html`<${Modal} title=${`Set the rate on ${a.name}`} sub=${`${unitName(a.owner)}, ${a.direction}`} onClose=${onClose} footer=${foot(t, onClose, 'Set rate', go, !isNum(rate))}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      ${noFixing(a) ? html`<${Notice} tone="warn">No ${a.rawTerms.referenceRate} fixing has been available since ${noFixing(a)}, so interest has stopped accruing.<//>` : null}
      <${Field} label="New rate (decimal a year)" hint="0.045 = 4.5%. Entered by you; it is not taken from market data."><${Num} value=${rate} onInput=${setRate} /><//>
      <p class="note">${noFixing(a) ? `Interest accrues at this rate from ${noFixing(a)}, the first day without a fixing.` : 'Interest up to today is accrued at the current rate first; the new rate applies from today.'}
        ${floating ? ` The arrangement then stops following ${a.rawTerms.referenceRate} and stays at the rate you set until you change it again.` : ''} The reset is recorded in the Book's history.</p>
    </div><//>`;
}

// ---- currency conversion ------------------------------------------------------------------------------
const useFxPairs = () => useLive(() => get('/api/instruments', { family: 'fx', limit: 200 }), [], { interval: false });
const useQuote = (id) => useLive(() => (id ? get('/api/quotes', { ids: id }) : null), [id]).data?.quotes?.[id]?.observation || null;
const noPairs = html`<${Empty} title="No currency pairs are registered">A conversion is a spot FX trade in a registered pair. Register the pair under <a href="#/instruments">Instruments</a> first.<//>`;
const pairOptions = (pairs) => pairs.map((p) => ({ value: p.id, label: p.symbol || p.name }));
// FX rates need more decimals than a share price: 1.08432, 151.703.
const fxPx = (x) => fmtNum(x, Math.abs(x) >= 20 ? 3 : 5);
const rateLine = (pair, obs, status) => html`<div class="row"><span class="note">Current market price, ${pair.terms.quote} per ${pair.terms.base}</span>
  ${obs && isNum(obs.value) ? html`<span class="price"><span class="v">${fxPx(obs.value)}</span> <${Prov} obs=${obs} /></span>` : html`<${Missing} reason="No rate is available for this pair" />`}
  ${obs && isNum(obs.bid) ? html`<span class="note">bid ${fxPx(obs.bid)}, ask ${fxPx(obs.ask)}</span>` : null}</div>
  ${obs && isNum(obs.value) ? null : status.data.market.connection === 'awaiting'
    ? html`<${Awaiting} compact what=${`There is no rate for ${pair.symbol || pair.name}. The conversion would wait as a working order. State a fill price in the preview, or enter a price for the pair by hand under Instruments.`} />`
    : html`<${Notice} tone="warn">There is no rate for ${pair.symbol || pair.name} right now. The conversion would wait as a working order unless you state a fill price in the preview.<//>`}`;

export function ConvertDialog({ book, status, unitId, fixed, onClose, onDone }) {
  const res = useBook(book.id);
  const pairs = useFxPairs();
  const [f, setF] = useState({ unitId: startUnit(book, unitId), pairId: '', action: 'sell', qty: null });
  const t = useTicket(onClose, onDone);
  const list = pairs.data?.items || [];
  const pair = list.find((p) => p.id === f.pairId);
  const obs = useQuote(f.pairId);
  const unit = book.units.find((u) => u.id === f.unitId);
  const { base, quote } = pair?.terms || {};
  const sold = f.action === 'sell' ? base : quote, bought = f.action === 'sell' ? quote : base;
  const px = obs ? (f.action === 'sell' ? obs.bid : obs.ask) ?? obs.value : null;
  const go = () => t.preview({ bookId: book.id, unitId: f.unitId, template: 'custom', name: `Convert ${sold} to ${bought}`, legs: [{ kind: 'trade', action: f.action, instrumentId: pair.id, qty: f.qty }] });
  return html`<${Modal} title="Convert currency" sub=${`A spot FX trade inside ${fixed ? unitName(unit) : 'one Treasury or Account'}. It goes through the preview like any other trade.`} onClose=${onClose}
    footer=${foot(t, onClose, 'Preview conversion', go, !pair || !(f.qty > 0), 'Nothing is submitted until you confirm the preview.')}>
    ${pairs.data && !list.length ? noPairs : html`<div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label="In" hint=${fixed ? FIXED_HINT : ''}><${UnitPick} book=${book} value=${f.unitId} lock=${fixed} onChange=${(v) => { setUnit(v); setF({ ...f, unitId: v }); }} /><//>
        <${Field} label="Currency pair"><${Select} value=${f.pairId} onChange=${(v) => setF({ ...f, pairId: v })} placeholder="Choose a pair…" options=${pairOptions(list)} /><//>
        ${pair ? html`<${Field} label="Direction" span="all"><div><${Seg} value=${f.action} onChange=${(v) => setF({ ...f, action: v })}
            options=${[{ value: 'sell', label: `Sell ${base}, receive ${quote}` }, { value: 'buy', label: `Sell ${quote}, receive ${base}` }]} /></div><//>
          <${Field} label=${`${base} to ${f.action}`} span=${2} hint=${isNum(px) && f.qty > 0 ? `About ${fmtMoney(f.qty * px, quote)} at the current ${f.action === 'sell' ? 'bid' : 'ask'}. An estimate; the preview shows the fill.` : 'Amounts are entered in the base currency of the pair.'}>
            <${Num} value=${f.qty} onInput=${(v) => setF({ ...f, qty: v })} /><//>` : null}
      </div>
      ${pair ? html`${rateLine(pair, obs, status)}
        <p class="note">${availableText(res.data, unit, sold, 'availableToTrade', 'available to trade')} Spot FX settles T+${pair.terms.settleDays ?? 2}: ${bought} counts as buying power at once, but cannot be withdrawn or transferred until it settles.</p>` : null}
    </div>`}<//>`;
}

/** One package, one confirmation: borrow cash in one currency and sell it at spot for another. Works the same for Treasury and for an Account. */
export function BorrowConvertDialog({ book, status, unitId, fixed, onClose, onDone }) {
  const pairs = useFxPairs();
  const cat = useLive(() => get('/api/catalog'), [], { interval: false });
  const [f, setF] = useState({ unitId: startUnit(book, unitId), pairId: '', side: 'quote', principal: null, base: null });
  const [draft, setDraft] = useState(null);
  const t = useTicket(onClose, onDone);
  const product = cat.data?.products.find((p) => p.id === 'cash_loan') || cat.data?.products.find((p) => p.family === 'loan');
  useEffect(() => { if (product && !draft) setDraft(newDraft(product)); }, [Boolean(product)]);
  const list = pairs.data?.items || [];
  const pair = list.find((p) => p.id === f.pairId);
  const obs = useQuote(f.pairId);
  const unit = book.units.find((u) => u.id === f.unitId);
  const { base, quote } = pair?.terms || {};
  const ccy = f.side === 'base' ? base : quote, other = f.side === 'base' ? quote : base;
  // The borrowed currency is sold. Selling the base currency is "sell"; selling the quote currency is "buy" of the base.
  const action = f.side === 'base' ? 'sell' : 'buy';
  const ask = obs ? obs.ask ?? obs.value : null;
  const sized = f.side === 'base' ? f.principal : isNum(ask) && ask > 0 && f.principal > 0 ? Math.floor((f.principal * (1 - RATE_HEADROOM) / ask) * 100) / 100 : null;
  const baseQty = f.side === 'base' ? f.principal : f.base ?? sized;
  const go = () => t.preview({
    bookId: book.id, unitId: f.unitId, template: 'custom', name: `Borrow ${ccy} and convert to ${other}`,
    legs: [
      { kind: 'loan', action: 'borrow_cash', purpose: 'financing', qty: f.principal, contract: draftToContract({ ...draft, name: draft.name || `${ccy} loan (converted to ${other})`, tradingCcy: ccy, marketView: viewFor(ccy) }) },
      { kind: 'trade', action, instrumentId: pair.id, qty: baseQty, dependsOn: [1] },
    ],
  });
  return html`<${Modal} size="mid" title="Borrow and convert" sub=${`${fixed ? `${unitName(unit)} borrows` : 'Borrows'} cash in one currency and converts it at spot, as one package with one confirmation.`} onClose=${onClose}
    footer=${foot(t, onClose, 'Preview borrow and convert', go, !pair || !draft || !(f.principal > 0) || !(baseQty > 0), 'Nothing is submitted until you confirm the preview.')}>
    ${pairs.data && !list.length ? noPairs : html`<div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label="Borrower" hint=${fixed ? FIXED_HINT : 'Treasury or the Account that borrows and owes.'}><${UnitPick} book=${book} value=${f.unitId} lock=${fixed} onChange=${(v) => { setUnit(v); setF({ ...f, unitId: v }); }} /><//>
        <${Field} label="Currency pair"><${Select} value=${f.pairId} onChange=${(v) => setF({ ...f, pairId: v, base: null })} placeholder="Choose a pair…" options=${pairOptions(list)} /><//>
        ${pair ? html`<${Field} label="Borrow" span="all"><div><${Seg} value=${f.side} onChange=${(v) => setF({ ...f, side: v, base: null })}
            options=${[{ value: 'quote', label: `Borrow ${quote}, receive ${base}` }, { value: 'base', label: `Borrow ${base}, receive ${quote}` }]} /></div><//>
          <${Field} label=${`Principal to borrow (${ccy})`} span=${2}><${Num} value=${f.principal} onInput=${(v) => setF({ ...f, principal: v })} /><//>` : null}
      </div>
      ${pair && draft ? html`
        <h4>Leg 1, the loan in ${ccy}</h4>
        <div class="grid-form"><${ContractFields} draft=${draft} onChange=${setDraft} /></div>
        <h4>Leg 2, the conversion: sell ${ccy}, receive ${other}</h4>
        ${rateLine(pair, obs, status)}
        ${f.side === 'quote' ? html`<div class="grid-form"><${Field} label=${`${base} to buy`} span=${2}
          error=${!isNum(ask) && !isNum(f.base) ? `No current rate for ${pair.symbol || pair.name}. Enter the ${base} amount to buy; it is not guessed.` : ''}
          hint=${isNum(f.base) ? `Your amount. At the current ask it uses about ${isNum(ask) ? fmtMoney(f.base * ask, quote) : 'an unknown amount'} of the ${quote} borrowed.`
            : isNum(sized) ? `Worked out from the principal at the current ask, less ${RATE_HEADROOM * 100}% so a small rate move before the fill does not leave the conversion short. The remainder stays as ${quote} cash. Edit the amount to change this.` : `Enter the principal to size the ${base} amount.`}>
          <${Num} value=${baseQty} onInput=${(v) => setF({ ...f, base: v })} /><//></div>`
          : html`<p class="note">All ${isNum(f.principal) ? fmtMoney(f.principal, base) : base} borrowed is sold${isNum(obs?.bid) && f.principal > 0 ? `, for about ${fmtMoney(f.principal * obs.bid, quote)} at the current bid (an estimate; the preview shows the fill)` : ''}.</p>`}
        <${Notice}>${owedBy(unit)} The borrowed ${ccy} is settled cash at once and is sold immediately; it is a liability until repaid, and its interest rate is the one you enter above. The conversion settles T+${pair.terms.settleDays ?? 2}. The ${other} bought counts as buying power at once, but cannot be withdrawn or transferred before it settles.<//>` : null}
    </div>`}<//>`;
}

// ---- cash loan or deposit, repo or reverse repo, securities lending ------------------------------------------
const MODES = {
  loan: { title: 'Cash loan or deposit', sub: 'Simulated borrowing or lending of cash at the terms you state. Borrowed cash is a liability of whoever borrows it.', family: 'loan', kind: 'loan', qty: 'Principal', button: 'Preview loan',
    sides: [{ value: 'borrow_cash', label: 'Borrow cash' }, { value: 'lend_cash', label: 'Lend or deposit cash' }] },
  repo: { title: 'Repo or reverse repo', sub: 'Cash against securities. A repo pledges a position this Treasury or Account holds; a reverse repo lends cash and receives collateral.', family: 'repo', kind: 'repo_open', qty: 'Cash principal', button: 'Preview repo',
    sides: [{ value: 'repo', label: 'Repo' }, { value: 'reverse_repo', label: 'Reverse repo' }], sideHint: { repo: 'Borrows cash against a position held here.', reverse_repo: 'Lends cash and receives collateral.' } },
  secloan: { title: 'Lend a security', sub: 'Lends out a position that is held. The borrower posts cash collateral, which is restricted cash and a liability.', family: 'secloan', kind: 'lend_sec', qty: 'Quantity to lend', button: 'Preview securities loan',
    sides: [{ value: 'lend_sec', label: 'Lend' }] },
};
// Products that make sense on one side only are left out of the other side's list.
const LEND_ONLY = ['bank_deposit', 'term_deposit', 'certificate_of_deposit', 'reverse_repo'], BORROW_ONLY = ['margin_loan', 'revolving_credit_facility', 'securities_borrowing', 'repo'];
const REPO_PRESET = { overnight_repo: { term: 'overnight' }, open_repo: { term: 'open' }, triparty_repo: { triparty: true }, special_repo: { collateralType: 'special' } };
const DEFAULT_PRODUCT = { borrow_cash: 'cash_loan', lend_cash: 'term_deposit', repo: 'repo', reverse_repo: 'reverse_repo', lend_sec: 'securities_lending' };

/** mode: 'loan' | 'repo' | 'secloan'. `unitId` preselects the Treasury or Account, `fixed` holds it there, `side` preselects borrow or lend. */
export function ArrangementDialog({ book, mode, unitId, fixed, side, onClose, onDone }) {
  const m = MODES[mode];
  const res = useBook(book.id);
  const cat = useLive(() => get('/api/catalog'), [], { interval: false });
  const [f, setF] = useState({ unitId: startUnit(book, unitId), action: m.sides.some((s) => s.value === side) ? side : m.sides[0].value, productId: '', ccy: book.reportingCcy, qty: null, name: '' });
  const [draft, setDraft] = useState(null);
  const [pos, setPos] = useState(null);
  const t = useTicket(onClose, onDone);
  const lending = ['lend_cash', 'reverse_repo'].includes(f.action);
  const products = (cat.data?.products || []).filter((p) => p.family === m.family && !(lending || mode === 'secloan' ? BORROW_ONLY : LEND_ONLY).includes(p.id));
  const product = products.find((p) => p.id === f.productId);
  const unit = book.units.find((u) => u.id === f.unitId);
  const needsPos = f.action === 'repo' || mode === 'secloan';
  // The product decides the starting terms, so a change of side or product starts the terms again.
  useEffect(() => { if (cat.data) setF((x) => ({ ...x, productId: products.some((p) => p.id === DEFAULT_PRODUCT[f.action]) ? DEFAULT_PRODUCT[f.action] : products[0]?.id || '' })); }, [f.action, Boolean(cat.data)]);
  useEffect(() => { setDraft(product ? newDraft(product, { terms: REPO_PRESET[product.id] }) : null); setPos(null); }, [f.productId, f.action]);
  // Another Treasury or Account holds different positions: the chosen one no longer applies, the other terms stay.
  const changeUnit = (v) => {
    setUnit(v); setF({ ...f, unitId: v }); setPos(null);
    if (needsPos && draft) setDraft(mode === 'secloan' ? { ...draft, underlyingId: '' } : { ...draft, terms: { ...draft.terms, collateralInstrumentId: '', collateralQty: null } });
  };
  const pick = (p) => {
    setPos(p || null);
    if (!p) return;
    const free = Math.max(0, p.qty - p.pledgedQty - p.onLoanQty);
    setF((x) => ({ ...x, ccy: p.ccy, qty: mode === 'secloan' ? free : x.qty }));
    setDraft((d) => d && (mode === 'secloan' ? { ...d, underlyingId: p.instrument.id } : { ...d, terms: { ...d.terms, collateralInstrumentId: p.instrument.id, collateralQty: free } }));
  };
  // A reverse repo names its collateral by instrument, not by a position held: look its symbol up for the default name.
  const [collSym, setCollSym] = useState('');
  const collId = f.action === 'reverse_repo' ? draft?.terms?.collateralInstrumentId : '';
  useEffect(() => { setCollSym(''); if (collId) get(`/api/instruments/${collId}`).then((i) => setCollSym(i.symbol || i.name), () => {}); }, [collId]);
  const sym = pos ? pos.instrument.symbol || pos.instrument.name : collSym;
  const tm = draft?.terms || {};
  const rateTag = tm.rateType !== 'floating' && isNum(tm.rate) ? ` ${fmtNum(tm.rate * 100, 3).replace(/\.?0+$/, '')}%` : '';
  const autoName = !product ? '' : mode === 'secloan' ? `Lend ${sym}`.trim()
    : `${mode === 'repo' ? `${f.action === 'repo' ? 'Repo' : 'Reverse repo'} ${sym}` : product.id === 'cash_loan' ? (lending ? 'Cash lent' : 'Cash loan') : plain(product.name)} ${f.ccy}${rateTag}`.replace(/\s+/g, ' ').trim();
  const go = () => t.preview({
    bookId: book.id, unitId: f.unitId, template: 'custom', name: f.name.trim() || autoName,
    legs: [{ kind: m.kind, action: f.action, purpose: 'financing', qty: f.qty, contract: draftToContract({ ...draft, name: f.name.trim() || autoName, tradingCcy: f.ccy, marketView: viewFor(f.ccy) }),
      collateralPositionId: f.action === 'repo' ? pos?.positionId : undefined, sourcePositionId: mode === 'secloan' ? pos?.positionId : undefined }],
  });
  const collQty = draft?.terms?.collateralQty, haircut = draft?.terms?.haircut;
  const collValue = pos && isNum(pos.price) && collQty > 0 ? collQty * pos.price * pos.instrument.multiplier : null;
  const who = mode === 'secloan' ? 'Lender' : lending ? 'Lender' : 'Borrower';
  return html`<${Modal} size="mid" title=${m.title} sub=${m.sub} onClose=${onClose}
    footer=${foot(t, onClose, m.button, go, !draft || !(f.qty > 0) || !CCY.test(f.ccy), 'Nothing is submitted until you confirm the preview.')}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label=${who} hint=${fixed ? FIXED_HINT : ''}><${UnitPick} book=${book} value=${f.unitId} lock=${fixed} onChange=${changeUnit} /><//>
        ${m.sides.length > 1 ? html`<${Field} label="Side" span=${2} hint=${m.sideHint?.[f.action]}><div><${Seg} value=${f.action} onChange=${(v) => setF({ ...f, action: v })} options=${m.sides} /></div><//>` : null}
        <${Field} label="Product" span=${2}><${Select} value=${f.productId} onChange=${(v) => setF({ ...f, productId: v })} options=${products.map((p) => ({ value: p.id, label: plain(p.name) }))} /><//>
        ${needsPos ? html`<${Field} label=${mode === 'secloan' ? 'Position to lend' : 'Collateral position'} span=${2} hint=${pos ? `${fmtQty(Math.max(0, pos.qty - pos.pledgedQty - pos.onLoanQty))} of ${fmtQty(pos.qty)} is free (not pledged, not on loan).` : `A long position held in ${unitName(unit)}.`}>
          <${PositionPicker} key=${`${f.unitId}:${f.action}`} value=${pos?.positionId || ''} onChange=${(v, p) => pick(p)} bookId=${book.id} unitId=${f.unitId} families=${['bond', 'equity', 'fund']} direction="long" /><//>` : null}
        <${Field} label="Currency">${mode === 'secloan' ? html`<${Text} value=${pos ? f.ccy : ''} disabled onInput=${() => {}} placeholder="From the security" />` : html`<${Text} value=${f.ccy} onInput=${(v) => setF({ ...f, ccy: v.toUpperCase().slice(0, 3) })} />`}<//>
        <${Field} label=${m.qty} hint=${lending ? availableText(res.data, unit, f.ccy) : ''}><${Num} value=${f.qty} onInput=${(v) => setF({ ...f, qty: v })} /><//>
        <${Field} label="Name" span=${2} hint="Optional"><${Text} value=${f.name} onInput=${(v) => setF({ ...f, name: v })} placeholder=${autoName} /><//>
      </div>
      ${!lending && mode !== 'secloan' ? html`<${Notice}>${owedBy(unit)}<//>` : null}
      ${draft ? html`<h4>Terms</h4><div class="grid-form"><${ContractFields} draft=${draft} onChange=${setDraft} skip=${f.action === 'repo' ? ['terms.collateralInstrumentId'] : mode === 'secloan' ? ['underlyingId'] : []} /></div>` : null}
      ${f.action === 'repo' && pos ? html`<p class="note">${isNum(collValue)
        ? html`Collateral: ${fmtQty(collQty)} ${sym} at <${Price} obs=${pos.priceObs} value=${pos.price} /> is worth ${fmtMoney(collValue, pos.ccy)}${isNum(haircut) ? `, or ${fmtMoney(collValue * (1 - haircut), pos.ccy)} after the haircut` : ''}. A guide only: the principal you enter is not checked against it.`
        : isNum(pos.price) ? 'Enter the collateral quantity to see its value.' : `${sym} has no price, so the value of the collateral cannot be shown. The principal you enter is not checked against it.`}
        ${' '}The pledged quantity cannot be sold or lent until the repo is closed.</p>` : null}
      ${mode === 'secloan' ? html`<p class="note">To borrow a security, sell it short from its instrument page or the Strategies page: the borrow is a leg of the short sale. Shares on loan cannot be sold until they are taken back.</p>` : null}
      ${product && product.support !== 'full' ? html`<${Notice}>Paper support for ${plain(product.name)}: ${product.support === 'partial' ? 'partly manual' : 'manual inputs'}. ${product.note}<//>` : null}
    </div><//>`;
}

// ---- cash by currency ------------------------------------------------------------------------------------------
/**
 * Cash of one Treasury or Account by currency, every bucket on its own row.
 * cash: [{ ccy, settled, receivable, payable, reserved, availableToTrade, availableToWithdraw, restricted, margin, borrowed, lent, collateralReceived }]
 * inventory (optional): that owner's securities, for the pledged and available collateral rows. wide: adds the "What it is" column.
 */
export function CashBuckets({ cash, rc, who, inventory, wide, empty }) {
  const mine = inventory || [];
  const ccys = [...new Set([...cash.map((c) => c.ccy), ...mine.map((i) => i.ccy)])].sort(rcFirst(rc));
  const cell = (key) => (ccy) => bare(cash.find((c) => c.ccy === ccy)?.[key] ?? 0, ccy);
  const secs = (qtyKey) => (ccy) => {
    const rows = mine.filter((i) => i.ccy === ccy && i[qtyKey] > 0);
    if (rows.some((i) => !isNum(i.price))) return html`<${Missing} reason="A security counted here has no price" />`;
    return bare(sum(rows.map((i) => i[qtyKey] * i.price * i.instrument.multiplier)), ccy);
  };
  const row = (label, c, what, strong) => ({ label, cell: c, what, strong });
  const rows = [
    { _group: 'Cash' },
    row('Settled', cell('settled'), `Cash that has settled and sits in ${who}.`),
    row('Unsettled, receivable', cell('receivable'), `Owed to ${who} on trades and conversions that have not settled yet.`),
    row('Unsettled, payable', cell('payable'), `Owed by ${who} on trades and conversions that have not settled yet.`),
    row('Reserved', cell('reserved'), 'Set aside by cash holds against short options, short positions and exercise cash.'),
    row('Available to trade', cell('availableToTrade'), 'Settled cash plus receivables, less payables and reservations. Short-sale proceeds are never included.', true),
    row('Available to withdraw', cell('availableToWithdraw'), 'Settled cash less payables and reservations: the most a transfer, withdrawal or repayment can take today.', true),
    { _group: 'Restricted and posted' },
    row('Restricted', cell('restricted'), 'Short-sale proceeds and cash collateral received. Not buying power.'),
    row('Margin posted', cell('margin'), 'Cash posted as margin or collateral on open positions.'),
    { _group: `Borrowed and lent by ${who} itself` },
    row('Cash borrowed', cell('borrowed'), `Cash ${who} has borrowed under its own loans and repos. A liability of ${who}.`),
    row('Cash lent', cell('lent'), `Cash ${who} has lent under loans, deposits and reverse repos.`),
    row('Cash collateral received', cell('collateralReceived'), 'Owed back to the borrowers of securities lent, and to OTC counterparties that posted it under a collateral agreement. A liability; the cash itself is in Restricted.'),
    ...(inventory ? [{ _group: `Securities collateral held in ${who}, valued at current market prices` },
      row('Pledged collateral', secs('pledgedQty'), 'Securities pledged under repos and secured loans. They cannot be sold or lent until released.'),
      row('Available collateral', secs('availableQty'), 'Securities neither pledged nor out on loan, free to pledge or lend.')] : []),
  ];
  if (!ccys.length) return html`<${Empty} ...${empty} />`;
  return html`<${Table} margin rows=${rows} columns=${[
    { label: who, render: (r) => html`<span class=${r.strong ? 'strong' : ''} title=${wide ? undefined : r.what}>${r.label}</span>` },
    ...ccys.map((ccy) => ({ label: ccy, align: 'r', render: (r) => html`<span class=${r.strong ? 'strong' : ''}>${r.cell(ccy)}</span>` })),
    wide ? { label: 'What it is', cls: 'wrap', render: (r) => html`<span class="muted small">${r.what}</span>` } : null,
  ].filter(Boolean)} />`;
}

// ---- borrowings and lending --------------------------------------------------------------------------------------
const CLOSE = {
  loan: (a) => ({ kind: 'repay', action: 'repay_cash', label: a.qty < 0 ? 'Repay' : 'Withdraw', confirm: a.qty < 0 ? 'Confirm repayment' : 'Confirm withdrawal' }),
  repo: (a) => ({ kind: 'repo_close', action: 'close_repo', label: a.qty < 0 ? 'Repurchase' : 'Terminate', confirm: a.qty < 0 ? 'Confirm repurchase' : 'Confirm termination' }),
  secloan: (a) => (a.qty > 0 ? { kind: 'return_sec', action: 'return_sec', label: 'Return', confirm: 'Confirm return' } : { kind: 'recall_sec', action: 'recall_sec', label: 'Take back', confirm: 'Confirm taking back' }),
};
/** The date since which a floating arrangement has had no fixing, if it is still floating. */
const noFixing = (a) => (a.rawTerms?.rateType === 'floating' && a.data?.rateMissing) || null;
const KEY_TERMS = ['Rate', 'Fee', 'Maturity', 'Term', 'Cash collateral'];
const NEXT = { 'loan.interest': 'interest payment', 'loan.maturity': 'repayment at maturity', 'repo.end': 'repurchase', 'secloan.fee': 'fee payment', 'secloan.recall': 'recall deadline' };
const closeArrangement = (a, onDone) => {
  const c = CLOSE[a.family](a);
  return openPreview({ bookId: a.bookId, unitId: a.unitId, template: 'custom', attachTo: a.strategyId || undefined, legs: [{ kind: c.kind, action: c.action, purpose: 'financing', targetPositionId: a.positionId, qty: Math.abs(a.qty) }] },
    { openOverlay, toastError, onDone, confirmLabel: c.confirm });
};
const arrangementActions = (a, onDone) => html`${a.family !== 'secloan' ? html`<${Button} small onClick=${() => openOverlay((close) => html`<${RateDialog} a=${a} onClose=${close} onDone=${onDone} />`)}>Set rate<//> ` : null}
  <${Button} small title="Opens the preview. A part repayment can be entered there." onClick=${() => closeArrangement(a, onDone)}>${CLOSE[a.family](a).label}<//>`;

/**
 * The borrowing register as a table: one row per external borrowing, each with its one ID and its owner.
 * rows: records from the register (treasury.borrowings.direct / .accountOriginated, or a balance sheet's `borrowings`).
 * arrangements (optional): the open positions behind them ({ positionId, data, rawTerms, ... }); a row's id is that position's id.
 */
export function BorrowingTable({ book, rows, arrangements = [], onDone, compact, empty }) {
  const rc = book.reportingCcy;
  // The register row names the position, its owner and its strategy, which is all a closing leg needs.
  const arr = (b) => arrangements.find((a) => a.positionId === b.id) || { positionId: b.id, bookId: book.id, unitId: b.owner.id, strategyId: b.strategy?.id || null, family: b.family, qty: b.family === 'secloan' ? b.securities.qty : -b.principal,
    name: b.name, owner: b.owner, direction: 'borrowed', instrument: { id: b.contractId }, rawTerms: { rateType: b.rate.type, referenceRate: b.rate.referenceRate }, data: null };
  const soft = (text, max) => html`<div style=${`white-space:normal;width:max-content;max-width:${max}px`}>${text}</div>`;
  const principal = (b) => (b.principal === null
    ? html`${fmtQty(b.securities.qty)} ${b.securities.instrument?.symbol || b.securities.instrument?.name || ''}<div class="sub">worth <${Money} value=${b.securities.value} ccy=${b.ccy} reason="No price is available for the security borrowed" /></div>`
    : html`${fmtMoney(b.principal, b.ccy, { bare: true })}${b.ccy !== rc ? html`<div class="sub"><${Money} value=${b.principalRc} ccy=${rc} reason=${`No conversion rate from ${b.ccy} to ${rc}`} /></div>` : null}`);
  const collateral = (b) => {
    const c = b.collateral;
    if (c.kind === 'securities' && c.instrument && isNum(c.qty)) return `${fmtQty(c.qty)} ${c.instrument.symbol || c.instrument.name} pledged${c.description.includes(', ') ? `, ${c.description.split(', ').slice(1).join(', ')}` : ''}`;
    return `${c.description}${isNum(c.cash) ? `: ${fmtMoney(c.cash, b.ccy)} held` : ''}`;
  };
  const columns = [
    { label: 'Borrowing ID', render: (b) => html`<div class="strong">${b.id}</div><div class="sub clip" style="max-width:140px" title=${b.name}>${b.name}</div>` },
    { label: 'Owner', render: (b) => html`${b.owner.name}<div class="sub">${b.accountOriginated ? 'Account-originated' : 'Treasury\'s own'}</div>` },
    { label: 'Type', render: (b) => soft(b.type, 120) },
    { label: 'Lender', render: (b) => (b.lender ? soft(b.lender, 105) : html`<${Missing} reason="No lender is recorded on this contract" />`) },
    { label: 'Currency', render: (b) => b.ccy },
    { label: 'Principal', align: 'r', title: `The amount owed, with its ${rc} equivalent at the current rate where the currency differs`, render: principal },
    { label: 'Rate', render: (b) => html`${b.rate.text ? soft(b.rate.text, 115) : html`<${Missing} reason="No rate is recorded on this contract" />`}${b.rate.dayCount ? html`<div class="sub">${b.rate.dayCount}</div>` : null}
      ${noFixing(arr(b)) ? html`<div><${Pill} tone="warn" title="Interest has stopped accruing until a rate is supplied or set by hand">no fixing since ${noFixing(arr(b))}<//></div>` : null}` },
    { label: 'Maturity', render: (b) => (b.maturity ? html`${b.maturity}<div class="sub">${b.term}</div>` : none(b.term)) },
    { label: 'Accrued', align: 'r', title: 'Interest or fee accrued and not yet paid. Owed by the owner of the borrowing.', render: (b) => fmtMoney(b.accrued, b.ccy, { bare: true }) },
    compact ? null : { label: html`Interest and fees<br />to date`, align: 'r', title: 'Charged to the owner\'s P&L since the borrowing began, paid or accrued: interest and borrow fees first, other fees beneath',
      render: (b) => html`<span title=${b.ccy !== rc && isNum(b.interestToDateRc) ? `${fmtMoney(b.interestToDateRc, rc)} at the rates when charged` : undefined}>${fmtMoney(b.interestToDate, b.ccy, { bare: true })}</span><div class="sub">fees ${fmtMoney(b.feesToDate, b.ccy, { bare: true })}</div>` },
  ].filter(Boolean);
  if (!rows.length) return empty ? html`<${Empty} ...${empty} />` : null;
  // Each borrowing is one record drawn on two lines: the figures, then its collateral, its payment schedule and what can be done with it.
  const lead = 'padding-top:0;height:auto;white-space:normal';
  return html`<div class="tablewrap"><table class="ledger margin tight">
    <thead><tr>${columns.map((c) => html`<th class=${c.align || ''} title=${c.title}>${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((b, i) => {
      const bg = `background:var(${i % 2 ? '--sheet-2' : '--sheet'})`;
      const next = b.schedule.next;
      return html`<tr key=${b.id}>${columns.map((c) => html`<td class=${c.align || ''} style=${`${bg}${compact ? '' : ';border-bottom:0'}`}>${c.render(b)}</td>`)}</tr>
        ${compact ? null : html`<tr key=${`${b.id}-terms`}><td colspan=${columns.length} style=${`${bg};${lead}`}><div class="row small" style="gap:4px 22px;align-items:flex-start;flex-wrap:nowrap;padding-bottom:3px">
          <div style="flex:1 1 0;min-width:0"><span class="muted">Collateral</span> ${collateral(b)}</div>
          <div style="flex:1.3 1 0;min-width:0"><span class="muted">Payment schedule</span> ${b.schedule.interest}. ${next ? html`<span class="muted">Next payment</span> ${next.date}, ${NEXT[next.type] || next.type}` : 'No payment is scheduled'}${next?.blocked ? html` <${Pill} tone="bad" title=${next.blocked}>blocked<//>` : null}</div>
          <div style="flex:none;white-space:nowrap">${arrangementActions(arr(b), onDone)}</div></div></td></tr>`}`;
    })}</tbody></table></div>`;
}

/** Deposits, cash lent, reverse repos and securities lent: the lending side of the same arrangements. */
function LendingTable({ rows, onDone, compact, empty }) {
  return html`<${Table} margin rows=${rows} rowKey=${(a) => a.positionId} empty=${empty} columns=${[
    { label: 'Arrangement', render: (a) => html`<div class="strong">${a.name}</div><div class="sub">${a.direction}, ${a.positionId}</div>` },
    { label: 'Owner', render: (a) => unitName(a.owner) },
    { label: 'Principal or quantity', align: 'r', render: (a) => (a.family === 'secloan' ? `${fmtQty(Math.abs(a.qty))} ${a.related?.symbol || ''}` : fmtMoney(Math.abs(a.qty), a.ccy)) },
    { label: 'Terms', cls: compact ? '' : 'wrap', render: (a) => html`${a.terms.filter(([k]) => KEY_TERMS.includes(k)).map(([k, v]) => html`<div><span class="muted">${k}</span> ${v}</div>`)}
      ${isNum(a.collateral) && a.collateral ? html`<div><span class="muted">Cash collateral held</span> ${fmtMoney(a.collateral, a.ccy)}</div>` : null}
      ${noFixing(a) ? html`<div><${Pill} tone="warn" title="Interest has stopped accruing until a rate is supplied or set by hand">no fixing since ${noFixing(a)}<//></div>` : null}
      ${compact ? null : html`<details><summary class="note">All terms</summary><dl class="terms">${a.terms.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl></details>`}` },
    { label: 'Accrued', align: 'r', title: 'Interest or fee accrued and not yet paid. Positive is receivable.', render: (a) => html`<${Money} value=${a.accrued} ccy=${a.ccy} signed /><div class="sub">${a.accrued < 0 ? 'owed' : a.accrued > 0 ? 'receivable' : ''}</div>` },
    { label: 'Related security', render: (a) => (a.related ? html`<div>${a.related.symbol || a.related.name}</div><div class="sub">${a.family === 'repo' ? `${fmtQty(a.rawTerms.collateralQty)} received` : 'out on loan'}</div>` : none()) },
    compact ? null : { label: '', align: 'r', render: (a) => arrangementActions(a, onDone) },
  ].filter(Boolean)} />`;
}
const isLending = (a) => (a.family === 'secloan' ? a.qty < 0 : a.qty > 0);

/** Book-level totals, stated once: every external borrowing is in exactly one of the two tables above, so each is counted once. */
function BorrowingTotals({ t, sheet, rc }) {
  const { direct, accountOriginated: acct } = t.borrowings;
  const all = [...direct, ...acct];
  const ccys = [...new Set(all.map((b) => b.ccy))].sort(rcFirst(rc));
  const cashOnly = (list) => list.filter((b) => b.principal !== null);
  const of = (list, ccy, pick) => sum(list.filter((b) => b.ccy === ccy).map(pick));
  const rows = ccys.map((ccy) => {
    const mine = cashOnly(all).filter((b) => b.ccy === ccy);
    return { ccy, own: of(cashOnly(direct), ccy, (b) => b.principal), acct: of(cashOnly(acct), ccy, (b) => b.principal), rcEq: mine.some((b) => !isNum(b.principalRc)) ? null : sum(mine.map((b) => b.principalRc)),
      accrued: of(all, ccy, (b) => b.accrued), interest: of(all, ccy, (b) => b.interestToDate), fees: of(all, ccy, (b) => b.feesToDate) };
  });
  const secs = all.filter((b) => b.principal === null);
  // The ledger's own figure for the same thing: Treasury's balance sheet plus each Account's, read from the oversight view.
  const ledger = new Map();
  const add = (cell) => { for (const x of cell?.byCurrency || []) ledger.set(x.ccy, (ledger.get(x.ccy) || 0) + x.amount); };
  const tr = sheet?.columns[0]?.id;
  add(sheet?.lines.find((l) => l.key === 'borrowed')?.cells[tr]);
  for (const a of sheet?.oversight?.accounts || []) add(a.cashBorrowed);
  const diff = sheet ? [...new Set([...ccys, ...ledger.keys()])].filter((ccy) => Math.abs((ledger.get(ccy) || 0) - ((rows.find((r) => r.ccy === ccy)?.own || 0) + (rows.find((r) => r.ccy === ccy)?.acct || 0))) > 0.005) : [];
  const total = rows.some((r) => r.rcEq === null) ? null : sum(rows.map((r) => r.rcEq));
  if (!all.length) return null;
  return html`<${Panel} title="External borrowing of the Book, by currency" note="Stated once" flush>
    <${Table} rows=${rows} rowKey=${(r) => r.ccy} columns=${[
      { label: 'Currency', render: (r) => html`<span class="strong">${r.ccy}</span>` },
      { label: 'Treasury\'s own principal', align: 'r', render: (r) => bare(r.own, r.ccy) },
      { label: 'Account-originated principal', align: 'r', render: (r) => bare(r.acct, r.ccy) },
      { label: 'Book, consolidated', align: 'r', render: (r) => html`<span class="strong">${fmtMoney(r.own + r.acct, r.ccy, { bare: true })}</span>` },
      { label: `Book, in ${rc}`, align: 'r', render: (r) => html`<${Money} value=${r.rcEq} bare reason=${`No conversion rate from ${r.ccy} to ${rc}`} />` },
      { label: 'Accrued, unpaid', align: 'r', render: (r) => bare(r.accrued, r.ccy) },
      { label: 'Interest to date', align: 'r', render: (r) => bare(r.interest, r.ccy) },
      { label: 'Fees to date', align: 'r', render: (r) => bare(r.fees, r.ccy) },
    ]} footer=${html`<tr><td colspan="4">All currencies, in ${rc} at current rates</td><td class="r"><${Money} value=${total} bare reason="A conversion rate is missing for a borrowed currency" /></td><td colspan="3"></td></tr>`} />
    <div class="small muted" style="padding:8px 12px">The consolidated Book counts each borrowing exactly once: ${plural(all.length, 'record')}, ${direct.length} of Treasury's own and ${acct.length} Account-originated. An Account-originated borrowing is on that Account's balance sheet and in the Book total, and never in Treasury's own column. Interest and fees are charged to the owner of the borrowing and so enter the Book once.
      ${secs.length ? ` ${plural(secs.length, 'securities borrow')} ${secs.length === 1 ? 'has' : 'have'} no cash principal; ${secs.length === 1 ? 'its' : 'their'} fees are in the accrued and to-date columns.` : ''}
      ${sheet && !diff.length ? html` The principal agrees with the Cash borrowed line of <a href=${`#/accounting/balance/${tr}`}>Treasury's balance sheet</a> plus each Account's.` : null}</div>
    ${diff.length ? html`<div style="padding:0 12px 10px"><${Notice} tone="err">The borrowing register and the ledger disagree in ${diff.join(', ')}: the ledger shows ${diff.map((ccy) => fmtMoney(ledger.get(ccy) || 0, ccy)).join(', ')} borrowed. Check the Full history in Accounting for an entry that was not made through a borrowing.<//></div>` : null}
  <//>`;
}

function Borrowings({ book, d, rc, act }) {
  const t = d.treasury;
  const lending = t.arrangements.filter(isLending);
  return html`<div class="stack">
    <div class="toolbar" style="margin:0"><${Button} onClick=${() => act.arrangement('loan')}>New loan or deposit<//><${Button} onClick=${() => act.arrangement('repo')}>New repo or reverse repo<//><${Button} onClick=${() => act.arrangement('secloan')}>Lend a security<//>
      <${Button} onClick=${act.borrowConvert}>Borrow and convert<//><span class="grow"></span><span class="note">Treasury or any Account can borrow. Each ticket asks who borrows; all are simulated arrangements.</span></div>
    <${Panel} title="Treasury's own borrowings" note="Borrowed by Treasury and owed by Treasury. These are Treasury's direct liabilities." flush>
      <${BorrowingTable} book=${book} rows=${t.borrowings.direct} arrangements=${t.arrangements} onDone=${act.reload}
        empty=${{ title: 'Treasury has no borrowings of its own', children: 'Loans and repos Treasury takes appear here once opened with the buttons above, or as financing legs of a strategy held in Treasury.' }} /><//>
    <${Panel} title="Account-originated borrowings" note="Shown here for oversight" flush>
      <div style="padding:10px 12px 0"><${Notice}>Each of these was borrowed by the Account named on the row and is owed by that Account. It is the same record, with the same ID, as on the Account's balance sheet. It is not an additional loan and it is not a Treasury liability: it is left out of Treasury's own balances and counted once in the consolidated Book.<//></div>
      <${BorrowingTable} book=${book} rows=${t.borrowings.accountOriginated} arrangements=${t.arrangements} onDone=${act.reload}
        empty=${{ title: 'No Account has borrowed directly', children: 'An Account can borrow cash or currencies itself, from its own page or with the buttons above. Its borrowings are then listed here as Account-originated.' }} /><//>
    <${BorrowingTotals} t=${t} sheet=${d.sheet} rc=${rc} />
    <${Panel} title="Lending, deposits and securities lent" note="Cash lent, deposits, reverse repos and securities out on loan, with the Treasury or Account that owns each" flush>
      <${LendingTable} rows=${lending} onDone=${act.reload} empty=${{ title: 'Nothing is lent or on deposit', children: 'Deposits, cash lent, reverse repos and securities lent appear here once opened with the buttons above.' }} /><//>
  </div>`;
}

// ---- first tab: Treasury's own balances, then the Accounts it funds ------------------------------------------------
const Section = ({ title, note }) => html`<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:6px 0 5px;border-bottom:1.5px solid var(--rule-strong)"><h2>${title}</h2><span class="note">${note}</span></div>`;
const lines = (list, text = 'none') => (list.length ? list.map((x) => html`<div>${fmtMoney(x.amount, x.ccy)}</div>`) : none(text));

function Accounts({ book, d, rc, act }) {
  const { overview: o, treasury: t, sheet } = d;
  const trId = t.treasury.id;
  const accounts = o.units.filter((u) => u.kind === 'account');
  const over = new Map((sheet?.oversight?.accounts || []).map((a) => [a.id, a]));
  const navOf = (u) => over.get(u.id)?.nav || { value: u.nav, complete: u.navComplete, provisional: u.navProvisional, affected: [] };
  const funded = (u) => t.accountFunding.filter((x) => x.account.id === u.id).map((x) => ({ ccy: x.ccy, amount: x.funded }));
  const borrowed = (u) => { const m = new Map(); for (const b of t.borrowings.accountOriginated) if (b.owner.id === u.id && b.principal !== null) m.set(b.ccy, (m.get(b.ccy) || 0) + b.principal); return [...m].map(([ccy, amount]) => ({ ccy, amount })); };
  const cash = (u, key) => (u.cash.length ? u.cash.map((c) => html`<div>${fmtMoney(c[key], c.ccy)}</div>`) : none());
  const all = { value: sum(accounts.map((u) => navOf(u).value)), provisional: accounts.some((u) => navOf(u).provisional), affected: accounts.flatMap((u) => navOf(u).affected || []) };
  const totalFunded = new Map();
  for (const x of t.accountFunding) totalFunded.set(x.ccy, (totalFunded.get(x.ccy) || 0) + x.funded);
  const received = [...totalFunded].map(([ccy, amount]) => ({ ccy, amount })).sort((a, b) => rcFirst(rc)(a.ccy, b.ccy));
  // Treasury's side of the same funding, from its own balance sheet: negative there means advanced.
  const advanced = (sheet?.representedBy.find((r) => r.key === 'internal')?.cells[trId]?.byCurrency || []).map((x) => ({ ccy: x.ccy, amount: -x.amount }));
  const residual = sheet ? [...new Set([...received, ...advanced].map((x) => x.ccy))].map((ccy) => ({ ccy, amount: (received.find((x) => x.ccy === ccy)?.amount || 0) - (advanced.find((x) => x.ccy === ccy)?.amount || 0) })).filter((x) => Math.abs(x.amount) > 0.004) : [];
  const list = (xs) => xs.map((x) => fmtMoney(x.amount, x.ccy)).join(', ');
  const go = (u) => setUnit(u.id);
  return html`<${Panel} title="Accounts" note=${accounts.length ? `${plural(accounts.length, 'Account')} of ${book.name}` : `None yet in ${book.name}`} flush actions=${html`${accounts.length ? html`<${Button} small onClick=${() => act.transfer()}>Transfer cash<//>` : null}<${Button} small onClick=${act.newAccount}>New Account<//>`}>
    ${accounts.length ? html`<div style="padding:10px 12px 0"><${Notice}>These balances belong to the Accounts and are not Treasury's. They are shown here because Treasury funds the Accounts and oversees them. An Account's own borrowing is owed by that Account.<//></div>` : null}
    <${Table} rows=${accounts} rowKey=${(u) => u.id} columns=${[
      { label: 'Account', render: (u) => html`<a class="sym" href=${`#/account/${u.id}`} onClick=${() => go(u)} title="Open this Account's page and use it on trade tickets">${u.name}</a><div class="sub">Account</div>` },
      { label: 'NAV', align: 'r', title: `The Account's own net asset value, in ${rc}`, render: (u) => html`<${NavValue} nav=${navOf(u)} ccy=${rc} />` },
      { label: 'Funding received', align: 'r', title: 'Net internal funding: transfers in less transfers out, from Treasury and from other Accounts. Internal to the Book.', render: (u) => lines(funded(u)) },
      { label: 'Settled cash', align: 'r', render: (u) => cash(u, 'settled') },
      { label: 'Available to trade', align: 'r', render: (u) => cash(u, 'availableToTrade') },
      { label: 'Borrowed by the Account', align: 'r', title: 'Cash the Account has borrowed directly. Owed by the Account; not a Treasury liability.', render: (u) => lines(borrowed(u)) },
      { label: 'Positions', align: 'r', title: 'Open positions, including financing legs', render: (u) => u.openPositions },
      { label: '', align: 'r', render: (u) => html`<${Button} small title="Transfer cash from Treasury to this Account" onClick=${() => act.transfer(null, u.id)}>Fund<//> <${Button} small title="Transfer cash from this Account back to Treasury" onClick=${() => act.transfer(u.id, trId)}>Return<//>` },
    ]} footer=${accounts.length > 1 ? html`<tr><td>All Accounts</td><td class="r"><${NavValue} nav=${all} ccy=${rc} /></td><td class="r">${lines(received)}</td><td colspan="5"></td></tr>` : null} />
    ${accounts.length ? html`<div class="small muted" style="padding:8px 12px">Funding is internal to the Book. ${advanced.length || received.length ? html`Treasury has advanced ${advanced.length ? list(advanced) : 'nothing'} net and the Accounts have received ${received.length ? list(received) : 'nothing'} net: the two cancel, so funding is eliminated from the consolidated Book and nothing is counted twice.` : 'No funding has moved yet.'}
        ${' '}Transfers between two Accounts move funding from one to the other without changing the total.</div>` : html`<${Empty} title="No Accounts yet">Create one with New Account, then fund it from Treasury. Positions can also be held in Treasury itself.<//>`}
    ${residual.length ? html`<div style="padding:0 12px 10px"><${Notice} tone="err">Internal funding does not cancel: a difference of ${list(residual)} remains between what Treasury advanced and what the Accounts received. Check the transfers in Accounting, Full history.<//></div>` : null}
  <//>`;
}

function Collateral({ d, book }) {
  const { collateralInventory: inv, collateralReceived: recv } = d.treasury;
  return html`<div class="stack">
    <${Section} title="Agreements and OTC collateral" note="Swaps, credit default swaps, forwards and OTC options post and receive collateral only as their configured terms say: an agreement, position-level terms, or none by explicit choice." />
    <${CollateralDesk} book=${book} />
    <${Section} title="Securities inventory" note="What Treasury and the Accounts hold that can be pledged or lent, and securities held under reverse repos." />
    <${Panel} title="Securities held" note="Across Treasury and every Account of this Book, each with its owner" flush><${Table} margin rows=${inv} rowKey=${(i) => i.positionId}
      empty=${{ title: 'No securities are held', children: 'Securities bought in Treasury or an Account appear here with what is pledged, on loan and free to use as collateral.' }}
      columns=${[
        { label: 'Security', render: (i) => html`<div class="sym">${i.instrument.symbol || i.instrument.name}</div><div class="sub clip">${i.instrument.symbol ? i.instrument.name : ''}</div>` },
        { label: 'Owner', render: (i) => unitName(i.owner) },
        { label: 'Quantity', align: 'r', render: (i) => fmtQty(i.qty) },
        { label: 'Pledged', align: 'r', render: (i) => fmtQty(i.pledgedQty) },
        { label: 'On loan', align: 'r', render: (i) => fmtQty(i.onLoanQty) },
        { label: 'Available', align: 'r', render: (i) => html`<span class="strong">${fmtQty(i.availableQty)}</span>` },
        { label: 'Current market price', align: 'r', render: (i) => html`<${Price} obs=${i.priceObs} value=${i.price} reason="No price is available for this security" />` },
        { label: 'Available value', align: 'r', render: (i) => html`<${Money} value=${i.availableValue} ccy=${i.ccy} reason="Needs a price" />` },
      ]} /><//>
    <${Panel} title="Collateral received under reverse repos" note="Held against cash lent. It is not the Book's property and is returned when the reverse repo ends." flush><${Table} rows=${recv}
      empty=${{ title: 'No collateral is held from counterparties', children: 'Securities received under a reverse repo are listed here until it is terminated.' }}
      columns=${[
        { label: 'Security', render: (r) => html`<span class="sym">${r.instrument?.symbol || r.instrument?.name || ''}</span>` },
        { label: 'Quantity', align: 'r', render: (r) => fmtQty(r.qty) }, { label: 'Under', render: (r) => r.arrangement }, { label: 'Owner', render: (r) => unitName(r.owner) },
      ]} /><//>
  </div>`;
}

const HOLD_KIND = { option_margin: 'Reserve against short options', short_margin: 'Margin against a short position', exercise_cash: 'Exercise cash for short puts' };
const REF_LABEL = { strategy: 'Strategy', position: 'Position', order: 'Order' };
const openStrategy = async (id) => { try { (await import('./strategy-detail.js')).openStrategy(id); } catch (err) { toastError(err); } };

function Holds({ book, d }) {
  const names = new Map(book.units.map((u) => [u.id, unitName(u)]));
  // A hold carries only the id of what it is against; look the names up so the reservation is explained.
  const refs = useLive(async () => {
    const [s, p] = await Promise.all([get('/api/strategies', { bookId: book.id }), get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' })]);
    return { strategies: new Map(s.items.map((x) => [x.id, x.name])), positions: new Map(p.positions.map((x) => [x.positionId, x])) };
  }, [book.id, d.treasury.holds.length], { interval: false }).data;
  const against = (h) => {
    const pos = h.ref_type === 'position' ? refs?.positions.get(h.ref_id) : null;
    const sid = h.ref_type === 'strategy' ? h.ref_id : pos?.strategy?.id;
    const label = pos ? `${pos.qty < 0 ? 'Short' : 'Long'} ${fmtQty(Math.abs(pos.qty))} ${pos.instrument.symbol || pos.instrument.name}${pos.strategy ? `, in ${pos.strategy.name}` : ''}`
      : h.ref_type === 'strategy' ? refs?.strategies.get(h.ref_id) || `Strategy ${h.ref_id}` : `${REF_LABEL[h.ref_type] || ''} ${h.ref_id || ''}`.trim();
    return sid ? html`<a href="javascript:void 0" title="Open the strategy" onClick=${() => openStrategy(sid)}>${label}</a>` : label;
  };
  return html`<p class="note">A hold reserves cash without moving it: the cash stays where it is, but cannot be traded, transferred or withdrawn. The total by currency is the Reserved line of each owner's cash.</p>
    <div class="panel"><div class="body flush"><${Table} margin rows=${d.treasury.holds} rowKey=${(h) => h.id}
      empty=${{ title: 'No cash is reserved', children: 'Holds are placed by the engine against short options, short positions and exercise cash, and released when the position closes.' }}
      columns=${[
        { label: 'Owner', render: (h) => names.get(h.unit_id) || h.unit_id },
        { label: 'Reserved for', render: (h) => html`<div>${HOLD_KIND[h.kind] || h.kind}</div>${h.note && h.note !== HOLD_KIND[h.kind] ? html`<div class="sub">${h.note}</div>` : null}` },
        { label: 'Amount', align: 'r', render: (h) => fmtMoney(h.amount, h.ccy) },
        { label: 'Against', render: against },
        { label: 'Placed', render: (h) => fmtTime(h.created_at) },
      ]} /></div></div>`;
}

function Alerts({ book, d, act }) {
  const names = new Map(book.units.map((u) => [u.id, unitName(u)]));
  const dismiss = async (a) => { try { await post(`/api/alerts/${a.id}/dismiss`); toast('Item dismissed.'); bump(); act.reload(); } catch (err) { toastError(err); } };
  if (!d.alerts.length) return html`<div class="panel"><${Empty} title="Nothing needs attention">Failed settlements, missed payments, recalls, missing fixings and packages with unexecuted legs are listed here when they happen.<//></div>`;
  return html`<div class="stack"><p class="note">Dismissing an item hides it; it does not fix the cause, and the item is raised again if the condition comes back.</p>
    ${d.alerts.map((a) => html`<div key=${a.id} class=${`notice ${a.level === 'error' ? 'err' : 'warn'}`}><div class="row" style="flex-wrap:nowrap;align-items:flex-start">
      <div style="flex:1;min-width:0"><div>${a.message}</div><div class="sub muted">${names.get(a.unit_id) || book.name}, ${fmtTime(a.ts)}</div></div>
      ${a.ref_type === 'strategy' ? html`<${Button} small onClick=${() => openStrategy(a.ref_id)}>Open strategy<//>` : null}<${Button} small onClick=${() => dismiss(a)}>Dismiss<//></div></div>`)}</div>`;
}

// ---- page ------------------------------------------------------------------------------------------------------------
/** The page's own load: what the tickets load, plus Treasury's balance sheet with its oversight of the Accounts. */
function useTreasury(bookId) {
  return useLive(async () => {
    const treasury = await get(`/api/books/${bookId}/treasury`); // refreshes prices and FX first
    const [b, a, sheet] = await Promise.all([get(`/api/books/${bookId}`), get(`/api/books/${bookId}/alerts`), get(`/api/books/${bookId}/accounting/balance`, { scope: 'treasury' })]);
    return { treasury, overview: b.overview, alerts: a.items, sheet };
  }, [bookId]);
}
const Group = ({ title, children }) => html`<div style="min-width:0"><div class="small" style="font-family:var(--head);font-weight:600;color:var(--ink-2);padding:0 12px 3px">${title}</div><div class="stats">${children}</div></div>`;
/** Principal of a set of cash borrowings in the reporting currency; missing when a conversion rate is. */
const principalRc = (list, rc) => {
  const cash = list.filter((b) => b.principal !== null);
  if (!cash.length) return none('None');
  return cash.some((b) => !isNum(b.principalRc)) ? html`<${Missing} reason=${`No conversion rate into ${rc} for a borrowed currency`} />` : fmtMoney(sum(cash.map((b) => b.principalRc)), rc);
};

export default function Treasury({ args, book, status }) {
  const tab = args[0] === 'funding' ? 'borrowings' : TAB_IDS.includes(args[0]) ? args[0] : 'cash';
  const res = useTreasury(book.id);
  const d = res.data;
  const rc = book.reportingCcy;
  const open = (Comp, props = {}) => openOverlay((close) => html`<${Comp} book=${book} status=${status} ...${props} onClose=${close} onDone=${res.reload} />`);
  const act = {
    reload: res.reload,
    transfer: (from, to) => open(TransferDialog, { from, to }),
    arrangement: (mode, side) => open(ArrangementDialog, { mode, side }),
    borrowConvert: () => open(BorrowConvertDialog),
    // The same thing the sidebar's New Account does: create it, make it the Account in use and open its page.
    newAccount: () => open(NameDialog, { title: 'New Account', sub: `In ${book.name}. An Account is funded from this Book's Treasury and holds its own positions and borrowings.`, label: 'Account name', button: 'Create Account', done: 'Account created. Fund it from Treasury to start trading in it.',
      save: async (name) => { const a = await post(`/api/books/${book.id}/accounts`, { name }); await refreshStatus(); setUnit(a.id); location.hash = `#/account/${a.id}`; } }),
  };
  if (!d) return html`<div class="page-head"><div><h1>Treasury</h1><div class="sub">Treasury of ${book.name}.</div></div></div>${res.error ? html`<${ErrorNote} error=${res.error} />` : html`<div class="note">Loading Treasury…</div>`}`;
  const { overview: o, treasury: t, sheet } = d;
  const accounts = o.units.filter((u) => u.kind === 'account');
  const own = t.arrangements.filter((a) => a.owner.kind === 'treasury');
  const ownLending = own.filter(isLending);
  const advanced = (sheet.representedBy.find((r) => r.key === 'internal')?.cells[t.treasury.id]?.byCurrency || []).map((x) => ({ ccy: x.ccy, amount: -x.amount }));
  const { direct, accountOriginated } = t.borrowings;
  const count = (list) => { const c = list.filter((b) => b.principal !== null).length; return `${c} of ${plural(list.length, 'record')}`; };
  const awaiting = status.data.market.connection === 'awaiting';
  return html`<div>
    <div class="page-head"><div><h1>Treasury</h1><div class="sub" style="max-width:100ch">Treasury of ${book.name}, reporting in ${rc}. It holds the Book's unallocated cash, its own borrowings, lending and collateral, and funds ${accounts.length === 1 ? 'one Account' : accounts.length ? `${accounts.length} Accounts` : 'no Accounts yet'}. What belongs to the Accounts is shown apart, for oversight.</div></div>
      <div class="actions"><a class="btn" href=${`#/accounting/balance/${t.treasury.id}`}>Treasury in Accounting</a></div></div>
    ${res.error ? html`<div style="margin-bottom:10px"><${ErrorNote} error=${res.error} /></div>` : null}
    <section class="panel" style="margin-bottom:12px"><div class="body" style="display:flex;gap:10px 12px;flex-wrap:wrap;padding:9px 4px 8px">
      <${Group} title="Treasury's own balances">
        <${Stat} label="Treasury NAV" value=${html`<${NavValue} nav=${t.treasuryNav} ccy=${rc} />`} sub="Direct balances only" />
        <${Stat} label="Treasury's own borrowings" value=${principalRc(direct, rc)} sub=${direct.length ? `Cash principal of ${count(direct)}` : 'Treasury owes nothing'} />
      <//>
      <${Group} title="Accounts it funds: their balances, not Treasury's">
        <${Stat} label="Funding advanced to Accounts" value=${advanced.length ? advanced.map((x) => html`<div>${fmtMoney(x.amount, x.ccy)}</div>`) : none('None')} sub="Internal, eliminated in the Book" />
        <${Stat} label="Account-originated borrowings" value=${principalRc(accountOriginated, rc)} sub=${accountOriginated.length ? `Cash principal of ${count(accountOriginated)}` : 'No Account has borrowed'} />
      <//>
      <${Group} title="Book, consolidated">
        <${Stat} label="Book NAV" value=${html`<${NavValue} nav=${t.bookNav} ccy=${rc} />`} sub=${accounts.length ? `Treasury plus ${plural(accounts.length, 'Account')}` : 'Treasury alone: no Accounts yet'} />
      <//>
    </div></section>
    ${t.bookNav.provisional || t.treasuryNav.provisional ? html`<div class="stack" style="margin-bottom:12px;gap:8px">
      ${awaiting ? html`<${Awaiting} compact what="Prices and conversion rates arrive with the Shaffer MarketData connection. Until then a figure that depends on a missing one is provisional. Enter the price by hand on the instrument; nothing is estimated in its place." />` : null}
      ${t.treasuryNav.provisional ? html`<div><div class="small strong" style="margin-bottom:3px">Treasury NAV</div><${NavAffected} nav=${t.treasuryNav} /></div>` : null}
      ${t.bookNav.provisional ? html`<div><div class="small strong" style="margin-bottom:3px">Book NAV</div><${NavAffected} nav=${t.bookNav} /></div>` : null}
    </div>` : null}
    <${Tabs} value=${tab} onChange=${(id) => { location.hash = `#/treasury/${id}`; }} tabs=${[
      { id: 'cash', label: 'Treasury and Accounts' }, { id: 'borrowings', label: 'Borrowings and lending', count: t.arrangements.length },
      { id: 'collateral', label: 'Collateral', count: (t.otcCollateral?.agreements || 0) + t.collateralInventory.length }, { id: 'holds', label: 'Cash holds', count: t.holds.length },
      { id: 'alerts', label: 'Needs attention', alert: d.alerts.length || undefined },
    ]} />
    ${tab === 'cash' ? html`<div class="stack">
      <${Section} title="Treasury's own balances" note="Held and owed by Treasury itself. Only these are on Treasury's balance sheet." />
      <${Panel} title="Treasury cash by currency" flush actions=${html`<${Button} small onClick=${() => open(CapitalDialog)}>Deposit or withdraw<//>
        <${Button} small onClick=${() => open(ConvertDialog)}>Convert currency<//><${Button} small onClick=${() => act.arrangement('loan')}>Borrow or lend cash<//><${Button} small onClick=${act.borrowConvert}>Borrow and convert<//>`}>
        <${CashBuckets} cash=${t.cash} rc=${rc} who="Treasury" wide inventory=${t.collateralInventory.filter((i) => i.owner.kind === 'treasury')}
          empty=${{ title: 'Treasury holds no cash yet', children: 'Deposit capital to start. Capital enters and leaves the Book only through Treasury.' }} />
        ${t.cash.length ? html`<div class="small muted" style="padding:8px 12px">Interest and fees to date are P&L, not a cash bucket: see <a href=${`#/accounting/pnl/${t.treasury.id}`}>Treasury P&L in Accounting</a>. Reservations are listed under Cash holds.</div>` : null}<//>
      <${Panel} title="Treasury's own borrowings and lending" note="Terms, payments and actions are under Borrowings and lending" flush actions=${html`<a class="btn small" href="#/treasury/borrowings">Open borrowings and lending</a>`}>
        <${BorrowingTable} book=${book} rows=${direct} arrangements=${t.arrangements} compact empty=${{ title: 'Treasury has no borrowings of its own', children: 'A loan or repo Treasury takes is listed here as its own liability.' }} />
        ${ownLending.length ? html`<${LendingTable} rows=${ownLending} compact />` : html`<div class="small muted" style="padding:8px 12px;border-top:1px solid var(--rule)">Treasury has lent no cash and no securities.</div>`}<//>
      <${Section} title="Accounts funded from this Treasury" note="Owned by the Accounts. Shown for oversight, and never added to Treasury's own balances." />
      <${Accounts} book=${book} d=${d} rc=${rc} act=${act} />
    </div>` : null}
    ${tab === 'borrowings' ? html`<${Borrowings} book=${book} d=${d} rc=${rc} act=${act} />` : null}
    ${tab === 'collateral' ? html`<${Collateral} d=${d} book=${book} />` : null}
    ${tab === 'holds' ? html`<${Holds} book=${book} d=${d} />` : null}
    ${tab === 'alerts' ? html`<${Alerts} book=${book} d=${d} act=${act} />` : null}
  </div>`;
}
