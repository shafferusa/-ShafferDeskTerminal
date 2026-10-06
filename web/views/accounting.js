// Accounting.
//
// One page at three scopes: the whole Book consolidated (Treasury plus every Account, internal
// transfers not counted twice), Treasury only, and each Account. Five tabs: P&L, open positions,
// pending trades, failed and cancelled trades, and the full audit history. The tab and scope live
// in the address (#/accounting/<tab>/<scope>) so a view can be linked and back/forward work.
//
// Figures come from the server as computed. A total that lacks a price or an FX rate is marked
// incomplete with the reason; a value that cannot be computed is drawn as missing, never as zero.
// History is append-only: a correction is a new event that points at the one it corrects.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, toast, toastError, useLive } from '../lib/core.js';
import { Awaiting, Button, Check, Empty, ErrorNote, Field, LineChart, Missing, Modal, Money, Notice, Num, OrderStatus, Pill, Price, Prov, PURPOSE_LABEL, Seg, Select, StrategyStatus, Table, Tabs, Text } from '../lib/ui.js';
import { openInstrument } from './instrument.js';
import { openStrategy } from './strategy-detail.js';

const TABS = [['pnl', 'P&L'], ['positions', 'Open positions'], ['pending', 'Pending trades'], ['failed', 'Failed and cancelled trades'], ['history', 'Full history']];
const NOTIONAL_FAMILIES = ['future', 'forward', 'swap', 'cds'];
const ADJ_CATEGORIES = [['fee', 'Fees'], ['commission', 'Commissions'], ['realized', 'Realized P&L'], ['dividend', 'Dividends'], ['coupon', 'Coupon income'], ['interest', 'Interest income'], ['borrow', 'Securities-borrow cost'], ['funding', 'Funding expense'], ['lending', 'Securities-lending income'], ['capital', 'External capital (Treasury only)']];
const CASH_ACCOUNT = { cash: 'settled cash', 'cash.restricted': 'restricted cash', 'cash.margin': 'margin' };
const unitLabel = (u) => (u.kind === 'treasury' ? 'Treasury' : u.name);
const words = (s) => String(s || '').replace(/[._]/g, ' ');
const sentence = (s) => words(s).replace(/^\w/, (c) => c.toUpperCase());
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const instName = (i) => (i ? i.symbol || i.name : '');
const link = (label, onClick, title) => html`<a href="javascript:void 0" title=${title} onClick=${(e) => { e.stopPropagation(); onClick(); }}>${label}</a>`;
const InstLink = ({ i }) => (i ? link(instName(i), () => openInstrument(i.id), i.name) : html`<span class="muted">none</span>`);
const StratLink = ({ s }) => (s ? link(s.name, () => openStrategy(s.id), `Strategy instance ${s.id}`) : html`<span class="muted">none</span>`);
const Incomplete = ({ why }) => html`<${Pill} tone="warn" title=${why}>incomplete<//>`;
/** A reporting-currency figure: missing when unknown, flagged when it leaves something out. */
function Rc({ value, ccy, complete = true, why, signed = true }) {
  if (!isNum(value)) return html`<${Missing} reason=${why} />`;
  return html`<${Money} value=${value} ccy=${ccy} signed=${signed} />${complete ? null : html` <${Incomplete} why=${why} />`}`;
}
const Section = ({ title, note, actions, children }) => html`<section class="panel"><header><h3>${title}</h3>${note ? html`<span class="note">${note}</span>` : null}<span class="grow"></span>${actions}</header><div class="body flush">${children}</div></section>`;
function OwnerFilter({ book, value, onChange }) {
  return html`<div class="row" style="gap:6px"><span class="note">Rows owned by</span><${Seg} value=${value} onChange=${onChange} options=${[{ value: '', label: 'All owners' }, ...book.units.map((u) => ({ value: u.id, label: unitLabel(u) }))]} /></div>`;
}
const whyNav = (nav, rc) => [
  nav.unpriced.length ? `${plural(nav.unpriced.length, 'open position')} with no price, carried at cost (${nav.unpriced.map((u) => instName(u.instrument)).join(', ')})` : null,
  nav.fxMissing.length ? `no FX rate into ${rc} for ${nav.fxMissing.join(', ')}, so balances in ${nav.fxMissing.length > 1 ? 'those currencies are' : 'that currency are'} left out` : null,
].filter(Boolean).join('; ');

// ---- header strip ---------------------------------------------------------------------------------------
function ScopeStrip({ book, scope, d }) {
  const rc = book.reportingCcy;
  const o = scope === 'book' ? d.overview : d.overview.units.find((u) => u.id === scope) || {};
  const nav = d.positions.nav;
  const why = whyNav(nav, rc);
  const by = new Map();
  for (const c of d.positions.cash) {
    const r = by.get(c.ccy) || { ccy: c.ccy, settled: 0, unsettled: 0, reserved: 0, restricted: 0, margin: 0 };
    for (const k of ['settled', 'unsettled', 'reserved', 'restricted', 'margin']) r[k] += c[k];
    by.set(c.ccy, r);
  }
  const cash = [...by.values()].sort((a, b) => (a.ccy === rc ? -1 : b.ccy === rc ? 1 : a.ccy < b.ccy ? -1 : 1));
  const cell = (r, k) => (r[k] ? fmtMoney(r[k], r.ccy, { bare: true }) : html`<span class="muted">0</span>`);
  return html`<section class="panel" style="margin-bottom:12px"><div class="body" style="display:flex;gap:8px 20px;flex-wrap:wrap;align-items:flex-start;padding:8px 12px">
    <div class="stats">
      <div class="stat"><span class="k">Net asset value, ${rc}</span><span class="v"><${Money} value=${nav.value} ccy=${rc} bare /></span>
        <span class="s">${nav.complete ? 'Every position priced, every currency converted' : html`<${Incomplete} why=${why} /> ${nav.unpriced.length ? `${plural(nav.unpriced.length, 'position')} unpriced` : ''}${nav.unpriced.length && nav.fxMissing.length ? ', ' : ''}${nav.fxMissing.length ? `no FX rate for ${nav.fxMissing.join(', ')}` : ''}`}</span></div>
      <div class="stat"><span class="k">Unrealized P&L, ${rc}</span><span class="v"><${Money} value=${o.unrealized} ccy=${rc} signed bare /></span>
        <span class="s">${o.unrealizedComplete ? 'On open positions' : html`<${Incomplete} why="At least one open position has no price or no FX rate. It is carried at cost and left out of this figure." /> leaves out unpriced positions`}</span></div>
      <div class="stat"><span class="k">Open positions</span><span class="v">${d.positions.positions.length}</span><span class="s">${scope === 'book' ? `across ${plural(book.units.length, 'unit')}` : ''}</span></div>
    </div>
    <div style="flex:1;min-width:430px">${cash.length ? html`<table class="ledger"><thead><tr><th>Cash</th><th class="r">Settled</th><th class="r" title="Receivable for unsettled sales less payable for unsettled purchases">Unsettled</th><th class="r" title="Held against working orders, short options and short positions">Reserved</th><th class="r" title="Short-sale proceeds and borrow collateral. Not buying power.">Restricted</th><th class="r" title="Margin and collateral posted">Margin</th></tr></thead>
      <tbody>${cash.map((r) => html`<tr><td class="strong">${r.ccy}</td><td class="r">${fmtMoney(r.settled, r.ccy, { bare: true })}</td><td class="r">${cell(r, 'unsettled')}</td><td class="r">${cell(r, 'reserved')}</td><td class="r">${cell(r, 'restricted')}</td><td class="r">${cell(r, 'margin')}</td></tr>`)}</tbody></table>`
      : html`<p class="note" style="margin:8px 0">No cash is held here yet. Capital is deposited into Treasury and Accounts are funded from it, under Treasury.</p>`}</div>
  </div></section>`;
}

