// What a spec step means, executed against a Terminal client (engine or API level).
//
// The requests built here are the ones the screens build: a ticket's package input is assembled the
// way web/views/instrument.js assembles it, a reduction goes through the strategy's "close" preview
// with an exact quantity, and a confirmation sends back the previewed legs with the cash figure
// that was displayed. The browser level does not use this file's request builders: it clicks.
//
// Step actions (see README "Steps" for the fields of each):
//   ticket, close, resize, package            trades, always preview then confirm
//   corporate_action, cashflow, lifecycle,    events recorded by hand
//   instrument_lifecycle, manual_price
//   register_instrument                       register another instrument mid-scenario (or assert that it is refused)
//   quote, close_price, fx_rate, rate, borrow controlled fixtures
//   clock                                     move the clock to an absolute instant and run a cycle
//   cycle                                     let one more engine cycle pass (working orders, partial fills)
//   transfer, deposit                         cash movements inside the Book / into Treasury
//   restart                                   close and reopen the application on the same database

import { eventsSince, normalizePreview, normalizeResult, observeState } from './normalize.mjs';

const SECURITY = new Set(['equity', 'fund', 'spot', 'crypto', 'bond', 'manual']);
export const TRADE_ACTIONS = new Set(['ticket', 'close', 'resize', 'package']);
export const FIXTURE_ACTIONS = new Set(['quote', 'close_price', 'fx_rate', 'rate', 'borrow']);
/** The cash requirement a confirmation sends back, as web/views/preview.js builds it. */
export const expectedOf = (pv) => ({ cash: Object.fromEntries(Object.values(pv.totals.cash || {}).map((r) => [r.ccy, r.required])) });

/** Scenario context shared by the drivers: ids, names and the lots opened so far. */
export function createContext(spec) {
  const ctx = {
    spec, bookId: null, accountId: null, treasuryId: null,
    instruments: {}, // key -> instrument view
    idToKey: new Map(), lots: new Map(), strategyToLot: new Map(), lastEventId: 0,
    ownerKey: (unitId) => (unitId === ctx.accountId ? 'account' : unitId === ctx.treasuryId ? 'treasury' : unitId),
    unitId: (key) => (key === 'account' ? ctx.accountId : key === 'treasury' ? ctx.treasuryId : key),
    /** The spec's key for an instrument id. A securities borrow is named after what it borrows. */
    instrumentKey(id, view) {
      if (ctx.idToKey.has(id)) return ctx.idToKey.get(id);
      const und = view?.underlyingId || ctx.borrowOf?.get(id);
      return und && ctx.idToKey.has(und) ? `borrow:${ctx.idToKey.get(und)}` : id;
    },
    lotOf: (strategyId) => (strategyId ? ctx.strategyToLot.get(strategyId) ?? null : null),
    borrowOf: new Map(),
    inst(key) {
      const i = ctx.instruments[key];
      if (!i) throw new Error(`Step refers to instrument "${key}", which the spec does not define.`);
      return i;
    },
    lot(name) {
      const l = ctx.lots.get(name);
      if (!l) throw new Error(`Step refers to "${name}", which no earlier step opened (use \`as\`).`);
      return l;
    },
    nameLot(name, strategyId, instrumentKey) {
      if (!name) return;
      ctx.lots.set(name, { name, strategyId, instrument: instrumentKey });
      ctx.strategyToLot.set(strategyId, name);
    },
  };
  return ctx;
}

/** Fixture bodies that need the instruments to exist: the spec's `quotes`, `borrow` and `closes` blocks. */
export function fixtureCalls(spec, ctx) {
  const calls = [];
  for (const [key, q] of Object.entries(spec.quotes || {})) calls.push(['quote', { instrumentId: ctx.inst(key).id, ...q }]);
  for (const [key, b] of Object.entries(spec.borrow || {})) calls.push(['borrow', { instrumentId: ctx.inst(key).id, ...b }]);
  for (const [key, byDate] of Object.entries(spec.closes || {})) for (const [date, value] of Object.entries(byDate)) calls.push(['close', { instrumentId: ctx.inst(key).id, date, value }]);
  return calls;
}

