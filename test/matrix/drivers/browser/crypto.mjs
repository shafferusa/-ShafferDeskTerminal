// Browser driver for the digital-asset family (cryptocurrencies, stablecoins, tokenized assets).
//
// A digital asset is not an exchange-listed security: its trading platform is entered as an OTC venue, so the
// registration form asks for the Primary view (the routing convention places it in Foreign Based). Its other
// contract fields are the equity-like ones, and it is traded on the security ticket of the instrument drawer
// (Buy, Sell; no Sell short), so this file reuses equity.mjs for both. Units received for nothing (a staking
// reward, an airdrop) are recorded on the same ticket with "State a fill price" set to 0.

import * as equity from './equity.mjs';

export const family = 'crypto';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };

export async function contractTerms(ui, dialog, draft, ctx) {
  if (draft.venueType === 'otc') await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await equity.contractTerms(ui, dialog, draft, ctx);
}

export const ticket = equity.ticket;
