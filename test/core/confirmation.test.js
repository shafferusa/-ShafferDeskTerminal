// Confirmation validation: a confirmation executes only figures that were displayed.
//
// Every expected number below is worked out by hand in the comment beside it. Prices are pinned on
// the demo feed (bid = ask), so a fill price is exactly the pinned price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, ledgerImbalance, goTo } from '../helpers.js';
import { createApi } from '../../server/api.js';
import { BOOK_DEFAULTS } from '../../server/core/defaults.js';

const pin = (app, id, px, size = 1e6) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: size, askSize: size });
const confirm = (app, pv, extra = {}) => app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation, ...extra });
const refusal = async (p) => { try { await p; } catch (err) { return err; } throw new Error('the confirmation was accepted'); };
const change = (err, n, field) => err.details.changes.find((c) => (n === null ? c.scope === 'package' : c.n === n) && c.field === field);
const twoBuys = (book, acct, inst) => ({ bookId: book.id, unitId: acct.id, template: 'custom', name: 'Two purchases', legs: [
  { kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 1000 },
  { kind: 'trade', action: 'buy', instrumentId: inst.BRVO.id, qty: 2000 },
] });

test('the preview states the figures a confirmation confirms, per leg and in total, with the Book tolerances', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100); pin(app, inst.BRVO.id, 50);
  const pv = await app.packages.preview(twoBuys(book, acct, inst));
  const c = pv.confirmation;
  assert.equal(c.snapshotAt, pv.generatedAt, 'one snapshot: the confirmation is of the preview as generated');
  assert.deepEqual(c.tolerances, { legPricePct: 0.5, legAmountPct: 0.5, packageCashPct: 0.5, grossCashPct: 0.5, maxPreviewAgeSec: 300 });
  assert.deepEqual(c.tolerances, BOOK_DEFAULTS.confirmation, 'the defaults live in defaults.js');
  // Leg 1: 1,000 x 100.00 = 100,000.00 paid. Leg 2: 2,000 x 50.00 = 100,000.00 paid. Equity commission is zero.
  assert.deepEqual(c.legs.map((l) => [l.n, l.qty, l.price, l.cash, l.fees, l.settleDate, l.quote.status]), [
    [1, 1000, 100, -100_000, 0, '2026-03-03', 'simulated'], // T+1 from Monday 2 March 2026
    [2, 2000, 50, -100_000, 0, '2026-03-03', 'simulated'],
  ]);
  // Package: required = 100,000 + 100,000 = 200,000; net cash = -200,000; gross = |-100,000| + |-100,000| = 200,000.
  assert.equal(c.totals.USD.required, 200_000);
  assert.equal(c.totals.USD.netCash, -200_000);
  assert.equal(c.totals.USD.grossCash, 200_000);
  assert.equal(c.totals.USD.grossNotional, 200_000);
  assert.equal(c.totals.USD.shortfall, 0);
});

