// Browser driver for the manual family: holdings and contracts valued by hand (private equity and venture capital
// interests, hedge fund interests, infrastructure, direct real estate, insurance-linked securities, the OTC contracts
// settled from a realised value entered by hand, the collateral swap).
//
//   contractTerms   the registration form: the Primary view where the form asks for it, each product's own terms
//                   (the labels are those of TERMS in server/products/manual.js, which web/lib/manual.js repeats),
//                   the valuation staleness limit, the settlement lag, and for an OTC contract its counterparty and
//                   the required "Collateral terms" group
//   ticket          the security ticket of the instrument drawer: the trading owner, the product's own action labels
//                   (Commit or acquire, Subscribe, Enter the contract, ...), the quantity under the product's own label,
//                   "State a fill price", and a settlement date or lag stated for the trade (`order.settle`)
//   actions.lifecycle  an event recorded by hand from the position's Lifecycle menu in the strategy instance: the menu
//                   must offer it under its label; its dialog is filled from the step's body and recorded. A manual
//                   cash flow goes through the shared path.
//   actions.agreement  a paper collateral agreement of the Book (the swap driver's path).
//   screens         after a step that records an event by hand, the strategy instance of every manual position of the
//                   Account is read: the lines it shows for the manual workflow (committed, called, uncalled; under
//                   notice; the valuation date and source) must state the API's figures.

import { TERMS, MANUAL_KIND, eventLabel } from '../../../../server/products/manual.js';
import * as swap from './swap.mjs';

export const family = 'manual';

const VIEW = { US_CASH: 'US Based', FOREIGN_CASH: 'Foreign Based', US_DERIV: 'US Derivatives', FOREIGN_DERIV: 'Foreign Derivatives' };
const ACTION = { buy: 'Buy', sell: 'Sell' };
const OTC = new Set(['collateral_swap', 'freight', 'spread_forward', 'spread_option', 'variance', 'volatility', 'correlation', 'dispersion', 'recovery', 'weather']);
const checkbox = (ui, scope, label) => ui.field(scope, label).locator('input[type="checkbox"]');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}(\\s*\\(required\\))?\\s*$`);
const kindOf = (productId) => MANUAL_KIND[productId] || 'holding';
const fakeInst = (productId) => ({ product_id: productId, terms: {} });

function agreementOf(ctx, ref) {
  const key = typeof ref === 'string' && ref.startsWith('$agreement:') ? ref.slice(11) : null;
  const a = key ? ctx.agreements?.get(key) : [...(ctx.agreements?.values() || [])].find((x) => x.id === ref);
  if (!a) throw new Error(`The contract names the agreement "${ref}", which no earlier \`agreement\` step recorded.`);
  return a;
}

/** The "Collateral terms" group of an OTC contract. A draft without a basis leaves the choice empty. */
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

/** The product's own contract fields, by their labels. */
export async function contractTerms(ui, dialog, draft, ctx) {
  if (await ui.field(dialog, /^\s*Primary view/).count()) await ui.option(dialog, /^\s*Primary view/, VIEW[draft.marketView]).click();
  const kind = kindOf(draft.productId);
  const t = draft.terms || {};
  const fields = [...(TERMS[kind] || []), { key: 'valuationMaxAgeDays', label: 'Valuation goes stale after (calendar days)', type: 'int' }, { key: 'settleDays', label: 'Settlement lag (business days)', type: 'int' },
    ...(OTC.has(kind) ? [{ key: 'counterparty', label: 'Counterparty', type: 'text' }] : [])];
  for (const f of fields) {
    const v = t[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'enum') await ui.select(dialog, exactly(f.label)).selectOption({ label: f.options[v] });
    else await ui.input(dialog, exactly(f.label)).fill(String(v));
  }
  if (OTC.has(kind)) {
    await fillCollateral(ui, dialog, t.collateralBasis, ctx);
    if (t.collateral) await ui.input(dialog, 'Other collateral terms').fill(t.collateral);
  }
}

