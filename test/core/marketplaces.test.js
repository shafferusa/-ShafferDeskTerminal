// Marketplaces: product-family tabs, explicit classification and the routing convention (ui1).
//
// Every catalog product has exactly one product-family tab; the tab matches the product's cash / derivative class;
// derivative products carry an underlying asset class; docs/COVERAGE.md prints the mapping. An instrument's market
// view is decided from explicit metadata (listing venue country, underlying, jurisdiction) and the documented
// convention for global FX, crypto and OTC products, never from its price currency; the basis is stored and shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASSET_CLASSES, ASSET_LISTS, MARKET_TABS, PRODUCTS, TAB_LISTS, assetClassOf, tabOf, tabsFor } from '../../server/core/catalog.js';
import { createApi } from '../../server/api.js';
import { makeApp } from '../helpers.js';

const USD = 'USD';
const swapTerms = (extra = {}) => ({ effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' }, legs: [
  { id: 'A', side: 'pay', type: 'fixed', ccy: USD, rate: 0.04, months: 6, dayCount: '30/360' },
  { id: 'B', side: 'receive', type: 'float', ccy: USD, index: 'SIM-3M', spread: 0, months: 3, dayCount: 'ACT/360' }], ...extra });
let serial = 0;
const irs = (extra = {}) => ({ productId: 'interest_rate_swap', name: `IRS M${++serial}`, venueType: 'otc', tradingCcy: USD, terms: swapTerms(), ...extra });
const stock = (extra) => ({ productId: 'common_stock', name: `Stock M${++serial}`, symbol: `MK${serial}`, venueType: 'exchange', tradingCcy: USD, ...extra });

test('every one of the catalog products has exactly one product-family tab, in a view of its own class', () => {
  assert.equal(PRODUCTS.length, 205, 'the catalog lists 205 products');
  const listed = Object.values(TAB_LISTS).flat();
  const count = new Map();
  for (const id of listed) count.set(id, (count.get(id) || 0) + 1);
  assert.deepEqual(PRODUCTS.filter((p) => !count.has(p.id)).map((p) => p.id), [], 'no product is unmapped');
  assert.deepEqual([...count].filter(([, n]) => n > 1).map(([id]) => id), [], 'no product is in two tabs');
  assert.deepEqual(listed.filter((id) => !PRODUCTS.some((p) => p.id === id)), [], 'the table names only catalog products');
  assert.equal(listed.length, 205);
  const tabIds = new Set(MARKET_TABS.map((t) => t.id));
  assert.deepEqual(Object.keys(TAB_LISTS).filter((t) => !tabIds.has(t)), [], 'every tab in the table is a defined tab');
  for (const p of PRODUCTS) {
    const tab = MARKET_TABS.find((t) => t.id === tabOf(p.id));
    assert.equal(tab.cls, p.cls, `${p.id} (${p.cls}) sits in a ${tab.cls} tab`);
  }
  // The owner's eight cash tabs and six derivative tabs, in order.
  assert.deepEqual(tabsFor('US_CASH').map((t) => t.label), ['Equities', 'Funds and ETFs', 'Bonds and Credit', 'Money Market and Deposits', 'FX and Currencies', 'Commodities', 'Crypto and Digital Assets', 'Alternatives and Other']);
  assert.deepEqual(tabsFor('FOREIGN_DERIV').map((t) => t.label), ['Options', 'Futures', 'Forwards', 'Swaps', 'Credit Derivatives', 'Structured and Other Derivatives']);
});

test('stocks, bonds, funds, FX and crypto each have their own tab (hand-checked placements)', () => {
  const expect = {
    common_stock: 'equities', adr: 'equities', preferred_stock: 'equities', short_sale: 'equities',
    etf: 'funds', etn: 'funds', mutual_fund: 'funds', closed_end_fund: 'funds', hedge_fund: 'funds',
    treasury_note: 'bonds', corporate_bond_ig: 'bonds', municipal_bond: 'bonds', mbs: 'bonds', catastrophe_bond: 'bonds',
    commercial_paper: 'money', money_market_fund: 'money', bank_deposit: 'money', repo: 'money', securities_lending: 'money',
    fx_spot: 'fx', currency: 'fx', crude_oil: 'commodities', carbon_credit: 'commodities', cryptocurrency: 'crypto', stablecoin: 'crypto',
    private_equity: 'alternatives', direct_real_estate: 'alternatives',
    equity_option: 'options', swaption: 'options', interest_rate_cap: 'options', equity_index_future: 'futures', fx_forward: 'forwards', tba_mortgage: 'forwards',
    interest_rate_swap: 'swaps', variance_swap: 'swaps', cds_single_name: 'credit', cds_swaption: 'credit', weather_derivative: 'structured', freight_contract: 'structured',
  };
  for (const [id, tab] of Object.entries(expect)) assert.equal(tabOf(id), tab, id);
});

