// Browser driver for credit default swaps (engine family "cds"), written by o2 so that a credit-default swaption scenario
// can register its underlying CDS through the registry form. It covers what that needs and no more: the CDS contract
// fields of the registration form (web/lib/contracts.js, F.cds) and the instrument drawer's ticket (the same ticket as a
// swap's, with "Buy protection (pay premium)" / "Sell protection (receive premium)"). The CDS products' own tester (s3)
// extends it with what their scenarios need (credit events recorded on the instrument, for example).
//
// A draft states: marketView, terms.referenceEntity, coupon (decimal), effective, maturity, recovery, indexFactor,
// seniority, counterparty, collateralBasis (as on a swap: { type: 'uncollateralized' } | { type: 'agreement',
// agreementId: '$agreement:<key>' } | { type: 'position', independentAmount, variationMargin, threshold, minimumTransfer }),
// collateral (free text).

import { ticket as swapTicket } from './swap.mjs';

export const family = 'cds';

const VIEW = { US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives', US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based' };
const checkbox = (ui, scope, label) => ui.field(scope, label).locator('input[type="checkbox"]');

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

/** The CDS contract fields of the registration form. */
export async function contractTerms(ui, dialog, draft, ctx) {
  const view = ui.field(dialog, /^\s*Primary view/);
  if (await view.count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  const t = draft.terms || {};
  await ui.input(dialog, /^\s*Reference entity or index/).fill(t.referenceEntity || '');
  await ui.input(dialog, /^\s*Running coupon/).fill(String(t.coupon));
  if (t.effective) await ui.input(dialog, 'Effective date').fill(t.effective);
  await ui.input(dialog, /^\s*Maturity/).fill(t.maturity || '');
  if (t.recovery !== undefined && t.recovery !== null) await ui.input(dialog, 'Recovery assumption').fill(String(t.recovery));
  if (t.indexFactor !== undefined && t.indexFactor !== null) await ui.input(dialog, 'Index factor').fill(String(t.indexFactor));
  if (t.seniority) await ui.input(dialog, 'Seniority').fill(t.seniority);
  if (t.counterparty) await ui.input(dialog, 'Counterparty').fill(t.counterparty);
  await fillCollateral(ui, dialog, t.collateralBasis, ctx);
  if (t.collateral) await ui.input(dialog, 'Other collateral terms').fill(t.collateral);
}

/** The instrument drawer's ticket: the swap ticket, whose action labels come from the contract (buy / sell protection). */
export const ticket = swapTicket;
