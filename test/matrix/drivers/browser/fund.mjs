// Browser driver for the fund family (mutual funds, money-market funds).
//
// A fund is registered with the equity-like contract fields (Lot size, Settlement lag) and is subscribed and
// redeemed on the security ticket of the instrument drawer (Buy, Sell), so this file reuses equity.mjs for both.
// What is particular to a fund happens after the ticket: the order waits for the NAV of its dealing date, which the
// shared preview, strategy and Accounting readers show (no estimated fill price; the working order with its reason).

import * as equity from './equity.mjs';

export const family = 'fund';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };

/**
 * An open-ended fund is not exchange-listed (it deals through its transfer agent), so the form asks for the Primary
 * view; then the equity-like fields (Lot size, Settlement lag).
 */
export async function contractTerms(ui, dialog, draft, ctx) {
  if (draft.venueType === 'otc') await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await equity.contractTerms(ui, dialog, draft, ctx);
}

/** The security ticket in the instrument drawer: Buy subscribes, Sell redeems. */
export const ticket = equity.ticket;