/** Create the Book, its Account, settings, capital, funding, instruments and fixtures through a client. */
export async function setupThroughClient(t, spec, ctx = createContext(spec)) {
  const b = spec.book;
  const book = await t.createBook({ name: b.name, reportingCcy: b.reportingCcy });
  ctx.bookId = book.id;
  ctx.treasuryId = book.units.find((u) => u.kind === 'treasury').id;
  await t.updateSettings(book.id, b.settings);
  // FX and rate fixtures first: every ledger entry is converted to the reporting currency when it is posted.
  for (const [pair, rate] of Object.entries(spec.fx || {})) await t.fixture('fx', { pair, rate });
  for (const [code, r] of Object.entries(spec.rates || {})) await t.fixture('rate', typeof r === 'number' ? { code, value: r } : { code, ...r });
  for (const c of b.capital) await t.capital(book.id, { type: 'deposit', ccy: c.ccy, amount: c.amount, note: 'Test matrix starting capital' });
  const acct = await t.createAccount(book.id, { name: b.account.name });
  ctx.accountId = acct.id;
  for (const f of b.account.funding) await t.transfer(book.id, { fromUnitId: ctx.treasuryId, toUnitId: acct.id, ccy: f.ccy, amount: f.amount, purpose: 'Test matrix funding' });
  for (const [key, draft] of Object.entries(spec.instruments)) {
    const d = { ...draft };
    if (d.underlying) { d.underlyingId = ctx.inst(d.underlying).id; delete d.underlying; }
    const view = await t.createInstrument(d);
    ctx.instruments[key] = view;
    ctx.idToKey.set(view.id, key);
  }
  for (const [kind, body] of fixtureCalls(spec, ctx)) await t.fixture(kind, body);
  await t.tick();
  return ctx;
}

/** Learn which instruments are securities borrows of the spec's instruments (they are created by the engine). */
async function learnBorrows(t, ctx) {
  const pos = await t.accounting(ctx.bookId, 'positions', { scope: 'book' });
  for (const p of pos.positions) if (p.family === 'secloan' && p.instrument.underlyingId) ctx.borrowOf.set(p.instrument.id, p.instrument.underlyingId);
}

async function positionIn(t, ctx, lotName, instrumentKey) {
  const lot = ctx.lot(lotName);
  const key = instrumentKey || lot.instrument;
  const s = await t.strategy(lot.strategyId);
  const want = key.startsWith('borrow:') ? null : ctx.inst(key).id;
  const p = s.positions.find((x) => (want ? x.instrument.id === want : x.family === 'secloan'));
  if (!p) throw new Error(`"${lotName}" holds no open position in ${key}.`);
  return { lot, strategy: s, position: p };
}

const orderOf = (step) => ({ orderType: step.order?.orderType || 'market', limitPrice: step.order?.limitPrice ?? null, stopPrice: step.order?.stopPrice ?? null, tif: step.order?.tif || 'day', statedPrice: step.order?.statedPrice ?? null });

/** Replace '$inst:key', '$unit:account', '$lot:name' strings anywhere in a raw package input. */
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

