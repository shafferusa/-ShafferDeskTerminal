// What the browser level does for each case: the interface part of the cases in ../cases/*.mjs.
//
// `b` is the case's World (lib/world.mjs) with a page: b.page, b.ui (the label-based helpers of the
// product matrix's browser driver), and everything the API level has (b.book(), b.sql(), b.cash()...)
// for preparing a Book and for reading what was stored afterwards. The action a case is about is
// always done in the interface: typed into a ticket, clicked, double-clicked. A refusal must be
// read on the screen, and what is stored is then checked behind the screen.
//
// Locators go by what a person reads (labels, button text, headings), as in test/matrix/drivers/browser.mjs.

import { evening, TUE } from './world.mjs';

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

// ---------------------------------------------------------------------------------------------
// Refusals read from the ticket and the preview dialog
// ---------------------------------------------------------------------------------------------

/**
 * Fill the ticket, ask for the preview, and report how the interface refuses: { where, text, confirmDisabled }.
 * `where` is 'ticket' (Preview cannot be pressed, or the ticket shows the reason), 'message' (the request was
 * refused and the reason shown as a message) or 'preview' (the dialog shows a blocking check). Null: not refused.
 */
async function refusalOf(b, inst, spec) {
  const { page, ui } = b;
  const drawer = await fillTicket(b, inst, spec);
  if (spec.settleOn) {
    await ui.field(drawer, 'Settlement').locator('select').selectOption({ label: 'State a settlement date' });
    await ui.field(drawer, 'Settlement').locator('input[type=date]').fill(spec.settleOn);
    await ui.field(drawer, 'Settlement').locator('.err').waitFor();
  }
  const ticketError = spec.settleOn ? (await ui.field(drawer, 'Settlement').locator('.err').innerText()).trim() : null;
  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) return { where: 'ticket', text: ticketError || (await drawer.locator('.notice').allInnerTexts()).join(' | ') || 'Preview is disabled', confirmDisabled: true };
  const { asked, modal, confirm } = await openPreviewFrom(b, drawer);
  if (!asked.ok) {
    await page.locator('.toasts .toast, .notice.err', { hasText: asked.body?.error || 'no message' }).first().waitFor();
    return { where: 'message', text: asked.body?.error, confirmDisabled: true };
  }
  const blocks = (await modal.locator('.checks .notice.err').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
  const disabled = await confirm.isDisabled();
  await ui.button(modal, 'Cancel').click();
  await modal.waitFor({ state: 'hidden' });
  if (!blocks.length && !disabled) return null;
  return { where: 'preview', text: [ticketError, ...blocks].filter(Boolean).join(' | '), confirmDisabled: disabled };
}

