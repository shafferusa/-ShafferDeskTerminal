// Simulated demo feed.
//
// Used ONLY when the Terminal is started in demo mode (`npm run demo`) and by the automated
// tests. It prices a small set of FICTIONAL instruments with a deterministic formula so the
// paper-trading workflows can be exercised before the Shaffer services exist. Every observation
// it produces carries status 'simulated' and source 'Simulated demo feed'; it is never a market
// quote, and demo mode keeps its own database.
//
// Analytics are deliberately not simulated: the Analytics Lab port stays "awaiting" in demo mode.

import { blackScholes } from '../quant/options.js';
import { addDays, diffDays, makeDate, weekday, ymd } from '../quant/dates.js';
import { adjust, isBusinessDay, thirdFriday } from '../quant/calendar.js';
import { instantInTz } from '../core/clock.js';
import { makeObservation, unavailable } from './observation.js';
import { MARKET_DATASETS, datasetStates } from './ports.js';

const SOURCE = 'Simulated demo feed';
const PROVIDER = 'demo';

/** Fictional instruments. `seed` drives the deterministic price path. */
export const DEMO_UNIVERSE = [
  { symbol: 'ALFA', name: 'Alfa Industries (demo)', product: 'common_stock', family: 'equity', view: 'US_CASH', ccy: 'USD', venue: 'SIM-US', domicile: 'US', base: 182, vol: 1.0, spreadBps: 2, dividend: 0.55, borrow: { available: true, quantity: 500000, feeRate: 0.005 } },
  { symbol: 'BRVO', name: 'Bravo Biotech (demo)', product: 'common_stock', family: 'equity', view: 'US_CASH', ccy: 'USD', venue: 'SIM-US', domicile: 'US', base: 46, vol: 2.0, spreadBps: 6, borrow: { available: true, quantity: 300, feeRate: 0.08 } },
  { symbol: 'CHRL', name: 'Charlie Holdings (demo)', product: 'common_stock', family: 'equity', view: 'US_CASH', ccy: 'USD', venue: 'SIM-US', domicile: 'US', base: 73, vol: 1.2, spreadBps: 3, borrow: { available: false, quantity: 0, feeRate: 0 } },
  { symbol: 'DLTA', name: 'Delta Utilities (demo)', product: 'common_stock', family: 'equity', view: 'US_CASH', ccy: 'USD', venue: 'SIM-US', domicile: 'US', base: 58, vol: 0.6, spreadBps: 2, dividend: 0.42, borrow: { available: true, quantity: 200000, feeRate: 0.004 } },
  { symbol: 'ECHO', name: 'Echo Pharma ADR (demo)', product: 'adr', family: 'equity', view: 'US_CASH', ccy: 'USD', venue: 'SIM-US', domicile: 'CH', underlyingGeo: 'CH', base: 94, vol: 0.9, spreadBps: 3, borrow: { available: true, quantity: 80000, feeRate: 0.01 } },
  { symbol: 'SIM500', name: 'Sim 500 Index ETF (demo)', product: 'etf', family: 'equity', view: 'US_CASH', ccy: 'USD', venue: 'SIM-US', domicile: 'US', base: 512, vol: 0.7, spreadBps: 1, dividend: 1.6, borrow: { available: true, quantity: 2000000, feeRate: 0.003 } },
  { symbol: 'KAIJ', name: 'Kaiju Motors (demo)', product: 'common_stock', family: 'equity', view: 'FOREIGN_CASH', ccy: 'JPY', venue: 'SIM-JP', domicile: 'JP', base: 2850, vol: 1.1, spreadBps: 5, lot: 100, borrow: { available: true, quantity: 100000, feeRate: 0.012 } },
  { symbol: 'ROSE', name: 'Rose & Crown plc (demo)', product: 'common_stock', family: 'equity', view: 'FOREIGN_CASH', ccy: 'GBP', venue: 'SIM-UK', domicile: 'GB', base: 12.4, vol: 0.9, spreadBps: 6, borrow: { available: true, quantity: 100000, feeRate: 0.009 } },
  { symbol: 'ALPN', name: 'Alpen AG (demo)', product: 'common_stock', family: 'equity', view: 'FOREIGN_CASH', ccy: 'EUR', venue: 'SIM-EU', domicile: 'DE', base: 96, vol: 0.8, spreadBps: 4, borrow: { available: true, quantity: 100000, feeRate: 0.007 } },
  { symbol: 'SIMCOIN', name: 'SimCoin (demo)', product: 'cryptocurrency', family: 'crypto', view: 'US_CASH', ccy: 'USD', venue: 'SIM-CRYPTO', base: 41000, vol: 2.5, spreadBps: 8 },
];