// ---- 1. P&L -----------------------------------------------------------------------------------------------
function PnlTab({ book, scope, consolidated, owner, setOwner, setScope }) {
  const rc = book.reportingCcy;
  const [range, setRange] = useState({ from: '', to: '' });
  const badRange = range.from && range.to && range.from > range.to;
  const res = useLive(async () => {
    const q = { from: range.from, to: range.to };
    const one = (s) => get(`/api/books/${book.id}/accounting/pnl`, { scope: s, ...q });
    const [pnl, nav, units] = await Promise.all([one(scope), get(`/api/books/${book.id}/nav-history`, { scope }), consolidated ? Promise.all(book.units.map((u) => one(u.id))) : null]);
    return { pnl, nav: nav.items, units, key: `${scope}|${range.from}|${range.to}` };
  }, [book.id, scope, range.from, range.to]);
  const d = res.data?.key === `${scope}|${range.from}|${range.to}` ? res.data : null;
  const dates = html`<div class="toolbar" style="margin:0">
    <span class="note">Period</span>
    <div style="width:150px"><${Text} type="date" value=${range.from} onInput=${(v) => setRange({ ...range, from: v })} /></div><span class="note">to</span>
    <div style="width:150px"><${Text} type="date" value=${range.to} onInput=${(v) => setRange({ ...range, to: v })} /></div>
    ${range.from || range.to ? html`<${Button} small onClick=${() => setRange({ from: '', to: '' })}>Show since inception<//>` : html`<span class="note">Since inception. Set dates to see one period.</span>`}
    <span class="grow"></span>${consolidated ? html`<${OwnerFilter} book=${book} value=${owner} onChange=${setOwner} />` : null}
  </div>`;
  if (!d) return html`<div class="stack">${dates}<${ErrorNote} error=${res.error} />${res.error ? null : html`<${Empty}>Loading the P&L…<//>`}</div>`;
  const p = d.pnl;
  const period = Boolean(p.period.from);
  const noStart = `No valuation snapshot exists before ${p.period.from}, so the change over the period cannot be computed. Clear the From date to see figures since inception.`;
  const badCats = p.categories.filter((c) => !c.rcComplete).map((c) => c.label);
  const whyCat = 'An FX rate was missing when some of these entries were posted, so they are left out of this total.';
  const whyTotal = [!p.period.known ? noStart : null, badCats.length ? `entries without an FX rate in ${badCats.join(', ')}` : null, !p.unrealized.complete ? 'open positions with no price' : null, !p.fx.complete ? 'a missing FX rate' : null].filter(Boolean).join('; ');
  const local = (list, signed = true) => (list?.length ? list.map((x) => html`<div><${Money} value=${x.amount} ccy=${x.ccy} signed=${signed} /></div>`) : html`<span class="muted">none</span>`);
  const pointInTime = (x, why) => html`<${Rc} value=${period ? x.change : x.current} ccy=${rc} complete=${x.complete} why=${period && !p.period.known ? noStart : why} />
    ${period ? html`<div class="sub">${p.period.startSnapshot ? `change since the ${p.period.startSnapshot} snapshot` : 'change over the period'}</div><div class="sub">now ${fmtMoney(x.current, rc, { sign: true })}</div>` : null}`;
  const translation = p.fx.byCurrency.reduce((a, b) => a + b.translation, 0);
  const flowsBy = (...accounts) => { const m = new Map(); for (const r of p.capital.byCurrency) if (accounts.includes(r.account) && r.amount) m.set(r.ccy, (m.get(r.ccy) || 0) + r.amount); return [...m].map(([ccy, amount]) => ({ ccy, amount })); };
  const line = (label, note, loc, value) => html`<tr><td class="wrap">${label}${note ? html`<div class="sub">${note}</div>` : null}</td><td class="r">${loc}</td><td class="r">${value}</td></tr>`;
  const group = (label, note) => html`<tr class="group"><td colspan="3">${label}${note ? html` <span class="sub" style="font-weight:400">${note}</span>` : null}</td></tr>`;
  const total = (label, loc, value) => html`<tr><td class="strong" style="border-top:1.5px solid var(--rule-strong)">${label}</td><td class="r" style="border-top:1.5px solid var(--rule-strong)">${loc}</td><td class="r strong" style="border-top:1.5px solid var(--rule-strong)">${value}</td></tr>`;
  const income = (u) => ['dividends', 'couponInterest', 'lendingIncome'].reduce((a, k) => a + u.categories.find((c) => c.key === k).rc, 0);
  const cat = (u, ...keys) => keys.reduce((a, k) => a + u.categories.find((c) => c.key === k).rc, 0);
  const unitRows = (d.units || []).map((u, i) => ({ u, unit: book.units[i] })).filter((r) => !owner || r.unit.id === owner);
  const pit = (u, x) => (period ? x.change : x.current);
  const top = Math.max(0, ...d.nav.map((n) => Math.abs(n.nav)));
  const [div, unitName] = top >= 1e6 ? [1e6, ' millions'] : top >= 1e4 ? [1e3, ' thousands'] : [1, ''];
  const issues = [
    p.missing.unpriced.length ? html`${plural(p.missing.unpriced.length, 'open position has', 'open positions have')} no price (${p.marketConnected ? 'no price is available' : p.awaitingMessage}). ${p.missing.unpriced.length > 1 ? 'They are' : 'It is'} carried at cost and left out of unrealized P&L: ${p.missing.unpriced.map((u, i) => html`${i ? ', ' : ''}<${InstLink} i=${u.instrument} /> (${fmtQty(u.qty)}, cost ${fmtMoney(u.cost, u.ccy)})`)}.` : null,
    p.missing.fxMissing.length ? `No FX rate into ${rc} for ${p.missing.fxMissing.join(', ')}. Balances in ${p.missing.fxMissing.length > 1 ? 'those currencies' : 'that currency'} are left out of the ${rc} column.` : null,
    !p.period.known ? noStart : null,
    badCats.length ? `Some entries in ${badCats.join(', ')} were posted without an FX rate and are missing from the ${rc} column.` : null,
  ].filter(Boolean);
  return html`<div class="stack">${dates}
    ${badRange ? html`<${Notice} tone="err">The From date is after the To date. Swap them or clear one.<//>` : null}
    <div class="split" style="grid-template-columns:minmax(0,1.5fr) minmax(320px,1fr)">
      <div class="stack">
        <${Section} title=${`Statement for ${p.scope.consolidated && scope === 'book' ? 'the whole Book' : unitLabel(p.scope.units[0])}`} note=${period ? `${p.period.from} to ${p.period.to || 'today'}` : p.period.to ? `Inception to ${p.period.to}` : 'Since inception'}>
          <div class="tablewrap"><table class="ledger margin"><thead><tr><th>Line</th><th class="r">In local currency</th><th class="r">In ${rc}</th></tr></thead><tbody>
            ${group('Investment performance')}
            ${p.categories.map((c) => line(c.label, c.note, local(c.byCurrency), html`<${Rc} value=${c.rc} ccy=${rc} complete=${c.rcComplete} why=${whyCat} />`))}
            ${line('Unrealized P&L', p.unrealized.note || 'Open positions at current prices, against cost.', html`${local(p.unrealized.currentByCurrency)}${period && p.unrealized.currentByCurrency.length ? html`<div class="sub">as of now</div>` : null}`, pointInTime(p.unrealized, 'At least one open position has no price. It is carried at cost and left out.'))}
            ${line('FX effects', p.fx.note, html`<span class="muted">not applicable</span>`, pointInTime(p.fx, 'An FX rate is missing for at least one currency.'))}
            ${!period ? p.fx.byCurrency.map((b) => line(html`<span class="muted" style="padding-left:14px">Translation of ${b.ccy} balances</span>`, null, '', html`<${Rc} value=${b.translation} ccy=${rc} complete=${b.complete} why=${`No FX rate from ${b.ccy} to ${rc} for part of this balance.`} />`)) : null}
            ${!period && p.fx.byCurrency.length && p.fx.complete ? line(html`<span class="muted" style="padding-left:14px">Dealing cost on conversions</span>`, null, '', html`<${Money} value=${Math.round((p.fx.current - translation) * 100) / 100} ccy=${rc} signed />`) : null}
            ${total('Investment P&L', '', html`<${Rc} value=${p.investmentPnl} ccy=${rc} complete=${p.complete} why=${whyTotal} />`)}
            ${group('Capital flows', 'money moved in or out, not performance')}
            ${line('Capital contributions', null, '', html`<${Money} value=${p.capital.contributions} ccy=${rc} />`)}
            ${line('Capital withdrawals', null, '', html`<${Money} value=${-p.capital.withdrawals || 0} ccy=${rc} />`)}
            ${p.scope.consolidated ? line('Transfers between Treasury and Accounts', `${fmtMoney(p.capital.internalIn, rc)} moved inside the Book. It cancels out here and is not counted twice.`, local(flowsBy('internal'), false), html`<${Money} value=${Math.round((p.capital.internalIn - p.capital.internalOut) * 100) / 100} ccy=${rc} />`)
              : html`${line('Transfers in', 'Funding received from Treasury or another Account.', '', html`<${Money} value=${p.capital.internalIn} ccy=${rc} />`)}${line('Transfers out', null, '', html`<${Money} value=${-p.capital.internalOut || 0} ccy=${rc} />`)}`}
            ${total('Net capital flows', local(flowsBy('capital', 'internal'), false), html`<${Rc} value=${p.capital.net} ccy=${rc} complete=${p.capital.complete} why="A flow was posted without an FX rate and is left out of this total." signed=${false} />`)}
            ${group('Net asset value')}
            ${line(period ? `At the start (${p.period.startSnapshot ? `snapshot of ${p.period.startSnapshot}` : 'nothing held before the period'})` : 'At inception', null, '', html`<${Rc} value=${p.nav.start} ccy=${rc} why=${noStart} signed=${false} />`)}
            ${line('Start, plus net capital flows, plus investment P&L', p.period.to ? 'Flows and ledger items stop at the To date; unrealized P&L and FX are valued as of now.' : null, '', html`<${Rc} value=${p.nav.explained} ccy=${rc} complete=${p.complete} why=${whyTotal} signed=${false} />`)}
            ${total('Net asset value now', '', html`<${Rc} value=${p.nav.end} ccy=${rc} complete=${p.nav.endComplete} why=${whyNav({ unpriced: p.missing.unpriced, fxMissing: p.missing.fxMissing }, rc)} signed=${false} />`)}
          </tbody></table></div>
        <//>
      </div>
      <div class="stack">
        ${!p.marketConnected ? html`<${Awaiting} compact what="Prices and FX rates arrive with the Shaffer MarketData connection. Until then positions are valued only where a price was entered by hand, and totals that depend on a missing price or rate are marked incomplete." />` : null}
        ${issues.length ? html`<section class="panel"><header><h3>What is missing</h3></header><div class="body stack" style="gap:8px">${issues.map((x) => html`<${Notice} tone="warn">${x}<//>`)}
          <p class="note" style="margin:0">Figures marked incomplete leave these items out. They are not final.</p></div></section>` : null}
        <section class="panel"><header><h3>Net asset value history</h3><span class="note">${rc}${unitName}, end-of-day snapshots</span></header><div class="body">
          ${d.nav.length > 1 ? html`<${LineChart} bars=${d.nav.map((n) => ({ date: n.date, close: n.nav / div }))} height=${170} />
            <p class="note" style="margin:6px 0 0">${fmtMoney(d.nav[0].nav, rc)} on ${d.nav[0].date}, ${fmtMoney(d.nav[d.nav.length - 1].nav, rc)} on ${d.nav[d.nav.length - 1].date}. ${plural(d.nav.length, 'snapshot')}. ${d.nav.some((n) => !n.complete) ? `${plural(d.nav.filter((n) => !n.complete).length, 'day')} had a missing price or FX rate and may understate or overstate the value.` : 'Every snapshot was fully priced.'} Capital flows move this line; they are not performance.</p>`
            : html`<p class="note" style="margin:0">${d.nav.length ? `One snapshot so far (${d.nav[0].date}). A line appears after the next end of day.` : 'No end-of-day snapshot yet. The first is taken at the close of the business day.'}</p>`}
        </div></section>
      </div>
    </div>
    ${consolidated ? html`<${Section} title="By owner" note=${`In ${rc}. Each row is that owner alone. Choose a row to open its statement.`}>
      <${Table} rows=${unitRows} rowKey=${(r) => r.unit.id} onRowClick=${(r) => setScope(r.unit.id)} columns=${[
        { label: 'Owner', render: (r) => html`<span class="strong">${unitLabel(r.unit)}</span>` },
        { label: 'Realized', align: 'r', render: (r) => html`<${Money} value=${cat(r.u, 'realized')} bare signed />` },
        { label: 'Income', align: 'r', title: 'Dividends, coupon and interest income, lending income', render: (r) => html`<${Money} value=${income(r.u)} bare signed />` },
        { label: 'Borrowing and funding', align: 'r', render: (r) => html`<${Money} value=${cat(r.u, 'borrowFunding')} bare signed />` },
        { label: 'Commissions and fees', align: 'r', render: (r) => html`<${Money} value=${cat(r.u, 'commissions', 'fees')} bare signed />` },
        { label: 'Unrealized', align: 'r', render: (r) => html`<${Rc} value=${pit(r.u, r.u.unrealized)} complete=${r.u.unrealized.complete} why="An open position has no price." />` },
        { label: 'FX effects', align: 'r', render: (r) => html`<${Rc} value=${pit(r.u, r.u.fx)} complete=${r.u.fx.complete} why="An FX rate is missing." />` },
        { label: 'Investment P&L', align: 'r', render: (r) => html`<${Rc} value=${r.u.investmentPnl} complete=${r.u.complete} why="A price, an FX rate or a starting snapshot is missing for this owner." />` },
        { label: 'Net capital flows', align: 'r', title: 'Includes funding between Treasury and Accounts', render: (r) => fmtMoney(r.u.capital.net, '', { sign: true }) },
        { label: 'Net asset value', align: 'r', render: (r) => html`<${Rc} value=${r.u.nav.end} complete=${r.u.nav.endComplete} why="A position has no price or a currency has no FX rate." signed=${false} />` },
      ]} footer=${!owner ? html`<tr><td>Whole Book</td><td class="r">${fmtMoney(cat(p, 'realized'), '', { sign: true })}</td><td class="r">${fmtMoney(income(p), '', { sign: true })}</td><td class="r">${fmtMoney(cat(p, 'borrowFunding'), '', { sign: true })}</td><td class="r">${fmtMoney(cat(p, 'commissions', 'fees'), '', { sign: true })}</td>
        <td class="r">${fmtMoney(pit(p, p.unrealized), '', { sign: true })}</td><td class="r">${fmtMoney(pit(p, p.fx), '', { sign: true })}</td><td class="r">${fmtMoney(p.investmentPnl, '', { sign: true })}</td><td class="r">${fmtMoney(p.capital.net, '', { sign: true })}</td><td class="r">${fmtMoney(p.nav.end, '')}</td></tr>` : null} />
    <//>` : null}
  </div>`;
}

// ---- 2. Open positions ------------------------------------------------------------------------------------
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
function PositionsTab({ book, d, consolidated, owner, setOwner }) {
  const rc = book.reportingCcy;
  const order = new Map(book.units.map((u, i) => [u.id, i]));
  const mine = (id) => !owner || id === owner;
  const sorted = d.positions.filter((p) => mine(p.owner.id)).sort((a, b) => order.get(a.owner.id) - order.get(b.owner.id) || (a.strategy?.name || '~').localeCompare(b.strategy?.name || '~') || (a.strategyId || '').localeCompare(b.strategyId || '') || (a.purpose === 'financing') - (b.purpose === 'financing'));
  const rows = [];
  let last = null;
  for (const p of sorted) {
    const key = `${p.owner.id}|${p.strategyId}`;
    if (key !== last) rows.push({ _group: html`${consolidated ? `${unitLabel(p.owner)}: ` : ''}<${StratLink} s=${p.strategy} /> ${p.strategy ? html`<span class="sub" style="font-weight:400">${sentence(p.strategy.template)}${p.strategy.investmentStrategy?.name ? `, ${p.strategy.investmentStrategy.name}` : ''}</span> <${StrategyStatus} status=${p.strategy.status} />` : ''}` });
    last = key;
    rows.push(p);
  }
  const cashRows = d.cash.filter((c) => mine(c.owner.id));
  const z = (x, ccy) => (x ? fmtMoney(x, ccy, { bare: true }) : html`<span class="muted">0</span>`);
  return html`<div class="stack">
    ${consolidated ? html`<div class="toolbar" style="margin:0"><${OwnerFilter} book=${book} value=${owner} onChange=${setOwner} /></div>` : null}
    ${!d.marketConnected ? html`<${Awaiting} compact what="Positions are valued only where a price exists. Without the Shaffer MarketData connection, market value and unrealized P&L are missing unless a price was entered by hand on the instrument." />` : null}
    <${Section} title="Positions" note="Grouped by owner and strategy instance. Financing legs sit with the strategy they fund.">
      <${Table} margin rows=${rows} rowKey=${(p) => p.positionId} columns=${[
        consolidated ? { label: 'Owner', render: (p) => unitLabel(p.owner) } : null,
        { label: 'Instrument and role', render: (p) => html`<div class="sym clip" style="max-width:215px"><${InstLink} i=${p.instrument} /></div>
          <div class="sub clip" style="max-width:215px" title=${p.instrument.name}><${Pill} tone=${p.purpose === 'hedge' ? 'pen' : p.purpose === 'financing' ? 'warn' : ''}>${PURPOSE_LABEL[p.purpose] || p.purpose}<//> ${p.instrument.symbol ? p.instrument.name : p.support?.productName || p.family}</div>` },
        { label: 'Quantity', align: 'r', render: (p) => html`${fmtQty(p.qty)}<div class=${`sub ${p.direction === 'long' ? 'gain' : p.direction === 'short' ? 'loss' : ''}`} style="white-space:normal;max-width:84px;margin-left:auto">${p.direction}</div>` },
        { label: 'Average cost', align: 'r', render: (p) => (p.ledgerCarried ? '' : html`${isNum(p.avgCost) ? fmtPrice(p.avgCost) : html`<${Missing} reason="No cost basis" />`}${p.family === 'future' ? html`<div class="sub">last settlement</div>` : p.family === 'forward' ? html`<div class="sub">dealt price</div>` : null}`) },
        { label: 'Current market price', align: 'r', title: 'Hover a price for its units and currency', render: (p) => (p.ledgerCarried ? '' : html`<span title=${`${p.priceUnits || 'price'}, ${p.ccy}`}><${Price} obs=${p.priceObs} value=${p.price} reason=${p.missingReason || 'No price available'} /></span>`) },
        { label: 'Market value or notional', align: 'r', title: 'Futures, forwards and swaps show their notional and the margin posted, not a market value.', render: valueCell },
        { label: 'Unrealized P&L', align: 'r', title: `In the position's currency, with the ${rc} equivalent beneath when it differs`, render: (p) => (p.ledgerCarried ? '' : html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} />
          ${p.ccy !== rc && !p.missing ? html`<div class="sub" title=${isNum(p.fxRate) ? `Converted at ${fmtNum(p.fxRate, p.fxRate < 0.1 ? 6 : 4)} ${rc} per ${p.ccy} (${p.fxObs?.statusLabel || 'rate'}, ${p.fxObs?.source || ''}). The rate and its source are in Net assets by currency below.` : ''}><${Money} value=${p.unrealizedRc} ccy=${rc} signed reason=${`No FX rate from ${p.ccy} to ${rc}`} /></div>` : null}`) },
        { label: 'Accrued, collateral', title: 'Accrued income or cost, restricted cash, margin, pledged and on-loan quantities, collateral and securities borrowed', render: holdCell },
      ].filter(Boolean)} empty=${{ title: owner ? 'This owner has no open positions' : 'No open positions', children: 'Positions appear here once a paper trade fills. Trade from a market view or build a package on the Strategy page.' }} />
    <//>
    <${Section} title="Cash and financing balances" note="Restricted cash is short-sale proceeds and borrow collateral, not buying power. Borrowed cash is a liability.">
      <${Table} rows=${cashRows} columns=${[
        consolidated ? { label: 'Owner', render: (c) => unitLabel(c.owner) } : null,
        { label: 'Currency', render: (c) => html`<span class="strong">${c.ccy}</span>` },
        { label: 'Settled', align: 'r', render: (c) => fmtMoney(c.settled, c.ccy, { bare: true }) }, { label: 'Unsettled', align: 'r', title: 'Receivable less payable', render: (c) => z(c.unsettled, c.ccy) },
        { label: 'Reserved', align: 'r', render: (c) => z(c.reserved, c.ccy) }, { label: 'Restricted', align: 'r', render: (c) => z(c.restricted, c.ccy) }, { label: 'Margin', align: 'r', render: (c) => z(c.margin, c.ccy) },
        { label: 'Available to trade', align: 'r', render: (c) => fmtMoney(c.availableToTrade, c.ccy, { bare: true }) },
        { label: 'Cash borrowed', align: 'r', render: (c) => (c.borrowed ? html`<span class="loss">${fmtMoney(c.borrowed, c.ccy, { bare: true })}</span>` : z(0)) }, { label: 'Cash lent', align: 'r', render: (c) => z(c.lent, c.ccy) },
        { label: 'Accrued, net', align: 'r', title: 'Accrued income receivable less accrued expense payable', render: (c) => (c.accruedReceivable || c.accruedPayable ? fmtMoney(c.accruedReceivable - c.accruedPayable, c.ccy, { bare: true, sign: true }) : z(0)) },
        { label: `Settled, ${rc}`, align: 'r', render: (c) => html`<${Money} value=${c.settledRc} bare reason=${`No FX rate from ${c.ccy} to ${rc}`} />` },
      ].filter(Boolean)} empty=${{ title: 'No cash balances', children: 'Deposit capital into Treasury and fund the Accounts under Treasury.' }} />
    <//>
    ${!owner && d.nav.byCurrency.length ? html`<${Section} title="Net assets by currency" note=${`Local amounts and their ${rc} equivalents at the current FX rate. Each balance is counted once.`}>
      <div class="tablewrap"><table class="ledger"><thead><tr><th>Currency</th><th class="r">Cash, all kinds</th><th class="r">Unsettled</th><th class="r">Positions at cost</th><th class="r">Unrealized</th><th class="r">Loans</th><th class="r">Accrued</th><th class="r">Net assets</th><th class="r">FX rate to ${rc}</th><th class="r">Net assets, ${rc}</th></tr></thead>
        <tbody>${d.nav.byCurrency.map((r) => html`<tr><td class="strong">${r.ccy}</td><td class="r">${z(r.cash + r.restricted + r.margin, r.ccy)}</td><td class="r">${z(r.receivable + r.payable, r.ccy)}</td><td class="r">${z(r.positionsAtCost, r.ccy)}</td>
          <td class="r">${r.unrealized ? fmtMoney(r.unrealized, r.ccy, { bare: true, sign: true }) : z(0)}</td><td class="r">${z(r.loansLent + r.loansBorrowed, r.ccy)}</td><td class="r">${z(r.accruedAsset + r.accruedLiab, r.ccy)}</td><td class="r strong">${fmtMoney(r.nav, r.ccy, { bare: true })}</td>
          <td class="r">${r.ccy === rc ? html`<span class="muted">1</span>` : isNum(r.fxRate) ? html`${fmtNum(r.fxRate, r.fxRate < 0.1 ? 6 : 4)} <${Prov} obs=${r.fxObs} />` : html`<${Missing} reason=${`No FX rate from ${r.ccy} to ${rc}`} />`}</td>
          <td class="r"><${Money} value=${r.navRc} bare reason=${`No FX rate from ${r.ccy} to ${rc}`} /></td></tr>`)}</tbody>
        <tfoot><tr><td colspan="9">Net asset value${d.nav.unpriced.length ? html` <span class="sub" style="font-weight:400">unpriced positions are carried at cost</span>` : ''}</td><td class="r"><${Rc} value=${d.nav.value} complete=${d.nav.complete} why=${whyNav(d.nav, rc)} signed=${false} /></td></tr></tfoot></table></div>
    <//>` : null}
  </div>`;
}

// ---- 3. Pending trades -------------------------------------------------------------------------------------
const settleDates = (list) => { const m = new Map(); for (const x of list) { const k = `${x.dueDate}|${x.ccy}`; m.set(k, { dueDate: x.dueDate, ccy: x.ccy, amount: (m.get(k)?.amount || 0) + x.amount }); } return [...m.values()]; };
const holdList = (list, lead = '') => list.filter((h) => h.amount).map((h) => html`<div>${lead}${fmtMoney(h.amount, h.ccy)} <span class="sub">${words(h.kind)}</span></div>`);
function OrderRows({ rows, partial, consolidated, onChanged }) {
  const [busy, setBusy] = useState('');
  const cancel = async (o) => {
    setBusy(o.id);
    try { await post(`/api/orders/${o.id}/cancel`); toast(`Order cancelled: leg ${o.legNo} of ${o.strategy.name}.`); bump(); onChanged(); } catch (err) { toastError(err); }
    setBusy('');
  };
  return html`<${Table} margin rows=${rows} rowKey=${(o) => o.id} columns=${[
    consolidated ? { label: 'Owner', render: (o) => o.owner } : null,
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
function PendingTab({ book, d, consolidated, owner, setOwner, reload }) {
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
    </div><span class="spacer"></span>${consolidated ? html`<${OwnerFilter} book=${book} value=${owner} onChange=${setOwner} />` : null}</div>
    <${Section} title="Open orders" note="Submitted and not filled at all. Nothing has traded and no cash has moved.">
      ${open.length ? html`<${OrderRows} rows=${open} consolidated=${consolidated} onChanged=${reload} />` : html`<${Empty}>No open orders. A limit or stop order that has not traded waits here, as does a leg waiting on another leg.<//>`}<//>
    <${Section} title="Partly filled orders" note="Part has executed and is settling; the remaining quantity is still working.">
      ${part.length ? html`<${OrderRows} rows=${part} partial consolidated=${consolidated} onChanged=${reload} />` : html`<${Empty}>No partly filled orders.<//>`}<//>
    <${Section} title="Executed trades awaiting settlement" note="The trade is done. Cash and securities move on the settlement date.">
      <${Table} margin rows=${settle} rowKey=${(s) => s.id} columns=${[
        consolidated ? { label: 'Owner', render: (s) => s.owner } : null,
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
        consolidated ? { label: 'Owner', render: (t) => t.owner } : null,
        { label: 'Item', render: (t) => html`<span class="strong">${t.label}</span>` },
        { label: 'Instrument and strategy instance', render: (t) => html`<${InstLink} i=${t.instrument} />${t.strategy ? html`<div class="sub">in <${StratLink} s=${t.strategy} /></div>` : null}` },
        { label: 'Due', render: (t) => t.dueDate },
        { label: 'State', render: (t) => html`<${Pill} tone=${t.status === 'blocked' ? 'bad' : ''}>${t.status === 'blocked' ? 'blocked' : 'scheduled'}<//>` },
        { label: 'Waiting for', cls: 'wrap', render: (t) => (t.status === 'blocked' ? html`<div>${t.reason}</div>${need(t)}` : html`<span class="muted">Its due date</span>`) },
      ].filter(Boolean)} empty=${{ children: 'No lifecycle items are scheduled for the positions held here.' }} /><//>
  </div>`;
}

// ---- 4. Failed and cancelled -------------------------------------------------------------------------------
function FailedTab({ book, d, consolidated, owner, setOwner }) {
  const [kind, setKind] = useState('');
  const mine = (x) => !owner || x.unitId === owner;
  const all = d.orders.filter(mine);
  const orders = all.filter((o) => !kind || o.status === kind);
  const count = (s) => all.filter((o) => o.status === s).length;
  const fails = d.settlementFailures.filter(mine), tasks = d.lifecycleFailures.filter(mine);
  const col = (...c) => c.filter(Boolean);
  return html`<div class="stack">
    <div class="toolbar" style="margin:0"><${Seg} value=${kind} onChange=${setKind} options=${[{ value: '', label: `All (${all.length})` }, { value: 'rejected', label: `Rejected (${count('rejected')})` }, { value: 'cancelled', label: `Cancelled (${count('cancelled')})` }, { value: 'expired', label: `Expired (${count('expired')})` }]} />
      <span class="grow"></span>${consolidated ? html`<${OwnerFilter} book=${book} value=${owner} onChange=${setOwner} />` : null}</div>
    <${Section} title="Orders that did not complete" note="Each with its reason, what did execute, and what the strategy instance still holds.">
      <${Table} margin rows=${orders} rowKey=${(o) => o.id} columns=${col(
        consolidated ? { label: 'Owner', render: (o) => o.owner } : null,
        { label: 'Order', render: (o) => html`<div class="strong">${o.label}</div><div class="sub">Leg ${o.legNo} of <${StratLink} s=${o.strategy} /></div><div class="sub">${fmtTime(o.updatedAt)}</div>` },
        { label: 'Outcome and reason', cls: 'wrap', render: (o) => html`<${Pill} tone=${o.status === 'rejected' ? 'bad' : 'warn'}>${o.category.toLowerCase()}<//><div>${o.statusReason || html`<${Missing} reason="No reason was recorded" />`}</div>` },
        { label: 'What executed', render: (o) => (o.filledQty > 0 ? html`<span class="strong">${fmtQty(o.filledQty)} of ${fmtQty(o.qty)}</span><div class="sub">average ${fmtPrice(o.avgPrice)}, ${plural(o.fills.length, 'fill')}</div><div class="sub">${fmtQty(o.remainingQty)} never traded</div>` : html`<span class="muted">Nothing filled</span>`) },
        { label: 'Still held by the strategy', render: (o) => (o.remainingPositions.length ? o.remainingPositions.map((r) => html`<div>${r.instrument} <b class=${r.qty > 0 ? 'gain' : 'loss'}>${fmtQty(r.qty)}</b></div>`) : html`<span class="muted">No open position</span>`) },
        { label: 'Strategy instance', render: (o) => html`<${StrategyStatus} status=${o.strategy.status} />${o.resolved ? html`<div class="sub">this leg was dealt with</div>` : null}` },
        { label: '', align: 'r', render: (o) => html`<${Button} small kind=${o.strategy.status === 'attention' && !o.resolved ? 'primary' : ''} onClick=${() => openStrategy(o.strategy.id)}>${o.strategy.status === 'attention' && !o.resolved ? 'Retry, unwind or accept' : 'Open strategy'}<//>` },
      )} empty=${{ title: all.length ? 'None of this kind' : 'No failed or cancelled orders', children: all.length ? 'Choose another outcome above.' : 'Rejected, cancelled and expired legs are listed here with their reasons.' }} /><//>
    <${Section} title="Failed settlements" note="A settlement fails rather than overdraw cash. It is retried on each engine cycle.">
      <${Table} margin rows=${fails} rowKey=${(s) => s.id} columns=${col(
        consolidated ? { label: 'Owner', render: (s) => s.owner } : null,
        { label: 'Instrument', render: (s) => html`<${InstLink} i=${s.instrument} />` },
        { label: 'Strategy instance', render: (s) => html`<${StratLink} s=${s.strategy} />` },
        { label: 'Cash movement', align: 'r', render: (s) => html`<span class="sub">${s.direction === 'receive' ? 'to receive' : 'to pay'}</span> <${Money} value=${s.amount} ccy=${s.ccy} signed />` },
        { label: 'Was due', render: (s) => s.dueDate }, { label: 'Attempts', align: 'r', render: (s) => s.attempts },
        { label: 'Reason', cls: 'wrap', render: (s) => html`<span class="loss">${s.error || 'No reason was recorded'}</span>` },
        { label: '', align: 'r', render: (s) => (s.strategy ? html`<${Button} small onClick=${() => openStrategy(s.strategy.id)}>Open strategy<//>` : '') },
      )} empty=${{ children: 'No settlement has failed.' }} /><//>
    ${tasks.length ? html`<${Section} title="Failed lifecycle items">
      <${Table} rows=${tasks} rowKey=${(t) => t.id} columns=${col(
        consolidated ? { label: 'Owner', render: (t) => t.owner } : null, { label: 'Item', render: (t) => t.label }, { label: 'Instrument', render: (t) => html`<${InstLink} i=${t.instrument} />` },
        { label: 'Strategy instance', render: (t) => html`<${StratLink} s=${t.strategy} />` }, { label: 'Due', render: (t) => t.dueDate }, { label: 'Reason', cls: 'wrap', render: (t) => html`<span class="loss">${t.reason}</span>` },
      )} /><//>` : null}
  </div>`;
}

// ---- 5. Full history --------------------------------------------------------------------------------------------
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
function AdjustmentDialog({ book, scope, corrects, onClose, onDone }) {
  const [f, setF] = useState({ unitId: corrects?.unitId || (scope !== 'book' ? scope : book.units[0].id), ccy: corrects?.cash?.[0]?.ccy || book.reportingCcy, amount: null, category: 'fee', note: '', correctsEventId: corrects?.id ?? null });
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
function HistoryTab({ book, scope, consolidated, owner, setOwner }) {
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
  const adjust = (corrects) => openOverlay((close) => html`<${AdjustmentDialog} book=${book} scope=${scope} corrects=${corrects} onClose=${close} onDone=${res.reload} />`);
  const cols = consolidated ? 5 : 4;
  return html`<div class="stack">
    <div class="toolbar" style="margin:0">
      <div style="width:230px"><${Select} value=${f.type} onChange=${(v) => setF({ ...f, type: v })} options=${typeOptions} placeholder="All event types" /></div>
      <div style="width:220px"><${Text} type="search" value=${typed} onInput=${setTyped} placeholder="Search the event text" /></div>
      <span class="note">From</span><div style="width:140px"><${Text} type="date" value=${f.from} onInput=${(v) => setF({ ...f, from: v })} /></div>
      <span class="note">to</span><div style="width:140px"><${Text} type="date" value=${f.to} onInput=${(v) => setF({ ...f, to: v })} /></div>
      <${Check} checked=${f.accruals} onChange=${(v) => setF({ ...f, accruals: v })} disabled=${Boolean(f.type)}>Include daily accruals<//>
    </div>
    ${consolidated ? html`<div class="toolbar" style="margin:0"><${OwnerFilter} book=${book} value=${owner} onChange=${setOwner} /><span class="note">An event shows under every owner whose balances it moved.</span></div>` : null}
    <${ErrorNote} error=${res.error} />
    <${Section} title="Audit trail" note=${`Newest first. ${plural(events.length, 'event')} shown${res.data?.accrualsHidden ? ', daily accruals hidden' : ''}. Nothing here is ever edited or deleted.`}
      actions=${html`<${Button} small onClick=${() => adjust(null)}>Record a manual adjustment<//>`}>
      ${!res.data && !all.length ? html`<${Empty}>${res.error ? '' : 'Loading the history…'}<//>` : !events.length ? html`<${Empty} title="No events match">Clear a filter, widen the dates or include daily accruals.<//>` : html`<div class="tablewrap"><table class="ledger margin">
        <thead><tr><th>Time</th>${consolidated ? html`<th>Owner</th>` : null}<th>Event</th><th class="r">Cash effect</th><th></th></tr></thead>
        <tbody>${events.map((e) => html`<tr key=${e.id} id=${`ev-${e.id}`}>
            <td>${fmtTime(e.ts, { seconds: true })}<div class="sub">#${e.id}</div></td>
            ${consolidated ? html`<td>${owners(e).map((o) => html`<div>${o}</div>`)}</td>` : null}
            <td class="wrap"><div class="strong">${sentence(e.type)}</div>${e.summary}
              ${e.correctsEventId ? html`<div class="sub"><${Pill} tone="pen">correction<//> Corrects ${link(`event #${e.correctsEventId}`, () => show(e.correctsEventId))}, which is kept as recorded.</div>` : null}
              ${e.correctedBy.length ? html`<div class="sub"><${Pill} tone="warn">corrected<//> Corrected by ${e.correctedBy.map((id, i) => html`${i ? ', ' : ''}${link(`event #${id}`, () => show(id))}`)}. This original is kept as recorded.</div>` : null}</td>
            <td class="r">${e.cash.length ? e.cash.map((c) => html`<div><${Money} value=${c.amount} ccy=${c.ccy} signed /></div>`) : html`<span class="muted">none</span>`}</td>
            <td class="r">${e.reversible ? html`<${Button} small onClick=${() => openOverlay((close) => html`<${ReverseDialog} e=${e} onClose=${close} onDone=${res.reload} />`)}>Reverse<//> ` : null}
              <${Button} small onClick=${() => setOpen((o) => ({ ...o, [e.id]: !o[e.id] }))}>${open[e.id] ? 'Hide entries' : `Entries (${e.entries.length})`}<//></td>
          </tr>${open[e.id] ? html`<tr class="detail" key=${`d${e.id}`}><td colspan=${cols} style="background:var(--paper);padding:10px 12px 12px 26px;white-space:normal"><${Entries} e=${e} rc=${rc} onAdjust=${() => adjust(e)} /></td></tr>` : null}`)}</tbody></table></div>`}
      ${st.current.more ? html`<div class="body" style="border-top:1px solid var(--rule)"><${Button} small busy=${busy} onClick=${older}>Show older events<//> <span class="note">Showing back to event #${all[all.length - 1]?.id}.</span></div>` : null}
    <//>
  </div>`;
}

// ---- page -----------------------------------------------------------------------------------------------------------
export default function Accounting({ args, book }) {
  const tab = TABS.some(([id]) => id === args[0]) ? args[0] : 'pnl';
  const scope = args[1] === 'treasury' ? book.units.find((u) => u.kind === 'treasury')?.id || 'book' : book.units.some((u) => u.id === args[1]) ? args[1] : 'book';
  const go = (t, s) => { location.hash = `#/accounting/${t}/${s}`; };
  const [owner, setOwner] = useState('');
  useEffect(() => { setOwner(''); }, [scope]);
  const base = useLive(async () => {
    const tabData = (t) => get(`/api/books/${book.id}/accounting/${t}`, { scope });
    const [b, positions, pending, failed] = await Promise.all([get(`/api/books/${book.id}`), tabData('positions'), tabData('pending'), tabData('failed')]);
    return { overview: b.overview, positions, pending, failed, scope };
  }, [book.id, scope]);
  const d = base.data?.scope === scope ? base.data : null;
  const consolidated = scope === 'book' && book.units.length > 1;
  const scopes = [{ value: 'book', label: 'Whole Book' }, ...book.units.map((u) => ({ value: u.id, label: unitLabel(u) }))];
  const unit = book.units.find((u) => u.id === scope);
  const attention = d ? d.failed.orders.filter((o) => o.strategy.status === 'attention' && !o.resolved).length + d.failed.settlementFailures.length + d.failed.lifecycleFailures.length : 0;
  const tabs = TABS.map(([id, label]) => ({ id, label,
    count: !d ? undefined : id === 'positions' ? d.positions.positions.length : id === 'pending' ? d.pending.openOrders.length + d.pending.partiallyFilled.length + d.pending.awaitingSettlement.length : id === 'failed' ? d.failed.orders.length : undefined,
    alert: d && id === 'failed' && attention ? attention : d && id === 'pending' ? d.pending.lifecycle.filter((t) => t.status === 'blocked').length || undefined : undefined }));
  const shared = { book, scope, consolidated, owner: consolidated ? owner : '', setOwner };
  return html`<div>
    <div class="page-head"><div><h1>Accounting</h1>
      <div class="sub">${scope === 'book' ? `${book.name}, consolidated: Treasury and ${plural(book.units.length - 1, 'Account')} together. Funding between them is internal and is not counted twice.` : unit.kind === 'treasury' ? `Treasury of ${book.name} alone: unallocated cash, funding and collateral.` : `The Account ${unit.name} in ${book.name}, alone.`} Reporting currency ${book.reportingCcy}.</div></div>
      <div class="actions"><span class="note">Scope</span>${scopes.length <= 6 ? html`<${Seg} value=${scope} onChange=${(s) => go(tab, s)} options=${scopes} />` : html`<div style="width:240px"><${Select} value=${scope} onChange=${(s) => go(tab, s)} options=${scopes} /></div>`}</div></div>
    <${ErrorNote} error=${base.error} />
    ${d ? html`<${ScopeStrip} book=${book} scope=${scope} d=${d} />` : base.error ? null : html`<${Empty}>Loading the accounts…<//>`}
    <${Tabs} tabs=${tabs} value=${tab} onChange=${(t) => go(t, scope)} />
    ${tab === 'pnl' ? html`<${PnlTab} ...${shared} setScope=${(s) => go('pnl', s)} />` : null}
    ${tab === 'history' ? html`<${HistoryTab} ...${shared} />` : null}
    ${d && tab === 'positions' ? html`<${PositionsTab} ...${shared} d=${d.positions} />` : null}
    ${d && tab === 'pending' ? html`<${PendingTab} ...${shared} d=${d.pending} reload=${base.reload} />` : null}
    ${d && tab === 'failed' ? html`<${FailedTab} ...${shared} d=${d.failed} />` : null}
  </div>`;
}
