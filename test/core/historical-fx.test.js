// Regression test: capital and internal funding stay at the reporting-currency amounts booked on their ledger entries.
//
// The fault (found by the accounting verification, fixed in server/core/accounting.js, balanceSheet): capital and
// internal funding were retranslated at today's FX rate, so contributed capital moved with the exchange rate and the FX
// effect of holding a currency vanished from "Results to date". This test runs one Book through contributions, funding,
// transfers, a return to Treasury and two rate moves, and checks every scope at every point against figures worked out
// by hand below. It goes through the real route handlers, engine and ledger (engine level, part of npm test); the only
// fixtures are the FX rates, which stand in for Shaffer MarketData.
//
// ---- The scenario, worked by hand (reporting currency USD) ----------------------------------------------------------
// R0: EUR/USD 1.10, USD/JPY 150 (1 JPY = 0.0066667 USD).
//   Capital into Treasury: 1,000,000 USD; 200,000 EUR = 220,000; 30,000,000 JPY = 200,000.  Capital booked 1,420,000.
//   Treasury funds North 300,000 USD and 100,000 EUR (110,000); South 200,000 USD, 50,000 EUR (55,000) and
//   6,000,000 JPY (40,000). North sends South 20,000 EUR (22,000). South returns 10,000 EUR to Treasury (11,000).
//   Cash: Treasury 500,000 USD, 60,000 EUR, 24,000,000 JPY. North 300,000 USD, 80,000 EUR.
//         South 200,000 USD, 60,000 EUR, 6,000,000 JPY.  (EUR 60+80+60 = 200k; JPY 24+6 = 30m: nothing created.)
//   Internal funding booked: Treasury -300,000 -110,000 -200,000 -55,000 -40,000 +11,000 = -694,000.
//                            North 300,000 + 110,000 - 22,000 = 388,000.  South 200,000 + 55,000 + 40,000 + 22,000
//                            - 11,000 = 306,000.  388,000 + 306,000 = 694,000 advanced = received.
//   Net assets: Treasury 500,000 + 66,000 + 160,000 = 726,000; North 300,000 + 88,000 = 388,000;
//               South 200,000 + 66,000 + 40,000 = 306,000; Book 1,420,000. Results 0 everywhere.
// R1 (both currencies up against USD): EUR/USD 1.20, USD/JPY 125 (1 JPY = 0.008 USD).
//   Treasury 500,000 + 72,000 + 192,000 = 764,000; results 764,000 - 1,420,000 + 694,000 = 38,000
//            (EUR 60,000 x 0.10 = 6,000; JPY 24,000,000 x (0.008 - 0.0066667) = 32,000).
//   North 300,000 + 96,000 = 396,000; results 8,000 (80,000 x 0.10).
//   South 200,000 + 72,000 + 48,000 = 320,000; results 14,000 (EUR 6,000; JPY 6,000,000 x 0.0013333 = 8,000).
//   Book 1,480,000; results 60,000 = 38,000 + 8,000 + 14,000 = EUR 200,000 x 0.10 (20,000) + JPY 240,000 - 200,000.
// R2 (both down): EUR/USD 1.05, USD/JPY 160 (1 JPY = 0.00625 USD).
//   Treasury 500,000 + 63,000 + 150,000 = 713,000; results -13,000 (EUR -3,000; JPY 150,000 - 160,000 = -10,000).
//   North 300,000 + 84,000 = 384,000; results -4,000.
//   South 200,000 + 63,000 + 37,500 = 300,500; results -5,500 (EUR -3,000; JPY 37,500 - 40,000 = -2,500).
//   Book 1,397,500; results -22,500 = EUR 200,000 x -0.05 (-10,000) + JPY 187,500 - 200,000 (-12,500).
// W: at R2 Treasury withdraws 50,000 EUR of capital, booked at 1.05 = 52,500.
//   The rule: a capital withdrawal is booked at the rate of the day. Capital falls by the USD amount paid out at that
//   rate (52,500), not by what those euros cost when contributed (55,000). The realised FX difference on the euros
//   withdrawn, 50,000 x (1.05 - 1.10) = -2,500, stays in results, under FX effects ("Translation of EUR balances"):
//   it is not taken to capital. So at W: capital 1,367,500 (EUR 150,000); Treasury net assets 713,000 - 52,500 =
//   660,500; results unchanged, -13,000 Treasury and -22,500 Book; the EUR FX effect is still -10,000
//   (EUR cash 150,000 booked 220,000 - 52,500 = 167,500, worth 157,500 at 1.05).
// R3: rates back to R0 (1.10, 150).
//   Treasury 500,000 + 11,000 + 160,000 = 671,000; results 671,000 - 1,367,500 + 694,000 = -2,500.
//   North 388,000 and South 306,000, results 0. Book 1,365,000; results -2,500: exactly the realised FX loss on
//   the withdrawal (EUR 150,000 now worth 165,000 against 167,500 booked).
// T: EUR/USD 1.15 (JPY 150), South sends North 10,000 EUR = 11,500 on both entries. North funding 388,000 + 11,500 =
//   399,500, South 306,000 - 11,500 = 294,500; the Accounts together still 694,000.
//   Net assets: Treasury 500,000 + 11,500 + 160,000 = 671,500; North 300,000 + 90,000 x 1.15 = 403,500;
//   South 200,000 + 50,000 x 1.15 + 40,000 = 297,500; Book 1,372,500.
//   Results: Treasury 671,500 - 1,367,500 + 694,000 = -2,000 (10,000 EUR booked 13,500, worth 11,500);
//   North 403,500 - 399,500 = 4,000 (90,000 EUR booked 99,500); South 297,500 - 294,500 = 3,000 (50,000 EUR booked
//   54,500); Book 5,000 = 1,372,500 - 1,367,500, all EUR translation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld } from '../system/lib/world.mjs';
import { AT } from '../system/cases/accounting.mjs';

