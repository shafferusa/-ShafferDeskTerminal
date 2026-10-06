// Simulated fill model and fee schedule.
//
// A paper order is never filled silently at the last displayed price. The model used for each
// fill is recorded on the fill and shown in the preview:
//
//   stated-price     the user stated the fill price for this leg (manual)
//   quoted-bid-ask   bought at the ask / sold at the bid of an executable quote, limited by its size
//   last-plus-spread only a last price was quoted: last +/- the Book's assumed half spread
//   manual-mark      a manually entered price (its bid/ask if entered, else +/- the assumed half spread)
//
// Indicative levels, model-derived marks, reconstructed prices and end-of-day closes are NOT
// executable quotes. An order against one of those waits, unless the user states a fill price.
// Fair values from Analytics Lab are never used for execution at all.

import { EXECUTABLE_STATUSES, STATUS_LABEL } from '../data/observation.js';
import { money, round } from './util.js';

export const FILL_MODEL_LABEL = {
  'stated-price': 'Stated fill price (manually entered)',
  'quoted-bid-ask': 'Quoted bid/ask',
  'last-plus-spread': 'Last price with assumed spread',
  'manual-mark': 'Manual-mark fill model',
  none: 'No executable price',
};

const BUY = new Set(['buy', 'buy_to_cover']);

function assumedHalfSpread(inst, mid, fill) {
  if (inst.family === 'option' || inst.family === 'otcoption') {
    const tick = inst.terms?.tickSize || 0.01;
    return inst.family === 'otcoption' ? 0 : Math.max(tick, (mid * fill.optionHalfSpreadPct) / 100);
  }
  if (inst.family === 'future') return (inst.terms?.tickSize || mid * 0.0001) * fill.futureHalfSpreadTicks;
  const bps = fill.halfSpreadBps[inst.family] ?? 0;
  return (mid * bps) / 10000;
}

function roundTick(inst, price, buy) {
  const tick = inst.terms?.tickSize;
  if (!tick) return round(price, 8);
  // Round against the order: buys up, sells down.
  const n = price / tick;
  const r = buy ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9);
  return round(r * tick, 8);
}

/**
 * Work out whether and at what price a leg could fill right now.
 * @returns {{executable:boolean, price:number|null, model:string, label:string, note:string, maxQty:number|null, reference:number|null, reason?:string}}
 */