/** The security ticket in the instrument drawer, with the product's own labels. */
export async function ticket(ui, t, ctx, step) {
  const inst = ctx.inst(step.instrument);
  const drawer = await ui.openInstrument(inst);
  await ui.tab(drawer, 'Trade');
  const owner = step.owner === 'treasury' ? 'Treasury' : ctx.spec.book.account.name;
  await ui.chooseOwner(drawer, owner);
  const label = inst.actionLabels?.[step.side] || ACTION[step.side] || step.side;
  const action = ui.option(drawer, 'Action', label);
  if (!await action.count()) return { refusal: { message: `The ticket does not offer "${label}" for ${inst.symbol || inst.name} in ${owner}.`, where: 'ticket, Action' } };
  if (await action.isDisabled()) return { refusal: { message: (await action.getAttribute('title')) || `"${label}" is disabled on the ticket.`, where: 'ticket, Action disabled' } };
  await action.click();
  if (step.side === 'sell') {
    const lot = ctx.lot(step.from);
    const held = (await t.strategy(lot.strategyId)).positions.find((p) => p.instrument.id === inst.id);
    if (!held) throw new Error(`"${step.from}" holds no ${inst.symbol || inst.name} to reduce.`);
    const which = ui.field(drawer, 'Sell from').locator('select');
    if (await which.count()) await which.first().selectOption(held.positionId);
  }
  await ui.input(drawer, inst.qtyLabel).fill(String(step.qty));
  const o = step.order || {};
  if (o.statedPrice !== undefined && o.statedPrice !== null) await ui.input(drawer, 'State a fill price').fill(String(o.statedPrice));
  if (o.settle) {
    const field = ui.field(drawer, 'Settlement');
    await field.locator('select').first().selectOption({ label: o.settle.date ? 'State a settlement date' : 'State a lag in business days' });
    await ui.drawn();
    await field.locator('input').first().fill(String(o.settle.date ?? o.settle.lag));
    await ui.drawn();
  }
  const preview = drawer.getByRole('button', { name: /^Preview/ });
  if (await preview.isDisabled()) {
    const notices = (await drawer.locator('.notice').allInnerTexts()).map((x) => x.trim().replace(/\s+/g, ' '));
    return { refusal: { message: notices.join(' | ') || 'The Preview button is disabled and the ticket gives no reason.', where: 'ticket, Preview disabled' } };
  }
  return { preview: () => preview.click() };
}

