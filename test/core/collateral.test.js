// Paper collateral agreements and clearing terms for OTC positions.
//
// Every expected figure below is worked out by hand from the configured terms and shown as
// arithmetic in a comment. The tests drive the real preview, order engine, end-of-day pass and
// ledger; only prices and marks are fixtures (manual marks, labelled manual by the data adapter).
//
// Marks: a swap is marked at its NPV per 100 notional and a CDS at its upfront per 100 notional, so
// for both   market value = quantity x mark / 100   (CDS index factor 1).
// A negative value is out of the money (we post); a positive one is in the money (we receive).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeBook, trade, ledgerImbalance, advance, goTo } from '../helpers.js';
import { createApi } from '../../server/api.js';

const USD = 'USD';
const mark = (app, instrumentId, value) => app.data.enterManual({ kind: 'price', subject: instrumentId, value, units: 'per 100 notional' });
const eod = (app, clock, date) => goTo(app, clock, `${date}T22:30:00.000Z`); // 17:30 New York: after the end-of-day cutoff
const morning = (app, clock, date) => goTo(app, clock, `${date}T15:00:00.000Z`);
const bal = (app, unit, account, ccy = USD) => app.ledger.balance(unit.id, account, ccy);
const posted = (app, unit, ccy = USD) => bal(app, unit, 'cash.margin', ccy);
const restricted = (app, unit, ccy = USD) => bal(app, unit, 'cash.restricted', ccy);
const owedBack = (app, unit, ccy = USD) => 0 - bal(app, unit, 'coll.received', ccy) || 0;
const cashOf = (app, unit, ccy = USD) => bal(app, unit, 'cash', ccy);
const line = (bs, key) => bs.lines.find((l) => l.key === key);
const cellRc = (bs, key, unitId) => line(bs, key)?.cells[unitId]?.rc ?? 0;
const totalRc = (bs, key) => line(bs, key)?.total.rc ?? 0;
const sound = (app, book) => { assert.deepEqual(ledgerImbalance(app), [], 'every event balances'); assert.deepEqual(app.agreements.reconcile(book.id), [], 'the collateral register agrees with the ledger'); };

const swapLegs = [
  { id: 'A', side: 'pay', type: 'fixed', ccy: USD, rate: 0.04, months: 6, dayCount: '30/360' },
  { id: 'B', side: 'receive', type: 'float', ccy: USD, index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' },
];
let serial = 0;
const withBasis = (basis) => (basis ? { collateralBasis: basis } : {});
const CONTRACTS = {
  trs: (inst, basis) => ({ productId: 'equity_trs', name: `TRS ALFA ${++serial}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: USD, underlyingId: inst.ALFA.id,
    terms: { effective: '2026-03-02', maturity: '2026-09-02', initialPrices: { A: 200 }, counterparty: 'Dealer A', ...withBasis(basis), legs: [
      { id: 'A', side: 'receive', type: 'return', ccy: USD, months: 3, underlyingId: inst.ALFA.id, passDividends: false },
      { id: 'B', side: 'pay', type: 'float', ccy: USD, index: 'SIM-ON', spread: 0.005, months: 3, dayCount: 'ACT/360' }] } }),
  cds: (inst, basis) => ({ productId: 'cds_single_name', name: `CDS Acme ${++serial}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: USD,
    terms: { referenceEntity: 'Acme Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, counterparty: 'Dealer A', ...withBasis(basis) } }),
  irs: (inst, basis) => ({ productId: 'interest_rate_swap', name: `IRS ${++serial}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: USD,
    terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', ...withBasis(basis), legs: swapLegs } }),
  forward: (inst, basis) => ({ productId: 'fx_forward', name: `EUR/USD forward ${++serial}`, marketView: 'FOREIGN_DERIV', venueType: 'otc', tradingCcy: USD,
    terms: { forwardType: 'fx', base: 'EUR', quote: USD, valueDate: '2026-06-02', counterparty: 'Dealer A', ...withBasis(basis) } }),
  otcoption: (inst, basis) => ({ productId: 'otc_option', name: `ALFA OTC call ${++serial}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: USD, underlyingId: inst.ALFA.id,
    terms: { right: 'C', strike: 200, expiration: '2026-06-19', counterparty: 'Dealer A', ...withBasis(basis) } }),
};
const leg = (contract, qty, { action = 'buy', price = 0 } = {}) => ({ kind: 'trade', action, qty, statedPrice: price, contract });
async function open(app, book, unit, contract, qty, opts) {
  const s = await trade(app, { bookId: book.id, unitId: unit.id, template: 'custom', legs: [leg(contract, qty, opts)] });
  const p = s.positions[0];
  return { s, positionId: p.positionId, instrumentId: p.instrument.id };
}
async function reduce(app, o, qty) {
  const pv = await app.packages.previewAction(o.s.id, 'close', qty ? { positionIds: [o.positionId], qty } : {});
  assert.equal(pv.blocking, 0, pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | '));
  return app.packages.submit({ ...pv.input, legs: pv.legs.map((l) => ({ ...l, statedPrice: 0 })), clientToken: pv.token, confirm: true });
}
const agreement = (app, book, units, terms = {}, extra = {}) => app.agreements.create(book.id, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: units.map((u) => u.id), terms, ...extra });
const collateralEvents = (app, book, scope) => app.accounting.history(book.id, scope, { limit: 500 }).events.filter((e) => /collateral/.test(e.type));

// ---- 1. behaviour follows the configured terms, not the product ------------------------------------------------

// The same three bases are applied to a total-return swap and to a credit default swap of the same
// notional, and marked identically. Expected figures depend on the basis only.
//   notional 1,000,000; marks -3 then +4 per 100:  value -30,000 then +40,000
//   (a) agreement: IA 5% = 50,000; VM, threshold 10,000:  post 30,000 - 10,000 = 20,000; then hold 40,000 - 10,000 = 30,000
//   (b) position-level terms: IA fixed 25,000; VM, no threshold:  post 30,000; then hold 40,000
//   (c) uncollateralized: nothing, whatever the mark
const BASES = {
  agreement: { ia: 50_000, vmPosted: 20_000, vmHeld: 30_000 },
  position: { ia: 25_000, vmPosted: 30_000, vmHeld: 40_000 },
  uncollateralized: { ia: 0, vmPosted: 0, vmHeld: 0 },
};
for (const product of ['trs', 'cds']) {
  for (const [basisType, want] of Object.entries(BASES)) {
    test(`${product.toUpperCase()} under ${basisType === 'agreement' ? 'a bilateral agreement with IA and VM' : basisType === 'position' ? 'position-level terms' : 'an explicit uncollateralized assumption'}: collateral follows the terms`, async () => {
      const { app, clock, inst } = makeApp();
      const { book, acct } = makeBook(app); // Alpha holds 500,000 USD
      const agr = basisType === 'agreement' ? agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true, threshold: 10_000, minimumTransfer: 0 }) : null;
      const basis = basisType === 'agreement' ? { type: 'agreement', agreementId: agr.id }
        : basisType === 'position' ? { type: 'position', independentAmount: { type: 'fixed', amount: 25_000 }, variationMargin: true, threshold: 0, minimumTransfer: 0 }
          : { type: 'uncollateralized' };
      const contract = CONTRACTS[product](inst, basis);

      // The preview states which basis applies and what it calls for.
      const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(contract, 1_000_000)] });
      assert.equal(pv.blocking, 0);
      assert.equal(pv.legs[0].collateral.basis.type, basisType);
      assert.equal(pv.legs[0].initialMargin, want.ia);
      assert.equal(pv.totals.cash.USD?.margin ?? 0, want.ia);
      const terms = Object.fromEntries(pv.legs[0].instrument.details)['Collateral terms'];
      assert.match(terms, { agreement: /Agreement "CSA Dealer A" with Dealer A \(bilateral, CSA-style\): Independent amount of 5\.00% of notional/, position: /Position-level terms\. Independent amount of 25,000\.00 USD for each position/, uncollateralized: /Uncollateralized \(paper assumption\)/ }[basisType]);

      const o = await open(app, book, acct, contract, 1_000_000);
      assert.equal(app.positions.get(o.positionId).data.collateralBasis.type, basisType, 'the basis is recorded on the position');
      assert.equal(posted(app, acct), want.ia, 'independent amount posted at the fill');
      assert.equal(cashOf(app, acct), 500_000 - want.ia);

      mark(app, o.instrumentId, -3); // 1,000,000 x -3 / 100 = -30,000: out of the money
      await eod(app, clock, '2026-03-02');
      assert.equal(posted(app, acct), want.ia + want.vmPosted);
      assert.equal(restricted(app, acct), 0);
      assert.equal(cashOf(app, acct), 500_000 - want.ia - want.vmPosted);

      mark(app, o.instrumentId, 4); // 1,000,000 x 4 / 100 = +40,000: in the money
      await eod(app, clock, '2026-03-03');
      assert.equal(posted(app, acct), want.ia, 'variation margin we posted has come back');
      assert.equal(restricted(app, acct), want.vmHeld, 'collateral received is restricted cash');
      assert.equal(owedBack(app, acct), want.vmHeld, 'with a matching liability');
      assert.equal(cashOf(app, acct), 500_000 - want.ia, 'and never settled cash');

      const view = app.agreements.positionView(app.positions.get(o.positionId));
      assert.equal(view.basis.type, basisType);
      if (basisType === 'uncollateralized') {
        assert.equal(view.independent, null);
        assert.equal(collateralEvents(app, book, acct.id).length, 0, 'no collateral event of any kind');
      } else {
        assert.equal(view.independent.held, want.ia);
        assert.equal(view.variation.received, want.vmHeld);
        // Every movement names its agreement (or says position-level terms), its positions, the requirement and the mark used.
        const ev = collateralEvents(app, book, acct.id).filter((e) => e.type === 'collateral.variation');
        assert.equal(ev.length, 2);
        for (const e of ev) {
          assert.equal(e.data.agreementId, agr ? agr.id : null);
          assert.equal(e.data.basis, basisType);
          assert.equal(e.data.positions[0].positionId, o.positionId);
          assert.ok(e.data.markObservationIds[0] > 0, 'the observation the mark came from is kept');
          assert.equal(e.data.positions[0].observation.status, 'manual');
        }
        assert.equal(ev[1].data.exposure, -30_000);
        assert.equal(ev[0].data.exposure, 40_000);
        assert.match(ev[0].summary, basisType === 'agreement' ? /under "CSA Dealer A" \(Dealer A\)/ : /under position-level terms/);
      }

      // Closing returns everything: nothing stays posted or held for a closed position.
      await reduce(app, o);
      assert.equal(posted(app, acct), 0);
      assert.equal(restricted(app, acct), 0);
      assert.equal(owedBack(app, acct), 0);
      assert.equal(cashOf(app, acct), 500_000, 'entered and closed at zero upfront: all cash is back');
      sound(app, book);
    });
  }
}

