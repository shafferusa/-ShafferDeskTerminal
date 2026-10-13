// Browser driver for the secloan family: securities borrowing and lending, stock loans and bond loans.
//
// A securities loan is not a registry instrument. A borrow is the borrow leg of the security ticket's Sell short (the
// equity or bond driver's ticket, `ticketOf`); securities are lent from the Treasury page's "Lend a security" ticket. What
// is done with an open loan: a lender's recall of borrowed securities (the strategy instance's position Lifecycle menu,
// "Lender recall"), and Take back (securities lent, Treasury's lending table) or Return (securities borrowed). The reading
// of the Treasury, Account and Book screens is the loan family's (drivers/browser/loan.mjs), with the Treasury Collateral
// tab's securities on loan added here.
//
//   ticket   step.ticket = { kind: 'lend', productId, productLabel, position: { instrument, lot }, qty, name, terms }
//            terms: feeRate, collateralPct, collateralAmount, recallable, counterparty
//   repay    step.lot (the loan) and step.amount (a part; otherwise the whole quantity): Take back / Return
//   lifecycle  body { action: 'recall', qty, days }

import * as loan from './loan.mjs';
import { shown } from '../browser.mjs';
import { numbersAgree } from '../../lib/compare.mjs';

export const family = 'secloan';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const texts = async (loc) => (await loc.allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
const unitName = (ctx, key) => (key === 'treasury' ? 'Treasury' : key === 'account' || !key ? ctx.spec.book.account.name : ctx.extraUnits.get(key)?.name || key);

/** A securities loan is never registered in the registry form. */
export async function contractTerms() {
  throw new Error('A securities loan is entered on its ticket (Lend a security, or the borrow leg of a short sale), not in the registry form.');
}

/** The "Lend a security" ticket of the Treasury page. Returns { preview } or { refusal }. */
async function lendDialog(ui, ctx, step) {
  const { page } = ui;
  const tk = step.ticket;
  const t = tk.terms || {};
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury/borrowings');
  await ui.button(page.locator('main'), 'Lend a security').click();
  const dlg = ui.dialog('Lend a security');
  await dlg.waitFor();
  await ui.select(dlg, /^Lender/).selectOption({ label: unitName(ctx, step.owner || 'account') });
  const product = ui.select(dlg, 'Product');
  await product.locator('option').first().waitFor({ state: 'attached' });
  await ui.drawn();
  const offered = await product.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent.trim() })));
  if (!offered.some((o) => o.value === tk.productId)) {
    return { refusal: { message: `The Product list of Lend a security offers only: ${offered.map((o) => o.label).join(', ')}. "${tk.productLabel || tk.productId}" is not offered.`, where: 'Lend a security, Product' } };
  }
  await product.selectOption(tk.productId);
  if (tk.productLabel && (await product.locator('option:checked').innerText()).trim() !== tk.productLabel) throw new Error(`The Product list labels ${tk.productId} "${(await product.locator('option:checked').innerText()).trim()}", the spec says "${tk.productLabel}".`);
  await ui.field(dlg, 'Fee (decimal a year)').waitFor();
  await ui.drawn();
  // The position lent: picking it sets the security, the currency and (all that is free) the quantity.
  const select = ui.field(dlg, 'Position to lend').locator('select').first();
  const sym = ctx.inst(tk.position.instrument).symbol || ctx.inst(tk.position.instrument).name;
  await select.locator('option', { hasText: sym }).first().waitFor({ state: 'attached' });
  const label = (await texts(select.locator('option'))).find((x) => x.startsWith(`${sym}:`));
  if (!label) return { refusal: { message: `The Position to lend list does not offer a position in ${sym}.`, where: 'Lend a security, Position to lend' } };
  await select.selectOption({ label });
  await ui.drawn();
  await ui.input(dlg, 'Quantity to lend').fill(String(tk.qty));
  await ui.input(dlg, 'Name').fill(tk.name);
  await ui.input(dlg, 'Fee (decimal a year)').fill(String(t.feeRate));
  if (t.collateralPct !== undefined && t.collateralPct !== null) await ui.input(dlg, 'Cash collateral (share of value)').fill(String(t.collateralPct));
  if (t.collateralAmount !== undefined && t.collateralAmount !== null) await ui.input(dlg, 'Collateral amount').fill(String(t.collateralAmount));
  const rec = ui.field(dlg, 'Recallable').locator('input[type="checkbox"]');
  if ((t.recallable !== false) !== await rec.isChecked()) await rec.click();
  if (t.counterparty) await ui.input(dlg, 'Counterparty').fill(t.counterparty);
  await ui.drawn();
  return { preview: () => ui.button(dlg, 'Preview securities loan').click() };
}

