// One Account of the selected Book.
//
// An Account is funded from the Book's Treasury and holds its own cash, positions and borrowings.
// Opening this page makes the Account the one in use on trade tickets and the Strategies page.
// It shows the Account alone: its NAV, cash by currency with every bucket, its own balance sheet,
// the borrowings it took directly, the internal funding it has received, and what it holds.
// A borrowing listed here is the one record of that loan: Treasury sees the same record in its
// oversight view as Account-originated, and the consolidated Book counts it once.
//
// The cash tickets are Treasury's (views/treasury.js), opened with this Account fixed. Everything
// that trades or borrows goes through the preview and its single confirmation.
import { html, useEffect } from '../vendor/preact-htm.js';
import { fmtMoney, fmtPrice, fmtQty, get, isNum, openOverlay, setUnit, useLive } from '../lib/core.js';
import { Awaiting, Button, Empty, ErrorNote, Holdings, Missing, Money, NavAffected, NavValue, Panel, Pill, Price, PURPOSE_LABEL, Stat, Table } from '../lib/ui.js';
import { openInstrument } from './instrument.js';
import { openStrategy } from './strategy-detail.js';
import { ArrangementDialog, BorrowConvertDialog, BorrowingTable, CashBuckets, ConvertDialog, TransferDialog } from './treasury.js';
import { CollateralDesk } from './agreements.js';

const FINANCING = ['loan', 'repo', 'secloan'];
const NOTIONAL = ['future', 'forward', 'swap', 'cds'];
const unitName = (u) => (u?.kind === 'treasury' ? 'Treasury' : u?.name || '');
const none = (text = 'none') => html`<span class="muted">${text}</span>`;
const link = (label, onClick, title) => html`<a href="javascript:void 0" title=${title} onClick=${onClick}>${label}</a>`;
const amounts = (list, text) => (list.length ? list.map((x) => html`<div>${fmtMoney(x.amount, x.ccy)}</div>`) : none(text));

/** The Account's own figures: balance sheet (with its NAV and borrowings), open positions and cash, and the header figures. */
function useAccount(bookId, unitId) {
  return useLive(async () => {
    if (!unitId) return null;
    const sheet = await get(`/api/books/${bookId}/accounting/balance`, { scope: unitId }); // refreshes prices and FX first
    const [b, positions] = await Promise.all([get(`/api/books/${bookId}`), get(`/api/books/${bookId}/accounting/positions`, { scope: unitId })]);
    return { unitId, sheet, positions, unit: b.overview.units.find((u) => u.id === unitId) };
  }, [bookId, unitId]);
}

/**
 * Net internal funding by counterparty, worked out from the Account's transfers. It is shown only
 * when it adds up to the ledger's own internal balance; otherwise the net figure stands by itself.
 */
function fundingBy(history, unitId, net) {
  if (!history || history.more) return null;
  const byId = new Map(history.events.map((e) => [e.id, e]));
  const m = new Map();
  for (const e of history.events) {
    const src = e.correctsEventId ? byId.get(e.correctsEventId) : e; // a reversal undoes the transfer it points at
    const t = src?.data;
    if (!t?.fromUnitId || !t.toUnitId) return null;
    const other = t.toUnitId === unitId ? t.fromUnitId : t.fromUnitId === unitId ? t.toUnitId : null;
    if (!other) continue;
    const amt = (t.toUnitId === unitId ? 1 : -1) * (e.correctsEventId ? -1 : 1) * t.amount;
    m.set(`${other}|${t.ccy}`, (m.get(`${other}|${t.ccy}`) || 0) + amt);
  }
  const rows = [...m].map(([k, amount]) => ({ unitId: k.split('|')[0], ccy: k.split('|')[1], amount })).filter((r) => Math.abs(r.amount) > 0.004);
  const ccys = new Set([...rows.map((r) => r.ccy), ...net.map((x) => x.ccy)]);
  for (const ccy of ccys) if (Math.abs(rows.filter((r) => r.ccy === ccy).reduce((a, r) => a + r.amount, 0) - (net.find((x) => x.ccy === ccy)?.amount || 0)) > 0.005) return null;
  return rows;
}

