// Browser driver for the forwards family (deliverable FX forwards, non-deliverable forwards, forwards on an
// asset, forward-rate agreements; the products equity, bond, FX and commodity forward, NDF, FRA, FX swap and
// TBA mortgage contract are all registered as one of these kinds).
//
// A forward is an OTC contract: its terms and the required "Collateral terms" group are typed into the
// contract form of the registry (web/lib/contracts.js, `forward`), then a position is opened from the
// instrument drawer's Trade tab at a stated fill price. This file drives:
//
//   contractTerms()      the registry form: jurisdiction (or the view by hand), calendars, kind of forward and
//                        its fields, counterparty, collateral terms
//   ticket()             the instrument drawer's Trade tab: Account, Buy / Sell, quantity, order fields, State a
//                        fill price
//   actions.lifecycle    the position's Lifecycle menu on the strategy instance: "Early termination" (amount,
//                        notional terminated, settlement date); a position no longer listed offers nothing
//
// What a draft may state, and where it goes on the form:
//   jurisdiction                   Jurisdiction (an OTC contract is placed by its governing law); without it the
//                                  Primary view is chosen by hand
//   conventions                    { tradingCalendar, settlementCalendar, paymentCalendar }
//   terms.forwardType              Kind of forward: fx | ndf | asset | fra
//   terms.base, quote              Base currency, Quote currency (fx, ndf)
//   terms.valueDate                Value date (all but fra)
//   terms.fixingDate, settleCcy    Fixing date, Settlement currency (ndf)
//   underlying                     Underlying (asset) or Fixing source (currency pair) (ndf): picked by symbol
//   terms.settlement               Settlement: cash | physical (asset)
//   multiplier                     Multiplier (asset)
//   terms.periodStart, periodEnd, fixingRate, dayCount     the FRA's period, reference rate code and day count
//   terms.counterparty, collateralBasis, collateral        as on every OTC contract

export const family = 'forward';