test('offsetting moves in two legs are refused leg by leg although the package cash is unchanged to the cent; the new figures need a new confirmation', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app); // the Account holds 500,000.00 USD
  pin(app, inst.ALFA.id, 100); pin(app, inst.BRVO.id, 50);
  const pv = await app.packages.preview(twoBuys(book, acct, inst));
  assert.equal(pv.totals.cash.USD.required, 200_000);
  // ALFA +3% to 103.00 and BRVO -3% to 48.50:
  //   leg 1 = 1,000 x 103.00 = 103,000.00   leg 2 = 2,000 x 48.50 = 97,000.00   total = 200,000.00, exactly as displayed.
  pin(app, inst.ALFA.id, 103); pin(app, inst.BRVO.id, 48.5);
  // The old guard compared only the cash required, which has not moved at all.
  const again = await app.packages.preview({ ...pv.input, legs: pv.legs, clientToken: pv.token });
  assert.equal(again.totals.cash.USD.required, 200_000, 'the package total hides both moves');
  const err = await refusal(confirm(app, pv));
  assert.equal(err.code, 'preview_changed');
  assert.equal(err.status, 409);
  assert.match(err.message, /legs 1, 2/, 'the refusal names both legs');
  assert.match(err.message, /Nothing was submitted/);
  // Leg 1, was / now: price 100 -> 103 = +3.00%; cash -100,000 -> -103,000 (a larger payment: -3.00% as a signed amount).
  assert.deepEqual([change(err, 1, 'price').was, change(err, 1, 'price').now, change(err, 1, 'price').changePct, change(err, 1, 'price').tolerancePct], [100, 103, 3, 0.5]);
  assert.deepEqual([change(err, 1, 'cash').was, change(err, 1, 'cash').now], [-100_000, -103_000]);
  // Leg 2: price 50 -> 48.50 = -3.00%; cash -100,000 -> -97,000.
  assert.deepEqual([change(err, 2, 'price').was, change(err, 2, 'price').now, change(err, 2, 'price').changePct], [50, 48.5, -3]);
  assert.deepEqual([change(err, 2, 'cash').was, change(err, 2, 'cash').now], [-100_000, -97_000]);
  // No package total moved, so none is reported: the refusal rests on the legs alone.
  assert.deepEqual(err.details.changes.filter((c) => c.scope === 'package'), []);
  assert.deepEqual(err.details.tolerances, pv.confirmation.tolerances);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0, 'nothing was submitted');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM orders').n, 0);

  // The refusal carries the new preview. Sending the OLD figures again is refused again: no silent re-pricing.
  const fresh = err.details.preview;
  assert.deepEqual(fresh.confirmation.legs.map((l) => [l.price, l.cash]), [[103, -103_000], [48.5, -97_000]]);
  assert.equal((await refusal(confirm(app, pv))).code, 'preview_changed');
  // Confirming the new figures executes them.
  const out = await confirm(app, fresh);
  const [o1, o2] = out.strategy.orders;
  assert.deepEqual([o1.status, o1.avgPrice, o2.status, o2.avgPrice], ['filled', 103, 'filled', 48.5]);
  // Confirmed -> fill -> ledger, to the cent.
  for (const [o, price, cash] of [[o1, 103, -103_000], [o2, 48.5, -97_000]]) {
    assert.equal(o.confirmed.basis, 'displayed');
    assert.equal(o.confirmed.snapshotAt, fresh.generatedAt);
    assert.deepEqual([o.confirmed.price, o.confirmed.cash, o.confirmed.fees, o.confirmed.settleDate], [price, cash, 0, '2026-03-03']);
    const f = o.fills[0];
    assert.deepEqual([f.price, f.gross, f.settleDate], [price, -cash, '2026-03-03']);
    assert.equal(f.confirm.exact, true, 'the fill is exactly what was confirmed');
    assert.equal(f.confirm.reason, 'Filled on the confirmed figures.');
    assert.deepEqual(f.confirm.variance, { price: 0, pricePct: 0, cash: 0, cashPct: 0, fees: 0, accrued: 0, margin: null, settleDate: null });
    const entries = app.db.all(`SELECT e.account, e.amount FROM entries e JOIN events v ON v.id = e.event_id WHERE v.order_id = ? AND v.type = 'trade.fill' ORDER BY e.id`, o.id);
    assert.deepEqual(entries.map((e) => [e.account, e.amount]), [['pos', -cash], ['pay.settle', cash]], 'position at cost against the payable; no other entry');
  }
  // Before settlement: 200,000.00 payable. After T+1: cash 500,000 - 103,000 - 97,000 = 300,000.00.
  assert.equal(app.ledger.cash(acct.id, 'USD').payable, 200_000);
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const cash = app.ledger.cash(acct.id, 'USD');
  assert.deepEqual([cash.settled, cash.payable], [300_000, 0]);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a buy and a sell that both rise leave net cash unchanged; the gross measure and each leg still refuse', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100); pin(app, inst.BRVO.id, 100);
  // Hold 1,000 BRVO first (100,000.00), then switch it into ALFA in one package.
  const held = (await confirm(app, await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 1000 }))).strategy;
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: held.id, legs: [
    { kind: 'trade', action: 'sell', instrumentId: inst.BRVO.id, qty: 1000 },
    { kind: 'trade', action: 'buy', instrumentId: inst.ALFA.id, qty: 1000 },
  ] });
  // Sale +100,000.00, purchase -100,000.00: net cash 0.00, gross 200,000.00.
  assert.deepEqual([pv.confirmation.totals.USD.netCash, pv.confirmation.totals.USD.grossCash], [0, 200_000]);
  // Both rise 2%: sale +102,000.00, purchase -102,000.00. Net cash is still 0.00; gross is 204,000.00 (+2.00%).
  pin(app, inst.ALFA.id, 102); pin(app, inst.BRVO.id, 102);
  const err = await refusal(confirm(app, pv));
  assert.equal(err.code, 'preview_changed');
  assert.equal(change(err, null, 'netCash'), undefined, 'net cash did not move, so it is not among the changes');
  assert.deepEqual([change(err, null, 'grossCash').was, change(err, null, 'grossCash').now, change(err, null, 'grossCash').changePct, change(err, null, 'grossCash').tolerance], [200_000, 204_000, 2, 'grossCashPct']);
  assert.deepEqual([change(err, 1, 'cash').was, change(err, 1, 'cash').now], [100_000, 102_000]);
  assert.deepEqual([change(err, 2, 'cash').was, change(err, 2, 'cash').now], [-100_000, -102_000]);
  assert.match(err.message, /legs 1, 2 and on the package totals/);
  // With the leg tolerances loosened to 5% the gross tolerance alone still refuses it.
  app.books.updateSettings(book.id, { confirmation: { legPricePct: 5, legAmountPct: 5, packageCashPct: 5 } });
  const err2 = await refusal(confirm(app, pv));
  assert.deepEqual(err2.details.changes.map((c) => [c.scope, c.field]), [['package', 'grossCash'], ['package', 'grossNotional']]);
  assert.equal(app.orders.forStrategy(held.id).length, 1, 'still only the original purchase');
});

