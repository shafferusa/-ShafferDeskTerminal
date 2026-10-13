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
import { shown } from '../browser.mjs';
import { numbersAgree } from '../../lib/compare.mjs';

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
  if (t.buffer !== undefined && t.buffer !== null) await ui.input(dlg, 'Additional buffer (amount)').fill(String(t.buffer));
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

const CHANGE = { pledge: 'More collateral (margin call)', release: 'Return of excess collateral', substitute: 'Substitution' };

/**
 * Collateral on the row of an open repo (its owner's page) or reverse repo (Treasury's lending table): a margin call met,
 * excess returned, or a substitution. A row that does not offer Collateral (a buy/sell-back) is a visible refusal.
 */
async function collateral(ui, t, ctx, step) {
  const b = step.body;
  const p = await loan.arrangementOf(t, ctx, { lot: step.lot, instrument: step.instrument });
  const row = await loan.arrangementRow(ui, ctx, p);
  const btn = ui.button(row, 'Collateral');
  if (!await btn.count()) return { refusal: { message: `The row of ${p.instrument.name} offers only: ${(await row.getByRole('button').allInnerTexts()).map((x) => x.trim()).join(', ')}. "Collateral" is not offered.`, where: 'Treasury page, row of the arrangement' } };
  await btn.click();
  const dlg = ui.dialog(/^Collateral on /);
  await dlg.waitFor();
  const offered = await texts(ui.select(dlg, 'Change').locator('option'));
  if (!offered.includes(CHANGE[b.change])) {
    await ui.button(dlg, 'Cancel').click();
    return { refusal: { message: `The Change list of the Collateral dialog offers only: ${offered.join(', ')}. "${CHANGE[b.change]}" is not offered.`, where: 'Collateral dialog, Change' } };
  }
  await ui.select(dlg, 'Change').selectOption({ label: CHANGE[b.change] });
  await ui.drawn();
  if (b.change === 'substitute' && p.qty < 0) {
    const sel = ui.select(dlg, 'Position pledged instead');
    const key = String(b.positionId).split(':')[2];
    const sym = ctx.inst(key).symbol || ctx.inst(key).name;
    await sel.locator('option', { hasText: sym }).first().waitFor({ state: 'attached' });
    const label = (await texts(sel.locator('option'))).find((x) => x.startsWith(`${sym}:`));
    await sel.selectOption({ label });
  } else if (b.change === 'substitute') {
    await pickInstrument(ui, ui.field(dlg, 'Security received instead'), ctx.inst(String(b.instrumentId).replace(/^\$inst:/, '')));
  }
  await ui.field(dlg, /^Quantity/).locator('input').first().fill(String(b.qty));
  const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => ui.button(dlg, 'Record collateral change').click());
  if (!r.ok) {
    await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
    return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: 'Collateral dialog message' } };
  }
  await dlg.waitFor({ state: 'hidden' });
  return {};
}

