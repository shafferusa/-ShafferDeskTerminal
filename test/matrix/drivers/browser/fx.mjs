// Browser driver for the fx family (spot currency pairs): the minimum.
//
// Written for the loan scenarios (cash_loan), which register a EUR/USD pair to borrow and convert through and never
// trade it from the instrument drawer: conversions go through the Convert currency and Borrow and convert tickets of
// the Treasury and Account pages (drivers/browser/loan.mjs). Whoever tests the fx family itself extends this file
// (its own ticket); keep contractTerms working for the loan scenarios.

export const family = 'fx';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };

/** A pair's contract terms: base and quote currency, spot settlement lag. An OTC pair with no venue asks for its Primary view. */
export async function contractTerms(ui, dialog, draft) {
  if (await ui.field(dialog, /^\s*Primary view/).count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await ui.input(dialog, 'Base currency').fill(draft.terms.base);
  await ui.input(dialog, 'Quote currency').fill(draft.terms.quote);
  if (draft.terms.settleDays !== undefined && draft.terms.settleDays !== null) await ui.input(dialog, 'Spot settlement lag').fill(String(draft.terms.settleDays));
}

export async function ticket(ui, t, ctx, step) {
  throw new Error(`Step "${step.id}": the fx driver has no instrument ticket yet (conversions are entered on the loan driver's convert tickets).`);
}