export function estimateFill(app, { inst, action, obs, book, statedPrice, limitPrice, stopPrice, orderType = 'market', stopTriggered = false }) {
  const fill = book.settings.fill;
  const buy = BUY.has(action);
  const out = { executable: false, price: null, model: 'none', label: FILL_MODEL_LABEL.none, note: '', maxQty: null, reference: obs?.value ?? null, obsStatus: obs?.status ?? null };
  const awaiting = app.data.describe().awaitingMessage;
  const slip = (p) => p * (1 + ((buy ? 1 : -1) * fill.slippageBps) / 10000);

  if (statedPrice !== null && statedPrice !== undefined) {
    out.executable = true;
    out.price = statedPrice;
    out.model = 'stated-price';
    out.label = FILL_MODEL_LABEL['stated-price'];
    out.note = 'Fills at the price you stated for this leg. Recorded as a manual input, not a market quote.';
    return applyOrderConditions(out, { buy, limitPrice, stopPrice, orderType, stopTriggered, last: statedPrice });
  }
  if (!obs || (obs.value === null && (obs.bid === null || obs.ask === null))) {
    out.reason = app.data.marketConnected()
      ? 'No price is available for this instrument. Enter a manual price or state a fill price.'
      : `${awaiting}: no price for this instrument. Enter a manual price or state a fill price.`;
    return out;
  }
  const shown = app.data.present(obs);
  const hasBook = obs.bid !== null && obs.ask !== null && obs.bid > 0 && obs.ask > 0;
  const mid = hasBook ? (obs.bid + obs.ask) / 2 : obs.value;

  if (obs.status === 'manual') {
    const half = assumedHalfSpread(inst, mid, fill);
    const raw = hasBook ? (buy ? obs.ask : obs.bid) : buy ? mid + half : mid - half;
    out.executable = true;
    out.price = roundTick(inst, slip(raw), buy);
    out.model = 'manual-mark';
    out.label = FILL_MODEL_LABEL['manual-mark'];
    out.note = hasBook ? 'Fills against the bid/ask you entered manually.' : `Fills at your manually entered price ${half ? 'plus the Book\'s assumed half spread' : '(no spread assumed)'}.`;
    return applyOrderConditions(out, { buy, limitPrice, stopPrice, orderType, stopTriggered, last: obs.value ?? mid });
  }

  if (!EXECUTABLE_STATUSES.has(obs.status) && !(obs.status === 'end-of-day' && fill.allowEndOfDayFills)) {
    out.reason = `Only a ${String(STATUS_LABEL[obs.status] || obs.status).toLowerCase()} value is available (${obs.source}). It is not an executable quote; state a fill price for this leg to proceed.`;
    return out;
  }
  const maxAge = fill.maxQuoteAgeSec + (obs.delayMinutes ? obs.delayMinutes * 60 : 0);
  if (obs.status !== 'end-of-day' && shown.ageSec !== null && shown.ageSec > maxAge) {
    out.reason = `The last quote is ${shown.ageSec} seconds old. Waiting for a fresh quote.`;
    return out;
  }
  const session = app.data.session(inst.id);
  if (session && session.state && session.state !== 'open') {
    out.reason = `Market is ${session.state === 'closed' ? 'closed' : `in its ${session.state}-market session`}. The order waits for the regular session.`;
    return out;
  }
  if (hasBook) {
    out.price = roundTick(inst, slip(buy ? obs.ask : obs.bid), buy);
    out.model = 'quoted-bid-ask';
    out.label = `${FILL_MODEL_LABEL['quoted-bid-ask']}${obs.status === 'delayed' ? ' (delayed)' : obs.status === 'simulated' ? ' (simulated feed)' : ''}`;
    const size = buy ? obs.askSize : obs.bidSize;
    if (size !== null && size > 0) out.maxQty = size * fill.participation;
    out.note = `${buy ? 'Buys at the ask' : 'Sells at the bid'}${out.maxQty !== null ? `, up to the displayed size (${out.maxQty}) per matching cycle; any remainder keeps working` : ''}.`;
  } else {
    const half = assumedHalfSpread(inst, mid, fill);
    out.price = roundTick(inst, slip(buy ? mid + half : mid - half), buy);
    out.model = 'last-plus-spread';
    out.label = FILL_MODEL_LABEL['last-plus-spread'];
    out.note = `No bid/ask quoted. Uses the last price ${buy ? 'plus' : 'minus'} the Book's assumed half spread.`;
  }
  if (fill.slippageBps) out.note += ` Includes ${fill.slippageBps} bp of assumed slippage.`;
  out.executable = true;
  return applyOrderConditions(out, { buy, limitPrice, stopPrice, orderType, stopTriggered, last: obs.value ?? mid });
}

function applyOrderConditions(out, { buy, limitPrice, stopPrice, orderType, stopTriggered, last }) {
  if ((orderType === 'stop' || orderType === 'stop_limit') && !stopTriggered) {
    const hit = buy ? last >= stopPrice : last <= stopPrice;
    if (!hit) {
      out.executable = false;
      out.reason = `Stop not triggered: last ${last} has not ${buy ? 'risen to' : 'fallen to'} ${stopPrice}.`;
      out.waitingOnStop = true;
      return out;
    }
    out.stopHit = true;
  }
  if ((orderType === 'limit' || orderType === 'stop_limit') && limitPrice !== null && limitPrice !== undefined) {
    const ok = buy ? out.price <= limitPrice + 1e-12 : out.price >= limitPrice - 1e-12;
    if (!ok) {
      out.executable = false;
      out.reason = `Limit not reached: executable price ${out.price} is ${buy ? 'above' : 'below'} the limit ${limitPrice}.`;
      out.waitingOnLimit = true;
    }
  }
  return out;
}

/** Commission and fees for a fill, from the Book's fee schedule. */
export function computeFees(book, inst, qty, price) {
  const f = book.settings.fees[inst.family];
  if (!f) return [];
  const ccy = inst.trading_ccy;
  const principal = ['swap', 'cds', 'forward'].includes(inst.family) ? qty : qty * price * inst.multiplier;
  let amount = (f.perUnit || 0) * qty + ((f.bps || 0) / 10000) * Math.abs(principal);
  if (amount > 0 && f.minimum) amount = Math.max(amount, f.minimum);
  amount = money(amount, ccy);
  return amount > 0 ? [{ kind: 'commission', amount, ccy, label: `Commission (${describeFee(f)})` }] : [];
}

function describeFee(f) {
  const parts = [];
  if (f.perUnit) parts.push(`${f.perUnit} per unit`);
  if (f.bps) parts.push(`${f.bps} bp`);
  if (f.minimum) parts.push(`min ${f.minimum}`);
  return parts.join(', ') || 'none';
}