/** The preview must display what a repo leg reconciles to: collateral value, haircut, buffer, the cash supported; a buy/sell-back its forward. */
async function reconciliationOnScreen(modal, pv) {
  const out = [];
  const rows = await modal.locator('table.pv-legs tbody tr:not(.group)').evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.children].filter((td) => td.dataset.label).map((td) => [td.dataset.label, td.innerText.trim()]))));
  const m = (x) => `${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  for (const l of pv.legs.filter((x) => x.kind === 'repo_open')) {
    const r = rows.find((x) => x.Leg && x.Leg.split('\n')[0].trim() === String(l.n));
    const fill = (r?.['Estimated fill'] || '').replace(/\s+/g, ' ');
    const at = `preview screen, leg ${l.n}`;
    const c = l.financing?.collateral;
    if (c) {
      for (const [what, x] of [['collateral value', c.worth], ['haircut', c.haircutAmount], ['cash supported', c.supports]]) if (!fill.includes(m(x))) out.push(`${at}: the ${what} ${x} is not displayed ("${fill}")`);
      if (c.buffer && !fill.includes(m(c.buffer))) out.push(`${at}: the buffer ${c.buffer} is not displayed`);
    } else if (l.financing) out.push(`${at}: the preview has no collateral reconciliation for the repo leg`);
    const f = l.financing?.forward;
    if (f && !(fill.includes(`Forward ${m(f.amount)}`) && fill.includes(f.endDate))) out.push(`${at}: the forward ${f.amount} on ${f.endDate} is not displayed ("${fill}")`);
  }
  return out;
}

export const actions = {
  ...loan.actions,
  async ticket(ui, t, ctx, step, tools) {
    if (step.ticket?.kind !== 'repo') return loan.actions.ticket(ui, t, ctx, step, tools);
    // As loan.openTicket, with the reconciliation checked on the preview screen as well.
    const inspect = async (modal, pv) => [...await loan.financingOnScreen(ui, modal, pv), ...await reconciliationOnScreen(modal, pv)];
    return loan.openTicket(ui, t, ctx, step, { ...tools, inspect }, () => repoDialog(ui, ctx, step));
  },
  /**
   * A part repurchase: the Repurchase (or Terminate) preview shows the whole outstanding principal and does not let a
   * quantity be typed, which is how the interface refuses it. In full, the loan family's path.
   */
  async repay(ui, t, ctx, step, tools) {
    const p = step.amount === undefined ? null : await loan.arrangementOf(t, ctx, step);
    if (!p || p.family !== 'repo') return loan.actions.repay(ui, t, ctx, step, tools);
    const label = p.qty < 0 ? 'Repurchase' : 'Terminate';
    const row = await loan.arrangementRow(ui, ctx, p);
    await ui.button(row, label).click();
    const modal = ui.dialog(/^Preview: /);
    await modal.waitFor();
    const cell = modal.locator('table.pv-legs tbody tr:not(.group) td[data-label="Quantity"]').first();
    await cell.waitFor();
    if (await cell.locator('input').count()) return loan.actions.repay(ui, t, ctx, step, tools);
    const fixed = (await cell.innerText()).split('\n')[0].trim();
    await ui.closeOverlays();
    return { refusal: { message: `The ${label} preview fixes the quantity at ${fixed}: a part cannot be entered.`, where: `${label} preview, Quantity` } };
  },
  async lifecycle(ui, t, ctx, step) {
    if (step.body?.action !== 'collateral') return undefined;
    return collateral(ui, t, ctx, step);
  },
};

/**
 * The loan family's screens (Treasury page, Accounts, Book balance sheet), then the Treasury Collateral tab: securities
 * pledged in the inventory and the collateral received under reverse repos, against the API and the spec.
 */
export async function screens(ui, ctx, t, info) {
  const out = await loan.screens(ui, ctx, t, info);
  const { expected } = info;
  const main = ui.page.locator('main');
  const tre = await t.http.get(`/api/books/${ctx.bookId}/treasury`);
  await ui.reloadAt('#/treasury/collateral');
  await ui.section(main, 'Collateral received under reverse repos').waitFor();
  await ui.drawn();
  const tables = await ui.tables(main);
  const recv = tables.find((x) => x.title.startsWith('Collateral received under reverse repos'));
  const rows = (recv?.rows || []).filter((r) => r.cells.length >= 4).map((r) => ({ sym: r.cells[0].trim(), qty: shown(r.cells[1]), under: r.cells[2].trim(), owner: r.cells[3].trim() }));
  const api = tre.collateralReceived || [];
  if (rows.length !== api.length) out.push(`screen vs API: collateral received lists ${rows.length} rows; the API has ${api.length}`);
  for (const a of api) {
    const r = rows.find((x) => x.under === a.arrangement);
    if (!r) { out.push(`screen vs API: collateral received under ${a.arrangement} is not listed`); continue; }
    if (r.sym !== (a.instrument?.symbol || a.instrument?.name)) out.push(`screen vs API: collateral under ${a.arrangement} shows ${r.sym}`);
    if (!numbersAgree(a.qty, r.qty)) out.push(`screen vs API: collateral under ${a.arrangement} shows ${r.qty.text}, the API has ${a.qty}`);
  }
  // The spec: what each reverse repo holds.
  for (const e of (expected.positions || []).filter((x) => x.collateralHeld)) {
    const sym = ctx.inst(e.collateralHeld.instrument).symbol || ctx.inst(e.collateralHeld.instrument).name;
    const r = rows.find((x) => x.sym === sym);
    if (!r || !numbersAgree(e.collateralHeld.qty, r.qty)) out.push(`spec vs screen: collateral received in ${sym} shows ${r ? r.qty.text : 'nothing'}, expected ${e.collateralHeld.qty}`);
  }
  if (Array.isArray(expected.positions) && !expected.positions.some((x) => x.collateralHeld) && rows.length) out.push(`spec vs screen: collateral received lists ${rows.length} rows; the spec has none`);
  // Pledged quantities in the securities inventory.
  const inv = tables.find((x) => x.title.startsWith('Securities held'));
  const col = (name) => inv?.head.findIndex((h) => h.startsWith(name)) ?? -1;
  for (const e of (expected.positions || []).filter((x) => x.pledged !== undefined && ctx.instruments[x.instrument] && !['repo', 'secloan', 'loan'].includes(ctx.inst(x.instrument).family))) {
    const sym = ctx.inst(e.instrument).symbol || ctx.inst(e.instrument).name;
    const r = inv?.rows.find((x) => x.cells[0].split('\n')[0].trim() === sym);
    if (!r) { if (e.qty > 0) out.push(`spec vs screen: ${sym} is not in the securities inventory`); continue; }
    if (!numbersAgree(e.pledged, shown(r.cells[col('Pledged')]))) out.push(`spec vs screen: ${sym} pledged shows "${r.cells[col('Pledged')]}", expected ${e.pledged}`);
  }
  return out;
}