/** SB:refusals:ticket-blocks. */
export async function ticketBlocks(b, c) {
  const book = await b.book('Browser ticket blocks');
  const inst = await b.stock('TKB', QUOTE);
  await b.fixture('borrow', { instrumentId: inst.id, available: true, quantity: 300, feeRate: 0.01 });
  const noBorrow = await b.stock('TKN', QUOTE);
  await b.fixture('borrow', { instrumentId: noBorrow.id, available: false, quantity: 0, feeRate: 0.01 });
  const opt = await b.instrument({ productId: 'equity_option', name: 'TKB 2026-02-20 50 Call', symbol: 'TKB 260220C50', marketView: 'US_DERIV', venue: 'CBOE', venueType: 'exchange', venueCountry: 'US', underlyingId: inst.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'C', strike: 50, expiration: '2026-02-20', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
  await b.fixture('quote', { instrumentId: opt.id, bid: 1.00, ask: 1.10, last: 1.05, bidSize: 50, askSize: 50 });
  await b.buy(book, inst, 200);
  await enter(b, book, '#/markets/US_CASH');
  await closeHedgePopup(b);
  const before = await b.books(book.id);
  const expectRefusal = async (label, instrument, spec, text, where) => {
    const r = await refusalOf(b, instrument, spec);
    if (!c.ok(r, `${label}: the interface refuses it`, 'the preview opened with nothing blocking and Confirm enabled')) return;
    c.match(r.text, text, `${label}: the reason on screen`);
    c.eq(r.confirmDisabled, true, `${label}: it cannot be confirmed`);
    if (where) c.eq(r.where, where, `${label}: refused on the ${where}`);
    c.note(`${label}: on the ${r.where}: "${r.text.slice(0, 160)}"`);
  };
  await expectRefusal('(a) buy 20,000', inst, { qty: 20_000 }, /short 510,505\.00 USD/, 'preview'); // 1,000,500.00 needed, 489,995.00 available
  await expectRefusal('(b) sell short 500 with 300 to borrow', inst, { action: 'Sell short', qty: 500 }, /only 300 TKB is available to borrow/, 'preview');
  await expectRefusal('(c) a quantity of 0', inst, { qty: 0 }, /./);
  await expectRefusal('(d) 10.5 shares', inst, { qty: 10.5 }, /multiple of 1/);
  await expectRefusal('(e) sell 300 of the 200 held', inst, { action: 'Sell', qty: 300 }, /200/);
  await expectRefusal('(f) settlement on Saturday 7 March', inst, { qty: 100, settleOn: '2026-03-07' }, /2026-03-07 \(Saturday\) is a Saturday/);
  await expectRefusal('(g) sell short with the borrow unavailable', noBorrow, { action: 'Sell short', qty: 100 }, /TKN is not available to borrow/, 'preview');
  await expectRefusal('(h) an expired option', opt, { qty: 1, account: 'Alpha' }, /expired on 2026-02-20/);
  await b.ui.closeOverlays();
  const after = await b.books(book.id);
  b.sameBooks(c, before, after, 'after every refusal');
  b.sameRows(c, before, after, 'after every refusal');
  // The screen agrees: 200 shares, 489,995.00 available to trade.
  await b.ui.reloadAt(`#/accounting/positions/${book.accountId}`);
  const main = b.page.locator('main');
  await main.locator('table').first().waitFor();
  const text = (await main.innerText()).replace(/\s+/g, ' ');
  c.match(text, /489,995\.00/, 'the positions screen shows 489,995.00 available to trade');
  c.match(text, /TKB/, 'and the 200 TKB held');
}

// ---------------------------------------------------------------------------------------------
// A failed dependent leg, and cancellations, from the strategy instance
// ---------------------------------------------------------------------------------------------

async function openStrategyDrawer(b, book, strategyId) {
  const { page, ui } = b;
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/positions/${book.accountId}`);
  await page.locator(`main a[title="Strategy instance ${strategyId}"]`).first().click();
  const drawer = page.getByRole('dialog').filter({ has: page.locator('header h3', { hasText: /^Positions/ }) });
  await drawer.waitFor();
  return drawer;
}

/** SB:stress:failed-leg-cancel / -retry / -unwind / -accept. */
export async function failedLegRecovery(b, c, mode) {
  const { page, ui } = b;
  const { brokenPackage } = await import('../cases/stress.mjs');
  const { book, opt, s } = await brokenPackage(b, `BF${mode[0].toUpperCase()}`);
  await enter(b, book);
  let drawer;
  if (mode === 'cancel') {
    drawer = await openStrategyDrawer(b, book, s.id);
    c.ok(await drawer.getByText(/In progress, not complete/).first().isVisible(), 'the strategy instance says it is in progress, not complete');
    const sent = watchRequests(page, 'POST', /\/action$/);
    await ui.button(drawer, 'Cancel working legs').dblclick();
    await ui.toast(/Working legs cancelled/);
    sent.stop();
    c.eq(sent.seen.length, 1, 'Cancel working legs double-clicked: one request');
  } else {
    await b.clock(evening('2026-03-02')); // the day order for the put expires unfilled
    await b.clock(TUE);
    drawer = await openStrategyDrawer(b, book, s.id);
  }
  const residual = ui.section(drawer, 'Residual exposure');
  await residual.waitFor();
  c.match(await residual.innerText(), /1 required leg did not execute while other legs did/, 'the drawer shows the residual exposure and says the package is not complete');
  c.eq(await ui.button(drawer, 'Cancel working legs').count(), 0, 'no leg is left to cancel');
  const view = async () => b.strategy(s.id);
  if (mode === 'cancel') {
    c.eq((await view()).status, 'attention', 'the package is in attention');
    for (const name of ['Retry the failed legs', 'Unwind what filled', 'Accept as it stands']) c.ok(await ui.button(residual, name).isVisible(), `"${name}" is offered`);
    c.eq((await b.books(book.id)).counts.orders, 2, 'two orders exist: the filled stock leg and the cancelled put leg');
  } else if (mode === 'retry') {
    await b.fixture('quote', { instrumentId: opt.id, bid: 0.90, ask: 0.95, last: 0.95, bidSize: 50, askSize: 50 }); // the retried limit (1.00) can now fill
    await ui.button(residual, 'Retry the failed legs').click();
    const modal = ui.dialog(/^Preview: /);
    await modal.waitFor();
    const confirm = modal.getByRole('button', { name: /^Confirm/ });
    await confirm.dblclick();
    await modal.waitFor({ state: 'hidden' });
    await b.tick();
    const v = await view();
    c.eq([v.status, v.complete], ['open', true], 'after the retry the package is open and complete');
    c.eq(v.orders.map((o) => [o.legNo, o.status, o.filledQty]), [[1, 'filled', 100], [2, 'expired', 0], [3, 'filled', 1]], 'three legs: stock filled, put expired, put filled once (Confirm was double-clicked)');
    c.eq(v.orders[2].avgPrice, 0.95, 'the put filled at the ask 0.95');
  } else if (mode === 'unwind') {
    await ui.button(residual, 'Unwind what filled').click();
    const modal = ui.dialog(/^Preview: /);
    await modal.waitFor();
    await modal.getByRole('button', { name: /^Confirm/ }).dblclick();
    await modal.waitFor({ state: 'hidden' });
    await b.tick();
    const v = await view();
    c.eq([v.status, v.positions.length], ['closed', 0], 'after the unwind the package is closed and holds nothing');
    c.eq(v.orders.filter((o) => o.action === 'sell').map((o) => [o.status, o.filledQty, o.avgPrice]), [['filled', 100, 50]], 'one sale of 100 at the bid 50.00 (Confirm was double-clicked)');
  } else if (mode === 'accept') {
    const before = await b.books(book.id);
    await ui.button(residual, 'Accept as it stands').click();
    const dlg = ui.dialog('Accept the position as it stands');
    const sent = watchRequests(page, 'POST', /\/action$/);
    await ui.button(dlg, 'Accept as it stands').dblclick();
    await dlg.waitFor({ state: 'hidden' });
    sent.stop();
    c.eq(sent.seen.length, 1, 'Accept double-clicked: one request');
    const v = await view();
    c.eq(v.status, 'open', 'after accepting the package is open');
    c.eq(b.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'strategy.accepted'`, book.id)[0].n, 1, 'one accepted event');
    b.sameBooks(c, before, await b.books(book.id), 'accepting');
  }
  await b.clean(c, book.id);
}