const FX_USD = { USD: 1, EUR: 1.085, GBP: 1.27, JPY: 1 / 151.2, CHF: 1.13, CAD: 0.735, AUD: 0.655 };
const RATES = { 'SIM-ON': 4.3, 'SIM-3M': 4.45 };
export const DEMO_FUTURES = {
  S5: { name: 'Sim 500 Index Future (demo)', view: 'US_DERIV', ccy: 'USD', venue: 'SIM-FUT-US', multiplier: 50, tickSize: 0.25, initialMargin: 12000, underlying: 'SIM500', scale: 10, settlement: 'cash' },
  SKJ: { name: 'Sim Kaiju Index Future (demo)', view: 'FOREIGN_DERIV', ccy: 'JPY', venue: 'SIM-FUT-JP', multiplier: 1000, tickSize: 5, initialMargin: 900000, underlying: 'KAIJ', scale: 13.5, settlement: 'cash' },
};
export const DEMO_BONDS = {
  SIMGOV31: { name: 'Sim Government 4.25% 15-May-2031 (demo)', product: 'treasury_note', view: 'US_CASH', ccy: 'USD', base: 100.4, vol: 0.06, terms: { couponType: 'fixed', couponRate: 0.0425, frequency: 2, maturity: '2031-05-15', issueDate: '2021-05-15', dayCount: 'ACT/ACT', redemption: 100 } },
  SIMCORP29: { name: 'Sim Corp 5.50% 01-Mar-2029 (demo)', product: 'corporate_bond_ig', view: 'US_CASH', ccy: 'USD', base: 101.9, vol: 0.1, terms: { couponType: 'fixed', couponRate: 0.055, frequency: 2, maturity: '2029-03-01', issueDate: '2019-03-01', dayCount: '30/360', redemption: 100 } },
};
const OPTION_VOL = { ALFA: 0.28, BRVO: 0.62, CHRL: 0.34, DLTA: 0.18, ECHO: 0.26, SIM500: 0.17 };
const BY_SYMBOL = new Map(DEMO_UNIVERSE.map((u) => [u.symbol, u]));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const frac = (seed, k) => ((hash(`${seed}#${k}`) % 100000) / 100000);

const PERIODS = [11 * 60e3, 47 * 60e3, 3.1 * 3600e3, 1.3 * 86400e3, 6.5 * 86400e3, 31 * 86400e3, 170 * 86400e3];
const AMPS = [0.0005, 0.001, 0.0028, 0.007, 0.016, 0.04, 0.09];

/** Deterministic, continuous price factor for a seed at an instant. */
function factor(seed, tMs, volScale = 1) {
  let x = 0;
  for (let k = 0; k < PERIODS.length; k++) x += AMPS[k] * volScale * Math.sin((2 * Math.PI * tMs) / PERIODS[k] + 2 * Math.PI * frac(seed, k));
  return Math.exp(x);
}

