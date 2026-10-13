// Browser driver for execution templates (spec family "templates"): the Strategies page end to end, and the
// actions of the strategy instance a package becomes. Shared by templates-a.mjs (t1) and templates-b.mjs (t2);
// extend it additively (new keys in `strategyPage`, new entries in `actions`).
//
// What is done in the interface here:
//   package          the Strategies page: Trading owner, Investment Strategy (by its ID from the list), holding period,
//                    hedge objective and scope, execution template, instrument, existing position or new, quantity or
//                    notional, hedge ratio, option contracts (expiration, strikes, contracts, calls or puts), securities
//                    borrow assumption, order terms, net limit, "If cash is short"; the hedge panel's answer (and the
//                    hedge package chosen in it); then the trade preview: legs edited there and re-checked, protection
//                    added deliberately, and the confirmation (shared previewAndConfirm)
//   hedge_request    the same page filled in up to the hedge panel; the request it sends and the answer it shows
//   close            with `qty`: the strategy instance's "Close an exact amount" (other closes are shared)
//   recover          the strategy instance's "Retry the failed legs" / "Unwind what filled"
//   strategy_action  "Accept as it stands" (and its dialog) / "Cancel working legs"
//   strategy_check   the strategy instance's drawer: its status as displayed, against the API
//   hedge_script     the scripted hedge service (a fixture standing in for Shaffer Hedge): set through the API
//
// A step's `strategyPage` states what is typed and chosen on the page (the request it produces is the step's
// `input`, which the engine and API levels send; the driver checks the page sent the same terms):
//   { owner?, investmentStrategy?: '<listed id>' | { typed: '<name>' }, holdingDays?, objective?: '<label>', scope?: '<label>',
//     template: '<label>', underlying: '<instrument key>', mode?: 'existing', existing?: { lot, instrument }, coverQty?,
//     sizeBy?: 'quantity' | 'notional', quantity?, notional?, hedgeRatio?, expiration?, farExpiration?, right?: 'C' | 'P',
//     strikes?: { '<field label>': strike }, contracts?, contractSpec?: { multiplier, deliverableUnits },
//     borrow?: { available, feeRate }, order?: { orderType, limitPrice, stopPrice, tif }, netLimit?,
//     financing?: { mode: 'treasury' | 'loan', rate? }, hedge?: 'none' | '<package label>' }
// Step-level: `editLegs: { <leg n>: { orderType, limitPrice, statedPrice, qty } }` (changed in the preview dialog, then
// re-checked) and `acknowledgeProtection: true` ("Add this protection deliberately").

export const family = 'templates';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (s) => new RegExp(`^\\s*${esc(s)}\\s*$`);
const ORDER_TYPE = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' };
const TIF = { day: 'Day', gtc: 'Until cancelled' };
const STATUS_WORDS = { attention: 'needs attention', partial: 'in progress', working: 'working' };

/** The templates family registers no instrument of its own: the instruments of a template scenario are filled in by their own family's driver. */
export async function contractTerms() {}

/** A template scenario's plain tickets name their family with `ticketOf` (equity, option); this family has no ticket of its own. */
export async function ticket(ui, t, ctx, step) {
  throw new Error(`Step "${step.id}": a template scenario's ticket step must name the ticket it uses (ticketOf: 'equity' or 'option').`);
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

/** '$inst:key', '$unit:key', '$lot:name' anywhere in a body, as the engine and API levels resolve them. */
/** '$pos:<lot>:<instrument key>': the open position of that instrument in that lot, as lib/actions.mjs resolves it. */
async function resolvePositionRefs(t, ctx, x) {
  if (typeof x === 'string' && x.startsWith('$pos:')) {
    const [, lot, key] = x.split(':');
    const s = await t.strategy(ctx.lot(lot).strategyId);
    const p = s.positions.find((q) => q.instrument.id === ctx.inst(key).id);
    if (!p) throw new Error(`"${lot}" holds no ${key} for ${x}.`);
    return p.positionId;
  }
  if (Array.isArray(x)) return Promise.all(x.map((v) => resolvePositionRefs(t, ctx, v)));
  if (x && typeof x === 'object') return Object.fromEntries(await Promise.all(Object.entries(x).map(async ([k, v]) => [k, await resolvePositionRefs(t, ctx, v)])));
  return x;
}

function resolveRefs(x, ctx) {
  if (typeof x === 'string') {
    if (x.startsWith('$inst:')) return ctx.inst(x.slice(6)).id;
    if (x.startsWith('$unit:')) return ctx.unitId(x.slice(6));
    if (x.startsWith('$lot:')) return ctx.lot(x.slice(5)).strategyId;
    return x;
  }
  if (Array.isArray(x)) return x.map((v) => resolveRefs(v, ctx));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolveRefs(v, ctx)]));
  return x;
}