/** The Account's balance sheet alone: one column, from the same worksheet Accounting draws in full. */
function Sheet({ sheet, unit, rc }) {
  const cell = (x) => x.cells[unit.id];
  const all = [...sheet.lines, ...sheet.representedBy].map(cell);
  const foreign = all.some((c) => c.byCurrency.some((x) => x.ccy !== rc));
  const span = foreign ? 3 : 2;
  const value = (c, strong) => html`<span class=${strong ? 'strong' : ''}>${fmtMoney(c.rc, rc, { bare: true })}</span>${c.complete ? null : html` <${Pill} tone="warn" title=${`No conversion rate into ${rc} for a currency on this line, so that balance is left out of this figure.`}>provisional<//>`}`;
  const local = (c) => (c.byCurrency.length ? c.byCurrency.map((x) => html`<div>${fmtMoney(x.amount, x.ccy)}</div>`) : '');
  const line = (label, c, { note, strong, rule } = {}) => { const st = rule ? 'border-top:1.5px solid var(--rule-strong)' : ''; return html`<tr><td style=${st} title=${note}><span class=${strong ? 'strong' : ''}>${label}</span></td>${foreign ? html`<td class="r" style=${st}>${strong ? '' : local(c)}</td>` : null}<td class="r" style=${st}>${value(c, strong)}</td></tr>`; };
  const group = (label) => html`<tr class="group"><td colspan=${span}>${label}</td></tr>`;
  const section = (key) => sheet.lines.filter((l) => l.section === key).map((l) => line(l.label, cell(l), { note: l.note }));
  if (!sheet.lines.length) return html`<${Empty} title="Nothing is on this Account's balance sheet yet">Fund the Account from Treasury. Its cash, positions and any borrowing it takes then appear here.<//>`;
  return html`<div class="tablewrap"><table class="ledger margin">
    <thead><tr><th>Line</th>${foreign ? html`<th class="r">In local currency</th>` : null}<th class="r">${unit.name}, ${rc}</th></tr></thead>
    <tbody>
      ${group('Assets')}${section('assets')}${line('Total assets', cell(sheet.assets), { strong: true, rule: true })}
      ${group('Liabilities')}${section('liabilities').length ? section('liabilities') : html`<tr><td colspan=${span} class="muted">This Account owes nothing.</td></tr>`}${line('Total liabilities', cell(sheet.liabilities), { strong: true, rule: true })}
      ${line('Net assets', cell(sheet.netAssets), { strong: true, rule: true })}
      ${group('Represented by')}
      ${sheet.representedBy.filter((r) => r.key !== 'capital' || cell(r).rc || cell(r).byCurrency.length).map((r) => line(r.key === 'internal' ? 'Internal funding received, net' : r.label, cell(r), { note: r.note }))}
    </tbody></table></div>`;
}

function Funding({ book, unit, sheet, history }) {
  const net = sheet.representedBy.find((r) => r.key === 'internal').cells[unit.id].byCurrency;
  const by = fundingBy(history, unit.id, net);
  const name = (id) => unitName(book.units.find((u) => u.id === id)) || id;
  const order = new Map(book.units.map((u, i) => [u.id, i]));
  const rc = book.reportingCcy;
  const rows = (by || []).sort((a, b) => order.get(a.unitId) - order.get(b.unitId) || (a.ccy === rc ? -1 : b.ccy === rc ? 1 : a.ccy < b.ccy ? -1 : 1));
  return html`<${Panel} title="Internal funding received" note="Inside the Book" flush>
    ${net.length || rows.length ? html`<div class="tablewrap"><table class="ledger">
      <thead><tr><th>Counterparty in this Book</th><th>Received by</th><th class="r">Net amount</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td>${name(r.unitId)}<div class="sub">${r.amount > 0 ? 'net received from it' : 'net sent to it'}</div></td><td>${unit.name}</td><td class="r">${fmtMoney(r.amount, r.ccy, { sign: true })}</td></tr>`)}</tbody>
      <tfoot><tr><td>Net funding received${by ? '' : html`<div class="sub" style="font-weight:400">from Treasury and other Accounts, less what was sent back</div>`}</td><td>${unit.name}</td><td class="r">${amounts(net, 'none')}</td></tr></tfoot></table></div>`
      : html`<${Empty} title="No funding has been received">Fund this Account from Treasury to give it cash to trade with.<//>`}
    <div class="small muted" style="padding:8px 12px">Funding is internal to the Book: cash moved between Treasury and its Accounts, never converted. It is not income, and it is eliminated when the Book is consolidated, so nothing is counted twice. Each transfer is in <a href=${`#/accounting/history/${unit.id}`}>this Account's history</a>.</div>
  <//>`;
}

