// Browser driver for listed options (engine family "option"): what is particular to an option
// contract on the registration form, how a contract is found, its ticket, and the actions only an
// option position has. Everything else (the preview and its confirmation, Close and Resize on the
// strategy instance, manual cash flows, the Accounting readers) is shared and lives in ../browser.mjs.
//
// How a contract is found: from its underlying. The underlying's drawer has an "Options and futures"
// tab; with no option chain supplied by Shaffer MarketData it lists the contracts registered on that
// underlying, and choosing one opens the contract with its ticket. An underlying that has no such tab
// (a future) is reached through the contract's own row in its Marketplace.
//
// Exports (see ./equity.mjs for the contract of a family driver):
//   contractTerms   the option fields of the registration form: underlying, type, strike, expiration,
//                   exercise style, settlement, premium multiplier, deliverable units
//   ticket          the option ticket: Account, Buy or Sell / write, contracts, order terms
//   actions         lifecycle (exercise and early assignment recorded by hand on the position),
//                   roll (the Roll dialog of the strategy instance), package (a covered structure
//                   assembled on the Strategies page)

export const family = 'option';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const ACTION = { buy: 'Buy', sell: 'Sell / write' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
const LIFECYCLE = {
  exercise: { menu: 'Exercise', dialog: /^Exercise: /, field: 'Contracts to exercise', button: 'Record exercise' },
  assign: { menu: 'Early assignment', dialog: /^Early assignment: /, field: 'Contracts assigned', button: 'Record assignment' },
};

/** Choose an instrument in a registry picker (type its ticker, pick the match). */
async function pickInstrument(ui, scope, label, inst) {
  const field = ui.field(scope, label);
  // An instrument may already be chosen (a preset): the picker then shows it with a Change button.
  const change = field.getByRole('button', { name: exactly('Change') });
  if (await change.count()) await change.click();
  await field.getByPlaceholder('Type a ticker or name').fill(inst.symbol || inst.name);
  await field.getByRole('button', { name: new RegExp(`^\\s*${esc(inst.symbol || inst.name)}(\\s|$)`) }).first().click();
  // The picker now shows what was chosen.
  await field.locator('b', { hasText: exactly(inst.symbol || inst.name) }).first().waitFor();
}

/** The option fields of the registration form. A spec states them on the draft: `underlying`, `multiplier`, `terms`. */
export async function contractTerms(ui, dialog, draft, ctx) {
  const t = draft.terms || {};
  if (draft.underlying) await pickInstrument(ui, dialog, /^\s*Underlying\s*\(required\)/, ctx.inst(draft.underlying));
  await ui.select(dialog, /^\s*Type\b/).selectOption({ label: t.right === 'P' ? 'Put' : 'Call' });
  await ui.input(dialog, /^\s*Strike\b/).fill(String(t.strike));
  await ui.input(dialog, /^\s*Expiration\b/).fill(t.expiration);
  await ui.select(dialog, /^\s*Exercise style\b/).selectOption({ label: t.exercise === 'european' ? 'European' : 'American' });
  await ui.select(dialog, /^\s*Settlement\s*$/).selectOption({ label: t.settlement === 'cash' ? 'Cash' : 'Physical delivery' });
  await ui.input(dialog, /^\s*Premium multiplier per contract\b/).fill(String(draft.multiplier));
  if (t.deliverable?.units !== undefined && t.deliverable.units !== null) await ui.input(dialog, /^\s*Deliverable units per contract\b/).fill(String(t.deliverable.units));
}

/** Find the contract and open it: from its underlying's list of registered contracts, or from its Marketplace. */
async function openContract(ui, ctx, inst) {
  const { page } = ui;
  const und = Object.values(ctx.instruments).find((i) => i.id === inst.underlyingId);
  if (und && ['equity', 'fund'].includes(und.family)) {
    const undDrawer = await ui.openInstrument(und);
    await ui.tab(undDrawer, 'Options and futures');
    const chain = ui.section(undDrawer, 'Option chain');
    await chain.getByRole('link', { name: exactly(inst.name) }).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(`^\\s*${esc(inst.symbol || inst.name)}(\\s|$)`) });
    await drawer.getByRole('tab', { name: /^Trade/ }).waitFor();
    return drawer;
  }
  return ui.openInstrument(inst);
}

/** The option ticket in the contract's drawer: Account, Buy or Sell / write, contracts, order terms. */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await openContract(ui, ctx, inst);
  await ui.tab(drawer, 'Trade');
  const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
  await ui.select(drawer, 'Account').selectOption({ label: owner });

  const action = ui.option(drawer, 'Action', ACTION[step.side]);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${ACTION[step.side]}" for ${inst.symbol || inst.name}.`, where: 'ticket, Action' } };
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

