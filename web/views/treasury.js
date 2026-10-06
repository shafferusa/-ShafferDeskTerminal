// Books and Treasury.
//
// A Book contains exactly one Treasury and any number of Accounts. Treasury holds the Book's
// unallocated cash, its funding arrangements and its collateral inventory; Accounts are funded from
// Treasury and hold their own positions. This screen shows that picture (Treasury cash by bucket,
// each Account, funding arrangements, collateral, holds, items needing attention) and carries the
// cash tickets: capital, transfers, currency conversion, borrow and convert, loans, repos and
// securities lending. Capital and transfers are recorded directly; everything that trades or
// borrows goes through the normal preview and its single confirmation.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtQty, fmtTime, get, isNum, openOverlay, post, put, refreshStatus, toast, toastError, useLive } from '../lib/core.js';
import { Awaiting, Button, Empty, ErrorNote, Field, Missing, Modal, Money, Notice, Num, Panel, Pill, Price, Prov, Seg, Select, Stat, Table, Tabs, Text } from '../lib/ui.js';
import { ContractFields, draftToContract, newDraft, PositionPicker } from '../lib/contracts.js';
import { openPreview } from './preview.js';

const TAB_IDS = ['cash', 'funding', 'collateral', 'holds', 'alerts'];
const CCY = /^[A-Z]{3}$/;
// When the borrowed currency is the quote currency of the pair, the amount of it a conversion uses
// depends on the fill price. This share is left unconverted so a small rate move between the
// preview and the fill does not leave the conversion short. Shown on the ticket; the amount is editable.
const RATE_HEADROOM = 0.001;
const unitName = (u) => (u?.kind === 'treasury' ? 'Treasury' : u?.name || '');
const treasuryOf = (book) => book.units.find((u) => u.kind === 'treasury');
const viewFor = (ccy) => (ccy === 'USD' ? 'US_CASH' : 'FOREIGN_CASH');
const plain = (name) => String(name || '').replace(/ \(.*\)$/, '');
const sum = (list) => list.reduce((a, x) => a + x, 0);
const bare = (x, ccy) => html`<span class=${x === 0 ? 'muted' : ''}>${fmtMoney(x, ccy, { bare: true })}</span>`;

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
const UnitPick = ({ book, value, onChange, skip }) => html`<${Select} value=${value} onChange=${onChange} placeholder=${value ? undefined : 'Choose…'}
  options=${book.units.filter((u) => u.id !== skip).map((u) => ({ value: u.id, label: unitName(u) }))} />`;

// ---- small dialogs --------------------------------------------------------------------------------------
function NameDialog({ title, sub, label, initial = '', button, done, save, onClose, onDone }) {
  const [name, setName] = useState(initial);
  const t = useTicket(onClose, onDone);
  const go = () => t.record(async () => { await save(name.trim()); await refreshStatus(); }, done);
  return html`<${Modal} title=${title} sub=${sub} onClose=${onClose} footer=${foot(t, onClose, button, go, !name.trim() || name.trim() === initial)}>
    <div ...${t.form}><${ErrorNote} error=${t.error} /><${Field} label=${label}><${Text} value=${name} onInput=${setName} autofocus /><//></div><//>`;
}

function CapitalDialog({ book, status, onClose, onDone }) {
  const res = useBook(book.id);
  const [f, setF] = useState({ type: 'deposit', ccy: book.reportingCcy, amount: null, note: '' });
  const t = useTicket(onClose, onDone);
  const dep = f.type === 'deposit';
  const go = () => t.record(() => post(`/api/books/${book.id}/capital`, { type: f.type, ccy: f.ccy, amount: f.amount, note: f.note.trim() || undefined }), dep ? 'Deposit recorded.' : 'Withdrawal recorded.');
  return html`<${Modal} title="Deposit or withdraw capital" sub="Capital enters and leaves the Book only through Treasury." onClose=${onClose}
    footer=${foot(t, onClose, dep ? 'Record deposit' : 'Record withdrawal', go, !(f.amount > 0) || !CCY.test(f.ccy))}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label="Movement" span=${2}><div><${Seg} value=${f.type} onChange=${(v) => setF({ ...f, type: v })} options=${[{ value: 'deposit', label: 'Deposit into Treasury' }, { value: 'withdrawal', label: 'Withdraw from Treasury' }]} /></div><//>
        <${Field} label="Currency" hint="Three-letter code"><${Text} value=${f.ccy} onInput=${(v) => setF({ ...f, ccy: v.toUpperCase().slice(0, 3) })} /><//>
        <${Field} label="Amount" span=${2} hint=${dep ? '' : availableText(res.data, treasuryOf(book), f.ccy)}><${Num} value=${f.amount} onInput=${(v) => setF({ ...f, amount: v })} /><//>
        <${Field} label="Note" span="all" hint="Optional. Kept with the entry in the Book's history."><${Text} value=${f.note} onInput=${(v) => setF({ ...f, note: v })} /><//>
      </div>
      <p class="note">Recorded on business date ${status.today}. Capital is not investment performance: Accounting reports it under capital flows, apart from P&L. To move cash to an Account afterwards, use Transfer cash.</p>
    </div><//>`;
}

