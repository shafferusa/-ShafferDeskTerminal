// Turns what the Terminal returns into the small, stable shapes that specs state expectations in.
//
// Engine and API clients return the same JSON, so these functions serve both levels. The browser
// level builds the same shapes from what the screens display (drivers/browser.mjs) and is compared
// both with the spec and with the API's version of the same state.
//
// Names used in the shapes:
//   owner       'account' (the scenario's Account) or 'treasury'
//   instrument  the spec's own key for an instrument ('main', 'common', ...); the securities borrow of
//               'main' is 'borrow:main'
//   lot         the name a step gave to what it opened (`as: 'lot1'`)

const r2 = (x) => (typeof x === 'number' ? Math.round(x * 1e8) / 1e8 : x ?? null);

/** The observable state of the scenario's Book. See README "State sections". */
export async function observeState(t, ctx) {
  const book = ctx.bookId;
  const [pos, pend, pnlA, pnlB, balA, balB, borrow, ov, failed] = await Promise.all([
    t.accounting(book, 'positions', { scope: 'book' }), t.accounting(book, 'pending', { scope: 'book' }),
    t.accounting(book, 'pnl', { scope: ctx.accountId }), t.accounting(book, 'pnl', { scope: 'book' }),
    t.accounting(book, 'balance', { scope: ctx.accountId }), t.accounting(book, 'balance', { scope: 'book' }),
    t.accounting(book, 'borrowings', { scope: 'book' }), t.overview(book), t.accounting(book, 'failed', { scope: 'book' }),
  ]);
  const owner = (id) => ctx.ownerKey(id);

  const cash = {};
  for (const c of pos.cash) {
    (cash[owner(c.owner.id)] ||= {})[c.ccy] = {
      settled: c.settled, unsettled: c.unsettled, receivable: c.receivable, payable: c.payable, reserved: c.reserved, restricted: c.restricted, margin: c.margin,
      availableToTrade: c.availableToTrade, availableToWithdraw: c.availableToWithdraw, borrowed: c.borrowed, lent: c.lent,
    };
  }

  const positions = pos.positions.map((p) => ({
    instrument: ctx.instrumentKey(p.instrument.id), lot: ctx.lotOf(p.strategyId), owner: owner(p.unitId), direction: p.direction, qty: p.qty,
    avgCost: r2(p.avgCost), cost: p.cost, price: r2(p.price), value: p.ledgerCarried ? p.notional : p.mv, unrealized: p.ledgerCarried ? null : p.unrealized,
    restrictedCash: p.restrictedCash || 0, accrued: p.accrued || 0, provisional: Boolean(p.missing), priceSource: p.priceObs?.source ?? null, priceStatus: p.priceObs?.status ?? null,
  })).sort(byKeys('instrument', 'lot', 'qty'));

  const holdings = {};
  for (const h of pos.holdings) holdings[ctx.instrumentKey(h.instrument.id)] = { long: h.long, short: h.short, net: h.net };

  const pending = pend.awaitingSettlement.map((s) => ({
    instrument: s.instrument ? ctx.instrumentKey(s.instrument.id) : null, lot: ctx.lotOf(s.strategy?.id), owner: owner(s.unitId), dueDate: s.dueDate, amount: s.amount, ccy: s.ccy, into: s.accounts[0], status: s.status,
  })).sort(byKeys('dueDate', 'instrument', 'amount', 'lot'));
  const openOrders = [...pend.openOrders, ...pend.partiallyFilled].map((o) => ({ instrument: o.instrument ? ctx.instrumentKey(o.instrument.id) : null, kind: o.kind, action: o.action, status: o.status, qty: o.qty, filledQty: o.filledQty }));
  const lifecycle = pend.lifecycle.map((x) => ({ type: x.type, instrument: x.instrument ? ctx.instrumentKey(x.instrument.id) : null, dueDate: x.dueDate, status: x.status })).sort(byKeys('dueDate', 'type', 'instrument'));

  const pnlOf = (p) => ({
    ...Object.fromEntries(p.categories.map((c) => [c.key, c.rc])), unrealized: p.unrealized.current, fx: p.fx.current, total: p.investmentPnl,
    complete: p.complete, navEnd: p.nav.end, navDifference: p.nav.difference,
  });

  const balOf = (b) => {
    const out = { assets: b.assets.total.rc, liabilities: b.liabilities.total.rc, netAssets: b.netAssets.total.rc };
    const local = {};
    for (const l of b.lines) {
      out[l.key] = l.total.rc;
      for (const x of l.total.byCurrency) (local[x.ccy] ||= {})[l.key] = x.amount;
    }
    for (const row of b.representedBy) out[row.key] = row.total.rc;
    return { ...out, local };
  };

  const unit = (id) => ov.units.find((u) => u.id === id);
  return {
    cash, positions, holdings, pending, openOrders, lifecycle,
    pnl: { account: pnlOf(pnlA), book: pnlOf(pnlB) },
    nav: { account: unit(ctx.accountId)?.nav ?? null, treasury: unit(ctx.treasuryId)?.nav ?? null, book: ov.nav },
    provisional: { account: Boolean(unit(ctx.accountId)?.navProvisional), book: Boolean(ov.navProvisional) },
    balance: { account: balOf(balA), book: balOf(balB) },
    borrowings: borrow.items.map((b) => ({
      owner: owner(b.owner.id), family: b.family, type: b.type, instrument: b.securities?.instrument ? ctx.instrumentKey(b.securities.instrument.id) : null, lot: ctx.lotOf(b.strategy?.id),
      qty: b.securities?.qty ?? null, value: b.securities?.value ?? null, principal: b.principal, ccy: b.ccy, rate: b.rate?.rate ?? null, accrued: b.accrued, costToDate: b.interestToDate, collateralCash: b.collateral?.cash ?? null,
      nextPayment: b.schedule?.next?.date ?? null,
    })).sort(byKeys('instrument', 'lot')),
    failed: { orders: failed.orders.length, settlements: failed.settlementFailures.length, lifecycle: failed.lifecycleFailures.length },
    alerts: ov.alerts.map((a) => a.code).sort(),
  };
}