/** SB:stress:cancellations. The partly filled order on the Pending tab, cancelled from there. */
export async function cancelPartial(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser cancel partial');
  const inst = await b.stock('BCP', { ...QUOTE, askSize: 300, bidSize: 300 });
  const s = await b.trade(b.ticketInput(book, inst, 'buy', 1_000, { order: { tif: 'gtc' } }));
  const rest = await b.trade(b.ticketInput(book, inst, 'buy', 50, { order: { orderType: 'limit', limitPrice: 40, tif: 'gtc' } }));
  await enter(b, book, `#/accounting/pending/${book.accountId}`);
  const partly = ui.section(page.locator('main'), 'Partly filled');
  await partly.waitFor();
  const row = partly.locator('tbody tr').first();
  c.match((await row.innerText()).replace(/\s+/g, ' '), /300 of 1,000.*700/, 'the Pending tab lists the order as partly filled: 300 of 1,000, 700 remaining');
  let sent = watchRequests(page, 'POST', /\/cancel$/);
  await ui.button(row, 'Cancel the rest').dblclick();
  await ui.toast(/Order cancelled/);
  sent.stop();
  c.eq(sent.seen.length, 1, 'Cancel the rest double-clicked: one request');
  await partly.locator('tbody tr').first().waitFor({ state: 'detached' }).catch(() => {});
  let v = await b.strategy(s.id);
  c.eq([v.orders[0].status, v.orders[0].filledQty, v.positions[0]?.qty], ['cancelled', 300, 300], 'the order is cancelled with 300 filled, and the 300 shares stay');
  c.eq(b.sql(`SELECT COUNT(*) AS n FROM events WHERE order_id = ? AND type = 'order.cancelled'`, s.orders[0].id)[0].n, 1, 'one cancellation event');
  // The resting order, from the Open orders table.
  const open = ui.section(page.locator('main'), 'Open orders');
  sent = watchRequests(page, 'POST', /\/cancel$/);
  await ui.button(open.locator('tbody tr').first(), 'Cancel order').dblclick();
  await ui.toast(/Order cancelled/);
  sent.stop();
  c.eq(sent.seen.length, 1, 'Cancel order double-clicked: one request');
  v = await b.strategy(rest.id);
  c.eq([v.orders[0].status, v.orders[0].filledQty], ['cancelled', 0], 'the resting order is cancelled, unfilled');
  await b.tick(); await b.tick();
  c.eq((await b.books(book.id)).counts.fills, 1, 'later cycles fill nothing more');
  await ui.reloadAt(`#/accounting/pending/${book.accountId}`);
  c.eq(await page.locator('main').getByRole('button', { name: /^Cancel (the rest|order)$/ }).count(), 0, 'no order is left to cancel on the Pending tab');
  await b.clean(c, book.id);
}

