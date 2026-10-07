// Browser driver for the loan family: cash loans and deposits.
//
// These contracts are not registry instruments. They are entered on tickets of the Treasury page and of an
// Account's page (web/views/treasury.js, web/views/account.js), and so are the flows around them. This file
// drives those tickets and reads those pages:
//
//   ticket   step.ticket.kind = 'loan'            "Cash loan or deposit" (Treasury: New loan or deposit; Account: Borrow cash)
//                               'convert'         "Convert currency"
//                               'borrow_convert'  "Borrow and convert"
//                               'secondary_sale'  the arrangement's own drawer (Instruments): no ticket is offered there
//   repay                                         Repay / Withdraw on the row of the open arrangement; a part is typed in the preview
//   instrument_lifecycle (set_rate)               Set rate on the row of the open arrangement
//   transfer                                      Fund from Treasury, Return to Treasury, Transfer to another Account (Account page)
//   create_account, deposit                       New Account; Deposit or withdraw capital
//
// After every step `screens` reads the Treasury page (its own borrowings, the Account-originated borrowings it
// oversees, the Book totals, the lending table), the borrowing Account's page and the Book balance sheet, and
// compares each with the API and with the spec: one borrowing must be one record in all three views.
//
// A step that is not one of these (a security ticket borrowed with `ticketOf`, a corporate action) falls through
// to the shared paths in ../browser.mjs.

import { learnContracts } from '../../lib/actions.mjs';
import { numbersAgree } from '../../lib/compare.mjs';
import { normalizeResult } from '../../lib/normalize.mjs';
import { shown } from '../browser.mjs';

export const family = 'loan';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const SIDE_LABEL = { borrow_cash: 'Borrow cash', lend_cash: 'Lend or deposit cash' };
const unitName = (ctx, key) => (key === 'treasury' ? 'Treasury' : key === 'account' || !key ? ctx.spec.book.account.name : ctx.extraUnits.get(key)?.name || key);
const texts = async (loc) => (await loc.allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);

/** A loan or deposit is never registered in the registry form: the form says so and offers no fields. */
export async function contractTerms() {
  throw new Error('A loan or deposit is entered on its ticket in Treasury or on an Account page, not in the registry form.');
}