const CAP0 = 1_420_000;
const INT = { T: -694_000, N: 388_000, S: 306_000 };

test('historical FX: capital and internal funding keep their booked USD amounts through transfers, rate moves, a withdrawal and Book consolidation', { timeout: 120_000 }, async () => {
  const w = await openWorld('engine', { label: 'historical-fx', at: AT.mon });
  const problems = [];
  let count = 0;
  const norm = (v) => (typeof v === 'number' ? v + 0 : v); // -0 and 0 are the same amount
  const eq = (actual, expected, msg) => {
    count++;
    try { assert.deepEqual(JSON.parse(JSON.stringify(actual, (k, v) => norm(v))), expected); } catch { problems.push(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
  };
  const near = (actual, expected, msg) => { count++; if (!(typeof actual === 'number' && Math.abs(actual - expected) < 0.005)) problems.push(`${msg}: got ${actual}, expected ${expected}`); };
  const amounts = (cell) => Object.fromEntries((cell?.byCurrency || []).map((x) => [x.ccy, x.amount]));
  try {
    const fx = (eur, jpy) => Promise.all([w.fixture('fx', { pair: 'EUR/USD', rate: eur }), w.fixture('fx', { pair: 'USD/JPY', rate: jpy })]);
    await fx(1.10, 150);
    const b = await w.post('/api/books', { name: 'Historical FX', reportingCcy: 'USD' });
    const T = b.units.find((u) => u.kind === 'treasury').id;
    const N = (await w.post(`/api/books/${b.id}/accounts`, { name: 'North' })).id;
    const S = (await w.post(`/api/books/${b.id}/accounts`, { name: 'South' })).id;
    const U = { T, N, S };
    const capital = (type, ccy, amount) => w.post(`/api/books/${b.id}/capital`, { type, ccy, amount, note: 'historical FX test' });
    const move = (from, to, ccy, amount) => w.post(`/api/books/${b.id}/transfers`, { fromUnitId: from, toUnitId: to, ccy, amount, purpose: 'historical FX test' });
    await capital('deposit', 'USD', 1_000_000);
    await capital('deposit', 'EUR', 200_000);
    await capital('deposit', 'JPY', 30_000_000);
    await move(T, N, 'USD', 300_000);
    await move(T, N, 'EUR', 100_000);
    await move(T, S, 'USD', 200_000);
    await move(T, S, 'EUR', 50_000);
    await move(T, S, 'JPY', 6_000_000);
    await move(N, S, 'EUR', 20_000);
    await move(S, T, 'EUR', 10_000);

    const bal = (scope) => w.get(`/api/books/${b.id}/accounting/balance`, { scope });
    const pl = (scope) => w.get(`/api/books/${b.id}/accounting/pnl`, { scope });
    const rep = (bs, k) => bs.representedBy.find((r) => r.key === k);

    /** Every scope at one point. e: { cap, capEur, int, na: {T,N,S}, res: {T,N,S}, fxByCcy: {EUR, JPY} } (Book). */
    async function point(at, e) {
      const ints = e.int || INT;
      const sum = (o) => o.T + o.N + o.S;
      const scopes = [
        ['Treasury', 'treasury', ['T']], ['North', N, ['N']], ['South', S, ['S']], ['accounts', 'accounts', ['N', 'S']], ['Book', 'book', ['T', 'N', 'S']],
      ];
      for (const [name, scope, members] of scopes) {
        const bs = await bal(scope);
        const p = await pl(scope);
        const tag = `${at} ${name}`;
        const hasT = members.includes('T');
        const add = (o) => members.reduce((a, k) => a + o[k], 0);
        const na = add(e.na), res = add(e.res);
        // Capital: Treasury's, at the booked amounts; nothing in the Accounts.
        near(rep(bs, 'capital').total.rc, hasT ? e.cap : 0, `${tag}: capital at its booked USD amount`);
        eq(amounts(rep(bs, 'capital').total), hasT ? { USD: 1_000_000, EUR: e.capEur, JPY: 30_000_000 } : {}, `${tag}: capital in local currency`);
        // Internal funding: each owner's cell at its booked amount; the scope total, except the whole Book where it is eliminated.
        for (const k of members) near(rep(bs, 'internal').cells[U[k]].rc, ints[k], `${tag}: ${k} internal funding at its booked USD amount`);
        if (scope !== 'book') near(rep(bs, 'internal').total.rc, add(ints), `${tag}: internal funding total at booked amounts`);
        // Net assets = assets - liabilities, at today's rates.
        near(bs.netAssets.total.rc, na, `${tag}: net assets`);
        near(bs.assets.total.rc - bs.liabilities.total.rc, bs.netAssets.total.rc, `${tag}: assets - liabilities = net assets`);
        for (const k of members) near(bs.netAssets.cells[U[k]].rc, e.na[k], `${tag}: ${k} net assets`);
        // Results: the FX effect of holding the currencies, and nothing else.
        near(rep(bs, 'results').total.rc, res, `${tag}: results to date`);
        for (const k of members) near(rep(bs, 'results').cells[U[k]].rc, e.res[k], `${tag}: ${k} results to date`);
        near(p.fx.current, res, `${tag}: P&L FX effects = results to date`);
        near(p.investmentPnl, rep(bs, 'results').total.rc, `${tag}: investment P&L = results to date on the balance sheet`);
        eq(p.categories.filter((c) => c.rc !== 0).map((c) => c.key), [], `${tag}: no realized, income, expense, commission or fee line`);
        near(p.unrealized.current, 0, `${tag}: no unrealized P&L`);
        near(p.fx.dealingRc ?? (p.fx.byCurrency.reduce((a, x) => a + x.dealing, 0)), 0, `${tag}: no dealing cost (no conversion was made)`);
        if (scope === 'book') {
          const int = rep(bs, 'internal');
          // The elimination is exact: received = advanced = 694,000 booked (the Accounts' funding), residual nothing.
          near(int.elimination.rc, 0, `${tag}: elimination leaves nothing in USD`);
          eq(int.residual, [], `${tag}: no residual in any currency`);
          near(int.gross.received, ints.N + ints.S, `${tag}: funding received at booked amounts`);
          near(int.gross.advanced, -ints.T, `${tag}: funding advanced at booked amounts`);
          near(int.gross.received, int.gross.advanced, `${tag}: advanced = received`);
          eq(int.total.byCurrency, [], `${tag}: no internal funding in the Book total`);
          // Book = sum of its owners after the elimination.
          near(bs.netAssets.total.rc, sum(e.na), `${tag}: Book net assets = Treasury + North + South`);
          near(rep(bs, 'results').total.rc, sum(e.res), `${tag}: Book results = Treasury + North + South`);
          near(rep(bs, 'capital').total.rc, Object.values(rep(bs, 'capital').cells).reduce((a, c) => a + c.rc, 0), `${tag}: Book capital = sum of the owners' capital`);
          near(Object.values(int.cells).reduce((a, c) => a + c.rc, 0), 0, `${tag}: the owners' funding cells cancel`);
          near(rep(bs, 'results').total.rc, bs.netAssets.total.rc - e.cap, `${tag}: Book results = net assets - capital`);
          // FX by currency (Book), and the "Accounts, combined" column.
          eq(Object.fromEntries(p.fx.byCurrency.map((x) => [x.ccy, x.translation])), e.fxByCcy, `${tag}: FX effects by currency`);
          const g = bs.accountsCombined;
          near(g.representedBy.internal.rc, ints.N + ints.S, `${tag}: Accounts combined funding at booked amounts`);
          near(g.representedBy.capital.rc, 0, `${tag}: Accounts combined capital`);
          near(g.representedBy.results.rc, e.res.N + e.res.S, `${tag}: Accounts combined results`);
        }
        if (scope === 'treasury') {
          const o = Object.fromEntries(bs.oversight.accounts.map((a) => [a.id, a.fundingReceived.rc]));
          near(o[N], ints.N, `${tag}: oversight funding received by North at booked amount`);
          near(o[S], ints.S, `${tag}: oversight funding received by South at booked amount`);
        }
      }
    }

    // The local-currency side never changes: funding by currency, whatever the rate.
    const localFunding = async (at) => {
      const bs = await bal('book');
      const int = rep(bs, 'internal');
      eq([T, N, S].map((u) => amounts(int.cells[u])), [{ USD: -500_000, EUR: -140_000, JPY: -6_000_000 }, { USD: 300_000, EUR: 80_000 }, { USD: 200_000, EUR: 60_000, JPY: 6_000_000 }], `${at}: funding in local currency`);
    };

    const ZERO = { T: 0, N: 0, S: 0 };
    await point('R0', { cap: CAP0, capEur: 200_000, na: { T: 726_000, N: 388_000, S: 306_000 }, res: ZERO, fxByCcy: { EUR: 0, JPY: 0 } });
    await localFunding('R0');
    await fx(1.20, 125);
    await point('R1', { cap: CAP0, capEur: 200_000, na: { T: 764_000, N: 396_000, S: 320_000 }, res: { T: 38_000, N: 8_000, S: 14_000 }, fxByCcy: { EUR: 20_000, JPY: 40_000 } });
    await localFunding('R1');
    await fx(1.05, 160);
    await point('R2', { cap: CAP0, capEur: 200_000, na: { T: 713_000, N: 384_000, S: 300_500 }, res: { T: -13_000, N: -4_000, S: -5_500 }, fxByCcy: { EUR: -10_000, JPY: -12_500 } });
    await localFunding('R2');

    // Withdrawal of 50,000 EUR at 1.05: capital falls by 52,500; the -2,500 realised FX stays in FX effects.
    await capital('withdrawal', 'EUR', 50_000);
    await point('W', { cap: CAP0 - 52_500, capEur: 150_000, na: { T: 660_500, N: 384_000, S: 300_500 }, res: { T: -13_000, N: -4_000, S: -5_500 }, fxByCcy: { EUR: -10_000, JPY: -12_500 } });
    const flows = (await pl('book')).capital;
    near(flows.contributions, CAP0, 'W: contributions at booked amounts (1,000,000 + 220,000 + 200,000)');
    near(flows.withdrawals, 52_500, 'W: the withdrawal at the rate of the day (50,000 x 1.05)');
    await fx(1.10, 150);
    await point('R3', { cap: CAP0 - 52_500, capEur: 150_000, na: { T: 671_000, N: 388_000, S: 306_000 }, res: { T: -2_500, N: 0, S: 0 }, fxByCcy: { EUR: -2_500, JPY: 0 } });

    // A transfer posted at yet another rate: both entries carry it.
    await fx(1.15, 150);
    await move(S, N, 'EUR', 10_000);
    const intT = { T: -694_000, N: 399_500, S: 294_500 };
    await point('T', { cap: CAP0 - 52_500, capEur: 150_000, int: intT, na: { T: 671_500, N: 403_500, S: 297_500 }, res: { T: -2_000, N: 4_000, S: 3_000 }, fxByCcy: { EUR: 5_000, JPY: 0 } });

    // Both entries of one transfer carry the same rate, so the sender's and receiver's USD amounts are equal and opposite.
    const rows = w.t.app.db.all(`SELECT e.id, e.type, n.unit_id, n.account, n.ccy, n.amount, n.amount_rc, n.fx_rate FROM events e JOIN entries n ON n.event_id = e.id WHERE e.book_id = ? AND e.type LIKE 'transfer.%' ORDER BY e.id`, b.id);
    const byEvent = new Map();
    for (const r of rows) { if (!byEvent.has(r.id)) byEvent.set(r.id, []); byEvent.get(r.id).push(r); }
    eq(byEvent.size, 8, 'eight transfers were booked (five fundings, two between Accounts, one return)');
    for (const [id, en] of byEvent) {
      eq(new Set(en.map((x) => x.fx_rate)).size, 1, `transfer ${id}: every entry carries the same rate`);
      eq(en.length, 4, `transfer ${id}: four entries (cash and funding, each side)`);
      for (const acct of ['cash', 'internal']) {
        const side = en.filter((x) => x.account === acct);
        near(side.reduce((a, x) => a + x.amount, 0), 0, `transfer ${id} ${acct}: local amounts cancel`);
        near(side.reduce((a, x) => a + x.amount_rc, 0), 0, `transfer ${id} ${acct}: sender's and receiver's USD amounts cancel`);
      }
    }
    const last = byEvent.get([...byEvent.keys()].at(-1));
    eq(last.map((x) => [x.unit_id === S ? 'S' : 'N', x.account, x.amount_rc, x.fx_rate]).sort(), [['N', 'cash', 11_500, 1.15], ['N', 'internal', -11_500, 1.15], ['S', 'cash', -11_500, 1.15], ['S', 'internal', 11_500, 1.15]], 'the transfer at 1.15: 10,000 EUR = 11,500 on both sides');
  } finally {
    await w.close();
  }
  assert.deepEqual(problems, [], `${problems.length} of ${count} checks failed:\n${problems.join('\n')}`);
});