export function createDemoMarketPort({ clock, resolveInstrument }) {
  const overrides = new Map(); // subject -> {value, bid, ask, bidSize, askSize}
  const borrowOverrides = new Map();
  let frozenSizes = null;

  const spotAt = (symbol, tMs) => {
    const u = BY_SYMBOL.get(symbol);
    if (!u) return null;
    return u.base * factor(symbol, tMs, u.vol);
  };
  const tickOf = (price) => (price >= 1000 ? 1 : price >= 1 ? 0.01 : 0.0001);
  const roundTo = (x, tick) => Math.round(x / tick) * tick;

  function fxAt(pair, tMs) {
    const [a, b] = pair.split('/');
    if (!(a in FX_USD) || !(b in FX_USD)) return null;
    const usd = (c) => (c === 'USD' ? 1 : FX_USD[c] * factor(`FX:${c}`, tMs, 0.35));
    return usd(a) / usd(b);
  }

  function rawPrice(instrument, tMs) {
    const t = instrument.terms || {};
    switch (instrument.family) {
      case 'equity':
      case 'crypto':
      case 'fund': {
        const u = BY_SYMBOL.get(instrument.symbol);
        if (!u) return null;
        const p = spotAt(u.symbol, tMs);
        return { mid: p, half: (p * u.spreadBps) / 20000, tick: tickOf(p), units: 'per unit', size: 100 };
      }
      case 'fx': {
        const pair = `${t.base}/${t.quote}`;
        const p = fxAt(pair, tMs);
        if (p === null) return null;
        const tick = p > 20 ? 0.001 : 0.00001;
        return { mid: p, half: p * 0.00005, tick, units: `${t.quote} per ${t.base}`, size: 1e6 };
      }
      case 'future': {
        const spec = DEMO_FUTURES[t.root];
        if (!spec || !t.expiration) return null;
        const s = spotAt(spec.underlying, tMs) * spec.scale;
        const T = Math.max(0, (Date.parse(`${t.expiration}T21:00:00Z`) - tMs) / (365 * 86400e3));
        const p = s * Math.exp(0.04 * T);
        return { mid: p, half: spec.tickSize / 2, tick: spec.tickSize, units: 'index points', size: 20 };
      }
      case 'option': {
        const und = resolveInstrument(instrument.underlying_id);
        if (!und || !(und.symbol in OPTION_VOL)) return null;
        const S = spotAt(und.symbol, tMs);
        const T = Math.max(0, (Date.parse(`${t.expiration}T20:00:00Z`) - tMs) / (365 * 86400e3));
        const m = Math.log(t.strike / S);
        const sigma = OPTION_VOL[und.symbol] * (1 + 0.6 * m * m - 0.15 * m);
        const p = blackScholes({ S, K: t.strike, T, r: 0.04, q: 0, sigma, right: t.right });
        const half = Math.max(0.01, p * 0.012);
        return { mid: Math.max(p, 0.01), half, tick: 0.01, units: 'per share (premium)', size: 15, extra: { iv: sigma, underlyingPrice: S } };
      }
      case 'bond': {
        const b = DEMO_BONDS[instrument.symbol];
        if (!b) return null;
        const p = b.base * factor(instrument.symbol, tMs, b.vol);
        return { mid: p, half: 0.03, tick: 0.001, units: '% of par (clean)', size: 5e6 };
      }
      default:
        return null;
    }
  }

  function observe(instrument, tMs, { forDate } = {}) {
    const nowIso = clock.now().toISOString();
    const ov = overrides.get(instrument.id);
    const raw = rawPrice(instrument, tMs);
    if (!raw && !ov) return null;
    let bid, ask, value, bidSize, askSize;
    if (ov) {
      value = ov.value ?? (ov.bid != null && ov.ask != null ? (ov.bid + ov.ask) / 2 : null);
      bid = ov.bid ?? (raw ? value - raw.half : value);
      ask = ov.ask ?? (raw ? value + raw.half : value);
      bidSize = ov.bidSize ?? null;
      askSize = ov.askSize ?? null;
    } else {
      const tick = raw.tick;
      bid = Math.max(tick, roundTo(raw.mid - raw.half, tick));
      ask = Math.max(bid + tick, roundTo(raw.mid + raw.half, tick));
      value = roundTo(raw.mid, tick);
      if (value < bid) value = bid;
      if (value > ask) value = ask;
      const minute = Math.floor(tMs / 60000);
      const sz = (side) => raw.size * (1 + (hash(`${instrument.id}|${side}|${minute}`) % 9));
      bidSize = frozenSizes ?? sz('b');
      askSize = frozenSizes ?? sz('a');
    }
    const prevDay = new Date(tMs - 86400e3).getTime();
    const prev = raw ? rawPrice(instrument, prevDay)?.mid ?? null : null;
    return makeObservation({
      kind: 'price', subject: instrument.id, value, bid, ask, bidSize, askSize, prevClose: prev,
      currency: instrument.trading_ccy, units: raw?.units || 'per unit', source: SOURCE, providerId: PROVIDER,
      status: 'simulated', delayMinutes: 0, asOf: new Date(tMs).toISOString(), forDate: forDate || null, receivedAt: nowIso,
      assumptions: ['Simulated price from the demo feed. Not a market quote.'], extra: raw?.extra || {},
    });
  }

  const closeMs = (date) => instantInTz(date, '16:00').getTime();

  return {
    id: PROVIDER,
    /** Test/demo controls: pin a price, or clear pins. */
    set(instrumentId, v) {
      overrides.set(instrumentId, typeof v === 'number' ? { value: v } : v);
    },
    setBorrow(instrumentId, v) {
      borrowOverrides.set(instrumentId, v);
    },
    setSizes(n) {
      frozenSizes = n;
    },
    clear() {
      overrides.clear();
      borrowOverrides.clear();
      frozenSizes = null;
    },
    state: () => ({
      connection: 'demo',
      message: 'Demo mode: simulated feed. Prices are not market quotes.',
      address: '', lastChecked: null, lastSuccess: null, lastError: null,
      datasets: {
        ...datasetStates(MARKET_DATASETS, 'demo', 'Simulated for the fictional demo instruments only'),
        fundamentals: { label: MARKET_DATASETS.fundamentals, state: 'awaiting', coverage: null, lastRefresh: null, refreshSchedule: null, note: 'Not simulated' },
        events: { label: MARKET_DATASETS.events, state: 'awaiting', coverage: null, lastRefresh: null, refreshSchedule: null, note: 'Not simulated' },
      },
    }),
    testConnection: async () => ({ ok: true, reachable: true, detail: 'Demo feed is built in; no external connection is used.' }),
    async quotes(instruments) {
      const t = clock.ms();
      return new Map(instruments.map((i) => [i.id, observe(i, t)]));
    },
    async fx(pairs) {
      const t = clock.ms();
      const nowIso = clock.now().toISOString();
      return new Map(pairs.map((pair) => {
        const ov = overrides.get(pair);
        const p = ov ? ov.value : fxAt(pair, t);
        if (p === null || p === undefined) return [pair, null];
        return [pair, makeObservation({ kind: 'fx', subject: pair, value: p, bid: p * 0.99995, ask: p * 1.00005, currency: pair.split('/')[1], units: `${pair.split('/')[1]} per ${pair.split('/')[0]}`, source: SOURCE, providerId: PROVIDER, status: 'simulated', asOf: nowIso, receivedAt: nowIso, assumptions: ['Simulated FX rate from the demo feed.'] })];
      }));
    },
    async rates(codes, { from, to } = {}) {
      const nowIso = clock.now().toISOString();
      const end = to || clock.today();
      const start = from || addDays(end, -10);
      return new Map(codes.map((code) => {
        if (!(code in RATES)) return [code, []];
        const out = [];
        for (let d = start; d <= end; d = addDays(d, 1)) {
          if (!isBusinessDay(d, 'US')) continue;
          const ov = overrides.get(`${code}@${d}`) ?? overrides.get(code);
          const v = ov ? ov.value : RATES[code] + 0.15 * Math.sin(diffDays('2024-01-01', d) / 45 + frac(code, 1) * 6);
          out.push(makeObservation({ kind: 'rate', subject: code, value: Math.round(v * 1000) / 1000, currency: 'USD', units: 'percent p.a.', source: SOURCE, providerId: PROVIDER, status: 'simulated', asOf: `${d}T21:00:00.000Z`, forDate: d, receivedAt: nowIso, assumptions: ['Simulated reference rate from the demo feed.'] }));
        }
        return [code, out];
      }));
    },
    async closes(reqs) {
      const today = clock.today();
      const now = clock.ms();
      return new Map(reqs.map(({ instrument, date }) => {
        const key = `${instrument.id}@${date}`;
        const t = closeMs(date);
        // A close exists only once the day's close has passed.
        if (date > today || t > now) return [key, null];
        const ov = overrides.get(key);
        if (ov) {
          return [key, makeObservation({ kind: 'price', subject: instrument.id, value: ov.value, currency: instrument.trading_ccy, units: 'per unit', source: SOURCE, providerId: PROVIDER, status: 'simulated', asOf: new Date(t).toISOString(), forDate: date, receivedAt: clock.now().toISOString(), assumptions: ['Simulated close from the demo feed.'] })];
        }
        const o = observe(instrument, t, { forDate: date });
        return [key, o ? { ...o, bid: null, ask: null, bidSize: null, askSize: null } : null];
      }));
    },
    async borrow(instruments) {
      const nowIso = clock.now().toISOString();
      return new Map(instruments.map((i) => {
        const b = borrowOverrides.get(i.id) ?? BY_SYMBOL.get(i.symbol)?.borrow;
        if (!b) return [i.id, null];
        return [i.id, {
          available: b.available, quantity: b.quantity, feeRate: b.feeRate, rebateRate: 0,
          obs: makeObservation({ kind: 'borrow', subject: i.id, value: b.feeRate * 100, units: 'percent p.a. (borrow fee)', source: SOURCE, providerId: PROVIDER, status: 'simulated', asOf: nowIso, receivedAt: nowIso, assumptions: ['Simulated borrow availability from the demo feed.'], extra: { available: b.available, quantity: b.quantity } }),
        }];
      }));
    },
    async sessions(instruments) {
      return new Map(instruments.map((i) => [i.id, { state: 'open', note: 'Demo feed trades around the clock' }]));
    },
    async history(instrument, { from, to } = {}) {
      const end = to || clock.today();
      const start = from || addDays(end, -180);
      const bars = [];
      const now = clock.ms();
      for (let d = start; d <= end; d = addDays(d, 1)) {
        if (weekday(d) === 0 || weekday(d) === 6) continue;
        const o = rawPrice(instrument, instantInTz(d, '09:30').getTime());
        const tClose = Math.min(closeMs(d), now);
        const c = rawPrice(instrument, tClose);
        if (!o || !c) return unavailable('no-coverage', 'The demo feed does not simulate this instrument.');
        const mid = rawPrice(instrument, instantInTz(d, '12:45').getTime()).mid;
        bars.push({ t: new Date(tClose).toISOString(), date: d, open: o.mid, high: Math.max(o.mid, c.mid, mid) * 1.002, low: Math.min(o.mid, c.mid, mid) * 0.998, close: c.mid, volume: 1e6 + (hash(`${instrument.id}${d}`) % 4e6) });
      }
      return { available: true, bars, source: SOURCE, providerId: PROVIDER, status: 'simulated', currency: instrument.trading_ccy };
    },
    async search() {
      return unavailable('awaiting-connection', 'Demo mode has no reference-data search. The fictional demo instruments are already in the registry.');
    },
    async reference() {
      return unavailable('awaiting-connection', 'Demo mode has no reference data service.');
    },
    async optionChain(underlying, { expiration } = {}) {
      if (!(underlying.symbol in OPTION_VOL)) return unavailable('no-coverage', 'The demo feed has no option chain for this instrument.');
      const t = clock.ms();
      const today = clock.today();
      const expirations = demoExpirations(today);
      const exp = expiration && expirations.includes(expiration) ? expiration : expirations[0];
      const S = spotAt(underlying.symbol, t);
      const step = S >= 400 ? 5 : S >= 100 ? 2.5 : S >= 25 ? 1 : 0.5;
      const center = Math.round(S / step) * step;
      const strikes = [];
      for (let k = -12; k <= 12; k++) strikes.push(Math.round((center + k * step) * 100) / 100);
      const T = Math.max(0, (Date.parse(`${exp}T20:00:00Z`) - t) / (365 * 86400e3));
      const nowIso = clock.now().toISOString();
      const mk = (right) => strikes.filter((k) => k > 0).map((K) => {
        const m = Math.log(K / S);
        const sigma = OPTION_VOL[underlying.symbol] * (1 + 0.6 * m * m - 0.15 * m);
        const p = Math.max(0.01, blackScholes({ S, K, T, r: 0.04, q: 0, sigma, right }));
        const half = Math.max(0.01, p * 0.012);
        const bid = Math.max(0.01, Math.round((p - half) * 100) / 100);
        const ask = Math.max(bid + 0.01, Math.round((p + half) * 100) / 100);
        return { contractSymbol: `${underlying.symbol} ${exp} ${K}${right}`, right, strike: K, expiration: exp, last: Math.round(p * 100) / 100, bid, ask, bidSize: 15, askSize: 15, volume: hash(`${underlying.symbol}${exp}${K}${right}`) % 900, openInterest: hash(`oi${underlying.symbol}${exp}${K}${right}`) % 9000, iv: sigma, inTheMoney: right === 'C' ? S > K : S < K, currency: underlying.trading_ccy, multiplier: 100, deliverable: { shares: 100 }, exercise: 'american', settlement: 'physical' };
      });
      return {
        available: true,
        chain: {
          underlying: { instrumentId: underlying.id, symbol: underlying.symbol, price: S, currency: underlying.trading_ccy },
          expirations, expiration: exp, strikes, calls: mk('C'), puts: mk('P'),
          source: SOURCE, providerId: PROVIDER, status: 'simulated', asOf: nowIso,
        },
      };
    },
    async contracts(underlying, { family } = {}) {
      if (family !== 'future') return unavailable('no-coverage', 'The demo feed lists futures contract months only.');
      const today = clock.today();
      const items = [];
      for (const [root, spec] of Object.entries(DEMO_FUTURES)) {
        if (underlying && underlying.symbol !== spec.underlying && underlying.symbol !== root) continue;
        for (const exp of demoQuarterlies(today, 4)) {
          items.push({ root, symbol: `${root} ${exp.slice(0, 7)}`, name: `${spec.name} ${exp.slice(0, 7)}`, expiration: exp, ...spec });
        }
      }
      return { available: true, items, source: SOURCE, providerId: PROVIDER, status: 'simulated' };
    },
    async corporateActions(instruments, { from, to } = {}) {
      const items = [];
      for (const i of instruments) {
        const u = BY_SYMBOL.get(i.symbol);
        if (!u?.dividend) continue;
        for (const ex of demoExDates(from, to)) items.push({ instrumentId: i.id, type: 'cash_dividend', exDate: ex, payDate: ex, amount: u.dividend, currency: u.ccy });
      }
      return { available: true, items, source: SOURCE, providerId: PROVIDER, status: 'simulated' };
    },
    async calendar() {
      return unavailable('awaiting-connection', 'Not simulated in demo mode.');
    },
  };
}