test('every derivative product has an underlying asset class; generic options take theirs from the underlying', () => {
  const ids = new Set(ASSET_CLASSES.map((a) => a.id));
  const all = Object.values(ASSET_LISTS).flat();
  for (const p of PRODUCTS.filter((x) => x.cls === 'deriv')) assert.equal(all.filter((id) => id === p.id).length, 1, `${p.id} has one asset class`);
  for (const p of PRODUCTS.filter((x) => x.cls === 'cash')) assert.ok(!all.includes(p.id), `${p.id} (cash) has no derivative asset class`);
  for (const k of Object.keys(ASSET_LISTS)) assert.ok(k === 'underlying' || ids.has(k), k);
  assert.equal(assetClassOf('interest_rate_swap', null), 'rates');
  assert.equal(assetClassOf('otc_option', { family: 'equity', product_id: 'common_stock' }), 'equity');
  assert.equal(assetClassOf('otc_option', { family: 'crypto', product_id: 'cryptocurrency' }), 'crypto');
  assert.equal(assetClassOf('option_on_future', { family: 'future', product_id: 'commodity_future' }), 'commodity');
  assert.equal(assetClassOf('barrier_option', null), 'other');
});

test('docs/COVERAGE.md prints the tab of every product (regenerate with npm run coverage)', () => {
  const md = readFileSync(new URL('../../docs/COVERAGE.md', import.meta.url), 'utf8');
  const at = md.indexOf('## Marketplace product-family tabs');
  assert.ok(at >= 0, 'COVERAGE.md has the Marketplace section');
  const section = md.slice(at, md.indexOf('\n## ', at + 5) > 0 ? md.indexOf('\n## ', at + 5) : undefined);
  for (const p of PRODUCTS) {
    const tab = MARKET_TABS.find((t) => t.id === tabOf(p.id));
    const line = section.split('\n').find((l) => l.startsWith(`| ${tab.label} |`));
    assert.ok(line && line.includes(p.name.replace(/\|/g, '\\|')), `${p.name} is printed under ${tab.label}`);
  }
});

test('the demo instruments are placed by venue, jurisdiction or the convention, never by their USD price', () => {
  const { app, inst } = makeApp();
  const v = (sym) => app.instruments.toView(inst[sym]);
  const where = (sym) => [v(sym).marketView, v(sym).classification.tab, v(sym).classification.routing.basis];
  assert.deepEqual(where('ALFA'), ['US_CASH', 'equities', 'listed']);
  assert.deepEqual(where('ECHO'), ['US_CASH', 'equities', 'listed'], 'an ADR of a Swiss issuer listed in the US is US Based');
  assert.deepEqual(where('KAIJ'), ['FOREIGN_CASH', 'equities', 'listed']);
  assert.deepEqual(where('SIM500'), ['US_CASH', 'funds', 'listed']);
  assert.deepEqual(where('SIMGOV31'), ['US_CASH', 'bonds', 'jurisdiction']);
  // Quoted in USD, but a global platform with no US listing: routed by the convention to Foreign Based.
  assert.deepEqual(where('SIMCOIN'), ['FOREIGN_CASH', 'crypto', 'convention']);
  assert.match(v('SIMCOIN').classification.routing.text, /no US listing: routed by convention to Foreign Based/);
  for (const pair of ['EUR/USD', 'GBP/USD', 'USD/JPY']) {
    assert.deepEqual(where(pair), ['FOREIGN_CASH', 'fx', 'convention'], pair);
    assert.deepEqual(v(pair).tags, [], `${pair} carries no cross-market tag: one place only`);
  }
  const fut = app.instruments.list({ family: 'future' })[0];
  assert.equal(app.instruments.toView(fut).classification.routing.basis, 'listed');
  assert.equal(app.instruments.toView(fut).classification.assetClass, 'equity');
});