test('a new OTC contract cannot be previewed without a collateral basis, whatever the product', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  for (const [product, price] of [['irs', 0], ['trs', 0], ['cds', 1], ['forward', 1.09], ['otcoption', 5]]) {
    const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(CONTRACTS[product](inst, null), 100_000, { price })] });
    assert.equal(pv.blocking, 1, `${product}: blocked`);
    const c = pv.checks.find((x) => x.level === 'error');
    assert.equal(c.code, 'collateral-basis');
    assert.match(c.message, /states no collateral terms\. Choose a collateral agreement, enter position-level terms, or choose "Uncollateralized \(paper assumption\)"/);
    await assert.rejects(app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true }), /states no collateral terms/);
    // The same contract with an explicit choice goes through.
    const ok = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(CONTRACTS[product](inst, { type: 'uncollateralized' }), 100_000, { price })] });
    assert.equal(ok.blocking, 0, `${product}: ${ok.checks.filter((x) => x.level === 'error').map((x) => x.message).join(' | ')}`);
    assert.equal(ok.legs[0].collateral.basis.label, 'Uncollateralized (paper assumption)');
  }
  // An OTC option with no premium quote is still checked for its basis.
  const noPrice = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1000, contract: CONTRACTS.otcoption(inst, null) }] });
  assert.ok(noPrice.checks.some((c) => c.level === 'error' && c.code === 'collateral-basis'));
});

test('a forward and a written OTC option post under the same agreement terms; the older initialMarginPct field still works as position-level terms', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: false });
  // FX forward: buy 100,000 EUR at 1.10 -> notional 110,000 USD; IA 2% = 2,200.
  await open(app, book, acct, CONTRACTS.forward(inst, { type: 'agreement', agreementId: agr.id }), 100_000, { price: 1.10 });
  assert.equal(posted(app, acct), 2200);
  // Written OTC call on 1,000 units struck at 200 -> notional 200,000; IA 2% = 4,000. Premium 5 x 1,000 = 5,000 is received at settlement.
  const w = await open(app, book, acct, CONTRACTS.otcoption(inst, { type: 'agreement', agreementId: agr.id }), 1000, { action: 'sell', price: 5 });
  assert.equal(posted(app, acct), 2200 + 4000);
  assert.equal(app.ledger.positionBalance(w.positionId, 'cash.margin', USD), 4000);
  // Legacy field on a swap: 10% of 300,000 = 30,000, with no agreement involved.
  const legacy = CONTRACTS.irs(inst, null);
  legacy.terms.initialMarginPct = 0.1;
  const l = await open(app, book, acct, legacy, 300_000);
  assert.equal(app.ledger.positionBalance(l.positionId, 'cash.margin', USD), 30_000);
  const v = app.agreements.positionView(app.positions.get(l.positionId));
  assert.equal(v.basis.type, 'position');
  assert.equal(v.basis.source, 'legacy-field');
  assert.equal(v.basis.agreement, null);
  sound(app, book);
});

