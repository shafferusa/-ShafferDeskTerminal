// Confirmation validation and fill reconciliation.
//
// A preview is one price snapshot. `snapshotOf` reduces it to the figures a person is shown and
// confirms: per leg (estimated fill, quantity, cash, fees, margin, collateral, notional, financing
// amount and rate, borrow availability, settlement date, quote status and freshness) and per
// currency for the whole package (cash required, net cash, each component, the shortfall, and two
// gross measures). The confirmation sends that snapshot back; `compare` sets it against a fresh
// pricing of the same legs under the Book's tolerances. A small net change cannot hide two large
// moves that offset each other, because every leg is checked alone and the gross measures add
// absolute amounts.
//
// What was confirmed is kept on each order (`confirmedLeg`), and each fill records how its actual
// figures differ from it and why (`fillVariance`), so a permitted difference is an explicit record.

import { ccyDecimals, money, num, round } from './util.js';

const BUY = new Set(['buy', 'buy_to_cover']);
const n0 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const minorUnit = (ccy) => 10 ** -ccyDecimals(ccy || 'USD');

/** The Book's confirmation tolerances, as the engine applies them. */
export function tolerancesOf(book) {
  const c = book.settings.confirmation || {};
  const over = book.settingsOverrides || {};
  // A Book that changed the old single threshold, and has not set the new package tolerance, keeps its value.
  const legacy = over.fill?.maxPreviewDriftPct;
  const packageCashPct = over.confirmation?.packageCashPct ?? legacy ?? c.packageCashPct ?? 0.5;
  return {
    legPricePct: c.legPricePct ?? 0.5,
    legAmountPct: c.legAmountPct ?? 0.5,
    packageCashPct,
    grossCashPct: c.grossCashPct ?? 0.5,
    maxPreviewAgeSec: c.maxPreviewAgeSec ?? 300,
  };
}

export const TOLERANCE_LABEL = {
  legPricePct: 'Leg price',
  legAmountPct: 'Leg amounts',
  packageCashPct: 'Package totals',
  grossCashPct: 'Gross cash and notional',
  maxPreviewAgeSec: 'Preview age',
};

/** Identity of a leg: what it does and to what. A different key means a different leg, not a moved figure. */
function legKey(r) {
  const what = r.instrumentId || (r.option ? `opt:${r.option.underlyingId}:${r.option.expiration}:${r.option.right}:${r.option.strike}` : null)
    || (r.contract ? `contract:${r.contract.productId}:${r.contract.name}` : null) || r.targetPositionId || r.sourcePositionId
    || (r.funding ? `fund:${r.funding.fromUnitId}:${r.funding.ccy}` : null) || (r.reserve ? `reserve:${r.reserve.ccy}` : null) || '';
  return `${r.kind}|${r.action || ''}|${what}`;
}

/** The displayed figures of one preview leg. */
export function legFigures(r) {
  const p = r.price || null;
  const obs = p?.observation || r.borrowInfo?.observation || null;
  const f = r.financing || null;
  return {
    n: r.n, key: legKey(r), label: r.label, kind: r.kind, action: r.action || null, purpose: r.purpose || 'primary', ccy: r.currency || r.instrument?.ccy || null,
    qty: n0(r.qty),
    orderType: r.kind === 'trade' ? r.orderType || 'market' : null, limitPrice: n0(r.limitPrice), stopPrice: n0(r.stopPrice), statedPrice: n0(r.statedPrice),
    price: p ? n0(p.estimate) : null, priceModel: p ? p.model || null : null, executable: p ? Boolean(p.executable) : null,
    quote: obs ? { status: obs.status || null, freshness: obs.freshness || null, asOf: obs.asOf || null, source: obs.source || null } : null,
    cash: n0(r.cash), otherCash: (r.otherCash || []).map((o) => ({ ccy: o.ccy, amount: o.amount })),
    fees: r.kind === 'trade' ? n0(r.feeTotal) : null, accrued: n0(r.accrued),
    notional: n0(r.notional), exposure: n0(r.exposure),
    margin: n0(r.initialMargin) || null,
    collateral: r.shortCollateral ? { topUp: n0(r.shortCollateral.topUp), marginHold: n0(r.shortCollateral.marginHold) } : null,
    // OTC collateral terms that apply to the leg (core/agreements.js): the basis, and the independent amount this trade calls for.
    agreement: r.collateral ? { basis: r.collateral.basis?.label || r.collateral.basis?.type || null, agreementId: r.collateral.basis?.agreementId || null, independent: n0(r.collateral.independent?.delta), required: n0(r.collateral.independent?.required), ccy: r.collateral.independent?.ccy || null, variation: r.collateral.variation ? (r.collateral.variation.on ? 'exchanged' : 'not exchanged') : null } : null,
    financing: f ? { amount: n0(f.amount), ccy: f.ccy || null, rateType: f.rateType || null, rate: n0(f.rate), referenceRate: f.referenceRate || null, spread: n0(f.spread), fixing: n0(f.fixing), maturity: f.maturity || null, dailyCost: n0(f.dailyCost), from: f.from || null } : null,
    borrow: r.borrowInfo ? { available: r.borrowInfo.available ?? null, feeRate: n0(r.borrowInfo.feeRate), quantityAvailable: n0(r.borrowInfo.quantityAvailable), source: r.borrowInfo.source || null, dailyCost: n0(r.borrowInfo.dailyCost) } : null,
    settleDate: r.settleDate || null,
    settlementBasis: r.settlement?.basis || null,
  };
}

