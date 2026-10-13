// Browser driver for the spot-asset family (environmental certificates, physical commodities, metals, energy).
//
// A spot asset is security-like: its registration form has the equity-like contract fields (Lot size, Settlement
// lag), a Multiplier, and its own units (Quantity unit, Quoted in); it is traded on the security ticket of the
// instrument drawer (Buy, Sell; no Sell short), so this file reuses equity.mjs for the ticket and adds what is
// particular to a spot asset:
//   - the Primary view, when the asset is not exchange-listed (the form asks for it);
//   - the asset's units and multiplier on the registration form;
//   - a settlement stated on the ticket for one trade (`order.settle`: { lag } or { date }), as for an OTC delivery
//     through a registry.
// Events recorded by hand (storage, insurance, delivery costs as manual cash flows; a retirement or a surrender as
// a sale at a stated price of 0) go through the shared paths and the same ticket.
// It was first written for the swap scenarios, which register a published index (a consumer price index) as a
// stand-in spot asset and never trade it; contractTerms keeps working for them.

import * as equity from './equity.mjs';

export const family = 'spot';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };

/** Primary view (when asked), Lot size and Settlement lag as for an equity, the Multiplier, and the asset's units. */
export async function contractTerms(ui, dialog, draft, ctx) {
  if (await ui.field(dialog, /^\s*Primary view/).count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await equity.contractTerms(ui, dialog, draft, ctx);
  if (draft.multiplier !== undefined && draft.multiplier !== null) await ui.input(dialog, 'Multiplier').fill(String(draft.multiplier));
  if (draft.terms?.quantityUnit) await ui.input(dialog, 'Quantity unit').fill(draft.terms.quantityUnit);
  if (draft.terms?.priceUnits) await ui.input(dialog, 'Quoted in').fill(draft.terms.priceUnits);
}

/** The security ticket in the instrument drawer, with a settlement stated for this trade when the step says so. */
export async function ticket(ui, t, ctx, step) {
  const out = await equity.ticket(ui, t, ctx, step);
  const s = step.order?.settle;
  if (out.refusal || !s) return out;
  const { page } = ui;
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^Trade/ }) });
  const field = ui.field(drawer, 'Settlement');
  await field.locator('select').first().selectOption({ label: s.date ? 'State a settlement date' : 'State a lag in business days' });
  await ui.drawn();
  await field.locator('input').first().fill(String(s.date ?? s.lag));
  await ui.drawn();
  return out;
}
