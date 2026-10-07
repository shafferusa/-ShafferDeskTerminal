// Browser ticket driver for the bond family (debt securities: bills, notes, bonds, zeros, floating-rate
// notes, securitised paper, loans held at a price). Everything that is not particular to a debt
// security (the preview and its confirmation, the strategy instance, manual cash flows, the Accounting
// readers) is shared and lives in ../browser.mjs. The contract of a family driver is described at the
// top of ./equity.mjs.
//
// What this file supports
//   contractTerms   every field of the registration form that the shared code does not fill:
//     - "Traded on: Exchange" for a listed bond (the form starts a bond as OTC), `venueType: 'exchange'`
//     - "Settlement currency", `settleCcy` (only when it differs from the trading currency)
//     - "Calendars and settlement", `conventions: { tradingCalendar, settlementCalendar, paymentCalendar, settleLag }`
//       (a joint calendar is written 'A+B', as in the form)
//     - "Primary view" for an OTC bond, from `marketView` (an exchange-listed bond is placed by its venue country)
//     - every bond contract field, from `terms`:
//         couponType ('fixed' | 'zero' | 'float'), couponRate, referenceRate, spread, currentCoupon,
//         frequency (1, 2, 4, 12), perpetual, maturity, anchorDate, issueDate, dayCount, redemption,
//         factor, minDenomination, seniority
//       A term the form has no field for (datedDate, firstCouponDate, eom, calendar, settleDays) cannot be
//       registered in the interface: contractTerms throws and names it, so a spec cannot pass at engine level on a term
//       a user could not have entered. Use `conventions.settleLag` for a settlement lag.
//   ticket          the security ticket of the instrument drawer: Account (or Treasury, `owner: 'treasury'`), Action
//                   (Buy, Sell, Sell short, Buy to cover), the position to reduce (`from`), Face amount, order type
//                   with limit and stop prices, time in force, a stated fill price, the Settlement field
//                   (`order.settle: { date }` or `{ lag }`), the borrow assumption of a short sale when no borrow data
//                   is supplied (`borrow: { feeRate }`), and "If cash is short" (`financing: { mode: 'treasury' }` or
//                   `{ mode: 'loan', rate }`). It returns a refusal when the ticket itself will not go on (an action
//                   that is not offered or is disabled, a disabled Preview button, a settlement conflict shown on the
//                   Settlement field).
//
// What it does not do (add it here, in `actions`, when a product needs it)
//   - Lifecycle events recorded by hand that have their own dialog: early redemption (call, put, tender), principal
//     paydown (pool factor), coupon suspension, conversion. Manual cash flows work through the shared path.
//   - Editing an instrument after registration (a fixing entered on a floating-rate note, a changed calendar).

export const family = 'bond';

const ACTION = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based', US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives' };
/** Contract terms the registration form has a field for. `calendar` and `settleDays` are engine terms with no field: use `conventions`. */
const FORM_TERMS = new Set(['couponType', 'couponRate', 'referenceRate', 'spread', 'currentCoupon', 'frequency', 'perpetual', 'maturity', 'anchorDate', 'issueDate', 'dayCount', 'redemption', 'factor', 'minDenomination', 'seniority']);
const has = (v) => v !== undefined && v !== null && v !== '';

/** One calendar role of "Calendars and settlement": a built-in calendar by its id, or a joint calendar typed as A+B. */
async function chooseCalendar(ui, dialog, label, id) {
  if (!has(id)) return;
  const field = ui.field(dialog, label);
  if (String(id).includes('+')) {
    await field.locator('select').first().selectOption('+');
    await field.locator('input').first().fill(String(id));
  } else await field.locator('select').first().selectOption(String(id));
}

/** The parts of the registration form that are particular to a debt security. */
export async function contractTerms(ui, dialog, draft) {
  const t = draft.terms || {};
  const unknown = Object.keys(t).filter((k) => !FORM_TERMS.has(k));
  if (unknown.length) throw new Error(`The registration form has no field for the bond term${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. A scenario may only state terms a user can enter (see the header of drivers/browser/bond.mjs).`);

  // ---- venue, currency, calendars, market view ----
  if (draft.venueType === 'exchange') await ui.option(dialog, 'Traded on', 'Exchange').click();
  if (has(draft.settleCcy) && draft.settleCcy !== draft.tradingCcy) await ui.input(dialog, 'Settlement currency').fill(draft.settleCcy);
  const c = draft.conventions || {};
  await chooseCalendar(ui, dialog, 'Trading calendar', c.tradingCalendar);
  await chooseCalendar(ui, dialog, 'Settlement calendar', c.settlementCalendar);
  await chooseCalendar(ui, dialog, 'Payment calendar', c.paymentCalendar);
  if (has(c.settleLag)) await ui.input(dialog, 'Settlement convention').fill(String(c.settleLag));
  // An OTC bond has no listing venue to place it: the primary view is chosen by hand. A listed one is placed by its venue country.
  const view = ui.option(dialog, 'Primary view', VIEW[draft.marketView]);
  if (!await view.isDisabled() && !/\bon\b/.test((await view.getAttribute('class')) || '')) await view.click();

  // ---- contract terms ----
  const type = t.couponType || (Number(t.couponRate) > 0 ? 'fixed' : null);
  if (type) await ui.select(dialog, 'Coupon').selectOption(type);
  await ui.drawn();
  if (has(t.couponRate)) await ui.input(dialog, 'Coupon rate').fill(String(t.couponRate));
  if (has(t.referenceRate)) await ui.input(dialog, 'Reference rate code').fill(String(t.referenceRate));
  if (has(t.spread)) await ui.input(dialog, 'Spread').fill(String(t.spread));
  if (has(t.currentCoupon)) await ui.input(dialog, 'Current coupon').fill(String(t.currentCoupon));
  if (has(t.frequency) && type !== 'zero' && Number(t.frequency) > 0) await ui.select(dialog, 'Payments per year').selectOption(String(t.frequency));
  if (t.perpetual) {
    await ui.field(dialog, 'Perpetual').locator('input[type=checkbox]').check();
    await ui.drawn();
    if (has(t.anchorDate)) await ui.input(dialog, 'A coupon date').fill(t.anchorDate);
  } else if (has(t.maturity)) await ui.input(dialog, 'Maturity').fill(t.maturity);
  if (has(t.issueDate)) await ui.input(dialog, 'Issue (dated) date').fill(t.issueDate);
  if (has(t.dayCount)) await ui.select(dialog, 'Day count').selectOption(t.dayCount);
  if (has(t.redemption)) await ui.input(dialog, 'Redemption').fill(String(t.redemption));
  if (has(t.factor)) await ui.input(dialog, 'Pool factor').fill(String(t.factor));
  if (has(t.minDenomination)) await ui.input(dialog, 'Minimum denomination').fill(String(t.minDenomination));
  if (has(t.seniority)) await ui.input(dialog, 'Seniority').fill(String(t.seniority));
}

