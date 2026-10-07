// Browser-level driver: the real interface in Chromium (Playwright), against a disposable server.
//
// What is done in the interface: creating the Book and its Account, depositing and transferring
// cash, registering each instrument in the registry form, every ticket, every preview and
// confirmation, closing and resizing from the strategy instance, events recorded by hand
// (dividends, splits, manual cash flows, manual prices), and reading the result back from the
// Accounting tabs. What is done through the API, because it stands in for something outside the
// Terminal or has no screen: fixtures (quotes, FX, borrow), the absolute clock, the Book's
// paper-desk assumptions (fee schedule and so on), the explicit engine cycle, and the restart.
//
// After every step three comparisons are made:
//   spec  vs API      the ledger and accounting views (the same check the API level makes)
//   API   vs screens  every figure the Accounting tabs display must be the API's figure, to the
//                     decimals shown: a display error is caught here
//   spec  vs screens  the hand-calculated figure against what is on screen
//
// Locators go by what a person reads: field labels, button text, tab names, table headers and
// section titles. There are no CSS paths into a screen's layout. The pieces that differ by product
// family (the registration form's contract fields, the ticket) live in drivers/browser/<family>.mjs.

import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openApiTerminal } from './api.mjs';
import { actThroughClient, createContext, fixtureCalls, rateFixtureCalls, TRADE_ACTIONS } from '../lib/actions.mjs';
import { diff, numbersAgree, Shown } from '../lib/compare.mjs';
import { eventsSince, normalizePreview, normalizeResult, observeState } from '../lib/normalize.mjs';
import { specKey } from '../lib/runner.mjs';
import { getProduct } from '../../../server/core/catalog.js';

const DEFAULT_PLAYWRIGHT = '/opt/npm-tools/node_modules/playwright/index.mjs';
const DEFAULT_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ACCRUAL_TYPES = new Set(['accrual', 'accrual.coupon', 'accrual.interest', 'accrual.fee']);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const startsWith = (s) => new RegExp(`^\\s*${esc(s)}`);

/** Playwright is not a dependency of the Terminal: it is found through SDT_PLAYWRIGHT, an installed package, or this machine's copy. */
export async function loadPlaywright() {
  const tried = [];
  for (const spec of [process.env.SDT_PLAYWRIGHT, 'playwright', DEFAULT_PLAYWRIGHT].filter(Boolean)) {
    try { return await import(spec.startsWith('/') || spec.startsWith('.') ? pathToFileURL(resolve(spec)).href : spec); } catch (err) { tried.push(`${spec}: ${err.code || err.message}`); }
  }
  throw new Error(`The browser level needs Playwright. Set SDT_PLAYWRIGHT to its index.mjs, or install it outside this repository.\n${tried.join('\n')}`);
}

export async function launchBrowser({ headed = false, slow = 0 } = {}) {
  const { chromium } = await loadPlaywright();
  const executablePath = process.env.SDT_CHROMIUM || (existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined);
  return chromium.launch({ headless: !headed, slowMo: slow, executablePath });
}

// ---------------------------------------------------------------------------------------------
// Reading numbers off a screen
// ---------------------------------------------------------------------------------------------

/** The first number in a piece of displayed text, with the decimals it was shown to. A dash or nothing is a missing value. */
export function shown(text) {
  const t = String(text ?? '').replace(/ /g, ' ').trim();
  const m = /([+\-−])?\s?(\d[\d,]*)(\.\d+)?/.exec(t);
  if (!m) return new Shown(null, 0, t);
  const value = Number(`${m[2].replace(/,/g, '')}${m[3] || ''}`) * (m[1] === '-' || m[1] === '−' ? -1 : 1);
  return new Shown(value, m[3] ? m[3].length - 1 : 0, t);
}
const firstLine = (cell) => String(cell ?? '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';

// ---------------------------------------------------------------------------------------------
// The page, by labels
// ---------------------------------------------------------------------------------------------

export function createUi(page, baseUrl) {
  const ui = {
    page, baseUrl,
    /** A form field by its label: the block that holds the label, its control and its hint. */
    field: (scope, label) => scope.locator('.field').filter({ has: page.locator('label', { hasText: label instanceof RegExp ? label : startsWith(label) }) }).first(),
    input: (scope, label) => ui.field(scope, label).locator('input').first(),
    select: (scope, label) => ui.field(scope, label).locator('select').first(),
    /** One option of a segmented choice (Buy | Sell | Sell short), by its text. */
    option: (scope, label, text) => ui.field(scope, label).getByRole('button', { name: exactly(text) }),
    dialog: (name) => page.getByRole('dialog', { name }),
    button: (scope, name) => scope.getByRole('button', { name: name instanceof RegExp ? name : exactly(name) }),
    /** A panel by its heading. */
    section: (scope, title) => scope.locator('section.panel, .panel').filter({ has: page.locator('header h3, header h2', { hasText: title instanceof RegExp ? title : startsWith(title) }) }).first(),
    /** Wait until the browser has drawn what the last response changed. A condition, not a delay. */
    drawn: () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))),

    async goto(hash) {
      await page.goto(`${baseUrl}/${hash}`);
      await page.locator('.shell .topbar').waitFor();
    },
    async reloadAt(hash) {
      await page.goto(`${baseUrl}/${hash}`);
      await page.reload();
      await page.locator('.shell .topbar').waitFor();
    },
    /** Click something and return the JSON of the API response it causes. */
    async respondsTo(method, pathPattern, click) {
      const wait = page.waitForResponse((r) => r.request().method() === method && pathPattern.test(new URL(r.url()).pathname));
      await click();
      const res = await wait;
      let body = null;
      try { body = await res.json(); } catch { /* no body */ }
      return { ok: res.ok(), status: res.status(), body };
    },
    async toast(text) {
      await page.locator('.toasts .toast', { hasText: text }).first().waitFor();
    },
    /** Close every dialog and drawer that is open (each listens for Escape). */
    async closeOverlays() {
      for (let i = 0; i < 6 && await page.getByRole('dialog').count(); i++) {
        await page.keyboard.press('Escape');
        await ui.drawn();
      }
      const left = await page.getByRole('dialog').count();
      if (left) throw new Error(`${left} dialog(s) did not close.`);
    },
    /** Every table inside `scope`, as text: its headers and rows, under the heading of the panel it sits in. */
    tables: (scope) => scope.evaluate((root) => [...root.querySelectorAll('table')].filter((t) => !t.parentElement.closest('table')).map((t) => {
      const panel = t.closest('section.panel, .panel');
      return {
        title: (panel?.querySelector('header h3, header h2')?.innerText || '').trim(),
        head: [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim()),
        rows: [...t.querySelectorAll('tbody tr')].map((tr) => ({ group: tr.classList.contains('group'), cells: [...tr.children].map((td) => td.innerText.trim()) })),
        foot: [...t.querySelectorAll('tfoot tr')].map((tr) => [...tr.children].map((td) => td.innerText.trim())),
      };
    })),
    /** Open an instrument from its Marketplace and return its drawer. */
    async openInstrument(inst) {
      await ui.closeOverlays();
      await ui.goto(`#/markets/${inst.marketView}`);
      const label = inst.symbol || inst.name;
      await page.getByPlaceholder(/Filter by symbol/).fill(label);
      const row = page.locator('main table tbody tr').filter({ has: page.locator('.sym', { hasText: exactly(label) }) }).first();
      await row.click();
      const drawer = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^Trade/ }) });
      await drawer.waitFor();
      return drawer;
    },
    async tab(scope, name) {
      const tab = scope.getByRole('tab', { name: startsWith(name) }).first();
      await tab.click();
      await ui.drawn();
    },
    /** Open a strategy instance's drawer from the Accounting positions of its owner. */
    async openStrategy(ctx, strategyId) {
      await ui.closeOverlays();
      await ui.reloadAt(`#/accounting/positions/${ctx.accountId}`);
      await page.locator(`main a[title="Strategy instance ${strategyId}"]`).first().click();
      const drawer = page.getByRole('dialog').filter({ has: page.locator('header h3', { hasText: /^Positions/ }) });
      await drawer.waitFor();
      return drawer;
    },
  };
  return ui;
}

