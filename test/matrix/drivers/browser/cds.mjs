// Browser driver for credit default swaps (engine family "cds"), written by o2 so that a credit-default swaption scenario
// can register its underlying CDS through the registry form, and extended by s3 for the credit products' own scenarios.
//
//   contractTerms()          the registry form's CDS fields (web/lib/contracts.js, F.cds): market view and calendars,
//                            reference entity, coupon, dates, recovery assumption, index factor, seniority, premium
//                            convention and first period, credit events, settlement after a credit event and the
//                            deliverable obligation, basket names and the default that triggers protection, tranche
//                            attachment and detachment, loan CDS cancellability, ABS reference obligation,
//                            counterparty and the required Collateral terms
//   ticket()                 the instrument drawer's ticket (the swap ticket; its actions read "Buy protection (pay
//                            premium)" / "Sell protection (receive premium)")
//   actions.instrument_lifecycle   the instrument form's "Lifecycle events recorded by hand" (web/views/credit-admin.js):
//                            credit_event { eventType, eventDate, recovery, settlement, entity, weight, settleDate },
//                            paygo { kind, amount, date }, cancel { date, note }; Review, then the confirmation
//   actions.roll             the strategy instance's Roll dialog: the index series to roll into, then the preview
//   actions.close / resize / agreement / owner_screens   the swap driver's paths (stated settlement amount on the
//                            preview, collateral agreement, Treasury's screens)
//
// A draft states: marketView, conventions { tradingCalendar, settlementCalendar, paymentCalendar, settleLag },
// terms.referenceEntity, coupon (decimal), effective, maturity, recovery, indexFactor, seniority, convention
// ('standard' | 'bespoke'), firstStub, creditEventSet, settlement ('auction' | 'cash' | 'physical'), deliverable, basket
// (array or ';' text), nth, attachment, detachment, cancellable, referenceObligation, counterparty, collateralBasis (as on
// a swap), collateral (free text).

import { ticket as swapTicket, actions as swapActions } from './swap.mjs';

export const family = 'cds';