test('the routing convention: listing country, underlying, jurisdiction, global convention, and set by hand', () => {
  const { app, inst } = makeApp();
  const I = app.instruments;
  const placed = (d) => { const i = I.create(d); return [i.market_view, i.routing_basis]; };
  // A USD-quoted stock listed in Japan is Foreign Based; a JPY-quoted stock listed in the US is US Based.
  assert.deepEqual(placed(stock({ venue: 'TSE', venueCountry: 'JP', tradingCcy: 'USD' })), ['FOREIGN_CASH', 'listed']);
  assert.deepEqual(placed(stock({ venue: 'NYSE', venueCountry: 'US', tradingCcy: 'JPY' })), ['US_CASH', 'listed']);
  // A listed product cannot be moved by hand against its listing venue.
  assert.throws(() => I.create(stock({ venue: 'NYSE', venueCountry: 'US', marketView: 'FOREIGN_CASH' })), /listing venue decides/);
  // Exchange-listed with no venue country: nothing decides it, so the view must be chosen; chosen, it is set by hand.
  assert.throws(() => I.create(stock({})), /no listing-venue country is recorded/);
  assert.deepEqual(placed(stock({ marketView: 'US_CASH' })), ['US_CASH', 'manual']);
  // Crypto quoted in USD with no venue: global, routed by convention to Foreign Based. Listed on a US exchange: US.
  assert.deepEqual(placed({ productId: 'cryptocurrency', name: `Coin M${++serial}`, venueType: 'global', tradingCcy: USD }), ['FOREIGN_CASH', 'convention']);
  assert.deepEqual(placed({ productId: 'cryptocurrency', name: `Coin M${++serial}`, venueType: 'exchange', venue: 'SIM-X', venueCountry: 'US', tradingCcy: USD }), ['US_CASH', 'listed']);
  // An OTC total-return swap on a US-listed stock follows its underlying.
  const trs = I.create({ productId: 'equity_trs', name: `TRS M${++serial}`, venueType: 'otc', tradingCcy: USD, underlyingId: inst.ALFA.id,
    terms: swapTerms({ initialPrices: { A: 200 }, legs: [{ id: 'A', side: 'receive', type: 'return', ccy: USD, months: 3, underlyingId: inst.ALFA.id, passDividends: false }, { id: 'B', side: 'pay', type: 'float', ccy: USD, index: 'SIM-ON', spread: 0.005, months: 3, dayCount: 'ACT/360' }] }) });
  assert.deepEqual([trs.market_view, trs.routing_basis], ['US_DERIV', 'underlying']);
  // A USD interest-rate swap with no jurisdiction stated is global OTC: by convention Foreign Derivatives, not US for being in USD.
  assert.deepEqual(placed(irs()), ['FOREIGN_DERIV', 'convention']);
  // Under US jurisdiction (governing law) it is US Derivatives; placed in US Derivatives explicitly without one, it is set by hand.
  assert.deepEqual(placed(irs({ jurisdiction: 'us' })), ['US_DERIV', 'jurisdiction']);
  assert.deepEqual(placed(irs({ marketView: 'US_DERIV' })), ['US_DERIV', 'manual']);
  assert.throws(() => I.create(irs({ jurisdiction: 'USA' })), /two-letter country code/);
  // A bond issued by a German issuer, traded OTC, with no jurisdiction stated: the issuer's domicile places it.
  const bund = I.create({ productId: 'foreign_gov_bond', name: `Bund M${++serial}`, venueType: 'otc', domicile: 'DE', tradingCcy: 'EUR',
    terms: { couponType: 'fixed', couponRate: 0.025, frequency: 1, maturity: '2034-02-15', issueDate: '2024-02-15', dayCount: 'ACT/ACT', redemption: 100 } });
  assert.deepEqual([bund.market_view, bund.routing_basis], ['FOREIGN_CASH', 'jurisdiction']);
  assert.match(I.toView(bund).classification.routing.text, /Issuer domiciled in DE, not listed/);
});