// ---------------------------------------------------------------------------------------------
// The trade preview and its confirmation
// ---------------------------------------------------------------------------------------------

/** What the preview dialog displays for each leg and in its cash table. */
async function readPreview(ui, modal) {
  const tables = await ui.tables(modal);
  const legsTable = tables.find((t) => t.head.includes('Estimated fill'));
  const col = (name) => legsTable.head.findIndex((h) => startsWith(name).test(h));
  const legs = (legsTable?.rows || []).filter((r) => !r.group && r.cells.length > 2).map((r) => {
    const cash = r.cells[col('Cash')] || '';
    const fees = /fees\s+([\d,.]+)/.exec(cash);
    return {
      label: firstLine(r.cells[col('Leg')]),
      estimate: shown(firstLine(r.cells[col('Estimated fill')])),
      settles: /\d{4}-\d{2}-\d{2}/.exec(r.cells[col('Settles')] || '')?.[0] || null,
      cash: shown(firstLine(cash)),
      fees: fees ? shown(fees[1]) : new Shown(0, 2, ''),
    };
  });
  const cashTable = tables.find((t) => t.rows.some((r) => /^Cash required/.test(r.cells[0] || '')));
  const cash = {};
  if (cashTable) {
    cashTable.head.slice(1).forEach((ccy, i) => {
      const line = (label) => { const row = cashTable.rows.find((r) => startsWith(label).test(r.cells[0] || '')); return row ? shown(row.cells[i + 1]) : undefined; };
      cash[ccy] = { purchases: line('Purchases'), proceeds: line('Sale proceeds'), restrictedProceeds: line('Short-sale proceeds'), fees: line('Fees and commissions'), margin: line('Margin'), collateral: line('Collateral top-up'), required: line('Cash required'), available: line('Available to trade now') };
    });
  }
  const blocks = (await modal.locator('.checks .notice.err').allInnerTexts()).map((x) => x.trim());
  return { legs, cash, blocks };
}

/** The displayed preview must show the figures the server sent for it. */
function previewDisplayProblems(pv, screen) {
  const out = [];
  const trade = pv.legs.filter((l) => l.kind === 'trade');
  const rows = screen.legs.filter((r) => /^(Buy|Sell)/.test(r.label));
  if (rows.length !== trade.length) out.push(`preview screen: ${rows.length} trade legs are displayed, the preview has ${trade.length}`);
  trade.forEach((l, i) => {
    const r = rows[i];
    if (!r) return;
    const at = `preview screen, leg ${l.n}`;
    if (typeof l.price?.estimate === 'number' && !numbersAgree(l.price.estimate, r.estimate)) out.push(`${at}: estimated fill shows "${r.estimate.text}", the preview has ${l.price.estimate}`);
    if (l.settleDate && r.settles !== l.settleDate) out.push(`${at}: settlement shows ${r.settles}, the preview has ${l.settleDate}`);
    if (typeof l.cash === 'number' && !numbersAgree(l.cash, r.cash)) out.push(`${at}: cash shows "${r.cash.text}", the preview has ${l.cash}`);
    if (l.feeTotal && !numbersAgree(l.feeTotal, r.fees)) out.push(`${at}: fees show "${r.fees.text}", the preview has ${l.feeTotal}`);
  });
  for (const c of Object.values(pv.totals.cash || {})) {
    const s = screen.cash[c.ccy];
    if (!s) { out.push(`preview screen: no ${c.ccy} column in the cash table`); continue; }
    for (const k of ['purchases', 'proceeds', 'restrictedProceeds', 'fees', 'margin', 'collateral']) if (c[k] && !(s[k] && numbersAgree(c[k], s[k]))) out.push(`preview screen: ${k} shows "${s[k]?.text ?? 'nothing'}" in ${c.ccy}, the preview has ${c[k]}`);
    for (const k of ['required', 'available']) if (!(s[k] && numbersAgree(c[k], s[k]))) out.push(`preview screen: ${k} shows "${s[k]?.text ?? 'nothing'}" in ${c.ccy}, the preview has ${c[k]}`);
  }
  return out;
}

/**
 * Press the button that asks for a preview, read the dialog, and confirm it unless a refusal is expected.
 * `open` clicks the button. Returns { preview, result, refusal, problems, strategy }.
 */
export async function previewAndConfirm(ui, ctx, open, { expectsRefusal, edit, inspect }) {
  const { page } = ui;
  const asked = await ui.respondsTo('POST', /^\/api\/strategies\/(preview|[^/]+\/preview-action)$/, open);
  if (!asked.ok) {
    // The interface shows the server's reason as a message; it must be on screen.
    await page.locator('.toasts .toast, .notice.err', { hasText: asked.body?.error || 'no message' }).first().waitFor();
    return { refusal: { message: asked.body?.error, status: asked.status, code: asked.body?.code, where: 'preview request, shown as a message' } };
  }
  let pv = asked.body;
  const modal = ui.dialog(/^Preview: /);
  await modal.waitFor();
  // Optional, for a ticket whose amount is changed in the preview itself (a part repayment): `edit(modal, pv)` changes
  // the legs on screen, then the edited package is re-checked, as the dialog requires before it can be confirmed.
  if (edit) {
    await edit(modal, pv);
    const again = await ui.respondsTo('POST', /^\/api\/strategies\/preview$/, () => ui.button(modal, 'Re-check edited package').click());
    if (!again.ok) {
      await modal.locator('.notice.err', { hasText: again.body?.error || 'no message' }).first().waitFor();
      await ui.button(modal, 'Cancel').click();
      await modal.waitFor({ state: 'hidden' });
      return { refusal: { message: again.body?.error, status: again.status, code: again.body?.code, where: 're-check of the edited preview, shown in the dialog' } };
    }
    pv = again.body;
    await modal.locator('.notice.warn', { hasText: 'You changed the package' }).waitFor({ state: 'hidden' });
    await ui.drawn();
  }
  const screen = await readPreview(ui, modal);
  const preview = normalizePreview(pv, ctx);
  const problems = previewDisplayProblems(pv, screen);
  // Optional: a family's own check of what the dialog displays for its legs (`inspect(modal, pv)` returns mismatches).
  if (inspect) problems.push(...await inspect(modal, pv));
  const confirm = modal.getByRole('button', { name: /^Confirm/ });
  if (pv.blocking) {
    if (!screen.blocks.length) problems.push('The preview is blocked but the dialog shows no blocking message.');
    if (await confirm.isEnabled()) problems.push('The preview is blocked but its Confirm button is enabled.');
    await ui.button(modal, 'Cancel').click();
    await modal.waitFor({ state: 'hidden' });
    return { preview, problems, refusal: { message: screen.blocks.join(' | ').replace(/^Blocks submission\.\s*/g, ''), code: pv.checks.find((c) => c.level === 'error')?.code, where: 'preview dialog, Confirm disabled' } };
  }
  if (expectsRefusal) {
    await ui.button(modal, 'Cancel').click();
    await modal.waitFor({ state: 'hidden' });
    return { preview, problems };
  }
  const sent = await ui.respondsTo('POST', /^\/api\/strategies$/, () => confirm.click());
  if (!sent.ok) {
    await modal.locator('.notice.err', { hasText: sent.body?.error || 'no message' }).first().waitFor();
    return { preview, problems, refusal: { message: sent.body?.error, status: sent.status, code: sent.body?.code, where: 'confirmation, shown in the preview dialog' } };
  }
  await modal.waitFor({ state: 'hidden' });
  const strategy = sent.body.strategy;
  if (sent.body.duplicate) problems.push('The confirmation was reported as a duplicate submission.');
  return { preview, problems, strategy, result: normalizeResult(strategy, pv.token, ctx) };
}

