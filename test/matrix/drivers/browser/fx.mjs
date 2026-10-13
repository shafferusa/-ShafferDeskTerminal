// Browser driver for the fx family (spot currency pairs): the minimum.
//
// Written for the loan scenarios (cash_loan), which register a EUR/USD pair and convert through the Convert currency
// and Borrow and convert tickets of the Treasury and Account pages (drivers/browser/loan.mjs); extended for the fx
// family's own scenarios (specs/fx.mjs) with the pair's ticket in the instrument drawer. Keep contractTerms working
// for the loan scenarios.

export const family = 'fx';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };

/** A pair's contract terms: base and quote currency, spot settlement lag. An OTC pair with no venue asks for its Primary view. */
export async function contractTerms(ui, dialog, draft) {
  if (await ui.field(dialog, /^\s*Primary view/).count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await ui.input(dialog, 'Base currency').fill(draft.terms.base);
  await ui.input(dialog, 'Quote currency').fill(draft.terms.quote);
  if (draft.terms.settleDays !== undefined && draft.terms.settleDays !== null) await ui.input(dialog, 'Spot settlement lag').fill(String(draft.terms.settleDays));
}

/**
 * The pair's own ticket in the instrument drawer (Trade tab): trading owner, "Buy <base>" or "Sell <base>", the
 * base-currency amount, optional order terms. A conversion entered on the Convert currency dialog of the Treasury
 * or an Account page is the same trade; scenarios that use that dialog borrow the loan driver's ticket.
 */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
  await ui.chooseOwner(drawer, owner);
  const label = `${step.side === 'buy' ? 'Buy' : 'Sell'} ${inst.terms.base}`;
  const action = ui.option(drawer, 'Action', label);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${label}" for ${inst.symbol || inst.name}.`, where: 'ticket, Action' } };
  await action.click();
  await ui.input(drawer, inst.qtyLabel).fill(String(step.qty));
  const o = step.order || {};
  if (o.statedPrice !== undefined && o.statedPrice !== null) await ui.input(drawer, 'State a fill price').fill(String(o.statedPrice));
  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) {
    const notices = (await drawer.locator('.notice').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
    return { refusal: { message: notices.join(' | ') || 'The Preview button is disabled and the ticket gives no reason.', where: 'ticket, Preview disabled' } };
  }
  return { preview: () => preview.click() };
}
