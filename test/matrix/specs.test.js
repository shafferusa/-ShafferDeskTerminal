// Spec audit: the literals in every spec, checked a second way from the spec's own inputs.
//
// The expected values in a spec are worked out by hand. This audit recomputes the ones that follow
// directly from stated inputs, with the independent calculators in lib/calc.mjs (which import
// nothing from server/), and fails if a literal disagrees with its own arithmetic:
//   - a trade leg's cash is quantity x estimated fill, negative for a purchase;
//   - its fee is the Book's stated fee schedule applied to that fill;
//   - its settlement date is the stated lag after the trade date, on weekdays, skipping the holidays
//     the spec lists by hand (`settlementCheck`).
// It never starts the Terminal.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getProduct } from '../../server/core/catalog.js';
import { addBusinessDays, commission, money, newYorkDate } from './lib/calc.mjs';
import { loadSpecs } from './lib/specs.mjs';

const specs = await loadSpecs();
const BUYS = new Set(['buy', 'buy_to_cover']);

test('matrix specs: every spec loads and names a catalog product once', () => {
  assert.ok(specs.length > 0);
  const ids = specs.map((s) => s.productId || `T:${s.template}${s.path ? `/${s.path}` : ''}`);
  assert.equal(new Set(ids).size, ids.length);
});