const TOTAL_FIELDS = [
  ['required', 'Cash required'], ['netCash', 'Net cash'], ['purchases', 'Purchases'], ['proceeds', 'Sale proceeds'], ['restrictedProceeds', 'Short-sale proceeds (restricted)'],
  ['fees', 'Fees and commissions'], ['margin', 'Margin'], ['collateral', 'Collateral'], ['reserved', 'Reserved against short options'],
  ['financingIn', 'Financing received'], ['financingOut', 'Financing paid out'], ['shortfall', 'Funding shortfall'],
];

/** The displayed figures of a whole preview: what a confirmation of it confirms. */
export function snapshotOf(pv, book) {
  const legs = pv.legs.map(legFigures);
  const totals = {};
  const at = (ccy) => (totals[ccy] = totals[ccy] || { ccy, grossCash: 0, grossNotional: 0 });
  for (const [ccy, t] of Object.entries(pv.totals.cash || {})) {
    const row = at(ccy);
    for (const [k] of TOTAL_FIELDS) if (typeof t[k] === 'number') row[k] = t[k];
  }
  for (const l of legs) {
    if (l.cash !== null && l.ccy) at(l.ccy).grossCash += Math.abs(l.cash);
    for (const o of l.otherCash) at(o.ccy).grossCash += Math.abs(o.amount || 0);
    if (l.notional !== null && l.ccy) at(l.ccy).grossNotional += Math.abs(l.notional);
  }
  for (const row of Object.values(totals)) { row.grossCash = money(row.grossCash, row.ccy); row.grossNotional = money(row.grossNotional, row.ccy); }
  return { version: 1, token: pv.token, snapshotAt: pv.generatedAt, tolerances: tolerancesOf(book), legs, totals, blocking: pv.blocking || 0 };
}

const pctOf = (was, now) => (was === null || now === null || was === 0 ? null : round(((now - was) / Math.abs(was)) * 100, 4));

/** True when a number moved by more than the tolerance (percent of what was displayed), with an absolute floor. */
function moved(was, now, pct, floor) {
  if (was === null && now === null) return false;
  if (was === null || now === null) return true;
  return Math.abs(now - was) > Math.max((Math.abs(was) * pct) / 100, floor) + 1e-9;
}

const LEG_AMOUNTS = [
  ['cash', 'Cash'], ['fees', 'Fees'], ['accrued', 'Accrued interest'], ['notional', 'Notional exposure'], ['margin', 'Margin'],
];
const LEG_TERMS = [
  ['qty', 'Quantity', 'qty'], ['orderType', 'Order type', 'text'], ['limitPrice', 'Limit price', 'price'], ['stopPrice', 'Stop price', 'price'], ['statedPrice', 'Stated fill price', 'price'],
  ['settleDate', 'Settlement date', 'date'], ['priceModel', 'Fill model', 'text'],
];

/**
 * Differences between two snapshots. `all: true` lists every difference with whether it is within
 * tolerance (used to record permitted changes); otherwise only what exceeds a tolerance or is a
 * changed non-numeric term.
 */