// ---- 2. threshold and minimum transfer amount -------------------------------------------------------------------

test('threshold and minimum transfer amount: no call inside the threshold, none below the minimum transfer, in either direction', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = agreement(app, book, [acct], { variationMargin: true, threshold: 25_000, minimumTransfer: 10_000 });
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  assert.equal(posted(app, acct), 0, 'no independent amount under these terms');
  const day = async (date, m) => { mark(app, o.instrumentId, m); await eod(app, clock, date); return app.agreements.positionView(app.positions.get(o.positionId)).variation; };

  let v = await day('2026-03-02', -2); // value -20,000: inside the 25,000 threshold -> required 0
  assert.equal(posted(app, acct), 0);
  assert.equal(v.required, 0);
  v = await day('2026-03-03', -3); // value -30,000: required 30,000 - 25,000 = 5,000, below the 10,000 minimum transfer -> nothing moves
  assert.equal(posted(app, acct), 0);
  assert.match(v.reason, /below the minimum transfer amount of 10,000\.00 USD/);
  v = await day('2026-03-04', -4); // value -40,000: required 15,000; transfer 15,000 >= 10,000 -> posted
  assert.equal(posted(app, acct), 15_000);
  assert.equal(v.balance, 15_000);
  v = await day('2026-03-05', -3.2); // value -32,000: required 7,000; a return of 8,000 is below the minimum transfer -> stays
  assert.equal(posted(app, acct), 15_000);
  v = await day('2026-03-06', -1); // value -10,000: required 0; a return of 15,000 >= 10,000 -> returned in full
  assert.equal(posted(app, acct), 0);
  assert.equal(cashOf(app, acct), 500_000);
  const moves = collateralEvents(app, book, acct.id).filter((e) => e.type === 'collateral.variation');
  assert.equal(moves.length, 2, 'two movements in five valuations');
  assert.deepEqual(moves.map((e) => e.data.delta), [-15_000, 15_000]);
  assert.equal(moves[1].data.threshold, 25_000);
  assert.equal(moves[1].data.minimumTransfer, 10_000);
  assert.equal(moves[1].data.requirementValue, 15_000);
  sound(app, book);
});

// ---- 3. netting scope ----------------------------------------------------------------------------------------------

test('per-position and per-Account netting give different calls for the same two positions', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  const beta = app.books.createAccount(book.id, { name: 'Beta' });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: beta.id, ccy: USD, amount: 300_000 });
  const terms = { variationMargin: true, threshold: 0, minimumTransfer: 0 };
  const perPosition = app.agreements.create(book.id, { name: 'CSA per position', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [acct.id], terms: { ...terms, nettingScope: 'position' } });
  const perAccount = app.agreements.create(book.id, { name: 'CSA per Account', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [beta.id], terms: { ...terms, nettingScope: 'account' } });
  // The same pair in each Account: 1,000,000 marked -3 (value -30,000) and 1,000,000 marked +2 (value +20,000).
  for (const [unit, agr] of [[acct, perPosition], [beta, perAccount]]) {
    const a = await open(app, book, unit, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
    const b = await open(app, book, unit, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
    mark(app, a.instrumentId, -3);
    mark(app, b.instrumentId, 2);
  }
  await eod(app, clock, '2026-03-02');
  // Each position alone: post 30,000 on the first AND hold 20,000 on the second.
  assert.equal(posted(app, acct), 30_000);
  assert.equal(restricted(app, acct), 20_000);
  assert.equal(owedBack(app, acct), 20_000);
  // Netted inside the Account: -30,000 + 20,000 = -10,000 -> post 10,000 and hold nothing.
  assert.equal(posted(app, beta), 10_000);
  assert.equal(restricted(app, beta), 0);
  assert.equal(owedBack(app, beta), 0);
  // The agreement shows what is posted on one set and held on another side by side, never netted against each other.
  const pp = app.agreements.view(app.agreements.get(perPosition.id));
  assert.deepEqual(pp.posted, [{ ccy: USD, amount: 30_000 }]);
  assert.deepEqual(pp.received, [{ ccy: USD, amount: 20_000 }]);
  const view = app.agreements.bookView(book.id);
  assert.equal(view.sets.length, 3, 'two single-position sets and one Account set');
  const set = view.sets.find((s) => s.key.startsWith('A:'));
  assert.equal(set.positions.length, 2);
  assert.equal(set.exposure, -10_000);
  sound(app, book);
});

// ---- 4. the receive side is not buying power -------------------------------------------------------------------------

test('collateral received is restricted cash with a matching liability: it cannot be traded with, withdrawn or transferred', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { account: 100_000 }); // Alpha holds 100,000
  const agr = agreement(app, book, [acct], { variationMargin: true });
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 5_000_000);
  mark(app, o.instrumentId, 3); // 5,000,000 x 3 / 100 = +150,000 held from the counterparty
  await eod(app, clock, '2026-03-02');
  const c = app.ledger.cash(acct.id, USD);
  assert.equal(c.restricted, 150_000);
  assert.equal(c.settled, 100_000);
  assert.equal(c.availableToTrade, 100_000, 'buying power is unchanged by collateral received');
  assert.equal(c.availableToWithdraw, 100_000);
  assert.equal(owedBack(app, acct), 150_000);
  // 120,000 is more than Alpha's own 100,000, although 250,000 of cash sits in its ledger.
  assert.throws(() => app.books.transfer({ bookId: book.id, fromUnitId: acct.id, toUnitId: treasury.id, ccy: USD, amount: 120_000 }), /has 100,000\.00 USD of settled USD available/);
  await morning(app, clock, '2026-03-03');
  const buy = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'long', underlyingId: inst.ALFA.id, targetNotional: 120_000 });
  assert.ok(buy.checks.some((x) => x.level === 'error' && x.code === 'cash'), 'a purchase larger than Alpha\'s own cash is blocked');
  // Net assets are unchanged by holding it: +150,000 restricted cash, -150,000 owed back.
  const bs = app.accounting.balanceSheet(book.id, acct.id);
  assert.equal(cellRc(bs, 'restricted', acct.id), 150_000);
  assert.equal(cellRc(bs, 'collateralReceived', acct.id), 150_000);
  assert.equal(bs.netAssets.total.rc, 100_000 + 150_000, 'net assets: 100,000 of cash plus the 150,000 unrealized gain on the swap');
  sound(app, book);
});

