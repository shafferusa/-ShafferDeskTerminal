// Browser driver for the swap family (interest-rate, overnight-index, basis, cross-currency, inflation,
// constant-maturity, total-return, equity and commodity swaps; caps, floors and collars).
//
// A swap is entered as a contract, never as "buy" or "sell": its legs, schedules, calendars,
// counterparty and the required "Collateral terms" group are typed into the contract form
// (web/lib/contracts.js), and a position is then opened with "Enter as written" or "Enter the
// opposite side". This file drives that form wherever it appears:
//
//   contractTerms()      the registry form (Instruments, New instrument): market view, calendars, effective
//                        date, maturity, counterparty, collateral terms, every leg
//   ticket()             the instrument drawer's Trade tab: Account, Enter as written / Enter the opposite
//                        side, Notional, order fields, State a fill price
//   actions.package      the Strategies page: Execution template "Custom", Add a leg, "New OTC contract",
//                        the same contract form in the leg dialog, Preview package (the OTC ticket)
//   actions.close        a termination from the strategy instance at a stated settlement amount: Preview
//   actions.resize       close (or the position's Close, or Preview resize), "state a fill price" on the
//                        leg in the preview, Re-check edited package, Confirm. Without `order.statedPrice`
//                        the shared path is used.
//   actions.manual_rate  Data connection, Manual entries, "Reference or funding rate": a fixing by hand
//   actions.owner_screens  the Accounting screens read with Treasury in scope (`owner: 'treasury'`), for a swap Treasury owns
//   actions.agreement    Treasury, Collateral, New agreement: a paper collateral agreement of the Book
//
// What a draft may state, and where it goes on the form (everything the form has):
//   marketView                     Primary view (an OTC contract is not placed by a venue)
//   conventions                    { tradingCalendar, settlementCalendar, paymentCalendar: 'USD' or 'A+B', settleLag }
//   terms.effective, maturity      Effective date, Maturity
//   terms.counterparty             Counterparty
//   terms.collateralBasis          Collateral basis: { type: 'uncollateralized' }
//                                  | { type: 'agreement', agreementId: '$agreement:<key of an agreement step>' }
//                                  | { type: 'position', independentAmount: { type: 'none' | 'pct' | 'fixed', pct, amount },
//                                      variationMargin, threshold, minimumTransfer }
//                                  (left out: nothing is chosen, to test that the Terminal refuses the trade)
//   terms.collateral               Other collateral terms (free text, recorded only)
//   terms.netSettlement            Net settlement (check box; s2)
//   terms.legs[]                   one panel per leg, added or removed to match:
//       side 'pay' | 'receive', type 'fixed' | 'float' | 'ois' | 'return' | 'price' | 'cap' | 'floor', ccy,
//       notionalFactor, rate (fixed), index and spread (float, ois), index and strike (cap, floor),
//       underlyingId '$inst:<key>' (return, price: picked by symbol in the Reference asset search), units and
//       fixedPrice (price), months 0 | 1 | 3 | 6 | 12 (Payment), dayCount, compounding (fixed leg paid at
//       maturity only), passDividends and resetNotional (return), exchangeNotional (fixed, float, ois)
//       notionalSchedule [{ from, factor }] (any leg: the "Notional schedule" box, one "date factor" a line),
//       averaging 'daily', pricingCalendar, hours 'day' | 'base' | 'peak' | 'offpeak', peakHours, peakCalendar (price legs; s2),
//       paymentLag (any leg: business days after the period end)
// Not on the form, so not typed here: the initial fixings of a return leg (`terms.initialPrices`); the API accepts them.