/** The preview of securities lent must display the cash collateral received. */
async function lendingOnScreen(modal, pv) {
  const out = [];
  const rows = await modal.locator('table.pv-legs tbody tr:not(.group)').evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.children].filter((td) => td.dataset.label).map((td) => [td.dataset.label, td.innerText.trim()]))));
  const m = (x) => Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const l of pv.legs.filter((x) => x.kind === 'lend_sec')) {
    const r = rows.find((x) => x.Leg && x.Leg.split('\n')[0].trim() === String(l.n));
    const fill = (r?.['Estimated fill'] || '').replace(/\s+/g, ' ');
    const c = l.lending;
    if (!c) out.push(`preview screen, leg ${l.n}: the preview has no cash collateral for the securities lent`);
    else if (!fill.includes(`Cash collateral received ${m(c.collateralCash)}`)) out.push(`preview screen, leg ${l.n}: the cash collateral ${c.collateralCash} is not displayed ("${fill}")`);
  }
  return out;
}

export async function ticket(ui, t, ctx, step) {
  if (step.ticket?.kind === 'lend') return lendDialog(ui, ctx, step);
  throw new Error('The secloan driver opens only the Lend a security ticket; a borrow is the short sale of the security\'s own ticket (ticketOf).');
}

/** The securities loan of a lot, from the API: the position, its instrument and its owner. */
async function secLoanOf(t, ctx, lot) {
  const s = await t.strategy(ctx.lot(lot).strategyId);
  const p = s.positions.find((x) => x.family === 'secloan');
  if (!p) throw new Error(`"${lot}" holds no securities loan.`);
  const all = (await t.accounting(ctx.bookId, 'positions', { scope: 'book' })).positions;
  return all.find((x) => x.positionId === p.positionId) || p;
}