// ---------------------------------------------------------------------------------------------
// Refusals that time produces, read where a user finds them: the Failed tab and "to review"
// ---------------------------------------------------------------------------------------------

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** The top bar's "N to review" button opened: the texts under "Items needing attention". Empty when there is no button. */
async function itemsToReview(b) {
  const { page, ui } = b;
  const chip = page.locator('.topbar').getByRole('button', { name: /to review$/ });
  if (!(await chip.count())) return [];
  await chip.click();
  const dlg = ui.dialog('Items needing attention');
  await dlg.waitFor();
  const items = (await dlg.locator('.notice').allInnerTexts()).map(flat);
  await ui.closeOverlays();
  return items;
}
const LOAN_LEG = { kind: 'loan', action: 'borrow_cash', qty: 100_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'System test loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-04-01' } } };
/** The Repay button of the Account's loan on Treasury's Borrowings page, pressed: the preview dialog. */
async function openRepayment(b) {
  const { page, ui } = b;
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury/borrowings');
  const panel = ui.section(page.locator('main'), 'Account-originated borrowings');
  await panel.waitFor();
  await ui.button(panel, 'Repay').first().click();
  const modal = ui.dialog(/^Preview: /);
  await modal.waitFor();
  return modal;
}

/** SB:refusals:cash-repayment. */
export async function repaymentRefused(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser repayment refused');
  await b.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [LOAN_LEG] });
  await b.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.accountId, toUnitId: book.treasuryId, ccy: 'USD', amount: 590_000 });
  await enter(b, book, '#/treasury/borrowings');
  const liab = async () => -(await b.balance(book.id, book.accountId, 'loan.liab'));

  // Early repayment from the Borrowings page.
  const before = await b.books(book.id);
  const modal = await openRepayment(b);
  const blocks = (await modal.locator('.checks .notice.err').allInnerTexts()).map(flat);
  c.match(blocks.join(' | '), /short 90,000\.00 USD/, 'the repayment preview shows the blocking reason with the 90,000.00 shortfall');
  const confirm = ui.button(modal, 'Confirm repayment');
  c.eq(await confirm.isDisabled(), true, 'Confirm repayment cannot be pressed');
  c.match(flat(await modal.locator('.pv-totals').innerText()), /short 90,000\.00 USD/, 'the totals line repeats the shortfall');
  await ui.button(modal, 'Cancel').click();
  await modal.waitFor({ state: 'hidden' });
  w_same(b, c, before, await b.books(book.id), 'the refused early repayment');

  // Maturity without the cash: the Failed tab and the items to review.
  await b.clock('2026-04-01T15:00:00.000Z');
  await ui.reloadAt(`#/accounting/failed/${book.accountId}`);
  const failedItems = ui.section(page.locator('main'), 'Failed lifecycle items');
  await failedItems.waitFor();
  const row = flat(await failedItems.locator('tbody tr').first().innerText());
  c.match(row, /2026-04-01/, 'the Failed tab lists the repayment due 1 April');
  c.match(row, /10,000\.00 USD/, 'with a reason naming the 10,000.00 that is there');
  c.note(`Failed tab: "${row.slice(0, 220)}"`);
  const items = await itemsToReview(b);
  c.ok(items.some((x) => /failed on System test loan/.test(x)), 'the top bar has an item to review for the failed repayment', items.join(' | '));
  c.near(await liab(), 100_000, 'the principal is still owed in full');
  c.near((await b.cash(book.id, book.accountId)).settled, 10_000, 'the cash was not part-used');

  // The cash arrives, through the Transfer dialog.
  const dlg = await openTransfer(b, { from: 'Treasury', to: 'Alpha', amount: 200_000 });
  await ui.button(dlg, 'Record transfer').click();
  await dlg.waitFor({ state: 'hidden' });
  await b.tick();
  await ui.reloadAt(`#/accounting/failed/${book.accountId}`);
  await page.locator('main').getByText('Failed settlements').first().waitFor();
  c.eq(await ui.section(page.locator('main'), 'Failed lifecycle items').count(), 0, 'after the funding the Failed tab no longer lists the repayment');
  c.ok(!(await itemsToReview(b)).some((x) => /failed on System test loan/.test(x)), 'and the item to review is gone');
  c.near(await liab(), 0, 'the loan is repaid');
  c.near((await b.cash(book.id, book.accountId)).settled, 109_583.33, 'cash is 10,000.00 + 200,000.00 - 100,000.00 - 416.67 interest');
  c.eq(b.sql(`SELECT COUNT(DISTINCT event_id) AS n FROM entries WHERE book_id = ? AND account = 'loan.liab'`, book.id)[0].n, 2, 'the principal moved twice in all: drawdown and one repayment');
  await b.clean(c, book.id);
}