test('edits: a new listing venue moves a listed product, a view set by hand stays, auto hands it back to the convention', () => {
  const { app } = makeApp();
  const I = app.instruments;
  const s = I.create(stock({ venue: 'NYSE', venueCountry: 'US' }));
  assert.equal(I.update(s.id, { venueCountry: 'GB', venue: 'LSE' }).market_view, 'FOREIGN_CASH', 'relisted in London');
  const swap = I.create(irs());
  const moved = I.update(swap.id, { marketView: 'US_DERIV' });
  assert.deepEqual([moved.market_view, moved.routing_basis], ['US_DERIV', 'manual']);
  assert.equal(I.update(swap.id, { name: 'Renamed swap' }).market_view, 'US_DERIV', 'a rename keeps the view set by hand');
  const back = I.update(swap.id, { routingBasis: 'auto' });
  assert.deepEqual([back.market_view, back.routing_basis], ['FOREIGN_DERIV', 'convention']);
  const jur = I.update(swap.id, { jurisdiction: 'US' });
  assert.deepEqual([jur.market_view, jur.routing_basis], ['US_DERIV', 'jurisdiction']);
  // A row registered before routing bases were stored is read against the convention.
  app.db.run('UPDATE instruments SET routing_basis = NULL WHERE id = ?', s.id);
  app.db.run('UPDATE instruments SET routing_basis = NULL, market_view = ? WHERE id = ?', 'US_DERIV', swap.id);
  const legacy = (id) => { const fresh = app.db.get('SELECT * FROM instruments WHERE id = ?', id); return I.classify({ ...fresh, tags: [], terms: JSON.parse(fresh.terms) }).routing; };
  assert.deepEqual([legacy(s.id).basis, legacy(s.id).stored], ['listed', false]);
  assert.equal(legacy(swap.id).basis, 'jurisdiction', 'US jurisdiction gives US Derivatives: the stored view agrees with it');
});

test('API: marketplace rows carry their tab and routing, a bond its accrued per 100, and a draft can ask what the convention gives', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const call = (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  const rows = (await call('GET', '/api/instruments', {}, { view: 'US_CASH', marketplace: '1' })).items;
  const gov = rows.find((r) => r.symbol === 'SIMGOV31');
  assert.equal(gov.classification.tab, 'bonds');
  // 4.25% semi-annual, ACT/ACT: last coupon 15 Nov 2025, next 15 May 2026 (181 days); 2 Mar 2026 is 107 days in.
  // Accrued per 100 = 4.25 / 2 x 107 / 181 = 227.375 / 181 = 1.2562154...
  assert.ok(Math.abs(gov.market.accruedPer100 - 227.375 / 181) < 1e-6, `accrued ${gov.market.accruedPer100}`);
  assert.equal(rows.find((r) => r.symbol === 'ALFA').market, null, 'no bond facts on a stock');
  assert.ok(!rows.some((r) => r.symbol === 'SIMCOIN' || r.symbol === 'EUR/USD'), 'neither crypto nor FX is listed in US Based');
  const onlyBonds = (await call('GET', '/api/instruments', {}, { view: 'US_CASH', tab: 'bonds' })).items.map((r) => r.symbol).sort();
  assert.deepEqual(onlyBonds, ['SIMCORP29', 'SIMGOV31']);
  const r1 = await call('GET', '/api/instruments/routing', {}, { productId: 'fx_spot', venueType: 'global' });
  assert.deepEqual([r1.view, r1.basis], ['FOREIGN_CASH', 'convention']);
  const r2 = await call('GET', '/api/instruments/routing', {}, { productId: 'equity_option', venueType: 'exchange', underlyingId: inst.KAIJ.id });
  assert.deepEqual([r2.view, r2.basis], ['FOREIGN_DERIV', 'underlying']);
  const r3 = await call('GET', '/api/instruments/routing', {}, { productId: 'common_stock', venueType: 'exchange' });
  assert.equal(r3.view, null);
  assert.match(r3.reason, /venue country/);
  const cat = await call('GET', '/api/catalog');
  assert.equal(cat.products.filter((p) => !p.tab).length, 0, 'the catalog route gives every product its tab');
  assert.equal(cat.marketTabs.length, 14);
});

// ---- item 3 of the Marketplace finish: every product reachable in exactly one place ---------------------------------
import { MARKET_VIEWS, conventionRoute } from '../../server/core/catalog.js';

