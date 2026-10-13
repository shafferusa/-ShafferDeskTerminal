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