const inst = (i) => link(i.symbol || i.name, () => openInstrument(i.id), i.name);

function HoldingsPanel({ d }) {
  const held = d.holdings.map((h) => ({ ...h, units: h.owners.map((o) => ({ name: o.name, long: o.long, short: o.short, net: o.net, qty: o.net })) }));
  return html`<${Panel} title="Holdings by instrument" note="Gross: long, short and net kept apart" flush>
    <${Table} rows=${held} rowKey=${(h) => h.instrument.id} columns=${[
      { label: 'Instrument', render: (h) => html`<div class="sym">${inst(h.instrument)}</div><div class="sub clip" style="max-width:190px">${h.instrument.symbol ? h.instrument.name : ''}</div>` },
      { label: 'Held, by owner', render: (h) => html`<${Holdings} h=${h} detail label="Held" />` },
    ]} empty=${{ title: 'This Account holds no instruments', children: html`Buy or sell short from a <a href="#/markets/US_CASH">Marketplace</a>, or build a package on the <a href="#/strategy">Strategies</a> page. This Account is already selected there.` }} />
    ${held.length ? html`<div class="small muted" style="padding:8px 12px">Long and short are separate positions. The net is shown beside them and never in place of the long holding.</div>` : null}<//>`;
}

function Positions({ unit, d, rc }) {
  const value = (p) => (NOTIONAL.includes(p.family) ? html`<${Money} value=${p.notional} ccy=${p.ccy} reason=${p.missingReason || 'Needs a price'} /><div class="sub">notional</div>`
    : p.ledgerCarried ? html`${fmtMoney(isNum(p.carrying) ? Math.abs(p.carrying) : p.notional, p.ccy)}<div class="sub">${p.family === 'secloan' ? 'value of the securities' : 'principal outstanding'}</div>`
      : html`<${Money} value=${p.mv} ccy=${p.ccy} reason=${p.missingReason} />`);
  return html`<${Panel} title="Open positions" note="Each position with its strategy instance. Financing legs are this Account's own." flush actions=${html`<a class="btn small" href=${`#/accounting/positions/${unit.id}`}>Open positions in Accounting</a>`}>
      <${Table} margin rows=${d.positions} rowKey=${(p) => p.positionId} columns=${[
        { label: 'Instrument', render: (p) => html`<div class="sym clip" style="max-width:230px">${inst(p.instrument)}</div><div class="sub">${p.purpose !== 'primary' ? html`<${Pill} tone=${p.purpose === 'hedge' ? 'pen' : 'warn'}>${PURPOSE_LABEL[p.purpose] || p.purpose}<//> ` : null}${p.instrument.symbol ? p.instrument.name : ''}</div>` },
        { label: 'Owner', render: (p) => p.owner.name },
        { label: 'Strategy instance', render: (p) => (p.strategy ? link(p.strategy.name, () => openStrategy(p.strategy.id), `Strategy instance ${p.strategy.id}`) : none()) },
        { label: 'Quantity', align: 'r', render: (p) => html`${fmtQty(p.qty)}<div class=${`sub ${p.direction === 'long' ? 'gain' : p.direction === 'short' ? 'loss' : ''}`}>${p.direction}</div>` },
        { label: 'Average cost', align: 'r', render: (p) => (p.ledgerCarried ? '' : isNum(p.avgCost) ? fmtPrice(p.avgCost) : html`<${Missing} reason="No cost basis" />`) },
        { label: 'Current market price', align: 'r', render: (p) => (p.ledgerCarried ? '' : html`<${Price} obs=${p.priceObs} value=${p.price} reason=${p.missingReason || 'No price available'} />`) },
        { label: 'Market value or notional', align: 'r', render: value },
        { label: 'Unrealized P&L', align: 'r', title: `In the position's currency, with the ${rc} equivalent beneath when it differs`, render: (p) => (p.ledgerCarried ? '' : html`<${Money} value=${p.unrealized} ccy=${p.ccy} signed reason=${p.missingReason} />
          ${p.ccy !== rc && !p.missing ? html`<div class="sub"><${Money} value=${p.unrealizedRc} ccy=${rc} signed reason=${`No conversion rate from ${p.ccy} to ${rc}`} /></div>` : null}`) },
      ]} empty=${{ title: 'No open positions', children: 'Positions appear here once a paper trade in this Account fills.' }} /><//>`;
}

