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
  const ids = specs.map((s) => s.productId || `T:${s.template}`);
  assert.equal(new Set(ids).size, ids.length);
});

for (const spec of specs) {
  test(`matrix spec audit: ${spec.productId || spec.template} trade legs agree with their own inputs`, () => {
    let now = spec.start;
    let checked = 0;
    const lotInstrument = new Map();
    for (const step of spec.steps) {
      if (step.action === 'clock') now = step.to;
      if (step.as) lotInstrument.set(step.as, step.instrument);
      const legs = step.expect?.preview?.legs;
      if (!legs || step.status) continue;
      for (const leg of legs) {
        if ((leg.kind || 'trade') !== 'trade' || typeof leg.estimate !== 'number' || typeof leg.qty !== 'number') continue;
        const key = leg.instrument || step.instrument || lotInstrument.get(step.lot || step.from) || 'main';
        const inst = spec.instruments[key];
        assert.ok(inst, `${step.id}: instrument "${key}" is not in the spec`);
        const ccy = inst.tradingCcy;
        const principal = leg.qty * leg.estimate * (inst.multiplier ?? 1);
        const where = `${spec.productId}:${step.id}`;
        if (typeof leg.cash === 'number') {
          const action = leg.action || step.side;
          assert.ok(action, `${where}: the leg needs its action to check the sign of its cash`);
          assert.equal(leg.cash, money(BUYS.has(action) ? -principal : principal, ccy), `${where}: cash is not quantity x estimated fill (${leg.qty} x ${leg.estimate})`);
          checked++;
        }
        if (typeof leg.fees === 'number') {
          const schedule = spec.book.settings.fees[getProduct(inst.productId).family];
          assert.equal(leg.fees, commission(schedule, leg.qty, principal, ccy), `${where}: fee does not follow from the Book's fee schedule ${JSON.stringify(schedule)}`);
          checked++;
        }
        if (leg.settleDate && spec.settlementCheck) {
          const { lag, holidays } = spec.settlementCheck;
          assert.equal(leg.settleDate, addBusinessDays(newYorkDate(now), lag, holidays), `${where}: settlement date is not T+${lag} from ${newYorkDate(now)} skipping ${holidays.join(', ') || 'no holidays'}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 0 || !spec.steps.some((s) => s.expect?.preview?.legs), 'the spec has preview legs to audit');
  });
}