test('collateral received is never spent on another position\'s settlement, even a cover that settles the same day', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const pin = (px) => app.data.market.set(inst.ALFA.id, { bid: px, ask: px, value: px, bidSize: 1e6, askSize: 1e6 });
  pin(200);
  const short = await trade(app, { bookId: book.id, unitId: acct.id, template: 'short', underlyingId: inst.ALFA.id, quantity: 100 }); // proceeds 20,000, restricted when they settle
  const agr = agreement(app, book, [acct], { variationMargin: true });
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  mark(app, o.instrumentId, 3); // +30,000 held from the swap counterparty
  await eod(app, clock, '2026-03-02'); // short collateral marked to 102% x 20,000 = 20,400: a 400 top-up from cash
  await morning(app, clock, '2026-03-03'); // the short-sale proceeds settle into restricted cash
  assert.equal(restricted(app, acct), 20_400 + 30_000);
  assert.equal(cashOf(app, acct), 500_000 - 400);
  // The stock triples and the short is covered for same-day settlement: 100 x 600 = 60,000 is due at once,
  // far more than the 20,400 held against the short.
  pin(600);
  await app.data.refresh({ instruments: [inst.ALFA] });
  const pv = await app.packages.previewAction(short.id, 'close');
  const r = await app.packages.submit({ ...pv.input, legs: pv.legs.map((l) => (l.kind === 'trade' ? { ...l, settle: { lag: 0 } } : l)), clientToken: pv.token, confirm: true });
  assert.equal(r.strategy.orders.find((x) => x.action === 'buy_to_cover').status, 'filled');
  // 20,400 comes from the short's own restricted cash and 39,600 from Alpha's settled cash. The 30,000 that belongs to the counterparty is untouched.
  assert.equal(restricted(app, acct), 30_000);
  assert.equal(owedBack(app, acct), 30_000);
  const pay = app.accounting.history(book.id, acct.id, { type: 'settlement.pay' }).events[0];
  assert.deepEqual(pay.entries.filter((e) => e.account.startsWith('cash')).map((e) => [e.account, e.amount]).sort(), [['cash', -39_600], ['cash.restricted', -20_400]]);
  sound(app, book);
});

// ---- 5. release ------------------------------------------------------------------------------------------------------

test('reducing a position returns its share of the independent amount at once; closing it leaves nothing posted', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.1 }, variationMargin: true });
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  assert.equal(posted(app, acct), 100_000); // 10% x 1,000,000
  mark(app, o.instrumentId, -2); // -20,000
  await eod(app, clock, '2026-03-02');
  assert.equal(posted(app, acct), 120_000); // 100,000 + 20,000 of variation margin
  await morning(app, clock, '2026-03-03');
  await reduce(app, o, 400_000);
  assert.equal(app.positions.get(o.positionId).qty, 600_000);
  assert.equal(app.ledger.positionBalance(o.positionId, 'cash.margin', USD), 60_000, '10% x 600,000');
  assert.equal(posted(app, acct), 80_000, '60,000 independent amount + 20,000 variation margin until the next valuation');
  await eod(app, clock, '2026-03-03'); // 600,000 x -2 / 100 = -12,000 -> 8,000 comes back
  assert.equal(posted(app, acct), 72_000);
  await morning(app, clock, '2026-03-04');
  await reduce(app, o);
  assert.equal(posted(app, acct), 0);
  assert.equal(cashOf(app, acct), 500_000);
  const v = app.agreements.bookView(book.id);
  assert.equal(v.positions.length, 0);
  assert.deepEqual(v.totals.posted, []);
  assert.equal(app.agreements.view(app.agreements.get(agr.id)).inUse, false);
  // With nothing open or held, the agreement can be closed, and then takes no new position.
  app.agreements.close(agr.id);
  const again = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000)] });
  assert.ok(again.checks.some((c) => c.level === 'error' && c.code === 'collateral-closed'));
  sound(app, book);
});

test('maturity and a credit event release collateral like any other close', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.03 }, variationMargin: true });
  const c = await open(app, book, acct, CONTRACTS.cds(inst, { type: 'agreement', agreementId: agr.id }), 2_000_000);
  assert.equal(posted(app, acct), 60_000); // 3% x 2,000,000
  mark(app, c.instrumentId, 2); // +40,000 -> held from the counterparty
  await eod(app, clock, '2026-03-02');
  assert.equal(restricted(app, acct), 40_000);
  app.db.tx(() => app.products.get('cds').creditEvent(app, { inst: app.instruments.get(c.instrumentId), recovery: 0.4 }));
  assert.equal(posted(app, acct), 0, 'independent amount returned on termination');
  assert.equal(restricted(app, acct), 0, 'collateral held goes back to the counterparty');
  assert.equal(owedBack(app, acct), 0);
  // A forward that settles on its value date gives its independent amount back.
  const f = await open(app, book, acct, CONTRACTS.forward(inst, { type: 'position', independentAmount: { type: 'fixed', amount: 7_000 }, variationMargin: false }), 50_000, { price: 1.1 });
  assert.equal(app.ledger.positionBalance(f.positionId, 'cash.margin', USD), 7_000);
  await morning(app, clock, '2026-06-02');
  assert.equal(app.positions.get(f.positionId).qty, 0);
  assert.equal(app.ledger.positionBalance(f.positionId, 'cash.margin', USD), 0);
  assert.equal(posted(app, acct), 0);
  sound(app, book);
});

// ---- 6. sharing across Accounts ----------------------------------------------------------------------------------------

