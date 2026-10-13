// Security-like families: equity, fund, spot asset, digital asset and manually valued holdings.
// Average-cost positions, cash settles on the settlement date, income arrives through recorded
// corporate actions or manual cash-flow entries.

import { addBusinessDays, COUNTRY_CALENDAR, CURRENCY_CALENDAR, describeCalendar, fxValueDate, isBusinessDay, isEuroAreaVenue, isKnownCalendar, joinCalendars } from '../quant/calendar.js';
import { addDays } from '../quant/dates.js';
import { partsInTz } from '../core/clock.js';
import { num } from '../core/util.js';
import { bookSecurityFill, valueSecurity } from './common.js';

// ---- calendars -----------------------------------------------------------------------------------------
//
// An instrument has three calendars:
//   trading      the days its market is open (a trade date is one of these)
//   settlement   the days a trade can settle on (settlement lags count these)
//   payment      the days its cash flows can be paid on (coupons, interest, maturity, resets)
// Each can be set on the instrument (`conventions.tradingCalendar`, `settlementCalendar`,
// `paymentCalendar`; a joint calendar is written 'A+B'). What is not set comes from the listing
// venue's country, then the currency, exactly as before. The payment calendar always also includes
// the payment calendar of every currency the instrument pays in.
// Nothing falls back to weekends silently: a role worked out on weekends only says so (`fallback`),
// and `flag` / `flagText` summarise the worst case across the three for the screens.

const one = (id, basis, note = null) => {
  const d = describeCalendar(id);
  return { id: d.id, label: d.label, basis, fallback: d.weekendsOnly, approximate: Boolean(note) || d.weekendsOnly || d.partlyWeekends, joint: d.joint, note: note || (d.partlyWeekends ? 'Part of this joint calendar is weekends only, so local holidays of that market are not recognised.' : null) };
};

/** The calendar of the instrument's market when nothing is set on the instrument: venue country, then currency. */
function marketCalendar(inst) {
  if (inst.family === 'crypto') return one('ALLDAYS', 'explicit');
  if (inst.family === 'fx' && inst.terms?.base && inst.terms?.quote) {
    const v = fxValueDate('2000-01-03', inst.terms.base, inst.terms.quote, 0);
    return { id: v.calendar, label: `Payment calendars of ${inst.terms.base} and ${inst.terms.quote}`, basis: 'currency', fallback: v.missing.length > 0, approximate: v.missing.length > 0, joint: true,
      note: v.missing.length ? `No payment calendar is built in for ${v.missing.join(' and ')}: weekends only are used for ${v.missing.length > 1 ? 'them' : 'it'}, so local holidays are not recognised.` : null };
  }
  if (inst.terms?.calendar && isKnownCalendar(inst.terms.calendar)) return one(inst.terms.calendar, 'explicit');
  const us = inst.market_view === 'US_CASH' || inst.market_view === 'US_DERIV';
  const country = String(inst.venue_country || '').toUpperCase() || (us && inst.venue_type !== 'otc' ? 'US' : '');
  if (country) {
    const cal = COUNTRY_CALENDAR[country];
    if (cal === 'US') return one(inst.family === 'bond' ? 'USBOND' : 'US', 'venue');
    if (cal) return one(cal, 'venue', isEuroAreaVenue(country) ? 'TARGET closing days are used for this euro-area venue. Any further closing days of its exchange are not included; add them as extra holidays.' : null);
    return one('WEEKEND', 'fallback', `No holiday calendar is built in for venues in ${country}. Dates use weekends only until Shaffer MarketData supplies the calendar; local holidays can be added by hand in Settings.`);
  }
  // No venue country: US market views use US calendars; otherwise the trading currency's payment calendar.
  if (us) return one(inst.family === 'bond' ? 'USBOND' : 'US', 'venue');
  const byCcy = CURRENCY_CALENDAR[inst.settle_ccy] || CURRENCY_CALENDAR[inst.trading_ccy];
  // An OTC contract has no listing venue: the payment calendar of its currency is its calendar, not a stand-in.
  if (byCcy) return one(byCcy, 'currency', inst.venue_type === 'otc' ? null : `No listing-venue country is recorded, so the ${inst.settle_ccy || inst.trading_ccy} payment calendar is used. Set the venue country on the instrument to use its market calendar.`);
  return one('WEEKEND', 'fallback', `No venue country is recorded and no payment calendar is built in for ${inst.trading_ccy}. Dates use weekends only; local holidays are not recognised.`);
}