test('tolerances are set per Book; a change they allow executes and is recorded on the order and the fill, with the reason', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const coin = inst.SIMCOIN;
  pin(app, coin.id, 30_000);
  const input = { bookId: book.id, unitId: acct.id, template: 'custom', name: 'Buy SIMCOIN', legs: [{ kind: 'trade', action: 'buy', instrumentId: coin.id, qty: 2 }] };
  const pv = await app.packages.preview(input);
  // Displayed: 2 x 30,000.00 = 60,000.00 paid; commission 10 bp of 60,000.00 = 60.00; digital assets settle the same day.
  assert.deepEqual([pv.confirmation.legs[0].price, pv.confirmation.legs[0].cash, pv.confirmation.legs[0].fees, pv.confirmation.legs[0].settleDate], [30_000, -60_000, 60, '2026-03-02']);
  assert.equal(pv.confirmation.totals.USD.required, 60_060);

  // +1% to 30,300.00: beyond the default 0.5%.
  pin(app, coin.id, 30_300);
  assert.equal((await refusal(confirm(app, pv))).code, 'preview_changed');
  // The Book raises its tolerances to 2%. The setting is stored on the Book and echoed in the next preview.
  const b2 = app.books.updateSettings(book.id, { confirmation: { legPricePct: 2, legAmountPct: 2, packageCashPct: 2, grossCashPct: 2 } });
  assert.deepEqual(b2.settingsOverrides.confirmation, { legPricePct: 2, legAmountPct: 2, packageCashPct: 2, grossCashPct: 2 });
  assert.equal((await app.packages.preview(input)).confirmation.tolerances.legPricePct, 2);
  await assert.rejects(() => Promise.resolve().then(() => app.books.updateSettings(book.id, { confirmation: { legPricePct: -1 } })), /non-negative/);

  // The same displayed figures (30,000.00) are now confirmed with the price at 30,300.00 (+1.00%, allowed).
  await goTo(app, clock, '2026-03-02T15:01:00.000Z'); // one minute later: a later cycle
  const out = await confirm(app, pv);
  const o = out.strategy.orders[0];
  assert.equal(o.status, 'filled');
  // What was confirmed is what was displayed; the pricing at confirmation and the permitted differences are kept beside it.
  assert.deepEqual([o.confirmed.basis, o.confirmed.price, o.confirmed.cash, o.confirmed.fees], ['displayed', 30_000, -60_000, 60]);
  assert.deepEqual([o.confirmed.atConfirmation.price, o.confirmed.atConfirmation.cash, o.confirmed.atConfirmation.fees], [30_300, -60_600, 60.6]);
  assert.deepEqual(o.confirmed.permitted.map((p) => [p.field, p.was, p.now, p.changePct]), [['price', 30_000, 30_300, 1], ['cash', -60_000, -60_600, -1], ['fees', 60, 60.6, 1], ['notional', 60_000, 60_600, 1]]);
  // Fill: 2 x 30,300.00 = 60,600.00; commission 10 bp = 60.60.
  const f = o.fills[0];
  assert.deepEqual([f.price, f.gross, f.fees[0].amount], [30_300, 60_600, 60.6]);
  // Variance against the confirmed figures: price +300.00 (+1.00%); cash -600.00; fees +0.60. Within the 2% tolerance.
  assert.deepEqual([f.confirm.variance.price, f.confirm.variance.pricePct, f.confirm.variance.cash, f.confirm.variance.fees], [300, 1, -600, 0.6]);
  assert.equal(f.confirm.exact, false);
  assert.equal(f.confirm.within, true);
  assert.match(f.confirm.reason, /Filled at the ask as priced at confirmation, after the price moved between the preview displayed and the confirmation/);
  assert.match(f.confirm.reason, /30300 against 30000 confirmed \(\+1%\)/);
  assert.match(f.confirm.reason, /Within the confirmation tolerances \(price 2%, amounts 2%\)/);
  // The permitted change is an explicit record in the history, not only a field on the fill.
  const ev = app.accounting.history(book.id, acct.id).events.find((e) => e.type === 'order.fill_variance');
  assert.ok(ev, 'a fill variance event is posted');
  assert.equal(ev.orderId, o.id);
  assert.match(ev.summary, /within tolerance/);
  // Ledger = fill, to the cent: position 60,600.00 at cost, commission 60.60, cash 60,660.60 out (same-day settlement).
  //   confirmed 60,000.00 + 60.00 = 60,060.00; recorded variance 600.00 + 0.60 = 600.60; 60,060.00 + 600.60 = 60,660.60.
  const bal = (acc) => app.ledger.balance(acct.id, acc, 'USD');
  assert.equal(bal('pos'), 60_600);
  assert.equal(bal('pnl.commission'), 60.6);
  assert.equal(bal('cash'), 500_000 - 60_660.6);
  assert.equal(-(f.confirm.confirmed.cash - f.confirm.confirmed.fees) + -(f.confirm.variance.cash - f.confirm.variance.fees), 60_660.6);
  assert.deepEqual(ledgerImbalance(app), []);

  // A Book that sets a tolerance to zero accepts no movement at all: one cent on the price is refused.
  app.books.updateSettings(book.id, { confirmation: { legPricePct: 0, legAmountPct: 0, packageCashPct: 0, grossCashPct: 0 } });
  const pv0 = await app.packages.preview(input);
  pin(app, coin.id, 30_300.01);
  const e0 = await refusal(confirm(app, pv0));
  assert.deepEqual([change(e0, 1, 'price').was, change(e0, 1, 'price').now, change(e0, 1, 'price').tolerancePct], [30_300, 30_300.01, 0]);
});

