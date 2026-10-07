// Paper collateral agreements, clearing terms, and the collateral they move.
//
// Collateral on an OTC position (swap, credit default swap, forward, OTC option) follows the terms
// that were explicitly configured for it, and nothing else. Each position states its basis:
//
//   agreement          a paper agreement recorded in the Book (bilateral, CSA-style; or cleared)
//   position           terms entered on the contract itself
//   uncollateralized   an explicit paper assumption: nothing is posted, nothing is received
//
// There is no product default anywhere in this file or in the product plugins: the same swap posts
// under one basis and posts nothing under another, and so does a CDS. A position with no basis on
// record is reported as such; a new one cannot be opened.
//
// What is simulated
//   independent amount   a share of notional, or a fixed amount per position, posted when the
//                        position opens, trued up when its notional changes, returned when it ends
//   variation margin     at each end-of-day pass, from the current mark of the netting set: posted
//                        when the set is out of the money beyond the threshold, received when it is
//                        in the money beyond the threshold; the minimum transfer amount is respected
//   netting scope        per position, per Account, or shared across the listed Accounts
//   collateral currency  one eligible cash currency per agreement, with its haircut
//   release              on reduction, close, maturity and termination
//
// Posted collateral stays the poster's own asset (`cash.margin`). Collateral received is restricted
// cash with a matching liability (`cash.restricted` / `coll.received`): it never reaches `cash`, so
// it is never buying power. Every movement is one balanced ledger event that names the agreement,
// the positions in the netting set, the requirement and the marks used, and it is mirrored in the
// `collateral_movements` register with its allocation to each Account.
//
// Nothing here crosses a Book: an agreement belongs to one Book, covers units of that Book only,
// and netting sets are built Book by Book. Sharing across Accounts exists only where an agreement
// lists those Accounts and names the unit that posts and receives.

import { j, pj } from '../db/db.js';
import { fmt } from './books.js';
import { AppError, CCY_RE, isZero, money, need, newId, num } from './util.js';

export const OTC_FAMILIES = ['swap', 'cds', 'forward', 'otcoption'];

export const AGREEMENT_KINDS = {
  bilateral: 'Bilateral (CSA-style)',
  cleared: 'Cleared',
  uncollateralized: 'Uncollateralized (paper assumption)',
};

/** The kind of an agreement inside a sentence. */
const KIND_INLINE = { bilateral: 'bilateral, CSA-style', cleared: 'cleared', uncollateralized: 'uncollateralized, a paper assumption' };

export const NETTING_SCOPES = {
  position: 'Each position on its own',
  account: 'All positions under the agreement inside one Account',
  shared: 'All positions under the agreement, across its Accounts',
};

/** Terms an agreement can carry on record that the paper engine does not enforce. */
export const RECORDED_ONLY = [
  { key: 'securitiesCollateral', label: 'Securities as eligible collateral', note: 'Only cash is posted and received. Securities listed as eligible stay on the record.' },
  { key: 'rehypothecation', label: 'Rehypothecation of collateral received', note: 'Collateral received is held as restricted cash and is never reused.' },
  { key: 'interestOnCollateral', label: 'Interest on cash collateral', note: 'No interest accrues on collateral posted or received.' },
  { key: 'ratingThresholds', label: 'Rating-based thresholds', note: 'The threshold is the fixed amount on the agreement. It does not move with a credit rating.' },
  { key: 'intradayCalls', label: 'Intraday margin calls', note: 'Calls are made once a day, in the end-of-day pass.' },
  { key: 'disputeResolution', label: 'Dispute handling', note: 'Every call is taken at the mark the Terminal holds. There is no dispute process.' },
  { key: 'rounding', label: 'Rounding of transfer amounts', note: 'Transfers are made to the minor unit of the currency.' },
  { key: 'counterpartyIndependentAmount', label: 'Independent amount posted by the counterparty', note: 'Only the Book\'s own independent amount is posted.' },
  { key: 'closeOut', label: 'Default and close-out provisions', note: 'A counterparty default is not simulated.' },
];

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on';
const pctText = (x) => `${(x * 100).toFixed(2)}%`;

function normalizeIA(raw, errors) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const type = ['pct', 'fixed', 'none'].includes(r.type) ? r.type : r.pct !== undefined && r.pct !== null && r.pct !== '' ? 'pct' : r.amount !== undefined && r.amount !== null && r.amount !== '' ? 'fixed' : 'none';
  if (type === 'pct') {
    const pct = num(r.pct);
    if (pct === null || !(pct > 0 && pct < 1)) { errors.push('The independent amount is a share of notional between 0 and 1 (0.05 = 5%).'); return { type: 'none' }; }
    return { type: 'pct', pct };
  }
  if (type === 'fixed') {
    const amount = num(r.amount);
    if (amount === null || !(amount > 0)) { errors.push('A fixed independent amount must be a positive amount.'); return { type: 'none' }; }
    return { type: 'fixed', amount };
  }
  return { type: 'none' };
}

/**
 * Normalise the collateral basis written on a contract (`terms.collateralBasis`).
 * Returns null when none is stated. Problems are pushed onto `errors`.
 */
export function normalizeBasis(raw, errors = []) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || !raw.type) { errors.push('Choose the collateral basis: an agreement, position-level terms, or uncollateralized.'); return null; }
  if (raw.type === 'uncollateralized') return { type: 'uncollateralized' };
  if (raw.type === 'agreement') {
    if (!raw.agreementId) errors.push('Choose the collateral agreement this contract falls under.');
    return { type: 'agreement', agreementId: String(raw.agreementId || '') };
  }
  if (raw.type === 'position') {
    const threshold = num(raw.threshold) ?? 0, minimumTransfer = num(raw.minimumTransfer) ?? 0;
    if (threshold < 0) errors.push('The threshold cannot be negative.');
    if (minimumTransfer < 0) errors.push('The minimum transfer amount cannot be negative.');
    return { type: 'position', independentAmount: normalizeIA(raw.independentAmount, errors), variationMargin: truthy(raw.variationMargin), threshold: Math.max(0, threshold), minimumTransfer: Math.max(0, minimumTransfer) };
  }
  errors.push('Choose the collateral basis: an agreement, position-level terms, or uncollateralized.');
  return null;
}

/** The basis a contract states: its own `collateralBasis`, or the older `initialMarginPct` field read as position-level terms. */
export function contractBasis(inst) {
  const t = inst?.terms || {};
  if (t.collateralBasis && t.collateralBasis.type) {
    const b = normalizeBasis(t.collateralBasis, []);
    return b ? { ...b, source: 'contract' } : null;
  }
  if (t.initialMarginPct !== null && t.initialMarginPct !== undefined) {
    return { type: 'position', independentAmount: t.initialMarginPct > 0 ? { type: 'pct', pct: t.initialMarginPct } : { type: 'none' }, variationMargin: false, threshold: 0, minimumTransfer: 0, source: 'legacy-field' };
  }
  return null;
}

