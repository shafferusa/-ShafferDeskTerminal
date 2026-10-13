// Browser driver for the repo family: repos, reverse repos, buy/sell-backs and sell/buy-backs.
//
// A repo is not a registry instrument. It is entered on the "Repo or reverse repo" ticket of the Treasury page
// ("New repo or reverse repo", Borrowings and lending), for Treasury or for an Account, and registers itself when the
// ticket is confirmed. What is done with an open repo is on its row: Set rate, and Repurchase (a repo, in the
// Treasury's or the Account's borrowings) or Terminate (a reverse repo, in the lending table). Those row actions, the
// transfers, the fixings entered by hand and the reading of the Treasury, Account and Book screens are the loan
// family's (drivers/browser/loan.mjs), reused here unchanged.
//
//   ticket   step.ticket = { kind: 'repo', side: 'repo' | 'reverse_repo', productId, productLabel, ccy, principal, name,
//                            collateral: { instrument, lot } (a repo: the position pledged), terms }
//            terms: collateralInstrumentId ('$inst:key'), collateralQty, haircut, rateType, rate | referenceRate + spread,
//                   dayCount, term ('overnight' | 'term' | 'open'), endDate, style, collateralType, triparty, agent, counterparty
//   repay, instrument_lifecycle (set_rate), transfer, create_account, deposit, manual_rate: the loan driver's paths.

import * as loan from './loan.mjs';

