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
import { tabOf } from '../../../server/core/catalog.js';

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
  b.entered = book;
}
/**
 * Close the post-trade hedge popup whenever the engine has produced one (after a Marketplace fill), so that it never
 * sits on top of the next step. While the Book entered still has a prompt the page has not shown, wait for it.
 */
export async function closeHedgePopup(b) {
  const { page } = b;
  const popup = page.getByRole('dialog', { name: /^Hedge/ });
  for (let i = 0; i < 12; i++) {
    if (await popup.count()) {
      // Wait for this popup to go, not for every popup: the next waiting prompt may open as soon as it closes.
      const one = await popup.first().elementHandle();
      await popup.first().locator('header').getByRole('button', { name: 'Close' }).click();
      await one.waitForElementState('hidden');
      continue;
    }
    if (!b.entered || await page.getByRole('dialog').count()) return;
    const waiting = (await b.get('/api/hedge/prompts', { bookId: b.entered.id })).items;
    if (!waiting.length) return;
    await popup.waitFor({ timeout: 8000 }).catch(() => {});
    if (!await popup.count()) { await page.reload(); await page.locator('.shell .topbar').waitFor(); }
  }
  throw new Error('Hedge prompts kept appearing.');
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

async function openStrategyDrawer(b, book, strategyId, unitId = book.accountId) {
  const { page, ui } = b;
  await closeHedgePopup(b);
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/positions/${unitId}`);
  await closeHedgePopup(b);
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
  await closeHedgePopup(b); // a post-trade prompt may open over the top bar at any moment
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

// ---------------------------------------------------------------------------------------------
// Missing and stale prices and conversion rates, on the ticket and on the valuation screens
// ---------------------------------------------------------------------------------------------

/** The Accounting header of the whole Book: the net asset value as displayed, whether it is marked provisional, and why. */
async function navShown(b, book) {
  const { page, ui } = b;
  await closeHedgePopup(b);
  await ui.closeOverlays();
  await ui.reloadAt('#/accounting/positions/book');
  await closeHedgePopup(b);
  const stat = page.locator('main .stat').filter({ hasText: 'Net asset value' }).first();
  await stat.waitFor();
  const shown = flat(await stat.locator('.v').innerText());
  const value = shown.replace(/\s*provisional$/, '');
  const reasons = (await page.locator('main .notice.warn', { hasText: 'Provisional.' }).first().locator('li').allInnerTexts().catch(() => [])).map(flat);
  void book;
  return { value, provisional: /provisional$/.test(shown), brief: flat(await stat.locator('.s').innerText()), reasons };
}
/** The Books page row of this Book. */
async function booksRow(b, book) {
  await b.ui.reloadAt('#/books');
  const row = b.page.locator('main table tbody tr').filter({ hasText: book.name }).first();
  await row.getByText(/\d,\d{3}\.\d\d/).first().waitFor(); // its net asset value is loaded after the list
  return flat(await row.innerText());
}
const SEK_STOCK = { productId: 'common_stock', name: 'Nordholm Verkstad AB', symbol: 'NORD', marketView: 'FOREIGN_CASH', venue: 'XSTO', venueType: 'exchange', venueCountry: 'SE', issuer: 'Nordholm Verkstad AB', domicile: 'SE', underlyingGeo: 'SE', tradingCcy: 'SEK', terms: {} };

/** SB:refusals:quote-missing, quote-stale, fx-missing, fx-stale. */
export async function provisionalNav(b, c, kind) {
  const { page, ui } = b;
  const book = await b.book(`Browser ${kind}`);
  const pendingOpen = async () => {
    await ui.closeOverlays();
    await ui.reloadAt(`#/accounting/pending/${book.accountId}`);
    await page.locator('main').getByText('Executed trades awaiting settlement').first().waitFor();
    return ui.section(page.locator('main'), 'Open orders');
  };

  if (kind === 'quote-missing' || kind === 'quote-stale') {
    const missing = kind === 'quote-missing';
    const inst = missing ? await b.stock('BQM', null) : await b.stock('BQS', { bid: 20.00, ask: 20.02, last: 20.01, bidSize: 5000, askSize: 5000, asOf: '2026-03-02T14:00:00.000Z' });
    await enter(b, book, '#/markets/US_CASH');
    const before = await b.books(book.id);
    const drawer = await fillTicket(b, inst, { qty: 100, order: { tif: 'gtc' } });
    const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
    const warnings = (await modal.locator('.checks .notice.warn').allInnerTexts()).map(flat).join(' | ');
    c.match(warnings, missing ? /no price for BQM/ : /36\d\d seconds old/, missing ? 'the preview dialog warns that there is no price for BQM' : 'the preview dialog warns how old the quote is');
    c.match(flat(await modal.locator('table').first().innerText()), /no executable price/, 'the leg shows "no executable price" where the estimated fill would be');
    c.eq(pv.legs[0].price.estimate, null, 'the preview carries no estimated fill');
    await confirm.click();
    await modal.waitFor({ state: 'hidden' });
    let open = await pendingOpen();
    const row = flat(await open.locator('tbody tr').first().innerText());
    c.match(row, missing ? /No price is available/ : /BQS/, missing ? 'the Pending tab shows the order waiting, with the reason: no price' : 'the Pending tab shows the order waiting');
    c.note(`Pending tab row: "${row.slice(0, 200)}"`);
    await b.tick(); await b.tick(); await b.tick();
    let now = await b.books(book.id);
    c.eq([now.counts.fills, now.counts.entries - before.counts.entries], [0, 0], 'three cycles: no fill and no ledger entry');
    if (missing) {
      open = await pendingOpen();
      await ui.button(open.locator('tbody tr').first(), 'Cancel order').click();
      await ui.toast(/Order cancelled/);
      now = await b.books(book.id);
      c.eq([now.counts.fills, now.ledger.positions.length], [0, 0], 'cancelled from the Pending tab: no fill, no position');
    } else {
      await b.fixture('quote', { instrumentId: inst.id, bid: 20.08, ask: 20.10, last: 20.10, bidSize: 5000, askSize: 5000 });
      await b.tick();
      c.eq(b.sql('SELECT qty, price FROM fills').map((f) => [f.qty, f.price]), [[100, 20.1]], 'a fresh quote: one fill of 100 at the fresh ask 20.10');
      await b.tick();
      c.eq((await b.books(book.id)).counts.fills, 1, 'another cycle does not fill again');
    }
    await closeHedgePopup(b);

    // Valuation.
    const held = await b.stock(missing ? 'BQH' : 'BQT');
    await b.buy(book, held, 100);
    const commissions = missing ? 1 : 2;
    let nav = await navShown(b, book);
    await closeHedgePopup(b);
    c.eq([nav.value, nav.provisional], [`${(1_000_000 - commissions - 1).toLocaleString('en-US')}.00`, false], `priced and current: the net asset value shows ${(1_000_000 - commissions - 1).toLocaleString('en-US')}.00, not provisional`);
    if (missing) await b.fixture('quote', { instrumentId: held.id, clear: true });
    else await b.fixture('quote', { instrumentId: held.id, bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000, asOf: '2026-03-02T13:00:00.000Z' });
    nav = await navShown(b, book);
    // missing: carried at cost, 1,000,000 - 1.00 commission; stale: still valued at 50.01
    const expected = missing ? '999,999.00' : '999,997.00';
    c.eq([nav.value, nav.provisional], [expected, true], `the net asset value shows ${expected} marked provisional`);
    c.match(nav.brief, missing ? /Provisional: BQH has no price/ : /Provisional: BQT is on a stale mark/, 'under it: which holding and why');
    c.ok(nav.reasons.some((x) => new RegExp(missing ? 'BQH' : 'BQT').test(x) && /Alpha/.test(x)), 'the list of reasons names the holding and its owner', nav.reasons.join(' | '));
    const rowText = (await page.locator('main table tbody tr').filter({ hasText: missing ? 'BQH' : 'BQT' }).allInnerTexts()).map(flat).join(' || ');
    if (missing) c.match(rowText, /no price/, 'the position row says "no price" where the price would be');
    else c.match(rowText, /50\.01/, 'the position row still shows the stale mark 50.01');
    c.match(await booksRow(b, book), /provisional/, 'the Books page marks this Book\'s net asset value provisional too');
    await b.fixture('quote', { instrumentId: held.id, bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000 });
    nav = await navShown(b, book);
    c.eq(nav.provisional, false, 'with a current quote again the figure is final');
    await b.clean(c, book.id);
    return;
  }

  // Conversion rates. The SEK arrives through the Deposit dialog.
  const missing = kind === 'fx-missing';
  if (!missing) await b.fixture('fx', { pair: 'SEK/USD', rate: 0.10 });
  await enter(b, book, '#/treasury');
  const dlg = await openCapital(b, { type: 'deposit', amount: 1_000_000, ccy: 'SEK' });
  const dep = await ui.respondsTo('POST', /\/capital$/, () => ui.button(dlg, 'Record deposit').click());
  c.ok(dep.ok, 'the deposit of 1,000,000 SEK is recorded', dep.body?.error);
  await dlg.waitFor({ state: 'hidden' });
  let nav = await navShown(b, book);
  if (missing) {
    c.eq([nav.value, nav.provisional], ['1,000,000.00', true], 'no SEK/USD rate: the net asset value shows the USD balances only, 1,000,000.00, marked provisional');
    c.match(nav.brief, /Provisional: SEK has no conversion rate/, 'and says SEK has no conversion rate');
    c.ok(b.sql(`SELECT amount_rc FROM entries WHERE book_id = ? AND ccy = 'SEK'`, book.id).every((e) => e.amount_rc === null), 'the SEK entries carry no USD equivalent (NULL, not zero)');
  } else {
    c.eq([nav.value, nav.provisional], ['1,100,000.00', false], 'current rate 0.10: 1,100,000.00, not provisional');
    await b.fixture('fx', { pair: 'SEK/USD', rate: 0.10, asOf: '2026-03-02T13:00:00.000Z' });
    nav = await navShown(b, book);
    c.eq([nav.value, nav.provisional], ['1,100,000.00', true], 'the rate two hours old: the same 1,100,000.00, marked provisional');
    c.match(nav.brief, /Provisional: SEK is on a stale conversion rate/, 'and says SEK is on a stale conversion rate');
  }
  c.match(await booksRow(b, book), /provisional/, 'the Books page marks the net asset value provisional too');
  // A SEK purchase from Treasury's SEK, from the ticket.
  const se = await b.instrument(SEK_STOCK);
  await b.fixture('quote', { instrumentId: se.id, bid: 100.00, ask: 100.20, last: 100.10, bidSize: 5000, askSize: 5000 });
  const drawer = await fillTicket(b, se, { account: 'Treasury', qty: 100 });
  const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
  const warnings = (await modal.locator('.checks .notice').allInnerTexts()).map(flat).join(' | ');
  c.match(warnings, missing ? /SEK\/USD|SEK.*conversion rate|conversion rate.*SEK/i : /SEK.*(not current|stale|old)|(not current|stale|old).*SEK/i, `the preview dialog names the ${missing ? 'missing' : 'stale'} SEK/USD rate`);
  c.eq(pv.blocking, 0, 'the purchase itself, paid in SEK, is not blocked');
  if (missing) {
    await confirm.click();
    await modal.waitFor({ state: 'hidden' });
    await b.tick();
    await closeHedgePopup(b);
    c.eq(b.sql('SELECT qty, price FROM fills').map((f) => [f.qty, f.price]), [[100, 100.2]], 'it executes in SEK: 100 at 100.20');
    await b.fixture('fx', { pair: 'SEK/USD', rate: 0.10 });
    nav = await navShown(b, book);
    // 1,000,000.00 USD + 0.10 x (1,000,000 - 10,021.00 owed + 10,010.00 holding) SEK
    c.eq([nav.value, nav.provisional], ['1,099,998.90', false], 'with a rate of 0.10 the net asset value is final: 1,099,998.90');
  } else {
    await ui.button(modal, 'Cancel').click();
    await modal.waitFor({ state: 'hidden' });
    await b.fixture('fx', { pair: 'SEK/USD', rate: 0.10 });
    nav = await navShown(b, book);
    c.eq([nav.value, nav.provisional], ['1,100,000.00', false], 'with a current rate the figure is final again');
  }
  await b.clean(c, book.id);
}

/** SB:refusals:incomplete-terms. The registry form with a term left out. */
export async function incompleteTerms(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser incomplete terms');
  await enter(b, book, '#/instruments');
  const count = () => b.sql('SELECT COUNT(*) AS n FROM instruments')[0].n;
  const n0 = count();
  // Nothing decides the market view (routing convention, server/core/catalog.js conventionRoute): a note marked as
  // exchange-traded with no venue country, no jurisdiction and no view chosen. The form itself stops, before anything is sent.
  {
    await ui.button(page.locator('main'), 'New instrument').first().click();
    const dlg = ui.dialog('New instrument');
    await ui.select(dlg, 'Product type').selectOption('treasury_note');
    await ui.drawn();
    await ui.input(dlg, 'Name').fill('Note with nothing but a name');
    await ui.option(dlg, 'Traded on', 'Exchange').click();
    const sent = watchRequests(page, 'POST', /^\/api\/instruments$/);
    await ui.button(dlg, 'Register instrument').click();
    await dlg.getByText(/Nothing decides the market view/).first().waitFor();
    sent.stop();
    c.eq(sent.seen.length, 0, 'nothing but a name, no venue country: the form sends nothing');
    c.match(flat(await dlg.innerText()), /Not saved\./, 'and says "Not saved"');
    await ui.button(dlg, 'Cancel').click();
    await dlg.waitFor({ state: 'hidden' });
  }
  const attempt = async (label, productId, name, text, otc = false) => {
    await ui.closeOverlays();
    await ui.goto('#/instruments');
    await ui.button(page.locator('main'), 'New instrument').first().click();
    const dlg = ui.dialog('New instrument');
    await ui.select(dlg, 'Product type').selectOption(productId);
    await ui.drawn();
    await ui.input(dlg, 'Name').fill(name);
    await ui.input(dlg, 'Venue country').fill('US');
    const view = ui.option(dlg, 'Primary view', 'US Based'); // an OTC product is not placed by its venue: the view is chosen
    if (otc && await view.count()) await view.click();
    const reg = await ui.respondsTo('POST', /^\/api\/instruments$/, () => ui.button(dlg, 'Register instrument').click());
    c.eq([reg.ok, reg.status], [false, 400], `${label}: the server refuses the registration`);
    await dlg.locator('.notice.err').first().waitFor();
    const shown = (await errorsIn(dlg)).join(' | ');
    c.match(shown, /The instrument was not saved\./, `${label}: the form says the instrument was not saved`);
    c.match(shown, text, `${label}: and names what is missing`);
    c.eq(await ui.input(dlg, 'Name').inputValue(), name, `${label}: the form stays open with what was typed`);
    c.note(`${label}: "${shown.slice(0, 240)}"`);
    await ui.button(dlg, 'Cancel').click();
    await dlg.waitFor({ state: 'hidden' });
  };
  await attempt('an option with no strike', 'equity_option', 'Option without a strike', /strike/i);
  await attempt('a bond with no maturity', 'treasury_note', 'Bond without a maturity', /maturity/i, true);
  await attempt('a future with no expiration', 'equity_index_future', 'Future without terms', /expiration|multiplier/i);
  c.eq(count(), n0, 'nothing was registered');
}

// ---------------------------------------------------------------------------------------------
// Collateral: the repo ticket, the sale of a pledged holding, an OTC independent amount
// ---------------------------------------------------------------------------------------------