export function compare(shown, now, tol, { nowMs = null, all = false } = {}) {
  const out = [];
  const push = (c, breach) => { if (breach || all) out.push({ ...c, within: !breach }); };
  const amount = (scope, n, label, field, fieldLabel, ccy, was, cur, pct, tolKey) => {
    if (was === cur || (was === null && cur === null)) return;
    const breach = moved(was, cur, pct, minorUnit(ccy));
    push({ scope, n, label, field, fieldLabel, ccy, unit: 'money', kind: 'amount', was, now: cur, changePct: pctOf(was, cur), tolerancePct: pct, tolerance: tolKey }, breach);
  };
  const term = (scope, n, label, field, fieldLabel, unit, was, cur, note) => {
    if (was === cur || (was === null && cur === null) || (typeof was === 'number' && typeof cur === 'number' && Math.abs(was - cur) < 1e-12)) return;
    push({ scope, n, label, field, fieldLabel, ccy: null, unit, kind: 'term', was, now: cur, changePct: null, tolerancePct: null, tolerance: null, note: note || null }, true);
  };

  // ---- the preview itself -----------------------------------------------------------------------
  if (nowMs !== null && tol.maxPreviewAgeSec > 0 && shown.snapshotAt) {
    const age = Math.round((nowMs - Date.parse(shown.snapshotAt)) / 1000);
    if (age > tol.maxPreviewAgeSec) push({ scope: 'package', n: null, label: 'Preview', field: 'previewAge', fieldLabel: 'Age of the displayed preview', ccy: null, unit: 'seconds', kind: 'term', was: tol.maxPreviewAgeSec, now: age, changePct: null, tolerancePct: null, tolerance: 'maxPreviewAgeSec', note: `The figures displayed were priced ${age} seconds before the confirmation; the Book allows ${tol.maxPreviewAgeSec}.` }, true);
  }

  // ---- legs ---------------------------------------------------------------------------------------
  // What was displayed comes back from the caller: read it defensively (a missing list is an empty one).
  const tidy = (l) => (l && typeof l === 'object' ? { ...l, otherCash: Array.isArray(l.otherCash) ? l.otherCash : [] } : null);
  const count = Math.max(shown.legs.length, now.legs.length);
  for (let i = 0; i < count; i++) {
    const a = tidy(shown.legs[i]), b = tidy(now.legs[i]);
    const n = (a || b).n, label = (a || b).label;
    if (!a || !b || a.key !== b.key) {
      push({ scope: 'leg', n, label, field: 'leg', fieldLabel: 'Leg', ccy: null, unit: 'text', kind: 'term', was: a ? a.label : null, now: b ? b.label : null, changePct: null, tolerancePct: null, tolerance: null,
        note: !b ? 'This leg is no longer part of the package.' : !a ? 'This leg was not in the package displayed.' : 'A different leg stands in this place.' }, true);
      continue;
    }
    const ccy = b.ccy || a.ccy;
    for (const [f, fl, unit] of LEG_TERMS) term('leg', n, label, f, fl, unit, a[f], b[f]);
    // Estimated fill: a price, with its own tolerance.
    if (a.price !== b.price) {
      const breach = moved(a.price, b.price, tol.legPricePct, 1e-9);
      push({ scope: 'leg', n, label, field: 'price', fieldLabel: 'Estimated fill', ccy, unit: 'price', kind: 'price', was: a.price, now: b.price, changePct: pctOf(a.price, b.price), tolerancePct: tol.legPricePct, tolerance: 'legPricePct',
        note: a.price !== null && b.price === null ? 'There is no executable price for this leg any more.' : null }, breach);
    }
    if (a.executable !== b.executable && a.price !== null && b.price !== null) term('leg', n, label, 'executable', 'Can fill now', 'text', a.executable ? 'yes' : 'no', b.executable ? 'yes' : 'no', b.executable ? null : 'The leg would now wait as a working order.');
    term('leg', n, label, 'quoteStatus', 'Quote status', 'text', a.quote?.status ?? null, b.quote?.status ?? null);
    term('leg', n, label, 'quoteFreshness', 'Quote freshness', 'text', a.quote?.freshness ?? null, b.quote?.freshness ?? null);
    for (const [f, fl] of LEG_AMOUNTS) amount('leg', n, label, f, fl, ccy, a[f], b[f], tol.legAmountPct, 'legAmountPct');
    const other = new Set([...a.otherCash.map((o) => o.ccy), ...b.otherCash.map((o) => o.ccy)]);
    for (const oc of other) amount('leg', n, label, `otherCash.${oc}`, `Cash in ${oc}`, oc, a.otherCash.find((o) => o.ccy === oc)?.amount ?? null, b.otherCash.find((o) => o.ccy === oc)?.amount ?? null, tol.legAmountPct, 'legAmountPct');
    amount('leg', n, label, 'collateral.topUp', 'Collateral top-up', ccy, a.collateral?.topUp ?? null, b.collateral?.topUp ?? null, tol.legAmountPct, 'legAmountPct');
    amount('leg', n, label, 'collateral.marginHold', 'Margin hold', ccy, a.collateral?.marginHold ?? null, b.collateral?.marginHold ?? null, tol.legAmountPct, 'legAmountPct');
    if (a.agreement || b.agreement) {
      term('leg', n, label, 'agreement.basis', 'Collateral basis', 'text', a.agreement?.basis ?? null, b.agreement?.basis ?? null);
      term('leg', n, label, 'agreement.agreementId', 'Collateral agreement', 'text', a.agreement?.agreementId ?? null, b.agreement?.agreementId ?? null);
      term('leg', n, label, 'agreement.variation', 'Variation margin', 'text', a.agreement?.variation ?? null, b.agreement?.variation ?? null);
      amount('leg', n, label, 'agreement.independent', 'Independent amount called', b.agreement?.ccy || a.agreement?.ccy || ccy, a.agreement?.independent ?? null, b.agreement?.independent ?? null, tol.legAmountPct, 'legAmountPct');
      amount('leg', n, label, 'agreement.required', 'Independent amount required', b.agreement?.ccy || a.agreement?.ccy || ccy, a.agreement?.required ?? null, b.agreement?.required ?? null, tol.legAmountPct, 'legAmountPct');
    }
    // Financing: the amount and the daily cost may move within tolerance; the terms may not move at all.
    const fa = a.financing, fb = b.financing;
    if (fa || fb) {
      amount('leg', n, label, 'financing.amount', 'Financing amount', fb?.ccy || fa?.ccy || ccy, fa?.amount ?? null, fb?.amount ?? null, tol.legAmountPct, 'legAmountPct');
      amount('leg', n, label, 'financing.dailyCost', 'Financing cost a day', fb?.ccy || fa?.ccy || ccy, fa?.dailyCost ?? null, fb?.dailyCost ?? null, tol.legAmountPct, 'legAmountPct');
      term('leg', n, label, 'financing.rateType', 'Financing rate type', 'text', fa?.rateType ?? null, fb?.rateType ?? null);
      term('leg', n, label, 'financing.rate', 'Financing rate', 'rate', fa?.rate ?? null, fb?.rate ?? null);
      term('leg', n, label, 'financing.referenceRate', 'Reference rate', 'text', fa?.referenceRate ?? null, fb?.referenceRate ?? null);
      term('leg', n, label, 'financing.spread', 'Spread', 'rate', fa?.spread ?? null, fb?.spread ?? null);
      term('leg', n, label, 'financing.fixing', 'Reference rate fixing', 'percent', fa?.fixing ?? null, fb?.fixing ?? null);
      term('leg', n, label, 'financing.maturity', 'Maturity', 'date', fa?.maturity ?? null, fb?.maturity ?? null);
      term('leg', n, label, 'financing.from', 'Funded from', 'text', fa?.from ?? null, fb?.from ?? null);
    }
    const ba = a.borrow, bb = b.borrow;
    if (ba || bb) {
      term('leg', n, label, 'borrow.available', 'Borrow availability', 'text', ba ? (ba.available === null ? 'unknown' : ba.available ? 'available' : 'unavailable') : null, bb ? (bb.available === null ? 'unknown' : bb.available ? 'available' : 'unavailable') : null);
      term('leg', n, label, 'borrow.feeRate', 'Borrow fee', 'rate', ba?.feeRate ?? null, bb?.feeRate ?? null);
      term('leg', n, label, 'borrow.source', 'Borrow data source', 'text', ba?.source ?? null, bb?.source ?? null);
      const short = (x, q) => (x && x.quantityAvailable !== null && q !== null ? x.quantityAvailable < q : false);
      if (short(ba, a.qty) !== short(bb, b.qty)) term('leg', n, label, 'borrow.quantityAvailable', 'Quantity available to borrow', 'qty', ba?.quantityAvailable ?? null, bb?.quantityAvailable ?? null);
      amount('leg', n, label, 'borrow.dailyCost', 'Borrow cost a day', ccy, ba?.dailyCost ?? null, bb?.dailyCost ?? null, tol.legAmountPct, 'legAmountPct');
    }
  }

  // ---- package totals, per currency ---------------------------------------------------------------
  for (const ccy of new Set([...Object.keys(shown.totals || {}), ...Object.keys(now.totals || {})])) {
    const a = shown.totals?.[ccy] || {}, b = now.totals?.[ccy] || {};
    const label = `Package, ${ccy}`;
    for (const [f, fl] of TOTAL_FIELDS) amount('package', null, label, f, fl, ccy, n0(a[f]) ?? 0, n0(b[f]) ?? 0, tol.packageCashPct, 'packageCashPct');
    amount('package', null, label, 'grossCash', 'Gross cash of the legs', ccy, n0(a.grossCash) ?? 0, n0(b.grossCash) ?? 0, tol.grossCashPct, 'grossCashPct');
    amount('package', null, label, 'grossNotional', 'Gross notional of the legs', ccy, n0(a.grossNotional) ?? 0, n0(b.grossNotional) ?? 0, tol.grossCashPct, 'grossCashPct');
  }
  return out;
}