test('a shared agreement nets across its Accounts, is posted by the unit it names, and records the allocation of every movement', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app); // Treasury 500,000; Alpha 500,000
  const beta = app.books.createAccount(book.id, { name: 'Beta' });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: beta.id, ccy: USD, amount: 300_000 }); // Treasury 200,000
  // Netting across Accounts needs the posting unit to be named.
  assert.throws(() => agreement(app, book, [acct, beta], { variationMargin: true, nettingScope: 'shared' }), /name the Treasury or Account that posts and receives/);
  const agr = agreement(app, book, [acct, beta], { independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, nettingScope: 'shared' }, { postingUnitId: treasury.id });
  const a = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  const b = await open(app, book, beta, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 2_000_000);
  // Independent amounts: 2% x 1,000,000 = 20,000 and 2% x 2,000,000 = 40,000, both posted by Treasury.
  assert.equal(posted(app, treasury), 60_000);
  assert.equal(cashOf(app, treasury), 200_000 - 60_000);
  assert.equal(posted(app, acct), 0);
  assert.equal(posted(app, beta), 0);
  assert.equal(cashOf(app, acct), 500_000, 'the Accounts\' own cash does not move');

  mark(app, a.instrumentId, -3); // Alpha: -30,000
  mark(app, b.instrumentId, -0.5); // Beta: 2,000,000 x -0.5 / 100 = -10,000
  await eod(app, clock, '2026-03-02');
  // Net -40,000 -> Treasury posts 40,000, allocated 30,000 : 10,000.
  assert.equal(posted(app, treasury), 100_000);
  let ev = collateralEvents(app, book, 'book').filter((e) => e.type === 'collateral.variation');
  assert.equal(ev.length, 1);
  const alloc = (e) => Object.fromEntries(e.data.allocations.map((x) => [x.unitId, x.amount]));
  assert.deepEqual(alloc(ev[0]), { [acct.id]: 30_000, [beta.id]: 10_000 });
  assert.equal(ev[0].data.delta, 40_000);
  assert.equal(ev[0].data.holderUnitId, treasury.id);

  mark(app, a.instrumentId, -1); // Alpha: -10,000; Beta unchanged at -10,000
  await eod(app, clock, '2026-03-03');
  // Net -20,000 -> 20,000 comes back; the 20,000 left is split 10,000 : 10,000, so the whole return is Alpha's.
  assert.equal(posted(app, treasury), 80_000);
  ev = collateralEvents(app, book, 'book').filter((e) => e.type === 'collateral.variation');
  assert.deepEqual(alloc(ev[0]), { [acct.id]: -20_000, [beta.id]: 0 });
  const rows = app.db.all(`SELECT event_id, SUM(amount) AS s FROM collateral_movements WHERE kind = 'variation' GROUP BY event_id ORDER BY event_id`);
  assert.deepEqual(rows.map((r) => r.s), [40_000, -20_000], 'the allocations of each movement add up to the movement');
  const view = app.agreements.bookView(book.id, acct.id);
  assert.deepEqual(view.totals.posted, [], 'nothing is on Alpha\'s own balance sheet');
  const memo = view.totals.allocatedByOthers.filter((m) => m.unit.id === acct.id);
  assert.equal(memo.reduce((s, m) => s + m.amount, 0), 20_000 + 10_000, 'Alpha is told what Treasury has posted for it: 20,000 IA + 10,000 VM');
  // Balance sheet: the posted collateral is Treasury's asset, once.
  const bs = app.accounting.balanceSheet(book.id, 'book');
  assert.equal(cellRc(bs, 'margin', treasury.id), 80_000);
  assert.equal(cellRc(bs, 'margin', acct.id), 0);
  assert.equal(cellRc(bs, 'margin', beta.id), 0);
  assert.equal(totalRc(bs, 'margin'), 80_000);
  // Closing both gives everything back to Treasury.
  await morning(app, clock, '2026-03-04');
  await reduce(app, a);
  assert.equal(posted(app, treasury), 60_000, 'Alpha\'s 20,000 independent amount is back; the set still has Beta\'s position, so its variation margin waits for the valuation');
  await reduce(app, b);
  assert.equal(posted(app, treasury), 0);
  assert.equal(cashOf(app, treasury), 200_000);
  sound(app, book);
});

// ---- 7. never across Books -----------------------------------------------------------------------------------------------

test('an agreement belongs to one Book: it cannot cover, be posted by, or be used from another Book, and nothing nets across Books', async () => {
  const { app, clock, inst } = makeApp();
  const one = makeBook(app, { name: 'Book One' });
  const two = makeBook(app, { name: 'Book Two' });
  assert.throws(() => agreement(app, one.book, [one.acct, two.acct], { variationMargin: true }), /belongs to a different Book/);
  assert.throws(() => agreement(app, one.book, [one.acct], { variationMargin: true }, { postingUnitId: two.treasury.id }), /must be the Treasury or an Account of this Book/);
  const terms = { variationMargin: true, nettingScope: 'account' };
  const a1 = agreement(app, one.book, [one.acct], terms);
  const a2 = agreement(app, two.book, [two.acct], terms);
  assert.throws(() => app.agreements.update(a1.id, { unitIds: [one.acct.id, two.acct.id] }), /belongs to a different Book/);
  assert.throws(() => app.agreements.requireAgreement(a1.id, two.book.id), /belongs to a different Book/);
  // A contract in Book Two that names Book One's agreement is blocked.
  const foreign = await app.packages.preview({ bookId: two.book.id, unitId: two.acct.id, template: 'custom', legs: [leg(CONTRACTS.irs(inst, { type: 'agreement', agreementId: a1.id }), 1_000_000)] });
  assert.equal(foreign.blocking, 1);
  assert.equal(foreign.checks.find((c) => c.level === 'error').code, 'collateral-other-book');
  // Opposite positions in the two Books, same counterparty, same terms: each Book is called on its own.
  const p1 = await open(app, one.book, one.acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: a1.id }), 1_000_000);
  const p2 = await open(app, two.book, two.acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: a2.id }), 1_000_000);
  mark(app, p1.instrumentId, -3); // Book One: -30,000 -> posts 30,000
  mark(app, p2.instrumentId, 3); // Book Two: +30,000 -> holds 30,000. Across Books they would cancel; they must not.
  await eod(app, clock, '2026-03-02');
  assert.equal(posted(app, one.acct), 30_000);
  assert.equal(restricted(app, one.acct), 0);
  assert.equal(posted(app, two.acct), 0);
  assert.equal(restricted(app, two.acct), 30_000);
  assert.equal(app.agreements.bookView(one.book.id).agreements.length, 1);
  assert.equal(app.agreements.bookView(one.book.id).positions.length, 1);
  assert.ok(app.agreements.bookView(two.book.id).movements.every((m) => m.agreement.id === a2.id));
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM collateral_movements m JOIN agreements a ON a.id = m.agreement_id WHERE a.book_id <> m.book_id`).n, 0);
  // Even a position record pointed at the other Book's agreement (forced here in the database) moves nothing under it:
  // it is flagged, treated as uncollateralized, and what it had posted comes back. Book Two is not touched.
  app.db.run(`UPDATE positions SET data = json_set(data, '$.collateralBasis.agreementId', ?) WHERE id = ?`, a2.id, p1.positionId);
  mark(app, p1.instrumentId, -6);
  await eod(app, clock, '2026-03-03');
  const forced = app.agreements.positionView(app.positions.get(p1.positionId));
  assert.equal(forced.basis.flagged, true);
  assert.match(forced.basis.problem, /belongs to a different Book/);
  assert.equal(posted(app, one.acct), 0);
  assert.equal(restricted(app, two.acct), 30_000);
  assert.equal(app.agreements.bookView(two.book.id).positions.length, 1);
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM collateral_movements m JOIN agreements a ON a.id = m.agreement_id WHERE a.book_id <> m.book_id`).n, 0);
  sound(app, one.book);
  sound(app, two.book);
});