export function createAgreements(app) {
  const { db, clock, ledger, books, positions, instruments } = app;
  const unitLabel = (u) => (u ? (u.kind === 'treasury' ? 'Treasury' : u.name) : null);
  const unitRef = (id) => { const u = id ? books.getUnit(id) : null; return u ? { id: u.id, name: unitLabel(u), kind: u.kind } : null; };

  // =============================================================================================
  // Agreements as records
  // =============================================================================================

  const parse = (row) => row && {
    ...row, terms: pj(row.terms, {}),
    unitIds: db.all('SELECT unit_id FROM agreement_units WHERE agreement_id = ? ORDER BY rowid', row.id).map((r) => r.unit_id),
  };
  const get = (id) => (id ? parse(db.get('SELECT * FROM agreements WHERE id = ?', id)) : null);
  function requireAgreement(id, bookId) {
    const a = get(id);
    if (!a) throw new AppError('Collateral agreement not found.', { status: 404 });
    if (bookId && a.book_id !== bookId) throw new AppError('That agreement belongs to a different Book.', { status: 400, code: 'other_book' });
    return a;
  }
  const list = (bookId) => db.all('SELECT * FROM agreements WHERE book_id = ? ORDER BY created_at, id', bookId).map(parse);

  function normalizeTerms(kind, raw, book, { postingUnitId }) {
    const errors = [];
    const collateralized = kind !== 'uncollateralized';
    const nonNeg = (v, label) => { const n = num(v) ?? 0; if (n < 0) errors.push(`${label} cannot be negative.`); return Math.max(0, n); };
    const t = {};
    t.baseCcy = String(raw.baseCcy || book.reporting_ccy).toUpperCase();
    if (!CCY_RE.test(t.baseCcy)) errors.push('The base currency is a three-letter currency code.');
    t.nettingScope = collateralized && NETTING_SCOPES[raw.nettingScope] ? raw.nettingScope : 'position';
    if (t.nettingScope === 'shared' && !postingUnitId) errors.push('Netting across Accounts is a shared arrangement: name the Treasury or Account that posts and receives the collateral.');
    t.threshold = collateralized ? nonNeg(raw.threshold, 'The threshold') : 0;
    t.minimumTransfer = collateralized ? nonNeg(raw.minimumTransfer, 'The minimum transfer amount') : 0;
    if (kind === 'cleared' && t.threshold > 0) errors.push('A cleared agreement has no threshold: variation margin is exchanged in full.');
    t.independentAmount = collateralized ? normalizeIA(raw.independentAmount, errors) : { type: 'none' };
    t.variationMargin = collateralized ? truthy(raw.variationMargin) : false;
    const eligible = [];
    for (const e of Array.isArray(raw.eligible) ? raw.eligible : []) {
      if (!e) continue;
      if (e.type === 'securities') {
        const description = String(e.description || '').trim();
        if (description) eligible.push({ type: 'securities', description, haircut: num(e.haircut) });
        continue;
      }
      const ccy = String(e.ccy || '').toUpperCase();
      if (!CCY_RE.test(ccy)) { errors.push('Eligible cash collateral is named by its three-letter currency code.'); continue; }
      const haircut = num(e.haircut) ?? 0;
      if (!(haircut >= 0 && haircut < 1)) errors.push('A haircut is a share between 0 and 1 (0.02 = 2%).');
      if (!eligible.some((x) => x.type === 'cash' && x.ccy === ccy)) eligible.push({ type: 'cash', ccy, haircut });
    }
    t.postingCcy = String(raw.postingCcy || t.baseCcy).toUpperCase();
    if (!CCY_RE.test(t.postingCcy)) errors.push('The collateral currency is a three-letter currency code.');
    // Nothing listed at all: the base currency in cash, at no haircut, is what the agreement accepts.
    if (collateralized && !eligible.some((e) => e.type === 'cash')) eligible.unshift({ type: 'cash', ccy: t.postingCcy, haircut: 0 });
    if (collateralized && !eligible.some((e) => e.type === 'cash' && e.ccy === t.postingCcy)) errors.push(`${t.postingCcy} cash is not on the list of eligible collateral. Add it, or choose a collateral currency that is listed.`);
    t.eligible = collateralized ? eligible : [];
    t.valuation = 'eod';
    t.recorded = {};
    for (const r of RECORDED_ONLY) {
      const v = raw.recorded?.[r.key];
      if (r.key !== 'securitiesCollateral' && v !== undefined && v !== null && String(v).trim() !== '') t.recorded[r.key] = String(v).trim();
    }
    t.notes = raw.notes ? String(raw.notes).trim() : null;
    if (errors.length) throw new AppError(errors[0], { details: { errors } });
    return t;
  }

  function normalizeInput(book, input, existing) {
    const name = String(input.name ?? existing?.name ?? '').trim();
    need(name, 'An agreement needs a name.');
    const counterparty = String(input.counterparty ?? existing?.counterparty ?? '').trim();
    need(counterparty, 'Name the counterparty (for a cleared agreement, the clearing house or clearing broker).');
    const kind = input.kind ?? existing?.kind;
    need(AGREEMENT_KINDS[kind], 'Choose the kind of agreement: bilateral, cleared or uncollateralized.');
    const unitIds = [...new Set((input.unitIds ?? existing?.unitIds ?? []).filter(Boolean))];
    need(unitIds.length, 'List the Treasury or Accounts the agreement covers.');
    for (const id of unitIds) {
      const u = books.getUnit(id);
      need(u, 'A Treasury or Account named on the agreement was not found.', { status: 404 });
      need(u.book_id === book.id, `${u.name} belongs to a different Book. An agreement covers the Treasury and Accounts of its own Book only.`, { code: 'other_book' });
    }
    const postingUnitId = (input.postingUnitId !== undefined ? input.postingUnitId : existing?.posting_unit_id) || null;
    if (postingUnitId) {
      const u = books.getUnit(postingUnitId);
      need(u, 'The posting unit was not found.', { status: 404 });
      need(u.book_id === book.id, 'The unit that posts and receives collateral must be the Treasury or an Account of this Book.', { code: 'other_book' });
      need(kind !== 'uncollateralized', 'An uncollateralized agreement moves no collateral, so it has no posting unit.');
    }
    const terms = normalizeTerms(kind, { ...(existing?.terms || {}), ...(input.terms || {}) }, book, { postingUnitId });
    return { name, counterparty, kind, unitIds, postingUnitId, terms };
  }

  function create(bookId, input = {}) {
    const book = books.requireBook(bookId);
    const v = normalizeInput(book, input);
    need(!db.get('SELECT 1 FROM agreements WHERE book_id = ? AND name = ?', book.id, v.name), `This Book already has an agreement named "${v.name}".`, { status: 409 });
    const id = newId('AGR');
    const now = clock.now().toISOString();
    db.tx(() => {
      db.run('INSERT INTO agreements (id, book_id, name, counterparty, kind, status, posting_unit_id, terms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, book.id, v.name, v.counterparty, v.kind, 'active', v.postingUnitId, j(v.terms), now, now);
      for (const u of v.unitIds) db.run('INSERT INTO agreement_units (agreement_id, unit_id) VALUES (?, ?)', id, u);
      ledger.post({
        bookId: book.id, unitId: books.treasuryOf(book.id).id, type: 'collateral.agreement',
        summary: `Collateral agreement recorded: ${v.name} with ${v.counterparty} (${AGREEMENT_KINDS[v.kind]})`,
        data: { action: 'created', agreementId: id, ...v },
      });
    });
    return get(id);
  }

  /** Open positions that state this agreement as their basis. */
  function positionsUnder(agreementId) {
    return db.all(`SELECT id FROM positions WHERE ABS(qty) > 1e-9 AND json_extract(data, '$.collateralBasis.agreementId') = ?`, agreementId).map((r) => positions.get(r.id));
  }
  // Per netting set: what is posted on one set and what is held on another are both shown, never netted against each other.
  const heldUnder = (agreementId) => db.all('SELECT set_key, kind, holder_unit_id, ccy, SUM(amount) AS s FROM collateral_movements WHERE agreement_id = ? GROUP BY set_key, kind, holder_unit_id, ccy', agreementId)
    .map((r) => ({ ...r, s: money(r.s, r.ccy) })).filter((r) => r.s !== 0);

  function update(id, patch = {}) {
    const cur = requireAgreement(id, patch.bookId);
    need(cur.status === 'active', 'This agreement is closed. Record a new one instead.', { status: 409 });
    const book = books.requireBook(cur.book_id);
    const v = normalizeInput(book, patch, cur);
    const open = positionsUnder(id), held = heldUnder(id);
    if (open.length || held.length) {
      const fixed = [];
      if (v.kind !== cur.kind) fixed.push('the kind of agreement');
      if (v.terms.baseCcy !== cur.terms.baseCcy) fixed.push('the base currency');
      if (v.terms.postingCcy !== cur.terms.postingCcy) fixed.push('the collateral currency');
      if (v.terms.nettingScope !== cur.terms.nettingScope) fixed.push('the netting scope');
      if ((v.postingUnitId || null) !== (cur.posting_unit_id || null)) fixed.push('the posting unit');
      need(!fixed.length, `Positions are open under this agreement, so ${fixed.join(', ')} cannot change. Close them first, or record a new agreement.`, { status: 409, code: 'in_use' });
      const stranded = open.filter((p) => !v.unitIds.includes(p.unit_id));
      need(!stranded.length, `${unitLabel(books.getUnit(stranded[0]?.unit_id))} has open positions under this agreement and cannot be removed from it.`, { status: 409, code: 'in_use' });
    }
    need(!db.get('SELECT 1 FROM agreements WHERE book_id = ? AND name = ? AND id <> ?', book.id, v.name, id), `This Book already has an agreement named "${v.name}".`, { status: 409 });
    db.tx(() => {
      db.run('UPDATE agreements SET name = ?, counterparty = ?, kind = ?, posting_unit_id = ?, terms = ?, updated_at = ? WHERE id = ?', v.name, v.counterparty, v.kind, v.postingUnitId, j(v.terms), clock.now().toISOString(), id);
      db.run('DELETE FROM agreement_units WHERE agreement_id = ?', id);
      for (const u of v.unitIds) db.run('INSERT INTO agreement_units (agreement_id, unit_id) VALUES (?, ?)', id, u);
      ledger.post({
        bookId: book.id, unitId: books.treasuryOf(book.id).id, type: 'collateral.agreement',
        summary: `Collateral agreement changed: ${v.name} with ${v.counterparty}. New terms apply from the next valuation.`,
        data: { action: 'changed', agreementId: id, before: { name: cur.name, counterparty: cur.counterparty, kind: cur.kind, unitIds: cur.unitIds, postingUnitId: cur.posting_unit_id, terms: cur.terms }, after: v },
      });
    });
    return get(id);
  }

  function close(id, { bookId } = {}) {
    const cur = requireAgreement(id, bookId);
    need(cur.status === 'active', 'This agreement is already closed.', { status: 409 });
    const open = positionsUnder(id);
    need(!open.length, `${open.length} open position${open.length > 1 ? 's are' : ' is'} under this agreement. Close ${open.length > 1 ? 'them' : 'it'} before closing the agreement.`, { status: 409, code: 'in_use' });
    need(!heldUnder(id).length, 'Collateral is still posted or held under this agreement. It is released when its positions end.', { status: 409, code: 'in_use' });
    const now = clock.now().toISOString();
    db.tx(() => {
      db.run(`UPDATE agreements SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
      ledger.post({ bookId: cur.book_id, unitId: books.treasuryOf(cur.book_id).id, type: 'collateral.agreement', summary: `Collateral agreement closed: ${cur.name} with ${cur.counterparty}`, data: { action: 'closed', agreementId: id } });
    });
    return get(id);
  }

  // =============================================================================================
  // Terms in force for a position
  // =============================================================================================

  /** The basis on record for a position, else the one its contract states. */
  function basisOf(pos, inst) {
    const b = pos?.data?.collateralBasis;
    if (b && b.type) return b;
    return contractBasis(inst);
  }

  /**
   * The terms that drive collateral for a basis, in one shape whatever their origin.
   * state: 'ok' | 'none' (no basis on record) | 'invalid' (the agreement named cannot be used).
   */
  function effective(basis, inst, unitId) {
    if (!basis) return { state: 'none', basis: null };
    if (basis.type === 'uncollateralized') {
      return { state: 'ok', basis, type: 'uncollateralized', agreement: null, counterparty: inst.terms?.counterparty || null, independentAmount: { type: 'none' }, variationMargin: false, threshold: 0, minimumTransfer: 0, nettingScope: 'position', baseCcy: inst.trading_ccy, postingCcy: inst.trading_ccy, haircut: 0, holderUnitId: unitId };
    }
    if (basis.type === 'position') {
      return { state: 'ok', basis, type: 'position', agreement: null, counterparty: inst.terms?.counterparty || null, independentAmount: basis.independentAmount || { type: 'none' }, variationMargin: Boolean(basis.variationMargin), threshold: basis.threshold || 0, minimumTransfer: basis.minimumTransfer || 0, nettingScope: 'position', baseCcy: inst.trading_ccy, postingCcy: inst.trading_ccy, haircut: 0, holderUnitId: unitId };
    }
    const a = get(basis.agreementId);
    if (!a) return { state: 'invalid', basis, problem: 'The collateral agreement named on this contract does not exist.' };
    // An agreement never reaches a unit of another Book, whatever a contract says.
    const holder = unitId ? books.getUnit(unitId) : null;
    if (holder && holder.book_id !== a.book_id) return { state: 'invalid', basis, problem: `The collateral agreement "${a.name}" belongs to a different Book.` };
    const t = a.terms;
    const cash = (t.eligible || []).find((e) => e.type === 'cash' && e.ccy === t.postingCcy);
    return {
      state: 'ok', basis, type: a.kind === 'uncollateralized' ? 'uncollateralized' : 'agreement', agreement: a, counterparty: a.counterparty,
      independentAmount: t.independentAmount || { type: 'none' }, variationMargin: Boolean(t.variationMargin), threshold: t.threshold || 0, minimumTransfer: t.minimumTransfer || 0,
      nettingScope: t.nettingScope || 'position', baseCcy: t.baseCcy, postingCcy: t.postingCcy || t.baseCcy, haircut: cash?.haircut || 0, holderUnitId: a.posting_unit_id || unitId,
    };
  }

  /** Value in the base currency of one unit of collateral currency, after the haircut. */
  function postingFactor(eff) {
    const fx = app.data.fx(eff.postingCcy, eff.baseCcy);
    if (!fx) return null;
    return { rate: fx.rate, haircut: eff.haircut || 0, factor: fx.rate * (1 - (eff.haircut || 0)), obs: fx.obs || null };
  }

  const notionalOf = (inst, pos, extra = {}) => {
    const plugin = app.products.get(inst.family);
    return plugin.collateralNotional ? plugin.collateralNotional(app, inst, { pos, qtyAfter: pos?.qty ?? 0, dq: 0, price: null, ...extra }) : null;
  };

  /** Independent amount required for a notional, in the collateral currency. amount is null when it cannot be worked out. */
  function iaRequired(eff, inst, notional) {
    const ia = eff.independentAmount;
    const ccy = eff.postingCcy;
    if (!ia || ia.type === 'none' || notional === 0) return { amount: 0, ccy, base: 0 };
    if (notional === null || notional === undefined || !(notional > 0)) return { amount: null, ccy, reason: 'the notional of the position is not known' };
    let base;
    let fxNotional = 1;
    if (ia.type === 'pct') {
      const fx = app.data.fx(inst.trading_ccy, eff.baseCcy);
      if (!fx) return { amount: null, ccy, reason: `no ${inst.trading_ccy}/${eff.baseCcy} conversion rate is available` };
      fxNotional = fx.rate;
      base = ia.pct * notional * fx.rate;
    } else base = ia.amount;
    const pf = postingFactor(eff);
    if (!pf) return { amount: null, ccy, reason: `no ${eff.postingCcy}/${eff.baseCcy} conversion rate is available for the collateral currency` };
    return { amount: money(base / pf.factor, ccy), ccy, base: money(base, eff.baseCcy), notional, fxNotional, fxPosting: pf.rate, haircut: pf.haircut };
  }

  const iaText = (ia, ccy) => (ia?.type === 'pct' ? `Independent amount of ${pctText(ia.pct)} of notional` : ia?.type === 'fixed' ? `Independent amount of ${fmt(ia.amount, ccy)} for each position` : 'No independent amount');
  /** One sentence stating the terms in force. */
  function termsSentence(eff) {
    if (eff.type === 'uncollateralized') return 'nothing is posted and nothing is received';
    const parts = [`${iaText(eff.independentAmount, eff.baseCcy)}${eff.independentAmount?.type !== 'none' ? ', posted in cash when the position opens and returned when it ends' : ''}`];
    if (eff.variationMargin) {
      parts.push(`variation margin each end of day against the mark, threshold ${fmt(eff.threshold, eff.baseCcy)}, minimum transfer ${fmt(eff.minimumTransfer, eff.baseCcy)}`);
      parts.push(eff.nettingScope === 'position' ? 'each position is its own netting set' : eff.nettingScope === 'account' ? 'positions net inside each Account' : 'positions net across the Accounts of the agreement');
    } else parts.push('no variation margin');
    if (eff.agreement) parts.push(`collateral in ${eff.postingCcy} cash${eff.haircut ? ` at a ${pctText(eff.haircut)} haircut` : ''}`);
    if (eff.agreement?.posting_unit_id) parts.push(`posted and received by ${unitLabel(books.getUnit(eff.agreement.posting_unit_id))}`);
    return parts.join('; ');
  }

  /** The "Collateral terms" rows a contract shows wherever its details are listed. */
  function describeRows(inst) {
    const t = inst.terms || {};
    const basis = contractBasis(inst);
    const rows = [];
    if (!basis) rows.push(['Collateral terms', 'None stated. A new position cannot be opened until a collateral basis is chosen.']);
    else {
      const eff = effective(basis, inst, null);
      if (eff.state === 'invalid') rows.push(['Collateral terms', `Agreement ${basis.agreementId}: not found`]);
      else if (basis.type === 'agreement') rows.push(['Collateral terms', `Agreement "${eff.agreement.name}" with ${eff.agreement.counterparty} (${KIND_INLINE[eff.agreement.kind]}${eff.agreement.status === 'closed' ? '; closed' : ''}): ${termsSentence(eff)}.`]);
      else if (basis.type === 'position') rows.push(['Collateral terms', `Position-level terms. ${cap(termsSentence(eff))}.`]);
      else rows.push(['Collateral terms', 'Uncollateralized (paper assumption): nothing is posted and nothing is received.']);
    }
    if (t.collateral && typeof t.collateral === 'string') rows.push(['Other collateral terms', `${t.collateral} (recorded, not simulated)`]);
    return rows;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /** What a basis is called on a screen. */
  function basisLabel(eff) {
    if (eff.state === 'none') return 'No collateral terms recorded (treated as uncollateralized)';
    if (eff.state === 'invalid') return 'Agreement cannot be used (treated as uncollateralized)';
    if (eff.basis.type === 'agreement') return `${eff.agreement.name} (${KIND_INLINE[eff.agreement.kind]})`;
    if (eff.basis.type === 'position') return 'Position-level terms';
    return 'Uncollateralized (paper assumption)';
  }

  // =============================================================================================
  // The requirement of a trade (preview and execution)
  // =============================================================================================

  /**
   * Collateral consequences of trading `qty` of an OTC contract in a unit.
   * Returns the basis that applies, the independent amount before and after, who posts it and in
   * which currency, and checks (errors block the preview and the fill).
   *   initialMargin   the part the trading unit itself posts in the contract's currency (so the
   *                   package's cash table can carry it); 0 when another unit or currency posts
   *   external        { unitId, ccy, amount } when the posting unit or currency differs
   */
  function tradeRequirement({ book, unit, inst, action, qty, price, strategyId, cashOut = 0 }) {
    const out = { applicable: OTC_FAMILIES.includes(inst.family), initialMargin: 0, external: null, checks: [], notes: [], basis: null, independent: null, variation: null, blocking: null };
    if (!out.applicable || !unit) return out;
    const bookId = book?.id || unit.book_id;
    const pos = inst.draft ? null : positions.find(unit.id, inst.id, strategyId || '');
    const before = pos?.qty || 0;
    const dq = (action === 'buy' ? 1 : -1) * qty;
    const after = before + dq;
    const opening = Math.abs(after) > Math.abs(before) + 1e-9 || (before !== 0 && Math.sign(after) !== Math.sign(before) && !isZero(after));
    const label = inst.symbol || inst.name;
    const block = (code, message) => { out.checks.push({ level: 'error', code, message }); if (!out.blocking) out.blocking = message; };
    const basis = basisOf(pos, inst);
    const named = basis?.type === 'agreement' ? get(basis.agreementId) : null;
    if (named && named.book_id !== bookId) {
      out.basis = { type: 'agreement', label: 'Agreement of another Book', agreementId: named.id, source: basis.source || null, flagged: true };
      block('collateral-other-book', `${label} names the agreement "${named.name}", which belongs to a different Book. Collateral never crosses Books: choose an agreement of this Book.`);
      return out;
    }
    const eff = effective(basis, inst, unit.id);
    out.basis = { type: basis?.type || 'none', label: basisLabel(eff), agreementId: basis?.agreementId || null, source: basis?.source || null, flagged: eff.state !== 'ok' };

    if (eff.state === 'none') {
      if (opening) block('collateral-basis', `${label} states no collateral terms. Choose a collateral agreement, enter position-level terms, or choose "Uncollateralized (paper assumption)" on the contract. Nothing is assumed for you.`);
      else out.checks.push({ level: 'warning', code: 'collateral-none', message: `${label} has no collateral terms recorded. It is treated as uncollateralized: nothing is posted and nothing is received.` });
      return out;
    }
    if (eff.state === 'invalid') {
      if (opening) block('collateral-basis', `${label}: ${eff.problem} Choose an agreement of this Book, position-level terms, or "Uncollateralized (paper assumption)".`);
      return out;
    }
    const a = eff.agreement;
    if (a) {
      if (opening && a.status !== 'active') block('collateral-closed', `The agreement "${a.name}" is closed, so no new position can be opened under it.`);
      if (opening && !a.unitIds.includes(unit.id)) block('collateral-not-covered', `The agreement "${a.name}" does not cover ${unitLabel(unit)}. Add ${unitLabel(unit)} to the agreement, or choose another basis.`);
    }
    // The full terms are in the contract's "Collateral terms" row; the note names the basis and what it does to this trade.
    out.notes.push(`Collateral basis: ${a ? `agreement "${a.name}" with ${a.counterparty} (${KIND_INLINE[a.kind]})` : basis.type === 'position' ? 'position-level terms on this contract' : 'uncollateralized (paper assumption)'}.${eff.type === 'uncollateralized' ? ' Nothing is posted and nothing is received.' : eff.variationMargin ? ' Variation margin is exchanged at each end-of-day pass.' : ' No variation margin.'}`);
    if (eff.type === 'uncollateralized') { out.variation = { on: false }; out.independent = { required: 0, held: 0, delta: 0, ccy: eff.postingCcy, holder: unitRef(eff.holderUnitId) }; return out; }

    // ---- independent amount for the position this trade leaves --------------------------------------
    const plugin = app.products.get(inst.family);
    const notional = isZero(after) ? 0 : plugin.collateralNotional ? plugin.collateralNotional(app, inst, { pos, qtyAfter: after, dq, price }) : null;
    const req = iaRequired(eff, inst, notional);
    const ccy = eff.postingCcy;
    const held = pos ? ledger.positionBalance(pos.id, 'cash.margin', ccy) : 0;
    const holder = books.getUnit(eff.holderUnitId);
    out.variation = { on: eff.variationMargin, threshold: eff.threshold, minimumTransfer: eff.minimumTransfer, baseCcy: eff.baseCcy, nettingScope: eff.nettingScope };
    if (req.amount === null) {
      out.independent = { required: null, held, delta: null, ccy, holder: unitRef(holder.id), reason: req.reason };
      if (opening) block('collateral-unvalued', `The independent amount on ${label} cannot be worked out: ${req.reason}. Nothing is estimated in its place.`);
      return out;
    }
    const delta = money(req.amount - held, ccy);
    out.independent = { required: req.amount, held, delta, ccy, holder: unitRef(holder.id), notional, base: req.base, baseCcy: eff.baseCcy, haircut: req.haircut || 0, external: holder.id !== unit.id };
    const sameBucket = holder.id === unit.id && ccy === inst.trading_ccy;
    if (sameBucket) out.initialMargin = delta;
    else if (delta !== 0) out.external = { unitId: holder.id, unitName: unitLabel(holder), ccy, amount: delta, sameUnit: holder.id === unit.id };
    if (delta > 0) {
      // Posted at once from settled cash that is not already committed.
      const free = money(ledger.cash(holder.id, ccy).availableToWithdraw - (sameBucket ? Math.max(0, cashOut) : 0), ccy);
      out.independent.available = free;
      if (free < delta - 0.004) {
        block('collateral-shortfall', `The independent amount of ${fmt(delta, ccy)} on ${label} cannot be posted: ${unitLabel(holder)} has ${fmt(Math.max(free, 0), ccy)} of settled ${ccy} cash free${holder.id !== unit.id ? ` (it posts for ${unitLabel(unit)} under "${a.name}")` : ''}. Fund it first, or reduce the size.`);
      }
      out.notes.push(`${fmt(delta, ccy)} is posted as the independent amount when this fills${holder.id !== unit.id ? `, by ${unitLabel(holder)}` : ''}.`);
    } else if (delta < 0) out.notes.push(`${fmt(-delta, ccy)} of independent amount is returned when this fills.`);
    return out;
  }

  /**
   * Carry a leg's collateral requirement into a package preview: the basis on the leg row, its
   * checks, and the independent amount where it is not already in the trading unit's cash table
   * (another currency, or a posting unit under a shared arrangement).
   * `calls` adds up what the whole package asks of each posting unit at once.
   */
  function addToPreview(coll, { row, leg, check, bump, calls }) {
    if (!coll || !coll.applicable) return;
    row.collateral = { basis: coll.basis, independent: coll.independent, variation: coll.variation, external: coll.external };
    for (const c of coll.checks) check(c.level, c.code, `Leg ${leg}: ${c.message}`, leg);
    const ia = coll.independent;
    if (!ia || !(ia.delta > 0)) return;
    if (coll.external?.sameUnit) bump(ia.ccy, 'margin', ia.delta);
    const k = `${ia.holder.id}|${ia.ccy}`;
    const before = calls.get(k) || 0;
    calls.set(k, before + ia.delta);
    const free = ledger.cash(ia.holder.id, ia.ccy).availableToWithdraw;
    if (before > 0 && before + ia.delta > free + 0.004 && !coll.checks.some((c) => c.code === 'collateral-shortfall')) {
      check('error', 'collateral-shortfall', `Leg ${leg}: together the legs of this package call for ${fmt(before + ia.delta, ia.ccy)} of independent amount from ${ia.holder.name}, which has ${fmt(Math.max(free, 0), ia.ccy)} of settled ${ia.ccy} cash free.`, leg);
    }
  }

  // =============================================================================================
  // State of a call, and failures
  // =============================================================================================

  const getState = (key) => { const r = db.get('SELECT * FROM collateral_state WHERE key = ?', key); return r ? { ...r, data: pj(r.data, {}) } : null; };
  function setState(key, s) {
    db.run(
      `INSERT INTO collateral_state (key, book_id, agreement_id, kind, holder_unit_id, ccy, status, required, held, pending, reason, as_of, updated_at, data, last_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET agreement_id = excluded.agreement_id, holder_unit_id = excluded.holder_unit_id, ccy = excluded.ccy, status = excluded.status, required = excluded.required,
         held = excluded.held, pending = excluded.pending, reason = excluded.reason, as_of = excluded.as_of, updated_at = excluded.updated_at, data = excluded.data,
         last_event_id = COALESCE(excluded.last_event_id, collateral_state.last_event_id)`,
      key, s.bookId, s.agreementId || null, s.kind, s.holderUnitId || null, s.ccy || null, s.status, s.required ?? null, s.held ?? null, s.pending ?? null, s.reason || null,
      s.asOf || clock.today(), clock.now().toISOString(), j(s.data || {}), s.eventId || null,
    );
  }

  /** A call that could not be met: visible, in the audit trail once, and retried. Never funded silently. */
  function failCall(key, s, message, eventBase) {
    const prev = getState(key);
    const fresh = !prev || prev.status !== 'failed' || Math.abs((prev.pending || 0) - (s.pending || 0)) > 0.004;
    setState(key, { ...s, status: 'failed', reason: message });
    app.alerts.raise({ bookId: s.bookId, unitId: s.holderUnitId, level: 'error', code: 'collateral.call_failed', refType: 'collateral', refId: key, message });
    if (fresh) ledger.post({ ...eventBase, type: 'collateral.call_failed', actor: 'engine', summary: message, data: { ...(s.data || {}), key, pending: s.pending, ccy: s.ccy } });
  }
  function clearFailure(key) {
    app.alerts.resolve({ refType: 'collateral', refId: key, code: 'collateral.call_failed' });
  }
  function flagUnvalued(key, s, message) {
    setState(key, { ...s, status: 'cannot_value', reason: message });
    app.alerts.raise({ bookId: s.bookId, unitId: s.holderUnitId, level: 'warning', code: 'collateral.unvalued', refType: 'collateral', refId: key, message });
  }
  const clearUnvalued = (key) => app.alerts.resolve({ refType: 'collateral', refId: key, code: 'collateral.unvalued' });

  const record = (eventId, m) => db.run(
    'INSERT INTO collateral_movements (event_id, ts, business_date, book_id, agreement_id, set_key, kind, holder_unit_id, allocated_unit_id, position_id, ccy, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    eventId, clock.now().toISOString(), clock.today(), m.bookId, m.agreementId || null, m.setKey, m.kind, m.holderUnitId, m.allocatedUnitId, m.positionId || null, m.ccy, m.amount,
  );

  // =============================================================================================
  // Independent amount
  // =============================================================================================

  /**
   * Bring the independent amount posted for a position to what its terms require now.
   * Posting needs settled, uncommitted cash in the posting unit; without it the call fails visibly.
   */
  function trueUpIndependent(pos, { reason = 'position change' } = {}) {
    const inst = instruments.get(pos.instrument_id);
    if (!inst || !OTC_FAMILIES.includes(inst.family)) return null;
    const key = `IA:${pos.id}`;
    const eff = effective(basisOf(pos, inst), inst, pos.unit_id);
    const closed = isZero(pos.qty);
    // Collateral posted earlier is returned when the position ends, whatever has happened to its terms since.
    const heldRows = db.all(`SELECT unit_id, ccy, SUM(amount) AS s FROM entries WHERE position_id = ? AND account = 'cash.margin' GROUP BY unit_id, ccy`, pos.id).map((r) => ({ ...r, s: money(r.s, r.ccy) })).filter((r) => r.s !== 0);
    if (eff.state !== 'ok') {
      if (closed) for (const h of heldRows) moveIndependent({ pos, inst, eff: null, holderUnitId: h.unit_id, ccy: h.ccy, held: h.s, required: 0, reason });
      return null;
    }
    const ccy = eff.postingCcy, holderUnitId = eff.holderUnitId;
    const base = { bookId: pos.book_id, agreementId: eff.agreement?.id || null, kind: 'independent', holderUnitId, ccy };
    for (const h of heldRows) if (closed && (h.unit_id !== holderUnitId || h.ccy !== ccy)) moveIndependent({ pos, inst, eff, holderUnitId: h.unit_id, ccy: h.ccy, held: h.s, required: 0, reason });
    const held = money(heldRows.filter((h) => h.unit_id === holderUnitId && h.ccy === ccy).reduce((a, h) => a + h.s, 0), ccy);
    const notional = closed ? 0 : notionalOf(inst, pos);
    const req = closed ? { amount: 0, ccy } : iaRequired(eff, inst, notional);
    if (req.amount === null) {
      flagUnvalued(key, { ...base, held, data: { positionId: pos.id, notional } }, `The independent amount on ${inst.symbol || inst.name} cannot be valued: ${req.reason}. Nothing is called until it can be.`);
      return null;
    }
    clearUnvalued(key);
    const delta = money(req.amount - held, ccy);
    const data = { positionId: pos.id, notional, requirement: req.amount, held, basis: eff.basis.type };
    if (delta === 0) {
      if (req.amount !== 0 || getState(key)) setState(key, { ...base, status: closed ? 'closed' : 'ok', required: req.amount, held, pending: 0, data });
      clearFailure(key);
      return null;
    }
    if (delta > 0) {
      const free = ledger.cash(holderUnitId, ccy).availableToWithdraw;
      if (free < delta - 0.004) {
        const holder = books.getUnit(holderUnitId);
        failCall(key, { ...base, required: req.amount, held, pending: delta, data },
          `Independent amount call of ${fmt(delta, ccy)} on ${inst.symbol || inst.name} failed: ${unitLabel(holder)} has ${fmt(Math.max(free, 0), ccy)} of settled ${ccy} cash free. It is retried each cycle. Fund ${unitLabel(holder)} or reduce the position.`,
          { bookId: pos.book_id, unitId: pos.unit_id, instrumentId: inst.id, strategyId: pos.strategy_id });
        return null;
      }
    }
    const eventId = moveIndependent({ pos, inst, eff, holderUnitId, ccy, held, required: req.amount, reason, req });
    setState(key, { ...base, status: closed ? 'closed' : 'ok', required: req.amount, held: req.amount, pending: 0, data: { ...data, held: req.amount }, eventId });
    clearFailure(key);
    return eventId;
  }

  function moveIndependent({ pos, inst, eff, holderUnitId, ccy, held, required, reason, req }) {
    const delta = money(required - held, ccy);
    if (delta === 0) return null;
    const a = eff?.agreement || null;
    const holder = books.getUnit(holderUnitId);
    const ia = eff?.independentAmount;
    const how = required === 0 ? 'the position ended' : ia?.type === 'pct' ? `${pctText(ia.pct)} of ${fmt(req?.notional ?? 0, inst.trading_ccy)} notional` : ia?.type === 'fixed' ? 'fixed amount for the position' : 'terms changed';
    const under = a ? ` under "${a.name}" (${a.counterparty})` : eff?.basis?.type === 'position' ? ' under its position-level terms' : '';
    const eventId = ledger.post({
      bookId: pos.book_id, unitId: pos.unit_id, type: `${inst.family}.collateral`, instrumentId: inst.id, strategyId: pos.strategy_id, positionId: pos.id, actor: 'engine',
      summary: `Collateral ${delta > 0 ? 'posted' : 'returned'} on ${inst.name}${under}: ${fmt(Math.abs(delta), ccy)} (independent amount, ${how}${holder.id !== pos.unit_id ? `; ${delta > 0 ? 'posted' : 'received back'} by ${unitLabel(holder)}` : ''})`,
      data: {
        kind: 'independent', basis: eff?.basis?.type || 'none', agreementId: a?.id || null, agreementName: a?.name || null, counterparty: eff?.counterparty || null,
        setKey: `P:${pos.id}`, positions: [pos.id], requirement: required, held, delta, target: required, notional: req?.notional ?? null, terms: ia || null,
        ccy, haircut: req?.haircut || 0, fxNotional: req?.fxNotional ?? null, fxPosting: req?.fxPosting ?? null, holderUnitId: holder.id, allocations: [{ unitId: pos.unit_id, amount: delta }], reason,
      },
      entries: [
        { unitId: holder.id, account: 'cash.margin', ccy, amount: delta, positionId: pos.id },
        { unitId: holder.id, account: 'cash', ccy, amount: -delta, positionId: pos.id },
      ],
    });
    record(eventId, { bookId: pos.book_id, agreementId: a?.id, setKey: `P:${pos.id}`, kind: 'independent', holderUnitId: holder.id, allocatedUnitId: pos.unit_id, positionId: pos.id, ccy, amount: delta });
    return eventId;
  }

  // =============================================================================================
  // Variation margin
  // =============================================================================================

  const setKeyOf = (pos, eff) => (eff.nettingScope === 'account' && eff.agreement ? `A:${eff.agreement.id}:${pos.unit_id}` : eff.nettingScope === 'shared' && eff.agreement ? `S:${eff.agreement.id}` : `P:${pos.id}`);

  /** Signed variation-margin balances of a netting set: + posted by us, - held from the counterparty. */
  const vmBalances = (key) => db.all(`SELECT holder_unit_id, ccy, SUM(amount) AS s FROM collateral_movements WHERE set_key = ? AND kind = 'variation' GROUP BY holder_unit_id, ccy`, key)
    .map((r) => ({ holderUnitId: r.holder_unit_id, ccy: r.ccy, amount: money(r.s, r.ccy) }));
  const vmBalance = (key, holderUnitId, ccy) => vmBalances(key).find((b) => b.holderUnitId === holderUnitId && b.ccy === ccy)?.amount || 0;

  function openOtcPositions(bookId) {
    return db.all(`SELECT p.id FROM positions p JOIN instruments i ON i.id = p.instrument_id WHERE p.book_id = ? AND ABS(p.qty) > 1e-9 AND i.family IN (${OTC_FAMILIES.map(() => '?').join(',')}) ORDER BY p.opened_at, p.id`, bookId, ...OTC_FAMILIES)
      .map((r) => positions.get(r.id));
  }

  /** The netting sets of one Book that exchange variation margin. Never reads another Book's positions. */
  function buildSets(bookId) {
    const sets = new Map();
    for (const p of openOtcPositions(bookId)) {
      const inst = instruments.get(p.instrument_id);
      const eff = effective(basisOf(p, inst), inst, p.unit_id);
      if (eff.state !== 'ok' || !eff.variationMargin) continue;
      if (eff.agreement && eff.agreement.book_id !== bookId) continue;
      const key = setKeyOf(p, eff);
      if (!sets.has(key)) sets.set(key, { key, bookId, eff, agreement: eff.agreement, holderUnitId: eff.holderUnitId, ccy: eff.postingCcy, positions: [] });
      sets.get(key).positions.push(p);
    }
    return sets;
  }

  /** Mark a netting set. ok=false when any position, or a conversion rate, has no observation. */
  function valueSet(set) {
    const { eff } = set;
    const base = eff.baseCcy;
    const rows = [], missing = [];
    const byUnit = new Map();
    let exposure = 0;
    for (const p of set.positions) {
      const inst = instruments.get(p.instrument_id);
      const v = app.valuation.position(p);
      const obs = v.priceObs;
      const row = { positionId: p.id, unitId: p.unit_id, instrumentId: inst.id, name: inst.symbol || inst.name, qty: p.qty, ccy: inst.trading_ccy, mark: v.price ?? null, mv: v.mv ?? null,
        observation: obs ? { status: obs.status, source: obs.source, asOf: obs.asOf, freshness: obs.freshness || null } : null };
      rows.push(row);
      if (v.mv === null || v.mv === undefined) { missing.push(`${row.name} has no mark`); continue; }
      const fx = app.data.fx(inst.trading_ccy, base);
      if (!fx) { missing.push(`no ${inst.trading_ccy}/${base} rate for ${row.name}`); continue; }
      row.fxToBase = fx.rate;
      row.mvBase = money(v.mv * fx.rate, base);
      exposure += row.mvBase;
      byUnit.set(p.unit_id, (byUnit.get(p.unit_id) || 0) + row.mvBase);
    }
    if (missing.length) return { ok: false, rows, reason: `${missing.join('; ')}` };
    const pf = postingFactor(eff);
    if (!pf) return { ok: false, rows, reason: `no ${eff.postingCcy}/${base} rate for the collateral currency` };
    exposure = money(exposure, base);
    const T = eff.threshold || 0;
    // + : we must have posted this much value. - : we must hold this much from the counterparty.
    const requirementValue = money(exposure > T ? -(exposure - T) : exposure < -T ? -exposure - T : 0, base);
    return { ok: true, rows, exposure, byUnit, requirementValue, factor: pf.factor, fxPosting: pf.rate, haircut: pf.haircut };
  }

  /** Split a set's balance between the Accounts whose positions it collateralises. */
  function allocate(key, ccy, after, weights, fallbackUnitId) {
    const before = new Map(db.all(`SELECT allocated_unit_id AS u, SUM(amount) AS s FROM collateral_movements WHERE set_key = ? AND kind = 'variation' AND ccy = ? GROUP BY allocated_unit_id`, key, ccy).map((r) => [r.u, money(r.s, ccy)]));
    const target = new Map();
    if (after !== 0) {
      const side = after > 0 ? 'post' : 'receive';
      let ws = [...weights].map(([u, w]) => [u, w[side]]).filter(([, w]) => w > 0);
      // Nothing on that side now (a balance kept in place by the minimum transfer amount): keep the earlier shares.
      if (!ws.length) ws = [...before].filter(([, b]) => Math.sign(b) === Math.sign(after)).map(([u, b]) => [u, Math.abs(b)]);
      if (!ws.length) ws = [[fallbackUnitId, 1]];
      const total = ws.reduce((a, [, w]) => a + w, 0);
      let left = after;
      ws.forEach(([u, w], i) => {
        const x = i === ws.length - 1 ? left : money((after * w) / total, ccy);
        target.set(u, x);
        left = money(left - x, ccy);
      });
    }
    return [...new Set([...before.keys(), ...target.keys()])].map((u) => ({ unitId: u, name: unitLabel(books.getUnit(u)), before: before.get(u) || 0, after: target.get(u) || 0, amount: money((target.get(u) || 0) - (before.get(u) || 0), ccy) }));
  }

  /**
   * Move a netting set's variation margin to `target` (signed, collateral currency).
   * The part we post needs settled, uncommitted cash; without it that part fails visibly and
   * nothing of it is posted. Returning what we hold from the counterparty never fails.
   */
  function applyVariation(set, target, valuation, { reason }) {
    const { key, bookId, agreement: a, eff, holderUnitId, ccy } = set;
    const stateKey = `VM:${key}`;
    const B = vmBalance(key, holderUnitId, ccy);
    const want = money(target, ccy);
    const base = { bookId, agreementId: a?.id || null, kind: 'variation', holderUnitId, ccy };
    const holder = books.getUnit(holderUnitId);
    const info = {
      setKey: key, nettingScope: eff?.nettingScope || 'position', basis: eff?.basis?.type || null, positions: valuation?.rows || (set.positions || []).map((p) => ({ positionId: p.id, unitId: p.unit_id, qty: p.qty })),
      exposure: valuation?.exposure ?? null, baseCcy: eff?.baseCcy || ccy, threshold: eff?.threshold ?? null, minimumTransfer: eff?.minimumTransfer ?? null,
      requirementValue: valuation?.requirementValue ?? null, haircut: valuation?.haircut ?? 0, fxPosting: valuation?.fxPosting ?? null, target: want, asOf: clock.today(),
    };
    if (money(want - B, ccy) === 0) {
      setState(stateKey, { ...base, status: want === 0 && !(set.positions || []).length ? 'closed' : 'ok', required: want, held: B, pending: 0, reason: reason || null, data: info });
      clearFailure(stateKey);
      return null;
    }
    const posted = Math.max(B, 0), received = Math.max(-B, 0);
    let dPost = money(Math.max(want, 0) - posted, ccy);
    const dRecv = money(Math.max(-want, 0) - received, ccy);
    let failure = null;
    if (dPost > 0) {
      const free = ledger.cash(holderUnitId, ccy).availableToWithdraw;
      if (free < dPost - 0.004) { failure = { need: dPost, free }; dPost = 0; }
    }
    const after = money(B + dPost - dRecv, ccy);
    let eventId = null;
    if (dPost !== 0 || dRecv !== 0) {
      const weights = new Map();
      for (const [u, e] of valuation?.byUnit || []) weights.set(u, { post: Math.max(0, -e), receive: Math.max(0, e) });
      const allocations = allocate(key, ccy, after, weights, set.positions?.[0]?.unit_id || holderUnitId);
      const moved = money(after - B, ccy);
      const parts = [];
      if (dRecv < 0) parts.push(`${fmt(-dRecv, ccy)} returned to the counterparty`);
      if (dPost < 0) parts.push(`${fmt(-dPost, ccy)} returned to us`);
      if (dPost > 0) parts.push(`${fmt(dPost, ccy)} posted`);
      if (dRecv > 0) parts.push(`${fmt(dRecv, ccy)} received`);
      const n = info.positions.length;
      // The event belongs to the Account whose positions it collateralises; a set shared by several belongs to the posting unit.
      const allocated = [...new Set(allocations.map((x) => x.unitId))];
      const owner = allocated.length === 1 ? allocated[0] : holderUnitId;
      eventId = ledger.post({
        bookId, unitId: owner, type: 'collateral.variation', actor: 'engine',
        instrumentId: key.startsWith('P:') && set.positions?.[0] ? set.positions[0].instrument_id : null,
        summary: `Variation margin${a ? ` under "${a.name}" (${a.counterparty})` : ' under position-level terms'}: ${parts.join(' and ')}. `
          + (valuation ? `Netting set of ${n} position${n > 1 ? 's' : ''} marked at ${fmt(valuation.exposure, eff.baseCcy)}; threshold ${fmt(eff.threshold, eff.baseCcy)}.` : `${cap(reason || 'netting set ended')}.`)
          + (holder.id !== owner ? ` Moved by ${unitLabel(holder)}.` : ''),
        data: {
          kind: 'variation', agreementId: a?.id || null, agreementName: a?.name || null, counterparty: eff?.counterparty || a?.counterparty || null, ...info,
          heldBefore: B, heldAfter: after, delta: moved, posted: { before: posted, after: Math.max(after, 0) }, received: { before: received, after: Math.max(-after, 0) },
          holderUnitId, allocations, reason: reason || null,
          markObservationIds: (set.positions || []).map((p) => { const o = app.data.price(p.instrument_id); return o ? app.data.recordUsed(o) : null; }),
        },
        entries: [
          { unitId: holderUnitId, account: 'cash.margin', ccy, amount: dPost },
          { unitId: holderUnitId, account: 'cash', ccy, amount: -dPost },
          { unitId: holderUnitId, account: 'cash.restricted', ccy, amount: dRecv },
          { unitId: holderUnitId, account: 'coll.received', ccy, amount: -dRecv },
        ],
      });
      for (const al of allocations) if (al.amount !== 0) record(eventId, { bookId, agreementId: a?.id, setKey: key, kind: 'variation', holderUnitId, allocatedUnitId: al.unitId, positionId: key.startsWith('P:') ? key.slice(2) : null, ccy, amount: al.amount });
    }
    if (failure) {
      failCall(stateKey, { ...base, required: want, held: after, pending: failure.need, data: info, eventId },
        `Variation margin call of ${fmt(failure.need, ccy)}${a ? ` under "${a.name}"` : ''} failed: ${unitLabel(holder)} has ${fmt(Math.max(failure.free, 0), ccy)} of settled ${ccy} cash free. It is retried each cycle. Fund ${unitLabel(holder)} or reduce the positions.`,
        { bookId, unitId: holderUnitId });
      return eventId;
    }
    setState(stateKey, { ...base, status: want === 0 && !(set.positions || []).length ? 'closed' : 'ok', required: want, held: after, pending: 0, reason: reason || null, data: info, eventId });
    clearFailure(stateKey);
    return eventId;
  }

  /** Value one netting set and exchange what its terms call for. */
  function runSet(set) {
    const stateKey = `VM:${set.key}`;
    const { eff, holderUnitId, ccy } = set;
    const base = { bookId: set.bookId, agreementId: set.agreement?.id || null, kind: 'variation', holderUnitId, ccy };
    const v = valueSet(set);
    const B = vmBalance(set.key, holderUnitId, ccy);
    if (!v.ok) {
      // No fabricated call: what is already posted or held stays where it is until the set can be marked.
      flagUnvalued(stateKey, { ...base, held: B, data: { setKey: set.key, positions: v.rows, nettingScope: eff.nettingScope, baseCcy: eff.baseCcy, threshold: eff.threshold, minimumTransfer: eff.minimumTransfer } },
        `Variation margin${set.agreement ? ` under "${set.agreement.name}"` : ''} cannot be valued: ${v.reason}. No call is made until every position in the netting set has a mark.`);
      return { key: set.key, status: 'cannot_value' };
    }
    clearUnvalued(stateKey);
    const heldValue = B * v.factor;
    const gap = v.requirementValue - heldValue;
    const mta = eff.minimumTransfer || 0;
    let target, note = null;
    if (Math.abs(gap) < Math.max(mta, 0.005)) {
      target = B;
      if (Math.abs(gap) >= 0.005) note = `A transfer worth ${fmt(Math.abs(gap), eff.baseCcy)} would be due. It is below the minimum transfer amount of ${fmt(mta, eff.baseCcy)}, so nothing moves.`;
    } else target = v.requirementValue === 0 ? 0 : money(v.requirementValue / v.factor, ccy);
    const eventId = applyVariation(set, target, v, { reason: note });
    return { key: set.key, status: getState(stateKey)?.status, eventId };
  }

  /** Return a netting set's variation margin in full (its last position ended, or its terms no longer call for any). */
  function releaseSet(bookId, key, why) {
    let n = 0;
    for (const b of vmBalances(key)) {
      if (b.amount === 0) continue;
      const row = db.get(`SELECT agreement_id FROM collateral_movements WHERE set_key = ? AND kind = 'variation' ORDER BY id DESC LIMIT 1`, key);
      const a = row?.agreement_id ? get(row.agreement_id) : null;
      applyVariation({ key, bookId, agreement: a, eff: a ? { agreement: a, counterparty: a.counterparty, nettingScope: a.terms.nettingScope, baseCcy: a.terms.baseCcy, threshold: a.terms.threshold, minimumTransfer: a.terms.minimumTransfer, basis: { type: 'agreement' } } : { basis: { type: 'position' }, nettingScope: 'position', baseCcy: b.ccy },
        holderUnitId: b.holderUnitId, ccy: b.ccy, positions: [] }, 0, null, { reason: why });
      n++;
    }
    const st = getState(`VM:${key}`);
    if (st && st.status !== 'closed') {
      db.run(`UPDATE collateral_state SET status = 'closed', pending = 0, required = 0, held = 0, updated_at = ? WHERE key = ?`, clock.now().toISOString(), `VM:${key}`);
      clearFailure(`VM:${key}`);
      clearUnvalued(`VM:${key}`);
    }
    return n;
  }

  // =============================================================================================
  // Hooks: position changes, end of day, retries
  // =============================================================================================

  /** Called by the OTC plugins whenever a position's quantity changes. */
  function onPositionChange({ pos: stale }) {
    let pos = positions.get(stale.id);
    if (!pos) return;
    const inst = instruments.get(pos.instrument_id);
    if (!OTC_FAMILIES.includes(inst.family)) return;
    // The basis is fixed on the position when it opens, so later edits elsewhere cannot change it unseen.
    if (!isZero(pos.qty) && !pos.data.collateralBasis) {
      const b = contractBasis(inst);
      if (b) pos = positions.setData(pos, { collateralBasis: { ...b, recordedAt: clock.now().toISOString() } });
    }
    trueUpIndependent(pos, { reason: isZero(pos.qty) ? 'position ended' : 'position changed' });
    if (isZero(pos.qty)) {
      const eff = effective(basisOf(pos, inst), inst, pos.unit_id);
      const key = eff.state === 'ok' ? setKeyOf(pos, eff) : `P:${pos.id}`;
      const others = key.startsWith('P:') ? [] : [...(buildSets(pos.book_id).get(key)?.positions || [])];
      if (!others.length) releaseSet(pos.book_id, key, 'the last position of the netting set ended');
      if (key !== `P:${pos.id}`) releaseSet(pos.book_id, `P:${pos.id}`, 'the position ended');
      app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'collateral.no_terms' });
      clearUnvalued(`IA:${pos.id}`);
      clearFailure(`IA:${pos.id}`);
    }
  }

  /** Currency pairs the valuation converts with (contract currency and collateral currency into each agreement's base currency). */
  function fxNeeds() {
    const pairs = new Set();
    for (const book of books.listBooks()) {
      for (const p of openOtcPositions(book.id)) {
        const inst = instruments.get(p.instrument_id);
        const eff = effective(basisOf(p, inst), inst, p.unit_id);
        if (eff.state !== 'ok' || eff.type === 'uncollateralized') continue;
        if (inst.trading_ccy !== eff.baseCcy) pairs.add(`${inst.trading_ccy}/${eff.baseCcy}`);
        if (eff.postingCcy !== eff.baseCcy) pairs.add(`${eff.postingCcy}/${eff.baseCcy}`);
      }
    }
    return [...pairs];
  }

  /** The end-of-day valuation: independent amounts trued up, variation margin exchanged, Book by Book. */
  function endOfDay(date) {
    const out = { date, independent: 0, variation: 0, failed: 0, unvalued: 0, flagged: 0 };
    for (const book of books.listBooks()) {
      const open = openOtcPositions(book.id);
      for (const p of open) {
        const inst = instruments.get(p.instrument_id);
        const eff = effective(basisOf(p, inst), inst, p.unit_id);
        if (eff.state !== 'ok') {
          out.flagged++;
          app.alerts.raise({ bookId: book.id, unitId: p.unit_id, level: 'warning', code: 'collateral.no_terms', refType: 'position', refId: p.id,
            message: eff.state === 'invalid' ? `${inst.symbol || inst.name} in ${unitLabel(books.getUnit(p.unit_id))}: ${eff.problem} It is treated as uncollateralized.`
              : `${inst.symbol || inst.name} in ${unitLabel(books.getUnit(p.unit_id))} has no collateral terms recorded. It is treated as uncollateralized. Record its basis under Treasury, Collateral.` });
          continue;
        }
        app.alerts.resolve({ refType: 'position', refId: p.id, code: 'collateral.no_terms' });
        try { if (db.tx(() => trueUpIndependent(p, { reason: 'end-of-day valuation' }))) out.independent++; } catch (err) { out.error = err.message; }
      }
      const sets = buildSets(book.id);
      for (const set of sets.values()) {
        try {
          const r = db.tx(() => runSet(set));
          if (r.eventId) out.variation++;
          if (r.status === 'failed') out.failed++;
          if (r.status === 'cannot_value') out.unvalued++;
        } catch (err) { out.error = err.message; }
      }
      // A set that no longer exchanges variation margin (its positions ended, or the term was switched off) gives everything back.
      const live = db.all(`SELECT set_key, SUM(amount) AS s FROM collateral_movements WHERE book_id = ? AND kind = 'variation' GROUP BY set_key, holder_unit_id, ccy HAVING ABS(SUM(amount)) > 0.004`, book.id);
      for (const row of live) if (!sets.has(row.set_key)) db.tx(() => { out.variation += releaseSet(book.id, row.set_key, 'the netting set no longer calls for variation margin'); });
    }
    return out;
  }

  /** Try failed calls again. A call is the difference between what is required and what is held, so a retry can never post twice. */
  function retryFailed(bookId) {
    const rows = bookId ? db.all(`SELECT * FROM collateral_state WHERE status = 'failed' AND book_id = ?`, bookId) : db.all(`SELECT * FROM collateral_state WHERE status = 'failed'`);
    let done = 0;
    for (const r of rows) {
      const st = { ...r, data: pj(r.data, {}) };
      db.tx(() => {
        if (st.kind === 'independent') {
          const pos = positions.get(st.key.slice(3));
          if (pos && trueUpIndependent(pos, { reason: 'retry of a failed call' })) done++;
          return;
        }
        const key = st.key.slice(3);
        const set = buildSets(st.book_id).get(key);
        if (!set) { releaseSet(st.book_id, key, 'the netting set ended'); return; }
        // Same positions as when the call was made: deliver that call. Otherwise wait for the next valuation.
        const then = (st.data.positions || []).map((p) => `${p.positionId}:${p.qty}`).sort().join('|');
        const now = set.positions.map((p) => `${p.id}:${p.qty}`).sort().join('|');
        if (then !== now) return;
        const before = vmBalance(key, set.holderUnitId, set.ccy);
        applyVariation(set, st.required, { rows: st.data.positions, exposure: st.data.exposure, requirementValue: st.data.requirementValue, haircut: st.data.haircut, fxPosting: st.data.fxPosting, byUnit: unitExposure(st.data.positions) }, { reason: 'retry of a failed call' });
        if (vmBalance(key, set.holderUnitId, set.ccy) !== before) done++;
      });
    }
    return done;
  }
  const unitExposure = (rows) => { const m = new Map(); for (const r of rows || []) if (r.mvBase !== undefined && r.mvBase !== null) m.set(r.unitId, (m.get(r.unitId) || 0) + r.mvBase); return m; };

  /** Record the basis of a position that has none (one opened before bases were required). */
  function setPositionBasis(positionId, raw) {
    const pos = positions.get(positionId);
    need(pos, 'Position not found.', { status: 404 });
    const inst = instruments.get(pos.instrument_id);
    need(OTC_FAMILIES.includes(inst.family), 'Collateral terms apply to swaps, credit default swaps, forwards and OTC options.');
    need(!isZero(pos.qty), 'This position is closed.');
    need(!basisOf(pos, inst), 'This position already has its collateral basis on record. It stays as recorded for the life of the position.', { status: 409 });
    const errors = [];
    const b = normalizeBasis(raw, errors);
    need(b && !errors.length, errors[0] || 'Choose the collateral basis: an agreement, position-level terms, or uncollateralized.');
    if (b.type === 'agreement') {
      const a = requireAgreement(b.agreementId, pos.book_id);
      need(a.status === 'active', 'That agreement is closed.');
      need(a.unitIds.includes(pos.unit_id), `The agreement "${a.name}" does not cover ${unitLabel(books.getUnit(pos.unit_id))}.`);
    }
    return db.tx(() => {
      const fresh = positions.setData(pos, { collateralBasis: { ...b, source: 'recorded-later', recordedAt: clock.now().toISOString() } });
      const eff = effective(fresh.data.collateralBasis, inst, pos.unit_id);
      ledger.post({ bookId: pos.book_id, unitId: pos.unit_id, type: 'collateral.basis', instrumentId: inst.id, strategyId: pos.strategy_id, summary: `Collateral basis recorded for ${inst.symbol || inst.name}: ${basisLabel(eff)}`, data: { positionId: pos.id, basis: b } });
      app.alerts.resolve({ refType: 'position', refId: pos.id, code: 'collateral.no_terms' });
      trueUpIndependent(fresh, { reason: 'collateral basis recorded' });
      return positionView(positions.get(pos.id));
    });
  }

  // =============================================================================================
  // Views
  // =============================================================================================

  function termRows(a) {
    const t = a.terms;
    if (a.kind === 'uncollateralized') return [{ label: 'Collateral', value: 'None. Nothing is posted and nothing is received (paper assumption).', simulated: true }];
    const rows = [
      { label: 'Independent amount', value: t.independentAmount.type === 'pct' ? `${pctText(t.independentAmount.pct)} of notional, each position` : t.independentAmount.type === 'fixed' ? `${fmt(t.independentAmount.amount, t.baseCcy)} for each position` : 'None', simulated: true },
      { label: 'Variation margin', value: t.variationMargin ? 'Exchanged each end of day against the mark' : 'Not exchanged', simulated: true },
      { label: 'Threshold', value: fmt(t.threshold, t.baseCcy), simulated: true },
      { label: 'Minimum transfer amount', value: fmt(t.minimumTransfer, t.baseCcy), simulated: true },
      { label: 'Netting scope', value: NETTING_SCOPES[t.nettingScope], simulated: true },
      { label: 'Collateral currency', value: `${t.postingCcy} cash${(t.eligible.find((e) => e.type === 'cash' && e.ccy === t.postingCcy)?.haircut || 0) ? `, valued at a ${pctText(t.eligible.find((e) => e.type === 'cash' && e.ccy === t.postingCcy).haircut)} haircut` : ', no haircut'}`, simulated: true },
      { label: 'Valuation', value: 'Daily, in the end-of-day pass', simulated: true },
    ];
    for (const e of t.eligible) {
      if (e.type === 'cash' && e.ccy !== t.postingCcy) rows.push({ label: `Eligible: ${e.ccy} cash`, value: `Haircut ${pctText(e.haircut || 0)}. Listed as eligible; collateral moves in ${t.postingCcy}.`, simulated: false });
      if (e.type === 'securities') rows.push({ label: 'Eligible: securities', value: `${e.description}${e.haircut !== null && e.haircut !== undefined ? `, haircut ${pctText(e.haircut)}` : ''}`, simulated: false });
    }
    for (const r of RECORDED_ONLY) if (t.recorded?.[r.key]) rows.push({ label: r.label, value: t.recorded[r.key], simulated: false, note: r.note });
    return rows;
  }

  function view(a) {
    if (!a) return null;
    const open = positionsUnder(a.id);
    const held = heldUnder(a.id);
    const sum = (pred) => { const m = new Map(); for (const h of held.filter(pred)) m.set(h.ccy, (m.get(h.ccy) || 0) + Math.abs(h.s)); return [...m].map(([ccy, amount]) => ({ ccy, amount: money(amount, ccy) })); };
    return {
      id: a.id, bookId: a.book_id, name: a.name, counterparty: a.counterparty, kind: a.kind, kindLabel: AGREEMENT_KINDS[a.kind], status: a.status,
      units: a.unitIds.map(unitRef).filter(Boolean), unitIds: a.unitIds, postingUnit: unitRef(a.posting_unit_id), postingUnitId: a.posting_unit_id || null, shared: Boolean(a.posting_unit_id),
      terms: a.terms, termRows: termRows(a), summary: a.kind === 'uncollateralized' ? 'Nothing is posted and nothing is received.' : `${cap(termsSentence(effective({ type: 'agreement', agreementId: a.id }, { trading_ccy: a.terms.baseCcy, terms: {} }, null)))}.`,
      openPositions: open.length, inUse: open.length > 0 || held.length > 0,
      posted: sum((h) => h.s > 0), received: sum((h) => h.s < 0),
      createdAt: a.created_at, updatedAt: a.updated_at, closedAt: a.closed_at,
    };
  }

  /** The latest collateral event of a position or of its netting set, with the part of it allocated to the position's own unit. */
  function lastMovement(pos, setKey) {
    const m = db.get(`SELECT m.*, e.summary FROM collateral_movements m JOIN events e ON e.id = m.event_id WHERE m.position_id = ? OR m.set_key = ? ORDER BY m.id DESC LIMIT 1`, pos.id, setKey);
    if (!m) return null;
    const rows = db.all('SELECT allocated_unit_id AS u, amount FROM collateral_movements WHERE event_id = ?', m.event_id);
    const mine = rows.filter((r) => r.u === pos.unit_id);
    const amount = money((mine.length ? mine : rows).reduce((a, r) => a + r.amount, 0), m.ccy);
    return { eventId: m.event_id, ts: m.ts, businessDate: m.business_date, kind: m.kind, ccy: m.ccy, amount, total: money(rows.reduce((a, r) => a + r.amount, 0), m.ccy), summary: m.summary };
  }

  /** Everything a screen shows about one position's collateral. */
  function positionView(pos, ctx = {}) {
    const inst = instruments.get(pos.instrument_id);
    const eff = effective(basisOf(pos, inst), inst, pos.unit_id);
    const v = app.valuation.position(pos);
    const out = {
      positionId: pos.id, unit: unitRef(pos.unit_id), strategyId: pos.strategy_id || null, instrument: app.valuation.lite(inst), family: inst.family, qty: pos.qty, direction: v.direction, ccy: inst.trading_ccy,
      mark: { price: v.price, mv: v.mv, observation: v.priceObs, missing: v.missing },
      basis: {
        type: eff.state === 'ok' ? eff.basis.type : 'none', label: basisLabel(eff), flagged: eff.state !== 'ok', source: eff.basis?.source || null,
        agreement: eff.agreement ? { id: eff.agreement.id, name: eff.agreement.name, counterparty: eff.agreement.counterparty, kind: eff.agreement.kind, kindLabel: AGREEMENT_KINDS[eff.agreement.kind], status: eff.agreement.status } : null,
        counterparty: eff.counterparty || null, sentence: eff.state === 'ok' ? `${cap(termsSentence(eff))}.` : null, problem: eff.problem || null,
        recordedOnly: [...(inst.terms?.collateral && typeof inst.terms.collateral === 'string' ? [{ label: 'Other collateral terms on the contract', value: inst.terms.collateral }] : []),
          ...(eff.agreement ? termRows(eff.agreement).filter((r) => !r.simulated).map((r) => ({ label: r.label, value: r.value })) : [])],
      },
      independent: null, variation: null, lastMovement: lastMovement(pos, eff.state === 'ok' ? setKeyOf(pos, eff) : `P:${pos.id}`),
    };
    if (eff.state !== 'ok' || eff.type === 'uncollateralized') return out;
    const ccy = eff.postingCcy;
    const st = getState(`IA:${pos.id}`);
    const notional = notionalOf(inst, pos);
    const req = iaRequired(eff, inst, notional);
    out.independent = {
      terms: eff.independentAmount, notional, required: req.amount, held: ledger.positionBalance(pos.id, 'cash.margin', ccy), ccy, holder: unitRef(eff.holderUnitId),
      status: req.amount === null ? 'cannot_value' : st?.status === 'failed' ? 'failed' : 'ok', reason: req.amount === null ? `Cannot be valued: ${req.reason}.` : st?.status === 'failed' ? st.reason : null, pending: st?.status === 'failed' ? st.pending : 0,
    };
    if (eff.variationMargin) {
      const key = setKeyOf(pos, eff);
      const vs = getState(`VM:${key}`);
      const bal = vmBalance(key, eff.holderUnitId, ccy);
      if (!key.startsWith('P:') && !ctx.sets) ctx.sets = buildSets(pos.book_id);
      const members = key.startsWith('P:') ? 1 : (ctx.sets.get(key)?.positions.length || 1);
      out.variation = {
        setKey: key, nettingScope: eff.nettingScope, positionsInSet: members, threshold: eff.threshold, minimumTransfer: eff.minimumTransfer, baseCcy: eff.baseCcy, ccy, holder: unitRef(eff.holderUnitId),
        balance: bal, posted: Math.max(bal, 0), received: Math.max(-bal, 0), exposure: vs?.data?.exposure ?? null, required: vs?.required ?? null, asOf: vs?.as_of || null,
        status: vs?.status || 'not_valued_yet', reason: vs?.reason || (vs ? null : 'Valued at the next end-of-day pass.'), pending: vs?.status === 'failed' ? vs.pending : 0,
      };
    }
    return out;
  }

  /** Agreements, positions, netting sets and recent movements of a scope inside one Book. */
  function bookView(bookId, scope = 'book') {
    const book = books.requireBook(bookId);
    const units = books.scopeUnits(bookId, scope);
    const ids = new Set(units.map((u) => u.id));
    const whole = units.length === books.unitsOf(bookId).length;
    const agreements = list(bookId).filter((a) => whole || a.unitIds.some((u) => ids.has(u)) || ids.has(a.posting_unit_id)).map(view);
    const ctx = {};
    const pos = openOtcPositions(bookId).map((p) => positionView(p, ctx)).filter((p) => ids.has(p.unit.id) || ids.has(p.independent?.holder?.id) || ids.has(p.variation?.holder?.id));
    const sets = db.all(`SELECT * FROM collateral_state WHERE book_id = ? AND kind = 'variation' AND status <> 'closed' ORDER BY key`, bookId).map((r) => {
      const d = pj(r.data, {});
      const a = r.agreement_id ? get(r.agreement_id) : null;
      const bal = vmBalance(r.key.slice(3), r.holder_unit_id, r.ccy);
      const alloc = db.all(`SELECT allocated_unit_id AS u, SUM(amount) AS s FROM collateral_movements WHERE set_key = ? AND kind = 'variation' GROUP BY allocated_unit_id`, r.key.slice(3)).map((x) => ({ unit: unitRef(x.u), amount: money(x.s, r.ccy) })).filter((x) => x.amount !== 0);
      return { key: r.key.slice(3), agreement: a ? { id: a.id, name: a.name, counterparty: a.counterparty } : null, holder: unitRef(r.holder_unit_id), ccy: r.ccy, status: r.status, reason: r.reason, asOf: r.as_of,
        exposure: d.exposure ?? null, baseCcy: d.baseCcy || r.ccy, threshold: d.threshold ?? null, minimumTransfer: d.minimumTransfer ?? null, required: r.required, balance: bal, posted: Math.max(bal, 0), received: Math.max(-bal, 0), pending: r.status === 'failed' ? r.pending : 0,
        nettingScope: d.nettingScope || 'position', positions: d.positions || [], allocations: alloc };
    }).filter((s) => whole || ids.has(s.holder?.id) || s.positions.some((p) => ids.has(p.unitId)));
    const scopeIds = [...ids];
    const q = scopeIds.map(() => '?').join(',');
    const movements = db.all(
      `SELECT m.*, e.summary, e.type FROM collateral_movements m JOIN events e ON e.id = m.event_id WHERE m.book_id = ? AND (m.holder_unit_id IN (${q}) OR m.allocated_unit_id IN (${q})) ORDER BY m.id DESC LIMIT 200`, bookId, ...scopeIds, ...scopeIds,
    ).map((m) => ({ id: m.id, eventId: m.event_id, ts: m.ts, businessDate: m.business_date, kind: m.kind, agreement: m.agreement_id ? (() => { const a = get(m.agreement_id); return a ? { id: a.id, name: a.name } : null; })() : null,
      setKey: m.set_key, holder: unitRef(m.holder_unit_id), allocatedTo: unitRef(m.allocated_unit_id), positionId: m.position_id, ccy: m.ccy, amount: m.amount, summary: m.summary, type: m.type }));
    const failures = db.all(`SELECT * FROM collateral_state WHERE book_id = ? AND status IN ('failed','cannot_value')`, bookId).map((r) => ({ key: r.key, kind: r.kind, status: r.status, reason: r.reason, pending: r.pending, ccy: r.ccy, holder: unitRef(r.holder_unit_id) }))
      .filter((f) => whole || ids.has(f.holder?.id));
    return {
      book: { id: book.id, name: book.name, reportingCcy: book.reporting_ccy }, scope: { units: units.map((u) => ({ id: u.id, name: unitLabel(u), kind: u.kind })), whole },
      agreements, positions: pos, sets, movements, failures, totals: totals(bookId, scopeIds),
      kinds: AGREEMENT_KINDS, nettingScopes: NETTING_SCOPES, recordedOnly: RECORDED_ONLY,
      simulated: ['Counterparty and agreement named on every movement', 'Covered Treasury and Accounts', 'Independent amount: a share of notional or a fixed amount per position', 'Variation margin at each end-of-day pass, with threshold and minimum transfer amount',
        'Netting scope: per position, per Account, or shared across listed Accounts with recorded allocations', 'One eligible cash currency per agreement, with its haircut', 'Release on reduction, close, maturity and termination'],
      futuresNote: 'Listed futures and options are cleared products: their margin follows the clearing terms kept with the Book\'s paper-desk assumptions (Settings) and each contract\'s own initial margin, not these agreements.',
    };
  }

  /**
   * OTC collateral by unit and currency, from the register: what each unit has posted (its own
   * asset) and what it holds from counterparties (restricted cash with a matching liability).
   * Each amount belongs to exactly one unit: the one whose ledger moved.
   */
  function totals(bookId, unitIds) {
    const ids = unitIds || books.unitsOf(bookId).map((u) => u.id);
    if (!ids.length) return { posted: [], received: [], allocatedByOthers: [] };
    const q = ids.map(() => '?').join(',');
    const posted = new Map(), received = new Map();
    const bump = (m, unitId, ccy, x) => { const k = `${unitId}|${ccy}`; m.set(k, (m.get(k) || 0) + x); };
    for (const r of db.all(`SELECT kind, set_key, holder_unit_id AS u, ccy, SUM(amount) AS s FROM collateral_movements WHERE book_id = ? AND holder_unit_id IN (${q}) GROUP BY kind, set_key, holder_unit_id, ccy`, bookId, ...ids)) {
      const s = money(r.s, r.ccy);
      if (s > 0) bump(posted, r.u, r.ccy, s); else if (s < 0) bump(received, r.u, r.ccy, -s);
    }
    const rows = (m) => [...m].map(([k, amount]) => { const [unitId, ccy] = k.split('|'); return { unit: unitRef(unitId), ccy, amount: money(amount, ccy) }; });
    // Amounts another unit posts or holds on behalf of these units (a shared arrangement): a memorandum, not their balance.
    const memo = db.all(`SELECT set_key, kind, holder_unit_id AS h, allocated_unit_id AS u, ccy, SUM(amount) AS s FROM collateral_movements WHERE book_id = ? AND allocated_unit_id IN (${q}) AND holder_unit_id <> allocated_unit_id GROUP BY set_key, kind, holder_unit_id, allocated_unit_id, ccy`, bookId, ...ids)
      .map((r) => ({ setKey: r.set_key, kind: r.kind, holder: unitRef(r.h), unit: unitRef(r.u), ccy: r.ccy, amount: money(r.s, r.ccy) })).filter((r) => r.amount !== 0);
    return { posted: rows(posted), received: rows(received), allocatedByOthers: memo };
  }

  /**
   * The register against the ledger: for every collateral event the register rows must add up to
   * what the ledger moved. Returns the events that do not (an empty list when all is well).
   */
  function reconcile(bookId) {
    const bad = [];
    const rows = db.all(`SELECT event_id, SUM(amount) AS s, MIN(ccy) AS ccy FROM collateral_movements WHERE book_id = ? GROUP BY event_id`, bookId);
    for (const r of rows) {
      const led = db.get(`SELECT COALESCE(SUM(CASE WHEN account = 'cash.margin' THEN amount WHEN account = 'cash.restricted' THEN -amount ELSE 0 END), 0) AS s FROM entries WHERE event_id = ?`, r.event_id).s;
      if (Math.abs(led - r.s) > 0.005) bad.push({ eventId: r.event_id, register: money(r.s, r.ccy), ledger: money(led, r.ccy) });
    }
    return bad;
  }

  return {
    create, update, close, get, list, view, requireAgreement,
    basisOf, effective, describeRows, tradeRequirement, addToPreview, onPositionChange, endOfDay, retryFailed, setPositionBasis,
    positionView, bookView, totals, reconcile, trueUpIndependent, vmBalances, fxNeeds,
  };
}