/** SB:refusals:failed-tab. A failed settlement and an unmet margin call, read on the Failed tab and under "to review". */
export async function failedTab(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser failed tab', { funding: 100_000 });
  const beta = (await b.post(`/api/books/${book.id}/accounts`, { name: 'Beta' })).id;
  await b.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.treasuryId, toUnitId: beta, ccy: 'USD', amount: 30_000 });
  const aaa = await b.stock('FTA');
  const bbb = await b.stock('FTB');
  // Beta: a swap under an agreement with variation margin, marked at -50,000.00.
  await b.fixture('rate', { code: 'TEST-3M', value: 4.0 });
  const agr = await b.post(`/api/books/${book.id}/agreements`, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [beta], terms: { variationMargin: true } });
  const swap = await b.trade({ bookId: book.id, unitId: beta, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract: { productId: 'interest_rate_swap', name: 'IRS system test', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', collateralBasis: { type: 'agreement', agreementId: agr.id }, legs: [
    { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
    { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } } }] });
  await b.post('/api/observations', { kind: 'price', subject: swap.positions[0].instrument.id, value: -5, units: 'per 100 notional' });
  // Alpha: the purchase that cannot be paid on Wednesday.
  const s1 = await b.buy(book, aaa, 1_000);
  await b.clock(evening('2026-03-02'));
  await b.clock(TUE);
  await b.closeOut(s1.id, { positionIds: [s1.positions[0].positionId], qty: 1_000, order: { orderType: 'market', tif: 'day', settle: { lag: 3 } } });
  await b.buy(book, bbb, 1_800);
  await b.clock('2026-03-04T15:00:00.000Z');

  await enter(b, book, `#/accounting/failed/${book.accountId}`);
  await closeHedgePopup(b);
  const main = page.locator('main');
  const fails = ui.section(main, 'Failed settlements');
  await fails.locator('tbody tr').first().waitFor();
  const row = flat(await fails.locator('tbody tr').first().innerText());
  c.match(row, /FTB/, 'Wednesday: the Failed tab lists the FTB settlement');
  c.match(row, /90,045\.00/, 'to pay 90,045.00');
  c.match(row, /2026-03-04/, 'due 4 March');
  c.match(row, /49,975\.00 USD available, 90,045\.00 USD due/, 'with the reason: what is available and what is due');
  c.eq(await fails.locator('tbody tr').count(), 1, 'one failed settlement, not one per retry');
  let items = await itemsToReview(b);
  c.ok(items.some((x) => /Settlement due 2026-03-04 failed/.test(x) && /49,975\.00 USD available/.test(x)), 'the items to review name the failed settlement and its reason', items.join(' | '));
  c.ok(items.some((x) => /call of 50,000\.00 USD .* failed: Beta has 30,000\.00 USD/.test(x)), 'and the margin call Beta could not meet: 50,000.00 called, 30,000.00 there', items.join(' | '));
  c.match(flat(await page.locator('.topbar').getByRole('button', { name: /to review$/ }).innerText()), /^2 to review$/, 'the top bar says "2 to review"');
  const cashA = await b.cash(book.id, book.accountId);
  c.near(cashA.settled, 49_975, 'Alpha: settled cash did not go negative');
  c.near((await b.cash(book.id, beta)).margin, 0, 'Beta: nothing was posted');

  // The cash arrives for both (the Friday receipt for Alpha; funding for Beta, through the Transfer dialog).
  const dlg = await openTransfer(b, { from: 'Treasury', to: 'Beta', amount: 100_000 });
  await ui.button(dlg, 'Record transfer').click();
  await dlg.waitFor({ state: 'hidden' });
  await b.clock(FRI_MORNING);
  await b.tick();
  await ui.reloadAt(`#/accounting/failed/${book.accountId}`);
  await ui.section(main, 'Failed settlements').waitFor();
  c.match(flat(await ui.section(main, 'Failed settlements').innerText()), /No settlement has failed/, 'Friday: the Failed tab says no settlement has failed');
  items = await itemsToReview(b);
  c.eq(items.filter((x) => /Settlement due|call of/.test(x)), [], 'and neither item is left to review');
  c.near((await b.cash(book.id, book.accountId)).settled, 9_925, 'Alpha: 49,975.00 + 49,995.00 - 90,045.00');
  c.near((await b.cash(book.id, beta)).margin, 50_000, 'Beta: the 50,000.00 call was delivered once');
  c.eq(b.sql(`SELECT COUNT(*) AS n FROM collateral_movements WHERE book_id = ? AND kind = 'variation'`, book.id)[0].n, 1, 'one variation-margin movement');
  await b.clean(c, book.id);
}
const FRI_MORNING = '2026-03-06T15:00:00.000Z';