// ---- 8. failures ---------------------------------------------------------------------------------------------------------

test('a call that cannot be met fails visibly, is retried, and is delivered once', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app, { account: 30_000 }); // Alpha holds 30,000
  const agr = agreement(app, book, [acct], { variationMargin: true });
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  mark(app, o.instrumentId, -5); // -50,000: a call for 50,000 against 30,000 of cash
  await eod(app, clock, '2026-03-02');
  assert.equal(posted(app, acct), 0, 'nothing is posted, and nothing is funded silently');
  assert.equal(cashOf(app, acct), 30_000);
  let alerts = app.alerts.open(book.id).filter((a) => a.code === 'collateral.call_failed');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /Variation margin call of 50,000\.00 USD under "CSA Dealer A" failed: Alpha has 30,000\.00 USD of settled USD cash free/);
  let v = app.agreements.positionView(app.positions.get(o.positionId)).variation;
  assert.equal(v.status, 'failed');
  assert.equal(v.pending, 50_000);
  await advance(app, clock, 60_000, { ticks: 3 }); // retried each cycle, still short
  assert.equal(posted(app, acct), 0);
  assert.equal(app.accounting.history(book.id, acct.id, { type: 'collateral.call_failed' }).events.length, 1, 'the failure is in the audit trail once, not once per retry');
  // Funding arrives: the next cycle delivers the call.
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: USD, amount: 100_000 });
  await advance(app, clock, 60_000);
  assert.equal(posted(app, acct), 50_000);
  assert.equal(cashOf(app, acct), 130_000 - 50_000);
  assert.equal(app.alerts.open(book.id).filter((a) => a.code === 'collateral.call_failed').length, 0);
  // More cycles and the next valuation at the same mark post nothing more.
  await advance(app, clock, 60_000, { ticks: 3 });
  await eod(app, clock, '2026-03-03');
  assert.equal(posted(app, acct), 50_000, 'no double posting');
  assert.equal(collateralEvents(app, book, acct.id).filter((e) => e.type === 'collateral.variation').length, 1);
  v = app.agreements.positionView(app.positions.get(o.positionId)).variation;
  assert.equal(v.status, 'ok');
  sound(app, book);
});

test('an opening trade whose independent amount cannot be met is blocked in the preview', async () => {
  const { app, inst } = makeApp();
  const { book, acct } = makeBook(app, { account: 30_000 });
  const agr = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.05 } });
  // 5% x 1,000,000 = 50,000 against 30,000 of settled cash.
  const pv = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(CONTRACTS.cds(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000)] });
  assert.ok(pv.blocking >= 1);
  const c = pv.checks.find((x) => x.code === 'collateral-shortfall');
  assert.match(c.message, /The independent amount of 50,000\.00 USD on CDS Acme \d+ cannot be posted: Alpha has 30,000\.00 USD of settled USD cash free/);
  assert.equal(pv.totals.cash.USD.shortfall, 20_000);
  await assert.rejects(app.packages.submit({ bookId: book.id, unitId: acct.id, template: 'custom', legs: pv.legs, clientToken: pv.token, confirm: true }));
  assert.equal(posted(app, acct), 0);
  // 600,000 notional needs 30,000: exactly what is there.
  const ok = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', legs: [leg(CONTRACTS.cds(inst, { type: 'agreement', agreementId: agr.id }), 600_000)] });
  assert.equal(ok.blocking, 0);
});

// ---- 9. missing marks ------------------------------------------------------------------------------------------------------

test('a missing mark produces no call and a flag; the call follows once every position in the set is marked', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const agr = agreement(app, book, [acct], { variationMargin: true, nettingScope: 'account' });
  const a = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  const b = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  mark(app, a.instrumentId, -3); // -30,000 on one position; the other has no mark at all
  await eod(app, clock, '2026-03-02');
  assert.equal(posted(app, acct), 0, 'no call is made on half a netting set');
  assert.equal(collateralEvents(app, book, acct.id).length, 0);
  const v = app.agreements.positionView(app.positions.get(b.positionId));
  assert.equal(v.mark.missing, true);
  assert.equal(v.variation.status, 'cannot_value');
  assert.match(v.variation.reason, /cannot be valued: IRS \d+ has no mark\. No call is made until every position in the netting set has a mark/);
  assert.equal(app.alerts.open(book.id).filter((x) => x.code === 'collateral.unvalued').length, 1);
  assert.equal(app.agreements.bookView(book.id).failures[0].status, 'cannot_value');
  mark(app, b.instrumentId, 1); // +10,000 -> net -20,000
  await eod(app, clock, '2026-03-03');
  assert.equal(posted(app, acct), 20_000);
  assert.equal(app.alerts.open(book.id).filter((x) => x.code === 'collateral.unvalued').length, 0);
  sound(app, book);
});

// ---- 10. balance sheets -------------------------------------------------------------------------------------------------------

test('posted and received collateral appear once at Account, Treasury and Book scope, and net assets reconcile', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app); // capital 1,000,000: Treasury 500,000, Alpha 500,000
  const agr = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true, threshold: 10_000 });
  const one = await open(app, book, acct, CONTRACTS.trs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  const two = await open(app, book, acct, CONTRACTS.cds(inst, { type: 'uncollateralized' }), 2_000_000);
  const three = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'position', variationMargin: true }), 1_000_000);
  mark(app, one.instrumentId, -3); // -30,000: posts 30,000 - 10,000 = 20,000 on top of its 50,000 independent amount
  mark(app, two.instrumentId, -1); // -20,000: uncollateralized, nothing moves
  mark(app, three.instrumentId, 4); // +40,000: holds 40,000 under its position-level terms
  await eod(app, clock, '2026-03-02');
  const A = app.accounting.balanceSheet(book.id, acct.id);
  const T = app.accounting.balanceSheet(book.id, 'treasury');
  const B = app.accounting.balanceSheet(book.id, 'book');
  // Account: 500,000 - 50,000 - 20,000 = 430,000 cash; 70,000 posted; 40,000 restricted and owed back.
  assert.equal(cellRc(A, 'cash', acct.id), 430_000);
  assert.equal(cellRc(A, 'margin', acct.id), 70_000);
  assert.equal(cellRc(A, 'restricted', acct.id), 40_000);
  assert.equal(cellRc(A, 'collateralReceived', acct.id), 40_000);
  // Positions at market value: -30,000 - 20,000 + 40,000 = -10,000 (all entered at zero cost).
  assert.equal(cellRc(A, 'positions', acct.id), -10_000);
  // Assets 430,000 + 70,000 + 40,000 - 10,000 = 530,000; liabilities 40,000; net 490,000 = 500,000 funded - 10,000 unrealized.
  assert.equal(A.assets.total.rc, 530_000);
  assert.equal(A.liabilities.total.rc, 40_000);
  assert.equal(A.netAssets.total.rc, 490_000);
  // Treasury: none of it.
  for (const key of ['margin', 'restricted', 'collateralReceived']) assert.equal(line(T, key), undefined, `Treasury has no ${key} line`);
  assert.equal(T.netAssets.total.rc, 500_000);
  // Book: the Account's amounts, once.
  assert.equal(totalRc(B, 'margin'), 70_000);
  assert.equal(totalRc(B, 'restricted'), 40_000);
  assert.equal(totalRc(B, 'collateralReceived'), 40_000);
  assert.equal(cellRc(B, 'margin', treasury.id), 0);
  assert.equal(B.netAssets.total.rc, 990_000, '1,000,000 of capital - 10,000 unrealized');
  assert.equal(B.assets.total.rc - B.liabilities.total.rc, B.netAssets.total.rc);
  // The breakdown that travels with the balance sheet agrees with its lines.
  assert.deepEqual(B.collateral.posted.map((r) => [r.unit.id, r.ccy, r.amount]), [[acct.id, USD, 70_000]]);
  assert.deepEqual(B.collateral.received.map((r) => [r.unit.id, r.ccy, r.amount]), [[acct.id, USD, 40_000]]);
  assert.deepEqual(T.collateral.posted, []);
  sound(app, book);
});

