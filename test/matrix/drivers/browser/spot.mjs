// Browser driver for the spot-asset family (physical commodities, metals, energy and the like): the minimum.
//
// A spot asset is security-like. Its registration form has the contract fields of an equity (Lot size,
// Settlement lag) and a Multiplier, and it is traded on the security ticket of the instrument drawer, so
// this file reuses equity.mjs for both. It was written for the swap scenarios, which register a published
// index (a consumer price index) as a stand-in spot asset because the catalog has no product for a
// reference index, and never trade it. Whoever tests the spot family itself extends this file.

import * as equity from './equity.mjs';

export const family = 'spot';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };

/**
 * Lot size and Settlement lag as for an equity, and the Multiplier the form shows for a spot asset. An asset that
 * is not listed on a venue has no venue to decide its market view: the form then asks for the Primary view.
 */
export async function contractTerms(ui, dialog, draft, ctx) {
  if (await ui.field(dialog, /^\s*Primary view/).count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await equity.contractTerms(ui, dialog, draft, ctx);
  if (draft.multiplier !== undefined && draft.multiplier !== null) await ui.input(dialog, 'Multiplier').fill(String(draft.multiplier));
}

/** The security ticket in the instrument drawer. */
export const ticket = equity.ticket;