export const family = 'swap';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const ACTION = { buy: 'Enter as written', sell: 'Enter the opposite side' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
const VIEW = { US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives', US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };
const AGREEMENT_KIND = { bilateral: 'bilateral', cleared: 'cleared', uncollateralized: 'uncollateralized' };
const ownerName = (ctx, key) => (key === 'treasury' ? 'Treasury' : key === 'account' || !key ? ctx.spec.book.account.name : ctx.extraUnits?.get(key)?.name || key);

/** An id a draft names as '$inst:key' or '$agreement:key', resolved the way lib/actions.mjs resolves it. */
const instOf = (ctx, ref) => (typeof ref === 'string' && ref.startsWith('$inst:') ? ctx.inst(ref.slice(6)) : null);
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

const legPanel = (ui, scope, i) => scope.locator('div.panel').filter({ has: ui.page.locator('header b', { hasText: exactly(`Leg ${String.fromCharCode(65 + i)}`) }) }).first();
const checkbox = (ui, scope, label) => ui.field(scope, label).locator('input[type="checkbox"]');

/** The "Legs" editor: one panel per leg, every field of each leg set from the draft. */
async function fillLegs(ui, scope, legs, ctx) {
  const panels = scope.locator('div.panel header b', { hasText: /^Leg [A-Z]$/ });
  for (let guard = 0; guard < 20; guard++) {
    const n = await panels.count();
    if (n === legs.length) break;
    if (n < legs.length) await ui.button(scope, 'Add a leg').click();
    else await ui.button(legPanel(ui, scope, n - 1), 'Remove').click();
    await ui.drawn();
  }
  if (await panels.count() !== legs.length) throw new Error(`The contract form shows ${await panels.count()} legs; the draft has ${legs.length}.`);
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const p = legPanel(ui, scope, i);
    await ui.select(p, 'Side').selectOption(leg.side);
    await ui.select(p, 'Leg type').selectOption(leg.type);
    await ui.drawn();
    await ui.input(p, 'Currency').fill(leg.ccy);
    await ui.input(p, 'Notional factor').fill(String(leg.notionalFactor ?? 1));
    if (leg.type === 'fixed') await ui.input(p, 'Fixed rate').fill(String(leg.rate));
    if (['float', 'ois', 'cap', 'floor'].includes(leg.type)) await ui.input(p, 'Index').fill(leg.index);
    if (['float', 'ois'].includes(leg.type)) await ui.input(p, 'Spread').fill(String(leg.spread ?? 0));
    if (['cap', 'floor'].includes(leg.type)) await ui.input(p, 'Strike rate').fill(String(leg.strike));
    if (leg.type === 'price') {
      await ui.input(p, 'Units per unit of notional').fill(String(leg.units ?? 1));
      await ui.input(p, 'Fixed price').fill(leg.fixedPrice === null || leg.fixedPrice === undefined ? '' : String(leg.fixedPrice));
    }
    if ((leg.type === 'return' && !leg.basket) || leg.type === 'dividend' || (leg.type === 'price' && (leg.fixedPrice === null || leg.fixedPrice === undefined))) { // s3: dividend legs; a basket has no reference asset
      const inst = instOf(ctx, leg.underlyingId);
      if (!inst) throw new Error(`Leg ${String.fromCharCode(65 + i)}: state the reference asset as underlyingId: '$inst:<key>'.`);
      await pickInstrument(ui, ui.field(p, 'Reference asset'), inst);
    }
    await ui.select(p, /^\s*(Reset and payment|Payment)/).selectOption(String(leg.months ?? 0));
    if (!['return', 'price', 'dividend'].includes(leg.type)) await ui.select(p, 'Day count').selectOption(leg.dayCount || 'ACT/360');
    if (leg.type === 'fixed' && (leg.compounding || await ui.field(p, 'Compounding').count())) {
      await ui.drawn();
      if (await ui.field(p, 'Compounding').count()) await ui.select(p, 'Compounding').selectOption(leg.compounding || 'none');
      else if (leg.compounding) throw new Error('The form offers Compounding only on a fixed leg paid at maturity only.');
    }
    if (leg.type === 'return') {
      const options = ui.field(p, 'Options');
      await options.locator('label.check', { hasText: 'Total return' }).locator('input').setChecked(Boolean(leg.passDividends));
      await options.locator('label.check', { hasText: 'Notional resets' }).locator('input').setChecked(Boolean(leg.resetNotional));
    }
    if (['fixed', 'float', 'ois'].includes(leg.type)) await checkbox(ui, p, /^\s*Notional\s*$/).setChecked(Boolean(leg.exchangeNotional));
    else if (leg.exchangeNotional) throw new Error('The form exchanges notional on fixed, floating and overnight legs only.');
    // s2: price legs (averaging, pricing calendar, delivery hours) and the notional schedule of any leg.
    if (leg.type === 'price') {
      if (leg.fixedPrice === null || leg.fixedPrice === undefined) await ui.select(p, 'Floating price').selectOption(leg.averaging || '');
      else if (leg.averaging) throw new Error('A fixed-price leg has no averaging.');
      await ui.input(p, 'Pricing calendar').fill(leg.pricingCalendar || '');
      await ui.select(p, 'Delivery hours').selectOption(leg.hours || '');
      if (leg.hours && leg.hours !== 'day') { await ui.drawn(); await ui.input(p, 'Peak hours a day').fill(String(leg.peakHours ?? 16)); await ui.input(p, 'Peak-day calendar').fill(leg.peakCalendar || ''); }
    }
    await ui.input(p, 'Payment lag (business days)').fill(String(leg.paymentLag ?? 0));
    const sched = (leg.notionalSchedule || []).map((s) => `${s.from} ${s.factor ?? ''}`.trim()).join('\n');
    await ui.field(p, 'Notional schedule').locator('textarea').fill(sched);
    await fillPartialLeg(ui, p, leg); // s3
  }
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

/** Calendars and settlement lag of the instrument (registry form only). */
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

/**
 * The contract fields of a swap: on the registration form, and in the leg dialog of the Strategies page (the
 * same form). The registration form also takes the market view and the calendars here: an OTC contract has no
 * listing venue to decide them.
 */
export async function contractTerms(ui, dialog, draft, ctx) {
  const view = ui.field(dialog, /^\s*Primary view/);
  if (await view.count()) {
    await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
    await fillConventions(ui, dialog, draft.conventions);
  }
  const t = draft.terms || {};
  await ui.input(dialog, 'Effective date').fill(t.effective || '');
  await ui.input(dialog, /^\s*Maturity/).fill(t.maturity || '');
  if (t.counterparty) await ui.input(dialog, 'Counterparty').fill(t.counterparty);
  await fillCollateral(ui, dialog, t.collateralBasis, ctx);
  if (t.collateral) await ui.input(dialog, 'Other collateral terms').fill(t.collateral);
  if (t.netSettlement || await ui.field(dialog, 'Net settlement').count()) await checkbox(ui, dialog, 'Net settlement').setChecked(Boolean(t.netSettlement)); // s2
  await fillPartialTerms(ui, dialog, t); // s3
  await fillLegs(ui, dialog, t.legs || [], ctx);
}

/** The instrument drawer's ticket for a registered contract: Account, side, notional, order terms, stated fill price. */
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

/** Open the strategy instance of a lot, from the Accounting positions of whoever holds it. */
async function openStrategy(ui, ctx, lot, owner) {
  if (!owner || owner === 'account') return ui.openStrategy(ctx, lot.strategyId);
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/positions/${ctx.unitId(owner)}`);
  await ui.page.locator(`main a[title="Strategy instance ${lot.strategyId}"]`).first().click();
  const drawer = ui.page.getByRole('dialog').filter({ has: ui.page.locator('header h3', { hasText: /^Positions/ }) });
  await drawer.waitFor();
  return drawer;
}

/**
 * A close or resize at a stated fill price. The strategy instance has no price field: the price is typed on the
 * leg in the preview ("state a fill price"), the edited package is checked again, and that second preview is
 * the one read, compared and confirmed.
 */
async function atStatedPrice(ui, t, ctx, step, { previewAndConfirm, expectsRefusal, positionRow }) {
  const price = step.order?.statedPrice;
  const owner = step.owner || 'account';
  if ((price === undefined || price === null) && owner === 'account') return undefined; // the shared path
  const lot = ctx.lot(step.lot);
  const drawer = await openStrategy(ui, ctx, lot, owner);
  let first;
  if (step.action === 'resize') {
    await ui.input(drawer, 'Resize, multiple of the current size').fill(String(step.factor));
    first = () => ui.button(drawer, 'Preview resize').click();
  } else if (step.scope === 'position') {
    if ((step.percent ?? 100) !== 100) throw new Error('The Close button on a position closes all of it; use the strategy share for a part.');
    const row = positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
    first = () => ui.button(row, 'Close').click();
  } else {
    await ui.input(drawer, 'Close, share of every position').fill(String(step.percent ?? 100));
    first = () => ui.button(drawer, 'Preview close').click();
  }
  if (price === undefined || price === null) return previewAndConfirm(ui, ctx, first, { expectsRefusal });
  // One "state a fill price" box per trade leg, in the Estimated fill column of the preview. The shared code then
  // presses "Re-check edited package" and reads, compares and confirms the re-checked preview.
  return previewAndConfirm(ui, ctx, first, {
    expectsRefusal,
    edit: async (modal) => {
      const boxes = modal.locator('td.fillcell .row', { hasText: 'state a fill price' }).locator('input');
      const n = await boxes.count();
      if (!n) throw new Error('The preview shows no leg that takes a stated fill price.');
      for (let i = 0; i < n; i++) await boxes.nth(i).fill(String(price));
      await ui.drawn();
    },
  });
}

/** The Strategies page as the OTC ticket: template "Custom", one "New OTC contract" leg per contract leg of the step's input. */
async function strategiesPage(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
  const { page } = ui;
  const input = step.input || {};
  if (input.attachTo || (input.template && input.template !== 'custom')) return undefined; // not this path
  const legs = input.legs || [];
  if (!legs.length || !legs.every((l) => l.kind === 'trade' && l.contract && l.contract.productId)) return undefined;
  await ui.closeOverlays();
  await ui.reloadAt('#/strategy');
  const main = page.locator('main');
  await ui.select(main, 'Account').selectOption({ label: ownerName(ctx, step.owner) });
  await ui.select(main, 'Execution template').selectOption('custom');
  await ui.drawn();
  const { getProduct } = await import('../../../../server/core/catalog.js');
  for (const leg of legs) {
    const c = leg.contract;
    const product = getProduct(c.productId);
    if (product.family !== 'swap') throw new Error(`The swap driver enters swap-family contracts on the Strategies page; ${c.productId} is ${product.family}.`);
    await ui.button(ui.section(main, /^Legs/), 'Add a leg').click();
    const dlg = ui.dialog('Add a leg');
    await dlg.waitFor();
    await ui.select(dlg, /^\s*Leg\s*$/).selectOption('contract');
    if (leg.purpose === 'hedge') await ui.option(dlg, 'Purpose', 'Hedge').click();
    const productSelect = ui.select(dlg, 'Product');
    await productSelect.locator(`option[value="${c.productId}"]`).waitFor({ state: 'attached' });
    await productSelect.selectOption(c.productId);
    await ui.input(dlg, 'Contract name').waitFor();
    await ui.input(dlg, 'Contract name').fill(c.name);
    // The first Currency field of the dialog is the contract's; each leg panel has its own.
    await dlg.locator('.field').filter({ has: page.locator('label', { hasText: exactly('Currency') }) }).first().locator('input').fill(c.tradingCcy);
    await contractTerms(ui, dlg, c, ctx);
    await ui.select(dlg, /^\s*Side\s*$/).first().selectOption(leg.action);
    await ui.input(dlg, 'Notional').first().fill(String(leg.qty));
    if (leg.orderType && leg.orderType !== 'market') await ui.select(dlg, 'Order type').selectOption({ label: ORDER_TYPE[leg.orderType] });
    if (leg.statedPrice !== undefined && leg.statedPrice !== null) await ui.input(dlg, 'State a fill price').fill(String(leg.statedPrice));
    await ui.button(dlg, 'Add leg').click();
    if (await dlg.locator('.notice.err').count()) {
      const message = (await dlg.locator('.notice.err').first().innerText()).trim();
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message, where: 'Add a leg dialog' } };
    }
    await dlg.waitFor({ state: 'hidden' });
  }
  const preview = ui.button(main, 'Preview package');
  const out = await previewAndConfirm(ui, ctx, async () => {
    const asked = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/strategies/preview');
    await preview.click();
    const res = await asked;
    // A request the server refuses outright is shown as a message on the page, which is what the shared code looks for.
    if (!res.ok()) await main.locator('.notice.err').first().waitFor();
  }, { expectsRefusal });
  if (out.strategy) {
    if (step.as && !ctx.lots.has(step.as)) ctx.nameLot(step.as, out.strategy.id, step.instrument || [].concat(step.contractAs || [])[0]);
    // The contract was registered by the confirmation: give it the key the step names, as lib/actions.mjs does.
    const keys = [].concat(step.contractAs || []);
    const made = out.strategy.orders.filter((o) => o.kind === 'trade' && o.instrument?.id).slice(-legs.length);
    for (let i = 0; i < keys.length; i++) {
      if (!keys[i] || !made[i]) continue;
      ctx.instruments[keys[i]] = await t.getInstrument(made[i].instrument.id);
      ctx.idToKey.set(made[i].instrument.id, keys[i]);
    }
  }
  return out;
}

export const actions = {
  close: atStatedPrice,
  resize: atStatedPrice,
  // s3: a package of registered instruments (an asset swap: the bond and its swap) when the legs are not new contracts.
  package: async (ui, t, ctx, step, tools) => (await strategiesPage(ui, t, ctx, step, tools)) ?? instrumentLegsPackage(ui, t, ctx, step, tools),
  manual_fx: (...args) => manualFx(...args), // s3
  basket_level: (...args) => basketLevel(...args), // s3
  lifecycle: (...args) => partialLifecycle(...args), // s3: call or put exercised, loan pass-through; anything else falls through

  /**
   * The Accounting screens read in Treasury's scope (`owner: 'treasury'`). The shared check after every step reads the
   * tabs of the scenario's Account; a scenario whose swap belongs to Treasury adds this step where it wants Treasury's
   * own screens compared with the API's figures for Treasury (cash, positions, holdings, pending, P&L, balance sheet).
   */
  async owner_screens(ui, t, ctx, step) {
    if (step.owner !== 'treasury') throw new Error('owner_screens reads the screens of Treasury: state `owner: \'treasury\'`.');
    const { readScreens, screenProblems } = await import('../browser.mjs');
    const { observeState } = await import('../../lib/normalize.mjs');
    // The shared readers work on "the scenario's Account": hand them Treasury in that place.
    const as = Object.create(ctx);
    as.accountId = ctx.treasuryId;
    as.ownerKey = (unitId) => (unitId === ctx.treasuryId ? 'account' : unitId === ctx.accountId ? 'other' : unitId);
    await ui.closeOverlays();
    const state = await observeState(t, as);
    const screen = await readScreens(ui, as, t);
    return { problems: screenProblems(as, screen, { expected: {}, state, events: [] }).map((m) => `Treasury's screens: ${m}`) };
  },

  /** A reference-rate fixing entered by hand: Data connection, Manual entries, "Reference or funding rate". */
  async manual_rate(ui, t, ctx, step) {
    await ui.closeOverlays();
    await ui.goto('#/data/manual');
    const panel = ui.section(ui.page.locator('main'), 'Reference or funding rate');
    await panel.waitFor();
    await ui.input(panel, 'Rate code').fill(step.code);
    await ui.input(panel, 'Value (percent a year)').fill(String(step.value));
    await ui.input(panel, 'Fixing date').fill(step.date || '');
    if (step.note) await ui.input(panel, 'Note').fill(step.note);
    const r = await ui.respondsTo('POST', /^\/api\/observations$/, () => ui.button(panel, 'Save rate').click());
    if (!r.ok) {
      await panel.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: r.body?.error, status: r.status, where: 'manual rate form message' } };
    }
    await ui.toast(/Rate saved/);
    return {};
  },

  /** A paper collateral agreement: Treasury, Collateral, New agreement. */
  async agreement(ui, t, ctx, step) {
    const { page } = ui;
    const a = step.agreement;
    await ui.closeOverlays();
    await ui.reloadAt('#/treasury/collateral');
    await ui.button(page.locator('main'), 'New agreement').first().click();
    const dlg = ui.dialog('New collateral agreement');
    await dlg.waitFor();
    await ui.input(dlg, 'Agreement name').fill(a.name);
    await ui.input(dlg, 'Counterparty').fill(a.counterparty);
    await ui.select(dlg, 'Kind').selectOption(AGREEMENT_KIND[a.kind || 'bilateral']);
    const covers = (a.covers || ['account']).map((k) => ownerName(ctx, k));
    for (const box of await ui.field(dlg, 'Covers').locator('label.check').all()) {
      const name = (await box.innerText()).trim();
      await box.locator('input').setChecked(covers.includes(name));
    }
    if ((a.kind || 'bilateral') !== 'uncollateralized') {
      const ia = a.independentAmount || { type: 'none' };
      await ui.select(dlg, /^\s*(Independent amount|Initial margin)/).selectOption(ia.type || 'none');
      if (ia.type === 'pct') await ui.input(dlg, 'Share of notional').fill(String(ia.pct));
      if (ia.type === 'fixed') await ui.input(dlg, 'Amount per position').fill(String(ia.amount));
      await checkbox(ui, dlg, 'Variation margin').setChecked(Boolean(a.variationMargin));
      // Currencies first: the labels of the amounts name the base currency.
      const base = a.baseCcy || ctx.spec.book.reportingCcy;
      await ui.input(dlg, 'Base currency').fill(base);
      await ui.input(dlg, 'Collateral currency').fill(a.postingCcy || base);
      if (a.kind !== 'cleared') await ui.input(dlg, 'Threshold').fill(String(a.threshold ?? 0));
      await ui.input(dlg, 'Minimum transfer').fill(String(a.minimumTransfer ?? 0));
      await ui.input(dlg, 'Haircut').fill(String(a.haircut ?? 0));
      await ui.select(dlg, 'Netting scope').selectOption(a.nettingScope || 'position');
      await ui.select(dlg, 'Posted and received by').selectOption(a.postedBy ? ctx.unitId(a.postedBy) : '');
    }
    const r = await ui.respondsTo('POST', /^\/api\/books\/[^/]+\/agreements$/, () => ui.button(dlg, 'Record agreement').click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      const message = (await dlg.locator('.notice.err').first().innerText()).trim();
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message, status: r.status, where: 'New collateral agreement dialog' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    ctx.agreements.set(step.as || a.name, { id: r.body.id, name: r.body.name });
    return {};
  },
};

