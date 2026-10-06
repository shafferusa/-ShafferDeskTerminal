// Security-like families: equity, fund, spot asset, digital asset and manually valued holdings.
// Average-cost positions, cash settles on the settlement date, income arrives through recorded
// corporate actions or manual cash-flow entries.

import { addBusinessDays, CALENDARS, COUNTRY_CALENDAR, CURRENCY_CALENDAR, isEuroAreaVenue } from '../quant/calendar.js';
import { num } from '../core/util.js';
import { bookSecurityFill, valueSecurity } from './common.js';

/**
 * The business-day calendar an instrument settles on, and how it was chosen. Nothing falls back to
 * weekends silently: when no holiday calendar exists for the market, `fallback` is true and `note`
 * says so, and the preview and the instrument page repeat it.
 *   basis: explicit (set on the instrument) | venue (listing-venue country) | currency (inferred
 *          from the trading currency because no venue country is recorded) | fallback
 */
export function calendarInfo(inst) {
  const done = (id, basis, note = null) => ({ id, label: CALENDARS[id]?.label || id, basis, fallback: id === 'WEEKEND', approximate: Boolean(note) || id === 'WEEKEND', note });
  if (inst.family === 'crypto') return done('ALLDAYS', 'explicit');
  if (inst.terms?.calendar && (CALENDARS[inst.terms.calendar] || String(inst.terms.calendar).includes('+'))) return done(inst.terms.calendar, 'explicit');
  const us = inst.market_view === 'US_CASH' || inst.market_view === 'US_DERIV';
  const country = String(inst.venue_country || '').toUpperCase() || (us && inst.venue_type !== 'otc' ? 'US' : '');
  if (country) {
    const cal = COUNTRY_CALENDAR[country];
    if (cal === 'US') return done(inst.family === 'bond' ? 'USBOND' : 'US', 'venue');
    if (cal) return done(cal, 'venue', isEuroAreaVenue(country) ? 'TARGET closing days are used for this euro-area venue. Any further closing days of its exchange are not included; add them as extra holidays.' : null);
    return done('WEEKEND', 'fallback', `No holiday calendar is built in for venues in ${country}. Dates use weekends only until Shaffer MarketData supplies the calendar; local holidays can be added by hand in Settings.`);
  }
  // No venue country: US market views use US calendars; otherwise the trading currency's payment calendar.
  if (us) return done(inst.family === 'bond' ? 'USBOND' : 'US', 'venue');
  const byCcy = CURRENCY_CALENDAR[inst.settle_ccy] || CURRENCY_CALENDAR[inst.trading_ccy];
  if (byCcy) return done(byCcy, 'currency', `No listing-venue country is recorded, so the ${inst.settle_ccy || inst.trading_ccy} payment calendar is used. Set the venue country on the instrument to use its market calendar.`);
  return done('WEEKEND', 'fallback', `No venue country is recorded and no payment calendar is built in for ${inst.trading_ccy}. Dates use weekends only; local holidays are not recognised.`);
}
export const calendarFor = (inst) => calendarInfo(inst).id;

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