export const family = 'repo';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const texts = async (loc) => (await loc.allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
const unitName = (ctx, key) => (key === 'treasury' ? 'Treasury' : key === 'account' || !key ? ctx.spec.book.account.name : ctx.extraUnits.get(key)?.name || key);
const SIDE = { repo: 'Repo', reverse_repo: 'Reverse repo' };
const TERM = { overnight: 'Overnight', term: 'Term', open: 'Open' };
const STYLE = { classic: 'Classic repo', buy_sell_back: 'Buy/sell-back' };
const COLL_TYPE = { gc: 'General collateral', special: 'Special' };

/** A repo is never registered in the registry form. */
export async function contractTerms() {
  throw new Error('A repo is entered on its ticket in Treasury, not in the registry form.');
}

/** Pick an instrument in an InstrumentPicker field by its symbol. */
async function pickInstrument(ui, field, inst) {
  const label = inst.symbol || inst.name;
  const change = field.getByRole('button', { name: exactly('Change') });
  if (await change.count()) await change.click();
  await field.locator('input[type="search"]').fill(label);
  await field.locator('.picklist button').filter({ has: ui.page.locator('b', { hasText: exactly(label) }) }).first().click();
  await field.getByRole('button', { name: exactly('Change') }).waitFor();
}

/** The Repo or reverse repo ticket. Returns { preview } or { refusal } when the ticket itself does not offer what the step asks. */
async function repoDialog(ui, ctx, step) {
  const { page } = ui;
  const tk = step.ticket;
  const t = tk.terms;
  await ui.closeOverlays();
  await ui.reloadAt('#/treasury/borrowings');
  await ui.button(page.locator('main'), 'New repo or reverse repo').click();
  const dlg = ui.dialog('Repo or reverse repo');
  await dlg.waitFor();
  await ui.option(dlg, 'Side', SIDE[tk.side]).click();
  await ui.drawn();
  await ui.select(dlg, /^(Borrower|Lender)/).selectOption({ label: unitName(ctx, step.owner || 'account') });
  const product = ui.select(dlg, 'Product');
  await product.locator('option').first().waitFor({ state: 'attached' });
  await ui.drawn();
  const offered = await product.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent.trim() })));
  if (!offered.some((o) => o.value === tk.productId)) {
    return { refusal: { message: `The Product list of the ${tk.side === 'repo' ? 'repo' : 'reverse repo'} side offers only: ${offered.map((o) => o.label).join(', ')}. "${tk.productLabel || tk.productId}" is not offered.`, where: 'Repo or reverse repo ticket, Product' } };
  }
  await product.selectOption(tk.productId);
  if (tk.productLabel && (await product.locator('option:checked').innerText()).trim() !== tk.productLabel) throw new Error(`The Product list labels ${tk.productId} "${(await product.locator('option:checked').innerText()).trim()}", the spec says "${tk.productLabel}".`);
  await ui.field(dlg, 'Haircut (decimal)').waitFor();
  await ui.drawn();
  if (tk.side === 'repo') {
    // The position pledged: picking it sets the collateral security, the currency and (all of it) the quantity.
    const select = ui.field(dlg, 'Collateral position').locator('select').first();
    const sym = ctx.inst(tk.collateral.instrument).symbol || ctx.inst(tk.collateral.instrument).name;
    await select.locator('option', { hasText: sym }).first().waitFor({ state: 'attached' });
    const label = (await texts(select.locator('option'))).find((x) => x.startsWith(`${sym}:`));
    if (!label) return { refusal: { message: `The Collateral position list does not offer a position in ${sym}.`, where: 'Repo ticket, Collateral position' } };
    await select.selectOption({ label });
    await ui.drawn();
  } else {
    await pickInstrument(ui, ui.field(dlg, 'Collateral security'), ctx.inst(String(t.collateralInstrumentId).replace(/^\$inst:/, '')));
  }
  await ui.input(dlg, 'Currency').fill(tk.ccy);
  await ui.input(dlg, 'Cash principal').fill(String(tk.principal));
  await ui.input(dlg, 'Name').fill(tk.name);
  await ui.input(dlg, 'Collateral quantity').fill(String(t.collateralQty));
  await ui.input(dlg, 'Haircut (decimal)').fill(String(t.haircut));
  await ui.select(dlg, 'Repo rate').selectOption(t.rateType);
  await ui.drawn();
  if (t.rateType === 'floating') {
    await ui.input(dlg, 'Reference rate code').fill(t.referenceRate);
    if (t.spread !== undefined && t.spread !== null) await ui.input(dlg, 'Spread (decimal)').fill(String(t.spread));
  } else if (t.rate !== undefined && t.rate !== null) await ui.input(dlg, 'Rate (decimal a year)').fill(String(t.rate));
  const dayCount = ui.select(dlg, 'Day count');
  const dayCounts = await texts(dayCount.locator('option'));
  if (!dayCounts.includes(t.dayCount)) return { refusal: { message: `The Day count field of a repo offers only: ${dayCounts.join(', ')}. "${t.dayCount}" cannot be chosen.`, where: 'Repo ticket, Day count' } };
  await dayCount.selectOption(t.dayCount);
  await ui.select(dlg, 'Term').selectOption({ label: TERM[t.term] });
  await ui.drawn();
  if (t.term === 'term' && t.endDate) await ui.input(dlg, 'End date').fill(t.endDate);
  await ui.select(dlg, 'Structure').selectOption({ label: STYLE[t.style || 'classic'] });
  await ui.select(dlg, 'Collateral type').selectOption({ label: COLL_TYPE[t.collateralType || 'gc'] });
  const tri = ui.field(dlg, 'Tri-party').locator('input[type="checkbox"]');
  if (Boolean(t.triparty) !== await tri.isChecked()) await tri.click();
  await ui.drawn();
  if (t.triparty && t.agent) await ui.input(dlg, 'Tri-party agent').fill(t.agent);
  if (t.counterparty) await ui.input(dlg, 'Counterparty').fill(t.counterparty);
  return { preview: () => ui.button(dlg, 'Preview repo').click() };
}

export async function ticket(ui, t, ctx, step) {
  if (step.ticket?.kind === 'repo') return repoDialog(ui, ctx, step);
  return loan.ticket(ui, t, ctx, step);
}

export const actions = {
  ...loan.actions,
  async ticket(ui, t, ctx, step, tools) {
    if (step.ticket?.kind !== 'repo') return loan.actions.ticket(ui, t, ctx, step, tools);
    return loan.openTicket(ui, t, ctx, step, tools, () => repoDialog(ui, ctx, step));
  },
};

export const screens = loan.screens;
