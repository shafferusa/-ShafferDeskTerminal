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
//   actions.lifecycle   an early redemption recorded by hand (issuer call, investor put, tender): the position's
//                   Lifecycle menu in the strategy instance, "Early redemption", then the dialog's Redemption price,
//                   Face amount redeemed and Label. Spec step: `{ action: 'lifecycle', lot, body: { action: 'redeem',
//                   price, face, label } }`. A refusal shown in the dialog is returned as the step's refusal.
//   actions.owner_screens   the Accounting screens read with Treasury in scope (`owner: 'treasury'`).
//
// What it does not do (add it here, in `actions`, when a product needs it)
//   - The other lifecycle events recorded by hand: principal paydown (pool factor), coupon suspension, conversion.
//     Manual cash flows work through the shared path.
//   - Editing an instrument after registration (a fixing entered on a floating-rate note, a changed calendar).

export const family = 'bond';

const ACTION = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based', US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives' };
/** Contract terms the registration form has a field for. `calendar` and `settleDays` are engine terms with no field: use `conventions`. */
const FORM_TERMS = new Set(['couponType', 'couponRate', 'referenceRate', 'spread', 'currentCoupon', 'frequency', 'perpetual', 'maturity', 'anchorDate', 'issueDate', 'dayCount', 'redemption', 'factor', 'minDenomination', 'seniority',
  // structured debt (added by b3): inflation-linked, callable, puttable, convertible and exchangeable bonds, securitised paper
  'indexRatio', 'inflationFloor', 'callSchedule', 'putSchedule', 'conversionRatio', 'paymentDelayDays', 'guarantor']);
const has = (v) => v !== undefined && v !== null && v !== '';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A call or put schedule as the form takes it: "2028-06-15 101; 2029-06-15 100". */
const scheduleText = (rows) => (Array.isArray(rows) ? rows.map((r) => `${r.date} ${r.price}`).join('; ') : String(rows));

/** Choose a registered instrument in an instrument picker of the form. */
async function pickInstrument(ui, scope, label, inst) {
  const field = ui.field(scope, label);
  const change = field.getByRole('button', { name: /^\s*Change\s*$/ });
  if (await change.count()) await change.click();
  await field.getByPlaceholder('Type a ticker or name').fill(inst.symbol || inst.name);
  await field.getByRole('button', { name: new RegExp(`^\\s*${esc(inst.symbol || inst.name)}(\\s|$)`) }).first().click();
  await field.locator('b', { hasText: inst.symbol || inst.name }).first().waitFor();
}

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
export async function contractTerms(ui, dialog, draft, ctx) {
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
  // ---- structured debt (b3) ----
  if (has(t.indexRatio)) await ui.input(dialog, 'Index ratio').fill(String(t.indexRatio));
  if (t.inflationFloor) await ui.field(dialog, 'Deflation floor').locator('input[type=checkbox]').check();
  if (has(t.callSchedule)) await ui.input(dialog, 'Call schedule').fill(scheduleText(t.callSchedule));
  if (has(t.putSchedule)) await ui.input(dialog, 'Put dates and prices').fill(scheduleText(t.putSchedule));
  if (draft.underlying) await pickInstrument(ui, dialog, /^\s*Shares delivered on conversion/, ctx.inst(draft.underlying));
  if (has(t.conversionRatio)) await ui.input(dialog, 'Conversion ratio').fill(String(t.conversionRatio));
  if (has(t.paymentDelayDays)) await ui.input(dialog, 'Payment delay').fill(String(t.paymentDelayDays));
  if (has(t.guarantor)) await ui.input(dialog, 'Guarantor').fill(String(t.guarantor));
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
/**
 * Lifecycle events recorded by hand on the instrument form (b3): the fields each fills, its Review and confirm buttons
 * and the toast that says it was recorded. Spec step: `{ action: 'instrument_lifecycle', instrument, body: { action, ... } }`.
 */
const MANUAL_FORMS = {
  index_ratio: { fields: (b) => [['New index ratio', b.ratio], ['Index ratio as of', b.asOf]], review: 'Review index ratio', confirm: 'Record index ratio', done: /Index ratio recorded/ },
  call: { fields: (b) => [['Call price', b.price], ['Share of the issue called', b.share]], review: 'Review issuer call', confirm: 'Record issuer call', done: /Issuer call recorded/ },
  writedown: { fields: (b) => [['Principal written down to', b.newFactor], ['Write-down effective from', b.effective]], select: (b) => [['Kind of write-down', b.kind]], review: 'Review write-down', confirm: 'Record write-down', done: /Write-down recorded/ },
};

/**
 * Position events recorded by hand from the Lifecycle menu (b3): the menu entry, the dialog's fields and its button.
 * Spec step: `{ action: 'lifecycle', lot, instrument?, body: { action: 'put', face, label } }` or
 * `{ ..., body: { action: 'convert', face, sharePrice, settlement: 'shares' | 'cash' } }`.
 */
const POSITION_FORMS = {
  put: { menu: 'Holder put', fields: (b) => [['Face amount put', b.face], ['Label', b.label]], button: 'Record holder put' },
  convert: { menu: 'Conversion into shares', fields: (b) => [['Face amount converted', b.face], ['Share price', b.sharePrice]], select: (b) => [['Settlement', b.settlement]], button: 'Record conversion' },
};
async function positionForm(ui, ctx, step, { positionRow }) {
  const f = POSITION_FORMS[step.body.action];
  const lot = ctx.lot(step.lot);
  const drawer = await ui.openStrategy(ctx, lot.strategyId);
  const row = positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
  const menu = row.locator('select').first();
  // The menu lists what the position's terms allow once they have loaded.
  await menu.locator('option', { hasText: f.menu }).first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
  if (!offered.includes(f.menu)) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "${f.menu}" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
  await menu.selectOption({ label: f.menu });
  const dlg = ui.dialog(new RegExp(`^${f.menu}`));
  for (const [label, value] of f.fields(step.body)) if (has(value)) await ui.input(dlg, label).fill(String(value));
  if (f.select) for (const [label, value] of f.select(step.body)) if (has(value)) await ui.select(dlg, label).selectOption(value);
  const record = ui.button(dlg, f.button);
  if (await record.isDisabled()) {
    await ui.button(dlg, 'Cancel').click();
    return { refusal: { message: `The "${f.button}" button is disabled: the dialog is missing an amount it needs.`, where: `${f.menu} dialog` } };
  }
  const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => record.click());
  if (!r.ok) {
    await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
    return { refusal: { message: r.body?.error, status: r.status, where: 'dialog message' } };
  }
  await dlg.waitFor({ state: 'hidden' });
  return {};
}

