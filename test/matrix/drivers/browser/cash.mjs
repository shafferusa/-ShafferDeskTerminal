// Browser driver for the cash family (currency balances held as ledger cash in Treasury and each Account).
//
// A currency balance is not a registry instrument (the registration form refuses product "currency" and says why).
// What a user does with currency balances happens on the Treasury and Account pages:
//   deposit            Treasury, "Deposit or withdraw" (Deposit into Treasury / Withdraw from Treasury)
//   transfer           Treasury, "Transfer cash" (shared path in ../browser.mjs): the same currency leaves and arrives
//   ticket (convert)   "Convert currency" on the Treasury page or an Account page: a spot FX trade in a registered
//                      pair, through the trade preview (the loan driver's convert ticket, reused)

import { ticket as loanTicket } from './loan.mjs';

export const family = 'cash';

/** Never reached for a refused registration (the form refuses before any contract field); kept for the interface. */
export async function contractTerms() {
  throw new Error('A currency balance is held as ledger cash; it has no registration form.');
}

/** Convert currency: step.ticket = { kind: 'convert', page: 'account' | 'treasury', pair, action: 'sell' | 'buy', qty }. */
export const ticket = (ui, t, ctx, step) => loanTicket(ui, t, ctx, step);

export const actions = {
  /** Deposit or withdraw capital in Treasury. */
  async deposit(ui, t, ctx, step) {
    const { page } = ui;
    await ui.closeOverlays();
    await ui.reloadAt('#/treasury');
    await ui.button(page.locator('main'), 'Deposit or withdraw').first().click();
    const dlg = ui.dialog('Deposit or withdraw capital');
    await dlg.waitFor();
    if (step.withdraw) await ui.option(dlg, 'Movement', 'Withdraw from Treasury').click();
    await ui.input(dlg, 'Currency').fill(step.ccy);
    await ui.input(dlg, 'Amount').fill(String(step.amount));
    if (step.note) await ui.input(dlg, 'Note').fill(step.note);
    const r = await ui.respondsTo('POST', /\/capital$/, () => ui.button(dlg, step.withdraw ? 'Record withdrawal' : 'Record deposit').click());
    if (!r.ok) {
      await dlg.locator('.notice.err').first().waitFor();
      return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: 'Deposit or withdraw capital dialog message' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },
};