/**
 * The old confirmation format carried only the cash required per currency. It is still accepted
 * (and checked against the package tolerance) for callers that have not moved to the snapshot.
 */
export function compareLegacyCash(expectedCash, pv, tol) {
  const out = [];
  for (const ccy of new Set([...Object.keys(expectedCash || {}), ...Object.keys(pv.totals.cash || {})])) {
    const was = num(expectedCash[ccy]) ?? 0, cur = pv.totals.cash[ccy]?.required ?? 0;
    if (moved(was, cur, tol.packageCashPct, 0.01)) out.push({ scope: 'package', n: null, label: `Package, ${ccy}`, field: 'required', fieldLabel: 'Cash required', ccy, unit: 'money', kind: 'amount', was, now: cur, changePct: pctOf(was, cur), tolerancePct: tol.packageCashPct, tolerance: 'packageCashPct', within: false });
  }
  return out;
}

const show = (c, x) => {
  if (x === null || x === undefined) return 'none';
  if (c.unit === 'money') return `${Number(x).toLocaleString('en-US', { minimumFractionDigits: ccyDecimals(c.ccy || 'USD'), maximumFractionDigits: ccyDecimals(c.ccy || 'USD') })} ${c.ccy || ''}`.trim();
  if (c.unit === 'price') return Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  if (c.unit === 'rate') return `${round(Number(x) * 100, 4)}%`;
  if (c.unit === 'percent') return `${x}%`;
  if (c.unit === 'seconds') return `${x} s`;
  return String(x);
};