/**
 * The hedge panel asks Shaffer Hedge (a fixture here) 0.9 s after the last change of the form, and again on every
 * change. Wait until the last request the page sent has been answered and the form has been quiet for longer than
 * that debounce: the answer shown is then the one for the form as filled in.
 */
function watchHedgeRequests(page) {
  const w = { sent: 0, answered: 0, lastAt: Date.now(), last: null };
  const isIt = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/hedge/requests';
  const onReq = (r) => { if (isIt(r)) { w.sent++; w.lastAt = Date.now(); } };
  const onRes = async (res) => { if (isIt(res.request())) { w.answered++; w.lastAt = Date.now(); try { w.last = await res.json(); } catch { /* no body */ } } };
  page.on('request', onReq);
  page.on('response', onRes);
  w.stop = () => { page.off('request', onReq); page.off('response', onRes); };
  w.settled = async ({ expectRequest = true, timeout = 20_000 } = {}) => {
    const until = Date.now() + timeout;
    for (;;) {
      const quiet = Date.now() - w.lastAt > 1_400;
      if (quiet && w.sent === w.answered && (!expectRequest || w.answered > 0)) return w.last;
      if (Date.now() > until) throw new Error(`The hedge panel did not settle: ${w.sent} request(s) sent, ${w.answered} answered.`);
      await page.waitForTimeout(150);
    }
  };
  return w;
}