// ---------------------------------------------------------------------------------------------
// s3: the swaps marked partial (non-deliverable, CMS spread, callable and puttable, quanto, basket, loan TRS, dividend)
// ---------------------------------------------------------------------------------------------
const has = (v) => v !== undefined && v !== null && v !== '';

/** Contract fields of a non-deliverable swap (settlement currency, fixing lag) and of a callable or puttable swap (its right). */
async function fillPartialTerms(ui, dialog, t) {
  if (t.settlementCcy) await ui.input(dialog, /^\s*Settlement currency \(non-deliverable\)/).fill(t.settlementCcy); // not the registry's own Settlement currency
  if (has(t.fixingLag)) await ui.input(dialog, 'FX fixing lag').fill(String(t.fixingLag));
  if (t.callRight) {
    await ui.input(dialog, 'Exercise dates').fill([].concat(t.callRight.dates || []).join('; '));
    await ui.select(dialog, 'Right held by').selectOption(t.callRight.by || 'written');
  }
}

/** Leg fields: a CMS spread's second index, a dividend leg's units, a basket instead of a reference asset, a quanto conversion. */
async function fillPartialLeg(ui, p, leg) {
  if (leg.index2) await ui.input(p, 'Minus index').fill(leg.index2);
  if (leg.type === 'dividend') await ui.input(p, 'Units per unit of notional').fill(String(leg.units ?? 1));
  if (leg.type === 'return' && leg.basket) {
    const text = Array.isArray(leg.basket) ? leg.basket.map((b) => `${b.name}: ${b.weight}`).join('; ') : leg.basket;
    await ui.input(p, 'Basket instead of a reference asset').fill(text);
    await ui.drawn();
    await ui.input(p, 'Initial basket level').fill(String(leg.initialLevel));
  }
  if (leg.quantoCcy) {
    await ui.input(p, 'Quanto currency').fill(leg.quantoCcy);
    await ui.drawn();
    await ui.input(p, 'Fixed conversion rate').fill(String(leg.quantoRate));
  }
}