/** One change as a sentence fragment: "leg 2 Sell short 100 BRVO: estimated fill 50.00, was 51.00 (-1.96%, tolerance 0.50%)". */
export function describeChange(c) {
  const where = c.scope === 'leg' ? `leg ${c.n} ${c.label}` : c.label;
  if (c.field === 'previewAge') return c.note;
  if (c.field === 'leg') return `${where}: ${c.note}`;
  const pct = c.changePct !== null && c.changePct !== undefined ? `${c.changePct > 0 ? '+' : ''}${round(c.changePct, 2)}%` : null;
  const tol = c.tolerancePct !== null && c.tolerancePct !== undefined ? `tolerance ${c.tolerancePct}%` : null;
  const extra = [pct, tol].filter(Boolean).join(', ');
  return `${where}: ${c.fieldLabel.toLowerCase()} is now ${show(c, c.now)}, was ${show(c, c.was)}${extra ? ` (${extra})` : ''}${c.note ? `. ${c.note}` : ''}`;
}

/** The refusal message: says which legs and totals changed, and that nothing was submitted. */
export function refusalMessage(changes) {
  const legs = [...new Set(changes.filter((c) => c.scope === 'leg').map((c) => c.n))].sort((a, b) => a - b);
  // Lead with what moved on each leg (its price if that moved, else its first change), then the package.
  const lead = [];
  for (const n of legs) {
    const mine = changes.filter((c) => c.scope === 'leg' && c.n === n);
    lead.push(mine.find((c) => c.field === 'price') || mine[0]);
  }
  const pk = changes.filter((c) => c.scope === 'package');
  if (pk.length) lead.push(pk.find((c) => c.field === 'previewAge') || pk.find((c) => c.field === 'required') || pk.find((c) => c.field === 'grossCash') || pk[0]);
  const head = legs.length ? `Terms changed on leg${legs.length > 1 ? 's' : ''} ${legs.join(', ')}${pk.length ? ' and on the package totals' : ''} since this package was displayed` : 'The package changed since it was displayed';
  return `${head}. ${lead.slice(0, 4).map(describeChange).join('; ')}${changes.length > lead.slice(0, 4).length ? `; ${changes.length - lead.slice(0, 4).length} more change${changes.length - lead.slice(0, 4).length > 1 ? 's' : ''} listed below` : ''}. Nothing was submitted. Check the new figures and confirm again.`;
}