// The dialog's fields for each body key, by label (web/lib/manual.js ManualEventDialog).
const MONEY = { amount: /^\s*(Amount called|Amount paid|Amount received|Capital expenditure)/, feePortion: 'Management-fee part', returnOfCapital: 'Return of capital', realizedGain: 'Realized gain', income: /^\s*Income \(/, carry: 'Carried interest withheld', face: 'Face written down' };
const REALISED = { spread_forward: 'Spread at expiry', spread_option: 'Spread at expiry', variance: 'Realised volatility', volatility: 'Realised volatility', correlation: 'Realised correlation', weather: 'Index for the period', recovery: 'Recovery rate' };
const KIND_LABEL = { management_fee: 'Management fee', performance_fee: 'Performance fee', carried_interest: 'Carried interest', operating: 'Operating expense', other: 'Other expense', rent: 'Rent', dividend: 'Dividend', distribution: 'Income distribution', coupon: 'Coupon', interest: 'Interest' };

async function fillEvent(ui, dlg, kind, b) {
  const fill = async (label, v) => { if (v !== undefined && v !== null && v !== '') await ui.input(dlg, label).fill(String(v)); };
  switch (b.action) {
    case 'valuation':
      await fill(/^\s*(Value of the|NAV per share|Price \(% of face\)|Price per unit)/, b.value);
      await fill('Valuation date', b.asOf);
      await fill('Source', b.source);
      break;
    case 'expense': case 'income':
      await ui.select(dlg, /^\s*Kind of/).selectOption({ label: KIND_LABEL[b.kind] });
      await fill(MONEY.amount, b.amount);
      break;
    case 'redemption_notice': await fill('Shares to redeem', b.shares); break;
    case 'redemption': await fill('NAV per share for the dealing date', b.nav); break;
    case 'credit_event': await fill('Credit event date', b.eventDate); break;
    case 'fee_payment': await fill('Fee period end', b.periodEnd); break;
    case 'settle':
      if (kind === 'freight') { await fill('Period settled', b.period); await fill('Average of the settlement index', b.average); await fill('Quantity settled', b.qty); }
      if (kind === 'dispersion') { await fill('Weighted constituent volatility', b.constituentVol); await fill('Index volatility', b.indexVol); }
      if (kind === 'recovery' && b.noCreditEvent) await checkbox(ui, dlg, 'No credit event before maturity').setChecked(true);
      if (REALISED[kind] && !(kind === 'recovery' && b.noCreditEvent)) await fill(REALISED[kind], b.realised);
      if (kind === 'ils') await fill('Redemption price', b.redemptionPrice);
      if (kind !== 'collateral_swap') await fill('Payment date', b.payDate);
      break;
    default:
      for (const [k, label] of Object.entries(MONEY)) if (b[k] !== undefined) await fill(label, b[k]);
  }
  if (b.note && await ui.field(dlg, 'Note').count()) await fill('Note', b.note);
}

export const actions = {
  async lifecycle(ui, t, ctx, step, { positionRow }) {
    const b = step.body;
    const lot = ctx.lot(step.lot);
    const inst = ctx.inst(step.instrument || lot.instrument);
    const kind = kindOf(inst.productId);
    const drawer = await ui.openStrategy(ctx, lot.strategyId);
    const row = positionRow(drawer, inst);
    const menu = row.locator('select').first();
    const offered = (await menu.locator('option').allInnerTexts()).map((x) => x.trim()).filter((x) => x && x !== 'Lifecycle');
    const label = eventLabel(fakeInst(inst.productId), b.action);
    if (!offered.includes(label)) return { refusal: { message: `The Lifecycle menu of this position offers only: ${offered.join(', ') || 'nothing'}. "${label}" is not offered.`, where: 'strategy instance, position Lifecycle menu' } };
    await menu.selectOption({ label });
    const dlg = ui.dialog(new RegExp(`^${esc(label)}:`));
    await dlg.waitFor();
    await fillEvent(ui, dlg, kind, b);
    const button = dlg.getByRole('button', { name: /^Record / });
    if (await button.isDisabled()) {
      const why = `The dialog's Record button stays disabled for ${JSON.stringify(b)}.`;
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message: why, where: `${label} dialog, Record disabled` } };
    }
    const r = await ui.respondsTo('POST', /^\/api\/positions\/[^/]+\/lifecycle$/, () => button.click());
    if (!r.ok) {
      await dlg.locator('.notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor();
      const message = (await dlg.locator('.notice.err').first().innerText()).trim();
      await ui.button(dlg, 'Cancel').click();
      return { refusal: { message, status: r.status, where: `${label} dialog message` } };
    }
    await dlg.waitFor({ state: 'hidden' });
    return {};
  },
  agreement: (...args) => swap.actions.agreement(...args),
};

/**
 * After an event recorded by hand: the strategy instance shows each manual position's workflow figures. They must be
 * the API's (the lines of web/lib/manual.js manualLines, read as text).
 */
export async function screens(ui, ctx, t, info) {
  if (!['lifecycle', 'ticket'].includes(info.step?.action) || info.step?.status) return [];
  const out = [];
  const say = (m) => out.push(`screen vs API: ${m}`);
  const money = (x, ccy) => `${Number(x).toLocaleString('en-US', { minimumFractionDigits: ['JPY'].includes(ccy) ? 0 : 2, maximumFractionDigits: ['JPY'].includes(ccy) ? 0 : 2 })} ${ccy}`;
  const lots = [...ctx.lots.values()];
  for (const lot of lots) {
    const s = await t.strategy(lot.strategyId);
    const mine = s.positions.filter((p) => p.family === 'manual' && p.manual);
    if (!mine.length) continue;
    const drawer = await ui.openStrategy(ctx, lot.strategyId);
    const panel = ui.section(drawer, 'Positions');
    const text = (await panel.innerText()).replace(/\s+/g, ' ');
    for (const p of mine) {
      const m = p.manual;
      const want = [];
      if (m.kind === 'commitment') want.push(`committed ${money(m.committed, p.ccy)}, called ${money(m.called, p.ccy)}, uncalled ${money(m.uncalled, p.ccy)}`);
      if (m.kind === 'fund_interest' && m.redemptions?.length) want.push(...m.redemptions.map((r) => `for ${r.dealingDate}`));
      want.push(m.valuation ? `valued by hand as of ${m.valuation.date} (${m.valuation.source})${m.valuation.stale ? ', stale' : ''}` : 'no valuation entered');
      for (const w of want) if (!text.includes(w)) say(`the strategy instance of ${p.instrument.symbol || p.instrument.name} does not show "${w}" (it shows: ${text.slice(0, 400)})`);
    }
    await ui.closeOverlays();
  }
  return out;
}