export const actions = {
  async ticket(ui, t, ctx, step, tools) {
    if (step.ticket?.kind !== 'lend') return undefined; // the security ticket (a short sale with its borrow leg): the shared path
    const inspect = (modal, pv) => lendingOnScreen(modal, pv);
    return loan.openTicket(ui, t, ctx, step, { ...tools, inspect }, () => lendDialog(ui, ctx, step));
  },

  /** Take back (securities lent: Treasury's lending table) or Return (securities borrowed: the owner's borrowing table). A part is typed into the preview. */
  async repay(ui, t, ctx, step, tools) {
    const p = await secLoanOf(t, ctx, step.lot);
    const { page } = ui;
    await ui.closeOverlays();
    const lent = p.qty < 0;
    const account = (p.owner?.kind || (p.unitId === ctx.treasuryId ? 'treasury' : 'account')) === 'account';
    if (!lent && account) await ui.reloadAt(`#/account/${p.unitId}`); else await ui.reloadAt('#/treasury/borrowings');
    const panel = ui.section(page.locator('main'), lent ? 'Lending, deposits and securities lent' : account ? 'Borrowings of this Account' : 'Treasury\'s own borrowings');
    const head = panel.locator('tbody tr').filter({ hasText: p.positionId }).first();
    await head.waitFor();
    const row = lent ? head : head.locator('xpath=following-sibling::tr[1]');
    const label = lent ? 'Take back' : 'Return';
    const edit = step.amount === undefined ? undefined : async (modal) => {
      await modal.locator('table.pv-legs tbody tr:not(.group) td[data-label="Quantity"] input').first().fill(String(step.amount));
    };
    return tools.previewAndConfirm(ui, ctx, () => ui.button(row, label).click(), { expectsRefusal: tools.expectsRefusal, edit });
  },

  /** A lender's recall of borrowed securities: the borrow position's Lifecycle menu on its strategy instance. */
  async lifecycle(ui, t, ctx, step) {
    if (step.body?.action !== 'recall') return undefined;
    const { page } = ui;
    const p = await secLoanOf(t, ctx, step.lot);
    const drawer = await ui.openStrategy(ctx, ctx.lot(step.lot).strategyId);
    const row = ui.section(drawer, 'Positions').locator('tbody tr').filter({ has: page.locator('.sym', { hasText: exactly(p.instrument.symbol || p.instrument.name) }) }).first();
    const menu = row.locator('select').first();
    const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
    if (!offered.includes('Lender recall')) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "Lender recall" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
    await menu.selectOption({ label: 'Lender recall' });
    const dlg = ui.dialog(/^Lender recall/);
    await dlg.waitFor();
    if (step.body.qty !== undefined) await ui.input(dlg, 'Quantity recalled').fill(String(step.body.qty));
    if (step.body.days !== undefined) await ui.input(dlg, 'Business days to return').fill(String(step.body.days));
    const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => ui.button(dlg, 'Record lender recall').click());
    if (!r.ok) { await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor(); return { refusal: { message: r.body?.error, status: r.status, where: 'Lender recall dialog message' } }; }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },

  transfer: loan.actions.transfer,
};

/**
 * The loan family's screens (Treasury page with its borrowing and lending tables, the Accounts, the Book balance sheet),
 * then the Treasury Collateral tab: the quantity of each holding out on loan, against the API and the spec.
 */
export async function screens(ui, ctx, t, info) {
  const out = await loan.screens(ui, ctx, t, info);
  const { expected } = info;
  const main = ui.page.locator('main');
  const tre = await t.http.get(`/api/books/${ctx.bookId}/treasury`);
  await ui.reloadAt('#/treasury/collateral');
  await ui.section(main, 'Securities held').waitFor();
  await ui.drawn();
  const tables = await ui.tables(main);
  const inv = tables.find((x) => x.title.startsWith('Securities held'));
  const col = (name) => inv?.head.findIndex((h) => h.startsWith(name)) ?? -1;
  const rowOf = (sym, owner) => inv?.rows.find((x) => x.cells[0].split('\n')[0].trim() === sym && (!owner || x.cells[col('Owner')].trim() === owner));
  for (const i of tre.collateralInventory || []) {
    const sym = i.instrument.symbol || i.instrument.name;
    const r = rowOf(sym, i.owner.kind === 'treasury' ? 'Treasury' : i.owner.name);
    if (!r) { out.push(`screen vs API: ${sym} of ${i.owner.name} is not in the securities inventory`); continue; }
    if (!numbersAgree(i.onLoanQty, shown(r.cells[col('On loan')]))) out.push(`screen vs API: ${sym} on loan shows "${r.cells[col('On loan')]}", the API has ${i.onLoanQty}`);
    if (!numbersAgree(i.availableQty, shown(r.cells[col('Available')]))) out.push(`screen vs API: ${sym} available shows "${r.cells[col('Available')]}", the API has ${i.availableQty}`);
  }
  for (const e of (expected.positions || []).filter((x) => x.onLoan !== undefined && ctx.instruments[x.instrument])) {
    const sym = ctx.inst(e.instrument).symbol || ctx.inst(e.instrument).name;
    const r = rowOf(sym, unitName(ctx, e.owner));
    if (!r) { if (e.qty > 0) out.push(`spec vs screen: ${sym} is not in the securities inventory`); continue; }
    if (!numbersAgree(e.onLoan, shown(r.cells[col('On loan')]))) out.push(`spec vs screen: ${sym} on loan shows "${r.cells[col('On loan')]}", expected ${e.onLoan}`);
  }
  return out;
}
