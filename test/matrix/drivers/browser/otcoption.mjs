// Browser driver for OTC options (engine family "otcoption"): vanilla, bond, FX, commodity, crypto,
// rate and digital options, swaptions, barrier, Asian, lookback, basket, spread, quanto and compound
// options. Everything shared (preview and confirmation, Close and Resize on the strategy instance,
// manual prices, transfers, the Accounting readers) lives in ../browser.mjs.
//
// An OTC option is registered as a contract in the registry form (Instruments, New instrument): the
// option fields of web/lib/contracts.js (F.otcoption) and the required "Collateral terms" group. It is
// then traded from the instrument drawer's Trade tab ("Buy" or "Sell / write", underlying units, the
// premium agreed with the dealer as "State a fill price").
//
// Exports (see ./equity.mjs for the contract of a family driver):
//   contractTerms   registry form: Primary view, Underlying instrument or Fixing rate code, Type, Strike,
//                   Expiration, Payoff (with Digital payout, Barrier and Barrier level), Exercise style
//                   (with Bermudan exercise dates), Settlement, Multiplier, Deliverable units, Counterparty,
//                   Collateral terms, Other collateral terms
//   ticket          the instrument drawer's ticket
//   actions         agreement, close / resize at a stated amount, owner_screens, manual_rate: the swap
//                   driver's paths (the same screens); lifecycle: Exercise (with an entry price when a
//                   swaption is exercised into its contract), Early assignment, Barrier event, Credit event
//                   knock-out, Lookback extreme; settlement_amount and settlement_value: entered by hand on
//                   the option's expiry item (Accounting, Pending)

import { actions as swapActions } from './swap.mjs';

export const family = 'otcoption';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const ACTION = { buy: 'Buy', sell: 'Sell / write' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
const VIEW = { US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives', US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };
const ownerName = (ctx, key) => (key === 'treasury' ? 'Treasury' : key === 'account' || !key ? ctx.spec.book.account.name : ctx.extraUnits?.get(key)?.name || key);
const checkbox = (ui, scope, label) => ui.field(scope, label).locator('input[type="checkbox"]');

function agreementOf(ctx, ref) {
  const key = typeof ref === 'string' && ref.startsWith('$agreement:') ? ref.slice(11) : null;
  const a = key ? ctx.agreements?.get(key) : [...(ctx.agreements?.values() || [])].find((x) => x.id === ref);
  if (!a) throw new Error(`The contract names the agreement "${ref}", which no earlier \`agreement\` step recorded.`);
  return a;
}

/** Choose an instrument in a registry picker (type its ticker, pick the match). */
async function pickInstrument(ui, scope, label, inst) {
  const field = ui.field(scope, label);
  const change = field.getByRole('button', { name: exactly('Change') });
  if (await change.count()) await change.click();
  await field.getByPlaceholder('Type a ticker or name').fill(inst.symbol || inst.name);
  await field.getByRole('button', { name: new RegExp(`^\\s*${esc(inst.symbol || inst.name)}(\\s|$)`) }).first().click();
  await field.locator('b', { hasText: exactly(inst.symbol || inst.name) }).first().waitFor();
}

/** The "Collateral terms" group. A draft without a basis leaves the choice empty. */
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
    await checkbox(ui, scope, 'Variation margin').setChecked(Boolean(basis.variationMargin));
    if (basis.variationMargin) {
      await ui.input(scope, 'Threshold').fill(String(basis.threshold ?? 0));
      await ui.input(scope, 'Minimum transfer amount').fill(String(basis.minimumTransfer ?? 0));
    }
  }
}

/** Calendars and settlement lag of the instrument (registry form only): 'JP' or a joint calendar such as 'JP+TARGET'. */
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
  if (c.settleLag !== undefined && c.settleLag !== null) await ui.input(dialog, 'Settlement convention: lag in business days').fill(String(c.settleLag));
}

/** The OTC option fields of the registration form. A spec states them on the draft: `underlying`, `multiplier`, `terms`. */
export async function contractTerms(ui, dialog, draft, ctx) {
  const view = ui.field(dialog, /^\s*Primary view/);
  if (await view.count()) {
    await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
    await fillConventions(ui, dialog, draft.conventions);
  }
  const t = draft.terms || {};
  if (draft.underlying) await pickInstrument(ui, dialog, /^\s*Underlying instrument/, ctx.inst(draft.underlying));
  if (t.fixingRate) await ui.input(dialog, /^\s*Fixing rate code/).fill(t.fixingRate);
  await ui.select(dialog, /^\s*Type\b/).selectOption(t.right === 'P' ? 'P' : 'C');
  await ui.input(dialog, /^\s*Strike\b/).fill(String(t.strike));
  await ui.input(dialog, /^\s*Expiration\b/).fill(t.expiration);
  await ui.select(dialog, /^\s*Payoff\b/).selectOption(t.optionType || 'vanilla');
  await ui.drawn();
  if (t.payout !== undefined && t.payout !== null) await ui.input(dialog, /^\s*Digital payout per unit/).fill(String(t.payout));
  if (t.barrier) {
    await ui.select(dialog, /^\s*Barrier\s*$/).selectOption(t.barrier.type);
    await ui.input(dialog, /^\s*Barrier level/).fill(String(t.barrier.level));
    if (t.barrier.rebate !== undefined && t.barrier.rebate !== null) await ui.input(dialog, /^\s*Rebate/).fill(String(t.barrier.rebate));
  }
  await ui.select(dialog, /^\s*Exercise style\b/).selectOption(t.exercise || 'european');
  await ui.drawn();
  if (t.exercise === 'bermudan') await ui.input(dialog, /^\s*Bermudan exercise dates/).fill([].concat(t.exerciseDates || []).join(', '));
  await ui.select(dialog, /^\s*Settlement\s*$/).selectOption(t.settlement || 'cash');
  await ui.drawn();
  if (draft.multiplier !== undefined && draft.multiplier !== null) await ui.input(dialog, /^\s*Multiplier\b/).fill(String(draft.multiplier));
  if (t.deliverable?.units !== undefined && t.deliverable.units !== null) await ui.input(dialog, /^\s*Deliverable units per unit of quantity/).fill(String(t.deliverable.units));
  if (t.counterparty) await ui.input(dialog, /^\s*Counterparty/).fill(t.counterparty);
  await fillCollateral(ui, dialog, t.collateralBasis, ctx);
  if (t.collateral) await ui.input(dialog, 'Other collateral terms').fill(t.collateral);
}

