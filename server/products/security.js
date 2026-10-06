// Security-like families: equity, fund, spot asset, digital asset and manually valued holdings.
// Average-cost positions, cash settles on the settlement date, income arrives through recorded
// corporate actions or manual cash-flow entries.

import { addBusinessDays } from '../quant/calendar.js';
import { num } from '../core/util.js';
import { bookSecurityFill, valueSecurity } from './common.js';

export function calendarFor(inst) {
  if (inst.family === 'crypto') return 'ALLDAYS';
  if (inst.terms?.calendar) return inst.terms.calendar;
  if (inst.market_view === 'US_CASH' || inst.market_view === 'US_DERIV') return inst.family === 'bond' ? 'USBOND' : 'US';
  return 'WEEKEND';
}

function makeSecurityPlugin(family, { label, qtyLabel, priceUnits, shortable = true }) {
  return {
    family,
    kind: 'security',
    shortRule: shortable ? 'borrow' : 'none',
    label,
    qtyLabel,
    actions: () => (shortable ? ['buy', 'sell', 'sell_short', 'buy_to_cover'] : ['buy', 'sell']),
    priceUnits: (inst) => inst.terms?.priceUnits || priceUnits,
    calendar: calendarFor,
    normalize(app, draft) {
      const errors = [];
      const terms = { ...(draft.terms || {}) };
      const lot = num(terms.lotSize);
      if (terms.lotSize !== undefined && terms.lotSize !== null && terms.lotSize !== '' && !(lot > 0)) errors.push('Lot size must be a positive number.');
      if (lot > 0) terms.lotSize = lot;
      const tick = num(terms.tickSize);
      if (tick > 0) terms.tickSize = tick; else delete terms.tickSize;
      const mult = num(draft.multiplier) ?? 1;
      if (!(mult > 0)) errors.push('Multiplier must be positive.');
      return { terms, multiplier: mult > 0 ? mult : 1, errors };
    },
    describe(inst) {
      const rows = [];
      if (inst.terms.lotSize) rows.push(['Lot size', inst.terms.lotSize]);
      if (inst.multiplier !== 1) rows.push(['Multiplier', inst.multiplier]);
      if (inst.terms.valuationBasis) rows.push(['Valuation basis', inst.terms.valuationBasis]);
      return rows;
    },
    qtyStep: (inst) => inst.terms?.lotStep || (family === 'crypto' || family === 'spot' || family === 'manual' ? 1e-8 : inst.terms?.fractional ? 1e-6 : 1),
    settleDate(app, inst, tradeDate, book) {
      const s = book.settings.settlement;
      const days = inst.terms?.settleDays ?? (family !== 'crypto' && inst.market_view === 'FOREIGN_CASH' ? s.foreignCash : s[family] ?? 1);
      return addBusinessDays(tradeDate, days, calendarFor(inst));
    },
    economics(app, { inst, action, qty, price }) {
      const gross = qty * price * inst.multiplier;
      const buy = action === 'buy' || action === 'buy_to_cover';
      return { ccy: inst.trading_ccy, principal: gross, cash: buy ? -gross : gross, accrued: 0, notional: gross, exposure: buy ? gross : -gross, initialMargin: 0, notes: [] };
    },
    fill(app, c) {
      const short = c.action === 'sell_short';
      const cover = c.action === 'buy_to_cover';
      return bookSecurityFill(app, c, {
        unitCost: c.price * c.inst.multiplier,
        // Short-sale proceeds are collateral for the securities borrow, not buying power.
        receiveAccounts: short ? ['cash.restricted'] : ['cash'],
        payAccounts: cover ? ['cash.restricted', 'cash'] : ['cash'],
      });
    },
    value(app, inst, pos, obs, mark) {
      return valueSecurity(inst, pos, obs, mark);
    },
  };
}

export const equity = makeSecurityPlugin('equity', { label: 'Equity-like security', qtyLabel: 'Shares', priceUnits: 'per share' });
export const fund = makeSecurityPlugin('fund', { label: 'Fund (NAV-priced)', qtyLabel: 'Shares', priceUnits: 'NAV per share', shortable: false });
export const spot = makeSecurityPlugin('spot', { label: 'Spot asset', qtyLabel: 'Units', priceUnits: 'per unit', shortable: false });
export const crypto = makeSecurityPlugin('crypto', { label: 'Digital asset', qtyLabel: 'Units', priceUnits: 'per unit', shortable: false });
export const manual = makeSecurityPlugin('manual', { label: 'Manually valued holding', qtyLabel: 'Units', priceUnits: 'per unit', shortable: false });