const NOTE = { productId: 'treasury_note', name: 'Test Treasury 4% 15-Mar-2031', symbol: 'TTSY31', marketView: 'US_CASH', venueType: 'otc', issuer: 'Test Treasury', domicile: 'US', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2031-03-15', issueDate: '2021-03-15', dayCount: 'ACT/ACT', redemption: 100 } };
/** Treasury holding 1,000,000 face of a note at 100.00, on Tuesday. */
async function treasuryWithNote(b, name) {
  const book = await b.book(name, { capital: 3_000_000, funding: 0 });
  const bond = await b.instrument(NOTE);
  await b.fixture('quote', { instrumentId: bond.id, bid: 99.98, ask: 100.00, last: 100.00, bidSize: 5e6, askSize: 5e6 });
  const hold = await b.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: bond.id, qty: 1_000_000 }] });
  await b.clock(TUE);
  return { book, bond, hold };
}
/** The blocking reasons a preview dialog shows, whether Confirm can be pressed, and the totals line. */
async function previewState(modal) {
  return {
    blocks: (await modal.locator('.checks .notice.err').allInnerTexts()).map(flat),
    confirmDisabled: await modal.getByRole('button', { name: /^Confirm/ }).isDisabled(),
    totals: flat(await modal.locator('.pv-totals').innerText()),
  };
}
/** "New repo or reverse repo" on Treasury's Borrowings page, filled for a repo by Treasury against the note; Preview pressed. */
async function previewRepo(b, { cash, face }) {
  const { page, ui } = b;
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury/borrowings');
  await ui.button(page.locator('main'), 'New repo or reverse repo').click();
  const dlg = ui.dialog('Repo or reverse repo');
  await dlg.waitFor();
  await ui.select(dlg, 'Borrower').selectOption({ label: 'Treasury' });
  const picker = ui.field(dlg, 'Collateral position').locator('select').first();
  await picker.locator('option', { hasText: 'TTSY31' }).first().waitFor({ state: 'attached' });
  const label = (await picker.locator('option').allInnerTexts()).map((x) => x.trim()).find((x) => x.startsWith('TTSY31:'));
  await picker.selectOption({ label });
  await ui.drawn();
  await ui.input(dlg, 'Cash principal').fill(String(cash));
  await ui.input(dlg, 'Collateral quantity').fill(String(face));
  await ui.input(dlg, 'Haircut (decimal)').fill('0.02');
  await ui.input(dlg, 'Rate (decimal a year)').fill('0.045');
  await ui.input(dlg, 'End date').fill('2026-03-10');
  const guide = flat(await dlg.locator('p.note', { hasText: 'Collateral:' }).innerText().catch(() => ''));
  const asked = await ui.respondsTo('POST', /^\/api\/strategies\/preview$/, () => ui.button(dlg, 'Preview repo').click());
  if (!asked.ok) { await dlg.locator('.notice.err').first().waitFor(); return { asked, dlg, modal: null, guide, refusal: (await errorsIn(dlg)).join(' | ') }; }
  const modal = ui.dialog(/^Preview: /);
  await modal.waitFor();
  return { asked, dlg, modal, guide };
}

/** SB:refusals:collateral-repo. */
export async function collateralRepo(b, c) {
  const { ui } = b;
  const { book } = await treasuryWithNote(b, 'Browser collateral repo');
  await enter(b, book, '#/treasury/borrowings');
  const before = await b.books(book.id);
  const cashBefore = (await b.cash(book.id, book.treasuryId)).settled;
  const refusedRepo = async (label, spec, text) => {
    const r = await previewRepo(b, spec);
    if (!r.modal) { c.match(r.refusal, text, `${label}: the ticket shows the reason`); return; }
    const st = await previewState(r.modal);
    c.match(st.blocks.join(' | '), text, `${label}: the preview dialog shows the blocking reason`);
    c.eq(st.confirmDisabled, true, `${label}: it cannot be confirmed`);
    c.note(`${label}: "${st.blocks.join(' | ').slice(0, 200)}"`);
    await ui.button(r.modal, 'Cancel').click();
    await r.modal.waitFor({ state: 'hidden' });
  };
  await refusedRepo('(a) pledging 2,000,000 face of the 1,000,000 held', { cash: 980_000, face: 2_000_000 }, /Only 1,000,000 of the collateral is unencumbered; 2,000,000 is needed/);
  await refusedRepo('(b) 2,000,000.00 of cash against 1,000,000 face', { cash: 2_000_000, face: 1_000_000 }, /collateral|haircut/i);
  w_same(b, c, before, await b.books(book.id), 'after the refused repos');
  const ok = await previewRepo(b, { cash: 900_000, face: 1_000_000 });
  c.match(ok.guide, /after the haircut/, '(c) the ticket shows what the collateral is worth after the haircut');
  c.note(`repo ticket guide: "${ok.guide.slice(0, 260)}"`);
  const st = await previewState(ok.modal);
  c.eq([st.blocks, st.confirmDisabled], [[], false], '(c) 900,000.00 against 1,000,000 face previews without a block');
  await ok.modal.getByRole('button', { name: /^Confirm/ }).click();
  await ok.modal.waitFor({ state: 'hidden' });
  await b.tick();
  c.near((await b.cash(book.id, book.treasuryId)).settled, cashBefore + 900_000, '(c) confirmed: Treasury cash is up by 900,000.00');
  await refusedRepo('(d) pledging the same holding again', { cash: 50_000, face: 100_000 }, /Only 0 of the collateral is unencumbered; 100,000 is needed/);
  await b.clean(c, book.id);
}

/** SB:refusals:collateral-pledged-position. */
export async function pledgedSale(b, c) {
  const { page, ui } = b;
  const { book, bond, hold } = await treasuryWithNote(b, 'Browser pledged position');
  await b.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'repo_open', action: 'repo', qty: 900_000, purpose: 'financing', collateralPositionId: hold.positions[0].positionId, contract: { productId: 'term_repo', name: 'Repo TTSY31', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: bond.id, collateralQty: 1_000_000, haircut: 0.02, rateType: 'fixed', rate: 0.045, term: 'term', endDate: '2026-03-10' } } }] });
  await enter(b, book);
  const before = await b.books(book.id);
  const status0 = (await b.strategy(hold.id)).status;
  const closeFromDrawer = async () => {
    const drawer = await openStrategyDrawer(b, book, hold.id, book.treasuryId);
    const row = ui.section(drawer, 'Positions').locator('tbody tr').filter({ hasText: 'TTSY31' }).first();
    c.match(flat(await row.innerText()), /pledged 1,000,000|TTSY31/, 'the drawer lists the note');
    await ui.button(row, 'Close').click();
    const modal = ui.dialog(/^Preview: /);
    await modal.waitFor();
    return modal;
  };
  let modal = await closeFromDrawer();
  let st = await previewState(modal);
  c.match(st.blocks.join(' | '), /unencumbered|pledged/i, 'selling the pledged note: the preview dialog shows the blocking reason');
  c.eq(st.confirmDisabled, true, 'it cannot be confirmed');
  c.note(`pledged sale: "${st.blocks.join(' | ').slice(0, 200)}"`);
  await ui.button(modal, 'Cancel').click();
  await modal.waitFor({ state: 'hidden' });
  w_same(b, c, before, await b.books(book.id), 'after the refused sale');
  c.eq((await b.strategy(hold.id)).status, status0, 'the holding\'s strategy instance keeps its status');
  // The repo is repurchased from the Borrowings page; the note is free again.
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury/borrowings');
  await ui.button(ui.section(page.locator('main'), 'Treasury\'s own borrowings'), 'Repurchase').first().click();
  modal = ui.dialog(/^Preview: /);
  await modal.waitFor();
  await ui.button(modal, 'Confirm repurchase').click();
  await modal.waitFor({ state: 'hidden' });
  await b.tick();
  modal = await closeFromDrawer();
  st = await previewState(modal);
  c.eq([st.blocks, st.confirmDisabled], [[], false], 'after the repurchase the same sale previews without a block');
  await ui.button(modal, 'Cancel').click();
  await modal.waitFor({ state: 'hidden' });
  await b.clean(c, book.id);
}

/** SB:refusals:collateral-independent-amount. */
export async function independentAmount(b, c) {
  const { ui } = b;
  const book = await b.book('Browser independent amount', { funding: 30_000 });
  const agr = await b.post(`/api/books/${book.id}/agreements`, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [book.accountId], terms: { independentAmount: { type: 'pct', pct: 0.05 } } });
  const cds = await b.instrument({ productId: 'cds_single_name', name: 'CDS Acme 2031', symbol: 'CDSACME', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { referenceEntity: 'Acme Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, counterparty: 'Dealer A', collateralBasis: { type: 'agreement', agreementId: agr.id } } });
  await enter(b, book, '#/markets/US_DERIV');
  const before = await b.books(book.id);
  const ticket = async (notional) => {
    const drawer = await ui.openInstrument(cds);
    await ui.tab(drawer, 'Trade');
    await ui.select(drawer, 'Account').selectOption({ label: 'Alpha' });
    const label = cds.actionLabels?.buy;
    if (label) await ui.option(drawer, 'Action', label).click();
    await ui.input(drawer, cds.qtyLabel || 'Notional').fill(String(notional));
    await ui.input(drawer, 'State a fill price').fill('0');
    return openPreviewFrom(b, drawer);
  };
  let p = await ticket(1_000_000);
  let st = await previewState(p.modal);
  c.match(st.blocks.join(' | '), /independent amount of 50,000\.00 USD .* cannot be posted: Alpha has 30,000\.00 USD/, '1,000,000 notional: the preview dialog names the 50,000.00 independent amount and the 30,000.00 there');
  c.match(st.totals, /short 20,000\.00 USD/, 'the totals line shows the 20,000.00 shortfall');
  c.eq(st.confirmDisabled, true, 'it cannot be confirmed');
  await ui.button(p.modal, 'Cancel').click();
  await p.modal.waitFor({ state: 'hidden' });
  w_same(b, c, before, await b.books(book.id), 'after the refusal');
  p = await ticket(600_000);
  st = await previewState(p.modal);
  c.eq([st.blocks, st.confirmDisabled], [[], false], '600,000 notional (30,000.00 needed) previews without a block');
  await p.confirm.click();
  await p.modal.waitFor({ state: 'hidden' });
  await b.tick();
  const cash = await b.cash(book.id, book.accountId);
  c.near(cash.margin, 30_000, 'confirmed: 30,000.00 is posted as margin');
  c.near(cash.settled, 0, 'and has left settled cash');
  await closeHedgePopup(b);
  await b.clean(c, book.id);
}

// ---------------------------------------------------------------------------------------------
// Shared steps for the screens read whole: requests settled, and the page scanned for what must not be there
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Wait until the page has no API request in flight (the event stream excepted) and none has started for `quietMs`,
 * then for the browser to draw. Screens load their data after they appear, so this is what "loaded" means here.
 */
async function settle(b, quietMs = 400) {
  const { page } = b;
  if (!b.net) {
    const n = { busy: new Map(), last: Date.now() };
    const api = (r) => { try { const p = new URL(r.url()).pathname; return p.startsWith('/api/') && p !== '/api/stream'; } catch { return false; } };
    page.on('request', (r) => { if (api(r)) { n.busy.set(r, Date.now()); n.last = Date.now(); } });
    const done = (r) => { if (n.busy.delete(r)) n.last = Date.now(); };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    // A full reload abandons what the old document had in flight, and not every abandoned request is reported.
    page.on('domcontentloaded', () => { n.busy.clear(); n.last = Date.now(); });
    b.net = n;
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    for (const [r, since] of b.net.busy) if (Date.now() - since > 15_000) b.net.busy.delete(r); // never answered: not "loading" any more
    if (!b.net.busy.size && Date.now() - b.net.last >= quietMs) { await b.ui.drawn(); return; }
    await sleep(50);
  }
  throw new Error(`The page kept requesting for 20 seconds (${b.net.busy.size} in flight).`);
}
/**
 * Click and return the API answer it causes, as ui.respondsTo does, except that a click that fails cannot leave the
 * wait for the answer behind as an unhandled rejection (which would end the whole run, not just the case).
 */
async function answerTo(b, method, pathPattern, click) {
  const wait = b.page.waitForResponse((r) => r.request().method() === method && pathPattern.test(new URL(r.url()).pathname));
  wait.catch(() => {});
  await click();
  const res = await wait;
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { ok: res.ok(), status: res.status(), body };
}
/** Go to a screen of the selected Book and wait until its data has loaded. */
async function show(b, hash) {
  await b.ui.closeOverlays().catch(() => {});
  await b.ui.goto(hash);
  await settle(b);
}
/**
 * The Marketplace row of an instrument, reached the way the shared driver's openInstrument reaches it (test/matrix/
 * drivers/browser.mjs): its market view, then its product-family tab (the API's classification, else the catalog's),
 * then the filter by symbol. Returns the row locator, drawn and settled.
 */
async function marketRow(b, inst) {
  const tab = inst.classification?.tab || tabOf(inst.productId || inst.product_id);
  await show(b, `#/markets/${inst.marketView || inst.market_view}${tab ? `/${tab}` : ''}`);
  await closeHedgePopup(b);
  await b.page.getByPlaceholder(/Filter by symbol/).fill(inst.symbol);
  const row = b.page.locator('main table tbody tr').filter({ has: b.page.locator('.sym', { hasText: exactly(inst.symbol) }) }).first();
  await row.waitFor();
  await settle(b);
  return row;
}
/**
 * Everything the page shows and carries (text, titles, data attributes, option values), except the Book selector
 * of the top bar, which lists every Book by name by design. Returns the needles found.
 */
async function foundOnPage(b, needles, scope = 'body') {
  const html = await b.page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return '';
    const copy = root.cloneNode(true);
    copy.querySelectorAll('.topbar select').forEach((x) => x.remove());
    return copy.innerHTML;
  }, scope);
  return needles.filter((x) => x && html.includes(x));
}
/** The labels of a select's options (placeholders, empty values and "+ New" entries left out). */
const optionLabels = async (select) => (await select.locator('option').evaluateAll((os) => os.filter((o) => o.value && !o.value.startsWith('__')).map((o) => o.textContent.trim())));
/** The Book selector of the top bar, used as a user does. */
async function switchBook(b, book) {
  const selector = b.page.locator('.topbar select').first();
  await selector.selectOption({ label: book.name });
  await selector.locator('option:checked', { hasText: exactly(book.name) }).waitFor({ state: 'attached' });
  b.entered = book;
  await settle(b);
}

// ---------------------------------------------------------------------------------------------
// Isolation: Book isolation through the interface, nothing netted across Books
// ---------------------------------------------------------------------------------------------

/** What belongs to one Book alone and must never be on another Book's screens: its ids and its names. */
const needlesOf = (X) => [...new Set([...X.ids, ...X.names, `${X.name} loan`, `${X.name} IRS`])];