/** Build the preview request for a trade step, as the screens would. */
async function previewFor(t, ctx, step) {
  const unitId = ctx.unitId(step.owner || 'account');
  // A ticket that is not the security ticket states the request it sends as `input` (README "Steps"); so does a
  // `package` step. '$inst:key', '$unit:account' and '$lot:name' stand for ids that exist only at run time.
  if (step.action === 'package' || (step.action === 'ticket' && step.input)) {
    const input = resolveRefs({ bookId: ctx.bookId, unitId, ...step.input }, ctx);
    return { lot: step.as, opens: !input.attachTo, instrument: step.instrument, pv: await t.preview(input) };
  }
  if (step.action === 'ticket') {
    const inst = ctx.inst(step.instrument);
    const order = orderOf(step);
    const security = SECURITY.has(inst.family);
    if (security && (step.side === 'sell' || step.side === 'buy_to_cover')) {
      const { lot, position } = await positionIn(t, ctx, step.from, step.instrument);
      return { lot: lot.name, pv: await t.previewAction(lot.strategyId, 'close', { positionIds: [position.positionId], qty: step.qty, order }) };
    }
    const legs = [];
    if (step.side === 'sell_short') {
      legs.push({ kind: 'borrow_sec', action: 'borrow_sec', instrumentId: inst.id, qty: step.qty, purpose: 'financing', role: 'borrow', borrow: step.borrow || null, note: 'Simulated securities borrow. The short sale cannot execute without it.' });
      legs.push({ kind: 'trade', action: step.side, instrumentId: inst.id, qty: step.qty, role: 'underlying', dependsOn: [1], ...order });
    } else legs.push({ kind: 'trade', action: step.side, instrumentId: inst.id, qty: step.qty, role: 'underlying', ...order });
    const simpleLong = step.side === 'buy' && security;
    const fin = step.financing;
    const input = {
      bookId: ctx.bookId, unitId, template: simpleLong ? 'long' : step.side === 'sell_short' ? 'short' : 'custom', underlyingId: inst.id, legs, origin: 'marketplace',
      financing: !fin || fin.mode === 'none' ? null : fin.mode === 'treasury' ? { mode: 'treasury' } : { mode: 'loan', rateType: 'fixed', rate: fin.rate },
      investmentStrategy: null, holdingPeriod: null, hedgeObjective: null,
    };
    return { lot: step.as, opens: true, instrument: step.instrument, pv: await t.preview(input) };
  }
  if (step.action === 'close') {
    const { lot, position } = await positionIn(t, ctx, step.lot, step.instrument);
    const fraction = (step.percent ?? 100) / 100;
    const args = step.scope === 'position' ? { positionIds: [position.positionId], fraction } : { fraction };
    return { lot: lot.name, pv: await t.previewAction(lot.strategyId, 'close', args) };
  }
  if (step.action === 'resize') {
    const lot = ctx.lot(step.lot);
    return { lot: lot.name, pv: await t.previewAction(lot.strategyId, 'resize', { factor: step.factor }) };
  }
  throw new Error(`Not a trade step: ${step.action}`);
}

const refusalOf = (err) => ({ message: err.message, status: err.status ?? null, code: err.code ?? null, where: 'request' });

