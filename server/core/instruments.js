// Instrument registry.
//
// Instruments are identified by Terminal IDs; a ticker is optional. Each instrument carries its
// product (from the catalog), its family's contract terms, and its market-view assignment. The
// Shaffer MarketData instrument ID, once reference data is connected, is stored in external_ids
// so nothing here has to be re-keyed later.

import { j, pj } from '../db/db.js';
import { FAMILIES, MARKET_VIEWS, getProduct } from './catalog.js';
import { AppError, CCY_RE, need, newId } from './util.js';

const PREFIX = { equity: 'EQ', fund: 'FD', spot: 'SP', crypto: 'CR', manual: 'MN', option: 'OP', otcoption: 'OO', future: 'FU', fx: 'FX', forward: 'FW', bond: 'BD', loan: 'LN', repo: 'RP', secloan: 'SL', swap: 'SW', cds: 'CD' };
const ARRANGEMENT_FAMILIES = new Set(['loan', 'repo', 'secloan']);
const DESCRIPTIVE_FIELDS = new Set(['name', 'symbol', 'tags', 'issuer', 'domicile', 'venue', 'underlyingGeo', 'externalIds', 'marketView']);

export function createInstruments(app) {
  const { db, clock } = app;
  const cache = new Map();

  const parse = (r) => r && {
    ...r,
    tags: pj(r.tags, []),
    terms: pj(r.terms, {}),
    external_ids: pj(r.external_ids, {}),
  };

  function get(id) {
    if (!id) return null;
    let inst = cache.get(id);
    if (!inst) {
      inst = parse(db.get('SELECT * FROM instruments WHERE id = ?', id));
      if (inst) cache.set(id, inst);
    }
    return inst || null;
  }
  function requireInst(id) {
    const i = get(id);
    if (!i) throw new AppError('Instrument not found in the registry.', { status: 404 });
    return i;
  }

  function validate(draft, { existing } = {}) {
    const product = getProduct(draft.productId);
    need(product, 'Choose a product type from the catalog.');
    need(product.family !== 'cash', 'Currency balances are held as ledger cash, not as registry instruments. Use an FX pair to convert between currencies.');
    need(product.support !== 'planned', `${product.name} is not implemented yet and cannot be created.`);
    const plugin = app.products.get(product.family);
    const name = String(draft.name || '').trim();
    need(name, 'An instrument needs a name.');
    const view = MARKET_VIEWS[draft.marketView];
    need(view, 'Assign the instrument to one of the four market views.');
    need(view.cls === product.cls, `${product.name} is a ${product.cls === 'cash' ? 'cash-market' : 'derivative'} product, so it belongs in ${product.cls === 'cash' ? 'US Based or Foreign Based' : 'US Derivatives or Foreign Derivatives'}.`);
    const venueType = draft.venueType === 'otc' ? 'otc' : 'exchange';
    if (venueType === 'exchange' && draft.venueCountry) {
      const isUs = String(draft.venueCountry).toUpperCase() === 'US';
      need((view.geo === 'US') === isUs, `A product listed on a ${isUs ? 'US' : 'non-US'} venue belongs in ${isUs ? 'a US' : 'a Foreign'} market view (listing venue decides, not issuer domicile or currency).`);
    }
    const norm = plugin.normalize(app, {
      terms: draft.terms || {}, multiplier: draft.multiplier ?? existing?.multiplier, underlying_id: draft.underlyingId || null,
      trading_ccy: draft.tradingCcy, settle_ccy: draft.settleCcy,
    });
    const tradingCcy = String(norm.tradingCcy || draft.tradingCcy || '').toUpperCase();
    const settleCcy = String(norm.settleCcy || draft.settleCcy || tradingCcy).toUpperCase();
    const errors = [...norm.errors];
    if (!CCY_RE.test(tradingCcy)) errors.push('Trading currency is required (three-letter code).');
    if (!CCY_RE.test(settleCcy)) errors.push('Settlement currency must be a three-letter code.');
    if (draft.underlyingId && !get(draft.underlyingId)) errors.push('The chosen underlying is not in the registry.');
    if (errors.length) throw new AppError(errors[0], { details: { errors } });
    return { product, plugin, name, view, venueType, terms: norm.terms, multiplier: norm.multiplier ?? 1, tradingCcy, settleCcy };
  }

  function create(draft, { actor = 'user' } = {}) {
    const v = validate(draft);
    const now = clock.now().toISOString();
    const id = draft.id || newId(PREFIX[v.product.family] || 'INS');
    need(!get(id), 'An instrument with that ID already exists.', { status: 409 });
    db.run(
      `INSERT INTO instruments (id, product_id, family, name, symbol, market_view, tags, issuer, domicile, venue, venue_type, underlying_id, underlying_geo, trading_ccy, settle_ccy, multiplier, terms, external_ids, ref_source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      id, v.product.id, v.product.family, v.name, draft.symbol ? String(draft.symbol).trim() : null, v.view.id, j(draft.tags || []), draft.issuer || null, draft.domicile || null,
      draft.venue || null, v.venueType, draft.underlyingId || null, draft.underlyingGeo || null, v.tradingCcy, v.settleCcy, v.multiplier, j(v.terms), j(draft.externalIds || {}),
      draft.refSource || (actor === 'user' ? 'manual' : actor), now, now,
    );
    return get(id);
  }

  /** Validate a contract and return it as an unsaved instrument (used by trade previews). */
  function draft(d, id = 'draft') {
    const v = validate(d);
    return {
      id, draft: true, product_id: v.product.id, family: v.product.family, name: v.name, symbol: d.symbol || null, market_view: v.view.id, tags: d.tags || [],
      issuer: d.issuer || null, domicile: d.domicile || null, venue: d.venue || null, venue_type: v.venueType, underlying_id: d.underlyingId || null,
      underlying_geo: d.underlyingGeo || null, trading_ccy: v.tradingCcy, settle_ccy: v.settleCcy, multiplier: v.multiplier, terms: v.terms, external_ids: d.externalIds || {}, ref_source: 'draft',
    };
  }

  const inUse = (id) => Boolean(db.get('SELECT 1 FROM positions WHERE instrument_id = ? LIMIT 1', id) || db.get('SELECT 1 FROM orders WHERE instrument_id = ? LIMIT 1', id));

  function update(id, patch, { system = false } = {}) {
    const cur = requireInst(id);
    if (system) {
      // Engine updates to contract state (resets, factors). Not validated as a user edit.
      if (patch.terms) db.run('UPDATE instruments SET terms = ?, updated_at = ? WHERE id = ?', j(patch.terms), clock.now().toISOString(), id);
      cache.delete(id);
      return get(id);
    }
    const locked = inUse(id);
    if (locked) {
      const bad = Object.keys(patch).filter((k) => !DESCRIPTIVE_FIELDS.has(k));
      need(!bad.length, 'This instrument has been traded, so its contract terms are locked. Descriptive fields can still be edited; for different terms create a new instrument.');
    }
    const draft = {
      productId: cur.product_id, name: patch.name ?? cur.name, symbol: patch.symbol ?? cur.symbol, marketView: patch.marketView ?? cur.market_view, tags: patch.tags ?? cur.tags,
      issuer: patch.issuer ?? cur.issuer, domicile: patch.domicile ?? cur.domicile, venue: patch.venue ?? cur.venue, venueType: patch.venueType ?? cur.venue_type, venueCountry: patch.venueCountry,
      underlyingId: patch.underlyingId ?? cur.underlying_id, underlyingGeo: patch.underlyingGeo ?? cur.underlying_geo, tradingCcy: patch.tradingCcy ?? cur.trading_ccy,
      settleCcy: patch.settleCcy ?? cur.settle_ccy, multiplier: patch.multiplier ?? cur.multiplier, terms: patch.terms ?? cur.terms, externalIds: { ...cur.external_ids, ...(patch.externalIds || {}) },
    };
    const v = validate(draft, { existing: cur });
    db.run(
      `UPDATE instruments SET name = ?, symbol = ?, market_view = ?, tags = ?, issuer = ?, domicile = ?, venue = ?, venue_type = ?, underlying_id = ?, underlying_geo = ?, trading_ccy = ?, settle_ccy = ?, multiplier = ?, terms = ?, external_ids = ?, updated_at = ? WHERE id = ?`,
      v.name, draft.symbol || null, v.view.id, j(draft.tags || []), draft.issuer || null, draft.domicile || null, draft.venue || null, v.venueType, draft.underlyingId || null,
      draft.underlyingGeo || null, v.tradingCcy, v.settleCcy, v.multiplier, j(locked ? cur.terms : v.terms), j(draft.externalIds), clock.now().toISOString(), id,
    );
    cache.delete(id);
    return get(id);
  }

  function list({ view, family, productId, q, underlyingId, includeArrangements = false, limit = 500 } = {}) {
    const where = [`status = 'active'`];
    const params = [];
    if (view) { where.push('market_view = ?'); params.push(view); }
    if (family) { where.push('family = ?'); params.push(family); }
    if (productId) { where.push('product_id = ?'); params.push(productId); }
    if (underlyingId) { where.push('underlying_id = ?'); params.push(underlyingId); }
    if (!includeArrangements && !family) where.push(`family NOT IN ('loan','repo','secloan')`);
    if (q) {
      where.push('(name LIKE ? OR symbol LIKE ? OR id LIKE ? OR issuer LIKE ?)');
      const like = `%${String(q).replace(/[%_]/g, '')}%`;
      params.push(like, like, like, like);
    }
    params.push(Math.min(Number(limit) || 500, 2000));
    return db.all(`SELECT * FROM instruments WHERE ${where.join(' AND ')} ORDER BY family, COALESCE(symbol, name) LIMIT ?`, ...params).map(parse);
  }

  function findOption({ underlyingId, expiration, strike, right, multiplier, deliverableUnits }) {
    return db.all(`SELECT * FROM instruments WHERE family = 'option' AND underlying_id = ? AND status = 'active'`, underlyingId).map(parse)
      .find((i) => i.terms.expiration === expiration && i.terms.right === right && Math.abs(i.terms.strike - strike) < 1e-9 && i.multiplier === multiplier && i.terms.deliverable.units === (deliverableUnits ?? multiplier)) || null;
  }

  /** Registry fields for a listed-option contract on an underlying. */
  function optionDraft({ underlyingId, expiration, strike, right, multiplier, deliverableUnits, exercise, settlement, tradingCcy, marketView, contractSymbol, productId }) {
    const und = requireInst(underlyingId);
    const view = marketView || (MARKET_VIEWS[und.market_view].geo === 'US' ? 'US_DERIV' : 'FOREIGN_DERIV');
    return {
      productId: productId || (und.family === 'future' ? 'option_on_future' : und.product_id === 'etf' ? 'etf_option' : 'equity_option'),
      name: `${und.symbol || und.name} ${expiration} ${strike} ${right === 'C' ? 'Call' : 'Put'}`,
      symbol: contractSymbol || `${und.symbol || und.id} ${expiration.slice(2).replace(/-/g, '')}${right}${strike}`,
      marketView: view, venue: und.venue, venueType: 'exchange', underlyingId, underlyingGeo: und.domicile, tradingCcy: tradingCcy || und.trading_ccy,
      multiplier, terms: { right, strike, expiration, exercise, settlement, deliverable: { units: deliverableUnits ?? multiplier } },
    };
  }

  /** Find or create the listed-option contract described by these terms. */
  function ensureOption(spec) {
    const existing = findOption(spec);
    if (existing) return existing;
    return create({ ...optionDraft(spec), refSource: spec.refSource }, { actor: spec.refSource || 'user' });
  }

  function support(inst) {
    const product = getProduct(inst.product_id);
    return { level: product?.support || 'manual', note: product?.note || '', productName: product?.name || inst.product_id, group: product?.group || '' };
  }

  /** API shape: registry row plus catalog and family information. */
  function toView(inst) {
    if (!inst) return null;
    const plugin = app.products.get(inst.family);
    const fam = FAMILIES[inst.family] || {};
    const und = inst.underlying_id ? get(inst.underlying_id) : null;
    return {
      id: inst.id, productId: inst.product_id, family: inst.family, familyLabel: fam.label || inst.family, name: inst.name, symbol: inst.symbol,
      marketView: inst.market_view, tags: inst.tags, issuer: inst.issuer, domicile: inst.domicile, venue: inst.venue, venueType: inst.venue_type,
      underlyingId: inst.underlying_id, underlying: und ? { id: und.id, symbol: und.symbol, name: und.name, family: und.family } : null, underlyingGeo: inst.underlying_geo,
      tradingCcy: inst.trading_ccy, settleCcy: inst.settle_ccy, multiplier: inst.multiplier, terms: inst.terms, externalIds: inst.external_ids, refSource: inst.ref_source,
      support: support(inst), qtyLabel: plugin.qtyLabel || fam.qty, priceUnits: plugin.priceUnits ? plugin.priceUnits(inst) : fam.price,
      actions: plugin.actions(inst), actionLabels: plugin.actionLabels || null, kind: plugin.kind, arrangement: ARRANGEMENT_FAMILIES.has(inst.family),
      details: plugin.describe ? plugin.describe(inst, app) : [], qtyStep: plugin.qtyStep ? plugin.qtyStep(inst) : 1, locked: inUse(inst.id),
      createdAt: inst.created_at, updatedAt: inst.updated_at,
    };
  }

  // ---- watchlists ---------------------------------------------------------------------------
  function watchlists(view) {
    let lists = db.all('SELECT * FROM watchlists WHERE market_view = ? ORDER BY position, created_at', view);
    if (!lists.length) {
      createWatchlist({ name: 'Main', marketView: view });
      lists = db.all('SELECT * FROM watchlists WHERE market_view = ? ORDER BY position, created_at', view);
    }
    return lists.map((w) => ({
      id: w.id, name: w.name, marketView: w.market_view,
      items: db.all('SELECT instrument_id FROM watchlist_items WHERE watchlist_id = ? ORDER BY position', w.id).map((r) => r.instrument_id).filter((id) => get(id)),
    }));
  }
  function createWatchlist({ name, marketView }) {
    need(MARKET_VIEWS[marketView], 'Unknown market view.');
    const nm = String(name || '').trim();
    need(nm, 'A watchlist needs a name.');
    const id = newId('WL');
    const pos = db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM watchlists WHERE market_view = ?', marketView).p;
    db.run('INSERT INTO watchlists (id, name, market_view, position, created_at) VALUES (?, ?, ?, ?, ?)', id, nm, marketView, pos, clock.now().toISOString());
    return id;
  }
  function renameWatchlist(id, name) {
    const nm = String(name || '').trim();
    need(nm, 'A watchlist needs a name.');
    db.run('UPDATE watchlists SET name = ? WHERE id = ?', nm, id);
  }
  function deleteWatchlist(id) {
    db.run('DELETE FROM watchlist_items WHERE watchlist_id = ?', id);
    db.run('DELETE FROM watchlists WHERE id = ?', id);
  }
  function addToWatchlist(id, instrumentId) {
    const w = db.get('SELECT * FROM watchlists WHERE id = ?', id);
    need(w, 'Watchlist not found.', { status: 404 });
    const inst = requireInst(instrumentId);
    need(inst.market_view === w.market_view || inst.tags.includes(w.market_view), `${inst.symbol || inst.name} belongs to ${MARKET_VIEWS[inst.market_view].label}. Add a cross-market tag to list it here.`);
    const pos = db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM watchlist_items WHERE watchlist_id = ?', id).p;
    db.run('INSERT OR IGNORE INTO watchlist_items (watchlist_id, instrument_id, position) VALUES (?, ?, ?)', id, instrumentId, pos);
  }
  const removeFromWatchlist = (id, instrumentId) => db.run('DELETE FROM watchlist_items WHERE watchlist_id = ? AND instrument_id = ?', id, instrumentId);

  return { get, require: requireInst, create, draft, update, list, ensureOption, findOption, optionDraft, support, toView, inUse, watchlists, createWatchlist, renameWatchlist, deleteWatchlist, addToWatchlist, removeFromWatchlist, isArrangement: (inst) => ARRANGEMENT_FAMILIES.has(inst.family) };
}