/** An FX fixing entered by hand for its date: Data connection, Manual entries, FX rate (`pair: 'USD/INR'`, `rate`, `date`). */
async function manualFx(ui, t, ctx, step) {
  await ui.closeOverlays();
  await ui.goto('#/data/manual');
  const panel = ui.section(ui.page.locator('main'), 'FX rate');
  await panel.waitFor();
  const [base, quote] = String(step.pair).split('/');
  await ui.input(panel, 'Base currency').fill(base);
  await ui.input(panel, 'Quote currency').fill(quote);
  await ui.drawn();
  await ui.input(panel, /^\s*Rate/).fill(String(step.rate));
  await ui.input(panel, 'FX fixing date').fill(step.date || '');
  if (step.note) await ui.input(panel, 'Note').fill(step.note);
  const r = await ui.respondsTo('POST', /^\/api\/observations$/, () => ui.button(panel, 'Save FX rate').click());
  if (!r.ok) {
    await panel.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
    return { refusal: { message: r.body?.error, status: r.status, where: 'FX rate form message' } };
  }
  await ui.toast(/FX rate saved/);
  return {};
}

/** The level of a basket at a reset, entered on the blocked payment item: Accounting, Pending, Lifecycle items. */
async function basketLevel(ui, t, ctx, step) {
  const lot = ctx.lot(step.lot);
  const inst = ctx.inst(step.instrument || lot.instrument);
  await ui.closeOverlays();
  await ui.reloadAt(`#/accounting/pending/${ctx.strategyUnits?.get(lot.strategyId) || ctx.accountId}`);
  const section = ui.section(ui.page.locator('main'), 'Lifecycle items');
  await section.waitFor();
  const row = section.locator('tbody tr').filter({ hasText: inst.symbol || inst.name }).filter({ has: ui.page.getByRole('button', { name: 'Save basket level' }) }).first();
  if (!await row.count()) return { refusal: { message: `No lifecycle item of ${inst.symbol || inst.name} asks for a basket level.`, where: 'Accounting, Pending, Lifecycle items' } };
  await row.locator('input').first().fill(String(step.value));
  const r = await ui.respondsTo('POST', /^\/api\/tasks\/[^/]+\/settlement-amount$/, () => ui.button(row, 'Save basket level').click());
  if (!r.ok) return { refusal: { message: r.body?.error, status: r.status, where: 'Pending, basket level' } };
  await ui.toast(/Basket level saved/);
  return {};
}