/** SB:refusals:calendar-closed-day. The world starts on Saturday 7 March. */
export async function closedDay(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser closed day');
  const inst = await b.stock('BCD', QUOTE);
  await enter(b, book, '#/markets/US_CASH');
  const drawer = await fillTicket(b, inst, { qty: 100 });
  const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
  c.eq(pv.blocking, 0, 'Saturday: the order is not blocked');
  const warnings = (await modal.locator('.checks .notice.warn').allInnerTexts()).map(flat);
  c.match(warnings.join(' | '), /closed today on calendar US \(2026-03-07 is a Saturday\).*matched on 2026-03-09/, 'the preview dialog warns that the market is closed and says when the order will be matched');
  c.match(flat(await modal.locator('table').first().innerText()), /2026-03-10/, 'the leg shows settlement on Tuesday 10 March');
  await confirm.click();
  await modal.waitFor({ state: 'hidden' });
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/pending/${book.accountId}`);
  const open = ui.section(page.locator('main'), 'Open orders');
  await open.locator('tbody tr').first().waitFor();
  c.match(flat(await open.locator('tbody tr').first().innerText()), /Market closed today on calendar US \(2026-03-07 is a Saturday\); will be matched on 2026-03-09/, 'the Pending tab shows the order waiting, with the reason');
  const sat = await b.books(book.id);
  c.eq(sat.counts.fills, 0, 'nothing filled on Saturday');
  await b.tick(); await b.tick(); await b.tick();
  w_same(b, c, sat, await b.books(book.id), 'three more cycles on Saturday');
  await b.clock('2026-03-08T15:00:00.000Z');
  c.eq((await b.books(book.id)).counts.fills, 0, 'Sunday: still no fill');
  await b.clock(MON2_OPEN);
  await ui.reloadAt(`#/accounting/pending/${book.accountId}`);
  await page.locator('main').getByText('Executed trades awaiting settlement').first().waitFor();
  c.eq(await ui.section(page.locator('main'), 'Open orders').locator('tbody tr').count(), 0, 'Monday: no open order is left on the Pending tab');
  const awaiting = flat(await ui.section(page.locator('main'), 'Executed trades awaiting settlement').innerText());
  c.match(awaiting, /BCD/, 'the trade is listed as executed, awaiting settlement');
  c.match(awaiting, /2026-03-10/, 'expected to settle on Tuesday 10 March');
  const fills = b.sql('SELECT qty, price, business_date, settle_date FROM fills');
  c.eq(fills.map((f) => [f.qty, f.price, f.business_date, f.settle_date]), [[100, 50.02, '2026-03-09', '2026-03-10']], 'one fill: 100 at 50.02, trade date Monday, settlement Tuesday');
  await b.tick();
  c.eq((await b.books(book.id)).counts.fills, 1, 'another cycle does not fill again');
  await closeHedgePopup(b);
  await b.clean(c, book.id);
}
const MON2_OPEN = '2026-03-09T14:00:00.000Z';