test('a Book that changed the old single threshold keeps its value as the package tolerance', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  app.books.updateSettings(book.id, { fill: { maxPreviewDriftPct: 4 }, confirmation: { legPricePct: 4, legAmountPct: 4, grossCashPct: 4 } });
  pin(app, inst.ALFA.id, 100);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000 });
  assert.equal(pv.confirmation.tolerances.packageCashPct, 4);
  pin(app, inst.ALFA.id, 103); // +3%: inside 4%
  assert.equal((await confirm(app, pv)).strategy.orders[0].avgPrice, 103);
});

test('changed non-numeric terms are refused whatever the tolerance: settlement date, preview age, borrow terms', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  // Tolerances wide open, so only the terms can refuse.
  app.books.updateSettings(book.id, { confirmation: { legPricePct: 50, legAmountPct: 50, packageCashPct: 50, grossCashPct: 50 } });
  pin(app, inst.ALFA.id, 100);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(pv.confirmation.legs[0].settleDate, '2026-03-03');

  // 301 seconds later, price unchanged: the displayed preview is older than the Book allows (300 s).
  clock.advance(301_000);
  const old = await refusal(confirm(app, pv));
  assert.equal(old.code, 'preview_changed');
  assert.deepEqual(old.details.changes.map((c) => [c.field, c.now, c.was]), [['previewAge', 301, 300]]);
  assert.match(old.message, /priced 301 seconds before the confirmation; the Book allows 300/);

  // The next day the same package would settle a day later: Tuesday 3 March + 1 business day = 4 March.
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const late = await refusal(confirm(app, pv));
  const sd = change(late, 1, 'settleDate');
  assert.deepEqual([sd.kind, sd.was, sd.now], ['term', '2026-03-03', '2026-03-04']);
  assert.match(late.message, /settlement date is now 2026-03-04, was 2026-03-03/);
  // With no age limit the settlement date alone still refuses.
  app.books.updateSettings(book.id, { confirmation: { maxPreviewAgeSec: 0 } });
  assert.deepEqual((await refusal(confirm(app, pv))).details.changes.map((c) => c.field), ['settleDate']);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0);

  // Borrow terms on a short sale: the fee doubles between preview and confirmation.
  app.data.market.setBorrow(inst.ALFA.id, { available: true, quantity: 100_000, feeRate: 0.01 });
  const short = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(short.blocking, 0);
  const b = short.confirmation.legs.find((l) => l.kind === 'borrow_sec');
  assert.deepEqual([b.borrow.available, b.borrow.feeRate], [true, 0.01]);
  app.data.market.setBorrow(inst.ALFA.id, { available: true, quantity: 100_000, feeRate: 0.02 });
  const fee = await refusal(confirm(app, short));
  assert.equal(fee.code, 'preview_changed');
  assert.deepEqual([change(fee, b.n, 'borrow.feeRate').was, change(fee, b.n, 'borrow.feeRate').now], [0.01, 0.02]);
  // The borrow disappears: the confirmation is blocked, and the change is named.
  app.data.market.setBorrow(inst.ALFA.id, { available: false, quantity: 0, feeRate: 0.02 });
  const gone = await refusal(confirm(app, short));
  assert.equal(gone.code, 'preview_failed');
  assert.deepEqual([change(gone, b.n, 'borrow.available').was, change(gone, b.n, 'borrow.available').now], ['available', 'unavailable']);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0);
});

