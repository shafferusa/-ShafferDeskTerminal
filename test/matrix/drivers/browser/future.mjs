// Browser ticket driver for the futures family: the contract fields of the registration form, the
// futures ticket in the instrument drawer, and the two things a futures scenario does on the strategy
// instance that the shared paths do not cover (rolling into another contract month, and managing a
// position that Treasury owns). Everything else (the preview and its confirmation, closing and
// resizing an Account's position, events recorded by hand, the Accounting readers) is shared and
// lives in ../browser.mjs. See ./equity.mjs for what a family driver exports.

export const family = 'future';

const ACTION = { buy: 'Buy', sell: 'Sell' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
/** A label that is exactly this text: "Settlement" and not "Settlement currency", "Underlying" and not "Underlying geography". */
const only = (text) => new RegExp(`^\\s*${text}\\s*$`);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One calendar role of "Calendars and settlement": a built-in calendar from the list, or one typed as a joint calendar. */
async function chooseCalendar(ui, dialog, label, id) {
  const field = ui.field(dialog, label);
  const select = field.locator('select').first();
  if (await select.locator(`option[value="${id}"]`).count()) { await select.selectOption(id); return; }
  // Not in the list (a joint calendar such as US+JP, or the every-day calendar of a 24/7 market): typed.
  await select.selectOption('+');
  await field.locator('input').first().fill(id);
}

/**
 * The futures contract fields: underlying (optional), contract root, perpetual or last trading day,
 * multiplier, tick size, initial margin per contract, settlement; then the calendars a spec sets on
 * the instrument (`conventions`).
 */
export async function contractTerms(ui, dialog, draft, ctx) {
  const t = draft.terms || {};
  if (draft.underlying) {
    const und = ctx.inst(draft.underlying);
    const field = ui.field(dialog, only('Underlying'));
    await field.getByRole('searchbox').fill(und.symbol || und.name);
    await field.getByRole('button', { name: new RegExp(`^\\s*${esc(und.symbol || und.name)}\\b`) }).first().click();
    // The picked instrument is shown in place of the search box.
    await field.getByRole('button', { name: only('Change') }).waitFor();
  }
  if (t.root) await ui.input(dialog, 'Contract root').fill(t.root);
  if (t.perpetual) await ui.field(dialog, 'Perpetual').getByRole('checkbox').check();
  else await ui.input(dialog, 'Last trading day').fill(t.expiration);
  await ui.input(dialog, 'Contract multiplier').fill(String(draft.multiplier));
  if (t.tickSize !== undefined && t.tickSize !== null) await ui.input(dialog, 'Tick size').fill(String(t.tickSize));
  if (t.initialMargin !== undefined && t.initialMargin !== null) await ui.input(dialog, 'Initial margin per contract').fill(String(t.initialMargin));
  if (t.settlement) await ui.select(dialog, only('Settlement')).selectOption(t.settlement);
  if (t.priceUnits) await ui.input(dialog, 'Quoted in').fill(t.priceUnits);
  const c = draft.conventions || {};
  if (c.tradingCalendar) await chooseCalendar(ui, dialog, 'Trading calendar', c.tradingCalendar);
  if (c.settlementCalendar) await chooseCalendar(ui, dialog, 'Settlement calendar', c.settlementCalendar);
  if (c.paymentCalendar) await chooseCalendar(ui, dialog, 'Payment calendar', c.paymentCalendar);
}

/** The futures ticket in the instrument drawer: Account, Buy or Sell, Contracts, order terms. Each ticket opens its own strategy instance. */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
  await ui.select(drawer, 'Account').selectOption({ label: owner });

  const action = ui.option(drawer, 'Action', ACTION[step.side]);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${ACTION[step.side] || step.side}" for ${inst.symbol || inst.name}.`, where: 'ticket, Action' } };
  if (await action.isDisabled()) return { refusal: { message: (await action.getAttribute('title')) || `"${ACTION[step.side]}" is disabled on the ticket.`, where: 'ticket, Action disabled' } };
  await action.click();

  // The ticket states the contract's multiplier beside the quantity: it must be the one the spec registered.
  const qty = ui.field(drawer, inst.qtyLabel);
  const hint = (await qty.innerText()).replace(/\s+/g, ' ');
  if (inst.multiplier !== 1 && !hint.includes(`Contract multiplier ${inst.multiplier}`)) throw new Error(`The ticket does not state the contract multiplier ${inst.multiplier} ("${hint}").`);
  await qty.locator('input').first().fill(String(step.qty));

  const o = step.order || {};
  if (o.orderType && o.orderType !== 'market') await ui.select(drawer, 'Order type').selectOption({ label: ORDER_TYPE[o.orderType] });
  if (o.limitPrice !== undefined && o.limitPrice !== null) await ui.input(drawer, 'Limit price').fill(String(o.limitPrice));
  if (o.stopPrice !== undefined && o.stopPrice !== null) await ui.input(drawer, 'Stop price').fill(String(o.stopPrice));
  if (o.tif && o.tif !== 'day') await ui.select(drawer, 'Time in force').selectOption({ label: TIF[o.tif] });
  if (o.statedPrice !== undefined && o.statedPrice !== null) await ui.input(drawer, 'State a fill price').fill(String(o.statedPrice));

  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) {
    const notices = (await drawer.locator('.notice').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
    return { refusal: { message: notices.join(' | ') || 'The Preview button is disabled and the ticket gives no reason.', where: 'ticket, Preview disabled' } };
  }
  return { preview: () => preview.click() };
}