for (const spec of specs) {
  test(`matrix spec audit: ${spec.productId || spec.template} trade legs agree with their own inputs`, () => {
    let now = spec.start;
    let checked = 0;
    const lotInstrument = new Map();
    const registered = new Map();
    for (const step of spec.steps) {
      if (step.action === 'clock') now = step.to;
      if (step.as) lotInstrument.set(step.as, step.instrument);
      // An instrument registered by a step (`register_instrument` with `as`), or by a contract leg (`contractAs`), is audited like one of the spec's own.
      if (step.action === 'register_instrument' && step.as && step.draft) registered.set(step.as, step.draft);
      [].concat(step.contractAs || []).forEach((key, i) => { const c = (step.input?.legs || []).filter((l) => l.contract)[i]?.contract; if (key && c) registered.set(key, c); });
      const legs = step.expect?.preview?.legs;
      if (!legs || step.status) continue;
      for (const leg of legs) {
        // A cash loan or deposit leg moves its principal: received by the borrower, paid out by the lender. A
        // repayment or withdrawal moves the principal stated plus the interest settled with it, the other way.
        if (leg.kind === 'loan' && typeof leg.qty === 'number' && typeof leg.cash === 'number') {
          assert.ok(['borrow_cash', 'lend_cash'].includes(leg.action), `${spec.productId}:${step.id}: a loan leg states its action (borrow_cash or lend_cash)`);
          assert.equal(leg.cash, leg.action === 'borrow_cash' ? leg.qty : -leg.qty, `${spec.productId}:${step.id}: the cash of a loan leg is its principal (${leg.qty}), received when borrowing and paid when lending`);
          checked++;
          continue;
        }
        // r1: a repo leg moves its cash principal (received on a repo, paid on a reverse repo); its reconciliation is the
        // collateral's value (clean plus accrued) less the contract's haircut and buffer, each to the cent.
        if (leg.kind === 'repo_open' && typeof leg.qty === 'number' && typeof leg.cash === 'number') {
          assert.ok(['repo', 'reverse_repo'].includes(leg.action), `${spec.productId}:${step.id}: a repo leg states its action (repo or reverse_repo)`);
          assert.equal(leg.cash, leg.action === 'repo' ? leg.qty : -leg.qty, `${spec.productId}:${step.id}: the cash of a repo leg is its principal`);
          const c = leg.financing?.collateral;
          if (c) {
            const terms = (step.input?.legs || []).find((l) => l.kind === 'repo_open')?.contract?.terms || {};
            const ccy = leg.ccy || 'USD';
            assert.equal(c.worth, money(c.clean + c.accrued, ccy), `${spec.productId}:${step.id}: the collateral is worth its clean value plus its accrued interest`);
            const after = money(c.worth * (1 - (terms.haircut || 0)), ccy);
            assert.equal(c.haircutAmount, money(c.worth - after, ccy), `${spec.productId}:${step.id}: the haircut is ${terms.haircut} of the collateral's value`);
            assert.equal(c.supports, money(after - (terms.buffer || 0), ccy), `${spec.productId}:${step.id}: the cash supported is the value less the haircut less the buffer`);
            assert.ok(leg.qty <= c.supports + 0.004, `${spec.productId}:${step.id}: the cash principal is within what the collateral supports`);
          }
          checked++;
          continue;
        }
        if ((leg.kind === 'repay' || leg.kind === 'repo_close') && typeof leg.cash === 'number' && typeof leg.financing?.principal === 'number') {
          assert.equal(Math.abs(leg.cash), money(leg.financing.principal + (leg.financing.interest || 0), leg.ccy || 'USD'), `${spec.productId}:${step.id}: the cash of a repayment is its principal plus the interest settled with it`);
          checked++;
          continue;
        }
        // A fund leg (model 'next-nav') has no fill price before its NAV is struck: its amounts are estimated on the last
        // published NAV, which the leg states as its `reference`.
        const px = typeof leg.estimate === 'number' ? leg.estimate : leg.model === 'next-nav' && typeof leg.reference === 'number' ? leg.reference : null;
        if ((leg.kind || 'trade') !== 'trade' || px === null || typeof leg.qty !== 'number') continue;
        const key = leg.instrument || step.instrument || lotInstrument.get(step.lot || step.from) || 'main';
        const inst = spec.instruments[key] || registered.get(key);
        assert.ok(inst, `${step.id}: instrument "${key}" is not in the spec`);
        const ccy = inst.tradingCcy;
        // A debt security with a pool factor or an index ratio settles on its principal outstanding (current face, or face x
        // index ratio): the leg states it as `notional`, and the spec works it out by hand from the factor or ratio it states.
        // s3: so does a credit default swap on an index (or tranche, or ABS reference) whose factor is below 1: its upfront is on
        // the notional outstanding, notional x factor, which the leg states as `notional`.
        const units = ['bond', 'cds'].includes(getProduct(inst.productId)?.family) && typeof leg.notional === 'number' ? leg.notional : leg.qty;
        const principal = units * px * (inst.multiplier ?? 1);
        const where = `${spec.productId}:${step.id}`;
        if (typeof leg.cash === 'number') {
          const action = leg.action || step.side;
          assert.ok(action, `${where}: the leg needs its action to check the sign of its cash`);
          // A debt security settles its principal plus the accrued interest the leg states (`accrued`), each to the cent.
          const accrued = typeof leg.accrued === 'number' ? leg.accrued : 0;
          const settles = money(principal, ccy) + accrued;
          assert.equal(leg.cash, money(BUYS.has(action) ? -settles : settles, ccy), `${where}: cash is not quantity x estimated fill (${leg.qty} x ${px})${accrued ? ` plus the stated accrued interest ${accrued}` : ''}`);
          checked++;
        }
        if (typeof leg.fees === 'number') {
          const schedule = spec.book.settings.fees[getProduct(inst.productId).family];
          assert.equal(leg.fees, commission(schedule, leg.qty, principal, ccy), `${where}: fee does not follow from the Book's fee schedule ${JSON.stringify(schedule)}`);
          checked++;
        }
        // A step that states its own settlement on the ticket (`order.settle`) or audits a different trade date (an
        // order placed while the market is closed) is not on the scenario's standing lag: it sets `settlementCheck: false`.
        if (leg.settleDate && spec.settlementCheck && step.settlementCheck !== false) {
          const { lag, holidays } = spec.settlementCheck;
          assert.equal(leg.settleDate, addBusinessDays(newYorkDate(now), lag, holidays), `${where}: settlement date is not T+${lag} from ${newYorkDate(now)} skipping ${holidays.join(', ') || 'no holidays'}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 0 || !spec.steps.some((s) => s.expect?.preview?.legs), 'the spec has preview legs to audit');
  });
}