function TransferDialog({ book, status, from, to, onClose, onDone }) {
  const res = useBook(book.id);
  const [f, setF] = useState({ from: from || treasuryOf(book).id, to: to || '', ccy: '', amount: null, purpose: '' });
  const t = useTicket(onClose, onDone);
  const src = book.units.find((u) => u.id === f.from), dst = book.units.find((u) => u.id === f.to);
  const held = res.data?.overview.units.find((u) => u.id === f.from)?.cash || [];
  useEffect(() => {
    if (res.data && !held.some((c) => c.ccy === f.ccy)) setF((x) => ({ ...x, ccy: (held.find((c) => c.ccy === book.reportingCcy) || held[0])?.ccy || '' }));
  }, [f.from, Boolean(res.data)]);
  const kind = !src || !dst ? '' : src.kind === 'treasury' ? 'Treasury funding' : dst.kind === 'treasury' ? 'a return to Treasury' : 'a transfer between Accounts';
  const have = held.find((c) => c.ccy === f.ccy);
  const go = () => t.record(() => post(`/api/books/${book.id}/transfers`, { fromUnitId: f.from, toUnitId: f.to, ccy: f.ccy, amount: f.amount, purpose: f.purpose.trim() || undefined }), 'Transfer recorded.');
  return html`<${Modal} title="Transfer cash" sub="Between Treasury and Accounts, or between two Accounts, inside this Book." onClose=${onClose}
    footer=${foot(t, onClose, 'Record transfer', go, !f.from || !f.to || !f.ccy || !(f.amount > 0))}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      <${Notice}>A transfer never converts currency: the same currency leaves the source and arrives at the destination. To change currency, use Convert currency, which is a separate spot FX trade.<//>
      ${book.units.length < 2 ? html`<${Notice} tone="warn">This Book has no Accounts yet, so there is nowhere to transfer to. Create one with New Account first.<//>` : null}
      <div class="grid-form">
        <${Field} label="Source"><${UnitPick} book=${book} value=${f.from} onChange=${(v) => setF({ ...f, from: v, to: f.to === v ? '' : f.to })} /><//>
        <${Field} label="Destination"><${UnitPick} book=${book} value=${f.to} skip=${f.from} onChange=${(v) => setF({ ...f, to: v })} /><//>
        <${Field} label="Currency"><${Select} value=${f.ccy} onChange=${(v) => setF({ ...f, ccy: v })} placeholder=${held.length ? undefined : 'No cash held'} options=${held.map((c) => ({ value: c.ccy, label: c.ccy }))} /><//>
        <${Field} label="Amount" span=${2} hint=${have ? `${unitName(src)} has ${fmtMoney(have.availableToWithdraw, have.ccy)} available to withdraw${have.availableToWithdraw < have.settled ? ` (settled ${fmtMoney(have.settled, have.ccy)}, less payables and reservations)` : ''}.` : res.data ? `${unitName(src)} holds no cash to transfer.` : ''}>
          <${Num} value=${f.amount} onInput=${(v) => setF({ ...f, amount: v })} /><//>
        <${Field} label="Purpose" span="all" hint="Optional. Recorded with the transfer."><${Text} value=${f.purpose} onInput=${(v) => setF({ ...f, purpose: v })} placeholder="Why the cash is moving" /><//>
      </div>
      <p class="note">${kind && f.amount > 0 && f.ccy ? `Recorded on business date ${status.today} as ${kind}: ${fmtMoney(f.amount, f.ccy)} from ${unitName(src)} to ${unitName(dst)}.` : `Recorded on business date ${status.today} with its currency, amount, source, destination and purpose.`}
        ${' '}Book totals are unchanged by a transfer.</p>
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

function ConvertDialog({ book, status, onClose, onDone }) {
  const res = useBook(book.id);
  const pairs = useFxPairs();
  const [f, setF] = useState({ unitId: treasuryOf(book).id, pairId: '', action: 'sell', qty: null });
  const t = useTicket(onClose, onDone);
  const list = pairs.data?.items || [];
  const pair = list.find((p) => p.id === f.pairId);
  const obs = useQuote(f.pairId);
  const unit = book.units.find((u) => u.id === f.unitId);
  const { base, quote } = pair?.terms || {};
  const sold = f.action === 'sell' ? base : quote, bought = f.action === 'sell' ? quote : base;
  const px = obs ? (f.action === 'sell' ? obs.bid : obs.ask) ?? obs.value : null;
  const go = () => t.preview({ bookId: book.id, unitId: f.unitId, template: 'custom', name: `Convert ${sold} to ${bought}`, legs: [{ kind: 'trade', action: f.action, instrumentId: pair.id, qty: f.qty }] });
  return html`<${Modal} title="Convert currency" sub="A spot FX trade inside one Treasury or Account. It goes through the preview like any other trade." onClose=${onClose}
    footer=${foot(t, onClose, 'Preview conversion', go, !pair || !(f.qty > 0), 'Nothing is submitted until you confirm the preview.')}>
    ${pairs.data && !list.length ? noPairs : html`<div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label="In"><${UnitPick} book=${book} value=${f.unitId} onChange=${(v) => setF({ ...f, unitId: v })} /><//>
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

/** One package, one confirmation: borrow cash in one currency and sell it at spot for another. */
function BorrowConvertDialog({ book, status, onClose, onDone }) {
  const pairs = useFxPairs();
  const cat = useLive(() => get('/api/catalog'), [], { interval: false });
  const [f, setF] = useState({ unitId: treasuryOf(book).id, pairId: '', side: 'quote', principal: null, base: null });
  const [draft, setDraft] = useState(null);
  const t = useTicket(onClose, onDone);
  const product = cat.data?.products.find((p) => p.id === 'cash_loan') || cat.data?.products.find((p) => p.family === 'loan');
  useEffect(() => { if (product && !draft) setDraft(newDraft(product)); }, [Boolean(product)]);
  const list = pairs.data?.items || [];
  const pair = list.find((p) => p.id === f.pairId);
  const obs = useQuote(f.pairId);
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
  return html`<${Modal} size="mid" title="Borrow and convert" sub="Borrows cash in one currency and converts it at spot, as one package with one confirmation." onClose=${onClose}
    footer=${foot(t, onClose, 'Preview borrow and convert', go, !pair || !draft || !(f.principal > 0) || !(baseQty > 0), 'Nothing is submitted until you confirm the preview.')}>
    ${pairs.data && !list.length ? noPairs : html`<div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label="In"><${UnitPick} book=${book} value=${f.unitId} onChange=${(v) => setF({ ...f, unitId: v })} /><//>
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
        <${Notice}>The borrowed ${ccy} is settled cash at once and is sold immediately; it is a liability until repaid, and its interest rate is the one you enter above. The conversion settles T+${pair.terms.settleDays ?? 2}. The ${other} bought counts as buying power at once, but cannot be withdrawn or transferred before it settles.<//>` : null}
    </div>`}<//>`;
}

// ---- funding arrangements: cash loan or deposit, repo or reverse repo, securities lending ------------------
const MODES = {
  loan: { title: 'Cash loan or deposit', sub: 'Simulated borrowing or lending of cash at the terms you state. Borrowed cash is a liability.', family: 'loan', kind: 'loan', qty: 'Principal', button: 'Preview loan',
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

function ArrangementDialog({ book, mode, onClose, onDone }) {
  const m = MODES[mode];
  const res = useBook(book.id);
  const cat = useLive(() => get('/api/catalog'), [], { interval: false });
  const [f, setF] = useState({ unitId: treasuryOf(book).id, action: m.sides[0].value, productId: '', ccy: book.reportingCcy, qty: null, name: '' });
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
    setF({ ...f, unitId: v }); setPos(null);
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
  return html`<${Modal} size="mid" title=${m.title} sub=${m.sub} onClose=${onClose}
    footer=${foot(t, onClose, m.button, go, !draft || !(f.qty > 0) || !CCY.test(f.ccy), 'Nothing is submitted until you confirm the preview.')}>
    <div ...${t.form}><${ErrorNote} error=${t.error} />
      <div class="grid-form">
        <${Field} label="In"><${UnitPick} book=${book} value=${f.unitId} onChange=${changeUnit} /><//>
        ${m.sides.length > 1 ? html`<${Field} label="Side" span=${2} hint=${m.sideHint?.[f.action]}><div><${Seg} value=${f.action} onChange=${(v) => setF({ ...f, action: v })} options=${m.sides} /></div><//>` : null}
        <${Field} label="Product" span=${2}><${Select} value=${f.productId} onChange=${(v) => setF({ ...f, productId: v })} options=${products.map((p) => ({ value: p.id, label: plain(p.name) }))} /><//>
        ${needsPos ? html`<${Field} label=${mode === 'secloan' ? 'Position to lend' : 'Collateral position'} span=${2} hint=${pos ? `${fmtQty(Math.max(0, pos.qty - pos.pledgedQty - pos.onLoanQty))} of ${fmtQty(pos.qty)} is free (not pledged, not on loan).` : `A long position held in ${unitName(unit)}.`}>
          <${PositionPicker} key=${`${f.unitId}:${f.action}`} value=${pos?.positionId || ''} onChange=${(v, p) => pick(p)} bookId=${book.id} unitId=${f.unitId} families=${['bond', 'equity', 'fund']} direction="long" /><//>` : null}
        <${Field} label="Currency">${mode === 'secloan' ? html`<${Text} value=${pos ? f.ccy : ''} disabled onInput=${() => {}} placeholder="From the security" />` : html`<${Text} value=${f.ccy} onInput=${(v) => setF({ ...f, ccy: v.toUpperCase().slice(0, 3) })} />`}<//>
        <${Field} label=${m.qty} hint=${lending ? availableText(res.data, unit, f.ccy) : ''}><${Num} value=${f.qty} onInput=${(v) => setF({ ...f, qty: v })} /><//>
        <${Field} label="Name" span=${2} hint="Optional"><${Text} value=${f.name} onInput=${(v) => setF({ ...f, name: v })} placeholder=${autoName} /><//>
      </div>
      ${draft ? html`<h4>Terms</h4><div class="grid-form"><${ContractFields} draft=${draft} onChange=${setDraft} skip=${f.action === 'repo' ? ['terms.collateralInstrumentId'] : mode === 'secloan' ? ['underlyingId'] : []} /></div>` : null}
      ${f.action === 'repo' && pos ? html`<p class="note">${isNum(collValue)
        ? html`Collateral: ${fmtQty(collQty)} ${sym} at <${Price} obs=${pos.priceObs} value=${pos.price} /> is worth ${fmtMoney(collValue, pos.ccy)}${isNum(haircut) ? `, or ${fmtMoney(collValue * (1 - haircut), pos.ccy)} after the haircut` : ''}. A guide only: the principal you enter is not checked against it.`
        : isNum(pos.price) ? 'Enter the collateral quantity to see its value.' : `${sym} has no price, so the value of the collateral cannot be shown. The principal you enter is not checked against it.`}
        ${' '}The pledged quantity cannot be sold or lent until the repo is closed.</p>` : null}
      ${mode === 'secloan' ? html`<p class="note">To borrow a security, sell it short from its instrument page or the Strategy page: the borrow is a leg of the short sale. Shares on loan cannot be sold until they are taken back.</p>` : null}
      ${product && product.support !== 'full' ? html`<${Notice}>Paper support for ${plain(product.name)}: ${product.support === 'partial' ? 'partly manual' : 'manual inputs'}. ${product.note}<//>` : null}
    </div><//>`;
}

// ---- page sections ------------------------------------------------------------------------------------------
function TreasuryCash({ t, rc, treasuryId }) {
  const mine = t.collateralInventory.filter((i) => i.owner.kind === 'treasury');
  const ccys = [...new Set([...t.cash.map((c) => c.ccy), ...mine.map((i) => i.ccy)])].sort((a, b) => (a === rc ? -1 : b === rc ? 1 : a < b ? -1 : 1));
  const cash = (key) => (ccy) => bare(t.cash.find((c) => c.ccy === ccy)?.[key] ?? 0, ccy);
  const secs = (qtyKey) => (ccy) => {
    const rows = mine.filter((i) => i.ccy === ccy && i[qtyKey] > 0);
    if (rows.some((i) => !isNum(i.price))) return html`<${Missing} reason="A security counted here has no price" />`;
    return bare(sum(rows.map((i) => i[qtyKey] * i.price * i.instrument.multiplier)), ccy);
  };
  const row = (label, cell, what, strong) => ({ label, cell, what, strong });
  const rows = [
    { _group: 'Cash' },
    row('Settled', cash('settled'), 'Cash that has settled and sits in Treasury.'),
    row('Unsettled, receivable', cash('receivable'), 'Owed to Treasury on trades and conversions that have not settled yet.'),
    row('Unsettled, payable', cash('payable'), 'Owed by Treasury on trades and conversions that have not settled yet.'),
    row('Reserved', cash('reserved'), 'Set aside by cash holds. Each one is listed under Cash holds.'),
    row('Available to trade', cash('availableToTrade'), 'Settled cash plus receivables, less payables and reservations. Short-sale proceeds are never included.', true),
    row('Available to withdraw', cash('availableToWithdraw'), 'Settled cash less payables and reservations: the most a transfer, withdrawal or repayment can take today.', true),
    { _group: 'Restricted and posted' },
    row('Restricted', cash('restricted'), 'Short-sale proceeds and cash collateral received. Not buying power.'),
    row('Margin posted', cash('margin'), 'Cash posted as margin or collateral on open positions.'),
    { _group: 'Funding' },
    row('Borrowing', cash('borrowed'), 'Cash borrowed under loans and repos. A liability.'),
    row('Lending', cash('lent'), 'Cash lent under loans, deposits and reverse repos.'),
    row('Cash collateral received', cash('collateralReceived'), 'Owed back to the borrowers of securities lent. A liability.'),
    { _group: 'Securities collateral held in Treasury, valued at current market prices' },
    row('Pledged collateral', secs('pledgedQty'), 'Securities pledged under repos and secured loans. They cannot be sold or lent until released.'),
    row('Available collateral', secs('availableQty'), 'Securities neither pledged nor out on loan, free to pledge or lend.'),
  ];
  if (!ccys.length) return html`<${Empty} title="Treasury holds no cash yet">Deposit capital to start. Capital enters and leaves the Book only through Treasury.<//>`;
  return html`<${Table} margin rows=${rows} columns=${[
    { label: 'Treasury', render: (r) => html`<span class=${r.strong ? 'strong' : ''}>${r.label}</span>` },
    ...ccys.map((ccy) => ({ label: ccy, align: 'r', render: (r) => html`<span class=${r.strong ? 'strong' : ''}>${r.cell(ccy)}</span>` })),
    { label: 'What it is', cls: 'wrap', render: (r) => html`<span class="muted small">${r.what}</span>` },
  ]} />
  <div class="small muted" style="padding:8px 12px">Interest and fees to date are P&L, not a cash bucket: see <a href=${`#/accounting/pnl/${treasuryId}`}>Treasury P&L in Accounting</a>. Interest accrued on each open arrangement is listed under Funding arrangements.</div>`;
}

function Units({ book, d, rc, act }) {
  const { overview: o, treasury: t } = d;
  const why = 'A price or an FX rate is missing for something held here, so this value is incomplete. Accounting, Open positions lists what is unpriced.';
  const nav = (u) => html`${fmtMoney(u.nav, rc, { bare: true })}${u.navComplete ? null : html` <${Pill} tone="warn" title=${why}>incomplete<//>`}`;
  const lines = (u, key) => (u.cash.length ? u.cash.map((c) => html`<div>${fmtMoney(c[key], c.ccy)}</div>`) : html`<span class="muted">none</span>`);
  const accounts = o.units.filter((u) => u.kind === 'account');
  return html`<${Table} rows=${o.units} rowKey=${(u) => u.id} columns=${[
    { label: 'Name', render: (u) => html`<div class="sym">${unitName(u)}</div><div class="sub">${u.kind === 'treasury' ? 'Unallocated cash and funding' : 'Account'}</div>` },
    { label: `NAV (${rc})`, align: 'r', render: nav },
    { label: `Unrealized (${rc})`, align: 'r', render: (u) => html`<${Money} value=${u.unrealized} ccy=${rc} signed bare />${u.unrealizedComplete ? null : html` <${Pill} tone="warn" title=${why}>incomplete<//>`}` },
    { label: 'Positions', align: 'r', title: 'Open positions, including funding arrangements', render: (u) => u.openPositions },
    { label: 'Settled cash', align: 'r', render: (u) => lines(u, 'settled') },
    { label: 'Available to trade', align: 'r', render: (u) => lines(u, 'availableToTrade') },
    { label: 'Net funding', align: 'r', title: 'Net funding received: transfers in less transfers out, from Treasury and from other Accounts', render: (u) => {
      if (u.kind === 'treasury') return html`<span class="muted">source</span>`;
      const mine = t.accountFunding.filter((x) => x.account.id === u.id);
      return mine.length ? mine.map((x) => html`<div>${fmtMoney(x.funded, x.ccy)}</div>`) : html`<span class="muted">none</span>`;
    } },
    { label: '', align: 'r', render: (u) => html`${u.kind === 'account' ? html`<${Button} small title="Transfer cash from Treasury to this Account" onClick=${() => act.transfer(null, u.id)}>Fund<//> <${Button} small title="Transfer cash from this Account back to Treasury" onClick=${() => act.transfer(u.id, treasuryOf(book).id)}>Return<//> ` : null}<a class="btn small" href=${`#/accounting/pnl/${u.id}`}>Accounting</a>` },
  ]} footer=${html`<tr><td>Book, consolidated</td><td class="r">${nav({ nav: o.nav, navComplete: o.navComplete })}</td><td class="r"><${Money} value=${o.unrealized} ccy=${rc} signed bare /></td><td class="r">${sum(o.units.map((u) => u.openPositions))}</td><td colspan="4"></td></tr>`} />
  ${accounts.length ? null : html`<${Empty} title="No Accounts yet">Create one with New Account, then fund it from Treasury. Positions can also be held in Treasury itself.<//>`}
  <div class="small muted" style="padding:8px 12px">Book totals are consolidated: funding moved between Treasury and Accounts is an internal transfer and is left out, so nothing is counted twice. Nothing is pooled with any other Book.</div>`;
}

const CLOSE = {
  loan: (a) => ({ kind: 'repay', action: 'repay_cash', label: a.qty < 0 ? 'Repay' : 'Withdraw', confirm: a.qty < 0 ? 'Confirm repayment' : 'Confirm withdrawal' }),
  repo: (a) => ({ kind: 'repo_close', action: 'close_repo', label: a.qty < 0 ? 'Repurchase' : 'Terminate', confirm: a.qty < 0 ? 'Confirm repurchase' : 'Confirm termination' }),
  secloan: (a) => (a.qty > 0 ? { kind: 'return_sec', action: 'return_sec', label: 'Return', confirm: 'Confirm return' } : { kind: 'recall_sec', action: 'recall_sec', label: 'Take back', confirm: 'Confirm taking back' }),
};
/** The date since which a floating arrangement has had no fixing, if it is still floating. */
const noFixing = (a) => (a.rawTerms.rateType === 'floating' && a.data?.rateMissing) || null;
const KEY_TERMS = ['Rate', 'Fee', 'Maturity', 'Term', 'Cash collateral'];

function Funding({ d, act }) {
  const rows = d.treasury.arrangements;
  const close = (a) => {
    const c = CLOSE[a.family](a);
    return openPreview({ bookId: a.bookId, unitId: a.unitId, template: 'custom', attachTo: a.strategyId || undefined, legs: [{ kind: c.kind, action: c.action, purpose: 'financing', targetPositionId: a.positionId, qty: Math.abs(a.qty) }] },
      { openOverlay, toastError, onDone: act.reload, confirmLabel: c.confirm });
  };
  return html`<div class="toolbar"><${Button} onClick=${() => act.arrangement('loan')}>New loan or deposit<//><${Button} onClick=${() => act.arrangement('repo')}>New repo or reverse repo<//><${Button} onClick=${() => act.arrangement('secloan')}>Lend a security<//>
      <${Button} onClick=${act.borrowConvert}>Borrow and convert<//><span class="grow"></span><span class="note">Open loans, deposits, repos and securities loans across the Book. All are simulated arrangements.</span></div>
    <div class="panel"><div class="body flush"><${Table} margin rows=${rows} rowKey=${(a) => a.positionId}
      empty=${{ title: 'No funding arrangements are open', children: 'Loans, deposits, repos, reverse repos and securities loans appear here once opened with the buttons above, or as financing legs of a strategy.' }}
      columns=${[
        { label: 'Arrangement', render: (a) => html`<div class="strong">${a.name}</div><div class="sub">${a.direction}</div>` },
        { label: 'Held in', render: (a) => unitName(a.owner) },
        { label: 'Principal or quantity', align: 'r', render: (a) => (a.family === 'secloan' ? `${fmtQty(Math.abs(a.qty))} ${a.related?.symbol || ''}` : fmtMoney(Math.abs(a.qty), a.ccy)) },
        { label: 'Terms', cls: 'wrap', render: (a) => html`${a.terms.filter(([k]) => KEY_TERMS.includes(k)).map(([k, v]) => html`<div><span class="muted">${k}</span> ${v}</div>`)}
          ${isNum(a.collateral) && a.collateral ? html`<div><span class="muted">Cash collateral held</span> ${fmtMoney(a.collateral, a.ccy)}</div>` : null}
          ${noFixing(a) ? html`<div><${Pill} tone="warn" title="Interest has stopped accruing until a rate is supplied or set by hand">no fixing since ${noFixing(a)}<//></div>` : null}
          <details><summary class="note">All terms</summary><dl class="terms">${a.terms.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl></details>` },
        { label: 'Accrued', align: 'r', title: 'Interest or fee accrued and not yet paid. Negative is owed by the Book.', render: (a) => html`<${Money} value=${a.accrued} ccy=${a.ccy} signed /><div class="sub">${a.accrued < 0 ? 'owed' : a.accrued > 0 ? 'receivable' : ''}</div>` },
        { label: 'Related security', render: (a) => (a.related ? html`<div>${a.related.symbol || a.related.name}</div><div class="sub">${a.family === 'repo' ? `${fmtQty(a.rawTerms.collateralQty)} ${a.qty < 0 ? 'pledged' : 'received'}` : a.qty < 0 ? 'out on loan' : 'borrowed'}</div>` : html`<span class="muted">none</span>`) },
        { label: '', align: 'r', render: (a) => html`${a.family !== 'secloan' ? html`<${Button} small onClick=${() => act.rate(a)}>Set rate<//> ` : null}<${Button} small title="Opens the preview. A part repayment can be entered there." onClick=${() => close(a)}>${CLOSE[a.family](a).label}<//>` },
      ]} /></div></div>`;
}

function Collateral({ d }) {
  const { collateralInventory: inv, collateralReceived: recv } = d.treasury;
  return html`<div class="stack">
    <${Panel} title="Securities held" note="Across Treasury and every Account of this Book" flush><${Table} margin rows=${inv} rowKey=${(i) => i.positionId}
      empty=${{ title: 'No securities are held', children: 'Securities bought in Treasury or an Account appear here with what is pledged, on loan and free to use as collateral.' }}
      columns=${[
        { label: 'Security', render: (i) => html`<div class="sym">${i.instrument.symbol || i.instrument.name}</div><div class="sub clip">${i.instrument.symbol ? i.instrument.name : ''}</div>` },
        { label: 'Held in', render: (i) => unitName(i.owner) },
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
        { label: 'Quantity', align: 'r', render: (r) => fmtQty(r.qty) }, { label: 'Under', render: (r) => r.arrangement }, { label: 'Held in', render: (r) => unitName(r.owner) },
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
  return html`<p class="note">A hold reserves cash without moving it: the cash stays where it is, but cannot be traded, transferred or withdrawn. The total by currency is the Reserved line of each cash picture.</p>
    <div class="panel"><div class="body flush"><${Table} margin rows=${d.treasury.holds} rowKey=${(h) => h.id}
      empty=${{ title: 'No cash is reserved', children: 'Holds are placed by the engine against short options, short positions and exercise cash, and released when the position closes.' }}
      columns=${[
        { label: 'Held in', render: (h) => names.get(h.unit_id) || h.unit_id },
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

export default function Books({ args, book, status }) {
  const tab = TAB_IDS.includes(args[0]) ? args[0] : 'cash';
  const res = useBook(book.id);
  const d = res.data;
  const rc = book.reportingCcy;
  const open = (Comp, props = {}) => openOverlay((close) => html`<${Comp} book=${book} status=${status} ...${props} onClose=${close} onDone=${res.reload} />`);
  const act = {
    reload: res.reload,
    transfer: (from, to) => open(TransferDialog, { from, to }),
    arrangement: (mode) => open(ArrangementDialog, { mode }),
    borrowConvert: () => open(BorrowConvertDialog),
    rate: (a) => open(RateDialog, { a }),
  };
  const rename = () => open(NameDialog, { title: 'Rename Book', label: 'Book name', initial: book.name, button: 'Rename Book', done: 'Book renamed.', save: (name) => put(`/api/books/${book.id}`, { name }) });
  const newAccount = () => open(NameDialog, { title: 'New Account', sub: `In ${book.name}. It starts empty; fund it from Treasury.`, label: 'Account name', button: 'Create Account', done: 'Account created.', save: (name) => post(`/api/books/${book.id}/accounts`, { name }) });
  if (!d) return html`<div class="page-head"><h1>${book.name}</h1></div>${res.error ? html`<${ErrorNote} error=${res.error} />` : html`<div class="note">Loading the Book…</div>`}`;
  const { overview: o, treasury: t } = d;
  const accounts = o.units.filter((u) => u.kind === 'account');
  const incomplete = [o.unpriced ? `${o.unpriced} open position${o.unpriced > 1 ? 's have' : ' has'} no price and ${o.unpriced > 1 ? 'are' : 'is'} carried at cost` : null, o.fxMissing.length ? `no FX rate for ${o.fxMissing.join(', ')}` : null].filter(Boolean).join('; ');
  const part = html`<span style="color:var(--amber)" title=${incomplete}>Incomplete valuation</span>`;
  return html`<div>
    <div class="page-head"><div><h1>${book.name}</h1><div class="sub" style="max-width:96ch">One Treasury and ${accounts.length === 1 ? 'one Account' : accounts.length ? `${accounts.length} Accounts` : 'no Accounts yet'}, reporting in ${rc}. Every transaction belongs to this Book and to Treasury or one Account; nothing is pooled across Books.</div></div>
      <div class="actions"><${Button} onClick=${rename}>Rename Book<//><${Button} kind="primary" onClick=${newAccount}>New Account<//></div></div>
    ${res.error ? html`<div style="margin-bottom:10px"><${ErrorNote} error=${res.error} /></div>` : null}
    <div class="stats" style="margin-bottom:12px">
      <${Stat} label=${`Book NAV (${rc})`} value=${fmtMoney(o.nav, rc, { bare: true })} sub=${o.navComplete ? 'Treasury plus all Accounts, consolidated' : part} />
      <${Stat} label=${`Treasury NAV (${rc})`} value=${fmtMoney(t.treasuryNav.value, rc, { bare: true })} sub=${t.treasuryNav.complete ? 'Unallocated cash, funding and collateral' : part} />
      <${Stat} label=${`In Accounts (${rc})`} value=${accounts.length ? fmtMoney(sum(accounts.map((u) => u.nav)), rc, { bare: true }) : html`<${Missing} reason="This Book has no Accounts yet" />`} sub=${accounts.some((u) => !u.navComplete) ? part : `${accounts.length} Account${accounts.length === 1 ? '' : 's'}`} />
      <${Stat} label=${`Unrealized P&L (${rc})`} value=${html`<${Money} value=${o.unrealized} ccy=${rc} signed bare />`} sub=${o.unrealizedComplete ? 'Open positions, whole Book' : part} />
      <${Stat} label="Funding arrangements" value=${t.arrangements.length} sub="Loans, deposits, repos, securities loans" />
    </div>
    ${o.navComplete ? null : html`<div style="margin-bottom:12px">${status.data.market.connection === 'awaiting'
      ? html`<${Awaiting} compact what=${`The Book's valuation is incomplete: ${incomplete || 'a price or an FX rate is missing'}. Prices and FX rates arrive with the Shaffer MarketData connection. Until then enter them by hand on the instrument; nothing is estimated in their place.`} />`
      : html`<${Notice} tone="warn">The Book's valuation is incomplete: ${incomplete || 'a price or an FX rate is missing'}. Enter the missing price on the instrument, or wait for the next observation. Nothing is estimated in its place.<//>`}</div>`}
    <${Tabs} value=${tab} onChange=${(id) => { location.hash = `#/treasury/${id}`; }} tabs=${[
      { id: 'cash', label: 'Treasury and Accounts' }, { id: 'funding', label: 'Funding arrangements', count: t.arrangements.length },
      { id: 'collateral', label: 'Collateral inventory', count: t.collateralInventory.length }, { id: 'holds', label: 'Cash holds', count: t.holds.length },
      { id: 'alerts', label: 'Needs attention', alert: d.alerts.length || undefined },
    ]} />
    ${tab === 'cash' ? html`<div class="stack">
      <${Panel} title="Treasury and Accounts" flush actions=${html`<${Button} small onClick=${() => act.transfer()}>Transfer cash<//>`}><${Units} book=${book} d=${d} rc=${rc} act=${act} /><//>
      <${Panel} title="Treasury cash by currency" flush actions=${html`<${Button} small onClick=${() => open(CapitalDialog)}>Deposit or withdraw<//>
        <${Button} small onClick=${() => open(ConvertDialog)}>Convert currency<//><${Button} small onClick=${act.borrowConvert}>Borrow and convert<//>`}>
        <${TreasuryCash} t=${t} rc=${rc} treasuryId=${t.treasury.id} /><//>
    </div>` : null}
    ${tab === 'funding' ? html`<${Funding} d=${d} act=${act} />` : null}
    ${tab === 'collateral' ? html`<${Collateral} d=${d} />` : null}
    ${tab === 'holds' ? html`<${Holds} book=${book} d=${d} />` : null}
    ${tab === 'alerts' ? html`<${Alerts} book=${book} d=${d} act=${act} />` : null}
  </div>`;
}