/** Fill the Strategies page as a step states it. Returns the page's main area and the hedge-request watcher. */
async function fillStrategyPage(ui, t, ctx, step) {
  const { page } = ui;
  const sp = step.strategyPage;
  await ui.closeOverlays();
  await ui.reloadAt('#/strategy');
  const main = page.locator('main');
  const hedge = watchHedgeRequests(page);
  const intent = ui.section(main, 'Account and intent');
  await intent.waitFor();
  const ownerKey = sp.owner || step.owner || 'account';
  await ui.chooseOwner(intent, ownerKey === 'treasury' ? 'Treasury' : ctx.spec.book.account.name);
  if (sp.investmentStrategy) {
    const f = ui.field(intent, 'Investment Strategy');
    const sel = f.locator('select');
    await f.locator('select, input').first().waitFor();
    if (typeof sp.investmentStrategy === 'string') await sel.selectOption(sp.investmentStrategy);
    else await f.locator('input').first().fill(sp.investmentStrategy.typed);
  }
  if (sp.holdingDays !== undefined) await ui.input(intent, 'Intended holding period').fill(String(sp.holdingDays));
  if (sp.objective) await ui.select(intent, 'Hedge objective').selectOption({ label: sp.objective });
  if (sp.scope) await ui.select(intent, 'Hedge scope').selectOption({ label: sp.scope });

  const what = ui.section(main, 'Instrument and template');
  await ui.select(what, 'Execution template').selectOption({ label: sp.template });
  await ui.drawn();
  const und = sp.underlying ? ctx.inst(sp.underlying) : null;
  if (und) {
    await pickInstrument(ui, what, /^\s*(Ticker or instrument|Underlying of the options|Underlying \(optional)/, und);
    await what.getByText('Current market price').first().waitFor();
  }
  if (sp.mode === 'existing') {
    await ui.option(what, 'Underlying position', 'Hedge an existing position').click();
    const lot = ctx.lot(sp.existing.lot);
    const s = await t.strategy(lot.strategyId);
    const p = s.positions.find((x) => x.instrument.id === ctx.inst(sp.existing.instrument).id);
    if (!p) throw new Error(`"${sp.existing.lot}" holds no ${sp.existing.instrument} to use as the existing position.`);
    const pick = ui.select(what, /^\s*Existing/);
    await pick.locator(`option[value="${p.positionId}"]`).waitFor({ state: 'attached' });
    await pick.selectOption(p.positionId);
    if (sp.coverQty !== undefined) await ui.input(what, 'Quantity to cover').fill(String(sp.coverQty));
  } else {
    if (sp.sizeBy === 'notional') {
      await ui.option(what, 'Size by', 'Notional').click();
      await ui.input(what, 'Target notional').fill(String(sp.notional));
    } else if (sp.quantity !== undefined && sp.quantity !== null) await ui.input(what, und.qtyLabel).fill(String(sp.quantity));
  }
  if (sp.hedgeRatio !== undefined) await ui.input(what, 'Hedge ratio').fill(String(sp.hedgeRatio));
  // t2: the futures hedge's "Underlying exposure" (long / short) when a new position is established.
  if (sp.direction) await ui.option(what, 'Underlying exposure', sp.direction === 'short' ? 'Short' : 'Long').click();
  // t2: the pairs trade's short leg: { instrument: '<key>', ratio }.
  if (sp.pair) {
    const pp = ui.section(main, 'Short leg of the pair');
    await pickInstrument(ui, pp, 'Security to borrow and sell short', ctx.inst(sp.pair.instrument));
    await ui.input(pp, 'Sizing ratio').fill(String(sp.pair.ratio));
  }
  // t2: futures contracts: { buy: '<key>' (the hedge future, or the month bought), sell?: '<key>' (the month sold), contracts? }.
  if (sp.futures) {
    const fp = ui.section(main, 'Futures contracts');
    const first = ui.select(fp, /^\s*(Futures contract for the hedge|Contract month to buy)/);
    await first.locator(`option[value="${ctx.inst(sp.futures.buy).id}"]`).waitFor({ state: 'attached' });
    await first.selectOption(ctx.inst(sp.futures.buy).id);
    if (sp.futures.sell) {
      const second = ui.select(fp, 'Contract month to sell');
      await second.locator(`option[value="${ctx.inst(sp.futures.sell).id}"]`).waitFor({ state: 'attached' });
      await second.selectOption(ctx.inst(sp.futures.sell).id);
    }
    if (sp.futures.contracts !== undefined && sp.futures.contracts !== null) await ui.input(fp, 'Contracts').fill(String(sp.futures.contracts));
  }
  // t2: the custom builder's legs ("Legs" panel, "Add a leg" dialog), in order: [{ type: 'instrument' | 'option',
  //     instrument?: '<key>', side: '<Side label>', qty, purpose?: 'hedge', right?: 'C' | 'P', expiration?, strike?,
  //     after?: <leg n> (its "Runs after") }]. Option legs are on the underlying chosen at the top of the page.
  if (sp.legs) {
    const lp = ui.section(main, 'Legs');
    for (const l of sp.legs) {
      await ui.button(lp, 'Add a leg').click();
      const dlg = ui.dialog(/^Add a leg/);
      await dlg.waitFor();
      await ui.select(dlg, 'Leg').selectOption(l.type === 'option' ? 'option' : 'instrument');
      await ui.drawn();
      if (l.purpose === 'hedge') await ui.option(dlg, 'Purpose', 'Hedge').click();
      if (l.type === 'option') {
        await ui.option(dlg, 'Type', l.right === 'C' ? 'Call' : 'Put').click();
        const exp = ui.field(dlg, 'Expiration');
        await exp.locator('select, input').first().waitFor();
        if (await exp.locator('select').count()) await exp.locator('select').selectOption(l.expiration); else await exp.locator('input').fill(l.expiration);
        await ui.drawn();
        const k = ui.field(dlg, 'Strike');
        if (await k.locator('select').count()) await k.locator('select').selectOption(String(l.strike)); else await k.locator('input').fill(String(l.strike));
      } else await pickInstrument(ui, dlg, 'Instrument', ctx.inst(l.instrument));
      await ui.select(dlg, 'Side').selectOption({ label: l.side });
      await ui.input(dlg, l.type === 'option' ? 'Contracts' : ctx.inst(l.instrument).qtyLabel || 'Quantity').fill(String(l.qty));
      await ui.button(dlg, 'Add leg').click();
      await dlg.waitFor({ state: 'detached' });
    }
    for (const [i, l] of sp.legs.entries()) if (l.after) await lp.locator('tbody tr').nth(i).locator('select').selectOption({ label: `Leg ${l.after}` });
  }

  if (sp.expiration || sp.strikes || sp.contracts !== undefined || sp.right) {
    const oc = ui.section(main, 'Option contracts');
    if (sp.right) await ui.option(oc, 'Built from', sp.right === 'P' ? 'Puts' : 'Calls').click();
    if (sp.expiration) await ui.input(oc, /^\s*(Expiration|Near expiration)/).fill(sp.expiration);
    if (sp.farExpiration) await ui.input(oc, /^\s*Far expiration/).fill(sp.farExpiration);
    for (const [label, strike] of Object.entries(sp.strikes || {})) await ui.input(oc, label).fill(String(strike));
    if (sp.contracts !== undefined && sp.contracts !== null) await ui.input(oc, 'Contracts').fill(String(sp.contracts));
    if (sp.contractSpec?.multiplier) await ui.input(oc, 'Premium multiplier per contract').fill(String(sp.contractSpec.multiplier));
    if (sp.contractSpec?.deliverableUnits) await ui.input(oc, 'Deliverable units per contract').fill(String(sp.contractSpec.deliverableUnits));
  }
  if (sp.borrow) {
    const bp = ui.section(main, 'Securities borrow');
    if (sp.borrow.available === false) await ui.field(bp, 'Borrow assumption').getByRole('checkbox').setChecked(false);
    if (sp.borrow.feeRate !== undefined) await ui.input(bp, 'Borrow fee').fill(String(sp.borrow.feeRate));
  }
  const of = ui.section(main, 'Order and funding');
  const o = sp.order || {};
  if (o.orderType && o.orderType !== 'market') await ui.select(of, 'Order type').selectOption({ label: ORDER_TYPE[o.orderType] });
  if (o.limitPrice !== undefined && o.limitPrice !== null) await ui.input(of, 'Limit price').fill(String(o.limitPrice));
  if (o.stopPrice !== undefined && o.stopPrice !== null) await ui.input(of, 'Stop price').fill(String(o.stopPrice));
  if (o.tif && o.tif !== 'day') await ui.select(of, 'Time in force').selectOption({ label: TIF[o.tif] });
  if (sp.netLimit !== undefined && sp.netLimit !== null) await ui.input(of, 'Net limit for the option legs').fill(String(sp.netLimit));
  if (sp.financing?.mode && sp.financing.mode !== 'none') {
    await ui.select(of, 'If cash is short').selectOption(sp.financing.mode);
    if (sp.financing.mode === 'loan') await ui.input(of, 'Loan rate').fill(String(sp.financing.rate));
  }
  // The hedge request goes out once the owner, the instrument and the amount are set; wait for the answer to the form as filled.
  const answer = await hedge.settled({ expectRequest: sp.expectHedgeRequest !== false });
  hedge.stop();
  const panel = ui.section(page.locator('main'), 'Hedge');
  if (sp.hedge) {
    const name = sp.hedge === 'none' ? 'No hedge with this package' : sp.hedge;
    await panel.getByRole('button', { name: new RegExp(`^\\s*${esc(name)}`) }).first().click();
    await ui.drawn();
  }
  return { main, panel, answer };
}

/** The terms of the request the page sent, against the `input` the engine and API levels send for the same step. */
function requestProblems(sent, want) {
  const out = [];
  const pick = (x) => ({
    template: x.template, underlyingId: x.underlyingId || null, mode: x.mode || 'new', existingPositionId: x.mode === 'existing' ? x.existingPositionId : null,
    quantity: x.quantity ?? null, targetNotional: x.targetNotional ?? null, hedgeRatio: x.hedgeRatio ?? null,
    expiration: x.options?.expiration || null, farExpiration: x.options?.farExpiration || null, right: x.options?.right || null, strikes: JSON.stringify(Object.fromEntries(Object.entries(x.options?.strikes || {}).filter(([, v]) => v !== null && v !== undefined).sort())),
    contracts: x.options?.contracts ?? null, orderType: x.orderType || 'market', limitPrice: x.limitPrice ?? null, stopPrice: x.stopPrice ?? null, tif: x.tif || 'day', netLimit: x.netLimit ?? null,
    financing: x.financing?.mode || 'none', loanRate: x.financing?.rate ?? null, borrowFee: x.borrow?.feeRate ?? null,
    investmentStrategy: x.investmentStrategy?.id || x.investmentStrategy?.name || null, holdingDays: x.holdingPeriod?.days ?? null, objective: x.hedgeObjective?.type || null,
    // t2: the futures contracts and, for the custom builder, every leg (kind, side, quantity, instrument or option, purpose, runs after).
    ...(want.futures ? { futures: JSON.stringify([x.futures?.instrumentId || null, x.futures?.farInstrumentId || null, x.futures?.contracts ?? null]) } : {}),
    ...(want.template === 'custom' ? { legs: JSON.stringify((x.legs || []).map((l) => [l.kind || 'trade', l.action, l.qty, l.instrumentId || null, l.option ? `${l.option.right}${l.option.strike}@${l.option.expiration}` : null, l.purpose || 'primary', (l.dependsOn || []).join('+')])) } : {}),
  });
  const a = pick(sent), b = pick(want);
  for (const k of Object.keys(b)) if (String(a[k]) !== String(b[k])) out.push(`Strategies page: the request sent ${k} = ${a[k]}, the step's input states ${b[k]}`);
  return out;
}

/** The legs changed in the preview dialog: order type, limit, stated fill price, quantity. */
function editLegsIn(ui, edits) {
  return async (modal) => {
    for (const [n, e] of Object.entries(edits)) {
      const row = modal.locator('table.pv-legs tbody tr').filter({ has: ui.page.locator('.leg-n', { hasText: exactly(String(n)) }) }).first();
      const order = row.locator('td[data-label="Order"]');
      if (e.orderType) await order.locator('select').first().selectOption(e.orderType);
      if (e.limitPrice !== undefined) await order.locator('.row', { hasText: 'limit' }).locator('input').fill(String(e.limitPrice));
      if (e.stopPrice !== undefined) await order.locator('.row', { hasText: 'stop' }).locator('input').fill(String(e.stopPrice));
      if (e.tif) await order.locator('select').nth(1).selectOption(e.tif);
      if (e.statedPrice !== undefined) await row.locator('td[data-label="Estimated fill"] .row', { hasText: 'state a fill price' }).locator('input').fill(String(e.statedPrice));
      if (e.qty !== undefined) await row.locator('td[data-label="Quantity"] input').first().fill(String(e.qty));
    }
  };
}

/** A strategy instance's drawer, opened from the list of strategy instances on the Strategies page (any status). */
export async function openStrategyDrawer(ui, ctx, strategyId) {
  const { page } = ui;
  await ui.closeOverlays();
  await ui.reloadAt('#/strategy');
  const list = ui.section(page.locator('main'), 'Strategy instances in this Book');
  await list.getByRole('button', { name: exactly('All') }).click();
  const row = list.locator('tbody tr', { hasText: strategyId }).first();
  await row.click();
  const drawer = page.getByRole('dialog').filter({ has: page.locator('header h3', { hasText: /^Positions/ }) });
  await drawer.waitFor();
  return drawer;
}

/** The status the drawer displays, against the API's. */
async function statusProblems(drawer, strategy) {
  const shown = (await drawer.locator('header .pill').first().innerText()).trim();
  const want = STATUS_WORDS[strategy.status] || strategy.status;
  return shown === want ? [] : [`strategy instance ${strategy.id}: the drawer shows "${shown}", the API says ${strategy.status} ("${want}")`];
}

/** The answer the hedge panel shows, against the API's stored request. */
async function hedgePanelProblems(ui, panel, r) {
  const out = [];
  if (!r) return ['The hedge panel shows no answer: the page sent no hedge request.'];
  const pill = panel.locator('[data-state]').first();
  await pill.waitFor();
  const state = await pill.getAttribute('data-state');
  if (state !== r.state) out.push(`hedge panel: state "${state}", the API has ${r.state}`);
  const text = (await panel.innerText()).replace(/\s+/g, ' ');
  if (r.source && r.source.kind !== 'shaffer-hedge' && !/demo fixture|test fixture/i.test(text)) out.push(`hedge panel: the answer came from ${r.source.label} but the panel does not label it as a fixture`);
  const proposed = (r.request?.proposedLegs || []).filter((l) => l.isProtection).length;
  const linked = (r.request?.linkedProtection || []).filter((h) => h.allocatedUnits > 0 || h.capacity?.units === null).length;
  if ((proposed || linked) && !/This package already has protection/.test(text)) out.push('hedge panel: the request carries protection already in place, but the panel does not say so');
  if (!(proposed || linked) && /This package already has protection/.test(text)) out.push('hedge panel: says the package already has protection, but the request carries none');
  return out;
}

export const actions = {
  /** A package built on the Strategies page from an execution template, previewed and confirmed. */
  async package(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    if (!step.strategyPage) return undefined;
    const want = resolveRefs(await resolvePositionRefs(t, ctx, { ...step.input }), ctx);
    const { main } = await fillStrategyPage(ui, t, ctx, step);
    let sentInput = null;
    const out = await previewAndConfirm(ui, ctx, async () => {
      const req = ui.page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/strategies/preview');
      await ui.button(main, 'Preview package').click();
      try { sentInput = (await req).postDataJSON(); } catch { sentInput = null; }
    }, {
      expectsRefusal,
      edit: step.editLegs ? editLegsIn(ui, step.editLegs) : undefined,
      acknowledge: Boolean(step.acknowledgeProtection),
    });
    const problems = [...(out.problems || [])];
    if (sentInput) problems.push(...requestProblems(sentInput, want));
    if (out.strategy && step.as && !ctx.lots.has(step.as)) ctx.nameLot(step.as, out.strategy.id, step.instrument);
    if (out.strategy?.id && out.strategy.unit?.id) (ctx.strategyUnits ||= new Map()).set(out.strategy.id, out.strategy.unit.id);
    // `contractAs`: the contract a leg registered on confirmation (a margin loan, for example) gets the step's key, as the
    // engine and API levels do (lib/actions.mjs, learnContracts): the new instruments of this submission, in leg order.
    if (step.contractAs && out.strategy) {
      const last = out.strategy.orders.at(-1)?.submission;
      const made = out.strategy.orders.filter((o) => o.submission === last && o.instrument && !ctx.idToKey.has(o.instrument.id) && !Object.values(ctx.instruments).some((i) => i.id === o.instrument.id));
      const keys = [].concat(step.contractAs);
      for (let i = 0; i < keys.length; i++) {
        if (!keys[i]) continue;
        if (!made[i]) { problems.push(`Step "${step.id}" names contract ${i + 1} "${keys[i]}", but the confirmation registered no instrument for it.`); continue; }
        ctx.instruments[keys[i]] = await t.getInstrument(made[i].instrument.id);
        ctx.idToKey.set(made[i].instrument.id, keys[i]);
      }
      if (out.strategy) {
        const { normalizeResult } = await import('../../lib/normalize.mjs');
        out.result = normalizeResult(out.strategy, last, ctx);
      }
    }
    return { ...out, problems };
  },

  /** The hedge request the page sends, and the answer its hedge panel shows. */
  async hedge_request(ui, t, ctx, step) {
    if (!step.strategyPage) return undefined;
    const { panel, answer } = await fillStrategyPage(ui, t, ctx, step);
    const { hedgeRequestView } = await import('../../lib/actions.mjs');
    if (answer) ctx.lastHedgeRequest = answer;
    return { result: answer ? hedgeRequestView(answer, ctx) : null, problems: await hedgePanelProblems(ui, panel, answer) };
  },

  /** Close an exact amount of one position (the strategy instance's Manage panel). Other closes take the shared path. */
  async close(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    if (step.qty === undefined || step.qty === null) return undefined;
    const lot = ctx.lot(step.lot);
    const inst = ctx.inst(step.instrument || lot.instrument);
    const s = await t.strategy(lot.strategyId);
    const p = s.positions.find((x) => x.instrument.id === inst.id);
    if (!p) throw new Error(`"${step.lot}" holds no ${step.instrument || lot.instrument} to close.`);
    const drawer = await openStrategyDrawer(ui, ctx, lot.strategyId);
    const field = ui.field(ui.section(drawer, 'Manage'), 'Close an exact');
    const which = field.locator('select');
    if (await which.count()) await which.first().selectOption(p.positionId);
    await field.locator('input').first().fill(String(step.qty));
    return previewAndConfirm(ui, ctx, () => ui.button(field, 'Preview close of this amount').click(), { expectsRefusal });
  },

  /** Retry the failed legs, or unwind what filled: the Residual exposure panel of a package that needs attention. */
  async recover(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategyDrawer(ui, ctx, lot.strategyId);
    const name = step.how === 'retry' ? 'Retry the failed legs' : 'Unwind what filled';
    const btn = ui.button(drawer, name);
    if (!await btn.count()) return { refusal: { message: `The strategy instance offers no "${name}": it is ${(await t.strategy(lot.strategyId)).status}.`, where: 'strategy instance' } };
    return previewAndConfirm(ui, ctx, () => btn.click(), { expectsRefusal });
  },

  /** Accept as it stands (with its dialog), or Cancel working legs. */
  async strategy_action(ui, t, ctx, step) {
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategyDrawer(ui, ctx, lot.strategyId);
    const action = /^\/api\/strategies\/[^/]+\/action$/;
    let r;
    if (step.how === 'accept') {
      const btn = ui.button(drawer, 'Accept as it stands');
      if (!await btn.count()) return { refusal: { message: 'The strategy instance offers no "Accept as it stands".', where: 'strategy instance' } };
      await btn.click();
      const dlg = ui.dialog(/^Accept the position as it stands/);
      await dlg.waitFor();
      r = await ui.respondsTo('POST', action, () => ui.button(dlg, 'Accept as it stands').click());
      if (r.ok) await dlg.waitFor({ state: 'hidden' });
    } else if (step.how === 'cancel_working') {
      const btn = ui.button(drawer, 'Cancel working legs');
      if (!await btn.count()) return { refusal: { message: 'The strategy instance offers no "Cancel working legs": no leg is working.', where: 'strategy instance' } };
      r = await ui.respondsTo('POST', action, () => btn.click());
    } else throw new Error(`Step "${step.id}": strategy_action needs how: 'accept' or 'cancel_working'.`);
    if (!r.ok) { await ui.page.locator('.toasts .toast, .notice.err', { hasText: r.body?.error || 'no message' }).first().waitFor(); return { refusal: { message: r.body?.error, status: r.status, where: 'message' } }; }
    const { normalizeResult } = await import('../../lib/normalize.mjs');
    // The drawer reloads after the action: its status must be the new one.
    const after = await t.strategy(lot.strategyId);
    await drawer.locator('header .pill', { hasText: exactly(STATUS_WORDS[after.status] || after.status) }).first().waitFor();
    return { result: normalizeResult(after, null, ctx), problems: await statusProblems(drawer, after) };
  },

  /** The strategy instance as its drawer shows it (status), against the API; the API's view is the step's result. */
  async strategy_check(ui, t, ctx, step) {
    const lot = ctx.lot(step.lot);
    const s = await t.strategy(lot.strategyId);
    const drawer = await openStrategyDrawer(ui, ctx, lot.strategyId);
    const { normalizeResult } = await import('../../lib/normalize.mjs');
    return { result: normalizeResult(s, null, ctx), problems: await statusProblems(drawer, s) };
  },

  /**
   * Roll: the Roll dialog of the strategy instance (Manage, Roll). Every option position of the instance is selected
   * when the dialog opens; `positions` narrows that. The new expiration is typed (no option chain is supplied for the
   * fixtures), the new strike only when one option is rolled alone; a futures position takes the month named by `into`.
   */
  async roll(ui, t, ctx, step, { previewAndConfirm, expectsRefusal }) {
    const lot = ctx.lot(step.lot);
    const drawer = await openStrategyDrawer(ui, ctx, lot.strategyId);
    const roll = ui.button(drawer, 'Roll');
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

  /** Repay (or withdraw) a loan or deposit a package's financing leg opened: its Repay button, as the loan family's driver does it. */
  async repay(ui, t, ctx, step, tools) {
    const { actions: loan } = await import('./loan.mjs');
    return loan.repay(ui, t, ctx, step, tools);
  },

  /** The scripted hedge service stands in for Shaffer Hedge: set through the API, like any fixture. */
  async hedge_script(ui, t, ctx, step) {
    await t.http.post('/api/demo/hedge-script', resolveRefs(step.script, ctx));
    return {};
  },

  /** t2: repay a loan that a package's financing leg drew: the Repay button on the Account's borrowings (drivers/browser/loan.mjs). */
  async repay(ui, t, ctx, step, tools) {
    const loan = await import('./loan.mjs');
    return loan.actions.repay(ui, t, ctx, step, tools);
  },
};
