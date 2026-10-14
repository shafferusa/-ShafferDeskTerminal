// The instrument workspace's plain logic (web/views/workspace-model.js): Gap % rules, the tab registry by family and
// what is not covered, and the request discipline (one selection per instrument, late or foreign answers discarded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelection, gapOf, refreshMs, serverBadge, workspaceTabs } from '../../web/views/workspace-model.js';

test('Gap %: a supplied gap is passed through as stated', () => {
  const g = gapOf({ price: 170, priceCcy: 'USD', priceUnits: 'per share', family: 'equity', fair: 205.4, fairCcy: 'USD', fairUnits: 'per share', supplied: 11.8 });
  assert.deepEqual(g, { value: 11.8, basis: 'supplied' });
});

test('Gap %: worked out only with the same currency, units and a positive price', () => {
  // (220 - 200) / 200 x 100 = 10
  const g = gapOf({ price: 200, priceCcy: 'USD', priceUnits: 'per share', family: 'equity', fair: 220, fairCcy: 'USD', fairUnits: 'per share' });
  assert.equal(g.basis, 'computed');
  assert.ok(Math.abs(g.value - 10) < 1e-12);
  // (99 - 100) / 100 x 100 = -1, bond in % of par on both sides
  assert.ok(Math.abs(gapOf({ price: 100, priceCcy: 'USD', priceUnits: '% of par (clean)', family: 'bond', fair: 99, fairCcy: 'USD', fairUnits: '% of par (clean)' }).value + 1) < 1e-12);
});

test('Gap %: not shown, with the reason, when inputs are missing or not comparable', () => {
  const base = { price: 200, priceCcy: 'USD', priceUnits: 'per share', family: 'equity', fair: 220, fairCcy: 'USD', fairUnits: 'per share' };
  const why = (patch) => gapOf({ ...base, ...patch });
  assert.equal(why({ fair: null }).value, null);
  assert.match(why({ fair: null }).why, /No fair price/);
  assert.match(why({ price: null }).why, /No current market price/);
  assert.match(why({ fairCcy: 'EUR' }).why, /EUR.*USD/);
  assert.match(why({ fairCcy: null }).why, /currency/);
  assert.match(why({ fairUnits: 'per ADR' }).why, /per ADR/);
  assert.match(why({ fairUnits: null }).why, /units/);
  assert.match(why({ price: 0 }).why, /positive/);
  assert.match(why({ family: 'swap', priceUnits: 'per 100 notional', fairUnits: 'per 100 notional' }).why, /mislead/);
  // A missing value is never turned into zero.
  for (const p of [{ fair: null }, { price: null }, { fairCcy: 'EUR' }]) assert.equal(why(p).value, null);
});

test('Tabs: equities get the nine research tabs; a bond lists issuer data as not covered', () => {
  const eq = workspaceTabs({ family: 'equity' }, null);
  assert.deepEqual(eq.tabs.map((t) => t.id), ['overview', 'history', 'earnings', 'statements', 'filings', 'actions', 'news', 'analytics', 'positions']);
  assert.equal(eq.notCovered.length, 0);
  const bond = workspaceTabs({ family: 'bond' }, null);
  assert.ok(!bond.tabs.some((t) => t.id === 'statements' || t.id === 'earnings'));
  assert.ok(bond.notCovered.some((n) => /financial statements/i.test(n.what)));
  assert.equal(bond.related, 'issuer');
  const opt = workspaceTabs({ family: 'option' }, null);
  assert.equal(opt.related, 'underlying');
  assert.ok(opt.notCovered.some((n) => /underlying/i.test(n.why)));
});

test('Tabs: an awaiting dataset keeps its tab with the state; one the server reports as not covered moves to the list', () => {
  const st = { datasets: { earnings: { mapped: false, state: 'awaiting' }, news: { mapped: true, state: 'available', covered: false, coverageNote: 'No news coverage for this listing.' }, statements: { mapped: true, state: 'not-requested' } } };
  const r = workspaceTabs({ family: 'equity' }, st);
  assert.equal(r.tabs.find((t) => t.id === 'earnings').state, 'awaiting');
  assert.equal(r.tabs.find((t) => t.id === 'statements').state, null);
  assert.ok(!r.tabs.some((t) => t.id === 'news'));
  assert.deepEqual(r.notCovered.find((n) => n.what === 'News and events'), { what: 'News and events', why: 'No news coverage for this listing.', by: 'server' });
  assert.equal(serverBadge({ mapped: true, authBlocked: true, state: 'available' }), 'error');
});