// ---- haircut on a collateral currency other than the base currency ---------------------------------------------------------------

test('collateral in a currency other than the base currency is valued at its rate less the haircut', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  app.books.capital({ bookId: book.id, type: 'deposit', ccy: 'EUR', amount: 200_000 });
  app.books.transfer({ bookId: book.id, fromUnitId: treasury.id, toUnitId: acct.id, ccy: 'EUR', amount: 200_000 });
  app.data.market.set('EUR/USD', { value: 1.15 });
  // USD cash is not on the list, so it cannot be the collateral currency.
  assert.throws(() => agreement(app, book, [acct], { variationMargin: true, eligible: [{ type: 'cash', ccy: 'EUR', haircut: 0.08 }] }), /USD cash is not on the list of eligible collateral/);
  const agr = agreement(app, book, [acct], { baseCcy: USD, postingCcy: 'EUR', variationMargin: true, eligible: [{ type: 'cash', ccy: 'EUR', haircut: 0.08 }, { type: 'securities', description: 'US Treasuries', haircut: 0.02 }] });
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: agr.id }), 1_000_000);
  mark(app, o.instrumentId, -4.6); // -46,000 USD
  await eod(app, clock, '2026-03-02');
  // 1 EUR of collateral counts for 1.15 x (1 - 0.08) = 1.058 USD; 46,000 / 1.058 = 43,478.26 EUR.
  assert.equal(posted(app, acct, 'EUR'), 43_478.26);
  assert.equal(posted(app, acct, USD), 0);
  assert.equal(cashOf(app, acct, 'EUR'), 200_000 - 43_478.26);
  const ev = collateralEvents(app, book, acct.id).find((e) => e.type === 'collateral.variation');
  assert.equal(ev.data.haircut, 0.08);
  assert.equal(ev.data.fxPosting, 1.15);
  assert.equal(ev.data.requirementValue, 46_000);
  await eod(app, clock, '2026-03-03'); // same mark and rate: nothing to move
  assert.equal(posted(app, acct, 'EUR'), 43_478.26);
  // Securities on the list are recorded, not simulated, and the screen data says so.
  const view = app.agreements.view(app.agreements.get(agr.id));
  const sec = view.termRows.find((r) => r.label === 'Eligible: securities');
  assert.equal(sec.simulated, false);
  assert.ok(app.agreements.bookView(book.id).recordedOnly.some((r) => r.key === 'rehypothecation'));
  sound(app, book);
});

// ---- positions that predate collateral bases ---------------------------------------------------------------------------------------

test('a position with no basis on record is flagged and treated as uncollateralized; it can be reduced but not increased until its basis is recorded', async () => {
  const { app, clock, inst } = makeApp();
  const { book, acct } = makeBook(app);
  const o = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'uncollateralized' }), 1_000_000);
  // Put the position in the state of one opened before bases existed: nothing on the position, nothing on the contract.
  const i = app.instruments.get(o.instrumentId);
  const { collateralBasis: _gone, ...terms } = i.terms;
  app.instruments.update(i.id, { terms }, { system: true });
  app.db.run(`UPDATE positions SET data = json_remove(data, '$.collateralBasis') WHERE id = ?`, o.positionId);
  mark(app, o.instrumentId, -3);
  await eod(app, clock, '2026-03-02');
  const v = app.agreements.positionView(app.positions.get(o.positionId));
  assert.equal(v.basis.type, 'none');
  assert.equal(v.basis.flagged, true);
  assert.equal(v.basis.label, 'No collateral terms recorded (treated as uncollateralized)');
  assert.equal(posted(app, acct), 0);
  assert.equal(app.alerts.open(book.id).filter((a) => a.code === 'collateral.no_terms').length, 1);
  await morning(app, clock, '2026-03-03');
  const more = await app.packages.preview({ bookId: book.id, unitId: acct.id, template: 'custom', attachTo: o.s.id, legs: [{ kind: 'trade', action: 'buy', qty: 500_000, statedPrice: 0, instrumentId: o.instrumentId }] });
  assert.ok(more.checks.some((c) => c.level === 'error' && c.code === 'collateral-basis'), 'an increase is blocked');
  const less = await app.packages.previewAction(o.s.id, 'close', { positionIds: [o.positionId], qty: 250_000 });
  assert.equal(less.blocking, 0, 'a reduction is allowed');
  assert.ok(less.checks.some((c) => c.level === 'warning' && c.code === 'collateral-none'));
  // Recording the basis afterwards applies it from then on: 4% x 1,000,000 = 40,000.
  const agr = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.04 } });
  const after = app.agreements.setPositionBasis(o.positionId, { type: 'agreement', agreementId: agr.id });
  assert.equal(after.basis.type, 'agreement');
  assert.equal(posted(app, acct), 40_000);
  assert.equal(app.alerts.open(book.id).filter((a) => a.code === 'collateral.no_terms').length, 0);
  assert.throws(() => app.agreements.setPositionBasis(o.positionId, { type: 'uncollateralized' }), /already has its collateral basis on record/);
  sound(app, book);
});

// ---- agreements as records ---------------------------------------------------------------------------------------------------------

