// Repos, reverse repos, buy/sell-backs and bond loans: the rules added in the r1 product round.
//   - a reverse repo lends no more than its collateral supports (value less haircut less any buffer), like a repo;
//   - a repo's collateral can be changed by agreement (margin call met, excess returned, substitution) and the cover
//     after a return or a substitution must still meet what is owed;
//   - a sell/buy-back fixes its forward price at inception and passes the coupon paid during its term to the buyer,
//     which reduces what is paid back;
//   - securities lent as a bond loan take cash collateral on the bonds' dirty value.
// Expected figures are worked by hand in the comments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goTo, ledgerImbalance, makeApp, makeBook, trade } from '../helpers.js';

const pin = (app, id, px) => app.data.market.set(id, { bid: px, ask: px, value: px, bidSize: 1e9, askSize: 1e9 });
const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);
const repoContract = (productId, name, terms) => ({ productId, name, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { rateType: 'fixed', dayCount: 'ACT/360', haircut: 0.02, ...terms } });
const errors = (pv) => pv.checks.filter((c) => c.level === 'error').map((c) => c.message).join(' | ');

test('a reverse repo lends no more than the collateral supports after the haircut and the buffer', async () => {
  const { app, inst } = makeApp();
  const { book, treasury } = makeBook(app, { cash: 2_000_000, account: 0 });
  pin(app, inst.SIMCORP29.id, 100);
  // SIMCORP29 5.50% 30/360, coupons 1 March / 1 September: on 2 March 2026 one day has accrued, 500,000 x 0.055 / 360 = 76.39.
  // Worth 500,076.39; less 2%: 490,074.86; less a 10,000 buffer: 480,074.86.
  const leg = (qty, buffer) => ({ kind: 'repo_open', action: 'reverse_repo', qty, contract: repoContract('reverse_repo', 'Reverse repo SIMCORP29', { collateralInstrumentId: inst.SIMCORP29.id, collateralQty: 500_000, rate: 0.04, term: 'term', endDate: '2026-03-16', buffer }) });
  const pv = await app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [leg(485_000, 10_000)] });
  assert.match(errors(pv), /The collateral received supports at most 480,074\.86 USD: 500,000 SIMCORP29 is worth 500,076\.39 USD \(500,000\.00 USD clean plus 76\.39 USD accrued interest\) and the haircut is 2\.00%, less the additional buffer of 10,000\.00 USD; 485,000\.00 USD requested\./);
  const ok = await app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [leg(480_000, 10_000)] });
  assert.equal(ok.blocking, 0, errors(ok));
  const c = ok.legs[0].financing.collateral;
  assert.deepEqual([c.worth, c.haircutAmount, c.buffer, c.supports], [500_076.39, 10_001.53, 10_000, 480_074.86]);
  // Without the buffer, 485,000 fits (490,074.86).
  assert.equal((await app.packages.preview({ bookId: book.id, unitId: treasury.id, template: 'custom', legs: [leg(485_000, 0)] })).blocking, 0);
});

