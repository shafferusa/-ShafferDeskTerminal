// What the browser level does for each case: the interface part of the cases in ../cases/*.mjs.
//
// `b` is the case's World (lib/world.mjs) with a page: b.page, b.ui (the label-based helpers of the
// product matrix's browser driver), and everything the API level has (b.book(), b.sql(), b.cash()...)
// for preparing a Book and for reading what was stored afterwards. The action a case is about is
// always done in the interface: typed into a ticket, clicked, double-clicked. A refusal must be
// read on the screen, and what is stored is then checked behind the screen.
//
// Locators go by what a person reads (labels, button text, headings), as in test/matrix/drivers/browser.mjs.

import { evening, MON, SAT, TUE } from './world.mjs';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const QUOTE = { bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000 };

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

/** Open the Terminal and choose the Book in the Book selector, as a user does; then go to a page of it. */
export async function enter(b, book, hash = '#/accounting') {
  const { page, ui } = b;
  await ui.goto('#/books');
  const selector = page.locator('.topbar select').first();
  await selector.selectOption({ label: book.name });
  await selector.locator('option:checked', { hasText: exactly(book.name) }).waitFor({ state: 'attached' });
  await ui.goto(hash);
  await ui.drawn();
}
/** Close the post-trade hedge popup if the engine has produced one. */
export async function closeHedgePopup(b) {
  const popup = b.page.getByRole('dialog', { name: /^Hedge/ });
  if (await popup.count()) { await popup.locator('header').getByRole('button', { name: 'Close' }).click(); await popup.waitFor({ state: 'hidden' }); }
}
/** The text of every error notice inside a dialog or panel. */
const errorsIn = async (scope) => (await scope.locator('.notice.err').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
/** Requests the page sends from now on, by method and path (to count what a double click really sent). */
function watchRequests(page, method, pathPattern) {
  const seen = [];
  const on = (req) => { if (req.method() === method && pathPattern.test(new URL(req.url()).pathname)) seen.push(req.url()); };
  page.on('request', on);
  return { seen, stop: () => page.off('request', on) };
}
async function openTransfer(b, { from, to, amount, ccy = 'USD' }) {
  const { page, ui } = b;
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury');
  await ui.button(page.locator('main'), 'Transfer cash').first().click();
  const dlg = ui.dialog('Transfer cash');
  await ui.select(dlg, 'Source').selectOption({ label: from });
  await ui.select(dlg, 'Destination').selectOption({ label: to });
  const select = ui.select(dlg, 'Currency');
  await select.locator('option:checked', { hasText: /^[A-Z]{3}$/ }).waitFor({ state: 'attached' });
  await ui.drawn();
  await select.selectOption(ccy);
  await ui.input(dlg, 'Amount').fill(String(amount));
  return dlg;
}
async function openCapital(b, { type, amount, ccy = 'USD' }) {
  const { page, ui } = b;
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury');
  await ui.button(page.locator('main'), 'Deposit or withdraw').first().click();
  const dlg = ui.dialog('Deposit or withdraw capital');
  if (type === 'withdrawal') await ui.option(dlg, 'Movement', 'Withdraw from Treasury').click();
  await ui.input(dlg, 'Currency').fill(ccy);
  await ui.input(dlg, 'Amount').fill(String(amount));
  return dlg;
}

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/** SB:refusals:cash-transfer. The Transfer cash dialog refuses more than the source has free, says why, and records nothing. */
export async function transferRefused(b, c) {
  const book = await b.book('Browser transfer refused');
  await enter(b, book, '#/treasury');
  const before = await b.books(book.id);
  const dlg = await openTransfer(b, { from: 'Alpha', to: 'Treasury', amount: 600_000 });
  const r = await b.ui.respondsTo('POST', /\/transfers$/, () => b.ui.button(dlg, 'Record transfer').click());
  c.eq([r.ok, r.status, r.body?.code], [false, 400, 'insufficient_cash'], 'the server refuses the transfer of 600,000.00');
  await dlg.locator('.notice.err').first().waitFor();
  c.match((await errorsIn(dlg)).join(' | '), /Alpha has 500,000\.00 USD of settled USD available; 600,000\.00 USD requested/, 'the dialog shows the reason');
  c.ok(await dlg.isVisible(), 'the dialog stays open on the refusal');
  c.match(await b.ui.field(dlg, 'Amount').locator('.hint').innerText(), /Alpha has 500,000\.00 USD available to withdraw/, 'the dialog had said beforehand what is available');
  w_same(b, c, before, await b.books(book.id), 'the refused transfer');
  // Corrected to an amount that is there, the same dialog records it.
  await b.ui.input(dlg, 'Amount').fill('100000');
  const ok = await b.ui.respondsTo('POST', /\/transfers$/, () => b.ui.button(dlg, 'Record transfer').click());
  c.ok(ok.ok, 'corrected to 100,000.00 it is recorded', ok.body?.error);
  await dlg.waitFor({ state: 'hidden' });
  await b.ui.toast(/Transfer recorded/);
  c.near((await b.cash(book.id, book.accountId)).settled, 400_000, 'the Account holds 400,000.00');
}
function w_same(b, c, before, after, label) { b.sameBooks(c, before, after, label); b.sameRows(c, before, after, label); }

/** SB:refusals:cash-withdrawal. */
export async function withdrawalRefused(b, c) {
  const book = await b.book('Browser withdrawal refused');
  await enter(b, book, '#/treasury');
  const before = await b.books(book.id);
  const dlg = await openCapital(b, { type: 'withdrawal', amount: 600_000 });
  c.match(await b.ui.field(dlg, 'Amount').locator('.hint').innerText(), /Treasury has 500,000\.00 USD/, 'the dialog says what Treasury has available');
  const r = await b.ui.respondsTo('POST', /\/capital$/, () => b.ui.button(dlg, 'Record withdrawal').click());
  c.eq([r.ok, r.status, r.body?.code], [false, 400, 'insufficient_cash'], 'the server refuses the withdrawal of 600,000.00');
  await dlg.locator('.notice.err').first().waitFor();
  c.match((await errorsIn(dlg)).join(' | '), /Treasury has 500,000\.00 USD available to withdraw; 600,000\.00 USD requested/, 'the dialog shows the reason');
  w_same(b, c, before, await b.books(book.id), 'the refused withdrawal');
  await b.ui.button(dlg, 'Cancel').click();
  await dlg.waitFor({ state: 'hidden' });
}

// ---------------------------------------------------------------------------------------------
// Duplicate clicks: every confirming button, double-clicked
// ---------------------------------------------------------------------------------------------

/** Open the security ticket of an instrument from its Marketplace, fill it, and return the drawer. */
async function fillTicket(b, inst, { account = 'Alpha', action = 'Buy', qty, order = {} }) {
  const { ui } = b;
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  await ui.select(drawer, 'Account').selectOption({ label: account });
  const act = ui.option(drawer, 'Action', action);
  await act.click();
  await ui.input(drawer, inst.qtyLabel || 'Shares').fill(String(qty));
  if (order.orderType === 'limit') { await ui.select(drawer, 'Order type').selectOption({ label: 'Limit' }); await ui.input(drawer, 'Limit price').fill(String(order.limitPrice)); }
  if (order.tif === 'gtc') await ui.select(drawer, 'Time in force').selectOption({ label: 'Until cancelled' });
  if (order.settleDate) await ui.input(drawer, /^Settlement/).fill(order.settleDate);
  return drawer;
}
/** Press Preview on a filled ticket and wait for the preview dialog (or the refusal message). */
async function openPreviewFrom(b, drawer) {
  const { page, ui } = b;
  const asked = await ui.respondsTo('POST', /^\/api\/strategies\/(preview|[^/]+\/preview-action)$/, () => drawer.getByRole('button', { name: /^Preview/ }).click());
  if (!asked.ok) return { asked, modal: null };
  const modal = ui.dialog(/^Preview: /);
  await modal.waitFor();
  return { asked, modal, pv: asked.body, confirm: modal.getByRole('button', { name: /^Confirm/ }), page };
}

/** SB:stress:double-click-transfer. Record transfer and Record deposit, double-clicked: one transfer, one deposit. */
export async function doubleClickTransfer(b, c) {
  const book = await b.book('Browser double click transfer');
  await enter(b, book, '#/treasury');
  const count = (type) => b.sql('SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = ?', book.id, type)[0].n;
  // Transfer
  let dlg = await openTransfer(b, { from: 'Treasury', to: 'Alpha', amount: 25_000 });
  let sent = watchRequests(b.page, 'POST', /\/transfers$/);
  const transfers0 = count('transfer.funding');
  await b.ui.button(dlg, 'Record transfer').dblclick();
  await dlg.waitFor({ state: 'hidden' });
  await b.ui.toast(/Transfer recorded/);
  await b.ui.drawn();
  sent.stop();
  c.eq(sent.seen.length, 1, 'Record transfer double-clicked: one request was sent');
  c.eq(count('transfer.funding') - transfers0, 1, 'one transfer is recorded');
  c.near((await b.cash(book.id, book.accountId)).settled, 525_000, 'the Account received 25,000.00 once');
  // Deposit
  dlg = await openCapital(b, { type: 'deposit', amount: 40_000 });
  sent = watchRequests(b.page, 'POST', /\/capital$/);
  const deposits0 = count('capital.deposit');
  await b.ui.button(dlg, 'Record deposit').dblclick();
  await dlg.waitFor({ state: 'hidden' });
  await b.ui.toast(/Deposit recorded/);
  sent.stop();
  c.eq(sent.seen.length, 1, 'Record deposit double-clicked: one request was sent');
  c.eq(count('capital.deposit') - deposits0, 1, 'one deposit is recorded');
  c.near((await b.cash(book.id, book.treasuryId)).settled, 515_000, 'Treasury holds 500,000.00 - 25,000.00 + 40,000.00');
  await b.clean(c, book.id);
}

/** SB:stress:double-click-confirm. The trade preview's Confirm button, double-clicked: one order, one fill. */
export async function doubleClickConfirm(b, c) {
  const book = await b.book('Browser double click confirm');
  const inst = await b.stock('DCC', QUOTE);
  await enter(b, book, '#/markets/US_CASH');
  const drawer = await fillTicket(b, inst, { qty: 100 });
  const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
  c.eq(pv.blocking, 0, 'the purchase of 100 previews without a block');
  const sent = watchRequests(b.page, 'POST', /^\/api\/strategies$/);
  await confirm.dblclick();
  await modal.waitFor({ state: 'hidden' });
  await b.ui.drawn();
  await b.tick();
  sent.stop();
  c.ok(sent.seen.length >= 1 && sent.seen.length <= 2, 'the confirmation was sent', `${sent.seen.length} requests`);
  c.note(`Confirm double-clicked: ${sent.seen.length} request${sent.seen.length === 1 ? '' : 's'} left the page`);
  const n = await b.books(book.id);
  c.eq([n.counts.strategies, n.counts.orders, n.counts.fills], [1, 1, 1], 'one strategy instance, one order, one fill');
  c.eq(b.sql('SELECT qty, price FROM fills').map((f) => [f.qty, f.price]), [[100, 50.02]], '100 shares at 50.02, once');
  c.near((await b.cash(book.id, book.accountId)).payable, 5_003, 'the Account owes 5,003.00 (5,002.00 + 1.00 commission), once');
  await closeHedgePopup(b);
  await b.clean(c, book.id);
}

// ---------------------------------------------------------------------------------------------
// Connection loss
// ---------------------------------------------------------------------------------------------

const treasuryCashShown = async (b) => {
  const panel = b.ui.section(b.page.locator('main'), 'Treasury cash by currency');
  return (await panel.innerText()).replace(/\s+/g, ' ');
};

/** SB:stress:connection-loss. */
export async function connectionLoss(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser connection loss');
  await enter(b, book, '#/treasury');
  const transfers = () => b.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'transfer.funding'`, book.id)[0].n;
  const n0 = transfers();

  // 1. The request reaches the server; its answer never reaches the page.
  let dlg = await openTransfer(b, { from: 'Treasury', to: 'Alpha', amount: 10_000 });
  let lost = 0;
  await page.route('**/api/books/*/transfers', async (route) => { lost++; try { await route.fetch(); } catch { /* the server answered or not: the page will not know */ } await route.abort('connectionreset'); }, { times: 1 });
  await ui.button(dlg, 'Record transfer').click();
  await dlg.locator('.notice.err').first().waitFor();
  c.eq(lost, 1, 'the answer to the first attempt was lost on the way back');
  c.match((await errorsIn(dlg)).join(' | '), /server is not reachable/i, 'the dialog says the server could not be reached');
  c.eq(transfers() - n0, 1, 'the server had recorded the transfer');
  c.match(await ui.input(dlg, 'Amount').inputValue(), /^10,?000$/, 'the dialog still holds what was typed');
  // The user, who cannot know, presses the button again.
  const again = await ui.respondsTo('POST', /\/transfers$/, () => ui.button(dlg, 'Record transfer').click());
  c.ok(again.ok, 'the second attempt is answered', again.body?.error);
  await dlg.waitFor({ state: 'hidden' });
  c.eq(transfers() - n0, 1, 'there is still exactly one transfer: the retry did not record a second');
  c.near((await b.cash(book.id, book.accountId)).settled, 510_000, 'the Account received 10,000.00 once');

  // 2. The server goes away.
  await ui.reloadAt('#/treasury');
  await page.locator('main').getByText(/490,000\.00/).first().waitFor();
  await b.t.kill();
  const notice = page.getByText(/server is not (reachable|responding)/i).first();
  await notice.waitFor({ timeout: 30_000 });
  c.ok(await notice.isVisible(), 'with the server gone the page says, by itself, that it cannot reach the server');
  dlg = await openTransferOffline(b, 7_000);
  if (dlg) {
    await ui.button(dlg, 'Record transfer').click();
    await dlg.locator('.notice.err').first().waitFor();
    c.match((await errorsIn(dlg)).join(' | '), /server is not reachable/i, 'an action tried meanwhile is refused with the reason, on the dialog');
  } else c.note('with the server gone the Transfer dialog cannot be opened (its data cannot be loaded)');

  // 3. The server comes back; something changed meanwhile.
  await b.t.start();
  await b.post(`/api/books/${book.id}/capital`, { type: 'deposit', ccy: 'USD', amount: 3_000 });
  c.eq(transfers() - n0, 1, 'nothing was recorded for the attempt made while the server was away');
  await notice.waitFor({ state: 'hidden', timeout: 40_000 });
  if (dlg) { await ui.closeOverlays().catch(() => {}); }
  await page.locator('main').getByText(/493,000\.00/).first().waitFor({ timeout: 40_000 });
  c.match(await treasuryCashShown(b), /493,000\.00/, 'without a reload the page shows the current figure: Treasury 493,000.00');
  // And the Terminal works again: one transfer, once.
  dlg = await openTransfer(b, { from: 'Treasury', to: 'Alpha', amount: 7_000 });
  const ok = await ui.respondsTo('POST', /\/transfers$/, () => ui.button(dlg, 'Record transfer').click());
  c.ok(ok.ok, 'after the recovery a transfer is recorded', ok.body?.error);
  await dlg.waitFor({ state: 'hidden' });
  c.eq(transfers() - n0, 2, 'two transfers in all: 10,000.00 and 7,000.00, each once');
  c.near((await b.cash(book.id, book.accountId)).settled, 517_000, 'the Account holds 517,000.00');
  b.takePageErrors(); // console errors of the requests that failed while the server was away are expected
  await b.clean(c, book.id);
}
/** The Transfer dialog opened from the page as it stands (no reload: the server is away). Null when it cannot be filled. */
async function openTransferOffline(b, amount) {
  const { page, ui } = b;
  try {
    await ui.button(page.locator('main'), 'Transfer cash').first().click();
    const dlg = ui.dialog('Transfer cash');
    await dlg.waitFor({ timeout: 5_000 });
    await ui.select(dlg, 'Destination').selectOption({ label: 'Alpha' }, { timeout: 3_000 });
    await ui.select(dlg, 'Currency').selectOption('USD', { timeout: 3_000 });
    await ui.input(dlg, 'Amount').fill(String(amount));
    if (await ui.button(dlg, 'Record transfer').isDisabled()) return null;
    return dlg;
  } catch { return null; }
}