/** SB:isolation:book-routes. */
export async function bookIsolation(b, c) {
  const { page, ui } = b;
  const { twoBooks } = await import('../cases/isolation.mjs');
  const { inst, A, B } = await twoBooks(b);
  const notA = needlesOf(A), notB = needlesOf(B);
  // Each Book's post-trade hedge popup is shown once (that marks it seen); from then on nothing may be stored.
  await enter(b, A, '#/accounting');
  await closeHedgePopup(b);
  await switchBook(b, B);
  await closeHedgePopup(b);
  const stored = b.fingerprint();

  // (1) Every screen of Book B, read whole.
  const screens = [
    ...['pnl', 'balance', 'positions', 'pending', 'failed', 'history'].flatMap((t) => ['book', B.treasuryId, B.accountId].map((s) => `#/accounting/${t}/${s}`)),
    ...['cash', 'borrowings', 'collateral', 'holds', 'alerts'].map((t) => `#/treasury/${t}`),
    `#/account/${B.accountId}`, '#/strategy', '#/markets/US_CASH', '#/markets/US_DERIV', '#/instruments',
  ];
  const leaks = [];
  const blank = [];
  for (const hash of screens) {
    await show(b, hash);
    await closeHedgePopup(b);
    const found = await foundOnPage(b, notA);
    if (found.length) leaks.push(`${hash}: ${found.join(', ')}`);
    // Not an empty screen: it shows at least one id or name of Iso B's own (the scan above would pass on a blank page).
    if (!(await foundOnPage(b, notB, 'main')).length) blank.push(hash);
    const errs = await errorsIn(page.locator('main'));
    c.eq(errs, [], `${hash} of Iso B loads without an error`);
  }
  c.eq(leaks, [], `${screens.length} screens of Iso B read whole: none shows or carries an id or a name of Iso A`);
  c.note(`${screens.length} screens of Iso B scanned for ${notA.length} ids and names of Iso A; screens showing none of Iso B's own ids or names either: ${blank.join(', ') || 'none'}`);
  c.ok(blank.length <= 4, 'the screens read did show Iso B\'s own records (at most a few global ones show none)', blank.join(', '));
  // The screens did show Book B's own: its Account and its short holding.
  await show(b, '#/accounting/positions/book');
  const holdings = flat(await ui.section(page.locator('main'), 'Holdings by instrument').innerText());
  c.match(holdings, /ISO/, 'Iso B\'s Open positions list its own ISO holding');
  c.match(flat(await page.locator('main').innerText()), /Bison/, 'and name its own Account, Bison');

  // (2) The instrument everyone can trade, opened from the Marketplace: its drawer shows B's holding only.
  const drawer = await ui.openInstrument(inst);
  await settle(b);
  c.eq(await foundOnPage(b, notA, '[role=dialog]'), [], 'the ISO drawer opened in Iso B carries nothing of Iso A');
  await ui.tab(drawer, 'Trade');
  const owners = await optionLabels(ui.select(drawer, 'Account'));
  c.eq(owners.sort(), ['Bison', 'Treasury'], 'the ticket offers Iso B\'s owners only: Treasury and Bison');
  await ui.closeOverlays();

  // (3) Every picker that lists owners or positions.
  await show(b, '#/treasury/cash');
  await ui.button(page.locator('main'), 'Transfer cash').first().click();
  let dlg = ui.dialog('Transfer cash');
  await dlg.waitFor();
  await settle(b);
  c.eq((await optionLabels(ui.select(dlg, 'Source'))).sort(), ['Bison', 'Treasury'], 'Transfer cash: the sources are Iso B\'s Treasury and Bison');
  c.eq(await optionLabels(ui.select(dlg, 'Destination')), ['Bison'], 'Transfer cash: from Treasury, the one destination is Bison');
  await ui.select(dlg, 'Source').selectOption({ label: 'Bison' });
  c.eq(await optionLabels(ui.select(dlg, 'Destination')), ['Treasury'], 'from Bison, the one destination is Treasury');
  c.eq(await foundOnPage(b, notA, '[role=dialog]'), [], 'the Transfer dialog carries nothing of Iso A');
  await ui.closeOverlays();
  await show(b, '#/treasury/borrowings');
  await ui.button(page.locator('main'), 'New repo or reverse repo').click();
  dlg = ui.dialog('Repo or reverse repo');
  await dlg.waitFor();
  await settle(b);
  c.eq((await optionLabels(ui.select(dlg, 'Borrower'))).sort(), ['Bison', 'Treasury'], 'the repo ticket\'s borrowers are Iso B\'s');
  c.eq(await foundOnPage(b, notA, '[role=dialog]'), [], 'the repo ticket (its collateral positions included) carries nothing of Iso A');
  await ui.closeOverlays();
  await show(b, '#/accounting/history/book');
  await ui.button(page.locator('main'), 'Record a manual adjustment').click();
  dlg = ui.dialog('Record a manual adjustment');
  await dlg.waitFor();
  c.eq((await optionLabels(ui.select(dlg, 'Owner'))).sort(), ['Bison', 'Treasury'], 'the adjustment dialog\'s owners are Iso B\'s');
  await ui.closeOverlays();

  // (4) Addresses typed with an id of Book A, while Book B is selected.
  for (const [hash, what] of [[`#/accounting/positions/${A.accountId}`, 'Accounting scoped to Aardvark'], [`#/accounting/balance/${A.accountId},${B.accountId}`, 'Accounting scoped to Aardvark and Bison'], [`#/account/${A.accountId}`, 'the Account page of Aardvark'], [`#/strategy/attach/${A.long.id}`, 'the Strategy page attaching to Iso A\'s strategy instance']]) {
    await show(b, hash);
    await closeHedgePopup(b);
    const found = await foundOnPage(b, notA.filter((x) => !hash.includes(x)), 'main');
    c.eq(found, [], `${what}, typed in the address while Iso B is selected: nothing of Iso A is shown`);
    // A unit that is not of this Book is ignored: alone it leaves the whole Book; beside Bison it leaves Bison.
    if (hash.startsWith('#/accounting/')) c.match(flat(await page.locator('main .page-head').innerText()), hash.includes(',') ? /The Account Bison in Iso B, alone/ : /Iso B, consolidated/, `${what}: only Iso B's own units are in scope`);
    c.note(`${what}: "${flat(await page.locator('main').innerText()).slice(0, 160)}"`);
  }

  // (5) Switching Book leaves no stale row: on each screen, B -> A -> B.
  for (const hash of ['#/accounting/positions/book', '#/treasury/cash', '#/strategy', '#/accounting/history/book', '#/markets/US_CASH']) {
    await show(b, hash);
    await closeHedgePopup(b);
    await switchBook(b, A);
    await closeHedgePopup(b);
    c.eq(await foundOnPage(b, notB), [], `${hash}: switched from Iso B to Iso A, nothing of Iso B is left on the page`);
    await switchBook(b, B);
    await closeHedgePopup(b);
    c.eq(await foundOnPage(b, notA), [], `${hash}: switched back to Iso B, nothing of Iso A is left on the page`);
  }
  await switchBook(b, A);
  await show(b, '#/accounting/positions/book');
  c.match(flat(await ui.section(page.locator('main'), 'Holdings by instrument').innerText()), /ISO/, 'after the switch Iso A shows its own ISO holding');
  c.match(flat(await page.locator('main').innerText()), /Aardvark/, 'and its own Account, Aardvark');

  // Behind the screens: reading and switching stored nothing; both Books are clean.
  b.sameStored(c, stored, b.fingerprint(), 'reading every screen of both Books and switching between them stored nothing');
  await b.clean(c, A.id, 'Iso A integrity');
  await b.clean(c, B.id, 'Iso B integrity');
}

/** The ISO row of the selected Book's US Based Marketplace: what "Held in this Book" says, and its hover text. */
async function heldInMarketplace(b, inst) {
  const row = await marketRow(b, inst);
  const held = row.locator('.held').first();
  return { text: flat(await held.innerText()), title: flat(await held.getAttribute('title')) };
}
/** The Holdings by instrument row of an instrument, on the selected Book's whole-Book Open positions. */
async function holdingRow(b, symbol) {
  await show(b, '#/accounting/positions/book');
  await closeHedgePopup(b);
  const panel = b.ui.section(b.page.locator('main'), 'Holdings by instrument');
  return flat(await panel.locator('tbody tr').filter({ hasText: symbol }).first().innerText());
}
/** The rows of the selected Book's Full history (accruals left out) that mention `text`. */
async function historyRows(b, text) {
  await show(b, '#/accounting/history/book');
  const rows = b.page.locator('main table tbody tr').filter({ hasText: text });
  await rows.first().waitFor({ timeout: 10_000 }).catch(() => {}); // drawn after the history loads; none may match
  return (await rows.allInnerTexts()).map(flat);
}