export const actions = {
  /**
   * An early redemption recorded by hand from the position's Lifecycle menu. Any other lifecycle event is handed
   * back to the shared path (which records manual cash flows and names what it does not do yet).
   */
  async lifecycle(ui, t, ctx, step, tools) {
    if (POSITION_FORMS[step.body?.action]) return positionForm(ui, ctx, step, tools);
    if (step.body?.action !== 'redeem') return undefined;
    const { positionRow } = tools;
    const lot = ctx.lot(step.lot);
    const drawer = await ui.openStrategy(ctx, lot.strategyId);
    const row = positionRow(drawer, ctx.inst(step.instrument || lot.instrument));
    const menu = row.locator('select').first();
    const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
    if (!offered.includes('Early redemption')) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "Early redemption" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
    await menu.selectOption({ label: 'Early redemption' });
    const dlg = ui.dialog(/^Early redemption/);
    await ui.input(dlg, 'Redemption price (% of par)').fill(String(step.body.price));
    // The dialog starts with the whole position as the face redeemed.
    if (step.body.face !== undefined && step.body.face !== null) await ui.input(dlg, 'Face amount redeemed').fill(String(step.body.face));
    if (step.body.label) await ui.input(dlg, 'Label').fill(step.body.label);
    const record = ui.button(dlg, 'Record early redemption');
    if (await record.isDisabled()) return { refusal: { message: 'The "Record early redemption" button is disabled: the dialog needs a redemption price of zero or more and a face amount above zero.', where: 'Early redemption dialog' } };
    const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => record.click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      return { refusal: { message: r.body?.error, status: r.status, where: 'dialog message' } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },
  /**
   * A lifecycle event recorded by hand on the instrument itself (added by b2): coupon suspension and its resumption
   * (`body: { action: 'suspend_coupon', suspended: true | false }`), and a principal paydown (`body: { action: 'paydown',
   * newFactor }`). The instrument drawer's Edit button opens the instrument form; its "Lifecycle events recorded by hand"
   * part asks for a review and then a confirmation, which posts the event. Other actions fall through to the shared path.
   */
  async instrument_lifecycle(ui, t, ctx, step) {
    const kind = step.body?.action;
    if (!['suspend_coupon', 'paydown', ...Object.keys(MANUAL_FORMS)].includes(kind)) return undefined;
    const inst = ctx.inst(step.instrument);
    const drawer = await ui.openInstrument(inst);
    await drawer.getByRole('button', { name: /^Edit$/ }).first().click();
    const dlg = ui.dialog(`Edit ${inst.symbol || inst.name}`);
    await dlg.waitFor();
    // The lifecycle part is drawn once the instrument has loaded: wait for it before looking for its buttons.
    await dlg.getByText('Lifecycle events recorded by hand').first().waitFor();
    await ui.drawn();
    let review, confirm, done;
    if (MANUAL_FORMS[kind]) {
      // A form of the "Lifecycle events recorded by hand" part (b3): fill its fields, then review and confirm.
      const f = MANUAL_FORMS[kind];
      // The form draws its lifecycle part once the instrument has loaded: wait for it before looking for a field.
      await dlg.getByText('Lifecycle events recorded by hand').first().waitFor();
      await ui.drawn();
      for (const [label, value] of f.fields(step.body)) {
        if (!has(value)) continue;
        const input = ui.input(dlg, label);
        if (!await input.count()) {
          await ui.button(dlg, 'Cancel').click();
          return { refusal: { message: `The instrument form offers no "${label}" field for ${inst.symbol || inst.name}.`, where: 'instrument form, Lifecycle events recorded by hand' } };
        }
        await input.fill(String(value));
      }
      if (f.select) for (const [label, value] of f.select(step.body)) if (has(value)) await ui.select(dlg, label).selectOption(value);
      review = ui.button(dlg, f.review); confirm = f.confirm; done = f.done;
      if (!await review.count()) {
        await ui.button(dlg, 'Cancel').click();
        return { refusal: { message: `The instrument form offers no "${f.review}" for ${inst.symbol || inst.name}.`, where: 'instrument form, Lifecycle events recorded by hand' } };
      }
    } else if (kind === 'paydown') {
      await ui.input(dlg, 'New pool factor').fill(String(step.body.newFactor));
      // Optional parts of a paydown (b3): the date the factor is effective from, the payment date, the scheduled factor.
      if (has(step.body.effective)) await ui.input(dlg, 'Factor effective from').fill(String(step.body.effective));
      if (has(step.body.payDate)) await ui.input(dlg, 'Principal paid on').fill(String(step.body.payDate));
      if (has(step.body.scheduledFactor)) await ui.input(dlg, 'Factor after scheduled principal').fill(String(step.body.scheduledFactor));
      review = ui.button(dlg, 'Review paydown'); confirm = 'Record paydown'; done = /Paydown recorded/;
    } else {
      review = ui.button(dlg, step.body.suspended ? 'Review coupon suspension' : 'Review resuming coupons');
      if (!await review.count()) {
        const close = async () => { await ui.button(dlg, 'Cancel').click(); await dlg.waitFor({ state: 'hidden' }); };
        await close();
        return { refusal: { message: `Coupons are already ${step.body.suspended ? 'suspended' : 'being paid'}: the form offers no "${step.body.suspended ? 'Review coupon suspension' : 'Review resuming coupons'}".`, where: 'instrument form, Lifecycle events recorded by hand' } };
      }
      confirm = step.body.suspended ? 'Suspend coupons' : 'Resume coupons'; done = step.body.suspended ? /Coupons suspended/ : /Coupons resumed/;
    }
    await review.click();
    await ui.drawn();
    const invalid = dlg.locator('.notice.err');
    if (await invalid.count()) {
      const message = (await invalid.first().innerText()).trim();
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message, where: 'instrument form, Lifecycle events recorded by hand' } };
    }
    const r = await ui.respondsTo('POST', /^\/api\/instruments\/[^/]+\/lifecycle$/, () => ui.button(dlg, confirm).click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      const message = r.body?.error;
      // The confirmation stays open beside the message, with its own Cancel: close the form with the footer's (the last one).
      await ui.button(dlg, 'Cancel').last().click();
      return { refusal: { message, status: r.status, where: 'instrument form message' } };
    }
    await ui.toast(done);
    await ui.button(dlg, 'Cancel').click();
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },
  /** A floating coupon's fixing entered by hand (Data connection, Manual entries): the swap driver's form path (added by b2). */
  async manual_rate(ui, t, ctx, step) {
    return (await import('./swap.mjs')).actions.manual_rate(ui, t, ctx, step);
  },
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