/** A fetch whose answers are released by hand, to play responses out of order. */
function manualFetch() {
  const calls = [];
  const fetchImpl = (path, query, signal) => new Promise((resolve, reject) => {
    const c = { path, query, resolve, reject };
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    calls.push(c);
  });
  return { calls, fetchImpl };
}

test('Requests: every request carries requestId and selection; as-of only when asked', async () => {
  const f = manualFetch();
  const sel = createSelection({ id: 'EQ-A', channel: 'page', asOf: '2025-06-30', fetchImpl: f.fetchImpl });
  const p1 = sel.request('profile', '/x', {});
  const p2 = sel.request('reference', '/y', {}, { asOf: false });
  assert.match(f.calls[0].query.requestId, /^page:EQ-A:\d+:profile:\d+$/);
  assert.equal(f.calls[0].query.selection, sel.token);
  assert.equal(f.calls[0].query.asOf, '2025-06-30');
  assert.equal(f.calls[1].query.asOf, undefined);
  f.calls[0].resolve({ state: 'available', requestId: f.calls[0].query.requestId, selection: sel.token });
  f.calls[1].resolve({ state: 'available' });
  assert.equal((await p1).body.state, 'available');
  assert.equal((await p2).body.state, 'available');
});

test('Requests: switching instrument aborts in flight; a late or foreign answer is discarded', async () => {
  const f = manualFetch();
  const seen = [];
  const a = createSelection({ id: 'EQ-A', channel: 'page', fetchImpl: f.fetchImpl, onDiscard: (d) => seen.push(d) });
  const pa = a.request('profile', '/a', {});
  a.close(); // the user chose another instrument
  const b = createSelection({ id: 'EQ-B', channel: 'page', fetchImpl: f.fetchImpl, onDiscard: (d) => seen.push(d) });
  const pb = b.request('profile', '/b', {});
  assert.equal((await pa).discarded, true);
  // An answer about another instrument is not drawn under B.
  f.calls[1].resolve({ state: 'available', requestId: f.calls[1].query.requestId, instrument: { terminalId: 'EQ-A', ids: { terminal: 'EQ-A' } } });
  assert.equal((await pb).discarded, true);
  // Two requests for one dataset: the older answer, arriving last, is discarded.
  const p1 = b.request('history', '/h', { range: '1y' });
  const p2 = b.request('history', '/h', { range: '5y' });
  f.calls[3].resolve({ state: 'available', requestId: f.calls[3].query.requestId });
  f.calls[2].resolve({ state: 'available', requestId: f.calls[2].query.requestId });
  assert.equal((await p2).body.state, 'available');
  assert.equal((await p1).discarded, true);
  // A server echo of another requestId, and a superseded answer, are discarded.
  const p3 = b.request('news', '/n', {});
  f.calls[4].resolve({ state: 'available', requestId: 'someone-else' });
  assert.equal((await p3).discarded, true);
  const p4 = b.request('news', '/n', {});
  f.calls[5].resolve({ state: 'error', requestId: f.calls[5].query.requestId, error: { code: 'superseded' } });
  assert.equal((await p4).discarded, true);
  assert.deepEqual(seen.map((s) => s.reason), ['aborted', 'the response is for instrument EQ-A', 'superseded by a newer request', 'the response is for another request', 'superseded on the server']);
});

test('Refresh interval: the server per-dataset setting first, on demand means none, else the Terminal settings', () => {
  assert.equal(refreshMs('quotes', { quotes: { mode: 'interval', intervalSec: 5 } }, {}), 5000);
  assert.equal(refreshMs('statements', { statements: { mode: 'on-demand', intervalSec: null } }, { referenceMs: 60000 }), null);
  assert.equal(refreshMs('statements', null, { referenceMs: 60000 }), 60000);
  assert.equal(refreshMs('analytics', null, { analyticsMs: 30000 }), 30000);
});