/** SB:isolation:no-netting. */
export async function noNetting(b, c) {
  const { page, ui } = b;
  const { twoBooks } = await import('../cases/isolation.mjs');
  const { inst, A, B } = await twoBooks(b);
  await enter(b, A, '#/accounting');
  await closeHedgePopup(b);

  // Gross holdings, each Book its own, on the Marketplace and on Accounting.
  let m = await heldInMarketplace(b, inst);
  c.eq(m.text, 'Long 200', 'Iso A, US Based Marketplace: ISO is held "Long 200"');
  c.match(m.title, /^Aardvark: Long 200$/, 'its hover names Aardvark alone');
  let row = await holdingRow(b, 'ISO');
  c.match(row, /Long 200/, 'Iso A, Holdings by instrument: Long 200');
  c.ok(!/Short|Net|100/.test(row.replace(/ISO Test Works Inc\./, '')), 'and no short, net or 100 in it', row);
  const navA0 = (await navShown(b, A)).value;
  await switchBook(b, B);
  await closeHedgePopup(b);
  m = await heldInMarketplace(b, inst);
  c.eq(m.text, 'Short 100', 'Iso B, US Based Marketplace: ISO is held "Short 100"');
  c.match(m.title, /^Bison: Short 100$/, 'its hover names Bison alone');
  row = await holdingRow(b, 'ISO');
  c.match(row, /Short 100/, 'Iso B, Holdings by instrument: Short 100');
  c.ok(!/Long|Net|200/.test(row.replace(/ISO Test Works Inc\./, '')), 'and no long, net or 200 in it', row);
  const navB0 = (await navShown(b, B)).value;

  // A deposit into Iso A through its Deposit dialog moves Iso A's net asset value only.
  await switchBook(b, A);
  const dlg = await openCapital(b, { type: 'deposit', amount: 10_000 });
  await ui.button(dlg, 'Record deposit').click();
  await dlg.waitFor({ state: 'hidden' });
  await ui.toast(/Deposit recorded/);
  const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
  const navA1 = (await navShown(b, A)).value;
  c.near(num(navA1) - num(navA0), 10_000, `Iso A's net asset value went up by 10,000.00 (${navA0} -> ${navA1})`);
  await switchBook(b, B);
  c.eq((await navShown(b, B)).value, navB0, `Iso B's net asset value is unchanged (${navB0})`);
  // The Books page lists each Book with its own figure and adds nothing up.
  await show(b, '#/books');
  const rows = (await page.locator('main table tbody tr').allInnerTexts()).map(flat);
  c.eq(rows.length, (await b.get('/api/books')).items.length, 'the Books page has one row per Book (the demo\'s own Demo Book, Iso A, Iso B) and no total row');
  c.ok(rows.some((r) => r.includes('Iso A') && r.includes(navA1)) && rows.some((r) => r.includes('Iso B') && r.includes(navB0)), 'each with its own net asset value', rows.join(' || '));
  c.ok(!/total/i.test(flat(await page.locator('main table').innerText())), 'the table has no total');

  // A dividend recorded by hand on the instrument (shared reference data), and each swap marked at -5.
  await switchBook(b, A);
  const idrawer = await ui.openInstrument(inst);
  await ui.tab(idrawer, 'History and actions');
  const panel = ui.section(idrawer, 'Dividends and corporate actions');
  await ui.field(panel, 'Ex-date').locator('input').fill('2026-03-04');
  await ui.field(panel, 'Pay date').locator('input').fill('2026-03-06');
  await ui.input(panel, 'Amount per unit').fill('0.25');
  await ui.button(panel, 'Record').click();
  await ui.toast(/Dividend recorded/);
  await ui.closeOverlays();
  for (const X of [A, B]) await b.post('/api/observations', { kind: 'price', subject: X.swap.positions[0].instrument.id, value: -5, units: 'per 100 notional' });
  for (const t of ['2026-03-02T22:30:00.000Z', '2026-03-04T15:00:00.000Z', '2026-03-06T15:00:00.000Z', '2026-03-06T22:30:00.000Z']) await b.clock(t);
  await b.tick();

  // Each Book's history shows its own event for its own holding; nothing net.
  for (const [X, other, mine, theirs] of [[A, B, /^Dividend\b(?! compensation)/, /Dividend compensation/], [B, A, /Dividend compensation/, /^Dividend\b(?! compensation)/]]) {
    if (b.entered !== X) await switchBook(b, X);
    const evs = await historyRows(b, 'Dividend');
    const own = evs.filter((r) => mine.test(r.replace(/^.*?ET #\d+ \S+ /, '').replace(/^.*?(Dividend)/, '$1')));
    c.eq(own.length, 1, `${X.name}'s Full history has one ${X === A ? 'dividend' : 'compensation'} event`);
    c.match(own[0], X === A ? /\+50\.00 USD/ : /−25\.00 USD/, X === A ? 'Iso A received +50.00 (200 x 0.25)' : 'Iso B paid −25.00 (100 x 0.25)');
    c.match(own[0], X === A ? /Aardvark/ : /Bison/, `owned by ${X === A ? 'Aardvark' : 'Bison'}`);
    c.eq(evs.filter((r) => theirs.test(r.replace(/^.*?(Dividend)/, '$1'))), [], `${X.name}'s history has no event of the other Book's kind`);
    c.ok(!evs.some((r) => /25\.00 USD/.test(r) && X === A) && !evs.some((r) => /50\.00 USD/.test(r) && X === B), `${X.name}: nothing netted (no 25.00 net in Iso A, no 50.00 in Iso B)`, evs.join(' || '));
    // Collateral: one variation-margin movement of 5,000.00, under this Book's agreement only.
    await show(b, '#/treasury/collateral');
    const text = flat(await page.locator('main').innerText());
    c.match(text, /5,000\.00/, `${X.name}'s collateral screen shows the 5,000.00 variation margin`);
    c.eq(await foundOnPage(b, needlesOf(other)), [], `${X.name}'s history and collateral screens carry nothing of ${other.name}`);
  }
  // Behind the screens, as at API level.
  const div = (X) => b.sql(`SELECT e.type, e.unit_id, (SELECT SUM(amount) FROM entries x WHERE x.event_id = e.id AND x.account = 'cash') AS cash FROM events e WHERE e.book_id = ? AND e.type LIKE 'dividend%'`, X.id).map((r) => [r.type, r.unit_id, r.cash]);
  c.eq(div(A), [['dividend', A.accountId, 50]], 'stored: Iso A received 50.00 once');
  c.eq(div(B), [['dividend.compensation', B.accountId, -25]], 'stored: Iso B paid 25.00 once');
  for (const X of [A, B]) {
    c.eq(b.sql('SELECT kind, amount, agreement_id FROM collateral_movements WHERE book_id = ?', X.id).map((r) => [r.kind, r.amount, r.agreement_id]), [['variation', 5_000, X.agr.id]], `stored: ${X.name} posted 5,000.00 once, under its own agreement`);
    await b.clean(c, X.id, `${X.name} integrity`);
  }
}

/** The top bar as read by a user: demo band, connection chips, hedge-service chip, clock. */
async function topBar(page) {
  const bar = page.locator('.topbar');
  return {
    demoBand: await page.locator('.band', { hasText: 'Demo mode' }).count() > 0,
    clockButtons: await page.getByRole('button', { name: /^\+1 (hour|day|week)$/ }).count(),
    chips: (await bar.locator('a.conn').allInnerTexts()).map(flat),
    hedgeChip: await bar.locator('[data-testid=hedge-service-chip]').count() > 0,
    clock: flat(await bar.locator('.clock').innerText()),
  };
}
/** The clock as the Terminal formats it (web/lib/core.js fmtTime), for instants around now. */
const nyClock = (ms) => `${new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: 'short', day: '2-digit' })} ET`;
const isRealTime = (shown) => [-2, -1, 0, 1, 2].some((m) => nyClock(Date.now() + m * 60_000) === shown);
/** The first-Book form shown when a Terminal has no Book. */
async function createFirstBook(b, ui, page, name) {
  const panel = ui.section(page.locator('main'), 'Create your first Book');
  await panel.waitFor();
  await ui.input(panel, 'Book name').fill(name);
  await ui.button(panel, 'Create Book').click();
  await page.locator('.toasts .toast', { hasText: `Book "${name}" created` }).first().waitFor();
}

/** SB:isolation:normal-mode-refusals. The world is a Terminal in normal mode. */
export async function normalMode(b, c) {
  const { page, ui } = b;
  const demoCalls = watchRequests(page, 'POST', /^\/api\/demo\//);
  const demoReads = watchRequests(page, 'GET', /^\/api\/demo\//);
  await ui.goto('#/accounting');
  await settle(b);
  let top = await topBar(page);
  c.eq([top.demoBand, top.clockButtons, top.hedgeChip], [false, 0, false], 'normal mode: no demo band, no buttons to move the clock, no hedge fixture chip');
  c.eq(top.chips, ['MarketData: awaiting', 'Analytics Lab: awaiting'], 'both Shaffer ports read "awaiting"');
  c.ok(isRealTime(top.clock), 'the clock in the top bar is the real time in New York', `${top.clock} vs ${nyClock(Date.now())}`);
  c.eq(await page.locator('.topbar select').count(), 0, 'no Book exists, so there is no Book selector');
  await createFirstBook(b, ui, page, 'Normal mode');
  await settle(b);
  const books = (await b.get('/api/books')).items;
  c.eq(books.map((x) => x.name), ['Normal mode'], 'the first-Book form created "Normal mode", the only Book');
  const book = { id: books[0].id, name: 'Normal mode', treasuryId: books[0].units.find((u) => u.kind === 'treasury').id };
  c.near((await b.cash(book.id, book.treasuryId)).settled, 1_000_000, 'with 1,000,000.00 of starting capital in Treasury');
  b.entered = book;

  // An instrument with no data source: no price is invented anywhere it is shown.
  const inst = await b.instrument({ productId: 'common_stock', name: 'Plain Works Inc.', symbol: 'PLN', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
  let row = await marketRow(b, inst);
  const rowText = flat(await row.innerText());
  c.ok(!/\d+\.\d\d/.test(rowText.replace(/Plain Works Inc\./, '')), 'the Marketplace row of PLN shows no price', rowText);
  c.match(flat(await page.locator('main').innerText()), /Awaiting Shaffer data connection/, 'the Marketplace says it is awaiting the Shaffer data connection');

  // The Data connection page offers no demo control.
  await show(b, '#/data');
  const dataText = flat(await page.locator('main').innerText());
  c.eq(await ui.section(page.locator('main'), 'Demo mode').count(), 0, 'the Data connection page has no Demo mode panel');
  c.ok(!/Demo hedge fixture/.test(dataText), 'and no Demo hedge fixture section', dataText.slice(0, 200));
  c.match(dataText, /start it with npm run demo\. Demo mode keeps its own database/, 'it says the demo is a separate server with its own database');
  c.eq(await page.getByText('Answer complete hedge requests').count(), 0, 'there is no switch to answer hedge requests with a fixture');

  // A price entered by hand is shown, labelled manual.
  await show(b, '#/data/manual');
  const px = ui.section(page.locator('main'), 'Instrument price');
  await px.locator('input[type=search]').fill('PLN');
  await px.locator('.picklist button.pick', { hasText: 'PLN' }).first().click();
  await ui.input(px, 'Price').fill('12.5');
  await ui.button(px, 'Save price').click();
  await ui.toast(/Price saved/);
  row = await marketRow(b, inst);
  const priced = await row.evaluate((tr) => tr.innerHTML);
  c.match(flat(await row.innerText()), /12\.50/, 'the Marketplace row now shows the 12.50 entered by hand');
  c.match(priced, /manual/i, 'labelled as a manual input');
  const q = await b.get('/api/quotes', { ids: inst.id });
  c.eq(q.quotes[inst.id].observation?.status, 'manual', 'behind the screen the quote is the manual observation');

  // Nothing in the interface reached for a demo control; the routes themselves refuse.
  demoCalls.stop(); demoReads.stop();
  c.eq([...demoCalls.seen, ...demoReads.seen], [], 'the page sent no request to a demo route');
  const fp = b.fingerprint();
  c.refused(await b.req('POST', '/api/demo/advance', { ms: 86_400_000 }), { status: 403 }, 'moving the clock (behind the screen)');
  c.refused(await b.req('POST', `/api/demo/fixtures/quote`, { instrumentId: inst.id, bid: 1, ask: 2, last: 1.5 }), { status: 403 }, 'a quote fixture (behind the screen)');
  b.sameStored(c, fp, b.fingerprint(), 'the refused demo controls stored nothing');
  await ui.reloadAt('#/accounting');
  await settle(b);
  top = await topBar(page);
  c.ok(isRealTime(top.clock) && !top.demoBand, 'after all of it the clock is still the real time and there is still no demo band', top.clock);
  await b.clean(c, book.id);
}

/** SB:isolation:demo-normal-databases. The world is a Terminal in normal mode with the database chosen by mode. */
export async function demoNormalScreens(b, c) {
  const { page: pageN, ui: uiN } = b;
  const { createUi } = await import('../../matrix/drivers/browser.mjs');
  const d = await b.open({ demo: true, dbByMode: true, sandbox: b.sandbox, tag: 'demo-side' });
  const fileN = b.t.server.database, fileD = d.t.server.database;
  c.match(fileN, /[\\/]terminal\.db$/, 'the normal server reports terminal.db');
  c.match(fileD, /[\\/]demo\.db$/, 'the demo server reports demo.db, in the same data directory');
  const pageD = await b.context.newPage();
  pageD.setDefaultTimeout(15_000);
  pageD.on('pageerror', (e) => b.pageErrors.push(String(e.message || e)));
  const uiD = createUi(pageD, d.t.url);
  const dw = { page: pageD, ui: uiD, get: d.get };

  // Two tabs, one per Terminal.
  await uiN.goto('#/accounting');
  await settle(b);
  await uiD.goto('#/accounting');
  await settle(dw);
  const topN = await topBar(pageN), topD = await topBar(pageD);
  c.eq([topN.demoBand, topD.demoBand], [false, true], 'the normal tab has no demo band; the demo tab has one');
  c.ok(isRealTime(topN.clock), 'the normal tab\'s clock is the real time', topN.clock);
  c.eq(await pageN.getByText('Create your first Book').count(), 1, 'the normal Terminal starts with no Book: it asks for the first one');
  c.eq(await optionLabels(pageD.locator('.topbar select').first()), ['Demo Book'], 'the demo tab\'s Book selector lists its seeded Demo Book only');

  // A Book created in the normal tab is not in the demo, and the reverse.
  await createFirstBook(b, uiN, pageN, 'Paper');
  await settle(b);
  await uiD.reloadAt('#/books');
  await settle(dw);
  c.ok(!(await pageD.locator('main table tbody tr').allInnerTexts()).some((r) => r.includes('Paper')), 'the demo tab\'s Books page does not list "Paper"');
  const fpN = b.fingerprint();
  // In the demo tab: a new Book from the Book selector, and the demo clock moved a week with its button.
  await pageD.locator('.topbar select').first().selectOption({ value: '__new' });
  const nb = uiD.dialog('New Book');
  await uiD.input(nb, 'Book name').fill('Demo extra');
  await uiD.button(nb, 'Create Book').click();
  await pageD.locator('.toasts .toast', { hasText: 'Book "Demo extra" created' }).first().waitFor();
  await settle(dw);
  const clockD0 = flat(await pageD.locator('.topbar .clock').innerText());
  await pageD.getByRole('button', { name: '+1 week' }).click();
  await pageD.locator('.topbar .clock').filter({ hasNotText: clockD0 }).waitFor();
  await settle(dw);
  c.eq((await optionLabels(pageD.locator('.topbar select').first())).sort(), ['Demo Book', 'Demo extra'], 'the demo tab now lists Demo Book and Demo extra');
  b.sameStored(c, fpN, b.fingerprint(), 'a Book created and a week of demo clock in the demo tab: every row of terminal.db is as before');
  await uiN.reloadAt('#/books');
  await settle(b);
  const rowsN = (await pageN.locator('main table tbody tr').allInnerTexts()).map(flat);
  c.eq(rowsN.length, 1, 'the normal tab\'s Books page lists one Book');
  c.match(rowsN[0], /^Paper/, 'and it is Paper');
  c.ok(isRealTime((await topBar(pageN)).clock), 'the normal tab\'s clock is still the real time', (await topBar(pageN)).clock);

  // Activity in the normal tab leaves demo.db as it was.
  const fpD = d.fingerprint();
  const dep = await openCapital(b, { type: 'deposit', amount: 5_000 });
  await uiN.button(dep, 'Record deposit').click();
  await dep.waitFor({ state: 'hidden' });
  await uiN.toast(/Deposit recorded/);
  d.sameStored(c, fpD, d.fingerprint(), 'a deposit recorded in the normal tab: every row of demo.db is as before');

  // Both stopped and started again: each tab, reloaded, shows its own Books.
  await b.restart(); await d.restart();
  await uiN.reloadAt('#/books');
  await settle(b);
  await uiD.reloadAt('#/books');
  await settle(dw);
  c.eq((await pageN.locator('main table tbody tr').allInnerTexts()).map((r) => flat(r).split(' ')[0]), ['Paper'], 'after a restart the normal tab lists Paper only');
  c.eq((await optionLabels(pageD.locator('.topbar select').first())).sort(), ['Demo Book', 'Demo extra'], 'and the demo tab Demo Book and Demo extra');
  c.eq([b.t.server.database, d.t.server.database], [fileN, fileD], 'each server reopened its own file');
  await pageD.close();
  await b.clean(c, (await b.get('/api/books')).items[0].id);
}

// ---------------------------------------------------------------------------------------------
// History survives reference edits made in the interface
// ---------------------------------------------------------------------------------------------

/** The Full history of the selected Book as displayed (accruals hidden), one entry per event number. */
async function historyShown(b) {
  await show(b, '#/accounting/history/book');
  await b.page.locator('main table tbody tr[id^="ev-"]').first().waitFor();
  const rows = await b.page.locator('main table tbody tr[id^="ev-"]').evaluateAll((trs) => trs.map((tr) => [tr.id, tr.innerText.replace(/\s+/g, ' ').trim()]));
  return Object.fromEntries(rows);
}
/** Every event row shown before is shown again, word for word; returns the event numbers added. */
function sameHistoryShown(c, before, after, label) {
  const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
  c.eq(changed.map((k) => `${k}: ${before[k].slice(0, 80)} -> ${(after[k] || 'gone').slice(0, 80)}`), [], `${label}: every event row of the Full history reads exactly as before (${Object.keys(before).length} rows)`);
  return Object.keys(after).filter((k) => !(k in before));
}
/** The row of a pending settlement on the Pending trades tab: its due date and amount as displayed. */
async function pendingSettlementShown(b, accountId) {
  await show(b, `#/accounting/pending/${accountId}`);
  const panel = b.ui.section(b.page.locator('main'), 'Executed trades awaiting settlement');
  await panel.locator('tbody tr').first().waitFor();
  return (await panel.locator('tbody tr').allInnerTexts()).map(flat);
}
/** One assumption row of the Settings page, by its panel and label: its inputs. */
const assumption = (b, panel, label) => b.ui.section(b.page.locator('main'), panel).locator('tbody tr').filter({ has: b.page.locator('td:first-child > div:first-child', { hasText: exactly(label) }) }).first().locator('input');

/** SB:history:reference-edits. */
export async function historyEdits(b, c) {
  const { page, ui } = b;
  const { aWeek } = await import('../cases/history.mjs');
  const L = await aWeek(b);
  await b.clock('2026-03-06T19:00:00.000Z'); // Friday 14:00 New York
  const late = await b.buy(L.book, L.lfa, 100);
  c.eq(late.orders[0].fills[0].settleDate, '2026-03-09', 'setup: a purchase made on Friday settles on Monday 9 March');
  await enter(b, L.book, '#/accounting');
  await closeHedgePopup(b);
  const stored = b.history();
  const shown0 = await historyShown(b);
  c.note(`the Full history shows ${Object.keys(shown0).length} event rows before the edits`);
  c.ok(Object.keys(shown0).length >= 10, 'a week of history is on the Full history tab', `${Object.keys(shown0).length} rows`);
  const pend0 = await pendingSettlementShown(b, L.book.accountId);
  const latePending = pend0.find((r) => /2026-03-09/.test(r));
  c.ok(latePending && /5,003\.00/.test(latePending), 'setup: the Pending trades tab shows 5,003.00 (100 x 50.02 + 1.00) due 2026-03-09', pend0.join(' || '));
  try {
    // (a) The instrument: renamed, new symbol, venue, issuer and domicile, its own settlement calendar and lag.
    await show(b, '#/instruments');
    await page.getByPlaceholder(/Filter by symbol, name, issuer/).fill('LFA');
    await page.locator('main table tbody tr').filter({ has: page.locator('.sym', { hasText: exactly('LFA') }) }).first().getByRole('button', { name: 'Edit' }).click();
    let dlg = ui.dialog(/^Edit LFA$/);
    await dlg.waitFor();
    await ui.input(dlg, 'Name').fill('LFA Renamed Holdings plc');
    await ui.input(dlg, 'Symbol').fill('LFAR');
    await ui.input(dlg, 'Issuer').fill('LFA Renamed Holdings plc');
    await ui.input(dlg, 'Issuer domicile').fill('IE');
    await ui.input(dlg, 'Listing venue').fill('NASDAQ');
    const settleCal = ui.select(dlg, 'Settlement calendar');
    await settleCal.selectOption({ label: (await settleCal.locator('option').allInnerTexts()).find((x) => x.startsWith('USBOND:')) });
    await ui.input(dlg, 'Settlement convention').fill('2');
    let saved = await answerTo(b, 'PUT', /^\/api\/instruments\//, () => ui.button(dlg, 'Save changes').click());
    c.ok(saved.ok, '(a) the instrument edit is saved', saved.body?.error);
    await dlg.waitFor({ state: 'hidden' });
    // The traded call: its contract terms cannot be changed in the form.
    await show(b, '#/instruments');
    await page.getByPlaceholder(/Filter by symbol, name, issuer/).fill('LFA 260306C100');
    await page.locator('main table tbody tr').filter({ hasText: 'LFA 260306C100' }).first().getByRole('button', { name: 'Edit' }).click();
    dlg = ui.dialog(/^Edit LFA 260306C100$/);
    await dlg.waitFor();
    c.match(flat(await dlg.innerText()), /Contract terms are locked\. This instrument has been traded/, '(a) the traded option\'s form says its contract terms are locked');
    // The notice comes with the instrument record; the contract fields appear only once the product catalog has
    // loaded (a separate request), so wait for them before counting.
    const terms = dlg.locator('div', { has: page.locator(':scope > h4', { hasText: /^Contract terms \(locked\)$/ }) }).locator('fieldset');
    await terms.first().waitFor();
    c.eq(await dlg.locator('fieldset[disabled]').count(), 1, '(a) and its contract terms cannot be typed into');
    const termFields = terms.locator('input, select, textarea');
    const nFields = await termFields.count();
    let editable = 0;
    for (let i = 0; i < nFields; i++) if (await termFields.nth(i).isEditable()) editable++;
    c.ok(nFields > 0 && editable === 0, '(a) none of its contract fields accepts input', `${editable} of ${nFields} editable`);
    c.ok(await ui.input(dlg, 'Name').isEditable(), '(a) while its name can still be edited');
    await ui.button(dlg, 'Cancel').click();
    await dlg.waitFor({ state: 'hidden' });
    await b.tick();
    b.historyIntact(c, stored, '(a) after the instrument edit');
    let added = sameHistoryShown(c, shown0, await historyShown(b), '(a) after the instrument edit');
    c.eq(added, [], '(a) no event was added to the Full history');
    c.match(Object.values(shown0).join(' '), /\bLFA\b/, '(a) the history named LFA before the edit');
    c.eq((await pendingSettlementShown(b, L.book.accountId)).find((r) => /5,003\.00/.test(r))?.match(/2026-03-09/)?.[0], '2026-03-09', '(a) the pending 5,003.00 is still due 2026-03-09');

    // (b) The calendar: 3 March (settlements were made that day) and 9 March (the pending date) become holidays.
    await show(b, '#/settings');
    const cal = page.locator('main').locator('.panel', { hasText: 'Add an extra holiday' });
    const calSelect = cal.locator('select').first();
    await calSelect.locator('option', { hasText: /^US: / }).first().waitFor({ state: 'attached' });
    await calSelect.selectOption({ label: (await calSelect.locator('option').allInnerTexts()).find((x) => x.startsWith('US:')) });
    for (const day of ['2026-03-03', '2026-03-09']) {
      await cal.getByPlaceholder('YYYY-MM-DD').fill(day);
      await ui.button(cal, 'Add holiday').and(page.locator(':enabled')).waitFor();
      const r = await answerTo(b, 'PUT', /\/holidays$/, () => ui.button(cal, 'Add holiday').click());
      c.ok(r.ok, `(b) ${day} is entered as a US holiday`, r.body?.error);
      await ui.toast(/Holiday added to US/);
    }
    await b.tick();
    b.historyIntact(c, stored, '(b) after the calendar edit');
    added = sameHistoryShown(c, shown0, await historyShown(b), '(b) after the calendar edit');
    c.eq(added, [], '(b) no event was added to the Full history');
    const pend1 = await pendingSettlementShown(b, L.book.accountId);
    c.eq(pend1.find((r) => /5,003\.00/.test(r))?.match(/\d{4}-\d{2}-\d{2}/g)?.includes('2026-03-09'), true, '(b) the pending 5,003.00 keeps its date, 2026-03-09, now a holiday');

    // (c) The Book's assumptions, and the refresh timings.
    await show(b, '#/settings');
    await assumption(b, 'Fees and commissions', 'Equities').nth(0).fill('0.02');
    await assumption(b, 'Settlement lags', 'Equities').nth(0).fill('3');
    await assumption(b, 'Short selling', 'Cash collateral on borrowed securities').nth(0).fill('1.5');
    await assumption(b, 'Confirmation tolerances', 'Leg price').nth(0).fill('2');
    await assumption(b, 'Confirmation tolerances', 'Package totals').nth(0).fill('2');
    const put = await answerTo(b, 'PUT', /^\/api\/books\//, () => ui.button(page.locator('main'), 'Save assumptions').click());
    c.ok(put.ok, '(c) the Book\'s assumptions are saved', put.body?.error);
    await show(b, '#/data/refresh');
    await ui.input(page.locator('main'), 'Prices and quotes').fill('2');
    await ui.input(page.locator('main'), 'Screen polling').fill('6');
    const rf = await answerTo(b, 'PUT', /^\/api\/data\/refresh$/, () => ui.button(page.locator('main'), 'Save refresh settings').click());
    c.ok(rf.ok, '(c) the refresh timings are saved', rf.body?.error);
    await b.tick();
    b.historyIntact(c, stored, '(c) after the settings change', { newEvents: ['book.settings'] });
    added = sameHistoryShown(c, shown0, await historyShown(b), '(c) after the settings change');
    const after = await historyShown(b);
    c.eq(added.length, 1, '(c) one event was added to the Full history');
    c.match(after[added[0]] || '', /settings/i, '(c) and it is the settings change', after[added[0]]);
    c.eq(b.sql(`SELECT fees FROM fills WHERE order_id = ?`, late.orders[0].id)[0].fees.includes('"amount":1'), true, '(c) the Friday fill keeps its 1.00 commission');

    // What is new uses the new assumptions. The instrument's own lag is taken off again in its form, so the Book's T+3 applies.
    await show(b, '#/instruments');
    await page.getByPlaceholder(/Filter by symbol, name, issuer/).fill('LFAR');
    await page.locator('main table tbody tr').filter({ has: page.locator('.sym', { hasText: exactly('LFAR') }) }).first().getByRole('button', { name: 'Edit' }).click();
    dlg = ui.dialog(/^Edit LFAR$/);
    await dlg.waitFor();
    await ui.select(dlg, 'Settlement calendar').selectOption({ index: 0 });
    await ui.input(dlg, 'Settlement convention').fill('');
    saved = await answerTo(b, 'PUT', /^\/api\/instruments\//, () => ui.button(dlg, 'Save changes').click());
    c.ok(saved.ok, 'the instrument\'s own settlement calendar and lag are taken off', saved.body?.error);
    await dlg.waitFor({ state: 'hidden' });
    await show(b, '#/markets/US_CASH');
    const drawer = await fillTicket(b, { ...L.lfa, symbol: 'LFAR' }, { qty: 100 });
    const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
    const legs = flat(await modal.locator('table').first().innerText());
    // 100 x 0.02 = 2.00 (above the 1.00 minimum). T+3 on the US calendar from Friday 6 March, Monday 9 March being a
    // holiday now: Tuesday 10 (1), Wednesday 11 (2), Thursday 12 (3).
    c.match(legs, /fees 2\.00/, 'a purchase previewed after the changes shows the new commission: 100 x 0.02 = 2.00');
    c.match(legs, /2026-03-12/, 'and settlement on Thursday 12 March (T+3, 9 March a holiday)');
    c.eq([pv.legs[0].feeTotal, pv.legs[0].settleDate], [2, '2026-03-12'], 'the preview behind the dialog says the same');
    await confirm.click();
    await modal.waitFor({ state: 'hidden' });
    await closeHedgePopup(b);
    b.historyIntact(c, stored, 'after the new purchase', { anyNew: true });
    sameHistoryShown(c, shown0, await historyShown(b), 'after the new purchase');
  } finally {
    await b.req('PUT', '/api/calendars/US/holidays', { dates: [] });
  }
  await b.clean(c, L.book.id);
}

// ---------------------------------------------------------------------------------------------
// Catch-up after downtime, read on the screens
// ---------------------------------------------------------------------------------------------

/** The Full history's event-type filter: each type as the screen names it, with the count it shows. */
async function eventTypeCounts(b) {
  await show(b, '#/accounting/history/book');
  const select = b.page.locator('main select').filter({ has: b.page.locator('option', { hasText: 'All event types' }) }).first();
  await select.locator('option').nth(2).waitFor({ state: 'attached' });
  const labels = await select.locator('option').evaluateAll((os) => os.map((o) => o.textContent.trim()));
  return Object.fromEntries(labels.map((l) => /^(.*) \((\d+)\)$/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
}
/** Every row of the Full history with daily accruals included, without its time and event number. */
async function historyLines(b) {
  await show(b, '#/accounting/history/book');
  await b.page.locator('main').getByText('Include daily accruals').first().click();
  // Reloaded with the accruals once the panel no longer says they are hidden; only then can older pages be asked for.
  await b.ui.section(b.page.locator('main'), 'Audit trail').filter({ hasNotText: 'daily accruals hidden' }).waitFor();
  await settle(b);
  while (await b.page.getByRole('button', { name: 'Show older events' }).count()) { await b.page.getByRole('button', { name: 'Show older events' }).click(); await settle(b); }
  return b.page.locator('main table tbody tr[id^="ev-"]').evaluateAll((trs) => trs.map((tr) => [...tr.children].slice(1, 4).map((td) => td.innerText.replace(/\s+/g, ' ').trim()).join(' | ')));
}
/** The figures of the Account a user looks for after downtime, as displayed. */
async function lifeShown(b, L) {
  await show(b, `#/accounting/positions/${L.book.accountId}`);
  const cash = flat(await b.ui.section(b.page.locator('main'), 'Cash and financing balances').innerText());
  await show(b, `#/accounting/pnl/${L.book.accountId}`);
  await b.page.locator('main').getByText('Borrowing and funding expenses').first().waitFor();
  await settle(b);
  const pnl = flat(await b.page.locator('main').innerText());
  await show(b, `#/accounting/pending/${L.book.accountId}`);
  await b.page.locator('main').getByText('Executed trades awaiting settlement').first().waitFor();
  await b.ui.section(b.page.locator('main'), 'Lifecycle items').waitFor();
  const pending = flat(await b.page.locator('main').innerText());
  const lifecycle = (await b.ui.section(b.page.locator('main'), 'Lifecycle items').locator('tbody tr').allInnerTexts().catch(() => [])).map(flat);
  await show(b, `#/accounting/failed/${L.book.accountId}`);
  await b.ui.section(b.page.locator('main'), 'Failed settlements').waitFor();
  const failed = flat(await b.page.locator('main').innerText());
  return { cash, pnl, pending, lifecycle, failed };
}
/** Press one of the demo band's buttons that move the clock, and wait until the top bar shows the new date. */
async function pressClock(b, label, datePattern) {
  // A post-trade popup can open at any moment (a request made or answered by the last cycle): close it and press again.
  for (let i = 0; ; i++) {
    await closeHedgePopup(b);
    try { await b.page.getByRole('button', { name: label }).first().click({ timeout: 4_000 }); break; } catch (err) { if (i >= 4) throw err; }
  }
  await b.page.locator('.topbar .clock', { hasText: datePattern }).waitFor({ timeout: 60_000 });
  await settle(b);
}

/** SB:nodup:catch-up. */
export async function catchUpScreens(b, c) {
  const { page } = b;
  const { openLife, liveDayByDay, lifeDigest, checkLife, sameLife } = await import('./life.mjs');
  // The reference: the same fifteen days lived one day at a time in a Terminal of its own.
  const r = await b.open({ tag: 'life-reference', engine: 'off' });
  const RL = await openLife(r, 'Life');
  await liveDayByDay(r);
  const ref = await lifeDigest(r, RL);
  const refTypes = Object.fromEntries(r.sql(`SELECT type, COUNT(*) AS n FROM events WHERE book_id = ? AND type NOT LIKE 'accrual%' GROUP BY type`, RL.book.id).map((x) => [x.type, x.n]));

  // Monday: everything put on; the page open on it.
  const L = await openLife(b, 'Life');
  await enter(b, L.book, '#/accounting');
  await closeHedgePopup(b);
  // Downtime: the server stops; the page says so.
  await b.t.kill();
  await page.locator('.offline-bar').waitFor({ timeout: 30_000 });
  c.match(flat(await page.locator('.offline-bar').innerText()), /server is not reachable/, 'with the server stopped the page says it cannot reach it');
  // Meanwhile the user opens a screen whose code the page has not loaded yet: it says so, rather than "Loading…".
  await page.locator('.rail a', { hasText: 'Data connection' }).click();
  await page.locator('main .notice.err', { hasText: 'This screen could not be loaded' }).waitFor();
  c.match(flat(await page.locator('main .notice.err', { hasText: 'This screen could not be loaded' }).first().innerText()), /could not be loaded.*reloads by itself when the server is back/, 'a screen opened while the server is away says it could not be loaded and will reload when the server is back');
  await b.t.start();
  await page.locator('.offline-bar').waitFor({ state: 'hidden', timeout: 30_000 });
  await page.locator('main h1', { hasText: 'Data connection' }).waitFor({ timeout: 30_000 });
  c.ok(true, 'the server back, that screen loads by itself');
  b.takePageErrors();
  await show(b, '#/accounting');
  // Back, the user moves the demo clock on with the demo band: two weeks and a day, Tuesday 17 March.
  await pressClock(b, '+1 week', /Mar 09, 2026/);
  await pressClock(b, '+1 week', /Mar 16, 2026/);
  await pressClock(b, '+1 day', /Mar 17, 2026/);
  await closeHedgePopup(b);

  // What the screens show: each kind of event as often as the day-by-day run booked it.
  const types = await eventTypeCounts(b);
  c.note(`event types on the Full history filter: ${Object.entries(types).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const sentence = (t) => t.replace(/[._]/g, ' ').replace(/^\w/, (x) => x.toUpperCase());
  const want = Object.fromEntries(Object.entries(refTypes).map(([t, n]) => [sentence(t), n]));
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, types[k] ?? 0]));
  c.eq(got, want, 'every kind of event (accruals aside) shows the count the day-by-day run booked');
  for (const [k, n] of [['Dividend', 1], ['Option expired', 1], ['Loan repayment', 1], ['Collateral variation', 1]]) c.eq(types[k], n, `the Full history lists "${k}" ${n === 1 ? 'once' : `${n} times`}`);
  c.eq(Object.keys(types).filter((k) => !(k in want) && !/^Accrual/.test(k) && !/^All /.test(k)), [], 'and no kind of event the day-by-day run did not have');
  // No line of the history, daily accruals included, appears twice.
  const lines = await historyLines(b);
  const twice = lines.filter((x, i) => lines.indexOf(x) !== i);
  c.eq(twice, [], `no row of the Full history (${lines.length} rows with accruals) appears twice`);
  // The figures a user checks after downtime.
  const s1 = await lifeShown(b, L);
  c.match(s1.cash, /944,301\.76/, 'Cash and financing balances: settled cash 944,301.76');
  c.match(s1.cash, /15,300\.00/, 'restricted 15,300.00 (short collateral)');
  c.match(s1.cash, /5,000\.00/, 'margin 5,000.00');
  for (const [fig, what] of [['250.00', 'dividend income 250.00'], ['420.00', 'option premium lost 420.00'], ['200.27', 'borrowing and funding expenses 200.27 (loan interest 194.44 + borrow fee 5.83)']]) c.match(s1.pnl, new RegExp(fig.replace('.', '\\.')), `P&L: ${what}`);
  c.eq(lines.filter((x) => /194\.44/.test(x)).length, 1, 'the Full history shows the loan interest of 194.44 on one row');
  c.match(s1.pending, /Executed trades awaiting settlement[^]*?(Nothing|No )/i, 'Pending trades: nothing is left awaiting settlement');
  c.eq(s1.lifecycle.filter((x, i) => s1.lifecycle.indexOf(x) !== i), [], 'each lifecycle item is listed once');
  c.match(s1.failed, /No settlement has failed/, 'Failed: no settlement has failed');

  // Downtime again, a reload, and more time: the screens are the same.
  await b.t.kill();
  await page.locator('.offline-bar').waitFor({ timeout: 30_000 });
  await b.t.start();
  await page.locator('.offline-bar').waitFor({ state: 'hidden', timeout: 30_000 });
  b.takePageErrors();
  await b.ui.reloadAt('#/accounting');
  await settle(b);
  await pressClock(b, '+1 hour', /Mar 17, 2026, 12:00/);
  await b.tick();
  c.eq(await eventTypeCounts(b), types, 'after a second stop, a reload, another hour and a cycle: the same event counts');
  const s2 = await lifeShown(b, L);
  c.eq(s2, s1, 'and the same cash, P&L, pending, lifecycle and failed screens');

  // Behind the screens: the hand-worked figures and the day-by-day books.
  await checkLife(b, c, L, 'catch-up from the screens');
  sameLife(c, ref, await lifeDigest(b, L), 'catch-up from the screens');
}

// ---------------------------------------------------------------------------------------------
// A Shaffer service address that stops answering, as the Data connection page and the screens show it
// ---------------------------------------------------------------------------------------------

/** Press Test connection on the MarketData panel; returns the verdict shown, the last error shown and how long it took. */
async function testMarketData(b) {
  const panel = b.ui.section(b.page.locator('main'), 'Shaffer MarketData');
  const t0 = Date.now();
  const r = await answerTo(b, 'POST', /^\/api\/data\/test$/, () => b.ui.button(panel, 'Test connection').click());
  const verdict = panel.locator('.notice').filter({ hasText: /Test passed|answered|could not be reached|Nothing to test/ }).first();
  await verdict.waitFor();
  await settle(b);
  return { ms: Date.now() - t0, verdict: flat(await verdict.innerText()), panel: flat(await panel.innerText()), result: r.body?.result };
}
/** The PLN row of the US Based Marketplace as displayed, and what the page says about the data source. */
async function plnRow(b) {
  const row = await marketRow(b, { symbol: 'AWAY', productId: 'common_stock', marketView: 'US_CASH' });
  return { text: flat(await row.innerText()), html: await row.evaluate((tr) => tr.innerHTML), page: flat(await b.page.locator('main').innerText()) };
}

/** SB:stress:service-stops-answering. The world is a Terminal in normal mode. */
export async function serviceAway(b, c) {
  const { page, ui } = b;
  const { createServer } = await import('node:http');
  const { createServer: createTcp } = await import('node:net');
  const book = await b.book('Service stops answering', { settings: null });
  const inst = await b.instrument({ productId: 'common_stock', name: 'Away Works Inc.', symbol: 'AWAY', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {}, conventions: { tradingCalendar: 'ALLDAYS' } });
  const s = await b.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 100, statedPrice: 50 }] });
  c.eq(s.orders[0].status, 'filled', 'setup: 100 shares bought at the stated price of 50.00');
  await enter(b, book, '#/data/manual');
  // The mark is entered by hand on the Data connection page.
  const px = ui.section(page.locator('main'), 'Instrument price');
  await px.locator('input[type=search]').fill('AWAY');
  await px.locator('.picklist button.pick', { hasText: 'AWAY' }).first().click();
  await ui.input(px, 'Price').fill('51');
  await ui.button(px, 'Save price').click();
  await ui.toast(/Price saved/);
  let nav = await navShown(b, book);
  c.eq([nav.value, nav.provisional], ['1,000,100.00', false], 'the Accounting header shows 1,000,100.00 (1,000,000.00 + 100 x (51.00 - 50.00)) on the manual mark');

  // A MarketData address that answers, typed into the Data connection page with a 1.5 second timeout.
  const listen = (srv, port = 0) => new Promise((res) => srv.listen(port, '127.0.0.1', () => res(srv.address().port)));
  const close = (srv) => new Promise((res) => { srv.closeAllConnections?.(); srv.close(() => res()); });
  let stub = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"service":"stub"}'); });
  const port = await listen(stub);
  b.defer(() => close(stub).catch(() => {}));
  await show(b, '#/data');
  const addresses = ui.section(page.locator('main'), 'Service addresses');
  await ui.input(addresses, 'Shaffer MarketData address').fill(`http://127.0.0.1:${port}`);
  await ui.input(addresses, 'Request timeout').fill('1.5');
  const saved = await answerTo(b, 'PUT', /^\/api\/data\/connection$/, () => ui.button(addresses, 'Save service addresses').click());
  c.ok(saved.ok, 'the address and the 1.5 second timeout are saved from the page', saved.body?.error);
  await ui.toast(/Service addresses saved/);
  let t = await testMarketData(b);
  c.match(t.verdict, /The address answered, but the connection is not verified/, 'Test connection: the address answers (reachable, not verified: no service contract exists yet)');
  let row = await plnRow(b);
  c.match(row.text, /51\.00/, 'the Marketplace row shows the manual 51.00');
  c.match(row.html, /manual/i, 'labelled manual');
  c.match(row.page, /Awaiting Shaffer data connection/, 'and the page still says it is awaiting the Shaffer data connection');
  const fp = b.fingerprint();
  const before = await b.books(book.id);

  // 1. Connection refused.
  await close(stub);
  await show(b, '#/data');
  t = await testMarketData(b);
  c.match(t.verdict, /The address could not be reached\..*Could not reach the configured address/, 'connection refused: the page says the address could not be reached, with the reason');
  c.ok(t.ms < 4_000, 'and says so at once', `${t.ms} ms`);
  c.match(t.panel, /Last error/, 'the panel shows its last error');
  row = await plnRow(b);
  c.ok(/51\.00/.test(row.text) && /manual/i.test(row.html) && /Awaiting Shaffer data connection/.test(row.page), 'the Marketplace still shows the manual 51.00 and the waiting state', row.text);
  const tick1 = await b.tick();
  c.ok(tick1 && !tick1.error, 'an engine cycle completes', JSON.stringify(tick1));
  nav = await navShown(b, book);
  c.eq([nav.value, nav.provisional], ['1,000,100.00', false], 'the Accounting header still shows 1,000,100.00');
  b.sameStored(c, fp, b.fingerprint(), 'connection refused: every stored row is as before');

  // 2. The connection is accepted and never answered.
  const held = new Set();
  const hang = createTcp((socket) => { held.add(socket); socket.on('close', () => held.delete(socket)); socket.on('error', () => {}); });
  await new Promise((res) => hang.listen(port, '127.0.0.1', res));
  const stopHanging = () => new Promise((res) => { for (const sk of held) sk.destroy(); hang.close(() => res()); });
  b.defer(() => stopHanging().catch(() => {}));
  await show(b, '#/data');
  const panel = ui.section(page.locator('main'), 'Shaffer MarketData');
  // The button itself, held before the click: while busy it reads "Working…" and its name no longer matches.
  const button = await ui.button(panel, 'Test connection').elementHandle();
  const t0 = Date.now();
  const testing = answerTo(b, 'POST', /^\/api\/data\/test$/, () => button.click());
  await sleep(400);
  c.eq(await button.evaluate((x) => [x.disabled, x.textContent.trim()]), [true, 'Working…'], 'no answer: while it waits the Test connection button reads "Working…" and cannot be pressed again');
  const answered = await testing;
  c.ok(answered.body?.result?.reachable === false && /aborted due to timeout/.test(answered.body?.result?.detail), 'no answer: behind the page the test reports the address unreachable after its timeout', JSON.stringify(answered.body).slice(0, 400));
  const verdict = panel.locator('.notice').filter({ hasText: /could not be reached.*aborted due to timeout/ }).first();
  await verdict.waitFor(); // this test's own verdict: step 1's said the connection was refused ("fetch failed")
  const waited = Date.now() - t0;
  c.ok(waited >= 1_000 && waited < 4_000, 'the page gives the verdict after the 1.5 second timeout, not later', `${waited} ms`);
  c.match(flat(await verdict.innerText()), /The address could not be reached/, 'and says the address could not be reached');
  const t1 = Date.now();
  const tick2 = await b.tick();
  c.ok(tick2 && !tick2.error && Date.now() - t1 < 3_000, 'an engine cycle completes without waiting for the service', `${Date.now() - t1} ms`);
  await show(b, `#/accounting/positions/${book.accountId}`);
  await ui.section(page.locator('main'), 'Positions').locator('tbody tr').filter({ hasText: 'AWAY' }).first().waitFor();
  c.ok(true, 'the Accounting positions screen still loads, with the AWAY holding');
  b.sameStored(c, fp, b.fingerprint(), 'no answer: every stored row is as before');
  await stopHanging();

  // 3. Answering again; then a restart.
  stub = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"service":"stub"}'); });
  await listen(stub, port);
  await show(b, '#/data');
  t = await testMarketData(b);
  c.match(t.verdict, /The address answered/, 'the address answers again: the page says so');
  await b.restart();
  await ui.reloadAt('#/accounting');
  await settle(b);
  b.sameStored(c, fp, b.fingerprint(), 'after reconnection and a restart: every stored row is as before');
  b.sameBooks(c, before, await b.books(book.id), 'after reconnection and a restart');
  nav = await navShown(b, book);
  c.eq([nav.value, nav.provisional], ['1,000,100.00', false], 'the Accounting header shows 1,000,100.00, unchanged');
  b.takePageErrors();
  await b.clean(c, book.id);
}

// ---------------------------------------------------------------------------------------------
// Hedge reconnection: the queue and the popup while the service is away, and when it is back
// ---------------------------------------------------------------------------------------------

/** The hedge review queue on the Strategies page: each request row by id, with its state and text. */
async function hedgeQueue(b) {
  await show(b, '#/strategy');
  await closeHedgePopup(b);
  const panel = b.page.locator('[data-testid=hedge-queue]');
  if (!(await panel.count())) return {};
  const rows = await panel.locator('tbody tr[data-request]').evaluateAll((trs) => trs.map((tr) => [tr.dataset.request, { state: tr.dataset.state, text: tr.innerText.replace(/\s+/g, ' ').trim() }]));
  return Object.fromEntries(rows);
}
/** The queue row's Review / Open / Complete button, pressed: the hedge popup of that request. */
async function openFromQueue(b, requestId) {
  await hedgeQueue(b);
  await b.page.locator(`[data-testid=hedge-queue] tr[data-request="${requestId}"]`).getByRole('button').first().click();
  const popup = b.page.locator('[data-testid=hedge-popup]');
  await popup.waitFor();
  await settle(b);
  return popup;
}
/** Manage panel of a strategy instance's drawer: fill one field, press its preview button, confirm. */
async function manageStrategy(b, book, strategyId, field, value, button) {
  const drawer = await openStrategyDrawer(b, book, strategyId);
  await b.ui.input(drawer, field).fill(String(value));
  await b.ui.button(drawer, button).click();
  const modal = b.ui.dialog(/^Preview: /);
  await modal.waitFor();
  await modal.getByRole('button', { name: /^Confirm/ }).click();
  await modal.waitFor({ state: 'hidden' });
  await b.ui.closeOverlays();
}

/** SB:hedge:reconnection. The world runs with the engine timer on. */
export async function hedgeReconnection(b, c) {
  const { page, ui } = b;
  const { scriptedPut } = await import('../cases/hedge.mjs');
  const CTX = { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };
  const QUOTE_DEEP = { bid: 50.00, ask: 50.02, last: 50.00, bidSize: 50_000, askSize: 50_000 };
  await b.post('/api/demo/hedge-script', { clear: true });
  const book = await b.book('Hedge reconnection', { capital: 2_000_000, funding: 1_000_000 });
  const inst = {};
  for (const sym of ['HGR', 'HSH', 'HCL', 'HUN', 'HIN']) inst[sym] = await b.stock(sym, QUOTE_DEEP);

  // The user switches the demo hedge fixture off on the Data connection page: nothing answers hedge requests.
  await enter(b, book, '#/data');
  const sw = page.locator('main').getByText('Answer complete hedge requests with the canned demo packages');
  if (await sw.locator('xpath=..').locator('input[type=checkbox]').isChecked()) {
    await sw.click();
    await ui.toast(/Demo hedge fixture turned off/);
  }
  await settle(b);
  c.match(flat(await page.locator('[data-testid=hedge-service-note]').innerText()), /answered now by: nothing \(awaiting connection\)/, 'the Data connection page says hedge requests are answered by nothing now (awaiting connection)');
  c.eq(await page.locator('.topbar [data-testid=hedge-service-chip]').count(), 0, 'and the top bar shows no hedge service answering');
  c.eq((await b.get('/api/hedge/service')).reachable, false, 'behind the screen, nothing answers hedge requests');

  // 300 HGR bought from its Marketplace ticket with the context a hedge request needs.
  const ticket = await fillTicket(b, inst.HGR, { qty: 300 });
  await ticket.getByRole('button', { name: 'Show funding and hedge context' }).click();
  const strat = ui.field(ticket, 'Investment Strategy');
  await strat.locator('select, input:enabled').first().waitFor(); // the Strategy list is asked for first
  if (await strat.locator('select').count()) await strat.locator('select').selectOption({ index: 1 });
  else await strat.locator('input').fill('Core Equity');
  await ui.input(ticket, 'Intended holding period').fill('60');
  await ui.select(ticket, 'Hedge objective').selectOption({ label: 'Downside protection' });
  const bought = await openPreviewFrom(b, ticket);
  await bought.confirm.click();
  await bought.modal.waitFor({ state: 'hidden' });
  await b.tick();
  const popup = page.locator('[data-testid=hedge-popup]');
  await popup.waitFor({ timeout: 20_000 });
  c.eq(await popup.getAttribute('aria-label'), 'Hedge for long HGR', 'after the fill the hedge popup opens for the long HGR');
  c.eq(await popup.getAttribute('data-state'), 'awaiting_connection', 'it says the request awaits the connection');
  c.match(flat(await popup.innerText()), /It is sent when Shaffer Hedge can be reached, against the exposure as it is then/, 'and that it is sent, against the exposure as it is then, when the service can be reached');
  c.eq(await popup.getByRole('button', { name: /Execute/ }).count(), 0, 'there is nothing to execute');
  await closeHedgePopup(b);
  const grew = (await b.get('/api/strategies', { bookId: book.id })).items.find((x) => x.underlying?.id === inst.HGR.id || /HGR/.test(x.name));
  const s = { grew: { id: grew.id } };
  s.shrank = await b.trade({ ...b.ticketInput(book, inst.HSH, 'buy', 400), ...CTX });
  s.closed = await b.trade({ ...b.ticketInput(book, inst.HCL, 'buy', 200), ...CTX });
  s.untouched = await b.trade({ ...b.ticketInput(book, inst.HUN, 'buy', 100), ...CTX });
  s.incomplete = await b.trade(b.ticketInput(book, inst.HIN, 'buy', 100));
  await b.tick();
  await closeHedgePopup(b);
  const reqOf = async (k) => (await b.get('/api/hedge/requests', { bookId: book.id })).items.find((r) => r.strategyId === s[k].id);
  const ids = {};
  for (const k of Object.keys(s)) ids[k] = (await reqOf(k)).id;

  let q = await hedgeQueue(b);
  c.eq(Object.keys(q).sort(), Object.values(ids).sort(), 'the hedge review queue lists five requests, one per position');
  c.eq(Object.keys(s).map((k) => q[ids[k]]?.state), ['awaiting_connection', 'awaiting_connection', 'awaiting_connection', 'awaiting_connection', 'incomplete'], 'four await the connection, the one without context is incomplete');
  c.match(q[ids.incomplete]?.text, /Needs .*Not sent/, 'the incomplete row says what it needs and that it was not sent');
  c.match(q[ids.grew]?.text, /cannot be reached: awaiting connection/, 'the waiting rows say Shaffer Hedge cannot be reached');

  // While the service is away the positions change, from each strategy instance's drawer.
  await manageStrategy(b, book, s.grew.id, 'Resize, multiple of the current size', 2, 'Preview resize');
  await manageStrategy(b, book, s.shrank.id, 'Close, share of every position', 75, 'Preview close');
  await manageStrategy(b, book, s.closed.id, 'Close, share of every position', 100, 'Preview close');
  await b.tick(); await b.tick();
  const held = async (k) => (await b.strategy(s[k].id)).positions.filter((p) => p.family === 'equity').reduce((a, p) => a + p.qty, 0);
  c.eq([await held('grew'), await held('shrank'), await held('closed')], [600, 100, 0], 'HGR doubled to 600, 300 of HSH sold (100 left), HCL closed');
  q = await hedgeQueue(b);
  c.eq(Object.keys(q).sort(), [ids.grew, ids.shrank, ids.untouched, ids.incomplete].sort(), 'while waiting the queue lists the four open requests: HCL\'s left it when its position was closed');
  c.eq((await b.get('/api/hedge/requests', { bookId: book.id })).items.map((r) => r.id).sort(), Object.values(ids).sort(), 'behind the screen there are still exactly the same five requests');
  c.eq([(await reqOf('closed')).state, (await reqOf('closed')).response ?? null], ['closed', null], 'HCL\'s is closed, and was never sent');
  c.eq((await b.get('/api/demo/hedge-script')).used ?? 0, 0, 'nothing was sent meanwhile');
  const beforeBooks = await b.books(book.id);
  const ordersOf = () => Object.fromEntries(Object.entries(s).map(([k, x]) => [k, b.sql('SELECT COUNT(*) AS n FROM orders WHERE strategy_id = ?', x.id)[0].n]));
  const orders0 = ordersOf();

  // The service comes back (a scripted stand-in for Shaffer Hedge, labelled a test fixture).
  await b.post('/api/demo/hedge-script', { responses: [{ packages: [scriptedPut(inst.HGR)] }], repeat: true });
  await b.tick(); await b.tick();
  q = await hedgeQueue(b);
  c.eq([q[ids.grew]?.state, q[ids.shrank]?.state, q[ids.untouched]?.state], ['recommendation_ready', 'recommendation_ready', 'recommendation_ready'], 'reconnected: HGR, HSH and HUN show a recommendation ready');
  c.match(q[ids.grew]?.text, /Long 600 HGR/, 'HGR\'s row is for the current 600');
  c.match(q[ids.shrank]?.text, /Long 100 HSH/, 'HSH\'s row is for the current 100');
  c.match(q[ids.grew]?.text, /test fixture, not Shaffer Hedge.*current/, 'labelled as a test fixture, not Shaffer Hedge, and current');
  c.eq(q[ids.closed], undefined, 'HCL\'s request has left the queue');
  c.eq(q[ids.incomplete]?.state, 'incomplete', 'HIN\'s is still incomplete');
  const cl = await reqOf('closed');
  c.eq([cl.state, cl.response ?? null], ['closed', null], 'behind the screen HCL\'s request is closed and was never answered');
  c.match(cl.message, /position this request was for was closed/, 'with the reason');
  c.eq((await b.get('/api/demo/hedge-script')).used, 3, 'exactly three requests reached the service');
  c.eq(b.sql('SELECT strategy_id, COUNT(*) AS n FROM hedge_requests WHERE book_id = ? GROUP BY strategy_id HAVING COUNT(*) > 1', book.id), [], 'no position has two requests');
  // The popup shows the current exposure, and receiving the recommendation executed nothing.
  let pop = await openFromQueue(b, ids.grew);
  c.eq(await pop.getAttribute('data-state'), 'recommendation_ready', 'HGR\'s popup, opened from the queue: recommendation ready');
  const sent = flat(await ui.section(pop, 'What was sent').innerText());
  c.match(sent, /Long 600/, 'what was sent is the current exposure: long 600');
  c.match(flat(await ui.section(pop, 'Packages').innerText()), /Scripted protective put.*test fixture/, 'the package is listed, labelled test fixture');
  await ui.closeOverlays();
  const afterBooks = await b.books(book.id);
  b.sameBooks(c, beforeBooks, afterBooks, 'the reconnection');
  c.eq([afterBooks.counts.orders, afterBooks.counts.fills, afterBooks.counts.entries, afterBooks.counts.positions], [beforeBooks.counts.orders, beforeBooks.counts.fills, beforeBooks.counts.entries, beforeBooks.counts.positions], 'no order, fill, ledger entry or position was added by receiving it');
  c.eq(ordersOf(), orders0, 'each strategy instance has the orders it had');
  await show(b, `#/accounting/positions/${book.accountId}`);
  c.eq(await ui.section(page.locator('main'), 'Positions').locator('tbody tr').filter({ hasText: /\bP\b|Put/ }).count(), 0, 'the Accounting positions screen shows no put');

  // Again: a refresh, timer cycles, the service away and back: nothing more.
  await b.post('/api/hedge/refresh');
  await b.tick(); await b.tick();
  await b.post('/api/demo/hedge-script', { clear: true });
  await b.tick();
  pop = await openFromQueue(b, ids.grew);
  c.match(flat(await pop.locator('[data-testid=hedge-status]').innerText()), /recommendation ready.*Shaffer Hedge cannot be reached/, 'service away again: the popup keeps the recommendation and says the service cannot be reached now');
  await ui.closeOverlays();
  await b.post('/api/demo/hedge-script', { responses: [{ packages: [scriptedPut(inst.HGR)] }], repeat: true });
  await b.tick(); await sleep(2_500); // the engine timer cycles by itself meanwhile
  q = await hedgeQueue(b);
  c.eq(Object.keys(q).sort(), [ids.grew, ids.shrank, ids.untouched, ids.incomplete].sort(), 'after a refresh, cycles and the service away and back: the same four open requests');
  const b2 = await b.books(book.id);
  c.eq([b2.counts.orders, b2.counts.fills, b2.counts.entries], [beforeBooks.counts.orders, beforeBooks.counts.fills, beforeBooks.counts.entries], 'and still nothing executed');

  // HGR is reduced after its recommendation arrived: stale, refreshed in place, then executed only by the user.
  await manageStrategy(b, book, s.grew.id, 'Close, share of every position', 50, 'Preview close');
  await b.tick(); await b.tick();
  pop = await openFromQueue(b, ids.grew);
  c.match(flat(await pop.innerText()), /This recommendation is stale\./, 'HGR reduced to 300: the popup says the recommendation is stale');
  c.eq(await pop.getByRole('button', { name: /^Execute/ }).isDisabled(), true, 'Execute now cannot be pressed on a stale recommendation');
  await pop.getByRole('button', { name: 'Refresh against current exposure' }).first().click();
  await pop.locator('.hedge-status', { hasText: 'current' }).first().waitFor({ timeout: 20_000 }).catch(() => {});
  await settle(b);
  c.match(flat(await ui.section(pop, 'What was sent').innerText()), /Long 300/, 'refreshed: the request is now for the 300 held');
  c.eq((await reqOf('grew')).id, ids.grew, 'refreshed in place: the same request');
  // The option leg has no quote: the desk states its fill price on the leg, then executes (double-clicked).
  const legPrice = pop.locator('[data-testid=leg-price]').first();
  await legPrice.getByPlaceholder('Fill price').fill('1.10');
  await legPrice.getByRole('button', { name: 'Use this fill price' }).click();
  await settle(b);
  const ack = pop.getByText(/^I have read the/);
  if (await ack.count()) await ack.click();
  const execute = pop.getByRole('button', { name: 'Execute now' });
  await execute.and(page.locator(':enabled')).waitFor();
  c.eq(b.sql(`SELECT COUNT(*) AS n FROM orders WHERE book_id = ? AND json_extract(data, '$.hedgeLinkId') IS NOT NULL`, book.id)[0].n, 0, 'until Execute now is pressed there is no hedge order');
  const posts = watchRequests(page, 'POST', /^\/api\/strategies$/);
  await execute.dblclick();
  await popup.waitFor({ state: 'hidden', timeout: 20_000 });
  posts.stop();
  await b.tick();
  const hedgeOrders = b.sql(`SELECT json_extract(data, '$.hedgeLinkId') AS link FROM orders WHERE book_id = ? AND json_extract(data, '$.hedgeLinkId') IS NOT NULL`, book.id);
  c.eq(hedgeOrders.map((o) => o.link), [ids.grew], 'Execute now, double-clicked, created one hedge order, carrying the request id');
  c.note(`Execute now double-clicked: ${posts.seen.length} request${posts.seen.length === 1 ? '' : 's'} left the page`);
  c.ok(['executing', 'executed'].includes((await reqOf('grew')).state), 'the request is now executing or executed', (await reqOf('grew')).state);
  await closeHedgePopup(b);
  b.takePageErrors();
  await b.clean(c, book.id);
}

// ---------------------------------------------------------------------------------------------
// Persistence across restarts, and an interrupted confirmation, as the user sees them
// ---------------------------------------------------------------------------------------------

/** The rows of the named panels of a page of the selected Book, as displayed (a panel that is not shown: null). */
async function panelRows(b, hash, titles) {
  await show(b, hash);
  await closeHedgePopup(b);
  const out = {};
  for (const t of titles) {
    const panel = b.ui.section(b.page.locator('main'), t);
    out[t] = (await panel.count()) ? (await panel.locator('tbody tr').allInnerTexts()).map(flat) : null;
  }
  return out;
}

/** SB:stress:restart-stages. */
export async function restartScreens(b, c) {
  const { page } = b;
  const book = await b.book('Browser restart stages');
  const inst = await b.stock('BRS', QUOTE);
  await enter(b, book, '#/markets/US_CASH');
  const drawer = await fillTicket(b, inst, { qty: 1_000, order: { orderType: 'limit', limitPrice: 49, tif: 'gtc' } });
  const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
  c.eq(pv.blocking, 0, 'the limit buy of 1,000 at 49.00 previews without a block');
  await confirm.click();
  await modal.waitFor({ state: 'hidden' });
  const order = () => b.sql('SELECT status, filled_qty FROM orders WHERE book_id = ?', book.id).map((r) => ({ ...r }));
  const screens = async () => ({
    pending: await panelRows(b, `#/accounting/pending/${book.accountId}`, ['Open orders', 'Partly filled', 'Executed trades awaiting settlement']),
    cash: flat(await (async () => { await show(b, `#/accounting/positions/${book.accountId}`); return b.ui.section(page.locator('main'), 'Cash and financing balances').innerText(); })()),
    holding: (await holdingRow(b, 'BRS').catch(() => '')) || '',
    history: await historyShown(b),
  });
  /** Stop and start the server, reload the page: every screen reads as before, nothing stored changed, nothing added. */
  const restartHere = async (stage) => {
    // Read first (closing the post-trade hedge popup marks its prompt seen, a user action), then fingerprint: what is
    // compared is the restart alone.
    const before = await screens();
    const fp = b.fingerprint();
    await b.restart();
    await page.reload();
    await page.locator('.shell .topbar').waitFor();
    const after = await screens();
    c.eq(after.pending, before.pending, `restart at "${stage}": the Pending tab lists the same orders and trades, each once`);
    c.eq(after.cash, before.cash, `restart at "${stage}": the cash balances read as before`);
    c.eq(after.holding, before.holding, `restart at "${stage}": the holding reads as before`);
    c.eq(sameHistoryShown(c, before.history, after.history, `restart at "${stage}"`), [], `restart at "${stage}": no row was added to the Full history`);
    b.sameStored(c, fp, b.fingerprint(), `restart at "${stage}": every stored row is as it was`);
    await b.clean(c, book.id, `restart at "${stage}"`);
    return after;
  };

  // Stage 1: working (ask 50.02, limit 49.00).
  let s = await restartHere('working');
  c.match((s.pending['Open orders'] || []).join(' | '), /Buy 1,000 BRS.*Limit at 49\.00, until cancelled working/, 'stage 1: the Pending tab lists the order under Open orders: buy 1,000 BRS, limit 49.00, until cancelled, working');
  await b.tick();
  c.eq(order(), [{ status: 'working', filled_qty: 0 }], 'after the restart and a cycle it is still working, unfilled');

  // Stage 2: partly filled (the ask falls to 49.00 with 300 displayed).
  await b.fixture('quote', { instrumentId: inst.id, bid: 48.98, ask: 49.00, last: 49.00, bidSize: 300, askSize: 300 });
  await b.tick();
  s = await restartHere('partly filled');
  c.match((s.pending['Partly filled'] || []).join(' | '), /300 of 1,000.*700/, 'stage 2: the Pending tab lists it as partly filled: 300 of 1,000, 700 remaining');
  await b.tick(); await b.tick(); await b.tick();
  c.eq(b.sql('SELECT f.qty FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ? ORDER BY f.rowid', book.id).map((f) => f.qty), [300, 300, 300, 100], 'after the restart the remainder fills: 300, 300, 100');

  // Stage 3: filled, unsettled. 1,000 x 49.00 = 49,000.00 plus commission 1,000 x 0.005 = 5.00.
  s = await restartHere('filled, unsettled');
  c.eq((s.pending['Executed trades awaiting settlement'] || []).length, 4, 'stage 3: four fills await settlement on the Pending tab, each once');
  c.match(s.cash, /49,005\.00/, 'stage 3: the cash balances show 49,005.00 payable');

  // Stage 4: Tuesday, settled: 500,000.00 - 49,005.00 = 450,995.00.
  await b.clock(TUE);
  s = await restartHere('settled');
  c.match(s.cash, /450,995\.00/, 'stage 4: settled cash 450,995.00');
  c.match(s.holding, /1,000/, 'stage 4: 1,000 BRS held');
  await b.tick();
  c.near((await b.cash(book.id, book.accountId)).settled, 450_995, 'a cycle after the restart pays nothing again');
  const n = (type) => b.sql('SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = ?', book.id, type)[0].n;
  c.eq([b.sql('SELECT COUNT(*) AS n FROM orders WHERE book_id = ?', book.id)[0].n, n('trade.fill'), n('settlement.pay')], [1, 4, 4], 'in the end one order, four fill events, four settlement payments');
  await closeHedgePopup(b);
}

/**
 * SB:stress:kill-mid-confirmation. The server process is killed while the preview dialog's confirmation is on its
 * way: (a) before the server receives it, (b) after the server has stored it but before its answer reaches the page.
 */
export async function interruptedConfirmation(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser interrupted confirmation');
  const insts = { a: await b.stock('BKA', QUOTE), b: await b.stock('BKB', QUOTE) };
  await enter(b, book, '#/markets/US_CASH');
  const counts = (inst) => ({
    strategies: b.sql('SELECT COUNT(DISTINCT o.strategy_id) AS n FROM orders o WHERE o.book_id = ? AND o.instrument_id = ?', book.id, inst.id)[0].n,
    orders: b.sql('SELECT COUNT(*) AS n FROM orders WHERE book_id = ? AND instrument_id = ?', book.id, inst.id)[0].n,
    fills: b.sql('SELECT COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ? AND o.instrument_id = ?', book.id, inst.id)[0].n,
  });
  for (const [variant, stored] of [['a', false], ['b', true]]) {
    const inst = insts[variant];
    const label = stored ? '(b) killed after the server stored the confirmation, before its answer reached the page' : '(a) killed before the server received the confirmation';
    await ui.closeOverlays().catch(() => {});
    const drawer = await fillTicket(b, inst, { qty: 100 });
    const { modal, confirm, pv } = await openPreviewFrom(b, drawer);
    c.eq(pv.blocking, 0, `${label}: the purchase of 100 ${inst.symbol} previews without a block`);
    // The confirmation leaves the page; the server process is killed (SIGKILL) on the way.
    await page.route('**/api/strategies', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      if (stored) { try { await route.fetch(); } catch { /* answered or not: the page will not know */ } }
      await b.t.kill();
      await route.abort('connectionreset');
    }, { times: 1 });
    await confirm.click();
    await modal.locator('.notice.err').first().waitFor({ timeout: 20_000 });
    const said = (await errorsIn(modal)).join(' | ');
    c.match(said, /not reachable, so it is not known whether this was recorded/i, `${label}: the dialog says the server could not be reached and that it is not known whether the trade was recorded`);
    c.match(said, /Sending it again unchanged is safe/i, `${label}: and that sending it again unchanged is safe`);
    c.ok(await modal.isVisible(), `${label}: the preview dialog stays open with what was previewed`);
    const offline = page.getByText(/server is not (reachable|responding)/i).first();
    await offline.waitFor({ timeout: 30_000 });
    c.ok(await offline.isVisible(), `${label}: the page says it cannot reach the server`);
    await b.t.start();
    c.eq(counts(inst), stored ? { strategies: 1, orders: 1, fills: 1 } : { strategies: 0, orders: 0, fills: 0 }, `${label}: after the restart the database holds ${stored ? 'the trade once' : 'nothing of it'}`);
    await b.clean(c, book.id, `${label}: after the restart`);
    // The user, who cannot know which it was, presses Confirm again in the same dialog.
    const again = await answerTo(b, 'POST', /^\/api\/strategies$/, () => modal.getByRole('button', { name: /^Confirm/ }).click());
    c.ok(again.ok, `${label}: the second confirmation is answered`, again.body?.error);
    if (stored) c.eq(again.body?.duplicate, true, `${label}: as a duplicate of what was stored`);
    await modal.waitFor({ state: 'hidden' });
    await b.tick();
    c.eq(counts(inst), { strategies: 1, orders: 1, fills: 1 }, `${label}: in the end one strategy instance, one order, one fill`);
    c.eq(b.sql('SELECT f.qty, f.price FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.instrument_id = ?', inst.id).map((f) => [f.qty, f.price]), [[100, 50.02]], `${label}: 100 shares at 50.02, once`);
    await closeHedgePopup(b);
  }
  // 2 x (5,002.00 + 1.00 commission) = 10,006.00 owed, once each.
  c.near((await b.cash(book.id, book.accountId)).payable, 10_006, 'the Account owes 10,006.00: each purchase once');
  b.takePageErrors().forEach((e) => { if (!/ERR_|Failed to fetch|NetworkError|not reachable/i.test(e)) c.fail(`browser console error: ${e}`); });
}

// ---------------------------------------------------------------------------------------------
// Duplicate clicks on the remaining confirming buttons: Treasury, reference data, agreements
// ---------------------------------------------------------------------------------------------

/** Double-click `button`, wait for `until`, and return how many requests matching (method, path) left the page. */
async function dblclickCounting(b, button, method, path, until) {
  const sent = watchRequests(b.page, method, path);
  await button.dblclick();
  await until();
  await settle(b);
  sent.stop();
  return sent.seen.length;
}
/** A Treasury arrangement dialog (New loan or deposit, Lend a security) opened from the Borrowings page. */
async function openArrangement(b, button, title) {
  const { page, ui } = b;
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury/borrowings');
  await ui.button(page.locator('main'), button).click();
  const dlg = ui.dialog(title);
  await dlg.waitFor();
  return dlg;
}
/** Press the arrangement dialog's preview button; returns the preview dialog and the preview answer. */
async function previewArrangement(b, dlg, button) {
  const asked = await answerTo(b, 'POST', /^\/api\/strategies\/preview$/, () => b.ui.button(dlg, button).click());
  if (!asked.ok) throw new Error(`${button}: the preview was refused: ${asked.body?.error}`);
  const modal = b.ui.dialog(/^Preview: /);
  await modal.waitFor();
  return { modal, pv: asked.body };
}

/** SB:stress:double-click-treasury. Record withdrawal, and the Confirm of a borrowing, a repo and a securities loan. */
export async function doubleClickTreasury(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser double click treasury', { capital: 3_000_000 });
  const bond = await b.instrument(NOTE);
  await b.fixture('quote', { instrumentId: bond.id, bid: 99.98, ask: 100.00, last: 100.00, bidSize: 5e6, askSize: 5e6 });
  const lent = await b.stock('DTL', QUOTE);
  await b.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: bond.id, qty: 1_000_000 }] });
  await b.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: lent.id, qty: 1_000 }] });
  await b.clock(TUE);
  await enter(b, book, '#/treasury');
  await closeHedgePopup(b);
  const ev = (like) => b.sql('SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE ?', book.id, like)[0].n;
  const strategies = () => b.sql('SELECT COUNT(*) AS n FROM strategies WHERE book_id = ?', book.id)[0].n;
  const tcash = async () => (await b.cash(book.id, book.treasuryId)).settled;

  // 1. Record withdrawal: 30,000.00 out of Treasury.
  let cash0 = await tcash();
  let n0 = ev('capital.withdrawal');
  let dlg = await openCapital(b, { type: 'withdrawal', amount: 30_000 });
  let sent = await dblclickCounting(b, ui.button(dlg, 'Record withdrawal'), 'POST', /\/capital$/, async () => { await dlg.waitFor({ state: 'hidden' }); await ui.toast(/Withdrawal recorded/); });
  c.eq(sent, 1, 'Record withdrawal double-clicked: one request left the page');
  c.eq(ev('capital.withdrawal') - n0, 1, 'one withdrawal is recorded');
  c.near(await tcash() - cash0, -30_000, 'Treasury cash fell by 30,000.00, once');

  // 2. A cash loan borrowed by Treasury: 100,000.00 at 5%, maturing 1 April; Confirm double-clicked.
  cash0 = await tcash();
  let s0 = strategies();
  dlg = await openArrangement(b, 'New loan or deposit', 'Cash loan or deposit');
  await ui.select(dlg, 'Borrower').selectOption({ label: 'Treasury' });
  await ui.input(dlg, 'Principal').fill('100000');
  await ui.input(dlg, 'Rate (decimal a year)').fill('0.05');
  await ui.input(dlg, 'Maturity').fill('2026-04-01');
  let p = await previewArrangement(b, dlg, 'Preview loan');
  c.eq(p.pv.blocking, 0, 'the loan previews without a block');
  sent = await dblclickCounting(b, p.modal.getByRole('button', { name: /^Confirm/ }), 'POST', /^\/api\/strategies$/, () => p.modal.waitFor({ state: 'hidden' }));
  await b.tick();
  c.ok(sent >= 1 && sent <= 2, 'the loan\'s confirmation was sent', `${sent} requests`);
  c.note(`loan Confirm double-clicked: ${sent} request${sent === 1 ? '' : 's'} left the page`);
  c.eq(strategies() - s0, 1, 'one borrowing is recorded (one strategy instance)');
  c.near(-(await b.balance(book.id, book.treasuryId, 'loan.liab')), 100_000, 'Treasury owes 100,000.00, once');
  c.near(await tcash() - cash0, 100_000, 'Treasury cash rose by 100,000.00, once');

  // 3. A repo of the note: 900,000.00 against 1,000,000 face at a 2% haircut; Confirm double-clicked.
  cash0 = await tcash();
  s0 = strategies();
  const r = await previewRepo(b, { cash: 900_000, face: 1_000_000 });
  c.ok(r.modal, 'the repo previews', r.refusal);
  if (r.modal) {
    sent = await dblclickCounting(b, r.modal.getByRole('button', { name: /^Confirm/ }), 'POST', /^\/api\/strategies$/, () => r.modal.waitFor({ state: 'hidden' }));
    await b.tick();
    c.note(`repo Confirm double-clicked: ${sent} request${sent === 1 ? '' : 's'} left the page`);
    c.eq(strategies() - s0, 1, 'one repo is recorded');
    c.near(await tcash() - cash0, 900_000, 'Treasury cash rose by 900,000.00, once');
    const pledged = (await b.get(`/api/books/${book.id}/accounting/positions`, { scope: book.treasuryId })).positions.find((x) => x.instrument.id === bond.id);
    c.eq(pledged?.pledgedQty, 1_000_000, 'the note is pledged once: 1,000,000 face');
  }

  // 4. Lend 500 DTL: Confirm double-clicked.
  s0 = strategies();
  dlg = await openArrangement(b, 'Lend a security', 'Lend a security');
  await ui.select(dlg, 'Lender').selectOption({ label: 'Treasury' });
  const picker = ui.field(dlg, 'Position to lend').locator('select').first();
  await picker.locator('option', { hasText: 'DTL' }).first().waitFor({ state: 'attached' });
  await picker.selectOption({ label: (await picker.locator('option').allInnerTexts()).map((x) => x.trim()).find((x) => x.startsWith('DTL')) });
  await ui.drawn();
  await ui.input(dlg, 'Quantity to lend').fill('500');
  await ui.input(dlg, 'Fee (decimal a year)').fill('0.01');
  p = await previewArrangement(b, dlg, 'Preview securities loan');
  c.eq(p.pv.blocking, 0, 'the securities loan previews without a block');
  sent = await dblclickCounting(b, p.modal.getByRole('button', { name: /^Confirm/ }), 'POST', /^\/api\/strategies$/, () => p.modal.waitFor({ state: 'hidden' }));
  await b.tick();
  c.note(`securities loan Confirm double-clicked: ${sent} request${sent === 1 ? '' : 's'} left the page`);
  c.eq(strategies() - s0, 1, 'one securities loan is recorded');
  const onLoan = (await b.get(`/api/books/${book.id}/accounting/positions`, { scope: book.treasuryId })).positions.find((x) => x.instrument.id === lent.id);
  c.eq([onLoan?.qty, onLoan?.onLoanQty], [1_000, 500], '500 of the 1,000 DTL are on loan, once');
  await closeHedgePopup(b);
  await b.clean(c, book.id);
}

/** SB:stress:double-click-reference. Register instrument, Save price, Save assumptions and Save request, each double-clicked. */
export async function doubleClickReference(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser double click reference');
  await enter(b, book, '#/instruments');
  const count = (sql, ...p) => b.sql(sql, ...p)[0].n;

  // 1. Register instrument.
  await ui.button(page.locator('main'), 'New instrument').first().click();
  let dlg = ui.dialog('New instrument');
  await ui.select(dlg, 'Product type').selectOption('common_stock');
  await ui.drawn();
  await ui.input(dlg, 'Name').fill('Double Click Works Inc.');
  await ui.input(dlg, 'Symbol').fill('DCW');
  await ui.input(dlg, 'Venue country').fill('US');
  let sent = await dblclickCounting(b, ui.button(dlg, 'Register instrument'), 'POST', /^\/api\/instruments$/, async () => { await dlg.waitFor({ state: 'hidden' }); await ui.toast(/Instrument registered/); });
  c.eq(sent, 1, 'Register instrument double-clicked: one request left the page');
  c.eq(count(`SELECT COUNT(*) AS n FROM instruments WHERE symbol = 'DCW'`), 1, 'one instrument DCW is registered');

  // 2. Save price (Data connection, Manual entries): 12.50 for DCW.
  await show(b, '#/data/manual');
  const px = ui.section(page.locator('main'), 'Instrument price');
  await px.locator('input[type=search]').fill('DCW');
  await px.locator('.picklist button.pick', { hasText: 'DCW' }).first().click();
  await ui.input(px, 'Price').fill('12.5');
  const obs0 = count(`SELECT COUNT(*) AS n FROM observations WHERE origin = 'manual-entry'`);
  sent = await dblclickCounting(b, ui.button(px, 'Save price'), 'POST', /^\/api\/observations$/, () => ui.toast(/Price saved/));
  c.eq(sent, 1, 'Save price double-clicked: one request left the page');
  c.eq(count(`SELECT COUNT(*) AS n FROM observations WHERE origin = 'manual-entry'`) - obs0, 1, 'one manual price is on file');

  // 3. Save assumptions (Settings): the equity commission changed to 0.01.
  await show(b, '#/settings');
  await assumption(b, 'Fees and commissions', 'Equities').nth(0).fill('0.01');
  const set0 = count(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'book.settings'`, book.id);
  sent = await dblclickCounting(b, ui.button(page.locator('main'), 'Save assumptions'), 'PUT', /^\/api\/books\/[^/]+$/, () => ui.button(page.locator('main'), 'Save assumptions').and(page.locator(':disabled')).waitFor());
  c.eq(sent, 1, 'Save assumptions double-clicked: one request left the page');
  c.eq(count(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'book.settings'`, book.id) - set0, 1, 'one settings change is recorded');

  // 4. Save request: a hedge request made without its context (incomplete), completed in the hedge popup.
  const inst = await b.stock('DCH', QUOTE);
  const held = await b.buy(book, inst, 100);
  await b.tick();
  const reqs = async () => (await b.get('/api/hedge/requests', { bookId: book.id })).items.filter((x) => x.strategyId === held.id);
  let rq = await reqs();
  c.eq(rq.map((x) => x.state), ['incomplete'], 'setup: the purchase made without a context has one incomplete hedge request');
  if (rq.length === 1) {
    // The post-trade popup opens by itself for the new request; otherwise it is opened from the review queue.
    await show(b, '#/strategy');
    let popup = page.locator('[data-testid=hedge-popup]');
    await popup.waitFor({ timeout: 8_000 }).catch(() => {});
    if (!(await popup.count())) popup = await openFromQueue(b, rq[0].id);
    c.match(flat(await popup.innerText()), new RegExp(rq[0].id), 'the hedge popup of that request is open');
    const form = popup.locator('[data-testid=hedge-complete-form]').first();
    const strat = ui.field(form, 'Investment Strategy');
    if (await strat.locator('select').count()) await strat.locator('select').selectOption({ index: 1 });
    else await strat.locator('input').fill('Core Equity');
    await ui.input(form, 'Intended holding period (days)').fill('60');
    await ui.select(form, 'Hedge objective').selectOption({ label: 'Downside protection' });
    const ordersBefore = (await b.books(book.id)).counts.orders;
    sent = await dblclickCounting(b, ui.button(form, 'Save request'), 'POST', /\/complete$/, () => ui.toast(/Request saved/));
    c.eq(sent, 1, 'Save request double-clicked: one request left the page');
    rq = await reqs();
    c.eq(rq.length, 1, 'there is still one hedge request for the position');
    c.ok(rq[0] && rq[0].state !== 'incomplete', 'and it is complete now', rq[0]?.state);
    await b.tick();
    c.eq((await b.books(book.id)).counts.orders, ordersBefore, 'saving (and any recommendation that came back) executed nothing');
    await ui.closeOverlays().catch(() => {});
  }
  await closeHedgePopup(b);
  await b.clean(c, book.id);
}

/** SB:stress:double-click-agreements. Record agreement, Close agreement and Retry failed calls, each double-clicked. */
export async function doubleClickAgreements(b, c) {
  const { page, ui } = b;
  const book = await b.book('Browser double click agreements', { funding: 100_000 });
  const beta = (await b.post(`/api/books/${book.id}/accounts`, { name: 'Beta' })).id;
  await b.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.treasuryId, toUnitId: beta, ccy: 'USD', amount: 30_000 });
  // Beta: a swap under an agreement with variation margin, marked at -5 per 100 on 1,000,000 = -50,000.00.
  await b.fixture('rate', { code: 'TEST-3M', value: 4.0 });
  const agr = await b.post(`/api/books/${book.id}/agreements`, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [beta], terms: { variationMargin: true } });
  const swap = await b.trade({ bookId: book.id, unitId: beta, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract: { productId: 'interest_rate_swap', name: 'IRS double click', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', collateralBasis: { type: 'agreement', agreementId: agr.id }, legs: [
    { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
    { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } } }] });
  await b.post('/api/observations', { kind: 'price', subject: swap.positions[0].instrument.id, value: -5, units: 'per 100 notional' });
  await b.clock(evening('2026-03-02')); // the end-of-day pass calls 50,000.00 from Beta, which has 30,000.00: the call fails
  await enter(b, book, '#/treasury/collateral');
  await closeHedgePopup(b);
  const count = (sql, ...p) => b.sql(sql, ...p)[0].n;

  // 1. Record agreement.
  const desk = page.locator('.coll-desk');
  await desk.waitFor();
  await ui.button(page.locator('main'), 'New agreement').first().click();
  let dlg = ui.dialog('New collateral agreement');
  await dlg.waitFor();
  await ui.input(dlg, 'Agreement name').fill('CSA Dealer B');
  await ui.input(dlg, 'Counterparty').fill('Dealer B');
  await ui.field(dlg, 'Covers').getByText('Alpha', { exact: true }).first().click();
  const a0 = count('SELECT COUNT(*) AS n FROM agreements WHERE book_id = ?', book.id);
  let sent = await dblclickCounting(b, ui.button(dlg, 'Record agreement'), 'POST', /\/agreements$/, () => dlg.waitFor({ state: 'hidden' }));
  c.eq(sent, 1, 'Record agreement double-clicked: one request left the page');
  c.eq(count('SELECT COUNT(*) AS n FROM agreements WHERE book_id = ?', book.id) - a0, 1, 'one agreement is recorded');
  c.eq(await page.locator('.toasts .toast.err').count(), 0, 'no error is shown');

  // 2. Close agreement (the new one: nothing is open under it).
  const row = page.locator('main tr').filter({ hasText: 'CSA Dealer B' }).first();
  await row.waitFor();
  const closes0 = count(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'collateral.agreement' AND json_extract(data, '$.action') = 'closed'`, book.id);
  sent = await dblclickCounting(b, ui.button(row, 'Close agreement'), 'POST', /\/agreements\/[^/]+\/close$/, () => ui.toast(/Agreement closed/));
  c.eq(sent, 1, 'Close agreement double-clicked: one request left the page');
  c.eq(count(`SELECT COUNT(*) AS n FROM agreements WHERE book_id = ? AND name = 'CSA Dealer B' AND status = 'closed'`, book.id), 1, 'the agreement is closed');
  c.eq(count(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'collateral.agreement' AND json_extract(data, '$.action') = 'closed'`, book.id) - closes0, 1, 'one closing is recorded');
  c.eq(await page.locator('.toasts .toast.err').count(), 0, 'no error is shown');

  // 3. Retry failed calls, once Beta has the cash (100,000.00 more, recorded behind the screen).
  c.near((await b.cash(book.id, beta)).margin, 0, 'setup: the 50,000.00 call failed, nothing was posted');
  await b.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.treasuryId, toUnitId: beta, ccy: 'USD', amount: 100_000 });
  await ui.reloadAt('#/treasury/collateral');
  const retry = page.getByRole('button', { name: 'Retry failed calls' });
  await retry.waitFor();
  const mv0 = count(`SELECT COUNT(*) AS n FROM collateral_movements WHERE book_id = ? AND kind = 'variation'`, book.id);
  sent = await dblclickCounting(b, retry, 'POST', /\/collateral\/retry$/, () => ui.toast(/failed call delivered/));
  c.eq(sent, 1, 'Retry failed calls double-clicked: one request left the page');
  c.eq(count(`SELECT COUNT(*) AS n FROM collateral_movements WHERE book_id = ? AND kind = 'variation'`, book.id) - mv0, 1, 'one variation-margin movement');
  c.near((await b.cash(book.id, beta)).margin, 50_000, 'Beta has posted 50,000.00, once');
  await b.tick();
  c.near((await b.cash(book.id, beta)).margin, 50_000, 'a cycle after it posts nothing more');
  await b.clean(c, book.id);
}