const FIN = new Set(['loan', 'repo', 'secloan']);
const OTC_FAMILIES = new Set(['swap', 'cds', 'forward', 'otcoption']);

test('all 205 products: a US-listed and a foreign-listed instrument each land in one tab of one view, and the views differ', () => {
  for (const p of PRODUCTS) {
    const tab = tabOf(p.id);
    assert.ok(tab, `${p.id} has a tab`);
    const cls = MARKET_VIEWS[`US_${p.cls === 'cash' ? 'CASH' : 'DERIV'}`].cls;
    assert.equal(MARKET_TABS.find((t) => t.id === tab).cls, cls);
    // Listed on a US venue / a Japanese venue. Financing arrangements are not listed: their stated jurisdiction decides.
    const us = FIN.has(p.family) ? conventionRoute({ product: p, venueType: 'otc', jurisdiction: 'US' }) : conventionRoute({ product: p, venueType: 'exchange', venueCountry: 'US' });
    const fo = FIN.has(p.family) ? conventionRoute({ product: p, venueType: 'otc', jurisdiction: 'GB' }) : conventionRoute({ product: p, venueType: 'exchange', venueCountry: 'JP' });
    const want = p.cls === 'cash' ? ['US_CASH', 'FOREIGN_CASH'] : ['US_DERIV', 'FOREIGN_DERIV'];
    assert.deepEqual([us.view, fo.view], want, `${p.id}: US and foreign listing`);
    assert.equal(us.basis, FIN.has(p.family) ? 'financing' : 'listed', p.id);
    // An OTC product is not listed: its governing law (jurisdiction) places it the same way.
    if (OTC_FAMILIES.has(p.family)) {
      assert.deepEqual([conventionRoute({ product: p, venueType: 'otc', jurisdiction: 'US' }).view, conventionRoute({ product: p, venueType: 'otc', jurisdiction: 'DE' }).view], want, `${p.id}: OTC by jurisdiction`);
    }
  }
});

test('the routing convention for global FX, crypto and OTC products with no US connection: Foreign, whatever the currency', () => {
  for (const p of PRODUCTS.filter((x) => ['fx', 'crypto'].includes(x.family) || OTC_FAMILIES.has(x.family))) {
    for (const venueType of ['global', 'otc']) {
      const r = conventionRoute({ product: p, venueType });
      assert.equal(r.view, p.cls === 'cash' ? 'FOREIGN_CASH' : 'FOREIGN_DERIV', `${p.id} ${venueType}`);
      assert.equal(r.basis, 'convention', `${p.id} ${venueType}`);
    }
  }
  // Financing arrangements follow the security they lend or take as collateral, never their currency.
  const repo = PRODUCTS.find((x) => x.id === 'term_repo');
  assert.equal(conventionRoute({ product: repo, venueType: 'otc', collateral: { market_view: 'US_CASH' } }).view, 'US_CASH');
  assert.equal(conventionRoute({ product: repo, venueType: 'otc', collateral: { market_view: 'FOREIGN_CASH' } }).view, 'FOREIGN_CASH');
  assert.equal(conventionRoute({ product: repo, venueType: 'otc' }).view, 'FOREIGN_CASH', 'no security, no jurisdiction: the convention');
});