test('financing terms, a missing leg and a changed quantity are changes of terms', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app, { cash: 1_000_000, account: 50_000 });
  pin(app, inst.ALFA.id, 100);
  // 1,000 ALFA = 100,000.00 with 50,000.00 in the Account: a 50,000.00 margin loan at 6% fixed is sized to the shortfall.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000, financing: { mode: 'loan', rateType: 'fixed', rate: 0.06 } });
  const loan = pv.confirmation.legs.find((l) => l.kind === 'loan');
  // Daily interest shown: 50,000.00 x 6% / 360 = 8.33.
  assert.deepEqual([loan.financing.amount, loan.financing.rate, loan.financing.rateType, loan.financing.dailyCost], [50_000, 0.06, 'fixed', 8.33]);
  assert.equal(pv.confirmation.totals.USD.financingIn, 50_000);
  // The same legs come back with the loan at 7%: a financing term changed.
  const legs7 = pv.legs.map((l) => (l.kind === 'loan' ? { ...l, contract: { ...l.contract, terms: { ...l.contract.terms, rate: 0.07 } } } : l));
  const err = await refusal(app.packages.submit({ ...pv.input, legs: legs7, clientToken: pv.token, confirm: true, expected: pv.confirmation }));
  assert.equal(err.code, 'preview_changed');
  assert.deepEqual([change(err, loan.n, 'financing.rate').kind, change(err, loan.n, 'financing.rate').was, change(err, loan.n, 'financing.rate').now], ['term', 0.06, 0.07]);
  // Daily cost 50,000.00 x 7% / 360 = 9.72: +16.69% on 8.33.
  assert.deepEqual([change(err, loan.n, 'financing.dailyCost').was, change(err, loan.n, 'financing.dailyCost').now], [8.33, 9.72]);
  // A different quantity than the one displayed (an edit that was never re-checked).
  const more = pv.legs.map((l) => (l.kind === 'trade' ? { ...l, qty: 400 } : l));
  const q = await refusal(app.packages.submit({ ...pv.input, legs: more, clientToken: pv.token, confirm: true, expected: pv.confirmation }));
  const tradeN = pv.legs.find((l) => l.kind === 'trade').n;
  assert.deepEqual([change(q, tradeN, 'qty').was, change(q, tradeN, 'qty').now], [1000, 400]);
  // A leg dropped after the preview.
  const dropped = await refusal(app.packages.submit({ ...pv.input, financing: null, legs: pv.legs.filter((l) => l.kind === 'trade').map((l) => ({ ...l, n: 1, dependsOn: [] })), clientToken: pv.token, confirm: true, expected: pv.confirmation }));
  assert.ok(['preview_changed', 'preview_failed'].includes(dropped.code));
  assert.ok(dropped.details.changes.some((c) => c.field === 'leg'), 'the missing leg is named');
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 0);
  // Unchanged, the package executes: the loan is drawn and the purchase fills.
  const out = await confirm(app, pv);
  assert.deepEqual(out.strategy.orders.map((o) => [o.kind, o.status]), [['loan', 'filled'], ['trade', 'filled']]);
  const lo = out.strategy.orders[0];
  assert.deepEqual([lo.confirmed.cash, lo.confirmed.financing.rate, lo.fills[0].confirm.exact], [50_000, 0.06, true]);
  assert.equal(app.ledger.balance(acct.id, 'loan.liab', 'USD'), -50_000);
});