/** Wait until a select has a chosen option that is a currency code, then choose (the dialog picks a default once balances load). */
async function chooseCurrency(ui, dlg, ccy) {
  const select = ui.select(dlg, 'Currency');
  await select.locator('option:checked', { hasText: /^[A-Z]{3}$/ }).waitFor({ state: 'attached' });
  await ui.drawn();
  if (!(await texts(select.locator('option'))).includes(ccy)) return false;
  await select.selectOption(ccy);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------------------------

/** The Cash loan or deposit ticket. Returns { preview } or { refusal } when the ticket itself does not offer what the step asks. */
async function loanDialog(ui, ctx, step) {
  const { page } = ui;
  const tk = step.ticket;
  const ownerKey = step.owner || 'account';
  const lending = tk.side === 'lend_cash';
  await ui.closeOverlays();
  if (tk.page === 'account') {
    await ui.reloadAt(`#/account/${ctx.unitId(ownerKey)}`);
    await ui.button(page.locator('main .toolbar'), 'Borrow cash').click();
  } else {
    await ui.reloadAt('#/treasury/borrowings');
    await ui.button(page.locator('main'), 'New loan or deposit').click();
  }
  const dlg = ui.dialog('Cash loan or deposit');
  await dlg.waitFor();
  const who = ui.select(dlg, /^(Borrower|Lender)/);
  if (tk.page === 'account') {
    // Opened from an Account's page, the ticket is fixed to that Account.
    if (!await who.isDisabled()) throw new Error('The ticket opened from an Account page lets the borrower be changed.');
    const chosen = (await who.locator('option:checked').innerText()).trim();
    if (chosen !== unitName(ctx, ownerKey)) throw new Error(`The ticket opened from the Account page is fixed to "${chosen}", not "${unitName(ctx, ownerKey)}".`);
  } else await who.selectOption({ label: unitName(ctx, ownerKey) });
  await ui.option(dlg, 'Side', SIDE_LABEL[tk.side]).click();
  // The product list follows the side: deposits are offered only when lending, margin loans and facilities only when borrowing.
  const product = ui.select(dlg, 'Product');
  await product.locator('option').first().waitFor({ state: 'attached' });
  await ui.drawn();
  const offered = await product.locator('option').evaluateAll((os) => os.map((o) => ({ value: o.value, label: o.textContent.trim() })));
  if (!offered.some((o) => o.value === tk.productId)) {
    return { refusal: { message: `The Product list of the ${lending ? 'lending' : 'borrowing'} side offers only: ${offered.map((o) => o.label).join(', ')}. "${tk.productLabel || tk.productId}" is not offered.`, where: 'Cash loan or deposit ticket, Product' } };
  }
  await product.selectOption(tk.productId);
  if (tk.productLabel && (await product.locator('option:checked').innerText()).trim() !== tk.productLabel) throw new Error(`The Product list labels ${tk.productId} "${(await product.locator('option:checked').innerText()).trim()}", the spec says "${tk.productLabel}".`);
  await ui.field(dlg, 'Arrangement').waitFor();
  await ui.drawn();
  await ui.input(dlg, 'Currency').fill(tk.ccy);
  await ui.input(dlg, 'Principal').fill(String(tk.principal));
  await ui.input(dlg, 'Name').fill(tk.name);

  const terms = tk.terms;
  // The arrangement type comes from the product; a spec that states another one chooses it.
  const arrangement = ui.select(dlg, 'Arrangement');
  if (await arrangement.inputValue() !== terms.loanType) await arrangement.selectOption(terms.loanType);
  await ui.select(dlg, exactly('Rate')).selectOption(terms.rateType);
  await ui.drawn();
  if (terms.rateType === 'floating') {
    if (terms.referenceRate) await ui.input(dlg, 'Reference rate code').fill(terms.referenceRate);
    if (terms.spread !== undefined && terms.spread !== null) await ui.input(dlg, 'Spread (decimal)').fill(String(terms.spread));
  } else if (terms.rate !== undefined && terms.rate !== null) await ui.input(dlg, 'Rate (decimal a year)').fill(String(terms.rate));
  const dayCount = ui.select(dlg, 'Day count');
  const dayCounts = await texts(dayCount.locator('option'));
  if (!dayCounts.includes(terms.dayCount)) {
    return { refusal: { message: `The Day count field of a loan or deposit offers only: ${dayCounts.join(', ')}. "${terms.dayCount}" cannot be chosen.`, where: 'Cash loan or deposit ticket, Day count' } };
  }
  await dayCount.selectOption(terms.dayCount);
  if (terms.maturity) {
    await ui.input(dlg, 'Maturity').fill(terms.maturity);
    await ui.drawn();
    await ui.select(dlg, 'Interest paid').selectOption(terms.interestPayment);
  } else {
    // Open-ended: there is no maturity to pay at, and the ticket says interest is paid monthly.
    const note = (await ui.field(dlg, 'Interest paid').innerText()).replace(/\s+/g, ' ');
    if (!/Monthly, because an open-ended arrangement has no maturity to pay at/.test(note)) throw new Error(`An open-ended arrangement should say that interest is paid monthly; the ticket says "${note}".`);
  }
  if (terms.counterparty) await ui.input(dlg, 'Counterparty').fill(terms.counterparty);
  if (tk.pledge) {
    const refusal = await pledge(ui, ctx, dlg, tk.pledge);
    if (refusal) return { refusal };
  }
  return { preview: () => ui.button(dlg, 'Preview loan').click() };
}

/** Collateral of a secured loan: the position to pledge and the quantity, in the ticket's Collateral fields. */
async function pledge(ui, ctx, dlg, p) {
  const field = ui.field(dlg, 'Collateral position');
  if (!await field.count()) return { message: 'The Cash loan or deposit ticket has no Collateral position field for this arrangement.', where: 'Cash loan or deposit ticket, Collateral' };
  const select = field.locator('select').first();
  const sym = ctx.inst(p.instrument).symbol;
  await select.locator('option', { hasText: sym }).first().waitFor({ state: 'attached' });
  const label = (await texts(select.locator('option'))).find((x) => x.startsWith(`${sym}:`));
  if (!label) return { message: `The Collateral position list does not offer a position in ${sym}.`, where: 'Cash loan or deposit ticket, Collateral' };
  await select.selectOption({ label });
  await ui.drawn();
  await ui.input(dlg, 'Quantity to pledge').fill(String(p.qty));
  return null;
}

/** The Convert currency ticket: a spot FX trade inside one Treasury or Account. */
async function convertDialog(ui, ctx, step) {
  const { page } = ui;
  const tk = step.ticket;
  const ownerKey = step.owner || 'account';
  const pair = ctx.inst(tk.pair);
  await ui.closeOverlays();
  if (tk.page === 'account') {
    await ui.reloadAt(`#/account/${ctx.unitId(ownerKey)}`);
    await ui.button(page.locator('main .toolbar'), 'Convert currency').click();
  } else {
    await ui.reloadAt('#/treasury');
    await ui.button(page.locator('main'), 'Convert currency').first().click();
  }
  const dlg = ui.dialog('Convert currency');
  await dlg.waitFor();
  if (tk.page !== 'account') await ui.select(dlg, exactly('In')).selectOption({ label: unitName(ctx, ownerKey) });
  const pairs = ui.select(dlg, 'Currency pair');
  await pairs.locator('option', { hasText: exactly(pair.symbol || pair.name) }).waitFor({ state: 'attached' });
  await pairs.selectOption(pair.id);
  const { base, quote } = pair.terms;
  await ui.option(dlg, 'Direction', tk.action === 'sell' ? `Sell ${base}, receive ${quote}` : `Sell ${quote}, receive ${base}`).click();
  await ui.input(dlg, `${base} to ${tk.action}`).fill(String(tk.qty));
  return { preview: () => ui.button(dlg, 'Preview conversion').click() };
}

/** The Borrow and convert ticket: a loan in one currency and its spot conversion, one package, one confirmation. */
async function borrowConvertDialog(ui, ctx, step) {
  const { page } = ui;
  const tk = step.ticket;
  const ownerKey = step.owner || 'account';
  const pair = ctx.inst(tk.pair);
  await ui.closeOverlays();
  if (tk.page === 'account') {
    await ui.reloadAt(`#/account/${ctx.unitId(ownerKey)}`);
    await ui.button(page.locator('main .toolbar'), 'Borrow and convert').click();
  } else {
    await ui.reloadAt('#/treasury/borrowings');
    await ui.button(page.locator('main'), 'Borrow and convert').first().click();
  }
  const dlg = ui.dialog('Borrow and convert');
  await dlg.waitFor();
  if (tk.page !== 'account') await ui.select(dlg, 'Borrower').selectOption({ label: unitName(ctx, ownerKey) });
  const pairs = ui.select(dlg, 'Currency pair');
  await pairs.locator('option', { hasText: exactly(pair.symbol || pair.name) }).waitFor({ state: 'attached' });
  await pairs.selectOption(pair.id);
  const { base, quote } = pair.terms;
  const other = tk.ccy === base ? quote : base;
  await ui.option(dlg, exactly('Borrow'), `Borrow ${tk.ccy}, receive ${other}`).click();
  await ui.input(dlg, `Principal to borrow (${tk.ccy})`).fill(String(tk.principal));
  await ui.field(dlg, 'Arrangement').waitFor();
  const terms = tk.terms;
  await ui.select(dlg, exactly('Rate')).selectOption(terms.rateType);
  await ui.drawn();
  if (terms.rateType === 'floating') {
    await ui.input(dlg, 'Reference rate code').fill(terms.referenceRate);
    if (terms.spread !== undefined && terms.spread !== null) await ui.input(dlg, 'Spread (decimal)').fill(String(terms.spread));
  } else if (terms.rate !== undefined && terms.rate !== null) await ui.input(dlg, 'Rate (decimal a year)').fill(String(terms.rate));
  await ui.select(dlg, 'Day count').selectOption(terms.dayCount);
  if (terms.maturity) {
    await ui.input(dlg, 'Maturity').fill(terms.maturity);
    await ui.drawn();
    await ui.select(dlg, 'Interest paid').selectOption(terms.interestPayment);
  }
  if (terms.counterparty) await ui.input(dlg, 'Counterparty').fill(terms.counterparty);
  // Borrowing the quote currency: the ticket sizes the base amount from the current ask, less its stated headroom.
  // The step states the amount it expects there (`sized`) and may type another (`baseQty`).
  if (tk.ccy === quote) {
    const field = ui.input(dlg, `${base} to buy`);
    if (tk.sized !== undefined) {
      const seen = Number((await field.inputValue()).replace(/,/g, ''));
      if (Math.abs(seen - tk.sized) > 0.005) throw new Error(`The ticket sized the ${base} amount at ${seen}; the spec works it out as ${tk.sized}.`);
    }
    if (tk.baseQty !== undefined) await field.fill(String(tk.baseQty));
  }
  return { preview: () => ui.button(dlg, 'Preview borrow and convert').click() };
}

/**
 * An attempt to sell an arrangement like a security. The registry lists it (when financing arrangements are
 * included); its drawer's Trade tab offers no ticket and says where the arrangement is managed.
 */
async function secondarySale(ui, ctx, step) {
  const { page } = ui;
  const inst = ctx.inst(step.ticket.instrument);
  await ui.closeOverlays();
  await ui.goto('#/instruments');
  await page.locator('main label.check', { hasText: 'Include loans, repos and securities loans' }).locator('input').check();
  await page.getByPlaceholder(/Filter by symbol, name/).fill(inst.name);
  await page.locator('main table tbody tr').filter({ hasText: inst.name }).first().click();
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^Trade/ }) });
  await drawer.waitFor();
  await ui.tab(drawer, 'Trade');
  await drawer.locator('.notice', { hasText: 'financing arrangement' }).first().waitFor();
  if (await drawer.getByRole('button', { name: /^Preview/ }).count()) throw new Error(`The drawer of ${inst.name} offers a trade ticket.`);
  return { refusal: { message: (await texts(drawer.locator('.notice'))).join(' | '), where: 'instrument drawer, Trade tab: no ticket is offered' } };
}