/** Every currency an instrument pays or receives cash in. */
export function paymentCurrencies(inst) {
  const t = inst.terms || {};
  const out = [];
  const add = (c) => { const x = String(c || '').toUpperCase(); if (/^[A-Z]{3}$/.test(x) && !out.includes(x)) out.push(x); };
  add(inst.settle_ccy); add(inst.trading_ccy);
  if (inst.family === 'fx' || inst.family === 'forward') { add(t.base); add(t.quote); }
  for (const l of Array.isArray(t.legs) ? t.legs : []) add(l?.ccy);
  return out;
}

/**
 * The three calendars of an instrument and how each was chosen.
 * Top-level id / label / basis / fallback / approximate / note describe the SETTLEMENT calendar
 * (the shape this function has always returned); `trading`, `settlement` and `payment` carry all three.
 *   basis: explicit (set on the instrument) | venue (listing-venue country) | currency | fallback
 */
export function calendarInfo(inst) {
  const c = inst.conventions || {};
  const market = marketCalendar(inst);
  const set = (id) => (id && isKnownCalendar(id) ? one(id, 'explicit') : null);
  // A currency pair trades on the global FX market (Monday to Friday); its two payment calendars decide value dates.
  const trading = set(c.tradingCalendar) || (inst.family === 'fx' ? one('FX', 'product') : { ...market });
  let settlement = set(c.settlementCalendar) || { ...market };
  if (inst.family === 'fx' && c.settlementCalendar && isKnownCalendar(c.settlementCalendar)) {
    // A currency pair always keeps its two payment calendars; a calendar set on it is added to them.
    const j = one(joinCalendars(c.settlementCalendar, market.id), 'explicit');
    settlement = { ...j, fallback: j.fallback || market.fallback, approximate: j.approximate || market.approximate, note: market.note };
  }
  // Payments: the calendar set for them (or the settlement calendar), joined with each currency's payment calendar.
  const ccys = inst.family === 'crypto' ? [] : paymentCurrencies(inst);
  const ccyCals = ccys.map((x) => CURRENCY_CALENDAR[x]).filter(Boolean);
  const missing = ccys.filter((x) => !CURRENCY_CALENDAR[x]);
  const base = set(c.paymentCalendar) || settlement;
  const pay = one(joinCalendars(base.id, ...ccyCals), c.paymentCalendar && isKnownCalendar(c.paymentCalendar) ? 'explicit' : base.basis);
  const payment = {
    ...pay, currencies: ccys, currencyCalendars: Object.fromEntries(ccys.map((x) => [x, CURRENCY_CALENDAR[x] || null])), missingCurrencies: missing,
    // Weekends only when no member of the joint calendar is a real one; a real currency calendar joined to a
    // weekends-only market calendar makes it approximate instead.
    fallback: pay.fallback, approximate: pay.approximate || base.approximate || missing.length > 0,
    note: [base.note && !c.paymentCalendar ? base.note : null, missing.length ? `No payment calendar is built in for ${missing.join(' and ')}, so ${missing.length > 1 ? 'their' : 'its'} bank holidays are not recognised on payment dates.` : null].filter(Boolean).join(' ') || pay.note || null,
  };
  const roles = [['Trading', trading], ['Settlement', settlement], ['Payment', payment]];
  const weekends = roles.filter(([, r]) => r.fallback), approx = roles.filter(([, r]) => r.approximate && !r.fallback);
  const flag = weekends.length ? 'weekends-only' : approx.length ? 'approximate' : null;
  const which = (list) => { const t = list.length === 3 ? 'trading, settlement and payment dates' : `${list.map(([n]) => n.toLowerCase()).join(' and ')} dates`; return t[0].toUpperCase() + t.slice(1); };
  const flagText = weekends.length
    ? `${which(weekends)} for this instrument are worked out on weekends only: no holiday calendar exists for its market, so local holidays are not recognised.`
    : approx.length ? `${which(approx)} for this instrument use an approximate calendar. ${[...new Set(approx.map(([, r]) => r.note).filter(Boolean))].join(' ')}`.trim() : null;
  return { ...settlement, trading, settlement: { ...settlement }, payment, flag, flagLabel: flag === 'weekends-only' ? 'Weekends-only calendar' : flag === 'approximate' ? 'Approximate calendar' : null, flagText };
}
/** Settlement calendar id (settlement lags count its business days). */
export const calendarFor = (inst) => calendarInfo(inst).id;
/** Payment calendar id (coupon, interest, maturity and reset payment dates are adjusted on it). */
export const paymentCalendarFor = (inst) => calendarInfo(inst).payment.id;
export const tradingCalendarFor = (inst) => calendarInfo(inst).trading.id;