/**
 * What an order keeps from its confirmation. `shown` is the leg as displayed (null when the caller
 * sent no displayed figures), `priced` the same leg as priced at the moment of confirmation.
 */
export function confirmedLeg({ shown, priced, tol, snapshotAt, confirmedAt, permitted, feeSchedule = null }) {
  const src = shown || priced;
  const pick = (l) => (l ? { price: l.price, priceModel: l.priceModel, qty: l.qty, cash: l.cash, otherCash: l.otherCash, fees: l.fees, accrued: l.accrued, notional: l.notional, margin: l.margin, collateral: l.collateral, agreement: l.agreement || null, financing: l.financing, borrow: l.borrow, settleDate: l.settleDate, quote: l.quote } : null);
  return {
    basis: shown ? 'displayed' : 'priced-at-confirmation',
    snapshotAt: shown ? snapshotAt : null, confirmedAt, ccy: src.ccy,
    ...pick(src),
    atConfirmation: shown ? pick(priced) : null,
    // Differences between what was displayed and the pricing at confirmation that the tolerances allowed.
    permitted: (permitted || []).map((c) => ({ field: c.field, fieldLabel: c.fieldLabel, was: c.was, now: c.now, changePct: c.changePct, tolerancePct: c.tolerancePct, unit: c.unit, ccy: c.ccy })),
    tolerances: { legPricePct: tol.legPricePct, legAmountPct: tol.legAmountPct },
    // The Book's fee schedule for this product as it stood at confirmation. The confirmed fee is this schedule
    // applied to the whole order; a partial fill is expected to carry its share by the same order-level rule.
    feeSchedule: feeSchedule ? { perUnit: feeSchedule.perUnit || 0, bps: feeSchedule.bps || 0, minimum: feeSchedule.minimum || 0 } : null,
  };
}

/**
 * Reconcile one fill with what was confirmed for its order.
 *   confirmed: order.data.confirmed (or undefined for an order the engine created itself)
 *   actual: { qty, price, cash, fees, expectedFees, accrued, margin, settleDate, model, quoteAsOf, action, ccy }
 * Amounts are compared pro rata for a partial fill, except fees: the fee schedule and its minimum apply to the
 * order, so the fee a fill is expected to carry (`expectedFees`, worked out by orders.js with the same order-level
 * rule on the confirmed price) is not a pro-rata share. Over the fills of an order the expected fees add up to the
 * confirmed fee.
 * Returns null when there is nothing to reconcile against.
 */
