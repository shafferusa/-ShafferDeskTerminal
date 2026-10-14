// Plain logic of the equity tabs Overview, Price history and Earnings (web/views/tabs/tabs-model.js): which price
// series is offered, gaps, annotation placement, the basis of the range change, earnings surprise and change against
// the prior value, and the Overview's field list with every missing field named. Expected values worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changeVsPrior, coverageOf, findGaps, placeAnnotations, profileRows, rangePerformance, seriesChoice, splitEarnings, surpriseOf } from '../../web/views/tabs/tabs-model.js';

const bar = (date, close, extra = {}) => ({ date, close, ...extra });
const unEnv = (items) => ({ env: { state: 'available', items, data: { adjusted: false } }, state: 'available' });
const adEnv = (items) => ({ env: { state: 'available', items, data: { adjusted: true } }, state: 'available' });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('series: switchable only when the server supplies both the adjusted and the unadjusted series', () => {
  const items = [bar('2026-01-05', 10), bar('2026-01-06', 11)];
  const both = seriesChoice({ un: unEnv(items), adj: adEnv(items), wanted: 'adjusted' });
  assert.deepEqual([both.show, both.switchable], ['adjusted', true]);
  assert.equal(seriesChoice({ un: unEnv(items), adj: adEnv(items), wanted: 'unadjusted' }).show, 'unadjusted');
  // The fixture's adjusted answer: unavailable, no items, data.available false.
  const noAdj = { env: { state: 'unavailable', items: [], data: { adjusted: true, available: false }, message: 'No adjusted series.' }, state: 'unavailable' };
  const one = seriesChoice({ un: unEnv(items), adj: noAdj, wanted: 'adjusted' });
  assert.deepEqual([one.show, one.switchable], ['unadjusted', false]);
  assert.match(one.why, /no adjusted series/i);
  // An "adjusted" request answered with an unadjusted series is not an adjusted series.
  const mislabelled = { env: { state: 'available', items, data: { adjusted: false } }, state: 'available' };
  assert.equal(seriesChoice({ un: unEnv(items), adj: mislabelled }).switchable, false);
  // Only the adjusted series exists.
  const onlyAdj = seriesChoice({ un: { env: { state: 'unavailable', items: [] }, state: 'unavailable' }, adj: adEnv(items) });
  assert.deepEqual([onlyAdj.show, onlyAdj.switchable], ['adjusted', false]);
  // While the adjusted answer is on its way the switch is not offered yet.
  assert.equal(seriesChoice({ un: unEnv(items), adj: { state: 'loading' } }).switchable, false);
});

test('gaps: stated holes and over-wide spacing are listed, weekends and a holiday Monday are not', () => {
  const bars = [bar('2026-07-09', 1), bar('2026-07-10', 1), /* Fri -> Tue: 4 days, a holiday weekend */ bar('2026-07-14', 1),
    /* 07-15..07-21 missing (stated) */ bar('2026-07-22', 1), bar('2026-07-23', 1), /* 07-23 -> 08-03: 11 days, not stated */ bar('2026-08-03', 1)];
  const g = findGaps(bars, '1d', ['2026-07-15..2026-07-21 (no bars from the source)', 'corporate-action annotations']);
  assert.equal(g.length, 3);
  assert.deepEqual([g[0].from, g[0].to, g[0].days, g[0].stated], ['2026-07-14', '2026-07-22', 8, true]);
  assert.deepEqual([g[1].from, g[1].to, g[1].days, g[1].stated], ['2026-07-23', '2026-08-03', 11, false]);
  // A stated item that is not a date range is kept, unplaced.
  assert.deepEqual([g[2].from, g[2].stated, g[2].label], [null, true, 'corporate-action annotations']);
  // Weekly bars 7 days apart are not a gap; 14 days apart is.
  assert.equal(findGaps([bar('2026-01-02', 1), bar('2026-01-09', 1), bar('2026-01-23', 1)], '1wk').length, 1);
});