/** The instrument drawer's ticket: Trading owner, Buy or Sell / write, underlying units, order terms, stated fill price. */
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
  await ui.input(drawer, inst.qtyLabel).fill(String(step.qty));
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

/** The strategy instance's drawer, opened from the Accounting positions of whoever owns it (the Account or Treasury). */
async function openStrategy(ui, t, ctx, strategyId) {
  const { page } = ui;
  const s = await t.strategy(strategyId);
  if (s.unit.id === ctx.accountId) return ui.openStrategy(ctx, strategyId);
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/positions/${s.unit.id}`);
  await page.locator(`main a[title="Strategy instance ${strategyId}"]`).first().click();
  const drawer = page.getByRole('dialog').filter({ has: page.locator('header h3', { hasText: /^Positions/ }) });
  await drawer.waitFor();
  return drawer;
}

const LIFECYCLE = {
  exercise: { menu: 'Exercise', qty: 'Contracts to exercise', button: 'Record exercise' },
  assign: { menu: 'Early assignment', qty: 'Contracts assigned', button: 'Record assignment' },
  barrier: { menu: 'Barrier event', button: 'Record barrier event' },
  knockout: { menu: 'Credit event knock-out', button: 'Record knock-out' },
  extreme: { menu: 'Lookback extreme', button: 'Record extreme' },
};

/** The expiry item of the lot's option position on the Pending tab of its owner: type the amount or value and save it. */
async function onExpiryItem(ui, t, ctx, step, what) {
  const lot = ctx.lot(step.lot);
  const s = await t.strategy(lot.strategyId);
  const inst = ctx.inst(step.instrument || lot.instrument);
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/pending/${s.unit.id}`);
  const section = ui.section(ui.page.locator('main'), 'Lifecycle items');
  await section.waitFor();
  const row = section.locator('tbody tr').filter({ hasText: inst.symbol || inst.name }).filter({ hasText: 'blocked' }).first();
  await row.waitFor();
  const input = row.locator('input').first();
  await input.fill(String(what === 'amount' ? step.amount : step.value));
  await ui.drawn();
  const path = what === 'amount' ? /^\/api\/tasks\/[^/]+\/settlement-amount$/ : /^\/api\/tasks\/[^/]+\/settlement-value$/;
  const r = await ui.respondsTo('POST', path, () => ui.button(row, what === 'amount' ? 'Save settlement amount' : 'Save settlement value').click());
  if (!r.ok) return { refusal: { message: r.body?.error, status: r.status, where: 'Pending tab, expiry item' } };
  await ui.toast(what === 'amount' ? /Settlement amount saved/ : /Settlement value saved/);
  return {};
}

export const actions = {
  agreement: swapActions.agreement,
  close: swapActions.close,
  resize: swapActions.resize,
  owner_screens: swapActions.owner_screens,
  manual_rate: swapActions.manual_rate,

  /**
   * Lifecycle events recorded by hand on the position (strategy instance, the position's Lifecycle menu, then its dialog):
   * Exercise (with the entry price of the swap or credit default swap a swaption is exercised into), Early assignment,
   * Barrier event, Credit event knock-out, Lookback extreme. A manual cash flow is left to the shared path.
   */
  async lifecycle(ui, t, ctx, step, tools) {
    const kind = step.body?.action;
    const L = LIFECYCLE[kind];
    if (!L) return undefined;
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategy(ui, t, ctx, lot.strategyId);
    const row = tools.positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
    const menu = row.locator('select').first();
    const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
    if (!offered.includes(L.menu)) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "${L.menu}" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
    await menu.selectOption({ label: L.menu });
    const dlg = ui.dialog(new RegExp(`^${esc(L.menu)}: `));
    await dlg.waitFor();
    const b = step.body;
    if (L.qty && b.contracts !== undefined && b.contracts !== null) await ui.input(dlg, L.qty).fill(String(b.contracts));
    if (kind === 'exercise' && b.price !== undefined && b.price !== null) await ui.input(dlg, /^\s*Entry price of the underlying contract/).fill(String(b.price));
    if (kind === 'extreme') {
      await ui.input(dlg, /^\s*Observed (maximum|minimum)/).fill(String(b.value));
      if (b.date) await ui.input(dlg, 'Observed on').fill(b.date);
    }
    if (b.note && ['barrier', 'knockout', 'extreme'].includes(kind)) await ui.input(dlg, 'Note').fill(b.note);
    const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => ui.button(dlg, L.button).click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: `${L.menu} dialog message` } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },

  /** The settlement amount (or a basket's or spread's settlement value) entered on the expiry item: Accounting, Pending. */
  async settlement_amount(ui, t, ctx, step) { return onExpiryItem(ui, t, ctx, step, 'amount'); },
  async settlement_value(ui, t, ctx, step) { return onExpiryItem(ui, t, ctx, step, 'value'); },
};