test('agreements: kinds, validation, edits while in use, and terms that are recorded but not simulated', async () => {
  const { app, inst } = makeApp();
  const { book, acct, treasury } = makeBook(app);
  assert.throws(() => app.agreements.create(book.id, { name: 'X', kind: 'bilateral', unitIds: [acct.id] }), /Name the counterparty/);
  assert.throws(() => app.agreements.create(book.id, { name: 'X', counterparty: 'D', kind: 'netting', unitIds: [acct.id] }), /Choose the kind of agreement/);
  assert.throws(() => app.agreements.create(book.id, { name: 'X', counterparty: 'D', kind: 'bilateral', unitIds: [] }), /List the Treasury or Accounts/);
  assert.throws(() => app.agreements.create(book.id, { name: 'X', counterparty: 'CCP', kind: 'cleared', unitIds: [acct.id], terms: { variationMargin: true, threshold: 5000 } }), /A cleared agreement has no threshold/);
  const cleared = app.agreements.create(book.id, { name: 'Clearing at CCP', counterparty: 'Example CCP via Clearing Broker', kind: 'cleared', unitIds: [acct.id, treasury.id], terms: { independentAmount: { type: 'pct', pct: 0.03 }, variationMargin: true } });
  assert.equal(app.agreements.view(cleared).kindLabel, 'Cleared');
  const none = app.agreements.create(book.id, { name: 'No CSA with Dealer B', counterparty: 'Dealer B', kind: 'uncollateralized', unitIds: [acct.id], terms: { independentAmount: { type: 'pct', pct: 0.5 }, variationMargin: true } });
  assert.deepEqual(none.terms.independentAmount, { type: 'none' }, 'an uncollateralized agreement carries no margin terms');
  assert.equal(none.terms.variationMargin, false);
  const csa = agreement(app, book, [acct], { independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true, recorded: { rehypothecation: 'Permitted', interestOnCollateral: 'SOFR flat', ratingThresholds: 'Zero below BBB' } });
  const rows = app.agreements.view(app.agreements.get(csa.id)).termRows;
  assert.deepEqual(rows.filter((r) => !r.simulated).map((r) => r.label), ['Rehypothecation of collateral received', 'Interest on cash collateral', 'Rating-based thresholds']);
  assert.ok(rows.filter((r) => r.simulated).length >= 6);
  // A cleared swap: 3% x 1,000,000 = 30,000 initial margin; an uncollateralized one under the other agreement: nothing.
  const c = await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: cleared.id }), 1_000_000);
  await open(app, book, acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: none.id }), 1_000_000);
  assert.equal(posted(app, acct), 30_000);
  // In use: the terms that define its netting sets and currency are fixed; the amounts can change.
  assert.throws(() => app.agreements.update(cleared.id, { terms: { nettingScope: 'account' } }), /the netting scope cannot change/);
  assert.throws(() => app.agreements.update(cleared.id, { unitIds: [treasury.id] }), /Alpha has open positions under this agreement/);
  assert.throws(() => app.agreements.close(cleared.id), /1 open position is under this agreement/);
  app.agreements.update(cleared.id, { terms: { independentAmount: { type: 'pct', pct: 0.04 } } });
  app.agreements.endOfDay('2026-03-02');
  assert.equal(app.ledger.positionBalance(c.positionId, 'cash.margin', USD), 40_000, 'the new 4% applies from the next valuation');
  // A trade by a unit the agreement does not cover is blocked.
  const pv = await app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [leg(CONTRACTS.irs(inst, { type: 'agreement', agreementId: csa.id }), 1_000_000)] });
  assert.equal(pv.checks.find((x) => x.level === 'error').code, 'collateral-not-covered');
  assert.equal(app.accounting.history(book.id, 'treasury', { type: 'collateral.agreement' }).events.length, 4, 'three agreements recorded and one changed, all in the audit trail');
  sound(app, book);
});

// ---- the routes the screens use ------------------------------------------------------------------------------------------------------

test('the collateral routes stay inside their Book', async () => {
  const { app, inst } = makeApp();
  const one = makeBook(app, { name: 'Book One' });
  const two = makeBook(app, { name: 'Book Two' });
  const api = createApi(app);
  const call = async (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, body, query }); };
  const made = await call('POST', `/api/books/${one.book.id}/agreements`, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [one.acct.id], terms: { independentAmount: { type: 'pct', pct: 0.05 }, variationMargin: true } });
  assert.equal(made.kindLabel, 'Bilateral (CSA-style)');
  assert.deepEqual(made.units.map((u) => u.name), ['Alpha']);
  assert.equal((await call('GET', `/api/books/${one.book.id}/agreements`)).items.length, 1);
  assert.equal((await call('GET', `/api/books/${two.book.id}/agreements`)).items.length, 0, 'the other Book does not list it');
  // The other Book cannot read, change or close it, and cannot name a unit of this Book.
  await assert.rejects(call('GET', `/api/books/${two.book.id}/agreements/${made.id}`), /belongs to a different Book/);
  await assert.rejects(call('PUT', `/api/books/${two.book.id}/agreements/${made.id}`, { name: 'Taken over' }), /belongs to a different Book/);
  await assert.rejects(call('POST', `/api/books/${two.book.id}/agreements/${made.id}/close`), /belongs to a different Book/);
  await assert.rejects(call('POST', `/api/books/${two.book.id}/agreements`, { name: 'Cross', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [one.acct.id] }), /belongs to a different Book/);
  assert.equal(app.agreements.get(made.id).name, 'CSA Dealer A');
  // A position of Book One is not reachable through Book Two, and a scope cannot name the other Book's Account.
  const o = await open(app, one.book, one.acct, CONTRACTS.irs(inst, { type: 'agreement', agreementId: made.id }), 1_000_000);
  await assert.rejects(call('PUT', `/api/books/${two.book.id}/positions/${o.positionId}/collateral-basis`, { basis: { type: 'uncollateralized' } }), /Position not found in this Book/);
  await assert.rejects(call('GET', `/api/books/${two.book.id}/collateral`, {}, { scope: one.acct.id }), /Unknown accounting scope/);
  const mine = await call('GET', `/api/books/${one.book.id}/collateral`, {}, { scope: one.acct.id });
  assert.equal(mine.positions.length, 1);
  assert.equal(mine.positions[0].independent.held, 50_000); // 5% x 1,000,000
  assert.equal((await call('GET', `/api/books/${two.book.id}/collateral`)).positions.length, 0);
  // Edit through the route: the change is applied and audited.
  const edited = await call('PUT', `/api/books/${one.book.id}/agreements/${made.id}`, { counterparty: 'Dealer A (London)', terms: { threshold: 20_000 } });
  assert.equal(edited.counterparty, 'Dealer A (London)');
  assert.equal(edited.terms.threshold, 20_000);
  assert.equal(edited.terms.independentAmount.pct, 0.05, 'terms that were not sent stay as they were');
  assert.deepEqual(await call('POST', `/api/books/${one.book.id}/collateral/retry`), { delivered: 0 });
});