// ---- settlement convention -------------------------------------------------------------------------------

/** Longest settlement lag, in business days, that an instrument or a trade may state. Beyond it the trade is a forward. */
export const MAX_SETTLE_LAG = 30;
/** Families whose settlement is fixed by the product, and why. Everything else takes a lag (0 is same-day). */
export const FIXED_SETTLEMENT = {
  future: 'A future settles through daily variation margin from the trade date, so no settlement date or lag can be set.',
  forward: 'A forward settles on its value date, which is a term of the contract.',
  loan: 'A loan or deposit takes effect when it is executed.',
  repo: 'A repo takes effect when it is executed and ends on its own end date.',
  secloan: 'A securities loan takes effect when it is executed.',
};

/** The Book's default lag for an instrument's family (business days). */
function bookLag(inst, book) {
  const s = book?.settings?.settlement || {};
  const f = inst.family;
  if (['equity', 'fund', 'spot', 'manual'].includes(f) && inst.market_view === 'FOREIGN_CASH') return s.foreignCash ?? 2;
  if (f === 'fx') return 2;
  return s[f] ?? ({ swap: 2, otcoption: 2, spot: 2, manual: 2, crypto: 0 }[f] ?? 1);
}

/**
 * How an instrument settles when the trade states nothing: { configurable, lag, basis, label, reason }.
 *   basis: instrument (its own convention or contract term) | book (the Book's paper-desk assumption) | product (fixed by the product)
 * `book` may be omitted; the lag is then null when it would come from the Book.
 */
export function settlementConvention(inst, book = null) {
  if (FIXED_SETTLEMENT[inst.family]) return { configurable: false, lag: inst.family === 'future' ? 0 : null, basis: 'product', label: inst.family === 'future' ? 'Same day (variation margin)' : inst.family === 'forward' ? 'On the value date' : 'On execution', reason: FIXED_SETTLEMENT[inst.family], maxLag: MAX_SETTLE_LAG };
  const own = num(inst.conventions?.settleLag) ?? num(inst.terms?.settleDays);
  const lag = own ?? (book ? bookLag(inst, book) : null);
  const label = lag === null ? 'Book default' : lag === 0 ? 'Same day' : `T+${lag}`;
  return { configurable: true, lag, basis: own !== null ? 'instrument' : 'book', label, reason: null, maxLag: MAX_SETTLE_LAG };
}