/** Ledger events (the audit history) with an id above `afterId`, oldest first, accruals included. */
export async function eventsSince(t, ctx, afterId) {
  const out = [];
  let before;
  for (;;) {
    const page = await t.accounting(ctx.bookId, 'history', { scope: 'book', accruals: '1', limit: 200, before });
    let done = false;
    for (const e of page.events) { if (e.id <= afterId) { done = true; break; } out.push(e); }
    if (done || !page.more) break;
    before = page.nextBefore;
  }
  return out.reverse().map((e) => ({
    id: e.id, type: e.type, summary: e.summary, owner: e.unitId ? ctx.ownerKey(e.unitId) : null, date: e.businessDate,
    cash: Object.fromEntries(e.cash.map((c) => [c.ccy, c.amount])), lot: ctx.lotOf(e.strategyId),
    entries: e.entries.map((x) => ({ owner: x.owner, account: x.account, ccy: x.ccy, amount: x.amount })),
  }));
}

/** The figures of a trade preview that a user reads before confirming. */
export function normalizePreview(pv, ctx) {
  const codes = (level) => pv.checks.filter((c) => c.level === level).map((c) => c.code);
  return {
    blocking: pv.blocking, name: pv.name, template: pv.template, intent: pv.intent,
    errors: codes('error'), warnings: codes('warning'), notes: codes('info'),
    messages: pv.checks.map((c) => `${c.level}: ${c.message}`),
    legs: pv.legs.map((l) => ({
      kind: l.kind, action: l.action, purpose: l.purpose, instrument: l.instrument ? ctx.instrumentKey(l.instrument.id, l.instrument) : null, qty: l.qty,
      estimate: l.price?.estimate ?? null, reference: l.price?.reference ?? null, model: l.price?.model ?? null, executable: l.price?.executable ?? null,
      priceSource: l.price?.observation?.source ?? null, settleDate: l.settleDate ?? null, calendar: l.calendar?.id ?? null,
      gross: l.gross ?? null, cash: l.cash ?? null, fees: l.feeTotal ?? 0, orderType: l.orderType, dependsOn: l.dependsOn || [],
      borrow: l.borrowInfo ? { available: l.borrowInfo.available, feeRate: l.borrowInfo.feeRate, dailyCost: l.borrowInfo.dailyCost, source: l.borrowInfo.source } : null,
      shortCollateral: l.shortCollateral ? { topUp: l.shortCollateral.topUp, marginHold: l.shortCollateral.marginHold } : null,
    })),
    cash: Object.fromEntries(Object.values(pv.totals.cash || {}).map((c) => [c.ccy, {
      purchases: c.purchases, proceeds: c.proceeds, restrictedProceeds: c.restrictedProceeds, fees: c.fees, margin: c.margin, collateral: c.collateral, reserved: c.reserved,
      financingIn: c.financingIn, financingOut: c.financingOut, required: c.required, available: c.available, shortfall: c.shortfall, netCash: c.netCash,
    }])),
  };
}

/** What a confirmation produced: the strategy's state and the legs of this submission with their fills. */
export function normalizeResult(strategy, submission, ctx) {
  const orders = strategy.orders.filter((o) => !submission || o.submission === submission);
  return {
    status: strategy.status, complete: strategy.complete,
    orders: orders.map((o) => ({
      kind: o.kind, action: o.action, instrument: o.instrument ? ctx.instrumentKey(o.instrument.id) : null, status: o.status, reason: o.statusReason ?? null,
      qty: o.qty, filledQty: o.filledQty, avgPrice: o.avgPrice ?? null,
      fills: o.fills.map((f) => ({ qty: f.qty, price: f.price ?? null, model: f.model, settleDate: f.settleDate ?? null, source: f.priceObservation?.source ?? null, status: f.priceObservation?.status ?? null, date: f.businessDate })),
    })),
  };
}

function byKeys(...keys) {
  return (a, b) => {
    for (const k of keys) {
      const x = a[k] ?? '', y = b[k] ?? '';
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
}
