import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, PRODUCTS, catalogSummary } from '../../server/core/catalog.js';
import { createProducts } from '../../server/products/index.js';

// The required universe, as listed in the build brief.
const REQUIRED = `common stocks, preferred stocks, ADRs, GDRs, ETFs, ETNs, mutual funds, closed-end funds, REITs, warrants, subscription rights, convertible securities, private equity interests, venture capital interests, hedge fund interests, infrastructure investments, direct real estate, Treasury bills, Treasury notes, Treasury bonds, TIPS, STRIPS, foreign government bills, foreign government bonds, foreign inflation-linked bonds, emerging-market local-currency debt, emerging-market hard-currency debt, agency debt, supranational bonds, municipal bonds, corporate bonds, investment-grade bonds, high-yield bonds, Eurobonds, foreign-market bonds, sovereign sukuk, corporate sukuk, floating-rate notes, zero-coupon bonds, callable bonds, puttable bonds, convertible bonds, exchangeable bonds, perpetual bonds, subordinated debt, contingent convertible bonds, covered bonds, mortgage-backed securities, residential MBS, commercial MBS, agency MBS, non-agency MBS, TBA mortgage contracts, mortgage specified pools, asset-backed securities, CMOs, CLOs, CDOs, credit-linked notes, structured notes, commercial paper, asset-backed commercial paper, certificates of deposit, bankers' acceptances, money-market funds, bank deposits, term deposits, syndicated loans, leveraged loans, revolving credit facilities, private credit, distressed debt, loan participations, currencies, spot FX, cash borrowing and lending, secured loans, unsecured loans, margin loans, securities-backed loans, securities borrowing, securities lending, stock loans, bond loans, short sales, repo, reverse repo, overnight repo, term repo, open repo, bilateral repo, tri-party repo, general-collateral repo, special-collateral repo, buy/sell-backs, sell/buy-backs, securities collateral swaps, physical and spot commodities, precious metals, industrial metals, crude oil, refined petroleum products, natural gas, LNG, coal, electricity, agricultural commodities, livestock, emissions allowances, carbon credits, renewable energy certificates, freight contracts, cryptocurrencies, stablecoins, tokenized assets, equity futures, equity-index futures, government-bond futures, Treasury futures, short-term interest-rate futures, FX futures, commodity futures, volatility futures, dividend futures, cryptocurrency futures, perpetual futures, equity forwards, bond forwards, FX forwards, non-deliverable forwards, commodity forwards, forward-rate agreements, listed options, OTC options, equity calls and puts, ETF options, index options, bond options, interest-rate options, FX options, commodity options, cryptocurrency options, options on futures, swaptions, credit-default swaptions, interest-rate caps, floors, collars, digital options, barrier options, Asian options, lookback options, basket options, spread options, quanto options, compound options, interest-rate swaps, overnight-index swaps, interest-rate basis swaps, cross-currency swaps, cross-currency basis swaps, FX swaps, non-deliverable swaps, zero-coupon inflation swaps, year-on-year inflation swaps, equity swaps, equity-index swaps, equity-basket swaps, equity total-return swaps, bond total-return swaps, loan total-return swaps, index total-return swaps, commodity swaps, commodity basis swaps, commodity-index swaps, energy swaps, electricity swaps, freight swaps, dividend swaps, variance swaps, volatility swaps, correlation swaps, dispersion swaps, single-name credit-default swaps, sovereign credit-default swaps, credit-index swaps, credit-basket swaps, credit-index tranche swaps, loan credit-default swaps, asset-backed credit-default swaps, credit-spread forwards, credit-spread options, recovery swaps, asset swaps, constant-maturity swaps, constant-maturity spread swaps, forward-starting swaps, amortizing swaps, accreting swaps, callable swaps, puttable swaps, quanto swaps, weather derivatives, catastrophe bonds, insurance-linked securities`.split(',').map((s) => s.trim());

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(us|domestic and foreign|and|the|a)\b/g, ' ').replace(/s\b/g, '').replace(/\s+/g, ' ').trim();
const ALIAS = {
  'convertible securitie': 'convertible security (preferred)', 'currencie': 'usd and foreign currency balances', 'spot fx': 'spot fx / currency pair', 'cash borrowing lending': 'cash borrowing and lending (usd or foreign currency)',
  'physical spot commoditie': 'physical / spot commodity', 'floor': 'interest-rate floor', 'collar': 'interest-rate collar', 'equity call put': 'equity call / put', 'mortgage backed securitie': 'mortgage-backed security',
  'asset backed securitie': 'asset-backed security', 'cmo': 'collateralised mortgage obligation (cmo)', 'clo': 'collateralised loan obligation (clo)', 'cdo': 'collateralised debt obligation (cdo)',
  'foreign market bond': 'foreign-market bond (yankee, samurai, bulldog …)', 'contingent convertible bond': 'contingent convertible bond (coco)', 'adr': 'american depositary receipt (adr)', 'gdr': 'global depositary receipt (gdr)',
  'etf': 'exchange-traded fund (etf)', 'etn': 'exchange-traded note (etn)', 'tip': 'us tips', 'strip': 'us treasury strips', 'equity future': 'equity (single-stock) future', 'treasury bill': 'us treasury bill', 'treasury note': 'us treasury note', 'treasury bond': 'us treasury bond',
  'insurance linked securitie': 'insurance-linked security', 'agricultural commoditie': 'agricultural commodity', 'municipal bond': 'municipal bond (domestic and foreign)', 'corporate bond': 'corporate bond (domestic and foreign)', 'common stock': 'common stock (domestic and foreign)',
  'credit default swaption': 'credit-default swaption', 'revolving credit facilitie': 'revolving credit facility', 'cryptocurrencie': 'cryptocurrency', 'mortgage specified pool': 'mortgage specified pool',
};

test('every product in the required universe is in the catalog with a real engine family', () => {
  const names = new Map(PRODUCTS.map((p) => [norm(p.name), p]));
  const products = createProducts();
  const missing = [];
  for (const req of REQUIRED) {
    const key = norm(req);
    const hit = names.get(key) || names.get(norm(ALIAS[key] || '~'));
    if (!hit) { missing.push(req); continue; }
    assert.ok(FAMILIES[hit.family], `${hit.name} has a family`);
    if (hit.family !== 'cash') assert.ok(products.has(hit.family), `${hit.name}: family ${hit.family} has a plugin`);
    assert.ok(['full', 'partial', 'manual'].includes(hit.support), `${hit.name} states an honest support level`);
    if (hit.support !== 'full') assert.ok(hit.note.length > 20, `${hit.name} explains what is not automated`);
  }
  assert.deepEqual(missing, []);
});

test('catalog ids are unique and counts add up', () => {
  const ids = new Set(PRODUCTS.map((p) => p.id));
  assert.equal(ids.size, PRODUCTS.length);
  const c = catalogSummary();
  assert.equal(c.counts.full + c.counts.partial + c.counts.manual + c.counts.planned, c.total);
  assert.ok(c.total >= REQUIRED.length);
});