// ---------------------------------------------------------------------------------------------
// Reading the Accounting screens
// ---------------------------------------------------------------------------------------------

const INTO = { 'settled cash': 'cash', 'restricted cash': 'cash.restricted', margin: 'cash.margin' };

async function readAccountingTab(ui, ctx, tab, scope, ready) {
  await ui.goto(`#/accounting/${tab}/${scope}`);
  await ui.page.locator('main').locator('header h3, header h2', { hasText: ready }).first().waitFor();
  await ui.drawn();
  return ui.tables(ui.page.locator('main'));
}
const tableOf = (tables, title) => tables.find((t) => (title instanceof RegExp ? title : startsWith(title)).test(t.title));
const rowsOf = (t) => (t?.rows || []).filter((r) => !r.group);
const cellOf = (t, row, header) => { const i = t.head.findIndex((h) => startsWith(header).test(h)); return i < 0 ? undefined : row.cells[i]; };

/** Everything the Accounting page displays for the scenario's Account (and the Book's net asset value). */
export async function readScreens(ui, ctx, t) {
  const { page } = ui;
  const acct = ctx.accountId;
  const screen = { cash: {}, nav: {}, provisional: {}, positions: [], holdings: {}, pending: [], pnl: {}, balance: {}, borrowings: [], history: [] };
  const stat = async (label) => {
    const el = page.locator('main .stat').filter({ has: page.locator('.k', { hasText: startsWith(label) }) }).first();
    return (await el.locator('.v').innerText()).trim();
  };

  // ---- open positions (reloaded, so nothing on the page is from before the step) ----
  await ui.reloadAt(`#/accounting/positions/${acct}`);
  await page.locator('main .stat .k', { hasText: /^Net asset value/ }).first().waitFor();
  await page.locator('main header h3', { hasText: /^Net assets by currency|^Positions|^Cash and financing/ }).first().waitFor();
  await ui.drawn();
  let tables = await ui.tables(page.locator('main'));
  const navText = await stat('Net asset value');
  screen.nav.account = shown(navText);
  screen.provisional.account = /provisional/i.test(navText);
  const strip = tables.find((x) => /^Cash,/.test(x.head[0] || ''));
  for (const r of rowsOf(strip)) {
    screen.cash[r.cells[0]] = { settled: shown(cellOf(strip, r, 'Settled')), unsettled: shown(cellOf(strip, r, 'Unsettled')), reserved: shown(cellOf(strip, r, 'Reserved')), restricted: shown(cellOf(strip, r, 'Restricted')), margin: shown(cellOf(strip, r, 'Margin')) };
  }
  const cashTable = tableOf(tables, 'Cash and financing balances');
  for (const r of rowsOf(cashTable)) {
    const ccy = cellOf(cashTable, r, 'Currency');
    if (screen.cash[ccy]) screen.cash[ccy].availableToTrade = shown(cellOf(cashTable, r, 'Available to trade'));
  }
  const pos = tableOf(tables, 'Positions');
  screen.positions = rowsOf(pos).map((r) => {
    const qty = (cellOf(pos, r, 'Quantity') || '').split('\n').map((x) => x.trim()).filter(Boolean);
    // Accrued income or cost is shown with the position ("accrued 19,456.52 USD"), signed; nothing is shown when it is zero.
    const accruedText = /(?:^|\n)\s*accrued\s+([^\n]+)/.exec(cellOf(pos, r, 'Accrued, collateral') || '')?.[1];
    return {
      accrued: accruedText ? shown(accruedText) : undefined,
      label: firstLine(cellOf(pos, r, 'Instrument and role')), qty: shown(qty[0]), direction: qty[1] || '',
      avgCost: shown(firstLine(cellOf(pos, r, 'Average cost'))), price: shown(firstLine(cellOf(pos, r, 'Current market price'))),
      value: shown(firstLine(cellOf(pos, r, 'Value or notional'))), unrealized: shown(firstLine(cellOf(pos, r, 'Unrealized'))),
      // A contract on a notional amount (future, forward, swap) shows its notional there, labelled "notional", with the margin posted beneath.
      valueIsNotional: /(?:^|\n)\s*notional\s*(?:\n|$)/.test(cellOf(pos, r, 'Value or notional') || ''),
      marginShown: (() => { const m = /(?:^|\n)\s*margin\s+([^\n]+)/.exec(cellOf(pos, r, 'Value or notional') || ''); return m ? shown(m[1]) : undefined; })(),
      extra: cellOf(pos, r, 'Accrued, collateral') || '',
    };
  });
  const held = tableOf(tables, 'Holdings by instrument');
  for (const r of rowsOf(held)) {
    const text = r.cells.slice(1).join(' ');
    const n = (re) => { const m = re.exec(text); return m ? shown(m[1]).value : 0; };
    screen.holdings[firstLine(r.cells[0]).split(/\s/)[0]] = { long: n(/Long ([\d,.]+)/), short: n(/Short ([\d,.]+)/) };
  }

  // ---- pending trades ----
  tables = await readAccountingTab(ui, ctx, 'pending', acct, /^Executed trades/);
  const settle = tableOf(tables, 'Executed trades');
  screen.pending = rowsOf(settle).map((r) => ({
    label: firstLine(cellOf(settle, r, 'Instrument')), amount: shown(cellOf(settle, r, 'Cash movement')), ccy: /([A-Z]{3})\s*$/.exec(firstLine(cellOf(settle, r, 'Cash movement')))?.[1] || null,
    into: INTO[firstLine(cellOf(settle, r, 'Settles into'))] || firstLine(cellOf(settle, r, 'Settles into')), dueDate: firstLine(cellOf(settle, r, 'Expected settlement')),
  }));
  screen.openOrders = rowsOf(tableOf(tables, 'Open orders')).length + rowsOf(tableOf(tables, 'Partly filled')).length;
  screen.lifecycle = rowsOf(tableOf(tables, 'Lifecycle items')).map((r) => ({ item: firstLine(r.cells[1]), dueDate: firstLine(cellOf(tableOf(tables, 'Lifecycle items'), r, 'Due')) }));

  // ---- P&L and balance sheet: rows are found by the labels the API gives its own lines ----
  const [pnlApi, balApi] = await Promise.all([t.accounting(ctx.bookId, 'pnl', { scope: acct }), t.accounting(ctx.bookId, 'balance', { scope: acct })]);
  tables = await readAccountingTab(ui, ctx, 'pnl', acct, /^Statement for/);
  const stmt = tableOf(tables, 'Statement for');
  // A line is found by its label. A row may carry a control after the label ("show currencies"), so a label followed by more words also counts.
  const line = (tb, label) => {
    const rows = rowsOf(tb);
    const row = rows.find((r) => firstLine(r.cells[0]) === label) || rows.find((r) => firstLine(r.cells[0]).startsWith(`${label} `));
    return row ? shown(row.cells[row.cells.length - 1]) : undefined;
  };
  for (const c of pnlApi.categories) screen.pnl[c.key] = line(stmt, c.label);
  screen.pnl.unrealized = line(stmt, pnlApi.unrealized.label);
  screen.pnl.fx = line(stmt, pnlApi.fx.label);
  screen.pnl.total = line(stmt, 'Investment P&L');
  screen.pnl.navEnd = line(stmt, 'Net asset value now');

  tables = await readAccountingTab(ui, ctx, 'balance', acct, /^Balance sheet/);
  const bs = tables.filter((x) => /^Balance sheet/.test(x.title)).sort((a, b) => b.rows.length - a.rows.length)[0];
  for (const l of balApi.lines) screen.balance[l.key] = line(bs, l.label);
  screen.balance.assets = line(bs, 'Total assets');
  screen.balance.liabilities = line(bs, 'Total liabilities');
  screen.balance.netAssets = line(bs, 'Net assets');
  screen.balanceLines = rowsOf(bs).map((r) => firstLine(r.cells[0]));
  // The borrowing register is on the same page: one row per borrowing record (cash loan, repo, securities borrow).
  const bor = tables.find((x) => /^Borrowings/.test(x.title) && x.head.some((h) => /^Record/.test(h)));
  screen.borrowings = rowsOf(bor).map((r) => {
    const principal = (cellOf(bor, r, 'Principal') || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const costs = cellOf(bor, r, 'Interest and fees') || '';
    const amount = (label) => { const m = new RegExp(`${label}\\s*([^\\n]+)`).exec(costs); return m ? shown(m[1]) : undefined; };
    return { record: firstLine(r.cells[0]), principalText: principal[0] || '', principal: shown(principal[0]), worth: /^worth/.test(principal[1] || '') ? shown(principal[1]) : undefined, accrued: amount('accrued'), costToDate: amount('interest to date') };
  });

  // ---- history ----
  tables = await readAccountingTab(ui, ctx, 'history', acct, /^Audit trail/);
  const audit = tableOf(tables, 'Audit trail');
  screen.history = rowsOf(audit).map((r) => ({ id: Number(/#(\d+)/.exec(r.cells[0])?.[1]), event: (cellOf(audit, r, 'Event') || '').replace(/\s*\n\s*/g, ' | '), cash: firstLine(cellOf(audit, r, 'Cash effect')) }));

  // ---- the whole Book's net asset value ----
  await ui.goto(`#/accounting/positions/book`);
  await page.locator('main .stat .k', { hasText: /^Net asset value/ }).first().waitFor();
  await page.locator('main', { hasText: /The whole Book|consolidated|Whole Book/ }).first().waitFor();
  await page.locator('main table thead th', { hasText: /^Cash, \d+ owners/ }).first().waitFor();
  await ui.drawn();
  const bookNav = await stat('Net asset value');
  screen.nav.book = shown(bookNav);
  screen.provisional.book = /provisional/i.test(bookNav);
  return screen;
}

/** Screens against the API's state, then the spec's expectations against the screens. */
export function screenProblems(ctx, screen, { expected, state, events }) {
  const out = [];
  const say = (m) => out.push(`screen vs API: ${m}`);
  const num = (path, api, s) => {
    if (api === null || api === undefined) { if (s && s.value !== null && !(api === undefined && s.value === 0)) say(`${path} shows "${s.text}" where the API has no value`); return; }
    if (!s) return say(`${path} is ${api} in the API but is not on the screen`);
    if (!numbersAgree(api, s)) say(`${path} shows "${s.text}", the API has ${api}`);
  };
  const symbolOf = (key) => (key.startsWith('borrow:') ? null : ctx.inst(key).symbol || ctx.inst(key).name);

  // cash, by currency
  for (const [ccy, c] of Object.entries(state.cash.account || {})) {
    const s = screen.cash[ccy];
    const nonZero = ['settled', 'unsettled', 'reserved', 'restricted', 'margin'].some((k) => c[k] !== 0);
    if (!s) { if (nonZero) say(`cash in ${ccy} is missing from the cash table`); continue; }
    for (const k of ['settled', 'unsettled', 'reserved', 'restricted', 'margin', 'availableToTrade']) num(`cash ${ccy} ${k}`, c[k], s[k]);
  }
  num('net asset value of the Account', state.nav.account, screen.nav.account);
  num('net asset value of the Book', state.nav.book, screen.nav.book);
  if (screen.provisional.account !== state.provisional.account) say(`the Account's net asset value is ${screen.provisional.account ? '' : 'not '}marked provisional on screen; the API says ${state.provisional.account ? 'provisional' : 'final'}`);
  if (screen.provisional.book !== state.provisional.book) say(`the Book's net asset value is ${screen.provisional.book ? '' : 'not '}marked provisional on screen; the API says ${state.provisional.book ? 'provisional' : 'final'}`);

  // positions: every API position has its row, and no row is left over
  const mine = state.positions.filter((p) => p.owner === 'account');
  const rows = [...screen.positions];
  const matched = [];
  for (const p of mine) {
    const sym = symbolOf(p.instrument);
    const fits = (r) => (sym ? r.label === sym : startsWith(`Borrow of ${ctx.inst(p.instrument.slice(7)).symbol}`).test(r.label)) && numbersAgree(p.qty, r.qty);
    // Two lots of one instrument can have the same quantity: the row meant is then the one whose average cost agrees too.
    let i = typeof p.avgCost === 'number' && rows.filter(fits).length > 1 ? rows.findIndex((r) => fits(r) && numbersAgree(p.avgCost, r.avgCost)) : -1;
    if (i < 0) i = rows.findIndex(fits);
    if (i < 0) { say(`position ${p.instrument} ${p.qty} is not in the Positions table (rows: ${screen.positions.map((r) => `${r.label} ${r.qty.text}`).join('; ') || 'none'})`); matched.push(null); continue; }
    const [r] = rows.splice(i, 1);
    matched.push(r);
    const at = `position ${sym || p.instrument} ${p.qty}`;
    if (!String(r.direction).startsWith(p.direction)) say(`${at} is labelled "${r.direction}", the API says ${p.direction}`);
    if (!p.instrument.startsWith('borrow:')) {
      num(`${at} average cost`, p.avgCost, r.avgCost);
      num(`${at} price`, p.price, r.price);
      num(`${at} unrealized`, p.unrealized, r.unrealized);
    }
    // A loan, deposit or repo is displayed at its signed principal (what is carried in the ledger), not at a market value.
    // A contract on a notional amount is displayed at its notional, labelled as such, with the margin posted for it:
    // its open trade equity or mark is in the Unrealized column, compared above.
    if (r.valueIsNotional) {
      num(`${at} notional`, p.notional, r.value);
      if (p.margin || r.marginShown) num(`${at} margin posted`, p.margin || null, r.marginShown);
    } else num(`${at} value`, typeof p.carrying === 'number' ? p.carrying : p.value, r.value);
    // Accrued interest (a debt security's accrued coupon, a borrow's accrued fee): shown beside the position whenever it is not zero.
    if (p.accrued || r.accrued) num(`${at} accrued`, p.accrued || null, r.accrued);
    if (p.restrictedCash && !new RegExp(`restricted cash ${esc(Math.abs(p.restrictedCash).toLocaleString('en-US', { minimumFractionDigits: 2 }))}`).test(r.extra)) say(`${at}: restricted cash ${p.restrictedCash} is not shown with the position ("${r.extra.replace(/\n/g, ' | ')}")`);
  }
  for (const r of rows) say(`the Positions table has a row the API does not: ${r.label} ${r.qty.text}`);

  // gross holdings
  // The table read is the Account's. When another owner (Treasury) holds positions too, the Account's share of a
  // holding is taken from its own positions; an instrument only the other owner holds is not expected on this screen.
  const onlyMine = state.positions.every((p) => p.owner === 'account');
  const heldHere = {};
  for (const [key, all] of Object.entries(state.holdings)) {
    const own = mine.filter((p) => p.instrument === key);
    if (onlyMine) heldHere[key] = all;
    else if (own.length) heldHere[key] = { long: own.reduce((a, p) => a + Math.max(p.qty, 0), 0), short: own.reduce((a, p) => a + Math.max(-p.qty, 0), 0) };
  }
  for (const [key, h] of Object.entries(heldHere)) {
    const s = screen.holdings[symbolOf(key)];
    if (!s) { say(`holding of ${symbolOf(key)} is not in Holdings by instrument`); continue; }
    if (s.long !== h.long || s.short !== h.short) say(`holding of ${symbolOf(key)} shows long ${s.long} and short ${s.short}; the API has long ${h.long} and short ${h.short}`);
  }
  for (const sym of Object.keys(screen.holdings)) if (!Object.keys(heldHere).some((k) => symbolOf(k) === sym)) say(`Holdings by instrument lists ${sym}, which the API does not hold`);

  // pending settlements
  const pend = state.pending.filter((p) => p.owner === 'account');
  const left = [...screen.pending];
  for (const p of pend) {
    const i = left.findIndex((r) => r.label === symbolOf(p.instrument) && r.dueDate === p.dueDate && numbersAgree(p.amount, r.amount) && r.into === p.into);
    if (i < 0) say(`settlement of ${p.amount} ${p.ccy} due ${p.dueDate} into ${p.into} is not in the Pending trades tab (rows: ${screen.pending.map((r) => `${r.label} ${r.amount.text} ${r.dueDate} ${r.into}`).join('; ') || 'none'})`);
    else left.splice(i, 1);
  }
  for (const r of left) say(`the Pending trades tab has a settlement the API does not: ${r.label} ${r.amount.text} due ${r.dueDate}`);
  // These screens are the Account's: orders and lifecycle items of Treasury or of another Account are not on them.
  const ownOrders = state.openOrders.filter((o) => (o.owner ?? 'account') === 'account').length;
  if (screen.openOrders !== ownOrders) say(`${screen.openOrders} working or partly filled orders are shown; the API has ${ownOrders}`);
  const life = state.lifecycle.filter((x) => (x.owner ?? 'account') === 'account').length;
  if (screen.lifecycle.length !== life) say(`${screen.lifecycle.length} lifecycle items are shown; the API has ${life}`);

  // P&L and balance sheet
  for (const k of ['realized', 'dividends', 'couponInterest', 'borrowFunding', 'lendingIncome', 'commissions', 'fees', 'unrealized', 'fx', 'total']) num(`P&L ${k}`, state.pnl.account[k], screen.pnl[k]);
  num('P&L net asset value now', state.pnl.account.navEnd, screen.pnl.navEnd);
  const { local, capital, internal, results, ...lines } = state.balance.account;
  for (const [k, v] of Object.entries(lines)) num(`balance sheet ${k}`, v, screen.balance[k]);

  // the borrowing register: every borrowing of the Account has its row, with its quantity or principal, value, accrued and cost to date
  const owed = state.borrowings.filter((b) => b.owner === 'account');
  const regRows = [...screen.borrowings];
  const regMatched = [];
  for (const b of owed) {
    const sym = b.instrument ? symbolOf(b.instrument) : null;
    const size = b.qty ?? b.principal;
    const i = regRows.findIndex((r) => numbersAgree(Math.abs(size), r.principal) && (sym ? r.principalText.includes(sym) : r.principalText.includes(b.ccy)));
    if (i < 0) { say(`borrowing of ${size} ${sym || b.ccy} (${b.type}) is not in the Borrowings table (rows: ${screen.borrowings.map((r) => `${r.record} ${r.principalText}`).join('; ') || 'none'})`); regMatched.push(null); continue; }
    const [r] = regRows.splice(i, 1);
    regMatched.push(r);
    const at = `borrowing ${r.record} (${size} ${sym || b.ccy})`;
    if (b.qty !== null) num(`${at} value`, b.value, r.worth);
    num(`${at} accrued`, b.accrued, r.accrued);
    num(`${at} interest to date`, b.costToDate, r.costToDate);
  }
  for (const r of regRows) say(`the Borrowings table has a row the API does not: ${r.record} ${r.principalText}`);

  // history: every event of this step that the audit trail shows (accruals are folded away by default) is there, newest first
  const visible = events.filter((e) => !ACCRUAL_TYPES.has(e.type) && (e.owner === 'account' || e.entries.some((x) => x.owner === ctx.spec.book.account.name)));
  for (const e of visible) {
    const row = screen.history.find((r) => r.id === e.id);
    if (!row) say(`history event #${e.id} (${e.type}) is not in the audit trail`);
    else if (!row.event.includes(e.summary)) say(`history event #${e.id} shows "${row.event}", the API summary is "${e.summary}"`);
  }

  // The spec's own figures against what is displayed (only the parts a screen shows).
  const asState = {
    // An owner with no cash in any currency has no cash rows: that is "missing" (a spec states `cash: { account: null }`).
    cash: { account: Object.keys(screen.cash).length ? screen.cash : null }, nav: screen.nav, provisional: screen.provisional,
    pnl: { account: screen.pnl }, balance: { account: screen.balance },
    positions: mine.map((p, i) => (matched[i] ? { qty: matched[i].qty, avgCost: matched[i].avgCost, price: matched[i].price, unrealized: matched[i].unrealized, accrued: matched[i].accrued,
      // The value cell of a loan, deposit or repo shows its signed principal: it answers the spec's `carrying`, not its `value`.
      // A cell labelled "notional" answers the spec's `notional` and `margin` (the margin posted for the position).
      ...(typeof p.carrying === 'number' ? { carrying: matched[i].value } : matched[i].valueIsNotional ? { notional: matched[i].value, margin: matched[i].marginShown } : { value: matched[i].value }) } : {})),
    borrowings: owed.map((b, i) => (regMatched[i] ? { [b.qty !== null ? 'qty' : 'principal']: regMatched[i].principal, value: regMatched[i].worth, accrued: regMatched[i].accrued, costToDate: regMatched[i].costToDate } : {})),
  };
  // The spec's positions of the Account (a position stated without an owner is the Account's; Treasury's are not on this screen).
  const expectedMine = (expected.positions || []).filter((p) => (p.owner || 'account') === 'account');
  const wanted = prune({ cash: expected.cash, nav: expected.nav, provisional: expected.provisional, pnl: expected.pnl, balance: expected.balance, positions: expectedMine.length === mine.length ? expectedMine : undefined,
    borrowings: (expected.borrowings || []).filter((b) => (b.owner || 'account') === 'account').length === owed.length && (expected.borrowings || []).length === owed.length ? expected.borrowings : undefined }, asState);
  out.push(...diff(wanted, asState).map((m) => `spec vs screen: ${m}`));
  return out;
}

/** Keep only the parts of an expectation that the screen reading has a place for. */
function prune(expected, actual) {
  if (expected === undefined || actual === undefined) return undefined;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length ? expected.map((e, i) => prune(e, actual[i])) : expected;
  if (expected && typeof expected === 'object' && !(expected instanceof RegExp)) {
    if (!actual || typeof actual !== 'object' || actual instanceof Shown) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(expected)) if (k in actual && actual[k] !== undefined) { const p = prune(v, actual[k]); if (p !== undefined) out[k] = p; }
    return out;
  }
  return expected;
}

// ---------------------------------------------------------------------------------------------
// Setup and the actions every family shares
// ---------------------------------------------------------------------------------------------

const CASHFLOW_LABEL = { dividend: 'Dividend', coupon: 'Coupon', interest: 'Interest income', return_of_capital: 'Return of capital (lowers cost)', capital_call: 'Capital call (raises cost)', fee: 'Fee', commission: 'Commission', realized: 'Realized P&L', borrow: 'Securities-borrow cost', funding: 'Funding expense', lending: 'Securities-lending income' };
const LIFECYCLE_LABEL = { exercise: 'Exercise', assign: 'Early assignment', barrier: 'Barrier event', redeem: 'Early redemption', recall: 'Lender recall', cashflow: 'Manual cash flow', convert: 'Conversion' };
const ownerName = (ctx, key) => (key === 'treasury' ? 'Treasury' : ctx.spec.book.account.name);

/**
 * The Transfer dialog picks a default currency once the source's balances have loaded. Wait for that default
 * before choosing, as a person would see it first; choosing in the same instant would be overwritten by it.
 */
async function chooseCurrency(ui, dlg, ccy) {
  const select = ui.select(dlg, 'Currency');
  await select.locator('option:checked', { hasText: /^[A-Z]{3}$/ }).waitFor({ state: 'attached' });
  await ui.drawn();
  await select.selectOption(ccy);
}

async function setupInBrowser(ui, t, spec, family) {
  const { page } = ui;
  const ctx = createContext(spec);
  const b = spec.book;
  // ---- the Book, from the Book selector ----
  await ui.goto('#/books');
  await page.locator('.topbar select').first().selectOption({ label: '+ New Book…' });
  let dlg = ui.dialog('New Book');
  await ui.input(dlg, 'Book name').fill(b.name);
  await ui.input(dlg, 'Reporting currency').fill(b.reportingCcy);
  const first = b.capital.find((c) => c.ccy === b.reportingCcy);
  await ui.input(dlg, 'Starting paper capital').fill(first ? String(first.amount) : '');
  // FX and rate fixtures have to be in force before any cash is posted (entries are converted when posted).
  for (const [pair, rate] of Object.entries(spec.fx || {})) await t.fixture('fx', { pair, rate });
  for (const [kind, body] of rateFixtureCalls(spec)) await t.fixture(kind, body);
  const made = await ui.respondsTo('POST', /^\/api\/books$/, () => ui.button(dlg, 'Create Book').click());
  if (!made.ok) throw new Error(`The Book was not created: ${made.body?.error}`);
  await dlg.waitFor({ state: 'hidden' });
  ctx.bookId = made.body.id;
  ctx.treasuryId = made.body.units.find((u) => u.kind === 'treasury').id;
  await page.locator('.topbar select').first().locator('option:checked', { hasText: exactly(b.name) }).waitFor({ state: 'attached' });
  // Paper-desk assumptions (fee schedule, settlement lags, short terms): set through the API. See README.
  await t.updateSettings(ctx.bookId, b.settings);

  // ---- capital in other currencies, on the Treasury page ----
  for (const c of b.capital.filter((x) => x !== first)) {
    await ui.goto('#/treasury');
    await ui.button(page.locator('main'), 'Deposit or withdraw').first().click();
    dlg = ui.dialog('Deposit or withdraw capital');
    await ui.input(dlg, 'Currency').fill(c.ccy);
    await ui.input(dlg, 'Amount').fill(String(c.amount));
    const r = await ui.respondsTo('POST', /\/capital$/, () => ui.button(dlg, 'Record deposit').click());
    if (!r.ok) throw new Error(`Deposit of ${c.amount} ${c.ccy} was refused: ${r.body?.error}`);
    await dlg.waitFor({ state: 'hidden' });
  }

  // ---- the Account, and its funding from Treasury ----
  await ui.goto('#/treasury');
  await ui.button(page.locator('nav.rail'), 'New Account').click();
  dlg = ui.dialog('New Account');
  await ui.input(dlg, 'Account name').fill(b.account.name);
  const acct = await ui.respondsTo('POST', /\/accounts$/, () => ui.button(dlg, 'Create Account').click());
  if (!acct.ok) throw new Error(`The Account was not created: ${acct.body?.error}`);
  await dlg.waitFor({ state: 'hidden' });
  ctx.accountId = acct.body.id;
  for (const f of b.account.funding) {
    await ui.reloadAt('#/treasury');
    await ui.button(page.locator('main'), 'Transfer cash').first().click();
    dlg = ui.dialog('Transfer cash');
    await ui.select(dlg, 'Source').selectOption({ label: 'Treasury' });
    await ui.select(dlg, 'Destination').selectOption({ label: b.account.name });
    await chooseCurrency(ui, dlg, f.ccy);
    await ui.input(dlg, 'Amount').fill(String(f.amount));
    const r = await ui.respondsTo('POST', /\/transfers$/, () => ui.button(dlg, 'Record transfer').click());
    if (!r.ok) throw new Error(`Funding of ${f.amount} ${f.ccy} was refused: ${r.body?.error}`);
    await dlg.waitFor({ state: 'hidden' });
  }

  // ---- instruments, in the registry form ----
  for (const [key, draft] of Object.entries(spec.instruments)) {
    const r = await registerInBrowser(ui, family, draft, ctx);
    if (r.refusal) throw new Error(`Instrument "${key}" was not registered: ${r.refusal.message}`);
    ctx.instruments[key] = r.view;
    ctx.idToKey.set(r.view.id, key);
  }
  for (const [kind, body] of fixtureCalls(spec, ctx)) await t.fixture(kind, body);
  await t.tick();
  return ctx;
}

/** Register an instrument in the registry form. Returns { view } or { refusal } when the form will not register it. */
async function registerInBrowser(ui, family, draft, ctx) {
  const { page } = ui;
  await ui.closeOverlays();
  await ui.goto('#/instruments');
  await ui.button(page.locator('main'), 'New instrument').first().click();
  const dlg = ui.dialog('New instrument');
  await ui.select(dlg, 'Product type').selectOption(draft.productId);
  await ui.drawn();
  const register = ui.button(dlg, 'Register instrument');
  if (await register.isDisabled()) {
    // The form names why this product is not registered by hand and offers no fields for it.
    const why = (await dlg.locator('.notice').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
    await ui.button(dlg, 'Cancel').click();
    await dlg.waitFor({ state: 'hidden' });
    return { refusal: { message: why.join(' | ') || 'Register instrument is disabled and the form gives no reason.', where: 'registration form, Register disabled' } };
  }
  await ui.input(dlg, 'Name').fill(draft.name);
  if (draft.symbol) await ui.input(dlg, 'Symbol').fill(draft.symbol);
  if (draft.issuer) await ui.input(dlg, 'Issuer').fill(draft.issuer);
  if (draft.venueType === 'otc') await ui.option(dlg, 'Traded on', 'OTC').click();
  if (draft.venue) await ui.input(dlg, /^(Listing venue|Venue or platform)/).fill(draft.venue);
  if (draft.venueCountry) await ui.input(dlg, 'Venue country').fill(draft.venueCountry);
  await ui.input(dlg, 'Trading currency').fill(draft.tradingCcy);
  if (draft.domicile) await ui.input(dlg, 'Issuer domicile').fill(draft.domicile);
  if (draft.underlyingGeo) await ui.input(dlg, 'Underlying geography').fill(draft.underlyingGeo);
  await family.of(getProduct(draft.productId).family).contractTerms(ui, dlg, draft, ctx);
  const reg = await ui.respondsTo('POST', /^\/api\/instruments$/, () => register.click());
  if (!reg.ok) {
    await dlg.locator('.notice.err').first().waitFor();
    const message = reg.body?.error;
    await ui.button(dlg, 'Cancel').click();
    await dlg.waitFor({ state: 'hidden' });
    return { refusal: { message, status: reg.status, where: 'registration form message' } };
  }
  await dlg.waitFor({ state: 'hidden' });
  // The registration must have stored what the spec states (the form decides the market view from the venue).
  const view = reg.body;
  for (const [k, v] of Object.entries({ productId: draft.productId, marketView: draft.marketView, tradingCcy: draft.tradingCcy, venueCountry: draft.venueCountry || null, symbol: draft.symbol || null })) {
    if (view[k] !== v) throw new Error(`The instrument was registered with ${k} = ${view[k]}, the spec states ${v}.`);
  }
  return { view };
}

/** Actions done on the strategy instance's drawer or other shared screens, for every family. */
async function sharedAction(ui, t, ctx, step, family) {
  const { page } = ui;
  const expectsRefusal = step.status === 'unsupported' || step.status === 'blocked';
  const positionRow = (drawer, inst) => ui.section(drawer, 'Positions').locator('tbody tr').filter({ has: page.locator('.sym', { hasText: exactly(inst.symbol || inst.name) }) }).first();

  // A family may add interface paths of its own, or replace a shared one, for a step action:
  //   export const actions = { '<action>': async (ui, t, ctx, step, tools) => ({ preview?, result?, refusal? }) }
  // Returning nothing hands the step back to the shared path below.
  const own = family.of(ctx.spec.family).actions?.[step.action];
  if (own) {
    const out = await own(ui, t, ctx, step, { previewAndConfirm, expectsRefusal, positionRow });
    if (out !== undefined) return out;
  }

  switch (step.action) {
    case 'ticket': {
      // The ticket of the scenario's own family, unless the step names another family's ticket (`ticketOf`).
      const opened = await family.of(step.ticketOf || ctx.spec.family).ticket(ui, t, ctx, step);
      if (opened.refusal) return opened;
      const out = await previewAndConfirm(ui, ctx, opened.preview, { expectsRefusal });
      if (out.strategy && step.as && !ctx.lots.has(step.as)) ctx.nameLot(step.as, out.strategy.id, step.instrument);
      return out;
    }
    case 'close': case 'resize': {
      const lot = ctx.lot(step.lot);
      const drawer = await ui.openStrategy(ctx, lot.strategyId);
      let open;
      if (step.action === 'resize') {
        await ui.input(drawer, 'Resize, multiple of the current size').fill(String(step.factor));
        open = () => ui.button(drawer, 'Preview resize').click();
      } else if (step.scope === 'position') {
        const row = positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
        if ((step.percent ?? 100) !== 100) throw new Error('The Close button on a position closes all of it; use the ticket for a part.');
        open = () => ui.button(row, 'Close').click();
      } else {
        await ui.input(drawer, 'Close, share of every position').fill(String(step.percent ?? 100));
        open = () => ui.button(drawer, 'Preview close').click();
      }
      return previewAndConfirm(ui, ctx, open, { expectsRefusal });
    }
    case 'cashflow': case 'lifecycle': {
      const lot = ctx.lot(step.lot);
      const drawer = await ui.openStrategy(ctx, lot.strategyId);
      const row = positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
      const menu = row.locator('select').first();
      const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
      const kind = step.action === 'cashflow' ? 'cashflow' : step.body.action;
      const label = LIFECYCLE_LABEL[kind] || kind;
      if (!offered.includes(label)) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "${label}" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
      if (kind !== 'cashflow') throw new Error(`The browser driver does not yet record the lifecycle event "${kind}". Add it to drivers/browser.mjs (sharedAction).`);
      await menu.selectOption({ label });
      const dlg = ui.dialog(/^Manual cash flow/);
      await ui.select(dlg, 'Kind of cash flow').selectOption({ label: CASHFLOW_LABEL[step.category] });
      await ui.input(dlg, 'Amount').fill(String(step.amount));
      if (step.note) await ui.input(dlg, 'Note').fill(step.note);
      const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => ui.button(dlg, 'Record cash flow').click());
      if (!r.ok) { await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor(); return { refusal: { message: r.body?.error, status: r.status, where: 'dialog message' } }; }
      await dlg.waitFor({ state: 'hidden' });
      return {};
    }
    case 'register_instrument': {
      const r = await registerInBrowser(ui, family, step.draft, ctx);
      if (r.refusal) return { refusal: r.refusal };
      if (step.as) { ctx.instruments[step.as] = r.view; ctx.idToKey.set(r.view.id, step.as); }
      return {};
    }
    case 'corporate_action': {
      const inst = ctx.inst(step.instrument);
      const drawer = await ui.openInstrument(inst);
      await ui.tab(drawer, 'History and actions');
      const panel = ui.section(drawer, 'Dividends and corporate actions');
      const split = step.type === 'split';
      await ui.select(panel, 'Type').selectOption({ label: split ? 'Split' : 'Cash dividend' });
      await ui.input(panel, 'Ex-date').fill(step.exDate);
      if (step.payDate && step.payDate !== step.exDate) throw new Error('The corporate-action form has no pay date: the action is paid on its ex-date. Remove payDate from the step.');
      if (split) { await ui.input(panel, 'New shares').fill(String(step.ratioNum)); await ui.input(panel, 'For each old').fill(String(step.ratioDen)); } else await ui.input(panel, 'Amount per unit').fill(String(step.amount));
      const r = await ui.respondsTo('POST', /^\/api\/corporate-actions$/, () => ui.button(panel, 'Record').click());
      if (!r.ok) { await page.locator('.toasts .toast', { hasText: r.body?.error || 'no message' }).first().waitFor(); return { refusal: { message: r.body?.error, status: r.status, where: 'message' } }; }
      // It is now listed on the instrument, with its terms, as recorded by hand.
      await panel.locator('tbody tr', { hasText: step.exDate }).first().waitFor();
      return {};
    }
    case 'manual_price': {
      const inst = ctx.inst(step.instrument);
      const drawer = await ui.openInstrument(inst);
      await ui.tab(drawer, 'Overview');
      const panel = ui.section(drawer, 'Current market price');
      if (step.value !== undefined && step.value !== null) await ui.input(panel, /^Price \(/).fill(String(step.value));
      if (step.bid !== undefined && step.bid !== null) await ui.input(panel, 'Bid').fill(String(step.bid));
      if (step.ask !== undefined && step.ask !== null) await ui.input(panel, 'Ask').fill(String(step.ask));
      if (step.forDate) await ui.input(panel, 'Closing price or fixing for date').fill(step.forDate);
      if (step.note) await ui.input(panel, 'Note').fill(step.note);
      const r = await ui.respondsTo('POST', /^\/api\/observations$/, () => ui.button(panel, 'Save manual price').click());
      if (!r.ok) return { refusal: { message: r.body?.error, status: r.status, where: 'message' } };
      await ui.toast(/Manual price saved/);
      return {};
    }
    case 'transfer': {
      await ui.closeOverlays();
      await ui.reloadAt('#/treasury');
      await ui.button(page.locator('main'), 'Transfer cash').first().click();
      const dlg = ui.dialog('Transfer cash');
      await ui.select(dlg, 'Source').selectOption({ label: ownerName(ctx, step.from) });
      await ui.select(dlg, 'Destination').selectOption({ label: ownerName(ctx, step.to) });
      await chooseCurrency(ui, dlg, step.ccy);
      await ui.input(dlg, 'Amount').fill(String(step.amount));
      const r = await ui.respondsTo('POST', /\/transfers$/, () => ui.button(dlg, 'Record transfer').click());
      if (!r.ok) {
        await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
        return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: 'Transfer cash dialog message' } };
      }
      await dlg.waitFor({ state: 'hidden' });
      return {};
    }
    default:
      throw new Error(`The browser driver has no interface path for the step action "${step.action}". Add it to drivers/browser.mjs, or to \`actions\` in drivers/browser/${ctx.spec.family}.mjs.`);
  }
}

/**
 * The per-family drivers a scenario needs (drivers/browser/<family>.mjs): its own family's, one for the family of
 * every instrument it registers (the registration form's contract fields differ by family), and any family whose
 * ticket a step borrows with `ticketOf`. A missing file fails the setup step with its name.
 */
async function loadFamilyDrivers(spec) {
  const need = new Set([spec.family]);
  for (const d of Object.values(spec.instruments)) need.add(getProduct(d.productId).family);
  for (const st of spec.steps) {
    if (st.ticketOf) need.add(st.ticketOf);
    if (st.action === 'register_instrument' && getProduct(st.draft?.productId)) need.add(getProduct(st.draft.productId).family);
  }
  const loaded = new Map();
  for (const id of need) {
    const file = resolve(import.meta.dirname, 'browser', `${id}.mjs`);
    if (!existsSync(file)) throw new Error(`No browser driver for the "${id}" family: test/matrix/drivers/browser/${id}.mjs does not exist. See "Adding a family" in test/matrix/README.md.`);
    loaded.set(id, await import(pathToFileURL(file).href));
  }
  return { of: (id) => loaded.get(id) || (() => { throw new Error(`The "${id}" family driver was not loaded for this scenario.`); })() };
}

/** Steps that are not interface work: fixtures, the clock, the engine cycle, the restart. */
const THROUGH_API = new Set(['quote', 'close_price', 'fx_rate', 'rate', 'borrow', 'clock', 'cycle']);

/**
 * The driver runScenario() uses at browser level. `browser` is a launched Chromium; one page per scenario.
 */
export function browserDriver(browser, { shotsDir } = {}) {
  let t = null, context = null, page = null, ui = null, family = null;
  const pageErrors = [];
  const takeErrors = () => pageErrors.splice(0).map((m) => `browser console: ${m}`);

  /** Close the post-trade hedge prompt whenever the engine has produced one, so it never sits on top of the next action. */
  async function dismissHedgePrompts(ctx) {
    for (let i = 0; i < 20; i++) {
      const popup = page.getByRole('dialog', { name: /^Hedge/ });
      if (await popup.count()) {
        await popup.locator('header').getByRole('button', { name: 'Close' }).click();
        await popup.waitFor({ state: 'hidden' });
        continue;
      }
      const waiting = await t.hedgePrompts(ctx.bookId);
      if (!waiting.length) return;
      // The engine has a prompt the page has not shown yet: it opens when the page hears of the change.
      await popup.waitFor({ timeout: 8000 }).catch(() => {});
      if (!await popup.count()) { await page.reload(); await page.locator('.shell .topbar').waitFor(); }
    }
    throw new Error('Hedge prompts kept appearing.');
  }

  return {
    level: 'browser',
    async setup(spec, sandbox) {
      family = await loadFamilyDrivers(spec);
      t = await openApiTerminal({ sandbox, at: spec.start });
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });
      await page.addInitScript(() => { try { if (!localStorage.getItem('sdt.theme')) localStorage.setItem('sdt.theme', 'light'); } catch { /* private mode */ } });
      ui = createUi(page, t.url);
      const ctx = await setupInBrowser(ui, t, spec, family);
      ctx.lastEventId = (await eventsSince(t, ctx, 0)).at(-1)?.id ?? 0;
      return ctx;
    },
    describe: () => ({ ...(t?.describe() ?? {}), level: 'browser', browser: browser.version() }),
    async act(ctx, step) {
      await ui.closeOverlays();
      if (THROUGH_API.has(step.action)) return actThroughClient(t, ctx, step);
      if (step.action === 'restart') { await this.restart(ctx); return {}; }
      const out = await sharedAction(ui, t, ctx, step, family);
      await ui.closeOverlays();
      return { ...out, problems: [...(out.problems || []), ...takeErrors()] };
    },
    async cycle(ctx) {
      await t.tick();
      await dismissHedgePrompts(ctx);
    },
    async observe(ctx) {
      const pos = await t.accounting(ctx.bookId, 'positions', { scope: 'book' });
      for (const p of pos.positions) if (p.family === 'secloan' && p.instrument.underlyingId) ctx.borrowOf.set(p.instrument.id, p.instrument.underlyingId);
      return observeState(t, ctx);
    },
    async newEvents(ctx) {
      const ev = await eventsSince(t, ctx, ctx.lastEventId);
      if (ev.length) ctx.lastEventId = ev.at(-1).id;
      return ev;
    },
    integrity: (ctx) => t.integrity(ctx.bookId),
    async screens(ctx, info) {
      try {
        await ui.closeOverlays();
        const screen = await readScreens(ui, ctx, t);
        const problems = screenProblems(ctx, screen, info);
        // A family may read further screens of its own (for loans: the Treasury page, the Account page) and
        // compare them: `export async function screens(ui, ctx, t, info)` returns a list of mismatches.
        const own = family.of(ctx.spec.family).screens;
        if (own) problems.push(...await own(ui, ctx, t, info));
        return [...problems, ...takeErrors()];
      } catch (err) {
        if (shotsDir) { mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: join(shotsDir, `${specKey(ctx.spec).replace(':', '-')}-${info.step?.id || 'check'}.png`) }).catch(() => {}); }
        return [`The Accounting screens could not be read: ${err.message.split('\n').slice(0, 6).join(' ')}`];
      }
    },
    async restart(ctx) {
      await t.restart();
      // Same address after the restart: the page is reloaded and must still be on the scenario's Book.
      await ui.reloadAt('#/accounting');
      const chosen = (await page.locator('.topbar select').first().locator('option:checked').innerText()).trim();
      if (chosen !== ctx.spec.book.name) throw new Error(`After the restart the Book selector shows "${chosen}", not "${ctx.spec.book.name}".`);
    },
    async shot(name) {
      if (!shotsDir || !page) return;
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {});
    },
    async close() {
      try { await context?.close(); } catch { /* already closed */ }
      try { await t?.close(); } finally { t = null; context = null; page = null; }
    },
  };
}

export const defaultShotsDir = () => process.env.SDT_MATRIX_SHOTS || join(tmpdir(), 'sdt-matrix-shots');
export { TRADE_ACTIONS };