test('a partial fill and a later fill at a new ask are each reconciled pro rata with the confirmed figures', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100, 300); // only 300 shares are displayed at the ask
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 1000, tif: 'gtc' });
  assert.deepEqual([pv.confirmation.legs[0].price, pv.confirmation.legs[0].cash], [100, -100_000]);
  let s = (await confirm(app, pv)).strategy;
  let o = s.orders[0];
  // First cycle: 300 of 1,000 at 100.00. Confirmed cash for 30% of the order: 30,000.00. No difference.
  assert.deepEqual([o.status, o.filledQty], ['partial', 300]);
  assert.deepEqual([o.fills[0].confirm.confirmed.share, o.fills[0].confirm.confirmed.cash, o.fills[0].confirm.actual.cash, o.fills[0].confirm.exact], [0.3, -30_000, -30_000, true]);
  assert.match(o.fills[0].confirm.reason, /Partial fill of 30% of the confirmed quantity/);
  // Next cycle the ask is 100.20 with 700 displayed: 700 x 100.20 = 70,140.00 against 70,000.00 confirmed for that share.
  pin(app, inst.ALFA.id, 100.2, 700);
  await goTo(app, clock, '2026-03-02T15:00:30.000Z');
  s = app.packages.strategyView(s.id);
  o = s.orders[0];
  assert.deepEqual([o.status, o.filledQty], ['filled', 1000]);
  const f2 = o.fills[1];
  assert.deepEqual([f2.qty, f2.price, f2.gross], [700, 100.2, 70_140]);
  // Variance: price +0.20 (+0.20%); cash 70,000.00 -> 70,140.00 paid = -140.00. Inside the 0.5% tolerance.
  assert.deepEqual([f2.confirm.confirmed.cash, f2.confirm.actual.cash, f2.confirm.variance.price, f2.confirm.variance.pricePct, f2.confirm.variance.cash, f2.confirm.within], [-70_000, -70_140, 0.2, 0.2, -140, true]);
  assert.match(f2.confirm.reason, /Filled at the ask on a later matching cycle/);
  // Order as a whole: confirmed 100,000.00; filled 30,000.00 + 70,140.00 = 100,140.00; recorded variances 0.00 + 140.00.
  assert.equal(o.fills.reduce((a, f) => a + f.gross, 0), 100_140);
  assert.equal(-o.confirmed.cash - o.fills.reduce((a, f) => a + f.confirm.variance.cash, 0), 100_140);
  assert.equal(app.ledger.balance(acct.id, 'pos', 'USD'), 100_140);
  assert.equal(app.ledger.cash(acct.id, 'USD').payable, 100_140);
  // A move outside tolerance on a working order is recorded as such: it is never passed off as within tolerance.
  pin(app, inst.BRVO.id, 50, 100);
  const pv2 = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 200, tif: 'gtc' });
  let s2 = (await confirm(app, pv2)).strategy;
  pin(app, inst.BRVO.id, 51, 100); // +2%
  await goTo(app, clock, '2026-03-02T15:01:00.000Z');
  s2 = app.packages.strategyView(s2.id);
  const late = s2.orders[0].fills[1];
  assert.deepEqual([late.price, late.confirm.variance.pricePct, late.confirm.within], [51, 2, false]);
  assert.match(late.confirm.reason, /Outside the confirmation tolerances/);
  assert.match(app.accounting.history(book.id, acct.id).events.find((e) => e.type === 'order.fill_variance' && e.orderId === s2.orders[0].id).summary, /outside tolerance/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a confirmation without displayed figures is recorded as priced at confirmation; the old cash-only form is still checked', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  pin(app, inst.ALFA.id, 100);
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 10 });
  const out = await app.packages.submit({ ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true });
  const o = out.strategy.orders[0];
  assert.deepEqual([o.confirmed.basis, o.confirmed.snapshotAt, o.confirmed.price, o.confirmed.cash, o.confirmed.atConfirmation], ['priced-at-confirmation', null, 100, -1000, null]);
  assert.equal(o.fills[0].confirm.exact, true);
  // Old form: only the cash required per currency. 10 x 100 = 1,000 displayed; at 103 it is 1,030 (+3%).
  const pv2 = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.BRVO.id, quantity: 10 });
  const shown = pv2.totals.cash.USD.required;
  pin(app, inst.BRVO.id, pv2.legs[0].price.estimate * 1.03);
  const err = await refusal(app.packages.submit({ ...pv2.input, legs: pv2.legs, clientToken: pv2.token, confirm: true, expected: { cash: { USD: shown } } }));
  assert.equal(err.code, 'preview_changed');
  assert.equal(err.details.changes[0].field, 'required');
  // Displayed figures that cannot be read are refused; they never count as "nothing to check".
  const bad = await refusal(app.packages.submit({ ...pv2.input, legs: pv2.legs, clientToken: pv2.token, confirm: true, expected: { legs: 'two' } }));
  assert.deepEqual([bad.code, bad.status], ['expected_invalid', 400]);
  assert.equal(app.packages.listStrategies({ bookId: book.id }).length, 1, 'only the first package exists');
});