test('a repo\'s collateral is topped up, returned and substituted by agreement; the cover must hold after a return', async () => {
  const { app, clock, inst } = makeApp();
  const { book, treasury } = makeBook(app, { cash: 4_000_000, account: 0 });
  const plugin = app.products.get('repo');
  pin(app, inst.SIMCORP29.id, 100);
  pin(app, inst.SIMGOV31.id, 100);
  const hold = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.SIMCORP29.id, qty: 1_200_000 }, { kind: 'trade', action: 'buy', instrumentId: inst.SIMGOV31.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const corp = hold.positions.find((p) => p.instrument.id === inst.SIMCORP29.id).positionId;
  const gov = hold.positions.find((p) => p.instrument.id === inst.SIMGOV31.id).positionId;
  // 1,000,000 SIMCORP29 on 3 March: 2 days accrued, 1,000,000 x 0.055 x 2 / 360 = 305.56; worth 1,000,305.56; less 5%: 950,290.28.
  const s = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'repo_open', action: 'repo', qty: 900_000, collateralPositionId: corp, contract: repoContract('bilateral_repo', 'Repo SIMCORP29', { collateralInstrumentId: inst.SIMCORP29.id, collateralQty: 1_000_000, haircut: 0.05, rate: 0.04, term: 'open' }) }] });
  const rp = s.positions[0].positionId;
  const ctx = () => { const pos = app.positions.get(rp); return { book, unit: treasury, inst: app.instruments.get(pos.instrument_id), pos }; };
  // The notes fall to 90: 900,000 + 305.56 (one more day accrues by the 3 March run: 1,000,000 x 0.055 x 2 / 360 still, the run is
  // for 3 March) less 5% = 855,290.28 against 900,000 plus a day's repo interest (100.00): short, flagged at the end of day.
  pin(app, inst.SIMCORP29.id, 90);
  await goTo(app, clock, '2026-03-03T22:30:00.000Z');
  assert.ok(app.alerts.open(book.id).some((a) => a.code === 'repo.margin'), 'the shortfall is flagged');
  // Returning collateral now is refused, with the figures.
  assert.throws(() => plugin.collateralChange(app, { ...ctx(), change: 'release', qty: 100_000 }), /After the return the cover would be .* short/);
  // More than the 200,000 free cannot be pledged.
  assert.throws(() => plugin.collateralChange(app, { ...ctx(), change: 'pledge', qty: 250_000 }), /Only 200,000 more SIMCORP29 is unencumbered in Treasury; 250,000 requested\./);
  // The margin call is met with the 200,000 free: 1,200,000 x 90 / 100 + 1,200,000 x 0.055 x 2 / 360 (366.67) = 1,080,366.67, less 5%
  // = 1,026,348.34 against 900,100.00 owed: the flag clears at once.
  const r = plugin.collateralChange(app, { ...ctx(), change: 'pledge', qty: 200_000 });
  near(r.cover, 1_026_348.34);
  assert.equal(app.positions.get(corp).pledged_qty, 1_200_000);
  assert.equal(app.alerts.open(book.id).some((a) => a.code === 'repo.margin'), false);
  // The notes recover to 100: 100,000 can go back (1,100,000 at 100 + 336.11 accrued, less 5%: 1,045,319.30 > 900,100).
  pin(app, inst.SIMCORP29.id, 100);
  plugin.collateralChange(app, { ...ctx(), change: 'release', qty: 100_000 });
  assert.equal(app.positions.get(corp).pledged_qty, 1_100_000);
  // Substitution by 1,000,000 SIMGOV31 (100 plus ACT/ACT accrued from 15 November: 108 of 181 days of 21,250 = 12,679.56; less 5%:
  // 962,045.58): the notes are released and the government bonds pledged.
  const sub = plugin.collateralChange(app, { ...ctx(), change: 'substitute', qty: 1_000_000, positionId: gov });
  near(sub.cover, 962_045.58);
  assert.equal(app.positions.get(corp).pledged_qty, 0);
  assert.equal(app.positions.get(gov).pledged_qty, 1_000_000);
  assert.equal(app.instruments.get(ctx().inst.id).terms.collateralInstrumentId, inst.SIMGOV31.id);
  // A substitution that would not cover is refused: 500,000 SIMCORP29 is worth about half of what is owed.
  assert.throws(() => plugin.collateralChange(app, { ...ctx(), change: 'substitute', qty: 500_000, positionId: corp }), /After the substitution the cover would be/);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a sell/buy-back fixes its forward price at inception and the coupon in the term reduces what is paid back', async () => {
  const { app, clock, inst } = makeApp();
  const { book, treasury } = makeBook(app, { cash: 2_000_000, account: 0 });
  const plugin = app.products.get('repo');
  pin(app, inst.SIMGOV31.id, 100);
  const hold = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.SIMGOV31.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  const gov = hold.positions[0].positionId;
  const cash0 = app.ledger.cash(treasury.id, 'USD').settled;
  // 990,000 at 4% ACT/360 from 3 March to 20 May (78 days); the 15 May coupon is 1,000,000 x 4.25% / 2 = 21,250, 5 days before the end.
  // Forward: 990,000 x (1 + 0.04 x 78 / 360) - 21,250 x (1 + 0.04 x 5 / 360) = 998,580.00 - 21,261.8056 = 977,318.19.
  const input = { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'repo_open', action: 'repo', qty: 990_000, collateralPositionId: gov, contract: repoContract('sell_buy_back', 'SBB SIMGOV31', { collateralInstrumentId: inst.SIMGOV31.id, collateralQty: 1_000_000, haircut: 0.01, rate: 0.04, term: 'term', endDate: '2026-05-20' }) }] };
  const pv = await app.packages.preview(input);
  assert.equal(pv.blocking, 0, errors(pv));
  assert.equal(pv.legs[0].financing.forward.amount, 977_318.19);
  assert.deepEqual(pv.legs[0].financing.forward.coupons.map((c) => [c.payDate, c.amount]), [['2026-05-15', 21_250]]);
  // A sell/buy-back is refused on the reverse repo side, and with a floating rate.
  const wrong = await app.packages.preview({ ...input, legs: [{ ...input.legs[0], action: 'reverse_repo' }] });
  assert.match(errors(wrong), /A sell\/buy-back raises cash against securities: it is entered on the Repo side/);
  const floating = await app.packages.preview({ ...input, legs: [{ ...input.legs[0], contract: repoContract('sell_buy_back', 'SBB float', { ...input.legs[0].contract.terms, rateType: 'floating', referenceRate: 'SOFR' }) }] });
  assert.match(errors(floating), /fixes its forward price at inception: the repo rate must be fixed/);
  const s = await trade(app, input);
  const pos = app.positions.get(s.positions[0].positionId);
  assert.equal(app.instruments.get(pos.instrument_id).terms.forward.amount, 977_318.19);
  // Its collateral cannot be changed.
  assert.throws(() => plugin.collateralChange(app, { book, unit: treasury, inst: app.instruments.get(pos.instrument_id), pos, change: 'pledge', qty: 1 }), /two outright trades in one security/);
  // 15 May: the issuer pays the coupon (21,250) and it is passed to the buyer at once: cash unchanged, 968,750 owed from then on.
  await goTo(app, clock, '2026-05-15T14:00:00.000Z');
  assert.equal(app.positions.get(pos.id).qty, -968_750);
  near(app.ledger.cash(treasury.id, 'USD').settled, cash0 + 990_000);
  // 20 May: the forward amount is paid, 977,318.19, and the bonds are released.
  await goTo(app, clock, '2026-05-20T14:00:00.000Z');
  near(app.ledger.cash(treasury.id, 'USD').settled, cash0 + 990_000 - 977_318.19);
  assert.equal(app.positions.get(pos.id).qty, 0);
  assert.equal(app.positions.get(gov).pledged_qty, 0);
  assert.deepEqual(ledgerImbalance(app), []);
});