import { actions as swapActions } from './swap.mjs';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const ACTION = { buy: 'Buy', sell: 'Sell' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const VIEW = { US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives' };
const ownerName = (ctx, key) => (key === 'treasury' ? 'Treasury' : ctx.spec.book.account.name);

function agreementOf(ctx, ref) {
  const key = typeof ref === 'string' && ref.startsWith('$agreement:') ? ref.slice(11) : null;
  const a = key ? ctx.agreements?.get(key) : [...(ctx.agreements?.values() || [])].find((x) => x.id === ref);
  if (!a) throw new Error(`The contract names the agreement "${ref}", which no earlier \`agreement\` step recorded.`);
  return a;
}

/** Search the registry in an instrument picker and choose the instrument by its symbol (or name). */
async function pickInstrument(ui, field, inst) {
  const label = inst.symbol || inst.name;
  const change = field.getByRole('button', { name: exactly('Change') });
  if (await change.count()) await change.click();
  await field.locator('input[type="search"]').fill(label);
  await field.locator('.picklist button').filter({ has: ui.page.locator('b', { hasText: exactly(label) }) }).first().click();
  await field.getByRole('button', { name: exactly('Change') }).waitFor();
}

/** The "Collateral terms" group (the same group as on every OTC contract form). */
async function fillCollateral(ui, scope, basis, ctx) {
  if (!basis) return;
  await ui.select(scope, 'Collateral basis').selectOption(basis.type);
  await ui.drawn();
  if (basis.type === 'agreement') {
    const a = agreementOf(ctx, basis.agreementId);
    const select = ui.select(scope, /^\s*Agreement/);
    await select.locator(`option[value="${a.id}"]`).waitFor({ state: 'attached' });
    await select.selectOption(a.id);
  }
  if (basis.type === 'position') {
    const ia = basis.independentAmount || { type: 'none' };
    await ui.select(scope, 'Independent amount').selectOption(ia.type || 'none');
    if (ia.type === 'pct') await ui.input(scope, 'Share of notional').fill(String(ia.pct));
    if (ia.type === 'fixed') await ui.input(scope, /^\s*Amount/).fill(String(ia.amount));
    await ui.field(scope, 'Variation margin').locator('input[type="checkbox"]').setChecked(Boolean(basis.variationMargin));
    if (basis.variationMargin) {
      await ui.input(scope, 'Threshold').fill(String(basis.threshold ?? 0));
      await ui.input(scope, 'Minimum transfer amount').fill(String(basis.minimumTransfer ?? 0));
    }
  }
}

async function fillConventions(ui, dialog, c) {
  if (!c) return;
  for (const [key, label] of [['tradingCalendar', 'Trading calendar'], ['settlementCalendar', 'Settlement calendar'], ['paymentCalendar', 'Payment calendar']]) {
    if (!c[key]) continue;
    const select = ui.select(dialog, label);
    if (String(c[key]).includes('+')) {
      await select.selectOption('+');
      await ui.field(dialog, label).locator('input').fill(c[key]);
    } else {
      await select.locator(`option[value="${c[key]}"]`).waitFor({ state: 'attached' });
      await select.selectOption(c[key]);
    }
  }
}

export async function contractTerms(ui, dialog, draft, ctx) {
  if (draft.jurisdiction) await ui.input(dialog, 'Jurisdiction').fill(draft.jurisdiction);
  else if (draft.marketView && await ui.field(dialog, /^\s*Primary view/).count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  await fillConventions(ui, dialog, draft.conventions);
  const t = draft.terms || {};
  await ui.select(dialog, 'Kind of forward').selectOption(t.forwardType);
  await ui.drawn();
  if (t.base) await ui.input(dialog, 'Base currency').fill(t.base);
  if (t.quote) await ui.input(dialog, 'Quote currency').fill(t.quote);
  if (t.forwardType !== 'fra') await ui.input(dialog, 'Value date').fill(t.valueDate || '');
  if (t.fixingDate && ['ndf', 'fra'].includes(t.forwardType)) await ui.input(dialog, 'Fixing date').fill(t.fixingDate);
  if (t.settleCcy) await ui.input(dialog, 'Settlement currency').fill(t.settleCcy);
  if (draft.underlying) await pickInstrument(ui, ui.field(dialog, t.forwardType === 'ndf' ? 'Fixing source (currency pair)' : exactly('Underlying')), ctx.inst(draft.underlying));
  if (t.settlement) await ui.select(dialog, exactly('Settlement')).selectOption(t.settlement);
  if (t.forwardType === 'asset' && draft.multiplier !== undefined && draft.multiplier !== null) await ui.input(dialog, exactly('Multiplier')).fill(String(draft.multiplier));
  if (t.forwardType === 'fra') {
    await ui.input(dialog, 'Interest period start').fill(t.periodStart);
    await ui.input(dialog, 'Interest period end').fill(t.periodEnd);
    await ui.input(dialog, 'Reference rate code').fill(t.fixingRate);
    if (t.dayCount) await ui.select(dialog, 'Day count').selectOption(t.dayCount);
  }
  if (t.counterparty) await ui.input(dialog, 'Counterparty').fill(t.counterparty);
  await fillCollateral(ui, dialog, t.collateralBasis, ctx);
  if (t.collateral) await ui.input(dialog, 'Other collateral terms').fill(t.collateral);
}

/** The instrument drawer's ticket for a registered forward: Account, Buy / Sell, quantity, order terms, stated fill price. */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  const owner = ownerName(ctx, step.owner);
  await ui.select(drawer, 'Account').selectOption({ label: owner });
  const label = inst.actionLabels?.[step.side] || ACTION[step.side];
  const action = ui.option(drawer, 'Action', label);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${label}" for ${inst.symbol || inst.name} in ${owner}.`, where: 'ticket, Action' } };
  await action.click();
  await ui.input(drawer, inst.qtyLabel || 'Notional').fill(String(step.qty));
  const o = step.order || {};
  if (o.orderType && o.orderType !== 'market') await ui.select(drawer, 'Order type').selectOption({ label: ORDER_TYPE[o.orderType] });
  if (o.limitPrice !== undefined && o.limitPrice !== null) await ui.input(drawer, 'Limit price').fill(String(o.limitPrice));
  if (o.statedPrice !== undefined && o.statedPrice !== null) await ui.input(drawer, 'State a fill price').fill(String(o.statedPrice));
  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) {
    const notices = (await drawer.locator('.notice').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
    return { refusal: { message: notices.join(' | ') || 'The Preview button is disabled and the ticket gives no reason.', where: 'ticket, Preview disabled' } };
  }
  return { preview: () => preview.click() };
}

/** Open the strategy instance of a lot from the Accounting positions of whoever holds it. */
async function openStrategy(ui, ctx, lot, owner) {
  if (!owner || owner === 'account') return ui.openStrategy(ctx, lot.strategyId);
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/positions/${ctx.unitId(owner)}`);
  await ui.page.locator(`main a[title="Strategy instance ${lot.strategyId}"]`).first().click();
  const drawer = ui.page.getByRole('dialog').filter({ has: ui.page.locator('header h3', { hasText: /^Positions/ }) });
  await drawer.waitFor();
  return drawer;
}

export const actions = {
  /**
   * A package of registered forwards on the Strategies page (an FX swap's near and far legs): Trading owner, template
   * Custom, "Add a leg" with Leg "Registered instrument" for each leg (instrument, side, quantity, stated fill price),
   * then Preview package. Packages of anything else are left to the shared path.
   */
  async package(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    const input = step.input || {};
    const legs = input.legs || [];
    if ((input.template && input.template !== 'custom') || input.attachTo || !legs.length || !legs.every((l) => l.kind === 'trade' && String(l.instrumentId || '').startsWith('$inst:'))) return undefined;
    const { page } = ui;
    await ui.closeOverlays();
    await ui.reloadAt('#/strategy');
    const main = page.locator('main');
    await ui.select(main, 'Trading owner').selectOption({ label: ownerName(ctx, step.owner) });
    await ui.select(main, 'Execution template').selectOption('custom');
    await ui.drawn();
    for (const leg of legs) {
      const inst = ctx.inst(leg.instrumentId.slice(6));
      await ui.button(ui.section(main, /^Legs/), 'Add a leg').click();
      const dlg = ui.dialog('Add a leg');
      await dlg.waitFor();
      await ui.select(dlg, /^\s*Leg\s*$/).selectOption('instrument');
      await ui.drawn();
      if (leg.purpose === 'hedge') await ui.option(dlg, 'Purpose', 'Hedge').click();
      await pickInstrument(ui, ui.field(dlg, exactly('Instrument')), inst);
      await ui.select(dlg, /^\s*Side\s*$/).selectOption(leg.action);
      await ui.input(dlg, inst.qtyLabel || 'Quantity').fill(String(leg.qty));
      if (leg.statedPrice !== undefined && leg.statedPrice !== null) await ui.input(dlg, 'State a fill price').fill(String(leg.statedPrice));
      await ui.button(dlg, 'Add leg').click();
      if (await dlg.locator('.notice.err').count()) {
        const message = (await dlg.locator('.notice.err').first().innerText()).trim();
        await ui.button(dlg, 'Cancel').click();
        return { refusal: { message, where: 'Add a leg dialog' } };
      }
      await dlg.waitFor({ state: 'hidden' });
    }
    const out = await previewAndConfirm(ui, ctx, () => ui.button(main, 'Preview package').click(), { expectsRefusal });
    if (out.strategy && step.as && !ctx.lots.has(step.as)) ctx.nameLot(step.as, out.strategy.id, step.instrument);
    return out;
  },
  /** A paper collateral agreement of the Book (Treasury, Collateral, New agreement): the same dialog the swap scenarios drive. */
  agreement: (...args) => swapActions.agreement(...args),
  /** Early termination at a stated amount: the position's Lifecycle menu, "Early termination", amount, notional, settlement date. */
  async lifecycle(ui, t, ctx, step, tools) {
    if (step.body?.action !== 'terminate') return undefined;
    const lot = ctx.lot(step.lot);
    const inst = ctx.inst(step.instrument || lot.instrument);
    const sym = inst.symbol || inst.name;
    const drawer = await openStrategy(ui, ctx, lot, step.owner);
    const panel = ui.section(drawer, 'Positions');
    await panel.waitFor();
    const row = tools.positionRow(drawer, inst);
    if (!await row.count()) {
      const listed = (await panel.locator('tbody tr .sym').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
      return { refusal: { message: `The strategy instance lists no open ${sym} position (positions listed: ${listed.join(', ') || 'none'}), so it cannot be terminated.`, where: 'strategy instance, Positions' } };
    }
    const menu = row.locator('select').first();
    const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
    if (!offered.includes('Early termination')) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "Early termination" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
    await menu.selectOption({ label: 'Early termination' });
    const dlg = ui.dialog(/^Early termination/);
    await dlg.waitFor();
    const b = step.body;
    if (b.amount !== undefined && b.amount !== null) await ui.input(dlg, /^\s*Termination amount/).fill(String(b.amount));
    if (b.qty !== undefined && b.qty !== null) await ui.input(dlg, 'Notional terminated').fill(String(b.qty));
    if (b.settleDate) await ui.input(dlg, 'Settlement date').fill(b.settleDate);
    const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => ui.button(dlg, 'Record termination').click());
    if (!r.ok) {
      const msg = r.body?.error || 'no message';
      await dlg.locator('.notice.err', { hasText: msg.slice(0, 60) }).first().waitFor();
      const shown = (await dlg.locator('.notice.err').first().innerText()).replace(/\s+/g, ' ').trim();
      await ui.button(dlg, 'Cancel').click();
      await dlg.waitFor({ state: 'hidden' });
      return { refusal: { message: shown, status: r.status, where: 'early termination dialog' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },
};
