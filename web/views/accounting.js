// Accounting.
//
// One page for the selected Book, at four kinds of scope: the whole Book consolidated (Treasury plus
// every Account, internal funding eliminated), Treasury alone, one Account, or several Accounts
// together. Six tabs: P&L, balance sheet, open positions, pending trades, failed and cancelled
// trades, and the full audit history. The tab and scope live in the address
// (#/accounting/<tab>/<scope>, where <scope> is book, treasury, a unit id, or unit ids joined by
// commas) so a view can be linked and back/forward work. A scope never leaves its Book.
//
// Figures come from the server as computed. Every row names the Treasury or Account that owns it.
// A value that rests on a missing or stale price or conversion rate is marked provisional and the
// affected items are named; a value that cannot be computed is drawn as missing, never as zero.
// History is append-only: a correction is a new event that points at the one it corrects.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, toast, toastError, useLive } from '../lib/core.js';
import { Awaiting, Button, Check, Empty, ErrorNote, Field, Holdings, LineChart, Missing, Modal, Money, NavAffected, NavValue, Notice, Num, OrderStatus, Pill, Price, Prov, PURPOSE_LABEL, Seg, Select, StrategyStatus, Table, Tabs, Text } from '../lib/ui.js';
import { openHedgeRequest, protectionText, protectionWords, sourceWords, StrategyRef } from './hedge.js';
import { openInstrument } from './instrument.js';
import { openStrategy } from './strategy-detail.js';

const TABS = [['pnl', 'P&L'], ['balance', 'Balance sheet'], ['positions', 'Open positions'], ['pending', 'Pending trades'], ['failed', 'Failed and cancelled trades'], ['history', 'Full history']];
const NOTIONAL_FAMILIES = ['future', 'forward', 'swap', 'cds'];
const ADJ_CATEGORIES = [['fee', 'Fees'], ['commission', 'Commissions'], ['realized', 'Realized P&L'], ['dividend', 'Dividends'], ['coupon', 'Coupon income'], ['interest', 'Interest income'], ['borrow', 'Securities-borrow cost'], ['funding', 'Funding expense'], ['lending', 'Securities-lending income'], ['capital', 'External capital (Treasury only)']];
const CASH_ACCOUNT = { cash: 'settled cash', 'cash.restricted': 'restricted cash', 'cash.margin': 'margin' };
const unitLabel = (u) => (u.kind === 'treasury' ? 'Treasury' : u.name);
const words = (s) => String(s || '').replace(/[._]/g, ' ');
const sentence = (s) => words(s).replace(/^\w/, (c) => c.toUpperCase());
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listNames = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0] || '');
const instName = (i) => (i ? i.symbol || i.name : '');
const link = (label, onClick, title) => html`<a href="javascript:void 0" title=${title} onClick=${(e) => { e.stopPropagation(); onClick(); }}>${label}</a>`;
const InstLink = ({ i }) => (i ? link(instName(i), () => openInstrument(i.id), i.name) : html`<span class="muted">none</span>`);
const StratLink = ({ s }) => (s ? link(s.name, () => openStrategy(s.id), `Strategy instance ${s.id}`) : html`<span class="muted">none</span>`);
const Provisional = ({ why }) => html`<${Pill} tone="warn" title=${why}>provisional<//>`;
/** A reporting-currency figure: missing when unknown, marked provisional when it leaves something out. */
function Rc({ value, ccy, complete = true, why, signed = true, stack = false }) {
  if (!isNum(value)) return html`<${Missing} reason=${why} />`;
  return html`<${Money} value=${value} ccy=${ccy} signed=${signed} />${complete ? null : stack ? html`<div><${Provisional} why=${why} /></div>` : html` <${Provisional} why=${why} />`}`;
}
const Section = ({ title, note, actions, children }) => html`<section class="panel"><header><h3>${title}</h3>${note ? html`<span class="note">${note}</span>` : null}<span class="grow"></span>${actions}</header><div class="body flush">${children}</div></section>`;
/** The owner column every accounting table carries, at every scope. */
const OWNER = (name) => ({ label: 'Owner', render: (r) => name(r) });
/** Shown only where more than one owner is in scope. */
function OwnerFilter({ units, value, onChange, label = 'Rows owned by' }) {
  const options = [{ value: '', label: 'All owners' }, ...units.map((u) => ({ value: u.id, label: unitLabel(u) }))];
  return html`<div class="row" style="gap:6px"><span class="note">${label}</span>${options.length <= 6 ? html`<${Seg} value=${value} onChange=${onChange} options=${options} />` : html`<div style="width:220px"><${Select} value=${value} onChange=${onChange} options=${options} /></div>`}</div>`;
}
// What makes a net asset value provisional, from the `affected` list the server returns with it.
const AFFECT = { unpriced: 'has no price', 'stale-price': 'is on a stale mark', 'fx-missing': 'has no conversion rate', 'fx-stale': 'is on a stale conversion rate' };
const affectedBrief = (list, max = 2) => { const all = [...new Set(list.map((a) => `${a.instrument ? instName(a.instrument) : a.ccy} ${AFFECT[a.kind] || a.kind}`))]; return `${all.slice(0, max).join(', ')}${all.length > max ? `, and ${all.length - max} more` : ''}`; };
const affectedWhy = (nav) => (nav?.affected || []).map((a) => a.detail).join('\n') || 'A price or conversion rate behind this figure is missing or not current.';

// ---- header strip ---------------------------------------------------------------------------------------
function ScopeStrip({ book, units, d }) {
  const rc = book.reportingCcy;
  const nav = d.positions.nav, un = d.pnl.unrealized;
  const left = nav.affected.filter((a) => a.kind === 'unpriced' || a.kind === 'fx-missing');
  const by = new Map();
  for (const c of d.positions.cash) {
    const r = by.get(c.ccy) || { ccy: c.ccy, settled: 0, unsettled: 0, reserved: 0, restricted: 0, margin: 0 };
    for (const k of ['settled', 'unsettled', 'reserved', 'restricted', 'margin']) r[k] += c[k];
    by.set(c.ccy, r);
  }
  const cash = [...by.values()].sort((a, b) => (a.ccy === rc ? -1 : b.ccy === rc ? 1 : a.ccy < b.ccy ? -1 : 1));
  const cell = (r, k) => (r[k] ? fmtMoney(r[k], r.ccy, { bare: true }) : html`<span class="muted">0</span>`);
  const why = 'max-width:250px;white-space:normal';
  return html`<section class="panel" style="margin-bottom:12px"><div class="body" style="display:flex;gap:8px 20px;flex-wrap:wrap;align-items:flex-start;padding:8px 12px">
    <div class="stats">
      <div class="stat"><span class="k">Net asset value, ${rc}</span><span class="v"><${NavValue} nav=${nav} /></span>
        <span class="s" style=${why}>${nav.provisional ? `Provisional: ${affectedBrief(nav.affected)}` : 'Every position priced, every currency converted at a current rate'}</span></div>
      <div class="stat"><span class="k">Unrealized P&L, ${rc}</span><span class="v"><${Money} value=${un.current} ccy=${rc} signed bare />${un.complete ? null : html` <${Provisional} why=${affectedWhy({ affected: left })} />`}</span>
        <span class="s" style=${why}>${un.complete ? 'On open positions' : `Provisional: leaves out ${[...new Set(left.map((a) => (a.instrument ? instName(a.instrument) : `${a.ccy} positions`)))].join(', ') || 'a position without a price'}`}</span></div>
      <div class="stat"><span class="k">Open positions</span><span class="v">${d.positions.positions.length}</span><span class="s">${units.length > 1 ? `across ${plural(units.length, 'owner')}` : ''}</span></div>
    </div>
    <div style="flex:1;min-width:540px;overflow:auto">${cash.length ? html`<table class="ledger"><thead><tr><th title=${`Cash of ${listNames(units.map(unitLabel))}, by currency`}>Cash${units.length > 1 ? `, ${units.length} owners` : `, ${unitLabel(units[0])}`}</th><th class="r">Settled</th><th class="r" title="Receivable for unsettled sales less payable for unsettled purchases">Unsettled</th><th class="r" title="Held against working orders, short options and short positions">Reserved</th><th class="r" title="Short-sale proceeds and borrow collateral. Not buying power.">Restricted</th><th class="r" title="Margin and collateral posted">Margin</th></tr></thead>
      <tbody>${cash.map((r) => html`<tr><td class="strong">${r.ccy}</td><td class="r">${fmtMoney(r.settled, r.ccy, { bare: true })}</td><td class="r">${cell(r, 'unsettled')}</td><td class="r">${cell(r, 'reserved')}</td><td class="r">${cell(r, 'restricted')}</td><td class="r">${cell(r, 'margin')}</td></tr>`)}</tbody></table>`
      : html`<p class="note" style="margin:8px 0">No cash is held here yet. Capital is deposited into Treasury and Accounts are funded from it, under Treasury.</p>`}</div>
  </div></section>`;
}