// ---------------------------------------------------------------------------------------------
// A confirmation refused because the figures moved, and the second confirmation
// ---------------------------------------------------------------------------------------------

/** SB:stress:confirm-changed. */
export async function confirmChanged(b, c) {
  const { ui } = b;
  const book = await b.book('Browser confirm changed');
  const inst = await b.stock('BCC', QUOTE);
  await enter(b, book, '#/markets/US_CASH');
  const drawer = await fillTicket(b, inst, { qty: 100 });
  const { modal, pv } = await openPreviewFrom(b, drawer);
  c.eq(pv.legs[0].price?.estimate, 50.02, 'the preview shows the purchase at the ask 50.02');
  await b.fixture('quote', { instrumentId: inst.id, bid: 50.98, ask: 51.00, last: 50.99, bidSize: 5000, askSize: 5000 });
  const before = await b.books(book.id);
  const refused = await ui.respondsTo('POST', /^\/api\/strategies$/, () => modal.getByRole('button', { name: /^Confirm/ }).click());
  c.eq([refused.status, refused.body?.code], [409, 'preview_changed'], 'the confirmation of figures that have moved is refused');
  await modal.getByText('Nothing was submitted.').waitFor();
  const changed = modal.locator('[data-testid=changes]');
  const text = flat(await changed.innerText());
  c.match(text, /What changed since you confirmed/, 'the dialog shows what changed');
  c.match(text, /50\.02.*51\.00/, 'was 50.02, now 51.00');
  w_same(b, c, before, await b.books(book.id), 'the refused confirmation');
  const again = ui.button(modal, 'Confirm the new figures');
  c.eq(await again.isDisabled(), true, 'the new figures cannot be confirmed before they are checked');
  await modal.getByLabel('I have checked the new figures').check();
  const sent = watchRequests(b.page, 'POST', /^\/api\/strategies$/);
  await again.dblclick();
  await modal.waitFor({ state: 'hidden' });
  await b.tick();
  sent.stop();
  c.note(`Confirm the new figures double-clicked: ${sent.seen.length} request${sent.seen.length === 1 ? '' : 's'} left the page`);
  const n = await b.books(book.id);
  c.eq([n.counts.strategies, n.counts.orders, n.counts.fills], [1, 1, 1], 'one strategy instance, one order, one fill');
  c.eq(b.sql('SELECT qty, price FROM fills').map((f) => [f.qty, f.price]), [[100, 51]], '100 shares at 51.00, once');
  await closeHedgePopup(b);
  await b.clean(c, book.id);
}

// ---------------------------------------------------------------------------------------------
// Duplicate clicks on the other confirming buttons
// ---------------------------------------------------------------------------------------------

/** Choose a lifecycle action for the position of `symbol` in an open strategy drawer; returns the dialog. */
async function openLifecycle(b, drawer, symbol, action, title) {
  const { ui } = b;
  const positions = ui.section(drawer, 'Positions');
  const row = positions.locator('tbody tr').filter({ hasText: symbol }).filter({ has: b.page.locator('select') }).first();
  await row.locator('select').selectOption({ label: action });
  const dlg = ui.dialog(title);
  await dlg.waitFor();
  return dlg;
}