test('a bond lent takes cash collateral on its dirty value; the fee accrues on its clean value', async () => {
  const { app, clock, inst } = makeApp();
  const { book, treasury } = makeBook(app, { cash: 2_000_000, account: 0 });
  pin(app, inst.SIMGOV31.id, 100);
  const hold = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.SIMGOV31.id, qty: 1_000_000 }] });
  await goTo(app, clock, '2026-03-03T15:00:00.000Z');
  // Dirty value on 3 March: 1,000,000 + 12,679.56 (108 of 181 days of 21,250); 102%: 1,012,679.56 + 20,253.59 = 1,032,933.15.
  const s = await trade(app, { bookId: book.id, unitId: treasury.id, template: 'custom', legs: [{ kind: 'lend_sec', action: 'lend_sec', qty: 1_000_000, sourcePositionId: hold.positions[0].positionId, contract: { productId: 'bond_loan', name: 'Lend SIMGOV31', marketView: 'US_CASH', venueType: 'otc', underlyingId: inst.SIMGOV31.id, tradingCcy: 'USD', terms: { feeRate: 0.0036, collateralPct: 1.02 } } }] });
  const pos = s.positions[0].positionId;
  near(-app.ledger.positionBalance(pos, 'coll.received', 'USD'), 1_032_933.15);
  near(app.ledger.balance(treasury.id, 'cash.restricted', 'USD'), 1_032_933.15);
  // The 4 March run: one day's fee (3 to 4 March) on 1,000,000 clean at 0.36% / 360: 10.00. The collateral is marked to 4 March's
  // dirty value: 109 of 181 days, 12,796.96; 1,012,796.96 x 1.02 = 1,033,052.90 (119.75 more received, restricted).
  await goTo(app, clock, '2026-03-04T22:30:00.000Z');
  near(app.ledger.positionBalance(pos, 'accrued.asset', 'USD'), 10);
  near(-app.ledger.positionBalance(pos, 'coll.received', 'USD'), 1_033_052.90);
  near(app.ledger.balance(treasury.id, 'cash.restricted', 'USD'), 1_033_052.90);
  assert.deepEqual(ledgerImbalance(app), []);
});