test('annotations: placed on their date, on the next bar when that day has no bar, or listed outside the range', () => {
  const bars = [bar('2026-05-06', 1), bar('2026-05-07', 1), bar('2026-05-11', 1), bar('2026-05-12', 1)];
  const placed = placeAnnotations(bars, [
    { date: '2026-05-09', type: 'cash_dividend' }, // a Saturday: next bar is Monday 05-11, index 2
    { date: '2026-05-07', type: 'split', ratio: { num: 2, den: 1 } }, // on its date, index 1
    { date: '2026-04-30', type: 'buyback' }, // before the first bar
    { date: '2026-05-20', type: 'cash_dividend' }, // after the last bar
  ]);
  assert.deepEqual(placed.map((a) => [a.date, a.placement, a.index, a.barDate]), [
    ['2026-04-30', 'before', null, null], ['2026-05-07', 'on', 1, '2026-05-07'], ['2026-05-09', 'next', 2, '2026-05-11'], ['2026-05-20', 'after', null, null]]);
});

test('range change: from the first close to the last close, with its basis; withheld across a split on an unadjusted series', () => {
  const bars = [bar('2026-01-05', 200), bar('2026-01-06', 190), bar('2026-01-07', 210)];
  // (210 / 200 - 1) x 100 = 5
  const p = rangePerformance(bars, { adjusted: false, annotations: [{ date: '2026-01-06', type: 'cash_dividend', amount: 1 }] });
  assert.ok(near(p.value, 5));
  assert.deepEqual([p.from, p.to, p.series, p.priceOnly], [{ date: '2026-01-05', close: 200 }, { date: '2026-01-07', close: 210 }, 'unadjusted', true]);
  const split = rangePerformance(bars, { adjusted: false, annotations: [{ date: '2026-01-06', type: 'split', ratio: { num: 2, den: 1 }, label: 'Split 2:1' }] });
  assert.equal(split.value, null);
  assert.match(split.why, /Split 2:1 on 2026-01-06/);
  // On an adjusted series the split is already in the prices: shown, and not "price only".
  const adj = rangePerformance(bars, { adjusted: true, annotations: [{ date: '2026-01-06', type: 'split' }] });
  assert.ok(near(adj.value, 5));
  assert.equal(adj.priceOnly, false);
  // A split on the first day is not inside the comparison (both closes are after it).
  assert.ok(near(rangePerformance(bars, { adjusted: false, annotations: [{ date: '2026-01-05', type: 'split' }] }).value, 5));
  assert.equal(rangePerformance([bar('2026-01-05', 0), bar('2026-01-06', 1)]).value, null);
  assert.equal(rangePerformance([bar('2026-01-05', 1)]).value, null);
});

test('coverage: a range that starts before the first bar is reported short, by calendar days', () => {
  // 2026-04-17 - 2026-04-14 = 3 days: within weekend spacing, not short
  assert.equal(coverageOf([bar('2026-04-17', 1), bar('2026-10-14', 1)], '2026-04-14', '2026-10-14').short, false);
  // 2026-04-17 - 2025-10-14 = 185 days
  const c = coverageOf([bar('2026-04-17', 1), bar('2026-10-14', 1)], '2025-10-14', '2026-10-14');
  assert.deepEqual([c.short, c.missingDays, c.firstDate, c.endShort], [true, 185, '2026-04-17', false]);
});