/** SB:stress:double-click-records. Repayment, manual cash flow, lender recall, corporate action: each button double-clicked. */
export async function doubleClickRecords(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser double click records', { funding: 600_000 });
  const inst = await b.stock('DCR', QUOTE);
  const shorted = await b.stock('DCS', QUOTE);
  await b.fixture('borrow', { instrumentId: shorted.id, available: true, quantity: 1_000, feeRate: 0.01 });
  await b.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [LOAN_LEG] });
  const long = await b.buy(book, inst, 100);
  const short = await b.short(book, shorted, 100);
  await b.clock(evening('2026-03-02'));
  await b.clock(TUE);
  await enter(b, book, '#/treasury/borrowings');
  await closeHedgePopup(b);
  const count = (sql, ...p) => b.sql(sql, ...p)[0].n;

  // 1. Confirm repayment. One day of interest: 100,000 x 5% x 1 / 360 = 13.89.
  const cash0 = (await b.cash(book.id, book.accountId)).settled;
  let modal = await openRepayment(b);
  let sent = watchRequests(page, 'POST', /^\/api\/strategies$/);
  await ui.button(modal, 'Confirm repayment').dblclick();
  await modal.waitFor({ state: 'hidden' });
  await b.tick();
  sent.stop();
  c.note(`Confirm repayment double-clicked: ${sent.seen.length} request${sent.seen.length === 1 ? '' : 's'} left the page`);
  c.near(-(await b.balance(book.id, book.accountId, 'loan.liab')), 0, 'the loan is repaid');
  c.near((await b.cash(book.id, book.accountId)).settled - cash0, -100_013.89, 'cash fell by 100,000.00 and 13.89 interest, once');
  c.eq(count(`SELECT COUNT(DISTINCT event_id) AS n FROM entries WHERE book_id = ? AND account = 'loan.liab'`, book.id), 2, 'the principal moved twice in all: drawdown and one repayment');

  // 2. Manual cash flow on the stock position.
  let drawer = await openStrategyDrawer(b, book, long.id);
  let dlg = await openLifecycle(b, drawer, 'DCR', 'Manual cash flow', /^Manual cash flow: DCR/);
  await ui.select(dlg, 'Kind of cash flow').selectOption({ label: 'Dividend' });
  await ui.input(dlg, 'Amount (USD)').fill('125');
  const cash1 = (await b.cash(book.id, book.accountId)).settled;
  const events1 = (await b.books(book.id)).counts.events;
  sent = watchRequests(page, 'POST', /\/lifecycle$/);
  await ui.button(dlg, 'Record cash flow').dblclick();
  await dlg.waitFor({ state: 'hidden' });
  await ui.toast(/Cash flow recorded/);
  sent.stop();
  c.eq(sent.seen.length, 1, 'Record cash flow double-clicked: one request');
  c.near((await b.cash(book.id, book.accountId)).settled - cash1, 125, 'the Account received 125.00 once');
  c.eq((await b.books(book.id)).counts.events - events1, 1, 'one event was recorded');

  // 3. Lender recall on the borrow behind the short sale.
  drawer = await openStrategyDrawer(b, book, short.id);
  dlg = await openLifecycle(b, drawer, 'DCS', 'Lender recall', /^Lender recall: /);
  const recalls = () => count(`SELECT COUNT(*) AS n FROM tasks WHERE book_id = ? AND type = 'secloan.recall'`, book.id);
  const notices = () => count(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE 'secloan.recall%'`, book.id);
  const [r0, n0] = [recalls(), notices()];
  sent = watchRequests(page, 'POST', /\/lifecycle$/);
  await ui.button(dlg, 'Record lender recall').dblclick();
  await dlg.waitFor({ state: 'hidden' });
  await ui.toast(/Lender recall recorded/);
  sent.stop();
  c.eq(sent.seen.length, 1, 'Record lender recall double-clicked: one request');
  c.eq([recalls() - r0, notices() - n0], [1, 1], 'one recall deadline and one recall notice were recorded');

  // 4. A cash dividend recorded by hand on the instrument page.
  await ui.closeOverlays();
  const idrawer = await ui.openInstrument(inst);
  await ui.tab(idrawer, 'History and actions');
  const panel = ui.section(idrawer, 'Dividends and corporate actions');
  await ui.field(panel, 'Ex-date').locator('input').fill('2026-03-05');
  await ui.input(panel, 'Amount per unit').fill('0.5');
  const ca0 = count('SELECT COUNT(*) AS n FROM corporate_actions WHERE instrument_id = ?', inst.id);
  sent = watchRequests(page, 'POST', /\/corporate-actions$/);
  await ui.button(panel, 'Record').dblclick();
  await ui.toast(/Dividend recorded/);
  await ui.drawn();
  sent.stop();
  c.note(`Record (corporate action) double-clicked: ${sent.seen.length} request${sent.seen.length === 1 ? '' : 's'} left the page`);
  c.eq(count('SELECT COUNT(*) AS n FROM corporate_actions WHERE instrument_id = ?', inst.id) - ca0, 1, 'one corporate action is recorded');
  // It pays once: 100 shares x 0.50 on Thursday 5 March.
  await ui.closeOverlays();
  await b.clock('2026-03-05T15:00:00.000Z');
  await b.tick();
  c.near(Math.abs(await b.balance(book.id, book.accountId, 'pnl.dividend')), 125 + 50, 'dividend income is 125.00 (by hand) + 50.00 (100 x 0.50), each once');
  b.takePageErrors().forEach((e) => { if (!/400|Bad Request/.test(e)) c.fail(`browser console error: ${e}`); });
  await b.clean(c, book.id);
}
