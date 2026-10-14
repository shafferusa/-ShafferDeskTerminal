// Instrument drawer: quote with provenance, product-appropriate trade ticket, analytics from
// Analytics Lab (or its waiting state), contract terms, option chain / contract months,
// positions held, corporate actions and price history. The ticket states how the trade settles
// (the instrument's convention, or a date or lag stated for this trade) and the Overview names the
// trading, settlement and payment calendars; a calendar that is approximate or weekends only is
// flagged with a badge and a sentence on both.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { bump, currentBook, fmtMoney, fmtNum, fmtPrice, fmtPriceUnits, fmtQty, fmtTime, get, getState, isNum, openOverlay, post, setUnit, toast, toastError, useLive, VIEW_LABEL } from '../lib/core.js';
import { Awaiting, Button, Check, Drawer, Empty, Field, Holdings, holdingsFromPositions, KV, LineChart, Missing, Modal, Money, Notice, Num, Panel, Pill, Price, Prov, Seg, Select, Signed, Support, Table, Tabs, Text } from '../lib/ui.js';
import { openPreview } from './preview.js';
import { strategyInput, StrategyPicker } from './hedge.js';
import { buildStrategy, hedgeFromWorkspace, openFullPage, useHeaderData, useRefreshSettings, useSelection, useWorkspaceStrategy, WorkspaceHeader } from './workspace.js';

const ACTION_LABEL = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
const OBJECTIVES = [
  { value: '', label: 'Not set' }, { value: 'downside_protection', label: 'Downside protection' }, { value: 'upside_protection_short', label: 'Upside protection for shorts' },
  { value: 'market_sector_reduction', label: 'Market / sector exposure reduction' }, { value: 'currency_protection', label: 'Currency protection' }, { value: 'rate_protection', label: 'Rate protection' },
  { value: 'credit_protection', label: 'Credit protection' }, { value: 'volatility_protection', label: 'Volatility protection' }, { value: 'server_defined', label: 'Other (defined by the Strategy on the server)' },
];
/**
 * The one way to open an instrument from anywhere (Marketplaces, search, watchlists, holdings and position rows,
 * Strategies legs, strategy detail, hedge legs, the registry): the quick overview drawer, with Open full page leading
 * to #/instrument/<id>. The Book and trading owner are the ones in use (store), so both carry over.
 */
export function openInstrument(id, opts = {}) {
  // Opened from a dialog (a hedge popup's leg, a preview): the drawer is raised above it.
  const over = typeof document !== 'undefined' && Boolean(document.querySelector('.modal'));
  openOverlay((close) => html`<div class=${over ? 'ws-over' : ''}><${InstrumentDrawer} id=${id} initialTab=${opts.tab} onClose=${close} /></div>`);
}

/**
 * The Trading owner picker used by every ticket and the Strategies page: the Book's Accounts, and apart from them
 * Treasury, labelled as the Book's own balance sheet. Choosing here also makes that owner the one in use, the same
 * as choosing an Account in the sidebar, so it carries to the next ticket and the Strategies page. Nothing is chosen
 * by substitution: with no owner in use and no Account, the picker asks for a choice (see defaultUnit).
 */
export const TREASURY_OWNER_GROUP = "Treasury (the Book's own balance sheet)";
export function UnitSelect({ value, onChange, book }) {
  const b = book || currentBook();
  const accounts = (b?.units || []).filter((u) => u.kind === 'account');
  const treasury = (b?.units || []).find((u) => u.kind === 'treasury');
  const options = [
    ...(accounts.length ? accounts.map((u) => ({ value: u.id, label: u.name, group: 'Accounts' })) : [{ value: '~none', label: 'No Accounts in this Book yet', group: 'Accounts', disabled: true }]),
    ...(treasury ? [{ value: treasury.id, label: 'Treasury', group: TREASURY_OWNER_GROUP }] : []),
  ];
  return html`<${Select} value=${value || ''} placeholder=${value ? undefined : 'Choose an owner'} onChange=${(v) => { if (!v || v === '~none') return; setUnit(v); onChange(v); }} options=${options} />`;
}
/**
 * The owner in use (sidebar, or chosen on the last ticket) if it belongs to this Book; otherwise the Book's first
 * Account. A Book with no Account gets no default: Treasury is offered as an explicit choice, never substituted.
 */
export function defaultUnit(book) {
  const b = book || currentBook();
  const inUse = getState().unitId;
  return b?.units.find((u) => u.id === inUse)?.id || b?.units.find((u) => u.kind === 'account')?.id || '';
}
/** What the Trading owner field says under the picker: which kind of owner is chosen, or that one must be. */
export function ownerHint(book, unitId, extra) {
  const b = book || currentBook();
  const u = b?.units.find((x) => x.id === unitId);
  const accounts = (b?.units || []).filter((x) => x.kind === 'account').length;
  if (!u) return accounts ? 'Choose an Account, or Treasury (the Book\'s own balance sheet).' : html`This Book has no Accounts. Choose Treasury to trade on the Book's own balance sheet, or <a href="#/treasury">create an Account</a> under Treasury.`;
  return html`${u.kind === 'treasury' ? 'Treasury: the Book\'s own balance sheet, not an Account.' : `Account in ${b.name}.`}${extra ? html` ${extra}` : null}`;
}

/** Order instructions shared by tickets. */
export function OrderFields({ o, set }) {
  return html`
    <${Field} label="Order type"><${Select} value=${o.orderType} onChange=${(v) => set({ orderType: v })} options=${[{ value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' }, { value: 'stop', label: 'Stop' }, { value: 'stop_limit', label: 'Stop limit' }]} /><//>
    ${['limit', 'stop_limit'].includes(o.orderType) ? html`<${Field} label="Limit price"><${Num} value=${o.limitPrice} onInput=${(v) => set({ limitPrice: v })} /><//>` : null}
    ${['stop', 'stop_limit'].includes(o.orderType) ? html`<${Field} label="Stop price"><${Num} value=${o.stopPrice} onInput=${(v) => set({ stopPrice: v })} /><//>` : null}
    <${Field} label="Time in force"><${Select} value=${o.tif} onChange=${(v) => set({ tif: v })} options=${[{ value: 'day', label: 'Day' }, { value: 'gtc', label: 'Until cancelled' }]} /><//>`;
}

/** Investment Strategy, holding period and hedge objective: the context a hedge request needs. */
// The Strategy is chosen by its ID from the list Analytics Lab supplies (in demo mode, the labelled demo list). A
// name can be typed only while that list is unavailable, and is then carried as an unresolved name. All three
// fields may be left empty: the hedge popup that follows the fill asks for whatever is missing.
const strategyRefOf = (v) => (typeof v === 'string' ? (v.trim() ? { id: null, name: v.trim(), resolved: false } : null) : v || null);
export function HedgeContext({ c, set }) {
  return html`
    <${Field} label="Investment Strategy" span=${2}><${StrategyPicker} value=${strategyRefOf(c.strategy)} onChange=${(v) => set({ strategy: v })} /><//>
    <${Field} label="Intended holding period (days)"><${Num} value=${c.days} onInput=${(v) => set({ days: v })} /><//>
    <${Field} label="Hedge objective" span=${2}><${Select} value=${c.objective} onChange=${(v) => set({ objective: v })} options=${OBJECTIVES} placeholder="Not set (the hedge popup will ask)" /><//>`;
}
export const hedgeContextInput = (c) => ({
  investmentStrategy: strategyInput(strategyRefOf(c.strategy)),
  holdingPeriod: c.days ? { days: c.days } : null,
  hedgeObjective: c.objective ? { type: c.objective } : null,
});