/** Settlement date `lag` business days after `tradeDate` on the instrument's settlement calendar. */
export function settleDateFor(inst, tradeDate, lag) {
  if (inst.family === 'fx') {
    let d = fxValueDate(tradeDate, inst.terms.base, inst.terms.quote, lag).date;
    const cal = calendarFor(inst);
    while (!isBusinessDay(d, cal)) d = addDays(d, 1);
    return d;
  }
  return addBusinessDays(tradeDate, lag, calendarFor(inst));
}
/** The settlement date of a trade done on `tradeDate` under the instrument's convention (no stated date or lag). */
export function standardSettleDate(inst, tradeDate, book) {
  return settleDateFor(inst, tradeDate, settlementConvention(inst, book).lag ?? 0);
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
    settleDate: (app, inst, tradeDate, book) => standardSettleDate(inst, tradeDate, book),
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

// ---- funds: forward pricing ------------------------------------------------------------------------------
//
// An open-ended fund (mutual fund, money-market fund) is not traded against a live quote. A subscription or a
// redemption is dealt at the next NAV struck after the order is placed ("forward pricing"): an order placed on a
// dealing day before the fund's cut-off gets that day's NAV; one placed after the cut-off, or on a day the fund
// does not deal, gets the next dealing day's NAV. Until that NAV is supplied (an official close of the dealing
// date from Shaffer MarketData, or a NAV entered by hand for that date) the order waits, visibly, and is not
// expired at the end of the day. The trade date is the dealing date; settlement is counted from it.
// The cut-off is the instrument's `terms.dealingCutoff` ('HH:MM', New York time), 16:00 when not set.

export const FUND_DEFAULT_CUTOFF = '16:00';
const cutoffOf = (inst) => (/^\d{2}:\d{2}$/.test(String(inst.terms?.dealingCutoff || '')) ? inst.terms.dealingCutoff : FUND_DEFAULT_CUTOFF);

/** The dealing date of a fund order placed at `placedAt` (ISO instant): that day before the cut-off on a dealing day, else the next dealing day. */
export function fundDealingDate(inst, placedAt) {
  const p = partsInTz(new Date(placedAt));
  const cal = tradingCalendarFor(inst);
  const [h, m] = cutoffOf(inst).split(':').map(Number);
  if (isBusinessDay(p.date, cal) && p.minutes < h * 60 + m) return p.date;
  return addBusinessDays(p.date, 1, cal);
}

/** The official NAV of a dealing date: a supplied close of that date, or a NAV entered by hand for it. Never a live quote. */
export function fundNavFor(app, inst, date) {
  const supplied = app.data._cache?.get(`close|${inst.id}@${date}`);
  if (supplied && supplied.value !== null && supplied.value !== undefined) return supplied;
  const manual = app.data.latestManual('price', inst.id, { forDate: date });
  return manual && manual.value !== null && manual.value !== undefined ? manual : null;
}

/**
 * Fill estimate of a fund order (the forward-pricing counterpart of fillmodel.estimateFill):
 * { executable, price, model: 'next-nav', label, note, reason, maxQty: null, reference, dealingDate, navObs, refusal }.
 * `refusal` is set for what a fund order cannot be (a limit or stop order).
 */
function fundEstimate(app, { inst, placedAt, orderType = 'market' }) {
  const dealingDate = fundDealingDate(inst, placedAt);
  const label = 'Next NAV (forward pricing)';
  const last = app.data.price(inst.id);
  const out = { executable: false, price: null, model: 'next-nav', label, note: '', reason: null, maxQty: null, reference: last?.value ?? null, obsStatus: last?.status ?? null, dealingDate, navObs: null, refusal: null };
  if (orderType && orderType !== 'market') {
    out.refusal = `A fund order is dealt at the next NAV struck after it is placed; a ${String(orderType).replace(/_/g, ' ')} order does not apply. Place it as a market order.`;
    out.reason = out.refusal;
    return out;
  }
  const nav = fundNavFor(app, inst, dealingDate);
  if (!nav) {
    out.note = `Dealt at the NAV of ${dealingDate} (cut-off ${cutoffOf(inst)} New York), not at a live quote.`;
    out.reason = `Waiting for the NAV of ${dealingDate}: a fund order is dealt at the next NAV struck after it is placed (cut-off ${cutoffOf(inst)} New York), never at a live quote.${out.reference !== null ? ` The amounts shown use the last published NAV, ${fmtPrice(out.reference)}, as an estimate.` : ''}`;
    return out;
  }
  return { ...out, executable: true, price: nav.value, reference: nav.value, navObs: nav, obsStatus: nav.status, note: `Dealt at the NAV of ${dealingDate} (${nav.source}), the next NAV struck after the order was placed.` };
}
const fmtPrice = (x) => Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export const equity = makeSecurityPlugin('equity', { label: 'Equity-like security', qtyLabel: 'Shares', priceUnits: 'per share' });
export const fund = {
  ...makeSecurityPlugin('fund', { label: 'Fund (NAV-priced)', qtyLabel: 'Shares', priceUnits: 'NAV per share', shortable: false }),
  /** Forward pricing: orders deal at the next NAV (see above). orders.js and packages.js use this instead of estimateFill. */
  forwardEstimate: fundEstimate,
  /** The close a working fund order needs from the data service: the NAV of its dealing date. */
  navNeeds: (inst, placedAt) => [{ instrument: inst, date: fundDealingDate(inst, placedAt) }],
};
// ---- spot assets: their own units --------------------------------------------------------------------------
//
// A spot asset is held and quoted in the units of its market: troy ounces, tonnes, barrels, MMBtu, MWh, bushels,
// pounds, allowances or certificates. `terms.quantityUnit` names the unit of quantity (the ticket's quantity field
// is labelled with it) and `terms.priceUnits` the unit of the price ("USD per troy ounce"). When the two differ (a
// kilobar quoted per troy ounce, live cattle held in pounds and quoted per hundredweight) the multiplier converts:
// value = quantity x price x multiplier, where the multiplier is price units per quantity unit (32.1507466 troy
// ounces in a kilogram; 0.01 hundredweight in a pound). `terms.lotSize`, when set, is the smallest tradable
// quantity: an allowance or a certificate is indivisible, so whole lots only.
const spotBase = makeSecurityPlugin('spot', { label: 'Spot asset', qtyLabel: 'Units', priceUnits: 'per unit', shortable: false });
const unitText = (x) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 60) : null);
export const spot = {
  ...spotBase,
  normalize(app, draft) {
    const out = spotBase.normalize(app, draft);
    for (const k of ['quantityUnit', 'priceUnits']) {
      const v = unitText(out.terms[k]);
      if (v) out.terms[k] = v; else delete out.terms[k];
    }
    return out;
  },
  describe(inst) {
    const rows = spotBase.describe(inst);
    if (inst.terms.quantityUnit) rows.unshift(['Quantity unit', inst.terms.quantityUnit]);
    if (inst.terms.priceUnits) rows.splice(inst.terms.quantityUnit ? 1 : 0, 0, ['Quoted in', inst.terms.priceUnits]);
    return rows;
  },
  /** The quantity field's label: the asset's own unit ("Troy ounces"), else "Units". */
  qtyLabelFor: (inst) => (inst.terms?.quantityUnit ? inst.terms.quantityUnit[0].toUpperCase() + inst.terms.quantityUnit.slice(1) : 'Units'),
  qtyStep: (inst) => (num(inst.terms?.lotSize) > 0 ? num(inst.terms.lotSize) : spotBase.qtyStep(inst)),
};
export const crypto = makeSecurityPlugin('crypto', { label: 'Digital asset', qtyLabel: 'Units', priceUnits: 'per unit', shortable: false });
export const manual = makeSecurityPlugin('manual', { label: 'Manually valued holding', qtyLabel: 'Units', priceUnits: 'per unit', shortable: false });