/** A swap position's own events from its Lifecycle menu: the exercise of a call or put, a loan pass-through. */
const PARTIAL_FORMS = {
  call_exercise: { menu: 'Call exercised', button: 'Record exercise' },
  put_exercise: { menu: 'Put exercised', button: 'Record exercise' },
  pass_through: { menu: 'Loan pass-through', button: 'Record pass-through' },
};
async function partialLifecycle(ui, t, ctx, step, tools) {
  const b = step.body || {};
  const f = PARTIAL_FORMS[b.action];
  if (!f) return undefined;
  const lot = ctx.lot(step.lot);
  const drawer = await openStrategy(ui, ctx, lot, step.owner);
  const row = tools.positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
  if (!await row.count()) return { refusal: { message: 'The strategy instance lists no open position to record it on.', where: 'strategy instance, Positions' } };
  const menu = row.locator('select').first();
  try { await menu.locator('option', { hasText: f.menu }).first().waitFor({ state: 'attached', timeout: 8000 }); } catch { /* reported below */ }
  const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
  if (!offered.includes(f.menu)) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "${f.menu}" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
  await menu.selectOption({ label: f.menu });
  const dlg = ui.dialog(new RegExp(`^${f.menu}`));
  await dlg.waitFor();
  if (b.action === 'pass_through') {
    await ui.select(dlg, 'Pass-through').selectOption(b.kind);
    await ui.drawn();
    if (b.kind === 'interest') await ui.input(dlg, 'Interest per 100 of notional').fill(String(b.amount));
    else {
      await ui.input(dlg, 'Share of the notional repaid').fill(String(b.share));
      if (has(b.price)) await ui.input(dlg, 'Repayment price').fill(String(b.price));
    }
    if (b.note) await ui.input(dlg, 'Note').fill(b.note);
  } else await ui.select(dlg, 'Exercised by').selectOption(b.by || 'us');
  const record = ui.button(dlg, f.button);
  if (await record.isDisabled()) { await ui.button(dlg, 'Cancel').click(); return { refusal: { message: `The "${f.button}" button is disabled: the dialog is missing an amount it needs.`, where: `${f.menu} dialog` } }; }
  const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => record.click());
  if (!r.ok) {
    await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
    const message = (await dlg.locator('.notice.err').first().innerText()).trim();
    await ui.button(dlg, 'Cancel').click();
    return { refusal: { message, status: r.status, where: 'dialog message' } };
  }
  await dlg.waitFor({ state: 'hidden' });
  return {};
}

/**
 * A package of registered instruments on the Strategies page (an asset swap: the bond and the swap): Trading owner, template
 * Custom, "Add a leg" with Leg "Registered instrument" for each (instrument, side, quantity, stated fill price), Preview package.
 */
async function instrumentLegsPackage(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
  const input = step.input || {};
  const legs = input.legs || [];
  if ((input.template && input.template !== 'custom') || input.attachTo || !legs.length || !legs.every((l) => l.kind === 'trade' && String(l.instrumentId || '').startsWith('$inst:'))) return undefined;
  const { page } = ui;
  await ui.closeOverlays();
  await ui.reloadAt('#/strategy');
  const main = page.locator('main');
  await ui.select(main, 'Account').selectOption({ label: ownerName(ctx, step.owner) });
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
    if (has(leg.statedPrice)) await ui.input(dlg, 'State a fill price').fill(String(leg.statedPrice));
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
  if (out.strategy?.id && out.strategy.unit?.id) (ctx.strategyUnits ||= new Map()).set(out.strategy.id, out.strategy.unit.id);
  return out;
}