test('earnings: upcoming against reported, surprise as supplied or worked out, change against the prior value', () => {
  const items = [
    { fiscalPeriod: '2026 Q1', releaseAt: '2026-04-28T20:05:00Z', reportedAt: '2026-04-28T20:07:00Z', metrics: [] },
    { fiscalPeriod: '2026 Q3', releaseAt: '2026-10-28T20:05:00Z', reportedAt: null, metrics: [{ key: 'revenue', reported: null }] },
    { fiscalPeriod: '2026 Q2', releaseAt: '2026-07-28T20:05:00Z', reportedAt: '2026-07-28T20:07:00Z', metrics: [] },
  ];
  const s = splitEarnings(items);
  assert.deepEqual(s.upcoming.map((e) => e.fiscalPeriod), ['2026 Q3']);
  assert.deepEqual(s.past.map((e) => e.fiscalPeriod), ['2026 Q2', '2026 Q1']);
  // Supplied surprise is passed through even when it differs from reported - consensus.
  assert.deepEqual(surpriseOf({ reported: 2.09, consensus: 2.03, surprise: 0.07, surprisePct: 3.4 }), { value: 0.07, pct: 3.4, basis: 'supplied', why: null });
  // Worked out: 2.10 - 2.00 = 0.10; 0.10 / 2.00 x 100 = 5
  const c = surpriseOf({ reported: 2.1, consensus: 2.0 });
  assert.equal(c.basis, 'computed');
  assert.ok(near(c.value, 0.1) && near(c.pct, 5));
  // Against a negative consensus: -1.09 - (-1.06) = -0.03; -0.03 / 1.06 x 100 = -2.8302
  const n = surpriseOf({ reported: -1.09, consensus: -1.06 });
  assert.ok(near(n.value, -0.03) && Math.abs(n.pct - (-2.830188679)) < 1e-6);
  assert.match(surpriseOf({ reported: 2, consensus: null }).why, /No consensus/);
  assert.match(surpriseOf({ reported: null, consensus: 2 }).why, /Not reported/);
  // (4589.3 - 4324) / 4324 x 100 = 6.1355
  assert.ok(Math.abs(changeVsPrior({ reported: 4589.3, prior: 4324 }).pct - 6.135522664) < 1e-6);
  assert.equal(changeVsPrior({ reported: -1.09, prior: -0.93 }).pct, null);
  assert.equal(changeVsPrior({ reported: 1, prior: 0 }).pct, null);
  assert.match(changeVsPrior({ reported: 1, prior: null }).why, /No prior/);
});

test('overview fields: company apart from listing, every expected field named, field dates and units kept', () => {
  const data = {
    issuer: { id: 'iss-1', name: 'Alfa', description: 'x', sector: 'Industrials', industry: null, classifications: [], country: 'US', employees: 100, fiscalYearEnd: '12-31' },
    listing: { exchange: 'X', symbol: 'ALFA', currency: 'USD', marketCap: 75.2e9, marketCapAsOf: '2026-10-13', sharesOutstanding: 412.5e6, sharesOutstandingAsOf: '2026-09-04', floatShares: null, listedSince: '1998-06-12' },
    highlights: { revenueTTM: null, dividendPerShareAnnual: 2.2, units: 'USD' },
    nextEarnings: { date: '2026-10-28', dateStatus: 'estimated' },
  };
  const r = profileRows(data, { nulls: { 'listing.floatShares': 'Float not reported' }, asOf: '2026-10-13T21:00:00Z' });
  const by = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
  const iss = by(r.issuer), lst = by(r.listing), hi = by(r.highlights);
  assert.ok(!('listing.marketCap' in iss) && !('issuer.sector' in lst));
  assert.equal(iss['issuer.industry'].value, null);
  assert.match(iss['issuer.industry'].why, /Not supplied/);
  assert.match(iss['issuer.classifications'].why, /no sector classification/);
  assert.deepEqual([lst['listing.marketCap'].value, lst['listing.marketCap'].units, lst['listing.marketCap'].asOf], [75.2e9, 'USD', '2026-10-13']);
  assert.deepEqual([lst['listing.sharesOutstanding'].units, lst['listing.sharesOutstanding'].asOf], ['shares', '2026-09-04']);
  assert.equal(lst['listing.floatShares'].why, 'Float not reported');
  assert.equal(lst['listing.exchange'].asOf, '2026-10-13T21:00:00Z');
  assert.deepEqual([hi['highlights.dividendPerShareAnnual'].units, hi['highlights.revenueTTM'].value, hi['highlights.revenueTTM'].units], ['USD per share', null, 'USD']);
  assert.deepEqual(r.nextEarnings, { date: '2026-10-28', dateStatus: 'estimated' });
  // An issuer with no listing: every listing field is still named, with the server's reason.
  const gov = profileRows({ issuer: { name: 'Gov' }, listing: null, highlights: null }, { nulls: { listing: 'A sovereign issuer has no equity listing' } });
  assert.equal(gov.listing.length, 7);
  assert.ok(gov.listing.every((x) => x.value === null && x.why === 'A sovereign issuer has no equity listing'));
  assert.deepEqual(gov.highlights, []);
});
