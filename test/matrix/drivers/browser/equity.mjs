// Browser ticket driver for the equity family: what is particular to equity-like securities on the
// registration form and on the instrument's trade ticket. Everything else (the preview and its
// confirmation, the strategy instance, events recorded by hand, the Accounting readers) is shared
// and lives in ../browser.mjs.
//
// A family driver exports:
//   contractTerms(ui, dialog, draft, ctx)   fill the "Contract terms" part of the registration form
//   ticket(ui, t, ctx, step)                fill the ticket for a `ticket` step; return { preview } where
//                                           preview() presses the button that opens the trade preview, or
//                                           { refusal: { message, where } } when the ticket itself will not go on
//   actions (optional)                      { '<step action>': async (ui, t, ctx, step, tools) => ({ preview?, result?, refusal? }) }
//                                           interface paths for step actions only this family has
//
// The driver of an instrument's own family fills its contract terms (a bond scenario that also registers a
// stock uses this file's contractTerms for the stock). A step uses the ticket of the scenario's family unless
// it says `ticketOf: '<family>'`.

export const family = 'equity';

const ACTION = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };

/** Equity-like securities have two optional contract fields; a spec states them under `terms`. */
export async function contractTerms(ui, dialog, draft) {
  if (draft.terms?.lotSize) await ui.input(dialog, 'Lot size').fill(String(draft.terms.lotSize));
  if (draft.terms?.settleDays !== undefined && draft.terms.settleDays !== null) await ui.input(dialog, 'Settlement lag').fill(String(draft.terms.settleDays));
}

/** The security ticket in the instrument drawer: Account, Action, the position to reduce, quantity, order terms. */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
  await ui.select(drawer, 'Account').selectOption({ label: owner });

  const action = ui.option(drawer, 'Action', ACTION[step.side]);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${ACTION[step.side]}" for ${inst.symbol || inst.name} in ${owner}.`, where: 'ticket, Action' } };
  if (await action.isDisabled()) return { refusal: { message: (await action.getAttribute('title')) || `"${ACTION[step.side]}" is disabled on the ticket.`, where: 'ticket, Action disabled' } };
  await action.click();

  // A sale or a cover reduces one position. With more than one to choose from, the ticket asks which.
  if (step.side === 'sell' || step.side === 'buy_to_cover') {
    const lot = ctx.lot(step.from);
    const held = (await t.strategy(lot.strategyId)).positions.find((p) => p.instrument.id === inst.id);
    if (!held) throw new Error(`"${step.from}" holds no ${inst.symbol} to ${step.side === 'sell' ? 'sell' : 'cover'}.`);
    const which = ui.field(drawer, step.side === 'sell' ? 'Sell from' : 'Cover').locator('select');
    if (await which.count()) await which.first().selectOption(held.positionId);
  }

  await ui.input(drawer, inst.qtyLabel).fill(String(step.qty));
  const o = step.order || {};
  if (o.orderType && o.orderType !== 'market') await ui.select(drawer, 'Order type').selectOption({ label: ORDER_TYPE[o.orderType] });
  if (o.limitPrice !== undefined && o.limitPrice !== null) await ui.input(drawer, 'Limit price').fill(String(o.limitPrice));
  if (o.stopPrice !== undefined && o.stopPrice !== null) await ui.input(drawer, 'Stop price').fill(String(o.stopPrice));
  if (o.tif && o.tif !== 'day') await ui.select(drawer, 'Time in force').selectOption({ label: TIF[o.tif] });
  if (o.statedPrice !== undefined && o.statedPrice !== null) await ui.input(drawer, 'State a fill price').fill(String(o.statedPrice));
  if (step.side === 'sell_short' && step.borrow) {
    // Only when no borrow data is supplied does the ticket ask for an assumption.
    await ui.input(drawer, 'Borrow fee').fill(String(step.borrow.feeRate));
  }

  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) {
    const notices = (await drawer.locator('.notice').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
    return { refusal: { message: notices.join(' | ') || 'The Preview button is disabled and the ticket gives no reason.', where: 'ticket, Preview disabled' } };
  }
  return { preview: () => preview.click() };
}