export async function ticket(ui, t, ctx, step) {
  switch (step.ticket?.kind) {
    case 'secondary_sale': return secondarySale(ui, ctx, step);
    case 'loan': return loanDialog(ui, ctx, step);
    case 'convert': return convertDialog(ui, ctx, step);
    case 'borrow_convert': return borrowConvertDialog(ui, ctx, step);
    default: throw new Error(`Step "${step.id}" has no \`ticket\` the loan driver knows (loan, convert, borrow_convert).`);
  }
}

// ---------------------------------------------------------------------------------------------
// What the preview dialog displays for financing legs
// ---------------------------------------------------------------------------------------------

/** Every financing leg of the preview must display its own figures: cash, rate, daily interest, principal and interest of a repayment. */
async function financingOnScreen(ui, modal, pv) {
  const out = [];
  const rows = await modal.locator('table.pv-legs tbody tr:not(.group)').evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.children].filter((td) => td.dataset.label).map((td) => [td.dataset.label, td.innerText.trim()]))));
  const money = (x) => Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const l of pv.legs.filter((x) => ['loan', 'repay'].includes(x.kind))) {
    const r = rows.find((x) => x.Leg && x.Leg.split('\n')[0].trim() === String(l.n));
    const at = `preview screen, leg ${l.n} (${l.label})`;
    if (!r) { out.push(`${at}: the leg is not displayed`); continue; }
    const what = r.What.replace(/\s+/g, ' ');
    const fill = (r['Estimated fill'] || '').replace(/\s+/g, ' ');
    if (!what.startsWith(l.label)) out.push(`${at}: the row is labelled "${what.slice(0, 60)}"`);
    if (typeof l.cash === 'number' && !numbersAgree(l.cash, shown(r.Cash))) out.push(`${at}: cash shows "${r.Cash}", the preview has ${l.cash}`);
    if (l.kind === 'loan') {
      if (typeof l.dailyCost === 'number' && !fill.includes(`About ${money(l.dailyCost)} ${l.currency} of interest a day`)) out.push(`${at}: daily interest ${l.dailyCost} is not displayed ("${fill}")`);
      if (typeof l.financing?.rate === 'number' && !new RegExp(`Rate ${esc((l.financing.rate * 100).toFixed(3))}% ${l.financing.rateType}`).test(fill)) out.push(`${at}: the rate ${l.financing.rate} is not displayed ("${fill}")`);
      if (l.financing?.maturity && !fill.includes(`to ${l.financing.maturity}`)) out.push(`${at}: the maturity ${l.financing.maturity} is not displayed ("${fill}")`);
      if (l.financing?.referenceRate && !fill.includes(l.financing.referenceRate)) out.push(`${at}: the reference rate ${l.financing.referenceRate} is not displayed ("${fill}")`);
    } else {
      if (!fill.includes(`Principal ${money(l.financing.principal)} ${l.currency}`)) out.push(`${at}: the principal ${l.financing.principal} is not displayed ("${fill}")`);
      const want = l.financing.interest ? `plus interest of ${money(l.financing.interest)} ${l.currency} accrued to today, settled with it` : l.financing.full ? 'no interest is outstanding' : 'a part repayment: interest stays on its schedule';
      if (!fill.includes(want)) out.push(`${at}: expected the dialog to say "${want}"; it says "${fill}"`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The row of an open arrangement, on its owner's page
// ---------------------------------------------------------------------------------------------

/** The open loan, deposit or repo position of a lot (or of an instrument key), from the API. */
async function arrangementOf(t, ctx, { lot, instrument }) {
  const all = (await t.accounting(ctx.bookId, 'positions', { scope: 'book' })).positions.filter((p) => ['loan', 'repo'].includes(p.family));
  const p = instrument && ctx.instruments[instrument] ? all.find((x) => x.instrument.id === ctx.instruments[instrument].id) : all.find((x) => x.strategyId === ctx.lot(lot).strategyId);
  if (!p) throw new Error(`No open loan or deposit for ${instrument ? `instrument "${instrument}"` : `"${lot}"`}.`);
  return p;
}

/**
 * Open the page that lists the arrangement and return the element that carries its buttons.
 * A borrowing is on its owner's page (Account: "Borrowings of this Account"; Treasury: "Treasury's own borrowings");
 * cash lent or on deposit is in Treasury's "Lending, deposits and securities lent" table, whoever owns it.
 */
async function arrangementRow(ui, ctx, p) {
  const { page } = ui;
  await ui.closeOverlays();
  const borrowed = p.qty < 0;
  const account = p.owner.kind === 'account';
  if (borrowed && account) await ui.reloadAt(`#/account/${p.owner.id}`); else await ui.reloadAt('#/treasury/borrowings');
  const panel = ui.section(page.locator('main'), !borrowed ? 'Lending, deposits and securities lent' : account ? 'Borrowings of this Account' : 'Treasury\'s own borrowings');
  const head = panel.locator('tbody tr').filter({ hasText: p.positionId }).first();
  await head.waitFor();
  // A borrowing is drawn on two lines: its figures, then its collateral, schedule and buttons.
  return borrowed ? head.locator('xpath=following-sibling::tr[1]') : head;
}

// ---------------------------------------------------------------------------------------------
// Step actions
// ---------------------------------------------------------------------------------------------

export const actions = {
  async ticket(ui, t, ctx, step, tools) {
    if (!step.ticket) return undefined; // not one of this family's tickets: the shared path (another family's ticket)
    const opened = await ticket(ui, t, ctx, step);
    if (opened.refusal) return opened;
    let raw = null;
    const out = await tools.previewAndConfirm(ui, ctx, opened.preview, { expectsRefusal: tools.expectsRefusal, inspect: async (modal, pv) => { raw = pv; return financingOnScreen(ui, modal, pv); } });
    if (out.strategy) {
      if (step.as && !ctx.lots.has(step.as)) ctx.nameLot(step.as, out.strategy.id, step.instrument);
      await learnContracts(t, ctx, step, raw, out.strategy);
      // The result was read before the new contract had its key: read it again so the leg names its instrument.
      out.result = normalizeResult(out.strategy, raw.token, ctx);
    }
    return out;
  },

  /** Repay (borrowed) or Withdraw (lent). The button previews the whole outstanding amount; a part is typed into the preview and re-checked. */
  async repay(ui, t, ctx, step, tools) {
    const p = await arrangementOf(t, ctx, step);
    const row = await arrangementRow(ui, ctx, p);
    const label = p.family === 'repo' ? (p.qty < 0 ? 'Repurchase' : 'Terminate') : p.qty < 0 ? 'Repay' : 'Withdraw';
    const edit = step.amount === undefined ? undefined : async (modal) => {
      await modal.locator('table.pv-legs tbody tr:not(.group) td[data-label="Quantity"] input').first().fill(String(step.amount));
    };
    return tools.previewAndConfirm(ui, ctx, () => ui.button(row, label).click(), { expectsRefusal: tools.expectsRefusal, edit, inspect: (modal, pv) => financingOnScreen(ui, modal, pv) });
  },

  /** Set rate, on the row of the arrangement. Other instrument lifecycle events are not this family's. */
  async instrument_lifecycle(ui, t, ctx, step) {
    if (step.body?.action !== 'set_rate') return undefined;
    const p = await arrangementOf(t, ctx, { instrument: step.instrument, lot: step.lot });
    const row = await arrangementRow(ui, ctx, p);
    await ui.button(row, 'Set rate').click();
    const dlg = ui.dialog(/^Set the rate on /);
    await dlg.waitFor();
    await ui.input(dlg, 'New rate (decimal a year)').fill(String(step.body.rate));
    const save = ui.button(dlg, 'Set rate');
    if (await save.isDisabled()) {
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message: 'The Set rate button is disabled: the dialog takes a rate as a decimal number.', where: 'Set rate dialog' } };
    }
    const r = await ui.respondsTo('POST', /^\/api\/instruments\/[^/]+\/lifecycle$/, () => save.click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: 'Set rate dialog message' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },

  /** Cash between Treasury and an Account, or between two Accounts, from the Account's own page. */
  async transfer(ui, t, ctx, step) {
    const { page } = ui;
    const fromT = step.from === 'treasury', toT = step.to === 'treasury';
    await ui.closeOverlays();
    await ui.reloadAt(`#/account/${ctx.unitId(fromT ? step.to : step.from)}`);
    await ui.button(page.locator('main .toolbar'), fromT ? 'Fund from Treasury' : toT ? 'Return to Treasury' : 'Transfer to another Account').click();
    const dlg = ui.dialog('Transfer cash');
    await dlg.waitFor();
    const source = ui.select(dlg, 'Source'), dest = ui.select(dlg, 'Destination');
    const chosen = async (sel) => (await sel.locator('option:checked').innerText()).trim();
    if (await chosen(source) !== unitName(ctx, step.from)) throw new Error(`The transfer ticket has Source "${await chosen(source)}", the step is from ${unitName(ctx, step.from)}.`);
    if (!fromT && !toT) await dest.selectOption({ label: unitName(ctx, step.to) });
    if (await chosen(dest) !== unitName(ctx, step.to)) throw new Error(`The transfer ticket has Destination "${await chosen(dest)}", the step is to ${unitName(ctx, step.to)}.`);
    if (!await chooseCurrency(ui, dlg, step.ccy)) {
      const held = await texts(ui.select(dlg, 'Currency').locator('option'));
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message: `${unitName(ctx, step.from)} holds no ${step.ccy} to transfer: the Currency list offers only ${held.join(', ') || 'nothing'}.`, where: 'Transfer cash ticket, Currency' } };
    }
    await ui.input(dlg, 'Amount').fill(String(step.amount));
    if (step.purpose) await ui.input(dlg, 'Purpose').fill(step.purpose);
    const r = await ui.respondsTo('POST', /\/transfers$/, () => ui.button(dlg, 'Record transfer').click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: 'Transfer cash ticket message' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },

  async create_account(ui, t, ctx, step) {
    const { page } = ui;
    await ui.closeOverlays();
    await ui.goto('#/treasury');
    await ui.button(page.locator('nav.rail'), 'New Account').click();
    const dlg = ui.dialog('New Account');
    await ui.input(dlg, 'Account name').fill(step.name);
    const r = await ui.respondsTo('POST', /\/accounts$/, () => ui.button(dlg, 'Create Account').click());
    if (!r.ok) return { refusal: { message: r.body?.error, status: r.status, where: 'New Account dialog' } };
    await dlg.waitFor({ state: 'hidden' });
    ctx.extraUnits.set(step.as, { id: r.body.id, name: step.name });
    return {};
  },

  /** External capital into or out of Treasury. */
  async deposit(ui, t, ctx, step) {
    const { page } = ui;
    await ui.closeOverlays();
    await ui.reloadAt('#/treasury');
    await ui.button(page.locator('main'), 'Deposit or withdraw').first().click();
    const dlg = ui.dialog('Deposit or withdraw capital');
    await dlg.waitFor();
    await ui.option(dlg, 'Movement', step.withdraw ? 'Withdraw from Treasury' : 'Deposit into Treasury').click();
    await ui.input(dlg, 'Currency').fill(step.ccy);
    await ui.input(dlg, 'Amount').fill(String(step.amount));
    if (step.note) await ui.input(dlg, 'Note').fill(step.note);
    const r = await ui.respondsTo('POST', /\/capital$/, () => ui.button(dlg, step.withdraw ? 'Record withdrawal' : 'Record deposit').click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: 'Deposit or withdraw capital message' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },
};

// ---------------------------------------------------------------------------------------------
// Reading the Treasury page, the Account pages and the Book balance sheet
// ---------------------------------------------------------------------------------------------

const lines = (cell) => String(cell ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const startsWith = (s) => new RegExp(`^\\s*${esc(s)}`);
const tableOf = (tables, title) => tables.find((x) => startsWith(title).test(x.title) && x.rows.length) || null;
const col = (tb, name) => tb.head.findIndex((h) => startsWith(name).test(h.replace(/\s+/g, ' ')));

/** A borrowing table of the Treasury or Account page: each record is two rows, its figures and then its terms and buttons. */
function borrowingRows(tb) {
  if (!tb) return [];
  const out = [];
  const c = (r, name) => r.cells[col(tb, name)] || '';
  tb.rows.forEach((r, i) => {
    if (r.cells.length < 5) return;
    const second = (tb.rows[i + 1]?.cells.length === 1 ? tb.rows[i + 1].cells[0] : '').replace(/\s+/g, ' ');
    const id = lines(c(r, 'Borrowing ID')), owner = lines(c(r, 'Owner')), principal = lines(c(r, 'Principal')), rate = lines(c(r, 'Rate')), maturity = lines(c(r, 'Maturity')), cost = lines(c(r, 'Interest and fees'));
    out.push({
      id: id[0], name: id[1] || '', owner: owner[0], origin: owner[1] || '', type: c(r, 'Type').replace(/\s+/g, ' '), lender: c(r, 'Lender').replace(/\s+/g, ' '), ccy: c(r, 'Currency').trim(),
      principal: shown(principal[0]), principalRc: principal[1] ? shown(principal[1]) : null, rateText: rate[0] || '', dayCount: rate[1] || '', noFixing: /no fixing since (\d{4}-\d{2}-\d{2})/.exec(rate.join(' '))?.[1] || null,
      maturity: /^\d{4}-\d{2}-\d{2}$/.test(maturity[0] || '') ? maturity[0] : null, term: maturity[1] || maturity[0] || '', accrued: shown(c(r, 'Accrued')), interest: shown(cost[0]), fees: shown((cost[1] || '').replace(/^fees/, '')),
      collateral: /Collateral (.*?) Payment schedule/.exec(second)?.[1] || '', schedule: /Payment schedule (.*?)\. (Next payment|No payment is scheduled)/.exec(second)?.[1] || '',
      nextDate: /Next payment (\d{4}-\d{2}-\d{2})/.exec(second)?.[1] || null, blocked: /\bblocked\b/.test(second), buttons: second,
    });
  });
  return out;
}

/** A "by currency" table whose first column names the lines and whose other columns are currencies (the cash tables). */
function byCurrency(tb) {
  const out = {};
  if (!tb) return out;
  tb.head.slice(1).forEach((ccy, i) => {
    if (!/^[A-Z]{3}$/.test(ccy)) return;
    out[ccy] = Object.fromEntries(tb.rows.filter((r) => !r.group).map((r) => [r.cells[0].trim(), shown(r.cells[i + 1])]));
  });
  return out;
}

const CASH_LINES = { settled: 'Settled', availableToTrade: 'Available to trade', availableToWithdraw: 'Available to withdraw', reserved: 'Reserved', restricted: 'Restricted', margin: 'Margin posted', borrowed: 'Cash borrowed', lent: 'Cash lent' };
const SHEET_LINES = { cash: 'Settled cash', restricted: 'Restricted cash', receivable: 'Receivable for unsettled trades', accruedIncome: 'Accrued income', positions: 'Positions at market value', lent: 'Cash lent', payable: 'Payable for unsettled trades', accruedExpense: 'Accrued interest and fees payable', borrowed: 'Cash borrowed', assets: 'Total assets', liabilities: 'Total liabilities', netAssets: 'Net assets', capital: 'External capital contributed', internal: 'Funding between Treasury and Accounts' };

/**
 * After every step: the Treasury page (Borrowings and lending, then its cash), each Account's page and the Book
 * balance sheet, against the API (a display error) and against the spec (the hand-worked figures).
 */
export async function screens(ui, ctx, t, { expected, state }) {
  const { page } = ui;
  const main = page.locator('main');
  const out = [];
  const api = (m) => out.push(`screen vs API: ${m}`);
  const spec = (m) => out.push(`spec vs screen: ${m}`);
  // A figure the API has must be displayed as that figure; one it does not have must not be displayed as an amount.
  const num = (say, what, want, s) => {
    if (want === undefined) return;
    compared++;
    if (want === null || want === 0) { if (s && s.value !== null && Math.abs(s.value) > 0.004) say(`${what} shows "${s.text}", expected ${want === null ? 'nothing' : 0}`); return; }
    if (!s || !numbersAgree(want, s)) say(`${what} shows "${s?.text ?? 'nothing'}", expected ${want}`);
  };
  let compared = 0;

  const [reg, tre] = await Promise.all([t.accounting(ctx.bookId, 'borrowings', { scope: 'book' }), t.http.get(`/api/books/${ctx.bookId}/treasury`)]);
  const units = [['treasury', ctx.treasuryId, 'Treasury'], ['account', ctx.accountId, ctx.spec.book.account.name], ...[...ctx.extraUnits].map(([k, u]) => [k, u.id, u.name])];
  const rc = ctx.spec.book.reportingCcy;

  // ---- 1. Treasury, Borrowings and lending ---------------------------------------------------------------
  await ui.reloadAt('#/treasury/borrowings');
  await ui.section(main, 'Treasury\'s own borrowings').waitFor();
  await ui.section(main, 'Lending, deposits and securities lent').waitFor();
  await ui.drawn();
  let tables = await ui.tables(main);
  const own = borrowingRows(tableOf(tables, 'Treasury\'s own borrowings'));
  const acct = borrowingRows(tableOf(tables, 'Account-originated borrowings'));
  const rowOf = new Map();
  const checkRecord = (b, rows, where, others) => {
    const r = rows.find((x) => x.id === b.id);
    if (others.some((x) => x.id === b.id)) api(`borrowing ${b.id} of ${b.owner.name} is also listed under ${where === 'Treasury\'s own borrowings' ? 'Account-originated borrowings' : 'Treasury\'s own borrowings'}: it must be one record in one table`);
    if (!r) { api(`borrowing ${b.id} of ${b.owner.name} is not listed under ${where} (rows: ${rows.map((x) => x.id).join(', ') || 'none'})`); return; }
    rowOf.set(b.id, r);
    const at = `${where}, ${b.id}`;
    if (r.owner !== b.owner.name) api(`${at}: owner shows "${r.owner}", the API has ${b.owner.name}`);
    if (r.origin !== (b.accountOriginated ? 'Account-originated' : 'Treasury\'s own')) api(`${at}: labelled "${r.origin}"`);
    if (r.ccy !== b.ccy) api(`${at}: currency shows ${r.ccy}, the API has ${b.ccy}`);
    if (b.principal !== null) num(api, `${at} principal`, b.principal, r.principal);
    if (b.principal !== null && b.ccy !== rc) num(api, `${at} principal in ${rc}`, b.principalRc, r.principalRc);
    num(api, `${at} accrued`, b.accrued, r.accrued);
    num(api, `${at} interest to date`, b.interestToDate, r.interest);
    num(api, `${at} fees to date`, b.feesToDate, r.fees);
    if (b.rate.text && r.rateText !== b.rate.text) api(`${at}: rate shows "${r.rateText}", the API has "${b.rate.text}"`);
    if (b.rate.dayCount && r.dayCount !== b.rate.dayCount) api(`${at}: day count shows "${r.dayCount}", the API has ${b.rate.dayCount}`);
    if ((b.maturity || null) !== r.maturity) api(`${at}: maturity shows ${r.maturity || `"${r.term}"`}, the API has ${b.maturity || 'none'}`);
    if (!b.maturity && r.term !== b.term) api(`${at}: term shows "${r.term}", the API has "${b.term}"`);
    if ((b.schedule.next?.date || null) !== r.nextDate) api(`${at}: next payment shows ${r.nextDate || 'none'}, the API has ${b.schedule.next?.date || 'none'}`);
    if (Boolean(b.schedule.next?.blocked) !== r.blocked) api(`${at}: the next payment is ${r.blocked ? '' : 'not '}shown as blocked; the API says ${b.schedule.next?.blocked ? 'blocked' : 'not blocked'}`);
    if (r.schedule !== b.schedule.interest) api(`${at}: payment schedule shows "${r.schedule}", the API has "${b.schedule.interest}"`);
    if (b.family === 'loan' && !/Set rate\s+Repay/.test(r.buttons)) api(`${at}: the row does not offer Set rate and Repay`);
  };
  for (const b of tre.borrowings.direct) checkRecord(b, own, 'Treasury\'s own borrowings', acct);
  for (const b of tre.borrowings.accountOriginated) checkRecord(b, acct, 'Account-originated borrowings', own);
  if (own.length !== tre.borrowings.direct.length) api(`Treasury's own borrowings lists ${own.length} records; the API has ${tre.borrowings.direct.length}`);
  if (acct.length !== tre.borrowings.accountOriginated.length) api(`Account-originated borrowings lists ${acct.length} records; the API has ${tre.borrowings.accountOriginated.length}`);
  // One register: Treasury's two tables together are exactly the Book's borrowing records, each once.
  const ids = [...own, ...acct].map((x) => x.id).sort().join(','), want = reg.items.map((b) => b.id).sort().join(',');
  if (ids !== want) api(`the two borrowing tables list ${ids || 'nothing'}; the Book's register is ${want || 'empty'}`);

  // The Book totals, stated once, by currency: they must be the ledger's "Cash borrowed" of the consolidated Book.
  const totals = tableOf(tables, 'External borrowing of the Book, by currency');
  const cash = reg.items.filter((b) => b.principal !== null);
  for (const ccy of new Set(cash.map((b) => b.ccy))) {
    const r = totals?.rows.find((x) => x.cells[0].trim() === ccy);
    if (!r) { api(`the Book totals have no ${ccy} row`); continue; }
    const cell = (name) => shown(r.cells[col(totals, name)]);
    const sum = (list, pick) => list.filter((b) => b.ccy === ccy).reduce((a, b) => a + pick(b), 0);
    num(api, `Book totals ${ccy}, Treasury's own principal`, sum(cash.filter((b) => !b.accountOriginated), (b) => b.principal), cell('Treasury\'s own principal'));
    num(api, `Book totals ${ccy}, Account-originated principal`, sum(cash.filter((b) => b.accountOriginated), (b) => b.principal), cell('Account-originated principal'));
    num(api, `Book totals ${ccy}, consolidated principal against the Book's ledger`, state.balance.book.local[ccy]?.borrowed ?? 0, cell('Book, consolidated'));
    num(api, `Book totals ${ccy}, accrued`, sum(reg.items, (b) => b.accrued), cell('Accrued, unpaid'));
    num(api, `Book totals ${ccy}, interest to date`, sum(reg.items, (b) => b.interestToDate), cell('Interest to date'));
  }
  if (!cash.length && totals) api('the Book totals table is shown although nothing is borrowed');

  // Cash lent and deposits: one row per arrangement, with its owner, principal and accrued interest receivable.
  const lendTable = tableOf(tables, 'Lending, deposits and securities lent');
  const lendRows = (lendTable?.rows || []).map((r) => ({ id: /POS-[0-9A-F]+/.exec(r.cells[col(lendTable, 'Arrangement')])?.[0], name: lines(r.cells[col(lendTable, 'Arrangement')])[0], owner: r.cells[col(lendTable, 'Owner')].trim(), principal: shown(r.cells[col(lendTable, 'Principal or quantity')]), terms: r.cells[col(lendTable, 'Terms')].replace(/\s+/g, ' '), accrued: shown(lines(r.cells[col(lendTable, 'Accrued')])[0]), buttons: r.cells[r.cells.length - 1].replace(/\s+/g, ' ') }));
  const lent = tre.arrangements.filter((a) => a.family === 'loan' && a.qty > 0);
  for (const a of lent) {
    const r = lendRows.find((x) => x.id === a.positionId);
    if (!r) { api(`${a.name} (${a.positionId}) is not in the lending table`); continue; }
    rowOf.set(a.positionId, r);
    const at = `lending table, ${a.name}`;
    if (r.owner !== (a.owner.kind === 'treasury' ? 'Treasury' : a.owner.name)) api(`${at}: owner shows "${r.owner}"`);
    num(api, `${at} principal`, a.qty, r.principal);
    num(api, `${at} accrued`, a.accrued, r.accrued);
    if (!/Set rate\s+Withdraw/.test(r.buttons)) api(`${at}: the row does not offer Set rate and Withdraw`);
  }
  if (lendRows.length !== tre.arrangements.filter((a) => (a.family === 'secloan' ? a.qty < 0 : a.qty > 0)).length) api(`the lending table lists ${lendRows.length} rows; the API has ${tre.arrangements.filter((a) => (a.family === 'secloan' ? a.qty < 0 : a.qty > 0)).length}`);

  // The spec's register figures against the rows on screen.
  if (Array.isArray(expected.borrowings) && expected.borrowings.length === reg.items.length) {
    for (const e of expected.borrowings) {
      const b = reg.items.find((x) => ctx.lotOf(x.strategy?.id) === e.lot && (e.ccy === undefined || x.ccy === e.ccy)) || (reg.items.length === 1 ? reg.items[0] : null);
      const r = b && rowOf.get(b.id);
      if (!r) { if (e.family === undefined || e.family === 'loan') spec(`the borrowing "${e.lot}" was not found on the Treasury page`); continue; }
      const at = `Treasury page, borrowing "${e.lot}"`;
      if (e.principal !== undefined && e.principal !== null) num(spec, `${at} principal`, e.principal, r.principal);
      num(spec, `${at} accrued`, e.accrued, r.accrued);
      num(spec, `${at} interest to date`, e.costToDate, r.interest);
      num(spec, `${at} fees to date`, e.feesToDate, r.fees);
      if (e.principalRc !== undefined && b.ccy !== rc) num(spec, `${at} principal in ${rc}`, e.principalRc, r.principalRc);
      if (e.rateText !== undefined && r.rateText !== e.rateText) spec(`${at}: rate shows "${r.rateText}", expected "${e.rateText}"`);
      if (e.dayCount !== undefined && r.dayCount !== e.dayCount) spec(`${at}: day count shows "${r.dayCount}", expected ${e.dayCount}`);
      if (e.maturity !== undefined && (e.maturity || null) !== r.maturity) spec(`${at}: maturity shows ${r.maturity || 'none'}, expected ${e.maturity || 'none'}`);
      if (e.nextPayment !== undefined && (e.nextPayment || null) !== r.nextDate) spec(`${at}: next payment shows ${r.nextDate || 'none'}, expected ${e.nextPayment || 'none'}`);
      if (e.origin !== undefined && r.origin !== (e.origin === 'account' ? 'Account-originated' : 'Treasury\'s own')) spec(`${at}: labelled "${r.origin}", expected ${e.origin === 'account' ? 'Account-originated' : 'Treasury\'s own'}`);
      if (e.blocked !== undefined && Boolean(e.blocked) !== r.blocked) spec(`${at}: the next payment is ${r.blocked ? '' : 'not '}shown as blocked`);
    }
  }
  // ... and its deposits and cash lent against the lending rows.
  for (const e of (expected.positions || []).filter((x) => x.direction === 'lent' && ctx.instruments[x.instrument])) {
    const a = lent.find((x) => x.instrument.id === ctx.instruments[e.instrument].id);
    const r = a && rowOf.get(a.positionId);
    if (!r) { spec(`the deposit or loan "${e.instrument}" was not found in the lending table`); continue; }
    num(spec, `lending table, "${e.instrument}" principal`, e.qty, r.principal);
    num(spec, `lending table, "${e.instrument}" accrued`, e.accrued, r.accrued);
  }

  // ---- 2. Treasury's own cash, and the Accounts it oversees -------------------------------------------------
  await ui.goto('#/treasury');
  await ui.section(main, 'Treasury cash by currency').waitFor();
  await ui.section(main, 'Accounts').locator('table').first().waitFor();
  await ui.drawn();
  tables = await ui.tables(main);
  const cashCheck = (key, screen, where) => {
    for (const [ccy, c] of Object.entries(state.cash[key] || {})) {
      const s = screen[ccy];
      if (!s) { if (Object.values(c).some((x) => x !== 0)) api(`${where}: no ${ccy} column`); continue; }
      for (const [k, label] of Object.entries(CASH_LINES)) num(api, `${where} ${ccy}, ${label}`, c[k], s[label]);
      for (const [k, label] of Object.entries(CASH_LINES)) num(spec, `${where} ${ccy}, ${label}`, expected.cash?.[key]?.[ccy]?.[k], s[label]);
    }
  };
  cashCheck('treasury', byCurrency(tableOf(tables, 'Treasury cash by currency')), 'Treasury cash');
  const accounts = tableOf(tables, 'Accounts');
  for (const [key, id, name] of units.slice(1)) {
    const r = accounts?.rows.find((x) => lines(x.cells[0])[0] === name);
    if (!r) { api(`the Accounts table of the Treasury page has no row for ${name}`); continue; }
    const borrowed = lines(r.cells[col(accounts, 'Borrowed by the Account')]);
    const mine = reg.items.filter((b) => b.owner.id === id && b.principal !== null);
    for (const ccy of new Set(mine.map((b) => b.ccy))) {
      const line = borrowed.find((x) => x.endsWith(ccy));
      num(api, `Treasury page, Accounts, ${name}: borrowed by the Account in ${ccy}`, mine.filter((b) => b.ccy === ccy).reduce((a, b) => a + b.principal, 0), line ? shown(line) : null);
    }
    if (!mine.length && borrowed.some((x) => /\d/.test(x))) api(`Treasury page, Accounts, ${name}: shows "${borrowed.join(' ')}" borrowed; the API has nothing`);
    num(api, `Treasury page, Accounts, ${name}: NAV`, key === 'account' ? state.nav.account : undefined, shown(r.cells[col(accounts, 'NAV')]));
  }
  const stat = async (label) => (await main.locator('.stat').filter({ has: page.locator('.k', { hasText: startsWith(label) }) }).first().locator('.v').innerText()).trim();
  const principalRc = (list) => (list.some((b) => b.principalRc === null) ? null : list.reduce((a, b) => a + b.principalRc, 0));
  const ownCash = tre.borrowings.direct.filter((b) => b.principal !== null), acctCash = tre.borrowings.accountOriginated.filter((b) => b.principal !== null);
  const ownStat = await stat('Treasury\'s own borrowings'), acctStat = await stat('Account-originated borrowings');
  if (ownCash.length ? !numbersAgree(principalRc(ownCash), shown(ownStat)) : ownStat !== 'None') api(`the "Treasury's own borrowings" figure shows "${ownStat}"; the API has ${ownCash.length ? principalRc(ownCash) : 'none'}`);
  if (acctCash.length ? !numbersAgree(principalRc(acctCash), shown(acctStat)) : acctStat !== 'None') api(`the "Account-originated borrowings" figure shows "${acctStat}"; the API has ${acctCash.length ? principalRc(acctCash) : 'none'}`);
  num(api, 'Treasury page, Treasury NAV', state.nav.treasury, shown(await stat('Treasury NAV')));
  num(api, 'Treasury page, Book NAV', state.nav.book, shown(await stat('Book NAV')));
  num(spec, 'Treasury page, Treasury NAV', expected.nav?.treasury, shown(await stat('Treasury NAV')));
  num(spec, 'Treasury page, Book NAV', expected.nav?.book, shown(await stat('Book NAV')));

  // ---- 3. Each Account's own page: the same records, on the balance sheet of the Account that owes them ------------
  for (const [key, id, name] of units.slice(1)) {
    await ui.goto(`#/account/${id}`);
    await main.locator('h1', { hasText: exactly(name) }).waitFor();
    await ui.section(main, 'Borrowings of this Account').waitFor();
    await ui.section(main, 'Balance sheet').waitFor();
    await ui.drawn();
    tables = await ui.tables(main);
    const rows = borrowingRows(tableOf(tables, 'Borrowings of this Account'));
    const mine = reg.items.filter((b) => b.owner.id === id);
    if (rows.map((x) => x.id).sort().join(',') !== mine.map((b) => b.id).sort().join(',')) api(`${name}'s page lists borrowings ${rows.map((x) => x.id).join(', ') || 'none'}; the API has ${mine.map((b) => b.id).join(', ') || 'none'}`);
    for (const r of rows) {
      // The same record, the same ID and the same figures as in Treasury's oversight table.
      const o = acct.find((x) => x.id === r.id);
      if (!o) { api(`${name}'s borrowing ${r.id} is not in Treasury's Account-originated table`); continue; }
      for (const k of ['principal', 'accrued', 'interest']) if (r[k].text !== o[k].text) api(`${name}'s borrowing ${r.id}: ${k} shows "${r[k].text}" on the Account page and "${o[k].text}" in Treasury's oversight`);
      if (r.origin !== 'Account-originated') api(`${name}'s borrowing ${r.id} is labelled "${r.origin}" on the Account page`);
    }
    if (key === 'account' || state.cash[key]) cashCheck(key, byCurrency(tableOf(tables, 'Cash by currency')), `${name}'s cash`);
    if (key === 'account') {
      const sheet = tableOf(tables, 'Balance sheet');
      const lineOf = (label) => { const r = sheet?.rows.find((x) => !x.group && x.cells[0].trim() === label); return r ? shown(r.cells[r.cells.length - 1]) : null; };
      for (const k of ['cash', 'lent', 'accruedIncome', 'accruedExpense', 'borrowed', 'assets', 'liabilities', 'netAssets']) {
        num(api, `${name}'s page, balance sheet, ${SHEET_LINES[k]}`, state.balance.account[k] ?? null, lineOf(SHEET_LINES[k]));
        num(spec, `${name}'s page, balance sheet, ${SHEET_LINES[k]}`, expected.balance?.account?.[k], lineOf(SHEET_LINES[k]));
      }
      const cashMine = mine.filter((b) => b.principal !== null);
      const owed = await stat('Borrowed by this Account');
      if (cashMine.length ? !numbersAgree(principalRc(cashMine), shown(owed)) : owed !== 'None') api(`${name}'s page shows "${owed}" borrowed by this Account; the API has ${cashMine.length ? principalRc(cashMine) : 'none'}`);
    }
  }

  // ---- 4. The Book, consolidated: every borrowing once, internal funding eliminated -----------------------------
  await ui.goto('#/accounting/balance/book');
  await main.locator('header h3, header h2', { hasText: /^Balance sheet of the whole Book/ }).first().waitFor();
  await ui.drawn();
  tables = await ui.tables(main);
  const sheets = tables.filter((x) => /^Balance sheet of the whole Book/.test(x.title));
  const head = sheets.find((x) => x.head.length)?.head || [];
  const body = sheets.find((x) => x.rows.length)?.rows.filter((r) => !r.group) || [];
  const column = (name) => head.findIndex((h) => h.replace(/\s+/g, ' ').trim() === name);
  // A line is found by its label; with a foreign currency in play the label is followed by a "show currencies" control.
  const labelled = (x, label) => lines(x.cells[0])[0] === label || lines(x.cells[0])[0].startsWith(`${label} `);
  const sheetCell = (label, name) => { const r = body.find((x) => labelled(x, label)); const i = column(name); return r && i >= 0 ? shown(r.cells[i]) : null; };
  if (process.env.SDT_LOAN_DEBUG === '2') console.log(JSON.stringify({ head, body: body.slice(0, 6), titles: tables.map((x) => [x.title, x.head.length, x.rows.length]) }, null, 1));
  if (column('Whole Book') < 0 || column('Treasury') < 0) api(`the Book balance sheet has columns ${head.join(' | ')}: Treasury and Whole Book are expected`);
  else {
    for (const [k, label] of Object.entries(SHEET_LINES)) {
      num(api, `Book balance sheet, ${label}, Whole Book`, state.balance.book[k] ?? null, sheetCell(label, 'Whole Book'));
      num(api, `Book balance sheet, ${label}, Treasury`, state.balance.treasury[k] ?? null, sheetCell(label, 'Treasury'));
      num(spec, `Book balance sheet, ${label}, Whole Book`, expected.balance?.book?.[k], sheetCell(label, 'Whole Book'));
      num(spec, `Book balance sheet, ${label}, Treasury`, expected.balance?.treasury?.[k], sheetCell(label, 'Treasury'));
      if (column(ctx.spec.book.account.name) >= 0) num(api, `Book balance sheet, ${label}, ${ctx.spec.book.account.name}`, state.balance.account[k] ?? null, sheetCell(label, ctx.spec.book.account.name));
    }
    // Internal funding is shown in each column and eliminated in the total.
    const funding = body.find((x) => labelled(x, SHEET_LINES.internal));
    if (funding && state.balance.treasury.internal && !/eliminated/.test(funding.cells[column('Eliminations')] || '')) api('the Book balance sheet does not show internal funding as eliminated');
  }
  const record = tables.find((x) => /^Borrowings/.test(x.title) && x.head.some((h) => /^Record/.test(h)));
  const listed = (record?.rows || []).map((r) => lines(r.cells[0])[0]).sort().join(',');
  if (listed !== want) api(`the Book balance sheet lists borrowings ${listed || 'none'}; the register is ${want || 'empty'}: each must be there exactly once`);

  // ---- 5. Treasury's own scheduled payments (the shared reader looks at the Account's only) ------------------------
  await ui.goto(`#/accounting/pending/${ctx.treasuryId}`);
  await main.locator('header h3, header h2', { hasText: /^Executed trades/ }).first().waitFor();
  await ui.drawn();
  tables = await ui.tables(main);
  const life = tableOf(tables, 'Lifecycle items');
  const due = (life?.rows || []).filter((r) => !r.group).map((r) => lines(r.cells[col(life, 'Due')])[0]).sort();
  const mineDue = state.lifecycle.filter((x) => x.owner === 'treasury').map((x) => x.dueDate).sort();
  if (due.join(',') !== mineDue.join(',')) api(`Treasury's pending lifecycle items are due ${due.join(', ') || 'never (none shown)'}; the API has ${mineDue.join(', ') || 'none'}`);
  const wantDue = (expected.lifecycle || []).filter((x) => x.owner === 'treasury').map((x) => x.dueDate).sort();
  if (Array.isArray(expected.lifecycle) && wantDue.join(',') !== due.join(',')) spec(`Treasury's pending lifecycle items are due ${due.join(', ') || 'never (none shown)'}; expected ${wantDue.join(', ') || 'none'}`);

  if (process.env.SDT_LOAN_DEBUG) console.log(`    loan screens: ${compared} figures compared, ${own.length} own and ${acct.length} Account-originated borrowing rows, ${lendRows.length} lending rows, ${out.length} mismatches`, JSON.stringify(acct[0] || own[0] || lendRows[0] || null));
  return out;
}