const VIEW = { US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives', US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };
const checkbox = (ui, scope, label) => ui.field(scope, label).locator('input[type="checkbox"]');
const has = (v) => v !== undefined && v !== null && v !== '';

async function fillCollateral(ui, scope, basis, ctx) {
  if (!basis) return;
  await ui.select(scope, 'Collateral basis').selectOption(basis.type);
  await ui.drawn();
  if (basis.type === 'agreement') {
    const key = String(basis.agreementId).replace(/^\$agreement:/, '');
    const a = ctx.agreements?.get(key);
    if (!a) throw new Error(`The CDS names the agreement "${basis.agreementId}", which no earlier \`agreement\` step recorded.`);
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

/** Calendars and settlement lag of the instrument (registry form only), as the swap driver fills them. */
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
  if (has(c.settleLag)) await ui.input(dialog, 'Settlement convention: lag in business days').fill(String(c.settleLag));
}

/** The CDS contract fields of the registration form. */
export async function contractTerms(ui, dialog, draft, ctx) {
  const view = ui.field(dialog, /^\s*Primary view/);
  if (await view.count()) {
    await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
    await fillConventions(ui, dialog, draft.conventions);
  }
  const t = draft.terms || {};
  await ui.input(dialog, /^\s*Reference entity or index/).fill(t.referenceEntity || '');
  await ui.input(dialog, /^\s*Running coupon/).fill(String(t.coupon));
  if (t.effective) await ui.input(dialog, 'Effective date').fill(t.effective);
  await ui.input(dialog, /^\s*Maturity/).fill(t.maturity || '');
  if (has(t.recovery)) await ui.input(dialog, 'Recovery assumption').fill(String(t.recovery));
  if (has(t.indexFactor)) await ui.input(dialog, 'Index factor').fill(String(t.indexFactor));
  if (t.seniority) await ui.input(dialog, 'Seniority').fill(t.seniority);
  // s3: the credit terms.
  if (t.convention) { await ui.select(dialog, 'Premium convention').selectOption(t.convention); await ui.drawn(); }
  if (t.firstStub && t.convention !== 'standard') await ui.select(dialog, 'First period').selectOption(t.firstStub);
  if (t.creditEventSet) await ui.select(dialog, /^\s*Credit events/).selectOption(t.creditEventSet);
  if (t.settlement) { await ui.select(dialog, 'Settlement after a credit event').selectOption(t.settlement); await ui.drawn(); }
  if (t.deliverable) await ui.input(dialog, 'Deliverable obligation').fill(t.deliverable);
  if (t.basket) await ui.input(dialog, 'Basket reference entities').fill(Array.isArray(t.basket) ? t.basket.join('; ') : t.basket);
  if (has(t.nth)) await ui.input(dialog, 'Protection on default number').fill(String(t.nth));
  if (has(t.attachment)) await ui.input(dialog, 'Attachment point').fill(String(t.attachment));
  if (has(t.detachment)) await ui.input(dialog, 'Detachment point').fill(String(t.detachment));
  if (has(t.cancellable)) await checkbox(ui, dialog, 'Cancellable on refinancing').setChecked(Boolean(t.cancellable));
  if (t.referenceObligation) await ui.input(dialog, 'Reference obligation').fill(t.referenceObligation);
  if (t.counterparty) await ui.input(dialog, 'Counterparty').fill(t.counterparty);
  await fillCollateral(ui, dialog, t.collateralBasis, ctx);
  if (t.collateral) await ui.input(dialog, 'Other collateral terms').fill(t.collateral);
}

/** The instrument drawer's ticket: the swap ticket, whose action labels come from the contract (buy / sell protection). */
export const ticket = swapTicket;

/** The fields each event recorded by hand fills on the instrument form (web/views/credit-admin.js), its Review button and confirmation. */
const FORMS = {
  credit_event: {
    selects: (b) => [['Kind of credit event', b.eventType], ['Settled by', b.settlement], ...(b.entity && b.pickEntity ? [['Defaulted name', b.entity]] : [])],
    inputs: (b) => [['Event date', b.eventDate], ['Recovery rate or auction final price', b.recovery], ...(b.entity && !b.pickEntity ? [['Defaulted name', b.entity]] : []), ['Weight of the defaulted name', b.weight], ['Settles on', b.settleDate]],
    review: 'Review credit event', confirm: 'Record credit event', done: /Credit event recorded/,
  },
  paygo: { selects: (b) => [['Pay-as-you-go event', b.kind]], inputs: (b) => [[b.kind === 'amortization' ? 'New factor of the reference obligation' : 'Amount per 100 of original notional', b.amount], ['Pay-as-you-go date', b.date]], review: 'Review pay-as-you-go event', confirm: 'Record pay-as-you-go event', done: /Pay-as-you-go event recorded/ },
  cancel: { selects: () => [], inputs: (b) => [['Cancellation date', b.date], ['Cancellation note', b.note]], review: 'Review cancellation', confirm: 'Record cancellation', done: /Cancellation recorded/ },
};

export const actions = {
  close: (...args) => swapActions.close(...args),
  resize: (...args) => swapActions.resize(...args),
  agreement: (...args) => swapActions.agreement(...args),
  owner_screens: (...args) => swapActions.owner_screens(...args),

  /**
   * An event recorded by hand on the CDS itself: the instrument drawer's Edit opens the instrument form, whose "Lifecycle
   * events recorded by hand" part is filled, reviewed and confirmed. A refusal is the form's own message: a field or a
   * choice it does not offer (a credit event the terms do not name, physical settlement the terms do not allow), or the
   * Terminal's answer to the confirmation.
   */
  async instrument_lifecycle(ui, t, ctx, step) {
    const b = step.body || {};
    const f = FORMS[b.action];
    if (!f) return undefined;
    const inst = ctx.inst(step.instrument);
    const drawer = await ui.openInstrument(inst);
    await drawer.getByRole('button', { name: /^Edit$/ }).first().click();
    const dlg = ui.dialog(`Edit ${inst.symbol || inst.name}`);
    await dlg.waitFor();
    await dlg.getByText('Lifecycle events recorded by hand').first().waitFor();
    await ui.drawn();
    const cancel = async (message, where) => { await ui.button(dlg, 'Cancel').first().click().catch(() => {}); return { refusal: { message, where } }; };
    const ended = dlg.locator('p.note', { hasText: /ended on/ });
    if (await ended.count()) return cancel((await ended.first().innerText()).trim(), 'instrument form, Lifecycle events recorded by hand');
    const review = ui.button(dlg, f.review);
    if (!await review.count()) return cancel(`The instrument form offers no "${f.review}" for ${inst.symbol || inst.name}.`, 'instrument form, Lifecycle events recorded by hand');
    // The basket's defaulted name is chosen from a list; an index or tranche constituent is typed.
    const pickEntity = b.action === 'credit_event' && b.entity && (await ui.select(dlg, 'Defaulted name').count()) > 0;
    const body = { ...b, pickEntity };
    for (const [label, value] of f.selects(body)) {
      if (!has(value)) continue;
      const select = ui.select(dlg, label);
      if (!await select.count()) return cancel(`The instrument form offers no "${label}" choice for ${inst.symbol || inst.name}.`, 'instrument form');
      const offered = (await select.locator('option').evaluateAll((os) => os.map((o) => o.value))).filter(Boolean);
      if (!offered.includes(String(value))) {
        const labels = (await select.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Choose…');
        return cancel(`"${label}" does not offer "${value}" for ${inst.symbol || inst.name}: it offers ${labels.join(', ') || 'nothing'}.`, `instrument form, ${label}`);
      }
      await select.selectOption(String(value));
      await ui.drawn();
    }
    for (const [label, value] of f.inputs(body)) {
      if (!has(value)) continue;
      const input = ui.input(dlg, label);
      if (!await input.count()) return cancel(`The instrument form offers no "${label}" field for ${inst.symbol || inst.name}.`, 'instrument form');
      await input.fill(String(value));
    }
    await ui.drawn();
    await review.click();
    await ui.drawn();
    const err = dlg.locator('.notice.err');
    if (await err.count()) return cancel((await err.first().innerText()).trim(), 'instrument form, review');
    const confirm = ui.button(dlg, f.confirm);
    await confirm.waitFor();
    const r = await ui.respondsTo('POST', /^\/api\/instruments\/[^/]+\/lifecycle$/, () => confirm.click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      const message = (await dlg.locator('.notice.err').first().innerText()).trim();
      return cancel(message, 'instrument form message');
    }
    await ui.toast(f.done);
    await ui.closeOverlays();
    return {};
  },

  /** Roll into a new index series: the strategy instance's Roll dialog, the series, then the preview of the two-leg package. */
  async roll(ui, t, ctx, step, tools) {
    const lot = ctx.lot(step.lot);
    const drawer = await ui.openStrategy(ctx, lot.strategyId);
    await ui.button(drawer, 'Roll').click();
    const dlg = ui.dialog(/^Roll positions of /);
    await dlg.waitFor();
    const target = ctx.inst(step.into);
    const series = ui.select(dlg, 'Series to roll into');
    const option = series.locator(`option[value="${target.id}"]`);
    try { await option.waitFor({ state: 'attached', timeout: 8000 }); } catch {
      const offered = (await series.locator('option').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
      return { refusal: { message: `The Roll dialog does not offer ${target.symbol || target.name}. It offers: ${offered.join(' | ') || 'nothing'}.`, where: 'Roll dialog, Series to roll into' } };
    }
    await series.selectOption(target.id);
    return tools.previewAndConfirm(ui, ctx, () => ui.button(dlg, 'Preview roll').click(), { expectsRefusal: tools.expectsRefusal });
  },
};