export function fillVariance(confirmed, actual, { filledAt = null } = {}) {
  if (!confirmed) return null;
  const ccy = actual.ccy || confirmed.ccy || 'USD';
  const share = confirmed.qty > 0 && actual.qty !== null && actual.qty !== undefined ? actual.qty / confirmed.qty : 1;
  const pro = (x) => (x === null || x === undefined ? null : money(x * share, ccy));
  const expFees = n0(actual.expectedFees) !== null ? money(actual.expectedFees, ccy) : pro(confirmed.fees);
  const exp = { qty: confirmed.qty, share: round(share, 8), price: confirmed.price ?? null, cash: pro(confirmed.cash), fees: expFees, accrued: pro(confirmed.accrued), margin: pro(confirmed.margin), settleDate: confirmed.settleDate || null };
  const act = { qty: actual.qty ?? null, price: n0(actual.price), cash: n0(actual.cash) === null ? null : money(actual.cash, ccy), fees: n0(actual.fees) === null ? null : money(actual.fees, ccy), accrued: n0(actual.accrued) === null ? null : money(actual.accrued, ccy), margin: n0(actual.margin), settleDate: actual.settleDate || null };
  const d = (a, b, dp) => (a === null || b === null ? null : round(b - a, dp));
  const dpm = ccyDecimals(ccy);
  const variance = {
    price: d(exp.price, act.price, 8), pricePct: pctOf(exp.price, act.price),
    cash: d(exp.cash, act.cash, dpm), cashPct: pctOf(exp.cash, act.cash),
    fees: d(exp.fees, act.fees, dpm), accrued: d(exp.accrued, act.accrued, dpm), margin: d(exp.margin, act.margin, dpm),
    settleDate: exp.settleDate && act.settleDate && exp.settleDate !== act.settleDate ? { confirmed: exp.settleDate, actual: act.settleDate } : null,
  };
  const tol = confirmed.tolerances || { legPricePct: 0.5, legAmountPct: 0.5 };
  const none = !variance.price && !variance.cash && !variance.fees && !variance.accrued && !variance.margin && !variance.settleDate;
  const priceOut = exp.price !== null && act.price !== null && moved(exp.price, act.price, tol.legPricePct, 1e-9);
  const cashOut = exp.cash !== null && act.cash !== null && moved(exp.cash, act.cash, tol.legAmountPct, minorUnit(ccy));
  const feesOut = exp.fees !== null && act.fees !== null && moved(exp.fees, act.fees, tol.legAmountPct, minorUnit(ccy));
  const within = !priceOut && !cashOut && !feesOut && !variance.settleDate;
  // ---- the reason, in words ---------------------------------------------------------------------
  const parts = [];
  // A fill more than a second after the confirmation came from a later matching cycle, not from the confirming one.
  const later = Boolean(filledAt && confirmed.confirmedAt && Date.parse(filledAt) - Date.parse(confirmed.confirmedAt) > 1000);
  const asPricedAtConfirmation = !later && confirmed.atConfirmation && n0(confirmed.atConfirmation.price) !== null && act.price !== null && Math.abs(confirmed.atConfirmation.price - act.price) < 1e-9;
  if (none) parts.push(share < 1 - 1e-9 ? `Partial fill of ${round(share * 100, 2)}% of the confirmed quantity, on the confirmed figures pro rata.` : 'Filled on the confirmed figures.');
  else {
    if (exp.price === null && act.price !== null) parts.push('No fill price was displayed at confirmation because the leg had no executable price then; it filled when one became available.');
    else if (variance.price) {
      const side = actual.model === 'quoted-bid-ask' ? (BUY.has(actual.action) ? 'at the ask' : 'at the bid') : actual.model === 'stated-price' ? 'at the stated price' : actual.model === 'manual-mark' ? 'against the manual mark' : 'at the last price with the assumed spread';
      const when = later ? 'on a later matching cycle' : asPricedAtConfirmation ? 'as priced at confirmation, after the price moved between the preview displayed and the confirmation' : 'of a quote that arrived between the preview and the fill';
      parts.push(`Filled ${side} ${actual.model === 'stated-price' ? '' : `${when} `}`.trim() + `${actual.quoteAsOf ? ` (quote of ${actual.quoteAsOf})` : ''}: ${act.price} against ${exp.price} confirmed (${variance.pricePct > 0 ? '+' : ''}${round(variance.pricePct ?? 0, 4)}%).`);
    }
    if (share < 1 - 1e-9) parts.push(`Partial fill of ${round(share * 100, 2)}% of the confirmed quantity; amounts are compared pro rata.`);
    if (variance.fees) parts.push(`Fees differ by ${variance.fees} ${ccy}${variance.price ? ' with the fill price' : ''}.`);
    if (variance.cash && !variance.price) parts.push(`Cash differs by ${variance.cash} ${ccy}.`);
    if (variance.settleDate) parts.push(`Settles ${act.settleDate}, not ${exp.settleDate} as confirmed, because the fill happened on a later trade date.`);
    parts.push(within ? `Within the confirmation tolerances (price ${tol.legPricePct}%, amounts ${tol.legAmountPct}%).`
      : `Outside the confirmation tolerances (price ${tol.legPricePct}%, amounts ${tol.legAmountPct}%): the order had been confirmed as a working order and filled at the market when it became executable.`);
  }
  return { basis: confirmed.basis, confirmed: exp, actual: act, variance, exact: none, within, tolerances: tol, reason: parts.join(' ') };
}