/** Next two weekly Fridays plus the next three monthly third Fridays. */
function demoExpirations(today) {
  const out = new Set();
  let d = today;
  while (weekday(d) !== 5) d = addDays(d, 1);
  if (d === today) d = addDays(d, 7);
  out.add(d);
  out.add(addDays(d, 7));
  const { y, m } = ymd(today);
  for (let k = 0; out.size < 6 && k < 8; k++) {
    const mm = ((m - 1 + k) % 12) + 1;
    const yy = y + Math.floor((m - 1 + k) / 12);
    const tf = thirdFriday(yy, mm);
    if (tf > today) out.add(tf);
  }
  return [...out].sort().slice(0, 5);
}

function demoQuarterlies(today, n) {
  const out = [];
  const { y } = ymd(today);
  for (let yy = y; out.length < n && yy < y + 3; yy++) {
    for (const mm of [3, 6, 9, 12]) {
      const tf = thirdFriday(yy, mm);
      if (tf > today && out.length < n) out.push(tf);
    }
  }
  return out;
}

/** Demo ex-dividend dates: the 15th of Feb/May/Aug/Nov, rolled to a business day. */
function demoExDates(from, to) {
  if (!from || !to) return [];
  const out = [];
  for (let y = ymd(from).y; y <= ymd(to).y; y++) {
    for (const m of [2, 5, 8, 11]) {
      const d = adjust(makeDate(y, m, 15), 'following', 'US');
      if (d >= from && d <= to) out.push(d);
    }
  }
  return out;
}