/**
 * A strategy instance's drawer, opened from the Accounting positions of its owner. The shared path opens the
 * Account's; a position that Treasury owns is listed under Treasury.
 */
async function openStrategyOf(ui, ctx, strategyId, owner) {
  if (owner !== 'treasury') return ui.openStrategy(ctx, strategyId);
  const { page } = ui;
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/positions/${ctx.treasuryId}`);
  await page.locator(`main a[title="Strategy instance ${strategyId}"]`).first().click();
  const drawer = page.getByRole('dialog').filter({ has: page.locator('header h3', { hasText: /^Positions/ }) });
  await drawer.waitFor();
  return drawer;
}

export const actions = {
  /** Roll: the strategy instance's Roll dialog, the contract month to roll into, then the preview of the two-leg package. */
  async roll(ui, t, ctx, step, tools) {
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategyOf(ui, ctx, lot.strategyId, step.owner);
    await ui.button(drawer, 'Roll').click();
    const dlg = ui.dialog(/^Roll positions of /);
    await dlg.waitFor();
    const target = ctx.inst(step.into);
    const month = ui.select(dlg, 'Contract month to roll into');
    // The contract months are read from the registry: the choice exists once they have loaded.
    const option = month.locator(`option[value="${target.id}"]`);
    try { await option.waitFor({ state: 'attached', timeout: 8000 }); } catch {
      const offered = (await month.locator('option').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
      return { refusal: { message: `The Roll dialog does not offer ${target.symbol || target.name}. It offers: ${offered.join(' | ') || 'nothing'}.`, where: 'Roll dialog, Contract month to roll into' } };
    }
    const label = (await option.innerText()).trim();
    if (target.terms.expiration && !label.includes(target.terms.expiration)) throw new Error(`The Roll dialog lists ${target.symbol} as "${label}", without its last trading day ${target.terms.expiration}.`);
    await month.selectOption(target.id);
    return tools.previewAndConfirm(ui, ctx, () => ui.button(dlg, 'Preview roll').click(), { expectsRefusal: tools.expectsRefusal });
  },

  /** Close and Resize on a position that Treasury owns: the same controls as the shared path, reached from Treasury's positions. */
  async close(ui, t, ctx, step, tools) {
    if (step.owner !== 'treasury') return undefined;
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategyOf(ui, ctx, lot.strategyId, 'treasury');
    let open;
    if (step.scope === 'position') {
      if ((step.percent ?? 100) !== 100) throw new Error('The Close button on a position closes all of it.');
      const row = tools.positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
      open = () => ui.button(row, 'Close').click();
    } else {
      await ui.input(drawer, 'Close, share of every position').fill(String(step.percent ?? 100));
      open = () => ui.button(drawer, 'Preview close').click();
    }
    return tools.previewAndConfirm(ui, ctx, open, { expectsRefusal: tools.expectsRefusal });
  },
  async resize(ui, t, ctx, step, tools) {
    if (step.owner !== 'treasury') return undefined;
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategyOf(ui, ctx, lot.strategyId, 'treasury');
    await ui.input(drawer, 'Resize, multiple of the current size').fill(String(step.factor));
    return tools.previewAndConfirm(ui, ctx, () => ui.button(drawer, 'Preview resize').click(), { expectsRefusal: tools.expectsRefusal });
  },
};