// ---- 1. P&L -----------------------------------------------------------------------------------------------
function PnlTab({ book, scope, units, whole, multi, scopeName, owner, setOwner, setScope }) {
  const rc = book.reportingCcy;
  const [range, setRange] = useState({ from: '', to: '' });
  const badRange = range.from && range.to && range.from > range.to;
  const res = useLive(async () => {
    const q = { from: range.from, to: range.to };
    const one = (s) => get(`/api/books/${book.id}/accounting/pnl`, { scope: s, ...q });
    const [pnl, nav, each] = await Promise.all([one(scope), get(`/api/books/${book.id}/nav-history`, { scope }), multi ? Promise.all(units.map((u) => one(u.id))) : null]);
    return { pnl, nav: nav.items, each, key: `${scope}|${range.from}|${range.to}` };
  }, [book.id, scope, range.from, range.to]);
  const d = res.data?.key === `${scope}|${range.from}|${range.to}` ? res.data : null;
  const dates = html`<div class="toolbar" style="margin:0">
    <span class="note">Period</span>
    <div style="width:150px"><${Text} type="date" value=${range.from} onInput=${(v) => setRange({ ...range, from: v })} /></div><span class="note">to</span>
    <div style="width:150px"><${Text} type="date" value=${range.to} onInput=${(v) => setRange({ ...range, to: v })} /></div>
    ${range.from || range.to ? html`<${Button} small onClick=${() => setRange({ from: '', to: '' })}>Show since inception<//>` : html`<span class="note">Since inception. Set dates to see one period.</span>`}
    <span class="grow"></span>${multi ? html`<${OwnerFilter} label="Owner columns" units=${units} value=${owner} onChange=${setOwner} />` : null}
  </div>`;
  if (!d) return html`<div class="stack">${dates}<${ErrorNote} error=${res.error} />${res.error ? null : html`<${Empty}>Loading the P&L…<//>`}</div>`;
  const p = d.pnl;
  const period = Boolean(p.period.from);
  const noStart = `No valuation snapshot exists before ${p.period.from}, so the change over the period cannot be computed. Clear the From date to see figures since inception.`;
  const badCats = p.categories.filter((c) => !c.rcComplete).map((c) => c.label);
  const whyCat = 'An FX rate was missing when some of these entries were posted, so they are left out of this total.';
  const navNow = (u) => ({ value: u.nav.end, provisional: u.nav.provisional, affected: u.nav.affected });
  const whyTotal = (u) => [!u.period.known ? noStart : null, u.categories.some((c) => !c.rcComplete) ? 'entries posted without an FX rate' : null, !u.unrealized.complete || !u.fx.complete ? affectedWhy(u.nav) : null].filter(Boolean).join('\n');
  const local = (list, signed = true) => (list?.length ? list.map((x) => html`<div><${Money} value=${x.amount} ccy=${x.ccy} signed=${signed} /></div>`) : html`<span class="muted">none</span>`);
  const pit = (x) => (period ? x.change : x.current);
  const sumTr = (u) => u.fx.byCurrency.reduce((a, b) => a + b.translation, 0);
  const flowsBy = (...accounts) => { const m = new Map(); for (const r of p.capital.byCurrency) if (accounts.includes(r.account) && r.amount) m.set(r.ccy, (m.get(r.ccy) || 0) + r.amount); return [...m].map(([ccy, amount]) => ({ ccy, amount })); };
  // The statement is a worksheet: one column per owner in scope (each owner's own statement), then the scope itself.
  const per = multi ? d.each.map((u, i) => ({ u, unit: units[i] })).filter((r) => !owner || r.unit.id === owner) : [];
  const all = [...per.map((r) => r.u), p];
  const edge = multi ? 'border-left:1px solid var(--rule);' : '';
  const cells = (f, st = '', strong = false) => all.map((u) => html`<td class=${`r ${strong && u === p ? 'strong' : ''}`} style=${`${u === p ? edge : ''}${st}`}>${f(u, u !== p)}</td>`);
  const line = (label, note, loc, f) => html`<tr><td class="wrap">${label}${note ? html`<div class="sub">${note}</div>` : null}</td>${cells(f).slice(0, -1)}<td class="r" style=${edge}>${loc}</td>${cells(f).slice(-1)}</tr>`;
  const group = (label, note) => html`<tr class="group"><td colspan=${2 + all.length}>${label}${note ? html` <span class="sub" style="font-weight:400">${note}</span>` : null}</td></tr>`;
  const top = 'border-top:1.5px solid var(--rule-strong);';
  const total = (label, loc, f) => html`<tr><td class="strong" style=${top}>${label}</td>${cells(f, top).slice(0, -1)}<td class="r" style=${`${edge}${top}`}>${loc}</td>${cells(f, top, true).slice(-1)}</tr>`;
  const money = (x, signed = true) => html`<${Money} value=${x} signed=${signed} />`;
  const pointInTime = (key) => (u, own) => html`<${Rc} stack=${own} value=${pit(u[key])} complete=${u[key].complete} why=${period && !u.period.known ? noStart : affectedWhy(u.nav)} />
    ${period && u === p ? html`<div class="sub">${p.period.startSnapshot ? `change since the ${p.period.startSnapshot} snapshot` : 'change over the period'}</div><div class="sub">now ${fmtMoney(u[key].current, rc, { sign: true })}</div>` : null}`;
  const translation = (ccy) => (u, own) => { const b = u.fx.byCurrency.find((x) => x.ccy === ccy); return b ? html`<${Rc} stack=${own} value=${b.translation} complete=${b.complete} why=${`No FX rate from ${ccy} to ${rc} for part of this balance.`} />` : html`<span class="muted">0.00</span>`; };
  const peak = Math.max(0, ...d.nav.map((n) => Math.abs(n.nav)));
  const [div, unitName] = peak >= 1e6 ? [1e6, ' millions'] : peak >= 1e4 ? [1e3, ' thousands'] : [1, ''];
  const issues = [!p.period.known ? noStart : null, badCats.length ? `Some entries in ${badCats.join(', ')} were posted without an FX rate and are left out of the ${rc} column.` : null].filter(Boolean);
  const scopeHead = multi ? (whole ? 'Whole Book' : 'Together') : unitLabel(units[0]);
  const statement = html`<${Section} title=${`Statement for ${scopeName}`} note=${`${period ? `${p.period.from} to ${p.period.to || 'today'}` : p.period.to ? `Inception to ${p.period.to}` : 'Since inception'}. Amounts in ${rc}${multi ? '. Each owner\'s column is that owner alone; choose its heading to open its statement' : ''}.`}>
    <div class="tablewrap"><table class="ledger margin"><thead><tr><th>Line</th>${per.map((r) => html`<th class="r">${link(unitLabel(r.unit), () => setScope(r.unit.id), `Open the statement of ${unitLabel(r.unit)} alone`)}</th>`)}
      <th class="r" style=${edge}>${scopeHead}, local currency</th><th class="r">${scopeHead}, ${rc}</th></tr></thead><tbody>
      ${group('Investment performance')}
      ${p.categories.map((c) => line(c.label, c.note, local(c.byCurrency), (u, own) => { const x = u.categories.find((k) => k.key === c.key); return html`<${Rc} stack=${own} value=${x.rc} complete=${x.rcComplete} why=${whyCat} />`; }))}
      ${line('Unrealized P&L', p.unrealized.complete ? 'Open positions at current prices, against cost.' : 'Provisional: a position with no price is carried at cost and left out.', html`${local(p.unrealized.currentByCurrency)}${period && p.unrealized.currentByCurrency.length ? html`<div class="sub">as of now</div>` : null}`, pointInTime('unrealized'))}
      ${line('FX effects', p.fx.complete ? p.fx.note : 'Provisional: a conversion rate is missing for at least one currency.', html`<span class="muted">not applicable</span>`, pointInTime('fx'))}
      ${!period ? p.fx.byCurrency.map((b) => line(html`<span class="muted" style="padding-left:14px">Translation of ${b.ccy} balances</span>`, null, '', translation(b.ccy))) : null}
      ${!period && p.fx.byCurrency.length && p.fx.complete ? line(html`<span class="muted" style="padding-left:14px">Dealing cost on conversions</span>`, null, '', (u) => (u.fx.complete ? money(Math.round((u.fx.current - sumTr(u)) * 100) / 100) : html`<${Missing} reason="An FX rate is missing" />`)) : null}
      ${total('Investment P&L', '', (u, own) => html`<${Rc} stack=${own} value=${u.investmentPnl} complete=${u.complete} why=${whyTotal(u)} />`)}
      ${group('Capital flows', 'money moved in or out, not performance')}
      ${line('Capital contributions', null, '', (u) => money(u.capital.contributions, false))}
      ${line('Capital withdrawals', null, '', (u) => money(-u.capital.withdrawals || 0, false))}
      ${whole && multi ? line('Transfers between Treasury and Accounts', `${fmtMoney(p.capital.internalIn, rc)} moved inside the Book. Each owner's column shows what it received less what it sent; the Book column eliminates it, so it is not counted twice.`, local(flowsBy('internal'), false), (u) => money(Math.round((u.capital.internalIn - u.capital.internalOut) * 100) / 100, false))
        : html`${line('Transfers in', multi ? 'Funding received from the rest of the Book, and transfers between the owners shown, which cancel in the net.' : 'Funding received from Treasury or another Account.', '', (u) => money(u.capital.internalIn, false))}${line('Transfers out', null, '', (u) => money(-u.capital.internalOut || 0, false))}`}
      ${total('Net capital flows', local(flowsBy('capital', 'internal'), false), (u, own) => html`<${Rc} stack=${own} value=${u.capital.net} complete=${u.capital.complete} why="A flow was posted without an FX rate and is left out of this total." signed=${false} />`)}
      ${group('Net asset value')}
      ${line(period ? `At the start (${p.period.startSnapshot ? `snapshot of ${p.period.startSnapshot}` : 'nothing held before the period'})` : 'At inception', null, '', (u) => html`<${Rc} value=${u.nav.start} why=${noStart} signed=${false} />`)}
      ${line('Start, plus net capital flows, plus investment P&L', p.period.to ? 'Flows and ledger items stop at the To date; unrealized P&L and FX are valued as of now.' : null, '', (u, own) => html`<${Rc} stack=${own} value=${u.nav.explained} complete=${u.complete} why=${whyTotal(u)} signed=${false} />`)}
      ${all.some((u) => u.nav.difference) ? line('Difference from net asset value now', all.every((u) => !u.nav.difference || u.nav.differenceIsRounding)
        ? 'Rounding only: the lines above are converted when each entry is posted, the net asset value from balances converted now.'
        : html`<span class="loss strong">Not explained by rounding.</span> The statement and the balances disagree by more than a few cents; check the full history for an entry posted without a rate.`, '', (u) => (u.nav.difference ? money(u.nav.difference) : html`<span class="muted">0.00</span>`)) : null}
      ${total('Net asset value now', '', (u, own) => (own ? html`<${Rc} stack value=${u.nav.end} complete=${!u.nav.provisional} why=${affectedWhy(u.nav)} signed=${false} />` : html`<${NavValue} nav=${navNow(u)} />`))}
    </tbody></table></div>
  <//>`;
  const side = html`${!p.marketConnected ? html`<${Awaiting} compact what="Prices and FX rates arrive with the Shaffer MarketData connection. Until then positions are valued only where a price was entered by hand, and totals that rest on a missing price or rate are marked provisional." />` : null}
    ${p.nav.provisional || issues.length ? html`<section class="panel"><header><h3>Why figures are provisional</h3></header><div class="body stack" style="gap:8px"><${NavAffected} nav=${p.nav} />
      ${p.missing.unpriced.length ? html`<p class="note" style="margin:0">Carried at cost: ${p.missing.unpriced.map((u, i) => html`${i ? ', ' : ''}<${InstLink} i=${u.instrument} /> (${fmtQty(u.qty)}, cost ${fmtMoney(u.cost, u.ccy)})`)}. Enter a price on the instrument to value ${p.missing.unpriced.length > 1 ? 'them' : 'it'}.</p>` : null}
      ${issues.map((x) => html`<${Notice} tone="warn">${x}<//>`)}
      <p class="note" style="margin:0">A figure marked provisional is not final: it changes when the missing price or rate arrives.</p></div></section>` : null}
    <section class="panel"><header><h3>Net asset value history</h3><span class="note">${rc}${unitName}, end-of-day snapshots</span></header><div class="body">
      ${d.nav.length > 1 ? html`<${LineChart} bars=${d.nav.map((n) => ({ date: n.date, close: n.nav / div }))} height=${170} />
        <p class="note" style="margin:6px 0 0">${fmtMoney(d.nav[0].nav, rc)} on ${d.nav[0].date}, ${fmtMoney(d.nav[d.nav.length - 1].nav, rc)} on ${d.nav[d.nav.length - 1].date}. ${plural(d.nav.length, 'snapshot')}. ${d.nav.some((n) => !n.complete) ? `${plural(d.nav.filter((n) => !n.complete).length, 'day')} had a missing price or FX rate and may understate or overstate the value.` : 'Every snapshot was fully priced.'} Capital flows move this line; they are not performance.</p>`
        : html`<p class="note" style="margin:0">${d.nav.length ? `One snapshot so far (${d.nav[0].date}). A line appears after the next end of day.` : 'No end-of-day snapshot yet. The first is taken at the close of the business day.'}</p>`}
    </div></section>`;
  return html`<div class="stack">${dates}
    ${badRange ? html`<${Notice} tone="err">The From date is after the To date. Swap them or clear one.<//>` : null}
    ${multi ? html`${statement}<div class="cols-2" style="align-items:start">${side}</div>` : html`<div class="split" style="grid-template-columns:minmax(0,1.5fr) minmax(320px,1fr)"><div class="stack">${statement}</div><div class="stack">${side}</div></div>`}
  </div>`;
}

// ---- 2. Balance sheet --------------------------------------------------------------------------------------
// A consolidation worksheet: one column per Treasury or Account in scope, eliminations for the whole
// Book, then the total. Amounts are in the reporting currency; local-currency amounts are a hover or
// an expanded row away. Below it, the borrowing register and, for Treasury, what it oversees.
const foreign = (c, rc) => Boolean(c) && (c.byCurrency.length > 1 || c.byCurrency.some((x) => x.ccy !== rc));
const fxText = (r) => fmtNum(r, r < 0.1 ? 6 : 4);
function Cell({ c, rc, rates }) {
  if (!c) return '';
  const local = c.byCurrency.map((x) => { const r = rates.get(x.ccy); return x.ccy === rc ? fmtMoney(x.amount, x.ccy) : `${fmtMoney(x.amount, x.ccy)}${isNum(r) ? ` at ${fxText(r)} = ${fmtMoney(x.amount * r, rc)}` : `, no FX rate to ${rc}`}`; }).join('\n');
  if (!c.complete) {
    const lacking = c.byCurrency.filter((x) => x.ccy !== rc && !isNum(rates.get(x.ccy))).map((x) => x.ccy);
    return html`<${Pill} tone="warn" title=${`No conversion rate to ${rc}, so this cell has no total.\n${local}`}>FX rate missing${lacking.length ? `: ${lacking.join(', ')}` : ''}<//>
      <div class="sub">${c.byCurrency.map((x) => html`<div>${fmtMoney(x.amount, x.ccy)}</div>`)}${c.byCurrency.length ? '' : `${fmtMoney(c.rc, rc)} so far, not final`}</div>`;
  }
  if (!c.byCurrency.length && !c.rc) return html`<span class="muted">0</span>`;
  const amount = fmtMoney(c.rc, rc, { bare: true });
  return foreign(c, rc) ? html`<span title=${`In local currency:\n${local}`} style="border-bottom:1px dotted var(--muted);cursor:help">${amount}</span>` : amount;
}
function Borrowings({ items, rc, empty }) {
  const box = (w, x) => html`<div style=${`white-space:normal;max-width:${w}px`}>${x}</div>`;
  const next = (n) => (n ? html`next ${n.date}, ${words(n.type).replace(/^(loan|repo|secloan) /, '')}${n.blocked ? html` <span class="loss">blocked: ${n.blocked}</span>` : ''}` : 'no payment scheduled');
  const amt = (label, x, ccy) => html`<div><span class="sub">${label}</span> ${fmtMoney(x, ccy)}</div>`;
  return html`<${Table} cls="tight" rows=${items} rowKey=${(b) => b.id} columns=${[
    { label: 'Record', title: 'The one ID of this borrowing, the same in every view, and the strategy instance it belongs to', render: (b) => html`<span class="strong" title=${`Contract ${b.contractId}: ${b.name}`}>${b.id}</span><div class="sub clip" style="max-width:135px">${b.strategy ? html`in <${StratLink} s=${b.strategy} />` : 'no strategy instance'}</div>` },
    { label: 'Owner and origin', render: (b) => html`<div class="strong">${b.owner.name}</div><${Pill} tone=${b.accountOriginated ? 'pen' : ''} title=${b.accountOriginated ? 'Borrowed directly by this Account. It is the Account\'s liability, not Treasury\'s.' : 'Borrowed by Treasury itself. It is Treasury\'s direct liability.'}>${b.accountOriginated ? 'Account-originated' : 'Treasury\'s own'}<//>` },
    { label: 'Type and lender', render: (b) => box(135, html`${b.type}<div class="sub">${b.lender ? `lender ${b.lender}` : 'lender not recorded'}</div>`) },
    { label: 'Principal', align: 'r', render: (b) => (b.securities ? html`${fmtQty(b.securities.qty)} ${instName(b.securities.instrument)}<div class="sub">${isNum(b.securities.value) ? `worth ${fmtMoney(b.securities.value, b.ccy)}` : html`value <${Missing} reason="The borrowed security has no price" />`}</div>`
      : html`${fmtMoney(b.principal, b.ccy)}${b.ccy !== rc ? html`<div class="sub">${isNum(b.principalRc) ? fmtMoney(b.principalRc, rc) : html`<${Missing} reason=${`No FX rate from ${b.ccy} to ${rc}`} /> ${rc}`}</div>` : null}`) },
    { label: 'Rate and maturity', render: (b) => box(125, html`<span title=${b.rate.dayCount ? `Day count ${b.rate.dayCount}` : undefined}>${b.rate.text || html`<${Missing} reason="No rate recorded" />`}</span><div class="sub" style="white-space:nowrap" title=${b.startDate ? `Started ${b.startDate}` : undefined}>${b.maturity ? `matures ${b.maturity}` : words(b.term)}</div>`) },
    { label: 'Collateral', render: (b) => box(145, b.collateral.description) },
    { label: 'Payment schedule', render: (b) => box(140, html`${b.schedule.interest}<div class="sub">${next(b.schedule.next)}</div>`) },
    { label: 'Interest and fees', align: 'r', title: 'Interest accrued and not yet paid, then interest and fees charged since the borrowing began', render: (b) => html`${amt('accrued', b.accrued, b.ccy)}${amt('interest to date', b.interestToDate, b.ccy)}${amt('fees to date', b.feesToDate, b.ccy)}` },
  ]} empty=${{ children: empty }} />`;
}
// The worksheet grid. With many Accounts the columns outgrow the page, so the Line column is pinned on
// the left and the total on the right, the heading stays in view while the page scrolls, the Accounts
// form one column group that folds into "Accounts, combined", and filters choose which Accounts are
// drawn as columns. The combined column is the server's own figure for those Accounts together
// (`accountsCombined`: what an Accounts-only scope reports as its total); nothing is added up here.
// A filter changes what is drawn only: every Account stays inside the combined column and the total.
const BS_GROUP_FROM = 3; // from this many Accounts in scope, they form a column group with filters
const BS_COMBINE_OVER = 6; // with more Accounts than this beside Treasury, the group starts combined
const BS_COMBINED = { id: 'accounts-combined', kind: 'combined', name: 'Accounts, combined' };
/** The column choice is kept for the session, per Book: an Account id means nothing in another Book. */
function bsLoad(bookId) {
  let v = {};
  try { v = JSON.parse(sessionStorage.getItem(`sdt.balance.${bookId}`) || '{}') || {}; } catch { /* nothing kept */ }
  return { combined: typeof v.combined === 'boolean' ? v.combined : null, q: typeof v.q === 'string' ? v.q : '', off: Array.isArray(v.off) ? v.off.map(String) : [], on: typeof v.on === 'string' ? v.on : '', borrow: v.borrow === true, hideZero: v.hideZero === true };
}
function bsSave(bookId, v) { try { sessionStorage.setItem(`sdt.balance.${bookId}`, JSON.stringify(v)); } catch { /* no storage: the choice lasts until the page is left */ } }
const hasBalance = (c) => Boolean(c) && c.byCurrency.length > 0;
function Worksheet({ bs, book, whole, allOpen, cell, elimCell, elimCh, rates }) {
  const rc = book.reportingCcy;
  const [view, setView] = useState(() => bsLoad(book.id));
  const [open, setOpen] = useState({});
  const [choosing, setChoosing] = useState(false);
  const [scrolls, setScrolls] = useState('');
  const headRef = useRef(null), bodyRef = useRef(null);
  const set = (patch) => { const next = { ...view, ...patch }; bsSave(book.id, next); setView(next); };
  // The heading is its own table so it can stay at the top of the page; it follows the body sideways.
  useEffect(() => {
    const h = headRef.current, b = bodyRef.current;
    if (!h || !b) return undefined;
    const follow = (from, to) => () => { if (Math.abs(to.scrollLeft - from.scrollLeft) > 0.5) to.scrollLeft = from.scrollLeft; };
    // Which sides have columns out of view, so the pinned columns can show that more lies under them.
    const mark = () => setScrolls(b.scrollWidth > b.clientWidth + 1 ? ` scrolls${b.scrollLeft > 1 ? ' more-left' : ''}${b.scrollLeft + b.clientWidth < b.scrollWidth - 1 ? ' more-right' : ''}` : '');
    const toHead = follow(b, h), onHead = follow(h, b);
    const onBody = () => { toHead(); mark(); };
    const measure = () => { mark(); toHead(); };
    b.addEventListener('scroll', onBody, { passive: true });
    h.addEventListener('scroll', onHead, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro) { ro.observe(b); if (b.firstElementChild) ro.observe(b.firstElementChild); }
    measure();
    return () => { b.removeEventListener('scroll', onBody); h.removeEventListener('scroll', onHead); if (ro) ro.disconnect(); };
  }, []);

  const cols = bs.columns, elim = bs.consolidated, showTotal = cols.length > 1;
  const g = bs.accountsCombined || null;
  const treasury = cols.find((c) => c.kind === 'treasury') || null;
  const accts = cols.filter((c) => c.kind === 'account');
  const grouped = Boolean(g) && accts.length >= BS_GROUP_FROM;
  const combined = grouped && (view.combined ?? (Boolean(treasury) && accts.length > BS_COMBINE_OVER));
  const showComb = grouped && Boolean(treasury); // without Treasury in scope the total already is the Accounts together
  const totalName = whole ? 'Whole Book' : 'Total';
  // Column filters. They apply to the Account columns only, and only to what is drawn.
  const q = view.q.trim().toLowerCase();
  const off = new Set(view.off);
  const offN = accts.filter((c) => off.has(c.id)).length;
  const onCells = view.on === 'assets' ? bs.assets.cells : view.on === 'liabilities' ? bs.liabilities.cells : bs.lines.find((l) => l.key === view.on)?.cells || null;
  const on = onCells ? view.on : '';
  const borrowers = new Set(bs.borrowings.map((b) => b.owner.id));
  const match = (c) => (!q || c.name.toLowerCase().includes(q)) && !off.has(c.id) && (!onCells || hasBalance(onCells[c.id])) && (!view.borrow || borrowers.has(c.id));
  const shown = !grouped ? accts : combined ? [] : accts.filter(match);
  const hiddenN = grouped && !combined ? accts.length - shown.length : 0;
  const dataCols = [treasury, ...shown, showComb ? BS_COMBINED : null].filter(Boolean);
  const at = (r, c) => (c.kind === 'combined' ? r.comb : r.cells[c.id]);
  // A rule on the left of the Accounts group and of the eliminations, once the columns are grouped.
  const groupStart = grouped ? dataCols.find((c) => c.kind !== 'treasury') : null;
  const colCls = (c) => `${c.kind === 'combined' ? ' bs-comb' : ''}${c === groupStart ? ' bs-edge' : ''}`;
  const elimCls = grouped ? ' bs-edge' : '';
  const span = 1 + dataCols.length + (elim ? 1 : 0) + (showTotal ? 1 : 0);
  // Lines with no balance for the owners drawn (Treasury and the Account columns shown, or the Accounts together when combined).
  const ownerCells = (r) => [treasury ? r.cells[treasury.id] : null, ...(combined ? [showComb ? r.comb : r.total] : shown.map((c) => r.cells[c.id]))];
  const hiddenLines = grouped && view.hideZero ? bs.lines.filter((l) => !ownerCells({ ...l, comb: g.lines[l.key] }).some(hasBalance)) : [];
  // Column widths, in digit widths, from the longest text a column can show (local-currency amounts
  // included), so no amount is clipped and the heading table and the body table agree exactly.
  const len = (c) => (!c ? 0 : Math.max(fmtMoney(c.rc, rc, { bare: true }).length, ...c.byCurrency.map((x) => fmtMoney(x.amount, x.ccy, { bare: true }).length),
    c.complete ? 0 : Math.max(Math.ceil(0.75 * (17 + 5 * c.byCurrency.length)) + 2, ...c.byCurrency.map((x) => fmtMoney(x.amount, x.ccy).length)))); // a cell with no rate shows a pill and its local amounts
  const everyRow = [...bs.lines, bs.assets, bs.liabilities, bs.netAssets, ...bs.representedBy];
  const headCh = (name, wraps) => Math.ceil(0.85 * (wraps ? Math.max(...name.split(/\s+/).map((w) => w.length)) : name.length));
  const unitCh = (c) => Math.max(9, headCh(c.name, grouped && c.kind !== 'treasury'), ...everyRow.map((r) => len(r.cells[c.id])));
  const acctCh = grouped ? Math.max(...accts.map(unitCh)) : 0; // one width for every Account column of a group
  const combCh = showComb ? Math.max(9, ...[...Object.values(g.lines), g.assets, g.liabilities, g.netAssets, ...Object.values(g.representedBy)].map(len)) + 1 : 0;
  const chOf = (c) => (c.kind === 'combined' ? combCh : grouped && c.kind === 'account' ? acctCh : unitCh(c));
  const totalCh = Math.max(headCh(totalName), ...everyRow.map((r) => len(r.total))) + 1;
  const widths = [...dataCols.map(chOf), ...(elim ? [Math.max(12, Math.ceil(0.9 * elimCh))] : []), ...(showTotal ? [totalCh] : [])]; // the elimination note is in smaller type
  const tableStyle = `min-width:calc(var(--bs-label) + ${widths.reduce((a, b) => a + b, 0)}ch + ${widths.length} * var(--bs-gut))`;
  const colgroup = () => html`<colgroup><col />${widths.map((w) => html`<col style=${`width:calc(${w}ch + var(--bs-gut))`} />`)}</colgroup>`;

  const row = (r, { strong = false, elimination = '' } = {}) => {
    const drawn = [...dataCols.map((c) => at(r, c)), r.total];
    const fx = drawn.some((c) => foreign(c, rc)), shownFx = fx && (allOpen || open[r.key]);
    const ccys = [...new Set(drawn.flatMap((c) => c.byCurrency.map((x) => x.ccy)))].sort((a, b) => (a === rc ? -1 : b === rc ? 1 : a < b ? -1 : 1));
    const loc = (c, ccy) => { const x = c?.byCurrency.find((y) => y.ccy === ccy); return x ? fmtMoney(x.amount, ccy, { bare: true }) : ''; }; // the row is labelled with its currency
    const rule = strong ? ' bs-rule' : '';
    return html`<tr><td class=${`wrap bs-l${strong ? ' strong' : ''}${rule}`} title=${r.note || undefined}>${r.label}${fx && !allOpen ? html` <span class="sub" style="font-weight:400">${link(shownFx ? 'hide currencies' : 'show currencies', () => setOpen((o) => ({ ...o, [r.key]: !o[r.key] })), 'The local-currency amounts behind this line')}</span>` : null}${r.note ? html`<div class="sub bs-note" style="font-weight:400">${r.note}</div>` : null}</td>
      ${dataCols.map((c) => html`<td class=${`r${colCls(c)}${rule}`}>${cell(at(r, c))}</td>`)}${elim ? html`<td class=${`r${elimCls}${rule}`}>${elimination}</td>` : null}${showTotal ? html`<td class=${`r bs-r${strong ? ' strong' : ''}${rule}`}>${cell(r.total)}</td>` : null}</tr>
      ${shownFx ? ccys.map((ccy) => html`<tr><td class="wrap muted bs-l" style="padding-left:26px">in ${ccy}${ccy !== rc ? html` <span class="sub">${isNum(rates.get(ccy)) ? `at ${fxText(rates.get(ccy))} ${rc}` : `no FX rate to ${rc}`}</span>` : null}</td>${dataCols.map((c) => html`<td class=${`r muted${colCls(c)}`}>${loc(at(r, c), ccy)}</td>`)}${elim ? html`<td class=${elimCls}></td>` : null}${showTotal ? html`<td class="r muted bs-r">${loc(r.total, ccy)}</td>` : null}</tr>`) : null}`;
  };
  const group = (label, note) => html`<tr class="group"><td colspan=${span}><span class="bs-stick">${label}${note ? html` <span class="sub" style="font-weight:400">${note}</span>` : null}</span></td></tr>`;
  const section = (id) => bs.lines.filter((l) => l.section === id && !hiddenLines.includes(l)).map((l) => row({ ...l, comb: g?.lines[l.key] }));

  // Heading: one row, or two when the Accounts are a group (the group over its columns).
  const acctCols = shown.length + (showComb ? 1 : 0);
  const two = grouped && acctCols > 0;
  const rs = two ? 2 : undefined;
  const thUnit = (c, rowspan) => html`<th class="r" rowspan=${rowspan} title=${c.kind === 'treasury' ? 'Treasury\'s own balances. Balances of the Accounts are in their own columns, never here.' : `Balances of the Account ${c.name}`}>${c.name}</th>`;
  const fold = (to) => html`<button type="button" class="btn link" title=${to ? 'Draw the Accounts as one column, added together' : 'Draw one column for each Account'} onClick=${() => set({ combined: to })}>${to ? 'Combine into one column' : 'Show each Account'}</button>`;
  const heading = html`<tr><th class="bs-l" rowspan=${rs}>Line</th>${treasury ? thUnit(treasury, rs) : null}
      ${two ? html`<th class=${`bs-group${combined ? ' r' : ''}`} colspan=${acctCols}><span class="bs-stick">${hiddenN ? `${shown.length} of ${accts.length} Accounts shown` : plural(accts.length, 'Account')} ${fold(!combined)}</span></th>` : shown.map((c) => thUnit(c))}
      ${elim ? html`<th class=${`r${elimCls}`} rowspan=${rs} title="Balances inside the Book that are removed so they are not counted in the Book total">Eliminations</th>` : null}
      ${showTotal ? html`<th class="r bs-r" rowspan=${rs}>${totalName}${grouped && !two ? html`<div class="sub" style="font-weight:400">${plural(accts.length, 'Account')} together</div>` : null}</th>` : null}</tr>
    ${two ? html`<tr class="bs-sub">${shown.map((c) => thUnit(c))}${showComb ? html`<th class="r bs-comb" title=${`The ${accts.length} Accounts together: each line is the sum of their own balances. Transfers between these Accounts cancel in the funding line; funding from Treasury does not.`}>${BS_COMBINED.name}</th>` : null}</tr>` : null}`;

  // Filters and the count of what they hide.
  const filter = (patch) => set({ ...patch, combined: false });
  const filtering = Boolean(q) || offN > 0 || Boolean(on) || view.borrow;
  const inScope = (id) => accts.some((c) => c.id === id);
  const onOptions = [{ value: '', label: 'With or without balances' }, { value: 'assets', label: 'Any asset', group: 'Only with a balance under' }, { value: 'liabilities', label: 'Any liability', group: 'Only with a balance under' },
    ...bs.lines.map((l) => ({ value: l.key, label: l.label, group: l.section === 'assets' ? 'Only with a balance on the asset line' : 'Only with a balance on the liability line' }))];
  const tools = grouped ? html`<div class="bs-tools">
      <span class="note">Account columns</span>
      <${Seg} value=${combined ? 'one' : 'each'} onChange=${(v) => set({ combined: v === 'one' })} options=${[{ value: 'one', label: 'Combined', title: 'One column for the Accounts added together' }, { value: 'each', label: 'One each', title: 'One column for each Account' }]} />
      <div class="bs-find"><${Text} type="search" value=${view.q} placeholder="Find Accounts by name" onInput=${(v) => filter({ q: v })} /></div>
      <div class="bs-on"><${Select} value=${on} onChange=${(v) => filter({ on: v })} options=${onOptions} /></div>
      <span title="Accounts that owe a cash loan, a repo or borrowed securities"><${Check} checked=${view.borrow} onChange=${(v) => filter({ borrow: v })}>Only with borrowings<//></span>
      <${Button} small onClick=${() => setChoosing(!choosing)}>${choosing ? 'Close the list' : offN ? `Choose Accounts, ${accts.length - offN} of ${accts.length} ticked` : 'Choose Accounts'}<//>
    </div>
    ${choosing ? html`<div class="bs-choose"><div class="row"><span class="note">Tick the Accounts to draw as columns. An unticked Account stays in the totals.</span>
        <${Button} small disabled=${!offN} onClick=${() => filter({ off: view.off.filter((id) => !inScope(id)) })}>Tick all<//><${Button} small disabled=${offN === accts.length} onClick=${() => filter({ off: [...new Set([...view.off, ...accts.map((c) => c.id)])] })}>Untick all<//></div>
      <div class="bs-chooselist">${accts.map((c) => html`<${Check} checked=${!off.has(c.id)} onChange=${(v) => filter({ off: v ? view.off.filter((id) => id !== c.id) : [...view.off, c.id] })}>${c.name}<//>`)}</div></div>` : null}
    <div class="bs-status"><div class="grow">${combined ? (showComb ? `The ${accts.length} Accounts are drawn as one column, their own balances added together. Transfers between them cancel in it.` : `The ${accts.length} Account columns are folded away. The Total column is these Accounts together.`)
      : hiddenN ? html`Showing ${shown.length} of ${accts.length} Accounts as columns. <b>${plural(hiddenN, 'Account')} ${hiddenN === 1 ? 'is' : 'are'} hidden</b> and still counted in ${showComb ? 'the combined column and in ' : ''}the ${totalName} column.` : `Showing all ${accts.length} Accounts, one column each.`}
      ${hiddenLines.length ? html` <b>${plural(hiddenLines.length, 'line')} with no balance in the columns shown ${hiddenLines.length === 1 ? 'is' : 'are'} hidden</b>; the totals still include every line.` : null}
      ${filtering && !combined ? html` <button type="button" class="btn link" onClick=${() => set({ q: '', on: '', borrow: false, off: view.off.filter((id) => !inScope(id)) })}>Show all ${accts.length} Accounts</button>` : null}</div>
      <${Check} checked=${view.hideZero} onChange=${(v) => set({ hideZero: v })}>Hide lines with no balance in the columns shown<//></div>` : null;

  return html`<div class=${`bs${scrolls}`}>${tools}
    <div class="bs-head" ref=${headRef}><table class="ledger margin bs-grid" style=${tableStyle}>${colgroup()}<thead>${heading}</thead></table></div>
    <div class="bs-body" ref=${bodyRef} tabindex="0" role="region" aria-label="Balance sheet lines. Scrolls sideways when the columns do not fit."><table class="ledger margin bs-grid" style=${tableStyle}>${colgroup()}<tbody>
      ${group('Assets')}${section('assets')}${row({ key: 'assets', label: 'Total assets', ...bs.assets, comb: g?.assets }, { strong: true })}
      ${group('Liabilities', 'amounts owed, shown as positive numbers')}${section('liabilities')}${row({ key: 'liabilities', label: 'Total liabilities', ...bs.liabilities, comb: g?.liabilities }, { strong: true })}
      ${row({ key: 'net', label: 'Net assets', ...bs.netAssets, comb: g?.netAssets }, { strong: true })}
      ${group('Represented by')}${bs.representedBy.map((r) => row({ ...r, comb: g?.representedBy[r.key] }, r.key === 'internal' ? { elimination: elimCell } : {}))}
      ${row({ key: 'net2', label: 'Net assets, as above', ...bs.netAssets, comb: g?.netAssets }, { strong: true })}
    </tbody></table></div>
  </div>`;
}
function BalanceTab({ book, scope, whole, multi, scopeName, openBalance }) {
  const rc = book.reportingCcy;
  const res = useLive(async () => ({ ...(await get(`/api/books/${book.id}/accounting/balance`, { scope })), key: scope }), [book.id, scope]);
  const [allOpen, setAllOpen] = useState(false);
  const bs = res.data?.key === scope ? res.data : null;
  if (!bs) return html`<div class="stack"><${ErrorNote} error=${res.error} />${res.error ? null : html`<${Empty}>Loading the balance sheet…<//>`}</div>`;
  const cols = bs.columns, elim = bs.consolidated;
  const rates = new Map([[rc, 1], ...bs.fxRates.map((r) => [r.ccy, r.rate])]);
  const cellsOf = (r) => [...cols.map((c) => r.cells[c.id]), r.total];
  const internal = bs.representedBy.find((x) => x.key === 'internal');
  const anyForeign = [...bs.lines, bs.assets, bs.liabilities, bs.netAssets, ...bs.representedBy].some((r) => cellsOf(r).some((c) => foreign(c, rc)));
  const cell = (c) => html`<${Cell} c=${c} rc=${rc} rates=${rates} />`;
  // Internal funding: what was advanced and what was received, shown so the elimination can be checked.
  // The server reports both sides; the sum over the cells is the same figure, kept for an older response.
  const side = (sign) => (internal.gross ? (sign > 0 ? internal.gross.received : internal.gross.advanced) : Math.round(Object.values(internal.cells).reduce((a, c) => a + (Math.sign(c.rc) === sign ? Math.abs(c.rc) : 0), 0) * 100) / 100);
  const unbalanced = internal.residual.length > 0;
  const elimCell = elim ? html`<${Pill} tone=${unbalanced ? 'bad' : 'ok'}>${unbalanced ? 'does not cancel' : 'eliminated'}<//>
    <div class="sub">${fmtMoney(side(-1), rc, { bare: true })} advanced</div><div class="sub">${fmtMoney(side(1), rc, { bare: true })} received</div>
    ${unbalanced ? html`<div class="sub loss" style="white-space:normal">left over ${internal.residual.map((x) => fmtMoney(x.amount, x.ccy)).join(', ')}</div>` : null}` : '';
  const cash = bs.borrowings.filter((b) => !b.securities).length;
  const over = bs.oversight && (bs.oversight.accounts.length || bs.oversight.accountBorrowings.length) ? bs.oversight : null;
  return html`<div class="stack">
    <div class="toolbar" style="margin:0"><span class="note">As of ${fmtTime(bs.asOf)}. Amounts in ${rc}${bs.fxRates.map((r) => (isNum(r.rate) ? `; 1 ${r.ccy} = ${fxText(r.rate)} ${rc}` : html`; <span class="loss">no rate for ${r.ccy}</span>`))}.${anyForeign ? ' Hover an underlined amount for its currencies.' : ''}</span>
      <span class="grow"></span>${anyForeign ? html`<${Check} checked=${allOpen} onChange=${setAllOpen}>Show local-currency amounts<//>` : null}</div>
    ${unbalanced ? html`<${Notice} tone="err"><b>Internal funding does not cancel.</b> ${internal.residual.map((x) => fmtMoney(x.amount, x.ccy)).join(', ')} is left over between Treasury and the Accounts, which should net to zero inside the Book. Find the transfer recorded on one side only under Full history, filtered to transfer events, and reverse it.<//>` : null}
    <${NavAffected} nav=${bs.nav} />
    <div class="bs-fit"><${Section} title=${`Balance sheet of ${scopeName}`} note=${elim ? 'Consolidation worksheet: each owner\'s own balances, the eliminations, and the Book total.' : multi ? 'Each owner\'s own balances, and their total.' : 'Its own balances only.'}
      actions=${html`<span class="nowrap" style="white-space:nowrap"><span class="note">Net assets</span> <${NavValue} nav=${bs.nav} ccy=${rc} cls="strong" /></span>`}>
      ${!bs.lines.length ? html`<${Empty} title="Nothing on this balance sheet yet">Deposit capital into Treasury, then fund the Accounts. Cash, positions and borrowings appear here as they are recorded.<//>`
        : html`<${Worksheet} bs=${bs} book=${book} whole=${whole} allOpen=${allOpen} cell=${cell} elimCell=${elimCell} elimCh=${Math.max(...[-1, 1].map((s) => `${fmtMoney(side(s), rc, { bare: true })} advanced`.length))} rates=${rates} />`}
    <//></div>
    ${elim ? html`<${Notice}><b>What consolidation did.</b> Internal funding between Treasury and the Accounts (${fmtMoney(side(-1), rc)} advanced, ${fmtMoney(side(1), rc)} received) is eliminated, so it is not in the Book total. External borrowing is counted once: ${cash ? `each of the ${plural(cash, 'cash borrowing')} below sits in the column of the Treasury or Account that owes it, and Treasury's column does not include an Account's borrowing` : 'no cash is borrowed at present'}. Interest and fees on a borrowing are charged once, to its owner.<//>` : null}
    <${Section} title="Borrowings" note=${`Each row is one record, however many views show it. Its ID is the same on its owner's balance sheet, in Treasury's oversight and in the Book total, where it is counted once.`}>
      <${Borrowings} items=${bs.borrowings} rc=${rc} empty=${over ? 'Treasury has no borrowing of its own. Borrowings originated by Accounts are listed under oversight below; they are not Treasury\'s liabilities.' : `Nothing is borrowed by ${scopeName}. A loan, repo or securities borrow appears here once its financing leg fills.`} />
    <//>
    ${over ? html`<h2 style="margin:10px 0 0">Accounts under Treasury oversight</h2>
      <${Notice} tone="warn"><b>Not part of Treasury's own balances.</b> ${over.note}<//>
      <${Section} title="Accounts" note="Each Account's own figures. Choose a row to open its balance sheet.">
        <${Table} rows=${over.accounts} rowKey=${(a) => a.id} onRowClick=${(a) => openBalance(a.id)} columns=${[
          { label: 'Account', render: (a) => html`<span class="strong">${a.name}</span>` },
          { label: `Net asset value, ${rc}`, align: 'r', render: (a) => html`<${NavValue} nav=${a.nav} />` },
          { label: `Funding received from Treasury, ${rc}`, align: 'r', title: 'Net internal funding the Account holds. It is the other side of the funding line on Treasury\'s balance sheet.', render: (a) => cell(a.fundingReceived) },
          { label: `Cash borrowed by the Account, ${rc}`, align: 'r', title: 'External borrowing the Account originated. It is the Account\'s liability.', render: (a) => cell(a.cashBorrowed) },
        ]} empty=${{ children: 'This Book has no Accounts yet. Add one under Treasury.' }} /><//>
      <${Section} title="Account-originated borrowings" note="The Accounts' own records, with the same IDs as on each Account's balance sheet. Listed here for oversight; none is added to Treasury's liabilities.">
        <${Borrowings} items=${over.accountBorrowings} rc=${rc} empty="No Account has borrowed directly." /><//>` : null}
  </div>`;
}

// ---- 3. Open positions ------------------------------------------------------------------------------------
function valueCell(p) {
  const sub = (t) => html`<div class="sub">${t}</div>`;
  if (NOTIONAL_FAMILIES.includes(p.family)) return html`<div title="A contract on a notional amount. The notional is not paid or owned.">${isNum(p.notional) ? html`${fmtMoney(p.notional, p.ccy)}` : html`<${Missing} reason=${p.missingReason || 'Needs a price'} />`}</div>${sub('notional')}${p.marginPosted ? sub(`margin ${fmtMoney(p.marginPosted, p.ccy)}`) : null}`;
  if (p.ledgerCarried) return html`<div>${fmtMoney(isNum(p.carrying) ? p.carrying : p.notional, p.ccy)}</div>${sub(p.family === 'secloan' ? 'value of the securities' : 'principal outstanding')}`;
  return html`<${Money} value=${p.mv} ccy=${p.ccy} reason=${p.missingReason} />${['option', 'otcoption'].includes(p.family) && isNum(p.notional) ? sub(`notional ${fmtMoney(p.notional, p.ccy)}`) : null}`;
}
function holdCell(p) {
  const c = p.collateral, out = [];
  if (p.accrued) out.push(html`accrued <${Money} value=${p.accrued} ccy=${p.ccy} signed />`);
  if (c.restrictedCash) out.push(`restricted cash ${fmtMoney(c.restrictedCash, p.ccy)}`);
  if (c.marginPosted && !NOTIONAL_FAMILIES.includes(p.family)) out.push(`margin posted ${fmtMoney(c.marginPosted, p.ccy)}`);
  if (c.pledgedQty) out.push(`pledged ${fmtQty(c.pledgedQty)}`);
  if (c.onLoanQty) out.push(`on loan ${fmtQty(c.onLoanQty)}`);
  if (c.received) out.push(`cash collateral received ${fmtMoney(c.received, p.ccy)}`);
  if (c.held) out.push(`collateral held ${fmtQty(c.held.qty)}`);
  if (p.borrowing) out.push(`borrowed ${fmtQty(p.borrowing.securitiesBorrowed)}${isNum(p.borrowing.feeRate) ? ` at ${fmtNum(p.borrowing.feeRate * 100, 3)}% a year` : ''}`);
  if (p.borrowing?.uncovered) out.push(html`<span class="loss strong">${fmtQty(p.borrowing.uncovered)} short with no borrow</span>`);
  if (p.recall) out.push(html`<span class="loss">recalled ${fmtQty(p.recall.qty)}, due ${p.recall.dueDate}</span>`);
  return out.length ? html`<div style="white-space:normal;min-width:125px;max-width:150px">${out.map((x) => html`<div class="sub">${x}</div>`)}</div>` : '';
}
// A hedge request still open for the position's strategy instance stays visible on the row.
// The pill says the request's one state; for a recommendation it also shows where it came from, when it was
// received, its version and whether it is still current, so the row never claims more than is available.
const HEDGE = {
  incomplete: ['warn', 'hedge request incomplete'], awaiting_connection: ['', 'hedge request awaiting connection'], ready_for_analysis: ['pen', 'hedge request ready for analysis'],
  recommendation_ready: ['pen', 'hedge recommendation ready'], executing: ['pen', 'hedge executing'], error: ['bad', 'hedge request failed'],
};
function HedgePill({ r, onDone }) {
  const stale = r.freshness?.status === 'stale';
  const [tone, label] = stale ? ['warn', 'hedge recommendation stale'] : HEDGE[r.state] || ['', `hedge request ${words(r.state || r.status)}`];
  const s = r.source;
  return html`${link(html`<span class=${`pill ${tone}`} style="white-space:normal;max-width:190px" data-hedge-state=${r.state}>${label}</span>`, () => openHedgeRequest(r.id, { onDone }), `${r.state === 'recommendation_ready' ? `${plural(r.packages, 'package')} to review. ` : r.message ? `${r.message} ` : ''}Open hedge request ${r.id}.`)}
    ${r.state === 'incomplete' ? html`<div class="rel-line" style="max-width:190px">Needs ${r.missing.join(', ')}. Not sent.</div>` : null}
    ${s ? html`<div class="rel-line" style="max-width:190px">From ${sourceWords(s)}, received ${fmtTime(s.receivedAt)}, version ${s.version || 'not supplied'}, ${stale ? `stale: ${r.freshness.changes.join(' ')}` : 'current'}${r.freshness?.cached ? `. ${r.freshness.cachedNote}` : ''}</div>` : null}`;
}
// Relationships of a position row, from stored identifiers: its hedge request (on the position the request is for),
// what protects it or what it protects, and what a financing leg funds. A hedge counts only through an allocation.
function PositionLinks({ p, reload }) {
  const mine = p.hedgeRequest && p.purpose === 'primary' && (!p.hedgeRequest.primary?.positionId || p.hedgeRequest.primary.positionId === p.positionId);
  const w = protectionWords(p.protection);
  return html`${mine ? html`<div style="margin-top:2px"><${HedgePill} r=${p.hedgeRequest} onDone=${reload} /></div>` : null}
    ${w ? html`<div style="margin-top:2px"><span class=${`pill ${w.tone}`} style="white-space:normal;max-width:190px" data-protection=${p.protection.assessment} title=${protectionText(p.protection)}>${w.text}</span>${p.protection.protectedUnits > 0 || p.protection.assessment === 'unavailable' ? html`<div class="rel-line" style="max-width:190px">Remaining exposure ${fmtQty(p.protection.remainingUnits)} of ${fmtQty(p.protection.exposureUnits)} units</div>` : null}</div>` : null}
    ${(p.relationships || []).map((r) => html`<div class="rel-line" style="max-width:190px" data-relation=${r.kind}>${r.text}</div>`)}`;
}
// Pricing coverage (is there a price now?) and lifecycle support (what the paper engine simulates) are separate facts.
const LIFECYCLE = { full: ['ok', 'full'], partial: ['warn', 'partly manual'], manual: ['warn', 'manual inputs'], planned: ['', 'not yet'] };
function coverageCell(p) {
  const o = p.priceObs, stale = o?.freshness === 'stale';
  const pricing = p.ledgerCarried ? html`<${Pill} title="Pricing: carried in the ledger at its contractual amount. No market price is needed.">price not needed<//>`
    : p.missing ? html`<${Pill} tone="warn" title=${`Pricing: ${p.missingReason || 'no price available'}. Carried at cost, which makes the net asset value provisional.`}>no price<//>`
      : html`<${Pill} tone=${stale ? 'warn' : 'ok'} title=${o ? `Pricing: ${o.statusLabel || o.status}, ${o.source}${o.asOf ? `, as of ${fmtTime(o.asOf, { seconds: true })}` : ''}${stale ? '. Past its freshness limit, which makes the net asset value provisional.' : ''}` : 'Pricing: valued from its contract terms'}>priced${o ? `: ${sentence(o.status).replace(/-/g, ' ')}` : ''}${stale ? ', stale' : ''}<//>`;
  const level = p.support?.level || 'manual';
  return html`<div>${pricing}</div><div style="margin-top:3px"><${Pill} tone=${LIFECYCLE[level]?.[0] || ''} title=${`Lifecycle support: ${p.support?.note || 'orders, settlement, accounting and scheduled events are simulated from the contract terms.'}`}>lifecycle: ${LIFECYCLE[level]?.[1] || level}<//></div>`;
}
function PositionsTab({ book, d, units, multi, owner, setOwner, reload }) {
  const rc = book.reportingCcy;
  const order = new Map(book.units.map((u, i) => [u.id, i]));
  const mine = (id) => !owner || id === owner;
  const sorted = d.positions.filter((p) => mine(p.owner.id)).sort((a, b) => order.get(a.owner.id) - order.get(b.owner.id) || (a.strategy?.name || '~').localeCompare(b.strategy?.name || '~') || (a.strategyId || '').localeCompare(b.strategyId || '') || (a.purpose === 'financing') - (b.purpose === 'financing'));
  const rows = [];
  let last = null;
  for (const p of sorted) {
    const key = `${p.owner.id}|${p.strategyId}`;
    if (key !== last) rows.push({ _group: html`${unitLabel(p.owner)}: <${StratLink} s=${p.strategy} /> ${p.strategy ? html`<span class="sub" style="font-weight:400">${sentence(p.strategy.template)}${p.strategy.investmentStrategy?.name ? html`, <${StrategyRef} s=${p.strategy.investmentStrategy} />` : ''}</span> <${StrategyStatus} status=${p.strategy.status} />` : ''}` });
    last = key;
    rows.push(p);
  }
  const cashRows = d.cash.filter((c) => mine(c.owner.id));
  const z = (x, ccy) => (x ? fmtMoney(x, ccy, { bare: true }) : html`<span class="muted">0</span>`);
  // Gross holdings: long and short stay apart, per owner and in total. A net is only ever shown beside them.
  const shown = units.filter((u) => mine(u.id));
  const holdings = d.holdings.filter((h) => h.owners.some((o) => mine(o.id)));
  const ownCell = (h, u) => { const o = h.owners.find((x) => x.id === u.id); return html`<${Holdings} h=${o ? { ...o, units: [o] } : null} />`; };
  const allCell = (h) => html`<${Holdings} h=${{ long: h.long, short: h.short, net: h.net, units: h.owners }} />`;
  return html`<div class="stack">
    ${multi ? html`<div class="toolbar" style="margin:0"><${OwnerFilter} units=${units} value=${owner} onChange=${setOwner} /></div>` : null}
    ${!d.marketConnected ? html`<${Awaiting} compact what="Positions are valued only where a price exists. Without the Shaffer MarketData connection, market value and unrealized P&L are missing unless a price was entered by hand on the instrument." />` : null}
    <${Section} title="Holdings by instrument" note="Gross quantities. A long and a short in the same instrument are separate positions; the net is shown beside them, never in their place.">
      <${Table} rows=${holdings} rowKey=${(h) => h.instrument.id} columns=${[
        { label: 'Instrument', render: (h) => html`<span class="sym"><${InstLink} i=${h.instrument} /></span>${h.instrument.symbol ? html` <span class="sub">${h.instrument.name}</span>` : null}` },
        ...(shown.length <= 4 ? shown.map((u) => ({ label: unitLabel(u), align: 'r', render: (h) => ownCell(h, u) })) : [{ label: 'By owner', render: (h) => html`<${Holdings} h=${{ ...h, units: h.owners.filter((o) => mine(o.id)) }} detail label="Owned by" />` }]),
        shown.length > 1 ? { label: multi && shown.length === units.length && units.length === book.units.length ? 'Whole Book' : 'All owners shown', align: 'r', title: 'Long, short and net across the owners in scope. Hover for each owner.', render: allCell } : null,
      ].filter(Boolean)} empty=${{ children: 'Nothing is held here. Securities, derivatives and currencies bought or sold short are listed by instrument once a paper trade fills.' }} />
    <//>
    <${Section} title="Positions" note="One row per position, grouped by owner and strategy instance. Financing legs sit with the strategy they fund.">
      <${Table} margin cls="tight" rows=${rows} rowKey=${(p) => p.positionId} columns=${[
        OWNER((p) => unitLabel(p.owner)),
        { label: 'Instrument and role', render: (p) => html`<div class="sym clip" style="max-width:190px"><${InstLink} i=${p.instrument} /></div>
          <div class="sub clip" style="max-width:190px" title=${p.instrument.name}><${Pill} tone=${p.purpose === 'hedge' ? 'pen' : p.purpose === 'financing' ? 'warn' : ''}>${PURPOSE_LABEL[p.purpose] || p.purpose}<//> ${p.instrument.symbol ? p.instrument.name : p.support?.productName || p.family}</div>
          <${PositionLinks} p=${p} reload=${reload} />` },
        { label: 'Quantity', align: 'r', render: (p) => html`${fmtQty(p.qty)}<div class=${`sub ${p.direction === 'long' ? 'gain' : p.direction === 'short' ? 'loss' : ''}`} style="white-space:normal;max-width:84px;margin-left:auto">${p.direction}</div>` },
        { label: 'Average cost', align: 'r', render: (p) => (p.ledgerCarried ? '' : html`${isNum(p.avgCost) ? fmtPrice(p.avgCost) : html`<${Missing} reason="No cost basis" />`}${p.family === 'future' ? html`<div class="sub">last settlement</div>` : p.family === 'forward' ? html`<div class="sub">dealt price</div>` : null}`) },
        { label: 'Current market price', align: 'r', title: 'Hover a price for its units and currency', render: (p) => (p.ledgerCarried ? '' : html`<span title=${`${p.priceUnits || 'price'}, ${p.ccy}`}><${Price} obs=${p.priceObs} value=${p.price} reason=${p.missingReason || 'No price available'} /></span>`) },
        { label: 'Value or notional', align: 'r', title: 'Market value. Futures, forwards and swaps show their notional and the margin posted, not a market value.', render: valueCell },
        { label: 'Unrealized P&L', align: 'r', title: `In the position's currency, with the ${rc} equivalent beneath when it differs`, render: (p) => (p.ledgerCarried ? '' : html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} />
          ${p.ccy !== rc && !p.missing ? html`<div class="sub" title=${isNum(p.fxRate) ? `Converted at ${fmtNum(p.fxRate, p.fxRate < 0.1 ? 6 : 4)} ${rc} per ${p.ccy} (${p.fxObs?.statusLabel || 'rate'}, ${p.fxObs?.source || ''}). The rate and its source are in Net assets by currency below.` : ''}><${Money} value=${p.unrealizedRc} ccy=${rc} signed reason=${`No FX rate from ${p.ccy} to ${rc}`} /></div>` : null}`) },
        { label: 'Accrued, collateral', title: 'Accrued income or cost, restricted cash, margin, pledged and on-loan quantities, collateral and securities borrowed', render: holdCell },
        { label: 'Pricing, lifecycle', title: 'Two separate facts. Pricing: whether this position has a current price, and from what kind of source. Lifecycle: how much of the instrument the paper engine simulates by itself.', render: coverageCell },
      ]} empty=${{ title: owner ? 'This owner has no open positions' : 'No open positions', children: 'Positions appear here once a paper trade fills. Trade from a market view or build a package on the Strategy page.' }} />
    <//>
    <${Section} title="Cash and financing balances" note="Restricted cash is short-sale proceeds and borrow collateral, not buying power. Borrowed cash is a liability.">
      <${Table} rows=${cashRows} columns=${[
        OWNER((c) => unitLabel(c.owner)),
        { label: 'Currency', render: (c) => html`<span class="strong">${c.ccy}</span>` },
        { label: 'Settled', align: 'r', render: (c) => fmtMoney(c.settled, c.ccy, { bare: true }) }, { label: 'Unsettled', align: 'r', title: 'Receivable less payable', render: (c) => z(c.unsettled, c.ccy) },
        { label: 'Reserved', align: 'r', render: (c) => z(c.reserved, c.ccy) }, { label: 'Restricted', align: 'r', render: (c) => z(c.restricted, c.ccy) }, { label: 'Margin', align: 'r', render: (c) => z(c.margin, c.ccy) },
        { label: 'Available to trade', align: 'r', render: (c) => fmtMoney(c.availableToTrade, c.ccy, { bare: true }) },
        { label: 'Cash borrowed', align: 'r', render: (c) => (c.borrowed ? html`<span class="loss">${fmtMoney(c.borrowed, c.ccy, { bare: true })}</span>` : z(0)) }, { label: 'Cash lent', align: 'r', render: (c) => z(c.lent, c.ccy) },
        { label: 'Accrued, net', align: 'r', title: 'Accrued income receivable less accrued expense payable', render: (c) => (c.accruedReceivable || c.accruedPayable ? fmtMoney(c.accruedReceivable - c.accruedPayable, c.ccy, { bare: true, sign: true }) : z(0)) },
        { label: `Settled, ${rc}`, align: 'r', render: (c) => html`<${Money} value=${c.settledRc} bare reason=${`No FX rate from ${c.ccy} to ${rc}`} />` },
      ]} empty=${{ title: 'No cash balances', children: 'Deposit capital into Treasury and fund the Accounts under Treasury.' }} />
    <//>
    ${!owner && d.nav.byCurrency.length ? html`<${Section} title="Net assets by currency" note=${`${multi ? 'The owners in scope together' : unitLabel(units[0])}. Local amounts and their ${rc} equivalents at the current FX rate. Each balance is counted once.`}>
      <div class="tablewrap"><table class="ledger tight"><thead><tr><th>Owner</th><th>Currency</th><th class="r">Cash, all kinds</th><th class="r">Unsettled</th><th class="r">Positions at cost</th><th class="r">Unrealized</th><th class="r">Loans</th><th class="r">Accrued</th><th class="r">Net assets</th><th class="r">FX rate to ${rc}</th><th class="r">Net assets, ${rc}</th></tr></thead>
        <tbody>${d.nav.byCurrency.map((r) => html`<tr><td title=${listNames(units.map(unitLabel))}>${multi ? `All ${units.length} owners` : unitLabel(units[0])}</td><td class="strong">${r.ccy}</td><td class="r">${z(r.cash + r.restricted + r.margin, r.ccy)}</td><td class="r">${z(r.receivable + r.payable, r.ccy)}</td><td class="r">${z(r.positionsAtCost, r.ccy)}</td>
          <td class="r">${r.unrealized ? fmtMoney(r.unrealized, r.ccy, { bare: true, sign: true }) : z(0)}</td><td class="r">${z(r.loansLent + r.loansBorrowed, r.ccy)}</td><td class="r">${z(r.accruedAsset + r.accruedLiab, r.ccy)}</td><td class="r strong">${fmtMoney(r.nav, r.ccy, { bare: true })}</td>
          <td class="r">${r.ccy === rc ? html`<span class="muted">1</span>` : isNum(r.fxRate) ? html`${fmtNum(r.fxRate, r.fxRate < 0.1 ? 6 : 4)} <${Prov} obs=${r.fxObs} />` : html`<${Missing} reason=${`No FX rate from ${r.ccy} to ${rc}`} />`}</td>
          <td class="r"><${Money} value=${r.navRc} bare reason=${`No FX rate from ${r.ccy} to ${rc}`} /></td></tr>`)}</tbody>
        <tfoot><tr><td colspan="10">Net asset value${d.nav.unpriced.length ? html` <span class="sub" style="font-weight:400">positions with no price are carried at cost</span>` : ''}</td><td class="r"><${NavValue} nav=${d.nav} /></td></tr></tfoot></table></div>
      ${d.nav.provisional ? html`<div style="padding:10px 12px"><${NavAffected} nav=${d.nav} /></div>` : null}
    <//>` : null}
  </div>`;
}

// ---- 4. Pending trades -------------------------------------------------------------------------------------
const settleDates = (list) => { const m = new Map(); for (const x of list) { const k = `${x.dueDate}|${x.ccy}`; m.set(k, { dueDate: x.dueDate, ccy: x.ccy, amount: (m.get(k)?.amount || 0) + x.amount }); } return [...m.values()]; };
const holdList = (list, lead = '') => list.filter((h) => h.amount).map((h) => html`<div>${lead}${fmtMoney(h.amount, h.ccy)} <span class="sub">${words(h.kind)}</span></div>`);
function OrderRows({ rows, partial, onChanged }) {
  const [busy, setBusy] = useState('');
  const cancel = async (o) => {
    setBusy(o.id);
    try { await post(`/api/orders/${o.id}/cancel`); toast(`Order cancelled: leg ${o.legNo} of ${o.strategy.name}.`); bump(); onChanged(); } catch (err) { toastError(err); }
    setBusy('');
  };
  return html`<${Table} margin rows=${rows} rowKey=${(o) => o.id} columns=${[
    OWNER((o) => o.owner),
    { label: 'Order', render: (o) => html`<div class="strong">${o.label}</div><div class="sub">Leg ${o.legNo} of <${StratLink} s=${o.strategy} />, ${(PURPOSE_LABEL[o.purpose] || o.purpose).toLowerCase()}</div>
      <div class="sub">${sentence(o.orderType || o.kindLabel)}${isNum(o.limitPrice) ? ` at ${fmtPrice(o.limitPrice)}` : ''}${isNum(o.stopPrice) ? `, stop ${fmtPrice(o.stopPrice)}` : ''}, ${o.tif === 'gtc' ? 'until cancelled' : o.tif === 'day' ? 'day order' : o.tif || ''}</div>` },
    { label: 'State', render: (o) => html`<${OrderStatus} status=${o.status} />` },
    partial ? { label: 'Filled', align: 'r', render: (o) => html`${fmtQty(o.filledQty)} of ${fmtQty(o.qty)}<div class="sub">average ${fmtPrice(o.avgPrice)}</div>` } : null,
    { label: 'Remaining', align: 'r', render: (o) => html`<span class="strong">${fmtQty(o.remainingQty)}</span>` },
    { label: 'Reserved', align: 'r', title: 'Cash and collateral held for this order, and holds of its strategy instance', render: (o) => (o.reserved.some((h) => h.amount) || o.strategyReserved.some((h) => h.amount) ? html`${holdList(o.reserved)}${holdList(o.strategyReserved, 'strategy: ')}` : html`<span class="muted">none</span>`) },
    { label: 'Expected settlement', render: (o) => (o.settlements.length ? html`${settleDates(o.settlements).map((s) => html`<div>${s.dueDate} <span class="sub">${fmtMoney(s.amount, s.ccy, { sign: true })}</span></div>`)}<div class="sub">for the filled part</div>` : html`<span class="muted">set when it fills</span>`) },
    { label: 'Dependency and reason', cls: 'wrap', render: (o) => html`${o.dependency ? html`<div class=${o.dependency.status === 'waiting' ? 'strong' : ''}>${o.dependency.status === 'waiting' ? `Waiting on leg ${o.dependency.legs.join(' and ')}` : `Leg ${o.dependency.legs.join(' and ')} is done`}</div>` : html`<div class="muted">No dependency</div>`}${o.statusReason ? html`<div class="sub">${o.statusReason}</div>` : null}` },
    { label: '', align: 'r', render: (o) => html`<${Button} small kind="danger" busy=${busy === o.id} onClick=${() => cancel(o)}>${partial ? 'Cancel the rest' : 'Cancel order'}<//>` },
  ].filter(Boolean)} />`;
}
function TaskAmount({ t, onChanged }) {
  const [amount, setAmount] = useState(t.data?.manualAmount ?? null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await post(`/api/tasks/${t.id}/settlement-amount`, { amount }); toast('Settlement amount saved. The option settles on the next engine cycle.'); bump(); onChanged(); } catch (err) { toastError(err); }
    setBusy(false);
  };
  return html`<div class="row" style="flex-wrap:nowrap;margin-top:4px"><div style="width:120px"><${Num} value=${amount} onInput=${setAmount} placeholder=${`total, ${t.instrument?.ccy || ''}`} /></div>
    <${Button} small busy=${busy} disabled=${!isNum(amount) || amount < 0} onClick=${save}>Save settlement amount<//></div>
    <div class="sub">Total due to the option holder. Enter 0 if it expired worthless.${isNum(t.data?.manualAmount) ? ` Saved so far: ${fmtNum(t.data.manualAmount)}.` : ''}</div>`;
}
function PendingTab({ d, units, multi, owner, setOwner, reload }) {
  const mine = (x) => !owner || x.unitId === owner;
  const open = d.openOrders.filter(mine), part = d.partiallyFilled.filter(mine), settle = d.awaitingSettlement.filter(mine), tasks = d.lifecycle.filter(mine);
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const need = (t) => (t.needs || []).map((n) => (n.kind === 'settlement-amount' ? html`<${TaskAmount} t=${t} onChanged=${reload} />`
    : n.kind === 'price' && n.subject ? html`<div class="sub">Needs the ${n.date || ''} closing price. ${link('Enter it on the instrument', () => openInstrument(n.subject, { tab: 'overview' }))}.</div>`
      : html`<div class="sub">Needs ${n.kind === 'rate' ? `the ${n.date || ''} fixing of rate ${n.subject}` : words(n.kind)}.</div>`));
  const tile = (n, label, sub, tone) => html`<div class="stat" style=${`border-left-color:var(--${tone})`}><span class="k">${label}</span><span class="v">${n}</span><span class="s">${sub}</span></div>`;
  return html`<div class="stack">
    <div class="row" style="align-items:flex-start"><div class="stats">
      ${tile(open.length, 'Open orders', 'nothing filled yet', 'pen')}${tile(part.length, 'Partly filled orders', 'the rest is still working', 'amber')}
      ${tile(settle.length, 'Executed, awaiting settlement', 'filled, cash not yet moved', 'gain')}${tile(tasks.length, 'Lifecycle items', blocked.length ? `${blocked.length} blocked on a missing input` : 'scheduled', blocked.length ? 'loss' : 'rule-strong')}
    </div><span class="spacer"></span>${multi ? html`<${OwnerFilter} units=${units} value=${owner} onChange=${setOwner} />` : null}</div>
    <${Section} title="Open orders" note="Submitted and not filled at all. Nothing has traded and no cash has moved.">
      ${open.length ? html`<${OrderRows} rows=${open} onChanged=${reload} />` : html`<${Empty}>No open orders. A limit or stop order that has not traded waits here, as does a leg waiting on another leg.<//>`}<//>
    <${Section} title="Partly filled orders" note="Part has executed and is settling; the remaining quantity is still working.">
      ${part.length ? html`<${OrderRows} rows=${part} partial onChanged=${reload} />` : html`<${Empty}>No partly filled orders.<//>`}<//>
    <${Section} title="Executed trades awaiting settlement" note="The trade is done. Cash and securities move on the settlement date.">
      <${Table} margin rows=${settle} rowKey=${(s) => s.id} columns=${[
        OWNER((s) => s.owner),
        { label: 'Instrument', render: (s) => html`<${InstLink} i=${s.instrument} />` },
        { label: 'Strategy instance', render: (s) => html`<${StratLink} s=${s.strategy} />` },
        { label: 'Cash movement', align: 'r', render: (s) => html`<span class="sub">${s.direction === 'receive' ? 'to receive' : 'to pay'}</span> <${Money} value=${s.amount} ccy=${s.ccy} signed />` },
        { label: 'Settles into', render: (s) => CASH_ACCOUNT[s.accounts[0]] || words(s.accounts[0]) },
        { label: 'Expected settlement', render: (s) => html`<span class="strong">${s.dueDate}</span>` },
        { label: 'State', render: (s) => html`<${Pill} tone=${s.status === 'pending' ? 'ok' : 'bad'}>${s.status === 'pending' ? 'awaiting settlement' : s.status}<//>${s.attempts ? html` <span class="sub">${plural(s.attempts, 'attempt')}</span>` : null}${s.error ? html`<div class="sub loss">${s.error}</div>` : null}` },
        { label: 'Executed', render: (s) => fmtTime(s.createdAt) },
      ].filter(Boolean)} empty=${{ children: 'Nothing is waiting to settle. Fills appear here between the trade and its settlement date.' }} /><//>
    <${Section} title="Lifecycle items" note="Coupons, expirations, interest, fees and maturities the engine will process. A blocked item names the input it is waiting for.">
      <${Table} rows=${tasks} rowKey=${(t) => t.id} columns=${[
        OWNER((t) => t.owner),
        { label: 'Item', render: (t) => html`<span class="strong">${t.label}</span>` },
        { label: 'Instrument and strategy instance', render: (t) => html`<${InstLink} i=${t.instrument} />${t.strategy ? html`<div class="sub">in <${StratLink} s=${t.strategy} /></div>` : null}` },
        { label: 'Due', render: (t) => t.dueDate },
        { label: 'State', render: (t) => html`<${Pill} tone=${t.status === 'blocked' ? 'bad' : ''}>${t.status === 'blocked' ? 'blocked' : 'scheduled'}<//>` },
        { label: 'Waiting for', cls: 'wrap', render: (t) => (t.status === 'blocked' ? html`<div>${t.reason}</div>${need(t)}` : html`<span class="muted">Its due date</span>`) },
      ].filter(Boolean)} empty=${{ children: 'No lifecycle items are scheduled for the positions held here.' }} /><//>
  </div>`;
}

// ---- 5. Failed and cancelled -------------------------------------------------------------------------------
function FailedTab({ d, units, multi, owner, setOwner }) {
  const [kind, setKind] = useState('');
  const mine = (x) => !owner || x.unitId === owner;
  const all = d.orders.filter(mine);
  const orders = all.filter((o) => !kind || o.status === kind);
  const count = (s) => all.filter((o) => o.status === s).length;
  const fails = d.settlementFailures.filter(mine), tasks = d.lifecycleFailures.filter(mine);
  const col = (...c) => c.filter(Boolean);
  return html`<div class="stack">
    <div class="toolbar" style="margin:0"><${Seg} value=${kind} onChange=${setKind} options=${[{ value: '', label: `All (${all.length})` }, { value: 'rejected', label: `Rejected (${count('rejected')})` }, { value: 'cancelled', label: `Cancelled (${count('cancelled')})` }, { value: 'expired', label: `Expired (${count('expired')})` }]} />
      <span class="grow"></span>${multi ? html`<${OwnerFilter} units=${units} value=${owner} onChange=${setOwner} />` : null}</div>
    <${Section} title="Orders that did not complete" note="Each with its reason, what did execute, and what the strategy instance still holds.">
      <${Table} margin rows=${orders} rowKey=${(o) => o.id} columns=${col(
        OWNER((o) => o.owner),
        { label: 'Order', render: (o) => html`<div class="strong">${o.label}</div><div class="sub">Leg ${o.legNo} of <${StratLink} s=${o.strategy} /></div><div class="sub">${fmtTime(o.updatedAt)}</div>` },
        { label: 'Outcome and reason', cls: 'wrap', render: (o) => html`<${Pill} tone=${o.status === 'rejected' ? 'bad' : 'warn'}>${o.category.toLowerCase()}<//><div>${o.statusReason || html`<${Missing} reason="No reason was recorded" />`}</div>` },
        { label: 'What executed', render: (o) => (o.filledQty > 0 ? html`<span class="strong">${fmtQty(o.filledQty)} of ${fmtQty(o.qty)}</span><div class="sub">average ${fmtPrice(o.avgPrice)}, ${plural(o.fills.length, 'fill')}</div><div class="sub">${fmtQty(o.remainingQty)} never traded</div>` : html`<span class="muted">Nothing filled</span>`) },
        { label: 'Still held by the strategy', render: (o) => (o.remainingPositions.length ? o.remainingPositions.map((r) => html`<div>${r.instrument} <b class=${r.qty > 0 ? 'gain' : 'loss'}>${fmtQty(r.qty)}</b></div>`) : html`<span class="muted">No open position</span>`) },
        { label: 'Strategy instance', render: (o) => html`<${StrategyStatus} status=${o.strategy.status} />${o.resolved ? html`<div class="sub">this leg was dealt with</div>` : null}` },
        { label: '', align: 'r', render: (o) => html`<${Button} small kind=${o.strategy.status === 'attention' && !o.resolved ? 'primary' : ''} onClick=${() => openStrategy(o.strategy.id)}>${o.strategy.status === 'attention' && !o.resolved ? 'Retry, unwind or accept' : 'Open strategy'}<//>` },
      )} empty=${{ title: all.length ? 'None of this kind' : 'No failed or cancelled orders', children: all.length ? 'Choose another outcome above.' : 'Rejected, cancelled and expired legs are listed here with their reasons.' }} /><//>
    <${Section} title="Failed settlements" note="A settlement fails rather than overdraw cash. It is retried on each engine cycle.">
      <${Table} margin rows=${fails} rowKey=${(s) => s.id} columns=${col(
        OWNER((s) => s.owner),
        { label: 'Instrument', render: (s) => html`<${InstLink} i=${s.instrument} />` },
        { label: 'Strategy instance', render: (s) => html`<${StratLink} s=${s.strategy} />` },
        { label: 'Cash movement', align: 'r', render: (s) => html`<span class="sub">${s.direction === 'receive' ? 'to receive' : 'to pay'}</span> <${Money} value=${s.amount} ccy=${s.ccy} signed />` },
        { label: 'Was due', render: (s) => s.dueDate }, { label: 'Attempts', align: 'r', render: (s) => s.attempts },
        { label: 'Reason', cls: 'wrap', render: (s) => html`<span class="loss">${s.error || 'No reason was recorded'}</span>` },
        { label: '', align: 'r', render: (s) => (s.strategy ? html`<${Button} small onClick=${() => openStrategy(s.strategy.id)}>Open strategy<//>` : '') },
      )} empty=${{ children: 'No settlement has failed.' }} /><//>
    ${tasks.length ? html`<${Section} title="Failed lifecycle items">
      <${Table} rows=${tasks} rowKey=${(t) => t.id} columns=${col(
        OWNER((t) => t.owner), { label: 'Item', render: (t) => t.label }, { label: 'Instrument', render: (t) => html`<${InstLink} i=${t.instrument} />` },
        { label: 'Strategy instance', render: (t) => html`<${StratLink} s=${t.strategy} />` }, { label: 'Due', render: (t) => t.dueDate }, { label: 'Reason', cls: 'wrap', render: (t) => html`<span class="loss">${t.reason}</span>` },
      )} /><//>` : null}
  </div>`;
}

// ---- 6. Full history --------------------------------------------------------------------------------------------
function ReverseDialog({ e, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { const r = await post(`/api/events/${e.id}/reverse`, { note }); toast(`Reversal recorded as event #${r.eventId}. Event #${e.id} stays in the history.`); bump(); onDone(); onClose(); } catch (err) { setError(err); setBusy(false); }
  };
  return html`<${Modal} title=${`Reverse event #${e.id}`} sub="History is never edited. The original stays, and a reversing event is recorded and linked to it." onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} onClick=${go}>Record reversal<//>`}>
    <div class="stack"><${ErrorNote} error=${error} /><${Notice}>${e.summary}<//>
      <${Field} label="Why it is being reversed" hint="Kept on the reversing event."><${Text} value=${note} onInput=${setNote} autofocus placeholder="For example: sent to the wrong Account" /><//></div><//>`;
}
function AdjustmentDialog({ book, unitId, corrects, onClose, onDone }) {
  const [f, setF] = useState({ unitId: corrects?.unitId || unitId, ccy: corrects?.cash?.[0]?.ccy || book.reportingCcy, amount: null, category: 'fee', note: '', correctsEventId: corrects?.id ?? null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const unit = book.units.find((u) => u.id === f.unitId);
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await post(`/api/books/${book.id}/adjustments`, { ...f, ccy: f.ccy.toUpperCase(), correctsEventId: f.correctsEventId || undefined }); toast(`Manual adjustment recorded as event #${r.eventId}.`); bump(); onDone(); onClose(); } catch (err) { setError(err); setBusy(false); }
  };
  return html`<${Modal} size="mid" title="Record a manual adjustment" sub="A cash entry against a named category. It is added to the history as its own event; nothing already recorded is changed." onClose=${onClose}
    footer=${html`<span class="note">Positive amounts are cash received, negative amounts are cash paid.</span><span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" busy=${busy} disabled=${!isNum(f.amount) || !f.amount || !f.note.trim()} onClick=${save}>Record adjustment<//>`}>
    <div class="stack"><${ErrorNote} error=${error} />
      <div class="grid-form">
        <${Field} label="Owner"><${Select} value=${f.unitId} onChange=${(v) => setF({ ...f, unitId: v })} options=${book.units.map((u) => ({ value: u.id, label: unitLabel(u) }))} /><//>
        <${Field} label="Category" span=${2} hint=${f.category === 'capital' && unit?.kind !== 'treasury' ? 'External capital is recorded in Treasury. Choose Treasury as the owner.' : 'The P&L line the other side of the entry goes to.'}>
          <${Select} value=${f.category} onChange=${(v) => setF({ ...f, category: v })} options=${ADJ_CATEGORIES.map(([value, label]) => ({ value, label }))} /><//>
        <${Field} label="Currency"><${Text} value=${f.ccy} onInput=${(v) => setF({ ...f, ccy: v.toUpperCase() })} /><//>
        <${Field} label="Amount" hint="Negative for cash paid"><${Num} value=${f.amount} onInput=${(v) => setF({ ...f, amount: v })} /><//>
        <${Field} label="Corrects event number" hint="Optional. Links this adjustment to the event it corrects."><${Num} value=${f.correctsEventId} onInput=${(v) => setF({ ...f, correctsEventId: v })} placeholder="none" /><//>
        <${Field} label="Note (required)" span="all" hint="Say what this adjusts and why."><${Text} value=${f.note} onInput=${(v) => setF({ ...f, note: v })} /><//>
      </div></div><//>`;
}
function Entries({ e, rc, onAdjust }) {
  const refs = [e.strategyId ? html`strategy instance ${link(e.strategyId, () => openStrategy(e.strategyId))}` : null, e.instrument ? html`instrument <${InstLink} i=${e.instrument} />` : null, e.orderId ? `order ${e.orderId}` : null, e.positionId ? `position ${e.positionId}` : null].filter(Boolean);
  return html`<div class="stack" style="gap:6px">
    ${e.entries.length ? html`<table class="ledger" style="max-width:980px"><thead><tr><th>Owner</th><th>Account</th><th>Currency</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">In ${rc}</th><th class="r">FX rate used</th></tr></thead>
      <tbody>${e.entries.map((n) => html`<tr><td>${n.owner}</td><td>${n.accountLabel}</td><td>${n.ccy}</td><td class="r">${n.amount > 0 ? fmtMoney(n.amount, n.ccy, { bare: true }) : ''}</td><td class="r">${n.amount < 0 ? fmtMoney(-n.amount, n.ccy, { bare: true }) : ''}</td>
        <td class="r">${isNum(n.amountRc) ? fmtMoney(n.amountRc, rc, { bare: true, sign: true }) : html`<${Missing} reason=${`No FX rate from ${n.ccy} to ${rc} was available when this was posted`} />`}</td>
        <td class="r">${n.ccy === rc ? html`<span class="muted">reporting currency</span>` : isNum(n.fxRate) ? html`${fmtNum(n.fxRate, n.fxRate < 0.1 ? 6 : 4)}${n.fxObsId ? html` <span class="sub">observation #${n.fxObsId}</span>` : null}` : html`<${Missing} reason="No FX rate was available at posting" />`}</td></tr>`)}</tbody></table>`
      : html`<div class="note">This event moved no balances. It records a decision or a status change.</div>`}
    <div class="sub muted">${refs.length ? html`Linked to ${refs.map((x, i) => html`${i ? ', ' : ''}${x}`)}. ` : ''}Recorded by ${e.actor === 'engine' ? 'the engine' : 'you'}, business date ${e.businessDate}.</div>
    ${onAdjust && e.entries.length && !e.correctedBy.length ? html`<div class="sub">${e.reversible ? 'This event can be reversed with the Reverse button. ' : 'This kind of event cannot be reversed automatically. '}${link('Record a manual adjustment that corrects it', onAdjust)}. The event itself stays as recorded.</div>` : null}</div>`;
}
function HistoryTab({ book, scope, units, multi, owner, setOwner }) {
  const rc = book.reportingCcy;
  const [f, setF] = useState({ type: '', q: '', from: '', to: '', accruals: false });
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  useEffect(() => { const t = setTimeout(() => setF((cur) => (cur.q === typed ? cur : { ...cur, q: typed })), 300); return () => clearTimeout(t); }, [typed]);
  const key = JSON.stringify([book.id, scope, f]);
  const query = { scope, type: f.type, q: f.q, from: f.from, to: f.to, accruals: f.accruals ? '1' : undefined, limit: 100 };
  const res = useLive(async () => ({ ...(await get(`/api/books/${book.id}/accounting/history`, query)), key }), [key]);
  // Events are append-only, so pages are merged by event number and nothing loaded is dropped.
  const st = useRef({ key: '', map: new Map(), more: null });
  if (st.current.key !== key) st.current = { key, map: new Map(), more: null };
  if (res.data?.key === key) { for (const e of res.data.events) st.current.map.set(e.id, e); if (st.current.more === null) st.current.more = res.data.more; }
  const all = [...st.current.map.values()].sort((a, b) => b.id - a.id);
  const ownerName = owner ? book.units.find((u) => u.id === owner)?.name : '';
  const events = all.filter((e) => !owner || e.unitId === owner || e.entries.some((n) => n.owner === ownerName));
  const older = async () => {
    setBusy(true);
    try { const r = await get(`/api/books/${book.id}/accounting/history`, { ...query, before: all[all.length - 1].id }); for (const e of r.events) st.current.map.set(e.id, e); st.current.more = r.more; } catch (err) { toastError(err); }
    setBusy(false); force((n) => n + 1);
  };
  const show = async (id) => {
    if (!st.current.map.has(id)) {
      // Not on the pages loaded (or filtered out): fetch that one event and show it by itself.
      try {
        const r = await get(`/api/books/${book.id}/accounting/history`, { scope, before: id + 1, limit: 1, accruals: '1' });
        const e = r.events.find((x) => x.id === id);
        if (!e) { toast(`Event #${id} is outside this scope. Switch to the whole Book to see it.`, 'warn'); return; }
        openOverlay((close) => html`<${Modal} size="mid" title=${`Event #${e.id}: ${sentence(e.type)}`} sub=${`${fmtTime(e.ts, { seconds: true })}. Kept as recorded.`} onClose=${close} footer=${html`<span class="grow"></span><${Button} onClick=${close}>Close<//>`}>
          <div class="stack"><${Notice}>${e.summary}<//><${Entries} e=${e} rc=${rc} /></div><//>`);
      } catch (err) { toastError(err); }
      return;
    }
    setOpen((o) => ({ ...o, [id]: true }));
    setTimeout(() => document.getElementById(`ev-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
  };
  const types = res.data?.types || [];
  const prefixes = new Map();
  for (const t of types) { const p = t.type.split('.')[0]; prefixes.set(p, (prefixes.get(p) || 0) + 1); }
  const typeOptions = types.flatMap((t, i) => { const p = t.type.split('.')[0]; const first = i === 0 || types[i - 1].type.split('.')[0] !== p; return [first && prefixes.get(p) > 1 ? { value: p, label: `All ${words(p)} events`, group: sentence(p) } : null, { value: t.type, label: `${sentence(t.type)} (${t.n})`, group: sentence(p) }].filter(Boolean); });
  const owners = (e) => { const s = [...new Set(e.entries.map((n) => n.owner))]; return s.length ? s : [e.owner || '']; };
  const adjust = (corrects) => openOverlay((close) => html`<${AdjustmentDialog} book=${book} unitId=${units[0].id} corrects=${corrects} onClose=${close} onDone=${res.reload} />`);
  return html`<div class="stack">
    <div class="toolbar" style="margin:0">
      <div style="width:230px"><${Select} value=${f.type} onChange=${(v) => setF({ ...f, type: v })} options=${typeOptions} placeholder="All event types" /></div>
      <div style="width:220px"><${Text} type="search" value=${typed} onInput=${setTyped} placeholder="Search the event text" /></div>
      <span class="note">From</span><div style="width:140px"><${Text} type="date" value=${f.from} onInput=${(v) => setF({ ...f, from: v })} /></div>
      <span class="note">to</span><div style="width:140px"><${Text} type="date" value=${f.to} onInput=${(v) => setF({ ...f, to: v })} /></div>
      <${Check} checked=${f.accruals} onChange=${(v) => setF({ ...f, accruals: v })} disabled=${Boolean(f.type)}>Include daily accruals<//>
    </div>
    ${multi ? html`<div class="toolbar" style="margin:0"><${OwnerFilter} units=${units} value=${owner} onChange=${setOwner} /><span class="note">An event shows under every owner whose balances it moved.</span></div>` : null}
    <${ErrorNote} error=${res.error} />
    <${Section} title="Audit trail" note=${`Newest first. ${plural(events.length, 'event')} shown${res.data?.accrualsHidden ? ', daily accruals hidden' : ''}. Nothing here is ever edited or deleted.`}
      actions=${html`<${Button} small onClick=${() => adjust(null)}>Record a manual adjustment<//>`}>
      ${!res.data && !all.length ? html`<${Empty}>${res.error ? '' : 'Loading the history…'}<//>` : !events.length ? html`<${Empty} title="No events match">Clear a filter, widen the dates or include daily accruals.<//>` : html`<div class="tablewrap"><table class="ledger margin">
        <thead><tr><th>Time</th><th title="Every Treasury or Account whose balances the event moved">Owner</th><th>Event</th><th class="r">Cash effect</th><th></th></tr></thead>
        <tbody>${events.map((e) => html`<tr key=${e.id} id=${`ev-${e.id}`}>
            <td>${fmtTime(e.ts, { seconds: true })}<div class="sub">#${e.id}</div></td>
            <td>${owners(e).map((o) => html`<div>${o || html`<span class="muted" title="This event belongs to the Book and moved no balance">Book</span>`}</div>`)}</td>
            <td class="wrap"><div class="strong">${sentence(e.type)}</div>${e.summary}
              ${e.correctsEventId ? html`<div class="sub"><${Pill} tone="pen">correction<//> Corrects ${link(`event #${e.correctsEventId}`, () => show(e.correctsEventId))}, which is kept as recorded.</div>` : null}
              ${e.correctedBy.length ? html`<div class="sub"><${Pill} tone="warn">corrected<//> Corrected by ${e.correctedBy.map((id, i) => html`${i ? ', ' : ''}${link(`event #${id}`, () => show(id))}`)}. This original is kept as recorded.</div>` : null}</td>
            <td class="r">${e.cash.length ? e.cash.map((c) => html`<div><${Money} value=${c.amount} ccy=${c.ccy} signed /></div>`) : html`<span class="muted">none</span>`}</td>
            <td class="r">${e.reversible ? html`<${Button} small onClick=${() => openOverlay((close) => html`<${ReverseDialog} e=${e} onClose=${close} onDone=${res.reload} />`)}>Reverse<//> ` : null}
              <${Button} small onClick=${() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}>${open[e.id] ? 'Hide entries' : `Entries (${e.entries.length})`}<//></td>
          </tr>${open[e.id] ? html`<tr class="detail" key=${`d${e.id}`}><td colspan="5" style="background:var(--paper);padding:10px 12px 12px 26px;white-space:normal"><${Entries} e=${e} rc=${rc} onAdjust=${() => adjust(e)} /></td></tr>` : null}`)}</tbody></table></div>`}
      ${st.current.more ? html`<div class="body" style="border-top:1px solid var(--rule)"><${Button} small busy=${busy} onClick=${older}>Show older events<//> <span class="note">Showing back to event #${all[all.length - 1]?.id}.</span></div>` : null}
    <//>
  </div>`;
}

// ---- page -----------------------------------------------------------------------------------------------------------
export default function Accounting({ args, book }) {
  const tab = TABS.some(([id]) => id === args[0]) ? args[0] : 'pnl';
  const accounts = book.units.filter((u) => u.kind === 'account');
  // The scope in the address: book, treasury, one unit id, or several joined by commas. Anything
  // that is not a unit of this Book is ignored, so a scope can never reach into another Book.
  let want = [];
  try { want = decodeURIComponent(args[1] || 'book').split(','); } catch { /* malformed address: whole Book */ }
  const picked = book.units.filter((u) => want.includes(u.id) || (u.kind === 'treasury' && want.includes('treasury')));
  const whole = !picked.length || (picked.length === book.units.length && picked.length > 1);
  const units = whole ? book.units : picked;
  const scope = whole ? 'book' : units.map((u) => u.id).join(',');
  const multi = units.length > 1;
  const go = (t, s) => { location.hash = `#/accounting/${t}/${s}`; };
  const [owner, setOwner] = useState('');
  useEffect(() => { setOwner(''); }, [scope]);
  // "Selected Accounts" mode: the checked Accounts are the scope, so the address carries the choice.
  const [pick, setPick] = useState(false);
  const picking = accounts.length > 1 && (pick || (multi && !whole));
  useEffect(() => { if (whole || units.every((u) => u.kind === 'treasury')) setPick(false); }, [scope]);
  const choose = (v) => {
    if (v !== 'pick') { setPick(false); go(tab, v); return; }
    setPick(true);
    if (!units.some((u) => u.kind === 'account') || whole) go(tab, accounts.map((u) => u.id).join(','));
  };
  // The checkboxes list the Accounts; Treasury joins them only when the address already has it in the group.
  const pickList = !whole && multi && units.some((u) => u.kind === 'treasury') ? book.units : accounts;
  const toggle = (id, on) => { const ids = pickList.filter((u) => (u.id === id ? on : !whole && units.includes(u))).map((u) => u.id); if (ids.length) go(tab, ids.join(',')); };
  const base = useLive(async () => {
    const tabData = (t) => get(`/api/books/${book.id}/accounting/${t}`, { scope });
    const [pnl, positions, pending, failed] = await Promise.all([tabData('pnl'), tabData('positions'), tabData('pending'), tabData('failed')]);
    return { pnl, positions, pending, failed, scope };
  }, [book.id, scope]);
  const d = base.data?.scope === scope ? base.data : null;
  const scopes = [{ value: 'book', label: 'Whole Book' }, ...book.units.map((u) => ({ value: u.id, label: unitLabel(u) })), ...(accounts.length > 1 ? [{ value: 'pick', label: 'Selected Accounts', title: 'Choose two or more Accounts and see them together' }] : [])];
  const names = units.map(unitLabel);
  const scopeName = whole ? 'the whole Book' : !multi ? names[0] : names.length === 2 ? `${listNames(names)} together` : `${names.length} owners together`;
  const attention = d ? d.failed.orders.filter((o) => o.strategy.status === 'attention' && !o.resolved).length + d.failed.settlementFailures.length + d.failed.lifecycleFailures.length : 0;
  const tabs = TABS.map(([id, label]) => ({ id, label,
    count: !d ? undefined : id === 'positions' ? d.positions.positions.length : id === 'pending' ? d.pending.openOrders.length + d.pending.partiallyFilled.length + d.pending.awaitingSettlement.length : id === 'failed' ? d.failed.orders.length : undefined,
    alert: d && id === 'failed' && attention ? attention : d && id === 'pending' ? d.pending.lifecycle.filter((t) => t.status === 'blocked').length || undefined : undefined }));
  const shared = { book, scope, units, whole, multi, scopeName, owner: multi ? owner : '', setOwner };
  return html`<div>
    <div class="page-head"><div><h1>Accounting</h1>
      <div class="sub">${!accounts.length ? `${book.name}: Treasury only, no Accounts yet.` : whole ? `${book.name}, consolidated: Treasury and ${plural(accounts.length, 'Account')} together. Funding between them is internal and is eliminated; external borrowing, interest and fees count once.`
        : multi ? `${book.name}: ${listNames(names)} together; transfers between them cancel, funding from the rest of the Book does not.`
          : units[0].kind === 'treasury' ? `Treasury of ${book.name} alone: its own cash, funding, borrowing and collateral. The Accounts it oversees are listed apart on the Balance sheet tab.` : `The Account ${units[0].name} in ${book.name}, alone.`} Reporting currency ${book.reportingCcy}.</div></div>
      <div class="actions" style="flex-direction:column;align-items:flex-end;gap:6px">
        <div class="row" style="gap:8px"><span class="note">Scope</span>${scopes.length <= 6 ? html`<${Seg} value=${picking ? 'pick' : scope} onChange=${choose} options=${scopes} />` : html`<div style="width:240px"><${Select} value=${picking ? 'pick' : scope} onChange=${choose} options=${scopes} /></div>`}</div>
        ${picking ? html`<div class="row" style="gap:6px 14px;justify-content:flex-end"><span class="note">Shown together</span>${pickList.map((u) => { const on = !whole && units.includes(u); return html`<${Check} checked=${on} disabled=${on && units.length === 1} onChange=${(v) => toggle(u.id, v)}>${unitLabel(u)}<//>`; })}</div>` : null}
      </div></div>
    <${ErrorNote} error=${base.error} />
    ${d ? html`<${ScopeStrip} book=${book} units=${units} d=${d} />` : base.error ? null : html`<${Empty}>Loading the accounts…<//>`}
    <${Tabs} tabs=${tabs} value=${tab} onChange=${(t) => go(t, scope)} />
    ${tab === 'pnl' ? html`<${PnlTab} ...${shared} setScope=${(s) => go('pnl', s)} />` : null}
    ${tab === 'balance' ? html`<${BalanceTab} ...${shared} openBalance=${(s) => go('balance', s)} />` : null}
    ${tab === 'history' ? html`<${HistoryTab} ...${shared} />` : null}
    ${d && tab === 'positions' ? html`<${PositionsTab} ...${shared} d=${d.positions} reload=${base.reload} />` : null}
    ${d && tab === 'pending' ? html`<${PendingTab} ...${shared} d=${d.pending} reload=${base.reload} />` : null}
    ${d && tab === 'failed' ? html`<${FailedTab} ...${shared} d=${d.failed} />` : null}
  </div>`;
}