test('the confirmation route refuses with the changes and the new preview; Settings stores the tolerances through the Book route', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const api = createApi(app);
  const call = (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  // Settings: PUT /api/books/:id { settings: { confirmation: ... } } stores the override and returns the merged settings.
  const saved = await call('PUT', `/api/books/${book.id}`, { settings: { confirmation: { legPricePct: 1.5, maxPreviewAgeSec: 60 } } });
  assert.deepEqual(saved.settings.confirmation, { legPricePct: 1.5, legAmountPct: 0.5, packageCashPct: 0.5, grossCashPct: 0.5, maxPreviewAgeSec: 60 });
  assert.deepEqual(saved.settingsOverrides.confirmation, { legPricePct: 1.5, maxPreviewAgeSec: 60 });
  assert.deepEqual((await call('GET', '/api/defaults')).book.confirmation, BOOK_DEFAULTS.confirmation);
  // Preview and confirm through the routes the screens use.
  pin(app, inst.ALFA.id, 100);
  const pv = await call('POST', '/api/strategies/preview', { bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, quantity: 100 });
  assert.equal(pv.confirmation.tolerances.legPricePct, 1.5);
  pin(app, inst.ALFA.id, 101); // +1%: inside the 1.5% leg price tolerance, outside the 0.5% amount and package tolerances
  const err = await refusal(call('POST', '/api/strategies', { ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: pv.confirmation }));
  assert.equal(err.status, 409);
  // 100 x 100 = 10,000 displayed; 100 x 101 = 10,100 now (+1.00%). The price itself (100 -> 101) is within its 1.5%.
  assert.deepEqual(err.details.changes.map((c) => [c.scope, c.field, c.was, c.now]), [
    ['leg', 'cash', -10_000, -10_100], ['leg', 'notional', 10_000, 10_100],
    ['package', 'required', 10_000, 10_100], ['package', 'netCash', -10_000, -10_100], ['package', 'purchases', 10_000, 10_100],
    ['package', 'grossCash', 10_000, 10_100], ['package', 'grossNotional', 10_000, 10_100],
  ]);
  const ok = await call('POST', '/api/strategies', { ...err.details.preview.input, legs: err.details.preview.legs, clientToken: err.details.preview.token, confirm: true, expected: err.details.preview.confirmation });
  assert.equal(ok.strategy.orders[0].avgPrice, 101);
  // The strategy route returns the confirmed figures and the fill reconciliation for the order table.
  const view = await call('GET', `/api/strategies/${ok.strategy.id}`);
  assert.deepEqual([view.orders[0].confirmed.price, view.orders[0].fills[0].confirm.exact], [101, true]);
});