/** Perform one step. Returns { preview?, result?, refusal? } in normalised form. */
export async function actThroughClient(t, ctx, step) {
  const expectsRefusal = step.status === 'unsupported' || step.status === 'blocked';
  if (TRADE_ACTIONS.has(step.action)) {
    let built;
    try { built = await previewFor(t, ctx, step); } catch (err) {
      if (err.status || expectsRefusal) return { refusal: refusalOf(err) };
      throw err;
    }
    const { pv } = built;
    const preview = normalizePreview(pv, ctx);
    if (pv.blocking) return { preview, refusal: { message: pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | '), status: null, code: pv.checks.find((c) => c.level === 'error').code, where: 'preview' } };
    if (expectsRefusal) return { preview }; // nothing refused it: the runner reports that
    let out;
    try {
      out = await t.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: expectedOf(pv) });
    } catch (err) {
      if (err.status) return { preview, refusal: { ...refusalOf(err), where: 'confirmation' } };
      throw err;
    }
    if (built.opens) ctx.nameLot(built.lot, out.strategy.id, built.instrument);
    return { preview, result: normalizeResult(out.strategy, pv.token, ctx) };
  }
  try {
    switch (step.action) {
      case 'corporate_action':
        await t.corporateAction({ instrumentId: ctx.inst(step.instrument).id, type: step.type || 'cash_dividend', exDate: step.exDate, payDate: step.payDate, amount: step.amount, ratioNum: step.ratioNum, ratioDen: step.ratioDen });
        return {};
      case 'cashflow': {
        const { position } = await positionIn(t, ctx, step.lot, step.instrument);
        await t.positionLifecycle(position.positionId, { action: 'cashflow', category: step.category, amount: step.amount, note: step.note });
        return {};
      }
      case 'lifecycle': {
        const { position } = await positionIn(t, ctx, step.lot, step.instrument);
        await t.positionLifecycle(position.positionId, step.body);
        return {};
      }
      case 'instrument_lifecycle': await t.instrumentLifecycle(ctx.inst(step.instrument).id, step.body); return {};
      case 'register_instrument': {
        const d = { ...step.draft };
        if (d.underlying) { d.underlyingId = ctx.inst(d.underlying).id; delete d.underlying; }
        const view = await t.createInstrument(d);
        if (step.as) { ctx.instruments[step.as] = view; ctx.idToKey.set(view.id, step.as); }
        return {};
      }
      case 'manual_price': {
        const i = ctx.inst(step.instrument);
        await t.manualPrice({ kind: 'price', subject: i.id, value: step.value ?? null, bid: step.bid ?? null, ask: step.ask ?? null, currency: i.tradingCcy, units: i.priceUnits, forDate: step.forDate || null, note: step.note || null });
        return {};
      }
      case 'quote': await t.fixture('quote', { instrumentId: ctx.inst(step.instrument).id, ...step.quote }); return {};
      case 'close_price': await t.fixture('close', { instrumentId: ctx.inst(step.instrument).id, date: step.date, value: step.value }); return {};
      case 'fx_rate': await t.fixture('fx', { pair: step.pair, rate: step.rate }); return {};
      case 'rate': await t.fixture('rate', { code: step.code, value: step.value, date: step.date }); return {};
      case 'borrow': await t.fixture('borrow', { instrumentId: ctx.inst(step.instrument).id, ...step.terms }); return {};
      case 'clock': await t.setClock(step.to); return {};
      case 'cycle': return {}; // nothing but the engine cycle the runner runs after every step
      case 'transfer': await t.transfer(ctx.bookId, { fromUnitId: ctx.unitId(step.from), toUnitId: ctx.unitId(step.to), ccy: step.ccy, amount: step.amount, purpose: step.purpose }); return {};
      case 'deposit': await t.capital(ctx.bookId, { type: 'deposit', ccy: step.ccy, amount: step.amount, note: step.note }); return {};
      case 'restart': await t.restart(); return {};
      default: throw new Error(`Unknown step action "${step.action}".`);
    }
  } catch (err) {
    if (err.status) return { refusal: refusalOf(err) };
    throw err;
  }
}

/**
 * A driver for the engine and API levels, built on a Terminal client.
 * `open({ sandbox, at })` returns the client; the driver owns it for one scenario.
 */
export function clientDriver(level, open) {
  let t = null;
  return {
    level,
    async setup(spec, sandbox) {
      t = await open({ sandbox, at: spec.start });
      const ctx = await setupThroughClient(t, spec);
      ctx.lastEventId = (await eventsSince(t, ctx, 0)).at(-1)?.id ?? 0;
      return ctx;
    },
    describe: () => t?.describe() ?? {},
    act: (ctx, step) => actThroughClient(t, ctx, step),
    /** One engine cycle, as the engine timer would run it after any action. */
    cycle: () => t.tick(),
    async observe(ctx) { await learnBorrows(t, ctx); return observeState(t, ctx); },
    async newEvents(ctx) {
      const ev = await eventsSince(t, ctx, ctx.lastEventId);
      if (ev.length) ctx.lastEventId = ev.at(-1).id;
      return ev;
    },
    integrity: (ctx) => t.integrity(ctx.bookId),
    restart: () => t.restart(),
    close: async () => { await t?.close(); t = null; },
    client: () => t,
  };
}