const BASIS_WORDS = { explicit: 'set on the instrument', venue: 'from the venue country', currency: 'from the currency', fallback: 'weekends-only fallback' };
/** Badge and sentence for a calendar that is approximate or weekends only. Nothing when the calendars are complete. */
export function CalendarFlag({ calendar, compact }) {
  if (!calendar?.flag) return null;
  const pill = html`<${Pill} tone="warn">${calendar.flag === 'weekends-only' ? 'weekends-only calendar' : 'approximate calendar'}<//>`;
  if (compact) return html`<div class="calflag">${pill} ${calendar.flagText}</div>`;
  return html`<${Notice} tone="warn">${pill} ${calendar.flagText} ${calendar.flag === 'weekends-only' ? 'Set calendars on the instrument (Edit), or add local holidays under Settings, Market calendars.' : ''}<//>`;
}
/** One calendar role. `said` lists notes already shown for an earlier role, so the same sentence is not repeated three times. */
function CalendarLine({ c, extra, said = [] }) {
  const note = c.note && !said.some((x) => x && c.note.startsWith(x)) ? c.note : c.note && said.some((x) => x && c.note.startsWith(x) && c.note.length > x.length) ? c.note.slice(said.find((x) => x && c.note.startsWith(x)).length).trim() : null;
  return html`<div class="calrow"><span>${c.label}</span><span class="muted">${c.id}, ${BASIS_WORDS[c.basis] || c.basis}</span>${c.fallback ? html`<${Pill} tone="warn">weekends only<//>` : c.approximate ? html`<${Pill} tone="warn">approximate<//>` : null}</div>
    ${note ? html`<div class="sub">${note}</div>` : null}${extra ? html`<div class="sub">${extra}</div>` : null}`;
}

/**
 * How this trade settles: the instrument's convention, or a settlement date or a lag stated for this
 * trade alone. What is stated is checked against the settlement calendar as it is typed; a conflict
 * is shown here and blocks the preview.
 */
function SettlementField({ inst, detail, book, value, onChange }) {
  const std = detail.settlement;
  const [check, setCheck] = useState(null);
  const stated = value.mode === 'date' ? (value.date ? { date: value.date } : null) : value.mode === 'lag' ? (isNum(value.lag) ? { lag: value.lag } : null) : null;
  const key = stated ? JSON.stringify(stated) : '';
  useEffect(() => {
    setCheck(null);
    if (!stated || !book) return undefined;
    let live = true;
    const t = setTimeout(() => { get(`/api/instruments/${inst.id}/settlement`, { bookId: book.id, ...stated }).then((r) => { if (live) setCheck(r); }, () => {}); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key, inst.id, book?.id]);
  if (!std) return null;
  if (!std.configurable) return html`<${Field} label="Settlement" span=${2} hint=${std.reason}><div class="small" style="padding-top:5px">${std.label}</div><//>`;
  const how = std.basis === 'instrument' ? 'set on the instrument' : 'Book default';
  const conflict = check?.conflicts?.[0]?.message || null;
  const hint = stated ? (check && !conflict ? `Settles ${check.date}${isNum(check.lag) ? ` (${check.lag === 0 ? 'same day' : `T+${check.lag}`})` : ''} on ${check.calendar.id}. The convention would be ${std.date}.` : 'Checked against the settlement calendar.')
    : detail.trading && !detail.trading.open ? `${std.label} (${how}): the market is closed today, so an order is matched on ${std.tradeDate} and settles ${std.date}, counted on ${std.calendar.id}.`
      : `${std.label} (${how}): a trade today settles ${std.date}, counted on ${std.calendar.id}.`;
  return html`<${Field} label="Settlement" span=${2} hint=${conflict ? null : hint} error=${conflict}>
    <div class="row" style="flex-wrap:nowrap;gap:6px">
      <div style="flex:1;min-width:0"><${Select} value=${value.mode} onChange=${(m) => onChange({ ...value, mode: m })} options=${[{ value: 'std', label: `Convention: ${std.label}, ${std.date}` }, { value: 'date', label: 'State a settlement date' }, { value: 'lag', label: 'State a lag in business days' }]} /></div>
      ${value.mode === 'date' ? html`<div style="width:140px;flex:none"><${Text} type="date" value=${value.date} onInput=${(v) => onChange({ ...value, date: v })} /></div>` : null}
      ${value.mode === 'lag' ? html`<div style="width:90px;flex:none"><${Num} value=${value.lag} onInput=${(v) => onChange({ ...value, lag: v })} placeholder="0 to 30" /></div>` : null}
    </div><//>`;
}
/** The `settle` field of a leg for what the ticket states, or undefined for the convention. */
const statedSettle = (v) => (v.mode === 'date' && v.date ? { date: v.date } : v.mode === 'lag' && isNum(v.lag) ? { lag: v.lag } : undefined);