export const actions = {
  /**
   * Exercise of a long option, or early assignment of a written one, recorded by hand: the position's Lifecycle
   * menu on its strategy instance, then the dialog. A manual cash flow is left to the shared path.
   */
  async lifecycle(ui, t, ctx, step, { positionRow }) {
    const kind = step.body?.action;
    const L = LIFECYCLE[kind];
    if (!L) return undefined;
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategy(ui, t, ctx, lot.strategyId);
    const row = positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
    const menu = row.locator('select').first();
    const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
    if (!offered.includes(L.menu)) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "${L.menu}" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
    await menu.selectOption({ label: L.menu });
    const dlg = ui.dialog(L.dialog);
    await dlg.waitFor();
    if (step.body.contracts !== undefined && step.body.contracts !== null) await ui.input(dlg, L.field).fill(String(step.body.contracts));
    const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => ui.button(dlg, L.button).click());
    if (!r.ok) {
      // The dialog stays open and shows the server's reason.
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: (await dlg.locator('.notice.err').first().innerText()).trim(), status: r.status, where: `${L.menu} dialog message` } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },

  /**
   * Roll: the Roll dialog of the strategy instance (Manage, Roll). Every option position of the instance is
   * selected when the dialog opens; `positions` on the step narrows that. The new expiration is typed (no option
   * chain is supplied for the fixtures), the new strike only when one option is rolled alone; a futures position
   * takes the contract month named by `into`.
   */
  async roll(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategy(ui, t, ctx, lot.strategyId);
    const manage = ui.section(drawer, 'Manage');
    const roll = ui.button(manage, 'Roll');
    if (!await roll.count()) return { refusal: { message: 'The strategy instance offers no Roll: it holds no option or futures position.', where: 'strategy instance, Manage' } };
    await roll.click();
    const dlg = ui.dialog(/^Roll positions of /);
    await dlg.waitFor();
    if (step.positions) {
      const wanted = step.positions.map((k) => ctx.inst(k).symbol || ctx.inst(k).name);
      const boxes = dlg.getByRole('checkbox');
      for (let i = 0; i < await boxes.count(); i++) {
        const label = (await boxes.nth(i).locator('xpath=..').innerText()).trim();
        await boxes.nth(i).setChecked(wanted.some((w) => label.includes(w)));
      }
    }
    if (step.newExpiration) await ui.input(dlg, 'New expiration').fill(step.newExpiration);
    if (step.newStrike !== undefined && step.newStrike !== null) await ui.input(dlg, 'New strike').fill(String(step.newStrike));
    if (step.into) await ui.select(dlg, 'Contract month to roll into').selectOption(ctx.inst(step.into).id);
    const go = ui.button(dlg, 'Preview roll');
    if (await go.isDisabled()) return { refusal: { message: 'Preview roll is disabled: the Roll dialog is not complete.', where: 'Roll dialog' } };
    return previewAndConfirm(ui, ctx, () => go.click(), { expectsRefusal });
  },

  /**
   * A package assembled on the Strategies page from an execution template. The step states what is entered there as
   * `strategyPage: { template, underlying, quantity, expiration, strikes: { '<field label>': strike }, contracts }`
   * (the request this produces is the step's `input`, which the engine and API levels send).
   */
  async package(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    const sp = step.strategyPage;
    if (!sp) return undefined;
    const { page } = ui;
    await ui.closeOverlays();
    await ui.goto('#/strategy');
    const main = page.locator('main');
    const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
    await ui.select(ui.section(main, 'Account and intent'), 'Account').selectOption({ label: owner });
    const what = ui.section(main, 'Instrument and template');
    await ui.select(what, 'Execution template').selectOption({ label: sp.template });
    const und = ctx.inst(sp.underlying);
    // Once the underlying, the amount and the contracts are all in place the page asks Shaffer Hedge (here the labelled
    // demo fixture) what hedge applies. Its answer can add a hedge package to the preview, so the preview is asked for
    // only after that answer has arrived.
    const hedgeAnswer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/hedge/requests', { timeout: 12_000 }).catch(() => null);
    await pickInstrument(ui, what, /^\s*(Ticker or instrument|Underlying of the options)/, und);
    await what.getByText('Current market price').first().waitFor();
    if (sp.quantity !== undefined && sp.quantity !== null) await ui.input(what, und.qtyLabel).fill(String(sp.quantity));
    const contracts = ui.section(main, 'Option contracts');
    if (sp.expiration) await ui.input(contracts, /^\s*(Expiration|Near expiration)/).fill(sp.expiration);
    if (sp.farExpiration) await ui.input(contracts, /^\s*Far expiration/).fill(sp.farExpiration);
    for (const [label, strike] of Object.entries(sp.strikes || {})) await ui.input(contracts, label).fill(String(strike));
    if (sp.contracts !== undefined && sp.contracts !== null) await ui.input(contracts, 'Contracts').fill(String(sp.contracts));
    await hedgeAnswer;
    await ui.drawn();
    const out = await previewAndConfirm(ui, ctx, () => ui.button(main, 'Preview package').click(), { expectsRefusal });
    if (out.strategy && step.as && !ctx.lots.has(step.as)) ctx.nameLot(step.as, out.strategy.id, step.instrument);
    return out;
  },
};