export default function Account({ args, book, status }) {
  const unit = book.units.find((u) => u.id === args[0] && u.kind === 'account') || null;
  const treasury = book.units.find((u) => u.kind === 'treasury');
  const rc = book.reportingCcy;
  // Opening an Account's page is choosing it: tickets and the Strategies page then default to it.
  useEffect(() => { if (unit) setUnit(unit.id); }, [unit?.id]);
  const res = useAccount(book.id, unit?.id);
  // Transfers change only when something is recorded, so they reload on changes rather than on the clock.
  const history = useLive(() => (unit ? get(`/api/books/${book.id}/accounting/history`, { scope: unit.id, type: 'transfer', limit: 1000 }) : null), [book.id, unit?.id], { interval: false });
  if (!unit) return html`<div class="page-head"><div><h1>Account</h1><div class="sub">${book.name}</div></div></div>
    <div class="panel"><${Empty} title="Not an Account of this Book">${args[0] ? `"${args[0]}" is` : 'That is'} not an Account of ${book.name}. Choose an Account in the sidebar, or go to <a href="#/treasury">Treasury</a>, which lists every Account of this Book.<//></div>`;
  const reload = () => { res.reload(); history.reload(); };
  const open = (Comp, props = {}) => openOverlay((close) => html`<${Comp} book=${book} status=${status} unitId=${unit.id} fixed ...${props} onClose=${close} onDone=${reload} />`);
  const act = {
    fund: () => open(TransferDialog, { from: treasury.id, to: unit.id }),
    giveBack: () => open(TransferDialog, { from: unit.id, to: treasury.id }),
    transfer: () => open(TransferDialog, { from: unit.id, accountsOnly: true }),
    borrow: () => open(ArrangementDialog, { mode: 'loan', side: 'borrow_cash' }),
    borrowConvert: () => open(BorrowConvertDialog),
    convert: () => open(ConvertDialog),
  };
  const acc = (tab, label) => html`<a class="btn small" href=${`#/accounting/${tab}/${unit.id}`}>${label}</a>`;
  const head = html`<div class="page-head"><div><h1>${unit.name}</h1><div class="sub" style="max-width:100ch">Account of ${book.name}, reporting in ${rc}. <${Pill} tone="pen">in use<//> on trade tickets and the Strategies page.</div></div>
    <div class="actions"><span class="note">In Accounting</span>${acc('balance', 'Balance sheet')}${acc('positions', 'Positions')}${acc('pnl', 'P&L')}${acc('history', 'History')}
      <span style="width:6px"></span><a class="btn primary" href="#/markets/US_CASH" title="Open the US Based Marketplace with this Account selected">Trade</a><a class="btn" href="#/strategy" title="Open the Strategies page with this Account selected">Build a strategy</a></div></div>`;
  const d = res.data?.unitId === unit.id ? res.data : null;
  if (!d) return html`${head}${res.error ? html`<${ErrorNote} error=${res.error} />` : html`<div class="note">Loading the Account…</div>`}`;
  const { sheet, positions, unit: o } = d;
  const net = sheet.representedBy.find((r) => r.key === 'internal').cells[unit.id];
  const cashLoans = sheet.borrowings.filter((b) => b.principal !== null);
  const owed = !cashLoans.length ? none('None') : cashLoans.some((b) => !isNum(b.principalRc)) ? html`<${Missing} reason=${`No conversion rate into ${rc} for a borrowed currency`} />` : fmtMoney(cashLoans.reduce((a, b) => a + b.principalRc, 0), rc);
  const arrangements = positions.positions.filter((p) => FINANCING.includes(p.family)).map((p) => ({ ...p, name: p.instrument.name, rawTerms: p.instrument.terms }));
  return html`<div>
    ${head}
    ${res.error ? html`<div style="margin-bottom:10px"><${ErrorNote} error=${res.error} /></div>` : null}
    <section class="panel" style="margin-bottom:12px"><div class="body" style="padding:9px 4px 8px"><div class="stats">
      <${Stat} label="Net asset value" value=${html`<${NavValue} nav=${sheet.nav} ccy=${rc} />`} sub=${sheet.nav.provisional ? 'Provisional: see what it rests on below' : 'This Account alone'} />
      <${Stat} label=${`Unrealized P&L (${rc})`} value=${html`<${Money} value=${o?.unrealized} ccy=${rc} signed bare />`} sub=${o && !o.unrealizedComplete ? html`<${Pill} tone="warn" title="An open position has no price or no conversion rate. It is carried at cost and left out of this figure.">provisional<//>` : 'On open positions'} />
      <${Stat} label="Open positions" value=${positions.positions.length} sub="Including financing legs" />
      <${Stat} label="Internal funding received" value=${net.byCurrency.length ? net.byCurrency.map((x) => html`<div>${fmtMoney(x.amount, x.ccy)}</div>`) : none('None')} sub="Net, inside the Book" />
      <${Stat} label="Borrowed by this Account" value=${owed} sub=${sheet.borrowings.length ? `Cash principal of ${cashLoans.length} of ${sheet.borrowings.length} record${sheet.borrowings.length === 1 ? '' : 's'}` : 'This Account has not borrowed'} />
    </div></div></section>
    ${sheet.nav.provisional ? html`<div class="stack" style="margin-bottom:12px;gap:8px">
      ${status.data.market.connection === 'awaiting' ? html`<${Awaiting} compact what="Prices and conversion rates arrive with the Shaffer MarketData connection. Until then a figure that depends on a missing one is provisional. Enter the price by hand on the instrument; nothing is estimated in its place." />` : null}
      <${NavAffected} nav=${sheet.nav} /></div>` : null}
    <div class="toolbar">
      <${Button} onClick=${act.fund}>Fund from Treasury<//><${Button} onClick=${act.giveBack}>Return to Treasury<//><${Button} onClick=${act.transfer}>Transfer to another Account<//>
      <span style="width:8px"></span>
      <${Button} onClick=${act.borrow}>Borrow cash<//><${Button} onClick=${act.borrowConvert}>Borrow and convert<//><${Button} onClick=${act.convert}>Convert currency<//>
    </div>
    <div class="stack">
      <div class="cols-2" style="align-items:start">
        <${Panel} title="Cash by currency" note=${`Held by ${unit.name}`} flush>
          <${CashBuckets} cash=${positions.cash} rc=${rc} who=${unit.name} empty=${{ title: 'This Account holds no cash yet', children: 'Fund it from Treasury, or borrow in the Account itself.' }} />
          ${positions.cash.length ? html`<div class="small muted" style="padding:8px 12px">Hover a line for what it means. Restricted cash is short-sale proceeds and collateral, not buying power. A transfer or repayment can take at most the amount available to withdraw.</div>` : null}<//>
        <${Panel} title="Balance sheet" note="This Account alone" flush actions=${acc('balance', 'Full balance sheet')}>
          <${Sheet} sheet=${sheet} unit=${unit} rc=${rc} />
          ${sheet.lines.length ? html`<div class="small muted" style="padding:8px 12px">Liabilities are amounts this Account owes. Cash it borrowed directly is its own liability, not Treasury's. Hover a line for what it holds.</div>` : null}<//>
      </div>
      <${Panel} title="Borrowings of this Account" note=${`Borrowed directly by ${unit.name} and owed by it`} flush actions=${html`<${Button} small onClick=${act.borrow}>Borrow cash<//><${Button} small onClick=${act.borrowConvert}>Borrow and convert<//>`}>
        <${BorrowingTable} book=${book} rows=${sheet.borrowings} arrangements=${arrangements} onDone=${reload}
          empty=${{ title: 'This Account has not borrowed', children: 'An Account can borrow cash or currencies directly, with Borrow cash or Borrow and convert. Borrowing is not restricted to Treasury.' }} />
        <div class="small muted" style="padding:8px 12px">Each borrowing is one record with one ID. The same record appears in <a href="#/treasury/borrowings">Treasury's oversight view</a>, labelled Account-originated, and once in the Book's consolidated balance sheet. It is never a second loan and never a Treasury liability.
          ${' '}Cash this Account has lent or placed on deposit is listed under Open positions and managed in Treasury, Borrowings and lending.</div><//>
      <div class="cols-2" style="align-items:start">
        <${Funding} book=${book} unit=${unit} sheet=${sheet} history=${history.data} />
        <${HoldingsPanel} d=${positions} />
      </div>
      <${Positions} unit=${unit} d=${positions} rc=${rc} />
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:6px 0 5px;border-bottom:1.5px solid var(--rule-strong)"><h2>OTC collateral</h2><span class="note">Agreements that cover ${unit.name}, and the collateral its swaps, credit default swaps, forwards and OTC options post and receive. The whole Book is under <a href="#/treasury/collateral">Treasury, Collateral</a>.</span></div>
      <${CollateralDesk} book=${book} unit=${unit} />
    </div>
  </div>`;
}