export function Ticket({ inst, detail, book, onDone, presetStrategy, quote = true }) {
  const [unitId, setUnitId] = useState(defaultUnit(book));
  const [action, setAction] = useState(inst.actions[0]);
  const [fromId, setFromId] = useState('');
  const [qty, setQty] = useState(null);
  const [o, setO] = useState({ orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day' });
  const [stated, setStated] = useState(null);
  const [stl, setStl] = useState({ mode: 'std', date: '', lag: null });
  const [fin, setFin] = useState('none');
  const [loanRate, setLoanRate] = useState(null);
  const [borrow, setBorrow] = useState({ available: true, feeRate: null });
  const [ctx, setCtx] = useState({ strategy: presetStrategy || '', days: null, objective: '' });
  // The Strategy chosen in the workspace header fills the ticket's investment Strategy (it can still be changed here).
  useEffect(() => { if (presetStrategy) setCtx((c) => ({ ...c, strategy: presetStrategy })); }, [presetStrategy?.id]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const obs = detail.observation;
  const labelOf = (a) => inst.actionLabels?.[a] || (inst.family === 'option' || inst.family === 'otcoption' ? { buy: 'Buy', sell: 'Sell / write' }[a] : inst.family === 'fx' ? { buy: `Buy ${inst.terms.base}`, sell: `Sell ${inst.terms.base}` }[a] : ACTION_LABEL[a]) || a;
  const mine = detail.positions.filter((p) => p.unitId === unitId);
  const hasBorrowData = Boolean(detail.borrow?.obs);
  // For securities, Sell reduces a long this Account already holds and Buy to cover reduces a short.
  // Going short is always its own action, with its borrow.
  const security = ['equity', 'fund', 'spot', 'crypto', 'bond', 'manual'].includes(inst.family);
  const longs = mine.filter((p) => p.qty > 0), shorts = mine.filter((p) => p.qty < 0);
  const actions = security ? ['buy', 'sell', ...(inst.actions.includes('sell_short') ? ['sell_short'] : []), ...(shorts.length ? ['buy_to_cover'] : [])] : inst.actions.filter((a) => a !== 'buy_to_cover');
  const reducing = security && (action === 'sell' || action === 'buy_to_cover');
  const pool = action === 'sell' ? longs : action === 'buy_to_cover' ? shorts : [];
  const from = pool.find((p) => p.positionId === fromId) || pool[0] || null;
  useEffect(() => { if (!actions.includes(action) || (action === 'sell' && security && !longs.length)) setAction(actions[0]); }, [unitId, actions.join(), longs.length]);

  const submit = async () => {
    setBusy(true);
    const order = { orderType: o.orderType, limitPrice: o.limitPrice, stopPrice: o.stopPrice, tif: o.tif, statedPrice: stated, settle: statedSettle(stl) };
    if (reducing) {
      await openPreviewAction(from.strategyId, 'close', { positionIds: [from.positionId], qty, order }, { onDone: (st) => { setQty(null); onDone?.(st); } });
      setBusy(false);
      return;
    }
    const legs = [];
    if (action === 'sell_short') {
      legs.push({ kind: 'borrow_sec', action: 'borrow_sec', instrumentId: inst.id, qty, purpose: 'financing', role: 'borrow', borrow: hasBorrowData ? null : borrow, note: 'Simulated securities borrow. The short sale cannot execute without it.' });
      legs.push({ kind: 'trade', action, instrumentId: inst.id, qty, role: 'underlying', dependsOn: [1], ...order });
    } else legs.push({ kind: 'trade', action, instrumentId: inst.id, qty, role: 'underlying', ...order });
    const simpleLong = action === 'buy' && ['equity', 'fund', 'spot', 'crypto', 'bond', 'manual'].includes(inst.family);
    const input = {
      bookId: book.id, unitId, template: simpleLong ? 'long' : action === 'sell_short' ? 'short' : 'custom', underlyingId: inst.id, legs, origin: 'marketplace',
      name: simpleLong || action === 'sell_short' ? undefined : `${labelOf(action)} ${inst.symbol || inst.name}`,
      financing: fin === 'none' ? null : fin === 'treasury' ? { mode: 'treasury' } : { mode: 'loan', rateType: 'fixed', rate: loanRate },
      ...hedgeContextInput(ctx),
    };
    await openPreview(input, { openOverlay, toastError, onDone: (s) => { setQty(null); onDone?.(s); } });
    setBusy(false);
  };
  const posActs = (p) => html`<div class="pos-acts">${FINANCEABLE.has(inst.family) ? html`<${HoldingFinancing} inst=${inst} book=${book} p=${{ ...p, owner: book.units.find((u) => u.id === p.unitId)?.name }} onDone=${onDone} />` : null}
    <span class="row nowrap" style="gap:4px;justify-content:flex-end"><${Button} small onClick=${() => closePos(p, 0.5)}>Close half<//><${Button} small onClick=${() => closePos(p)}>Close<//></span></div>`;
  const closePos = async (p, fraction = 1) => {
    const pv = await openPreviewAction(p.strategyId, 'close', { positionIds: [p.positionId], fraction }, { onDone });
    return pv;
  };

  if (inst.arrangement) return html`<${Notice}>This is a financing arrangement. Open, repay or terminate it from Treasury or the Account.<//>`;
  // In the workspace drawer the sticky header already shows the quote, bid and ask (quote=false).
  return html`<div class="stack">
    ${quote ? html`<div class="row">
      <div><div class="note">Current market price</div><div style="font-size:20px"><${Price} obs=${obs} reason=${detail.marketState.connection === 'awaiting' ? detail.marketState.message : 'No price available'} /></div></div>
      ${obs && isNum(obs.bid) ? html`<div class="stat"><span class="k">Bid</span><span class="v" style="font-size:15px">${fmtPriceUnits(obs.bid, inst.priceUnits)}</span><span class="s">${isNum(obs.bidSize) ? `size ${fmtQty(obs.bidSize)}` : ''}</span></div>
        <div class="stat"><span class="k">Ask</span><span class="v" style="font-size:15px">${fmtPriceUnits(obs.ask, inst.priceUnits)}</span><span class="s">${isNum(obs.askSize) ? `size ${fmtQty(obs.askSize)}` : ''}</span></div>` : null}
      <span class="spacer"></span><span class="note">${inst.priceUnits}, ${inst.tradingCcy}</span>
    </div>` : null}
    ${!obs ? html`<${Awaiting} compact what="There is no price for this instrument. A paper order would wait as a working order. Enter a price on the Overview tab, or state a fill price below." />` : null}
    <${CalendarFlag} calendar=${inst.calendar} />
    ${detail.trading && !detail.trading.open ? html`<${Notice} tone="warn"><b>${detail.trading.reason}</b> An order placed now stays working until then; its trade date and settlement are counted from the day it fills. A Day order placed today is good for ${detail.trading.next}.<//>` : null}
    <div class="row" style="padding:6px 10px;border:1px solid var(--rule);border-radius:4px;background:var(--paper)"><${Holdings} h=${holdingsFromPositions(detail.positions)} detail label=${`${book.name} holds`} /></div>
    <div class="grid-form">
      <${Field} label="Trading owner" hint=${ownerHint(book, unitId, unitId ? (mine.length ? html`Held here: <${Holdings} h=${holdingsFromPositions(mine)} />` : 'No position held here.') : null)}><${UnitSelect} value=${unitId} onChange=${setUnitId} book=${book} /><//>
      <${Field} label="Action" span=${2}><${Seg} value=${action} onChange=${setAction} options=${actions.map((a) => ({ value: a, label: labelOf(a), disabled: security && a === 'sell' && !longs.length, title: security && a === 'sell' && !longs.length ? 'This Account holds none to sell. To go short, choose Sell short.' : undefined }))} /><//>
      ${reducing && pool.length > 1 ? html`<${Field} label=${action === 'sell' ? 'Sell from' : 'Cover'} span=${2}><${Select} value=${from?.positionId} onChange=${setFromId} options=${pool.map((p) => ({ value: p.positionId, label: `${p.strategy?.name || 'Position'}: ${fmtQty(Math.abs(p.qty))}` }))} /><//>` : null}
      <${Field} label=${inst.qtyLabel} hint=${inst.multiplier !== 1 && inst.family !== 'bond' && inst.family !== 'swap' && inst.family !== 'cds' ? `Contract multiplier ${inst.multiplier}` : inst.family === 'bond' ? 'Face amount' : ''}><${Num} value=${qty} onInput=${setQty} /><//>
      <${OrderFields} o=${o} set=${(p) => setO({ ...o, ...p })} />
      <${Field} label="State a fill price" hint="Optional. Recorded as a manual input, not a market quote."><${Num} value=${stated} onInput=${setStated} placeholder="none" /><//>
      <${SettlementField} inst=${inst} detail=${detail} book=${book} value=${stl} onChange=${setStl} />
    </div>
    ${reducing && from ? html`<${Notice}>${action === 'sell' ? 'Sells from' : 'Covers'} <b>${from.strategy?.name || 'the position'}</b> in ${book.units.find((u) => u.id === unitId)?.kind === 'treasury' ? 'Treasury' : 'this Account'}, which is ${from.qty > 0 ? 'long' : 'short'} ${fmtQty(Math.abs(from.qty))}${isNum(from.avgCost) ? ` at an average ${fmtPriceUnits(from.avgCost, inst.priceUnits)}` : ''}.${action === 'buy_to_cover' ? ' The matching borrowed securities are returned once the cover fills.' : ''}${qty > Math.abs(from.qty) ? html` <b>${fmtQty(qty)} is more than it holds.</b>` : ''}<//>` : null}
    ${security && !longs.length && !shorts.length && detail.positions.length ? html`<div class="note">Held in other Accounts of this Book, not in this one. Choose that Account to sell it.</div>` : null}
    ${action === 'sell_short' ? html`<${Panel} title="Securities borrow">
      ${hasBorrowData ? html`<div><${Pill} tone=${detail.borrow.available ? 'ok' : 'bad'}>${detail.borrow.available ? 'Available to borrow' : 'Not available to borrow'}<//> fee ${fmtNum(detail.borrow.feeRate * 100, 3)}% a year${isNum(detail.borrow.quantity) ? `, ${fmtQty(detail.borrow.quantity)} available` : ''} <${Prov} obs=${detail.borrow.obs} /></div>`
        : html`<div class="stack"><${Awaiting} compact what="No borrow availability or fee data for this security. State your own assumption to proceed; it is recorded as a manual assumption." />
          <div class="grid-form"><${Field} label="Assume available"><${Check} checked=${borrow.available} onChange=${(v) => setBorrow({ ...borrow, available: v })}>Yes<//><//>
          <${Field} label="Borrow fee (decimal a year)" hint="0.005 = 0.5%"><${Num} value=${borrow.feeRate} onInput=${(v) => setBorrow({ ...borrow, feeRate: v })} /><//></div></div>`}
      <p class="note" style="margin-top:8px">The borrow is its own leg. If it fails, the short sale is rejected with it. Sale proceeds are held as restricted collateral.</p><//>` : null}
    ${ctx.strategy && typeof ctx.strategy === 'object' && ctx.strategy.id ? html`<div class="note" data-testid="ticket-strategy">Investment Strategy: <b>${ctx.strategy.name}</b> (${ctx.strategy.id})${presetStrategy?.id === ctx.strategy.id ? ', as chosen in the header' : ''}. It goes with the order and the hedge request that follows the fill.</div>` : null}
    <div class="row"><button class="btn link" onClick=${() => setMore(!more)}>${more ? 'Hide' : 'Show'} funding and hedge context</button></div>
    ${more ? html`<div class="grid-form">
      <${Field} label="If cash is short" span=${2}><${Select} value=${fin} onChange=${setFin} options=${[{ value: 'none', label: 'Do not finance (the trade is blocked)' }, { value: 'treasury', label: 'Fund the shortfall from Treasury' }, { value: 'loan', label: 'Borrow the shortfall (simulated lender)' }]} /><//>
      ${fin === 'loan' ? html`<${Field} label="Loan rate (decimal a year)" hint="0.06 = 6%. Not assumed for you."><${Num} value=${loanRate} onInput=${setLoanRate} /><//>` : null}
      <${HedgeContext} c=${ctx} set=${(p) => setCtx({ ...ctx, ...p })} />
    </div>` : null}
    <div class="row"><${Button} kind=${action === 'buy' ? 'buy' : action === 'sell' || action === 'sell_short' ? 'sell' : 'primary'} busy=${busy} disabled=${!(qty > 0) || !unitId || (reducing && (!from || qty > Math.abs(from.qty)))} onClick=${submit}>Preview ${labelOf(action).toLowerCase()}<//>
      <span class="note">Nothing is submitted until you confirm the preview.</span></div>
    ${mine.length ? html`<${Panel} title="Positions in this Account" flush>
      <${Table} columns=${[
        // On a narrow screen the buttons sit under the strategy name instead of in a last column (app.css, ui1).
        { label: 'Strategy', render: (p) => html`${p.strategy?.name || ''}<div class="pos-acts-sm">${posActs(p)}</div>` },
        { label: 'Quantity', align: 'r', render: (p) => fmtQty(p.qty) },
        { label: 'Average cost', align: 'r', render: (p) => fmtPriceUnits(p.avgCost, inst.priceUnits) },
        { label: 'Unrealized', align: 'r', render: (p) => html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} />` },
        { label: FINANCEABLE.has(inst.family) ? 'Financing and close' : '', align: 'r acts', title: FINANCEABLE.has(inst.family) ? 'Repo, lend or pledge this holding (opens the Treasury or Account dialog with it filled in), or close it' : undefined, render: (p) => posActs(p) },
      ]} rows=${mine} rowKey=${(p) => p.positionId} /><//>` : null}
    <${FinancingLinks} inst=${inst} book=${book} unitId=${unitId} longs=${longs} onShort=${() => setAction('sell_short')} canShort=${actions.includes('sell_short')} onDone=${onDone} />
  </div>`;
}

/**
 * Financing of this instrument (ui1). Borrowing, lending, repo and pledging stay on the Treasury and Account pages:
 * these links open the same dialogs those pages use (treasury.js ArrangementDialog), with the instrument, the holding
 * and its owner filled in. No new engine path: the dialog previews and confirms as it does on those pages.
 * A securities borrow is always a leg of a short sale, so "Borrow this security" turns the ticket to Sell short.
 * Each link is shown where the product and the holding allow it; where not, the reason is said.
 */
export const FINANCEABLE = new Set(['equity', 'fund', 'bond']);
const freeQty = (p) => Math.max(0, p.qty - (p.pledgedQty || 0) - (p.onLoanQty || 0));
/** Why a holding cannot be repoed, lent or pledged; null when it can. */
export function holdingBlock(inst, p) {
  if (!FINANCEABLE.has(inst.family)) return notFinanceable(inst);
  if (!p) return 'Choose the trading owner first.';
  if (p.qty <= 0) return 'A short position is covered by its securities borrow: it cannot be repoed, lent or pledged.';
  if (freeQty(p) <= 0) return `All ${fmtQty(p.qty)} held are ${p.onLoanQty > 0 && p.pledgedQty > 0 ? 'pledged or on loan' : p.onLoanQty > 0 ? 'on loan' : 'pledged'}: nothing is free to repo, lend or pledge until it is returned or released.`;
  return null;
}
function notFinanceable(inst) {
  if (inst.arrangement) return 'This is a financing arrangement itself. Open, repay or terminate it from Treasury or the Account.';
  if (inst.marketView?.endsWith('DERIV') || ['option', 'future', 'swap', 'cds', 'forward', 'otcoption'].includes(inst.family)) return 'A derivative is not repoed, lent or pledged here. Its premium, margin and collateral are funded from cash: choose how under "If cash is short" on the ticket, or move cash from Treasury.';
  return `Repo, securities lending and pledging take equities, funds and bonds held long; ${inst.support.productName.replace(/ \(.*\)$/, '')} is not one of them. Fund a purchase with cash, or with a loan arranged on the Treasury or Account page.`;
}
/** Open the Treasury / Account dialog for this instrument; `positionId` names the holding when it came from one. */
export async function openFinancing({ book, inst, unitId, mode, side, productId, positionId, onDone }) {
  const m = await import('./treasury.js');
  openOverlay((close) => html`<${m.ArrangementDialog} book=${book} mode=${mode} side=${side} unitId=${unitId} preset=${{ instrumentId: inst.id, productId, positionId }} onClose=${close} onDone=${(x) => { bump(); onDone?.(x); }} />`);
}
/** The three holding links (repo, lend, finance) for one holding, as small buttons; disabled with the reason when they do not apply. */
export function HoldingFinancing({ inst, book, p, onDone }) {
  const why = holdingBlock(inst, p);
  if (!FINANCEABLE.has(inst.family) || p.qty <= 0) return html`<span class="muted small" title=${why}>${p.qty < 0 ? 'Short: covered by its borrow' : 'Not financeable'}</span>`;
  const go = (mode, side, productId) => openFinancing({ book, inst, unitId: p.unitId, mode, side, productId, positionId: p.positionId, onDone });
  return html`<span class="row nowrap" style="gap:4px;justify-content:flex-end">
    <${Button} small disabled=${Boolean(why)} title=${why || `Repo: borrow cash against this holding of ${p.owner || 'its owner'}`} onClick=${() => go('repo', 'repo')}>Repo<//>
    <${Button} small disabled=${Boolean(why)} title=${why || `Lend this holding of ${p.owner || 'its owner'}`} onClick=${() => go('secloan', 'lend_sec')}>Lend<//>
    <${Button} small disabled=${Boolean(why)} title=${why || `A securities-backed loan pledging this holding of ${p.owner || 'its owner'}`} onClick=${() => go('loan', 'borrow_cash', 'securities_backed_loan')}>Finance<//></span>`;
}
function FinancingLinks({ inst, book, unitId, longs, onShort, canShort, onDone }) {
  if (inst.arrangement) return null;
  const owner = book.units.find((u) => u.id === unitId);
  const where = owner ? (owner.kind === 'treasury' ? 'Treasury' : owner.name) : 'the trading owner';
  const page = owner ? (owner.kind === 'treasury' ? '#/treasury/borrowings' : `#/account/${owner.id}`) : '#/treasury';
  const pageLink = html`<a class="btn small link" href=${page}>Open ${owner?.kind === 'account' ? `${owner.name}'s page` : 'Treasury borrowings and lending'}</a>`;
  if (!FINANCEABLE.has(inst.family)) {
    return html`<${Panel} title="Financing" note="Borrowing, lending, repo and funding are arranged on the Treasury and Account pages">
      <p class="note" style="margin:0 0 6px" data-testid="financing-reason">${notFinanceable(inst)}</p><div class="row">${pageLink}</div><//>`;
  }
  const free = longs.reduce((a, p) => a + freeQty(p), 0);
  const held = longs.length > 0;
  const hold = held ? (longs.find((p) => freeQty(p) > 0) || longs[0]) : null;
  const why = !owner ? 'Choose the trading owner first.' : !held ? `${where} holds no long position in it: repo, lending and pledging need one.` : holdingBlock(inst, { ...hold, qty: longs.reduce((a, p) => a + p.qty, 0), pledgedQty: longs.reduce((a, p) => a + (p.pledgedQty || 0), 0), onLoanQty: longs.reduce((a, p) => a + (p.onLoanQty || 0), 0) });
  const open = (mode, side, productId) => openFinancing({ book, inst, unitId, mode, side, productId, positionId: hold?.positionId, onDone });
  return html`<${Panel} title="Financing" note=${`Arranged on the ${owner?.kind === 'account' ? 'Account' : 'Treasury'} page; these open the same dialogs`}>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      <${Button} small disabled=${!canShort} onClick=${onShort} title=${canShort ? 'A borrow is always a leg of a short sale: the ticket turns to Sell short, with its borrow leg' : `${inst.support.productName} cannot be sold short here, so there is nothing to borrow`}>Borrow this security<//>
      <${Button} small disabled=${Boolean(why)} onClick=${() => open('repo', 'repo')} title=${why || `Repo: borrow cash against this holding of ${where}`}>Repo this holding<//>
      <${Button} small disabled=${Boolean(why)} onClick=${() => open('secloan', 'lend_sec')} title=${why || `Lend this holding of ${where}`}>Lend this holding<//>
      <${Button} small disabled=${Boolean(why)} onClick=${() => open('loan', 'borrow_cash', 'securities_backed_loan')} title=${why || `A securities-backed loan pledging this holding of ${where}`}>Finance this position<//>
      <${Button} small disabled=${!owner} onClick=${() => open('repo', 'reverse_repo')} title=${owner ? 'Reverse repo: lend cash and take this security as collateral' : 'Choose the trading owner first.'}>Reverse repo against it<//>
      ${pageLink}
    </div>
    <p class="note" style="margin:6px 0 0" data-testid="financing-reason">${why ? html`<b>Repo, lend and finance:</b> ${why}` : `${where} holds ${fmtQty(free)} free to repo, lend or pledge.`}${canShort ? '' : html` <b>Borrow:</b> ${inst.support.productName} cannot be sold short here.`} Nothing is submitted until the dialog's preview is confirmed.</p>
  <//>`;
}

/** Preview a lifecycle action on a strategy (close, resize, roll, retry, unwind). */
export async function openPreviewAction(strategyId, action, args = {}, { onDone } = {}) {
  try {
    const pv = await post(`/api/strategies/${strategyId}/preview-action`, { action, ...args });
    const { PreviewModal } = await import('./preview.js');
    openOverlay((close) => html`<${PreviewModal} preview=${pv} onClose=${close} onDone=${onDone} confirmLabel=${{ close: 'Confirm close', unwind: 'Confirm unwind', resize: 'Confirm resize', roll: 'Confirm roll', retry: 'Confirm retry' }[action] || 'Confirm paper trade'} />`);
    return pv;
  } catch (err) { toastError(err); return null; }
}

function ManualPrice({ inst, onSaved }) {
  const [v, setV] = useState({ value: null, bid: null, ask: null, forDate: '', note: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post('/api/observations', { kind: 'price', subject: inst.id, value: v.value, bid: v.bid, ask: v.ask, currency: inst.tradingCcy, units: inst.priceUnits, forDate: v.forDate || null, note: v.note || null });
      toast('Manual price saved. It is labelled as manually entered everywhere it appears.');
      setV({ value: null, bid: null, ask: null, forDate: '', note: '' });
      bump(); onSaved?.();
    } catch (err) { toastError(err); }
    setBusy(false);
  };
  return html`<div class="grid-form">
    <${Field} label=${`Price (${inst.priceUnits})`} span=${inst.family === 'swap' ? 'all' : undefined} hint=${inst.family === 'swap' ? 'A swap is marked at its net present value per 100 notional, negative when it is against you. Include the interest accrued since the last payment: nothing accrues in the ledger between payment dates. On a cross-currency swap, leave out the principal already exchanged: it is on the balance sheet as lent and owed, and would be counted twice.' : undefined}><${Num} value=${v.value} onInput=${(x) => setV({ ...v, value: x })} /><//>
    <${Field} label="Bid" hint="Optional"><${Num} value=${v.bid} onInput=${(x) => setV({ ...v, bid: x })} /><//>
    <${Field} label="Ask" hint="Optional"><${Num} value=${v.ask} onInput=${(x) => setV({ ...v, ask: x })} /><//>
    <${Field} label="Closing price or fixing for date" hint="Leave empty for a current price"><${Text} type="date" value=${v.forDate} onInput=${(x) => setV({ ...v, forDate: x })} /><//>
    <${Field} label="Note" span=${2}><${Text} value=${v.note} onInput=${(x) => setV({ ...v, note: x })} placeholder="Where the price came from" /><//>
    <div class="field" style="justify-content:flex-end"><${Button} busy=${busy} disabled=${!isNum(v.value) && !(isNum(v.bid) && isNum(v.ask))} onClick=${save}>Save manual price<//></div>
  </div>`;
}

function Analytics({ a, state }) {
  if (!a) return html`<${Awaiting} what="EFS, Sector Score, Equity Score, Fundamental and Realistic Fair Value, both Gaps, timing eligibility, outlier flags, sizing suggestions and hedge outputs are supplied by Analytics Lab. Nothing is estimated here." />`;
  const n = (x, dp = 2) => (isNum(x) ? fmtNum(x, dp) : html`<${Missing} reason="Not supplied by Analytics Lab" />`);
  return html`<div class="stack">
    <table class="ledger"><thead><tr><th></th><th class="r">Fundamental</th><th class="r">Realistic</th></tr></thead><tbody>
      <tr><td>Fair price</td><td class="r">${isNum(a.fundamentalFairValue) ? fmtPrice(a.fundamentalFairValue) : html`<${Missing} />`}</td><td class="r">${isNum(a.realisticFairValue) ? fmtPrice(a.realisticFairValue) : html`<${Missing} />`}</td></tr>
      <tr><td>Gap %</td><td class="r"><${Signed} value=${a.fundamentalGap} suffix="%" /></td><td class="r"><${Signed} value=${a.realisticGap} suffix="%" /></td></tr>
    </tbody></table>
    <${KV} rows=${[['EFS', n(a.efs)], ['Sector Score', n(a.sectorScore)], ['Equity Score', n(a.equityScore)],
      ['Timing eligibility', a.timingEligibility ?? html`<${Missing} reason="Not supplied" />`], ['Outlier flags', a.outlierFlags?.length ? a.outlierFlags.join(', ') : a.outlierFlags ? 'None' : html`<${Missing} reason="Not supplied" />`],
      ['Sizing suggestion', a.sizing ? JSON.stringify(a.sizing) : html`<${Missing} reason="Not supplied" />`], ['Hedge output', a.hedge ? JSON.stringify(a.hedge) : html`<${Missing} reason="Not supplied" />`],
      ['Model run', a.modelRun || html`<${Missing} />`], ['As of', a.asOf ? fmtTime(a.asOf) : html`<${Missing} />`], ['Source', a.source || state.message]]} />
    <p class="note">Fair prices are analytical values. They are never treated as an executable quote and never used to fill an order.</p>
  </div>`;
}

function Overview({ inst, detail, reload, onClose }) {
  const obs = detail.observation;
  return html`<div class="stack">
    <${Panel} title="Current market price">
      ${obs ? html`<div class="stats">
          <div class="stat"><span class="k">Price</span><span class="v">${fmtPriceUnits(obs.value, inst.priceUnits)}</span><span class="s"><${Prov} obs=${obs} /></span></div>
          <div class="stat"><span class="k">Bid / ask</span><span class="v" style="font-size:15px">${isNum(obs.bid) ? `${fmtPriceUnits(obs.bid, inst.priceUnits)} / ${fmtPriceUnits(obs.ask, inst.priceUnits)}` : '—'}</span><span class="s">${isNum(obs.bidSize) ? `${fmtQty(obs.bidSize)} x ${fmtQty(obs.askSize)}` : ''}</span></div>
          <div class="stat"><span class="k">Source</span><span class="v" style="font-size:14px">${obs.source}</span><span class="s">${fmtTime(obs.asOf, { seconds: true })}</span></div>
          <div class="stat"><span class="k">Currency and units</span><span class="v" style="font-size:14px">${obs.currency || inst.tradingCcy}</span><span class="s">${obs.units || inst.priceUnits}</span></div>
          <div class="stat"><span class="k">Freshness</span><span class="v" style="font-size:14px">${{ fresh: 'Fresh', stale: 'Stale', manual: 'Manual entry', unknown: 'Unknown' }[obs.freshness]}</span><span class="s">${detail.session?.state ? `session ${detail.session.state}` : ''}</span></div>
        </div>` : html`<${Awaiting} compact what="No price for this instrument yet. Enter one below to value positions and fill paper orders against it." />`}
      <h4 style="margin:12px 0 6px">Enter a price by hand</h4>
      <${ManualPrice} inst=${inst} onSaved=${reload} />
      ${detail.manualEntries.length ? html`<details style="margin-top:8px"><summary class="note">Manual entries kept on file (${detail.manualEntries.length})</summary>
        <table class="ledger"><tbody>${detail.manualEntries.map((m) => html`<tr><td>${fmtTime(m.as_of)}</td><td class="r">${fmtPrice(m.value)}</td><td>${m.for_date ? `for ${m.for_date}` : 'current'}</td><td>${m.superseded_by ? 'superseded' : 'in use'}</td><td>${m.note || ''}</td></tr>`)}</tbody></table></details>` : null}
    <//>
    <${Panel} title="Fair price and analytics" note="From Shaffer Analytics Lab"><${Analytics} a=${detail.analytics} state=${detail.analyticsState} /><//>
    <${Panel} title="Contract">
      ${inst.calendar.flag ? html`<div style="margin-bottom:10px"><${CalendarFlag} calendar=${inst.calendar} /></div>` : null}
      <${KV} rows=${[
        ['Product', inst.support.productName],
        ['Lifecycle support', html`<${Support} level=${inst.support.level} note=${inst.support.note} /> ${inst.support.note || 'Orders, settlement, accounting and scheduled events are simulated from the contract terms.'}`],
        ['Pricing coverage', html`${inst.pricing.state === 'priced' ? html`<${Pill} tone="ok">priced now<//>` : inst.pricing.state === 'unpriced' ? html`<${Pill} tone="warn">no price yet<//>` : html`<${Pill}>not needed<//>`} ${inst.pricing.basisLabel}${inst.pricing.current ? `. Current source: ${inst.pricing.current.source} (${inst.pricing.current.status}).` : '.'} This is separate from lifecycle support.`],
        ['Trading calendar', html`<${CalendarLine} c=${inst.calendar.trading} />`],
        ['Settlement calendar', html`<${CalendarLine} c=${inst.calendar.settlement} said=${[inst.calendar.trading.note]} />`],
        ['Payment calendar', html`<${CalendarLine} c=${inst.calendar.payment} said=${[inst.calendar.trading.note, inst.calendar.settlement.note]} extra=${inst.calendar.payment.currencies?.length ? `Payments in ${inst.calendar.payment.currencies.join(' and ')} follow ${inst.calendar.payment.currencies.map((x) => (inst.calendar.payment.currencyCalendars[x] ? `the ${x} payment calendar (${inst.calendar.payment.currencyCalendars[x]})` : `no built-in calendar for ${x}`)).join(' and ')}, joined with the calendar above.` : ''} />`],
        ['Settlement convention', html`${inst.settlement.configurable ? html`${detail.settlement ? detail.settlement.label : inst.settlement.label} <span class="muted">${inst.settlement.basis === 'instrument' ? 'set on the instrument' : 'from the Book\'s paper-desk assumptions'}</span>` : html`${inst.settlement.label} <span class="muted">fixed by the product</span>`}
          ${detail.settlement ? html`<div class="sub">${detail.trading && !detail.trading.open ? `${detail.trading.reason} That trade settles ${detail.settlement.date}.` : `A trade today (${detail.settlement.tradeDate}) settles ${detail.settlement.date}.`}${inst.settlement.configurable ? 'A date or lag can be stated for one trade on the ticket.' : inst.settlement.reason}</div>` : null}`],
        ['Listing venue country', inst.venueCountry || html`<${Missing} reason="Not recorded. It selects the calendars unless they are set on the instrument." />`],
        // ui1: where the instrument sits in the Marketplaces and what placed it there (catalog.js routing convention).
        ['Market view', html`${inst.arrangement ? html`Not a Marketplace row: a financing arrangement, arranged on the Treasury and Account pages` : html`<a href=${`#/markets/${inst.marketView}/${inst.classification?.tab || ''}/show/${encodeURIComponent(inst.id)}`} onClick=${() => onClose?.()} title="Open the Marketplace tab this instrument is in, with its row picked out">${VIEW_LABEL[inst.marketView]}${inst.classification?.tabLabel ? `, ${inst.classification.tabLabel}` : ''}</a>`}
          ${inst.classification?.routing ? html`<div class="sub">${inst.classification.routing.text.toLowerCase().startsWith(inst.classification.routing.basisLabel.toLowerCase()) ? '' : `${inst.classification.routing.basisLabel}: `}${inst.classification.routing.text}.${inst.classification.routing.basis === 'convention' ? ' No US listing or US jurisdiction is recorded; state a jurisdiction or set the view by hand under Edit.' : ''}</div>` : null}`],
        ['Jurisdiction', inst.jurisdiction || html`<${Missing} reason="Not stated. For an instrument that is not listed it decides US or Foreign." />`],
        ['Venue', inst.venue ? `${inst.venue} (${inst.venueType === 'otc' ? 'OTC' : inst.venueType === 'global' ? 'global platform' : 'exchange'})` : inst.venueType === 'otc' ? 'OTC' : inst.venueType === 'global' ? 'Global, no listing venue' : null],
        ['Issuer', inst.issuer], ['Issuer domicile', inst.domicile], ['Underlying geography', inst.underlyingGeo],
        inst.underlying ? ['Underlying', html`<a href="javascript:void 0" onClick=${() => openInstrument(inst.underlying.id)}>${inst.underlying.symbol || inst.underlying.name}</a>`] : null,
        ['Trading currency', inst.tradingCcy], inst.settleCcy !== inst.tradingCcy ? ['Settlement currency', inst.settleCcy] : null,
        ['Quantity in', inst.qtyLabel], ['Price in', inst.priceUnits],
        ...inst.details,
        ['Terminal ID', inst.id], ['Shaffer MarketData ID', inst.externalIds?.shaffer || html`<${Missing} reason="Linked when reference data is connected" />`],
        ['Reference source', inst.refSource === 'manual' ? 'Entered by hand' : inst.refSource],
      ]} /><//>
  </div>`;
}

function OptionTicket({ und, c, chain, onClose }) {
  const book = currentBook();
  const [unitId, setUnitId] = useState(defaultUnit(book));
  const [action, setAction] = useState('buy');
  const [qty, setQty] = useState(1);
  const [o, setO] = useState({ orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const spec = { underlyingId: und.id, expiration: c.expiration, strike: c.strike, right: c.right, multiplier: c.multiplier, deliverableUnits: c.deliverable?.shares ?? c.deliverable?.units ?? c.multiplier, exercise: c.exercise || 'american', settlement: c.settlement || 'physical' };
    const template = action === 'buy' ? (c.right === 'C' ? 'long_call' : 'long_put') : 'custom';
    const pv = await openPreview({ bookId: book.id, unitId, template, underlyingId: und.id, origin: 'marketplace', name: action === 'sell' ? `Short ${c.right === 'C' ? 'call' : 'put'} ${und.symbol} ${c.strike} ${c.expiration}` : undefined,
      legs: [{ kind: 'trade', action, option: spec, qty, group: 'options', role: c.right === 'C' ? 'call' : 'put', ...o }] }, { openOverlay, toastError });
    setBusy(false);
    if (pv) onClose();
  };
  return html`<${Modal} title=${`${und.symbol} ${c.expiration} ${c.strike} ${c.right === 'C' ? 'call' : 'put'}`} sub=${`One contract delivers ${fmtQty(c.deliverable?.shares ?? c.multiplier)} units; premium multiplier ${c.multiplier}. Quote: ${chain.source}.`} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!(qty > 0) || !unitId} onClick=${go}>Preview<//>`}>
    <div class="grid-form">
      <${Field} label="Trading owner" hint=${ownerHint(null, unitId)}><${UnitSelect} value=${unitId} onChange=${setUnitId} /><//>
      <${Field} label="Action"><${Seg} value=${action} onChange=${setAction} options=${[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell / write' }]} /><//>
      <${Field} label="Contracts"><${Num} value=${qty} onInput=${setQty} /><//>
      <${OrderFields} o=${o} set=${(p) => setO({ ...o, ...p })} />
    </div>
    ${action === 'sell' ? html`<p class="note" style="margin-top:10px">Writing an option reserves cash: a short put is fully cash-secured; an uncovered short call reserves a share of the underlying's value and has unbounded loss. For covered structures use the Strategy page.</p>` : null}
  <//>`;
}

export function Chain({ inst }) {
  const [exp, setExp] = useState('');
  const res = useLive(() => get(`/api/instruments/${inst.id}/chain`, { expiration: exp }), [inst.id, exp]);
  const months = useLive(() => get(`/api/instruments/${inst.id}/contracts`, { family: 'future' }), [inst.id], { interval: false });
  const d = res.data;
  const register = async (productId) => { const m = await import('./registry.js'); m.openCreateInstrument({ view: inst.marketView.replace('CASH', 'DERIV'), preset: { productId, underlyingId: inst.id, tradingCcy: inst.tradingCcy } }); };
  const quote = (c) => html`<button class="btn link" onClick=${() => openOverlay((close) => html`<${OptionTicket} und=${inst} c=${c} chain=${d.chain} onClose=${close} />`)}>${fmtPrice(c.bid)} / ${fmtPrice(c.ask)}</button>`;
  return html`<div class="stack">
    <${Panel} title="Option chain" flush=${Boolean(d?.available)} actions=${d?.available ? html`<div style="width:170px"><${Select} value=${d.chain.expiration} onChange=${setExp} options=${d.chain.expirations.map((e) => ({ value: e, label: e }))} /></div>` : null}>
      ${!d ? html`<${Empty}>Loading…<//>` : d.available ? html`
        <table class="ledger"><thead><tr><th class="r">Call bid / ask</th><th class="r">IV</th><th class="c">Strike</th><th class="r">Put bid / ask</th><th class="r">IV</th></tr></thead><tbody>
          ${d.chain.strikes.map((k) => { const c = d.chain.calls.find((x) => x.strike === k), p = d.chain.puts.find((x) => x.strike === k); const atm = Math.abs(k - d.chain.underlying.price) < (d.chain.strikes[1] - d.chain.strikes[0]) / 2;
            return html`<tr><td class="r">${c ? quote(c) : ''}</td><td class="r sub">${c && isNum(c.iv) ? `${fmtNum(c.iv * 100, 1)}%` : ''}</td><td class=${`c ${atm ? 'strong' : ''}`}>${fmtPrice(k)}</td><td class="r">${p ? quote(p) : ''}</td><td class="r sub">${p && isNum(p.iv) ? `${fmtNum(p.iv * 100, 1)}%` : ''}</td></tr>`; })}
        </tbody></table>
        <div class="body small muted">Underlying ${fmtPrice(d.chain.underlying.price)} ${d.chain.underlying.currency}. Source: ${d.chain.source} (${d.chain.status}). Choose a quote to open a ticket.</div>`
        : html`<div class="stack"><${Awaiting} compact what="Option chains are derivative contract data from Shaffer MarketData. Until they are supplied, register a contract by hand with its own multiplier and deliverable." />
          ${d.registered.length ? html`<${Table} columns=${[{ label: 'Registered contract', render: (i) => html`<a href="javascript:void 0" onClick=${() => openInstrument(i.id, { tab: 'trade' })}>${i.name}</a>` }, { label: 'Multiplier', align: 'r', render: (i) => i.multiplier }]} rows=${d.registered} />` : null}
          <div><${Button} onClick=${() => register('equity_option')}>Register an option contract<//></div></div>`}
    <//>
    <${Panel} title="Futures contract months" flush=${Boolean(months.data?.registered?.length)}>
      ${months.data?.registered?.length ? html`<${Table} columns=${[
        { label: 'Contract', render: (i) => html`<a href="javascript:void 0" onClick=${() => openInstrument(i.id, { tab: 'trade' })}>${i.symbol || i.name}</a>` },
        { label: 'Expiration', render: (i) => i.terms.expiration || 'Perpetual' }, { label: 'Multiplier', align: 'r', render: (i) => i.multiplier },
        { label: 'Initial margin', align: 'r', render: (i) => (isNum(i.terms.initialMargin) ? fmtMoney(i.terms.initialMargin, i.tradingCcy) : html`<${Missing} reason="Not supplied" />`) },
      ]} rows=${months.data.registered} />` : html`<div class="stack">${months.data && !months.data.available ? html`<${Awaiting} compact what="Futures contract data comes from Shaffer MarketData. Register a contract by hand to trade it now." />` : html`<p class="note">No futures are registered on this underlying.</p>`}
        <div><${Button} onClick=${() => register('equity_future')}>Register a futures contract<//></div></div>`}
    <//>
  </div>`;
}

function History({ inst }) {
  const res = useLive(() => get(`/api/instruments/${inst.id}/history`), [inst.id], { interval: false });
  const ca = useLive(() => get('/api/corporate-actions', { instrumentId: inst.id }), [inst.id]);
  const [f, setF] = useState({ type: 'cash_dividend', exDate: '', payDate: '', amount: null, ratioNum: null, ratioDen: 1 });
  // A pay date is optional and applies to a cash dividend: entitlement is fixed by the holding at the open of the
  // ex-date, the cash is posted on the pay date (on the ex-date when none is given). A split takes effect on its ex-date.
  const payBad = f.type === 'cash_dividend' && f.payDate && f.exDate && f.payDate < f.exDate;
  const record = async () => {
    try {
      const { payDate, ...rest } = f;
      await post('/api/corporate-actions', { instrumentId: inst.id, ...rest, ...(f.type === 'cash_dividend' && payDate ? { payDate } : {}) });
      toast(f.type === 'cash_dividend' ? `Dividend recorded. It is paid on ${payDate || f.exDate} on the holding at the open of the ex-date.` : 'Split recorded. It is applied on its ex-date.');
      setF({ ...f, exDate: '', payDate: '', amount: null, ratioNum: null }); ca.reload(); bump();
    } catch (err) { toastError(err); }
  };
  const d = res.data;
  return html`<div class="stack">
    <${Panel} title="Price history">${!d ? html`<${Empty}>Loading…<//>` : d.available ? html`<${LineChart} bars=${d.bars} /><p class="note">Daily closes. Source: ${d.source} (${d.status}). Historical coverage alone does not mean live prices are available.</p>` : html`<${Awaiting} compact what="Historical prices come from Shaffer MarketData." />`}<//>
    <${Panel} title="Dividends and corporate actions">
      ${ca.data?.items.length ? html`<${Table} columns=${[
        { label: 'Type', render: (c) => (c.type === 'split' ? 'Split' : 'Cash dividend') }, { label: 'Ex-date', key: 'ex_date' },
        { label: 'Pay date', render: (c) => (c.type === 'split' ? html`<span class="muted">on the ex-date</span>` : c.pay_date || c.ex_date) },
        { label: 'Terms', render: (c) => (c.type === 'split' ? `${c.ratio_num} for ${c.ratio_den}` : `${c.amount} ${c.ccy} per unit`) },
        { label: 'Source', key: 'source' }, { label: 'Status', render: (c) => html`<${Pill} tone=${c.status === 'applied' ? 'ok' : ''}>${c.status}<//>` },
      ]} rows=${ca.data.items} />` : html`<p class="note">None recorded. Corporate actions are supplied by Shaffer MarketData when connected, or recorded here by hand.</p>`}
      <h4 style="margin:12px 0 6px">Record one by hand</h4>
      <div class="grid-form">
        <${Field} label="Type"><${Select} value=${f.type} onChange=${(v) => setF({ ...f, type: v })} options=${[{ value: 'cash_dividend', label: 'Cash dividend' }, { value: 'split', label: 'Split' }]} /><//>
        <${Field} label=${html`Ex-date <span class="muted">(required)</span>`}><${Text} type="date" value=${f.exDate} onInput=${(v) => setF({ ...f, exDate: v })} /><//>
        ${f.type === 'cash_dividend' ? html`<${Field} label="Pay date" hint="Optional. The cash is posted on this date; left empty, on the ex-date." error=${payBad ? 'The pay date must be on or after the ex-date.' : null}><${Text} type="date" value=${f.payDate} onInput=${(v) => setF({ ...f, payDate: v })} /><//>` : null}
        ${f.type === 'split' ? html`<${Field} label="New shares"><${Num} value=${f.ratioNum} onInput=${(v) => setF({ ...f, ratioNum: v })} /><//><${Field} label="For each old"><${Num} value=${f.ratioDen} onInput=${(v) => setF({ ...f, ratioDen: v })} /><//>`
          : html`<${Field} label=${`Amount per unit (${inst.tradingCcy})`}><${Num} value=${f.amount} onInput=${(v) => setF({ ...f, amount: v })} /><//>`}
        <div class="field" style="justify-content:flex-end"><${Button} disabled=${!f.exDate || Boolean(payBad)} onClick=${record}>Record<//></div>
      </div><//>
  </div>`;
}

function Positions({ detail, reload, book }) {
  const openStrategy = async (id) => { const m = await import('./strategy-detail.js'); m.openStrategy(id); };
  const inst = detail.instrument;
  return html`<${Table} columns=${[
    { label: 'Held in', render: (p) => p.owner },
    { label: 'Strategy', render: (p) => (p.strategy ? html`<a href="javascript:void 0" onClick=${() => openStrategy(p.strategy.id)}>${p.strategy.name}</a>` : '') },
    { label: 'Quantity', align: 'r', render: (p) => fmtQty(p.qty) }, { label: 'Average cost', align: 'r', render: (p) => fmtPriceUnits(p.avgCost, detail.instrument?.priceUnits) },
    { label: 'Market value', align: 'r', render: (p) => html`<${Money} value=${p.mv} ccy=${p.ccy} reason=${p.missingReason} />` },
    { label: 'Unrealized', align: 'r', render: (p) => html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} />` },
    FINANCEABLE.has(inst.family) && book ? { label: 'Financing', align: 'r', title: 'Repo, lend or pledge this holding: opens the Treasury or Account dialog with the holding and its owner filled in', render: (p) => html`<${HoldingFinancing} inst=${inst} book=${book} p=${p} onDone=${reload} />` } : null,
    { label: '', align: 'r', render: (p) => html`<${Button} small onClick=${() => openPreviewAction(p.strategy.id, 'close', { positionIds: [p.positionId] }, { onDone: reload })}>Close<//>` },
  ].filter(Boolean)} rows=${detail.positions} rowKey=${(p) => p.positionId} empty=${{ title: 'No position in this Book', children: 'Use the Trade tab to open one.' }} />
    ${detail.positions.length && !FINANCEABLE.has(inst.family) ? html`<p class="note">${notFinanceable(inst)}</p>` : null}`;
}

function InstrumentDrawer({ id, initialTab, onClose }) {
  const book = currentBook();
  const [tab, setTab] = useState(initialTab || 'trade');
  const res = useLive(() => get(`/api/instruments/${id}/detail`, { bookId: book?.id }), [id, book?.id]);
  const d = res.data;
  const sel = useSelection(id, 'drawer');
  const [strategy, setStrategy] = useWorkspaceStrategy();
  const intervalFor = useRefreshSettings();
  const head = useHeaderData(sel, strategy, intervalFor);
  const bodyRef = useRef(null);
  useEffect(() => { if (d && initialTab === 'chain' && !['equity', 'fund', 'future'].includes(d.instrument.family)) setTab('overview'); }, [Boolean(d)]);
  if (!d) return html`<${Drawer} title="Instrument" onClose=${onClose}>${res.error ? html`<${Notice} tone="err">${res.error.message}<//>` : html`<${Empty}>Loading…<//>`}<//>`;
  const inst = d.instrument;
  const chainable = ['equity', 'fund'].includes(inst.family);
  const tabs = [{ id: 'trade', label: 'Trade' }, { id: 'overview', label: 'Overview' }, chainable ? { id: 'chain', label: 'Options and futures' } : null, { id: 'positions', label: 'Positions', count: d.positions.length }, { id: 'history', label: 'History and actions' }].filter(Boolean);
  const addToList = async () => {
    try {
      const wl = await get('/api/watchlists', { view: inst.marketView });
      await post(`/api/watchlists/${wl.items[0].id}/items`, { instrumentId: inst.id });
      toast(`Added to the ${wl.items[0].name} watchlist.`); bump();
    } catch (err) { toastError(err); }
  };
  const edit = async () => { const m = await import('./registry.js'); m.openEditInstrument(inst, { onDone: res.reload }); };
  const trade = () => { setTab('trade'); bodyRef.current?.closest('.body')?.scrollTo?.({ top: 0 }); };
  return html`<${Drawer} wide onClose=${onClose} title=${inst.symbol ? `${inst.symbol}  ${inst.name}` : inst.name} sub=${`${inst.support.productName}, ${inst.arrangement ? 'financing arrangement' : `${VIEW_LABEL[inst.marketView]}${inst.classification?.tabLabel ? `, ${inst.classification.tabLabel}` : ''}`}, ${inst.tradingCcy}`}
    actions=${html`<${Button} small onClick=${addToList}>Add to watchlist<//><${Button} small onClick=${edit}>Edit<//>`}>
    <div ref=${bodyRef} class="ws-sticky"><${WorkspaceHeader} inst=${inst} detail=${d} analytics=${head.analytics} reference=${head.reference} strategy=${strategy} setStrategy=${setStrategy} book=${book}
      onTrade=${trade} onBuild=${() => { onClose(); buildStrategy(inst, strategy); }} onHedge=${() => hedgeFromWorkspace({ inst, detail: d, book, strategy })}
      onOpenPage=${() => { onClose(); openFullPage(inst.id, tab === 'history' ? 'history' : tab === 'positions' ? 'positions' : ''); }} />
    <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} /></div>
    ${tab === 'trade' ? html`<${Ticket} inst=${inst} detail=${d} book=${book} onDone=${res.reload} presetStrategy=${strategy} quote=${false} />` : null}
    ${tab === 'overview' ? html`<${Overview} inst=${inst} detail=${d} reload=${res.reload} onClose=${onClose} />` : null}
    ${tab === 'chain' ? html`<${Chain} inst=${inst} />` : null}
    ${tab === 'positions' ? html`<${Positions} detail=${d} reload=${res.reload} book=${book} />` : null}
    ${tab === 'history' ? html`<${History} inst=${inst} />` : null}
  <//>`;
}