/** The security ticket in the instrument drawer, for a debt security. */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
  await ui.select(drawer, 'Account').selectOption({ label: owner });
  await ui.drawn();

  const action = ui.option(drawer, 'Action', ACTION[step.side]);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${ACTION[step.side]}" for ${inst.symbol || inst.name} in ${owner}.`, where: 'ticket, Action' } };
  if (await action.isDisabled()) return { refusal: { message: (await action.getAttribute('title')) || `"${ACTION[step.side]}" is disabled on the ticket.`, where: 'ticket, Action disabled' } };
  await action.click();

  // A sale or a cover reduces one position. With more than one to choose from, the ticket asks which.
  if (step.side === 'sell' || step.side === 'buy_to_cover') {
    const lot = ctx.lot(step.from);
    const held = (await t.strategy(lot.strategyId)).positions.find((p) => p.instrument.id === inst.id);
    if (!held) throw new Error(`"${step.from}" holds no ${inst.symbol || inst.name} to ${step.side === 'sell' ? 'sell' : 'cover'}.`);
    const which = ui.field(drawer, step.side === 'sell' ? 'Sell from' : 'Cover').locator('select');
    if (await which.count()) await which.first().selectOption(held.positionId);
  }

  await ui.input(drawer, inst.qtyLabel).fill(String(step.qty)); // "Face amount"
  const o = step.order || {};
  if (o.orderType && o.orderType !== 'market') await ui.select(drawer, 'Order type').selectOption({ label: ORDER_TYPE[o.orderType] });
  if (has(o.limitPrice)) await ui.input(drawer, 'Limit price').fill(String(o.limitPrice));
  if (has(o.stopPrice)) await ui.input(drawer, 'Stop price').fill(String(o.stopPrice));
  if (o.tif && o.tif !== 'day') await ui.select(drawer, 'Time in force').selectOption({ label: TIF[o.tif] });
  if (has(o.statedPrice)) await ui.input(drawer, 'State a fill price').fill(String(o.statedPrice));

  // Settlement stated for this trade alone: a date or a lag in business days. The ticket checks it against the
  // settlement calendar as it is typed and shows a conflict on the field.
  if (o.settle) {
    const field = ui.field(drawer, /^Settlement\s*$/);
    const answered = ui.page.waitForResponse((r) => /\/api\/instruments\/[^/]+\/settlement$/.test(new URL(r.url()).pathname));
    if (has(o.settle.date)) {
      await field.locator('select').first().selectOption('date');
      await field.locator('input[type=date]').fill(String(o.settle.date));
    } else {
      await field.locator('select').first().selectOption('lag');
      await field.locator('input.num').fill(String(o.settle.lag));
    }
    await answered;
    await ui.drawn();
    const conflict = field.locator('.err');
    if (await conflict.count()) return { refusal: { message: (await conflict.first().innerText()).trim(), where: 'ticket, Settlement field' } };
  }

  if (step.side === 'sell_short' && step.borrow) {
    // Only when no borrow data is supplied does the ticket ask for an assumption.
    await ui.input(drawer, 'Borrow fee').fill(String(step.borrow.feeRate));
  }
  if (step.financing && step.financing.mode !== 'none') {
    await drawer.getByRole('button', { name: /^Show funding and hedge context/ }).click();
    await ui.select(drawer, 'If cash is short').selectOption(step.financing.mode);
    if (step.financing.mode === 'loan') await ui.input(drawer, 'Loan rate').fill(String(step.financing.rate));
  }

  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) {
    const notices = (await drawer.locator('.notice').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
    return { refusal: { message: notices.join(' | ') || 'The Preview button is disabled and the ticket gives no reason.', where: 'ticket, Preview disabled' } };
  }
  return { preview: () => preview.click() };
}

/**
 * Step actions of this family's own.
 *
 * owner_screens ({ owner: 'treasury' })  The shared screen check after every step reads the Accounting tabs in the
 *   scope of the scenario's Account. A scenario whose positions belong to Treasury adds this step where it wants the
 *   screens checked: the same tabs are read in Treasury's scope (cash strip, positions, holdings, pending trades,
 *   P&L, balance sheet, borrowings, history) and every figure is compared with the API's figures for Treasury, to the
 *   decimals shown. The spec's own figures are compared with the API after every step as always, so the three agree.
 */
export const actions = {
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
};