// One registered product per tab, each registered twice through the API (US and foreign facts, no market view given),
// and every Marketplace view and tab asked for its rows: each instrument is in exactly one (view, tab), the expected one.
const DRAFTS = {
  equities: (g, n) => ({ productId: 'common_stock', name: `Route stock ${n}`, symbol: `RS${n}`, venueType: 'exchange', venue: g === 'US' ? 'NYSE' : 'TSE', venueCountry: g === 'US' ? 'US' : 'JP', tradingCcy: 'USD' }),
  funds: (g, n) => ({ productId: 'etf', name: `Route ETF ${n}`, symbol: `RE${n}`, venueType: 'exchange', venueCountry: g === 'US' ? 'US' : 'GB', tradingCcy: 'USD' }),
  bonds: (g, n) => ({ productId: 'corporate_bond', name: `Route bond ${n}`, venueType: 'otc', domicile: g === 'US' ? 'US' : 'DE', tradingCcy: 'USD',
    terms: { couponType: 'fixed', couponRate: 0.05, frequency: 2, maturity: '2031-03-01', issueDate: '2024-03-01', dayCount: '30/360', redemption: 100 } }),
  money: (g, n) => ({ productId: 'commercial_paper', name: `Route CP ${n}`, venueType: 'otc', domicile: g === 'US' ? 'US' : 'FR', tradingCcy: 'USD', multiplier: 0.01,
    terms: { couponType: 'zero', maturity: '2026-09-01', issueDate: '2026-03-01', dayCount: 'ACT/360', redemption: 100 } }),
  fx: (g, n) => (g === 'US' ? { productId: 'fx_spot', name: `Route pair ${n}`, venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: { base: 'EUR', quote: 'USD', settleDays: 2 } }
    : { productId: 'fx_spot', name: `Route pair ${n}`, venueType: 'global', tradingCcy: 'USD', terms: { base: 'EUR', quote: 'USD', settleDays: 2 } }),
  commodities: (g, n) => ({ productId: 'crude_oil', name: `Route oil ${n}`, venueType: 'exchange', venueCountry: g === 'US' ? 'US' : 'GB', tradingCcy: 'USD', terms: { quantityUnit: 'barrels', priceUnits: 'USD per barrel' } }),
  crypto: (g, n) => (g === 'US' ? { productId: 'cryptocurrency', name: `Route coin ${n}`, venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD' } : { productId: 'cryptocurrency', name: `Route coin ${n}`, venueType: 'global', tradingCcy: 'USD' }),
  // Terms as server/products/manual.js asks for them (TERMS.commitment, TERMS.weather).
  alternatives: (g, n) => ({ productId: 'private_equity', name: `Route PE ${n}`, venueType: 'otc', jurisdiction: g === 'US' ? 'US' : 'LU', tradingCcy: 'USD', terms: { valuationMaxAgeDays: 90, commitment: 1_000_000 } }),
  options: (g, n, inst) => ({ productId: 'equity_option', name: `Route option ${n}`, venueType: 'exchange', underlyingId: (g === 'US' ? inst.ALFA : inst.KAIJ).id, tradingCcy: g === 'US' ? 'USD' : 'JPY', multiplier: 100,
    terms: { right: 'C', strike: 100 + n, expiration: '2026-06-19', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } }),
  futures: (g, n) => ({ productId: 'equity_index_future', name: `Route future ${n}`, venueType: 'exchange', venueCountry: g === 'US' ? 'US' : 'DE', tradingCcy: 'USD', multiplier: 50, terms: { expiration: '2026-06-19', initialMargin: 12000 } }),
  forwards: (g, n) => ({ productId: 'fx_forward', name: `Route forward ${n}`, venueType: 'otc', jurisdiction: g === 'US' ? 'US' : 'GB', tradingCcy: 'USD',
    terms: { forwardType: 'fx', base: 'EUR', quote: 'USD', valueDate: '2026-06-02', counterparty: 'Dealer B', collateralBasis: { type: 'uncollateralized' } } }),
  swaps: (g, n) => irs({ name: `Route swap ${n}`, jurisdiction: g === 'US' ? 'US' : 'GB' }),
  credit: (g, n) => ({ productId: 'cds_single_name', name: `Route CDS ${n}`, venueType: 'otc', jurisdiction: g === 'US' ? 'US' : 'GB', tradingCcy: 'USD',
    terms: { referenceEntity: 'Acme Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, counterparty: 'Dealer A', collateralBasis: { type: 'uncollateralized' } } }),
  structured: (g, n) => ({ productId: 'weather_derivative', name: `Route weather ${n}`, venueType: 'otc', jurisdiction: g === 'US' ? 'US' : 'GB', tradingCcy: 'USD',
    terms: { valuationMaxAgeDays: 30, station: 'Sim Airport', index: 'HDD', baseTemp: 65, periodStart: '2026-11-01', periodEnd: '2027-03-31', strike: 1000, tick: 5000, cap: 1_000_000, optionType: 'call', side: 'long',
      counterparty: 'Dealer C', collateralBasis: { type: 'uncollateralized' } } }),
};

test('API: one instrument of every tab, registered with US and with foreign facts, is listed in exactly one view and tab', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const call = async (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  assert.deepEqual(Object.keys(DRAFTS).sort(), MARKET_TABS.map((t) => t.id).sort(), 'a draft for every tab');
  const made = [];
  let n = 0;
  for (const [tab, draft] of Object.entries(DRAFTS)) {
    for (const g of ['US', 'FOREIGN']) {
      const d = draft(g, ++n, inst);
      assert.equal(d.marketView, undefined, 'no market view is given: the facts decide');
      const v = await call('POST', '/api/instruments', d);
      const cls = MARKET_TABS.find((t) => t.id === tab).cls;
      made.push({ id: v.id, tab, view: `${g}_${cls === 'cash' ? 'CASH' : 'DERIV'}`, product: d.productId });
    }
  }
  const where = new Map(made.map((m) => [m.id, []]));
  for (const view of Object.keys(MARKET_VIEWS)) {
    for (const t of tabsFor(view)) {
      const rows = (await call('GET', '/api/instruments', {}, { view, tab: t.id, marketplace: '1', limit: '2000' })).items;
      for (const r of rows) if (where.has(r.id)) where.get(r.id).push(`${view}/${t.id}`);
    }
  }
  for (const m of made) assert.deepEqual(where.get(m.id), [`${m.view}/${m.tab}`], `${m.product} (${m.view}) is in exactly one place`);
});

test('registration never infers US from the quote currency: USD-quoted instruments with foreign or no US facts are Foreign', async () => {
  const { app, inst } = makeApp();
  const api = createApi(app);
  const post = (body) => { const m = api.match('POST', '/api/instruments'); return m.handler({ params: m.params, query: {}, body }); };
  const usdForeign = [
    { productId: 'common_stock', name: 'USD line in Tokyo', symbol: 'USDJP1', venueType: 'exchange', venueCountry: 'JP', tradingCcy: 'USD' },
    { productId: 'cryptocurrency', name: 'USD coin, global', venueType: 'global', tradingCcy: 'USD' },
    { productId: 'fx_spot', name: 'EUR/USD global', venueType: 'global', tradingCcy: 'USD', terms: { base: 'EUR', quote: 'USD', settleDays: 2 } },
    irs({ name: 'USD swap, no jurisdiction' }),
    { productId: 'corporate_bond', name: 'USD Eurobond of a German issuer', venueType: 'otc', domicile: 'DE', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 1, maturity: '2030-01-15', issueDate: '2025-01-15', dayCount: '30/360', redemption: 100 } },
    { productId: 'equity_option', name: 'USD-quoted option on KAIJ', venueType: 'exchange', underlyingId: inst.KAIJ.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'P', strike: 90, expiration: '2026-06-19', exercise: 'european', settlement: 'cash', deliverable: { units: 100 } } },
  ];
  for (const d of usdForeign) {
    const v = await post(d);
    assert.ok(v.marketView.startsWith('FOREIGN'), `${d.name}: ${v.marketView} (${v.classification.routing.basis})`);
  }
  // And the converse: a JPY-quoted line on a US venue is US Based.
  assert.equal((await post({ productId: 'common_stock', name: 'JPY line in New York', symbol: 'JPYUS1', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'JPY' })).marketView, 'US_CASH');
});

test('a routing override set by hand is kept, labelled on the row and the instrument page, and listed in its chosen view', async () => {
  const { app } = makeApp();
  const api = createApi(app);
  const call = async (method, path, body = {}, query = {}) => { const m = api.match(method, path); return m.handler({ params: m.params, query, body }); };
  const v = await call('POST', '/api/instruments', irs({ name: 'Swap moved by hand', marketView: 'US_DERIV' }));
  assert.equal(v.marketView, 'US_DERIV');
  assert.equal(v.classification.routing.basis, 'manual');
  assert.equal(v.classification.routing.basisLabel, 'Set by hand');
  assert.equal(v.classification.routing.short, 'Set by hand');
  assert.match(v.classification.routing.text, /^Set by hand \(the convention gives Foreign Derivatives\)/);
  const rows = (await call('GET', '/api/instruments', {}, { view: 'US_DERIV', tab: 'swaps', marketplace: '1' })).items;
  assert.ok(rows.some((r) => r.id === v.id), 'listed in US Derivatives, Swaps');
  assert.ok(!(await call('GET', '/api/instruments', {}, { view: 'FOREIGN_DERIV', tab: 'swaps' })).items.some((r) => r.id === v.id), 'not also in Foreign Derivatives');
});
