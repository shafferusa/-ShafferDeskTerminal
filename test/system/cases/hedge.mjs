// Hedge reconnection: requests that wait while Shaffer Hedge cannot be reached, positions that change
// or close meanwhile, the service coming back, and the rule that a recommendation is never executed
// by arriving. API and browser level (the engine level of the same workflow is
// test/core/hedge.test.js). The scripted service of the demo environment stands in for Shaffer
// Hedge (everything it returns is labelled a test fixture); requests, previews, execution and the
// ledger are the real ones. The API case runs with the engine timer on, as a user's Terminal does.

export const area = 'hedge';
const CTX = { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };
const QUOTE = { bid: 50.00, ask: 50.02, last: 50.00, bidSize: 50_000, askSize: 50_000 };
const EXP = '2026-06-19';
export const scriptedPut = (und, contracts = 1) => ({ id: 'scripted-put', label: 'Scripted protective put', recommended: true, legs: [{ role: 'hedge', hedgeFamily: 'Options', kind: 'trade', action: 'buy', quantity: contracts, option: { underlyingId: und.id, expiration: EXP, strike: 45, right: 'P', multiplier: 100, deliverableUnits: 100, exercise: 'american', settlement: 'physical' } }] });

/** Positions bought from a Marketplace while the hedge service is away. Returns the Book, the instruments and the strategy instances. */
export async function waitingRequests(w) {
  await w.post('/api/demo/hedge-fixture', { enabled: false });
  await w.post('/api/demo/hedge-script', { clear: true });
  const book = await w.book('Hedge reconnection', { capital: 2_000_000, funding: 1_000_000 });
  const inst = {};
  for (const s of ['HGR', 'HSH', 'HCL', 'HUN', 'HIN']) inst[s] = await w.stock(s, QUOTE);
  const buy = (i, qty, ctx = CTX) => w.trade({ ...w.ticketInput(book, i, 'buy', qty), ...ctx });
  const s = { grew: await buy(inst.HGR, 300), shrank: await buy(inst.HSH, 400), closed: await buy(inst.HCL, 200), untouched: await buy(inst.HUN, 100), incomplete: await buy(inst.HIN, 100, {}) };
  await w.tick();
  return { book, inst, s };
}
export const requestOf = async (w, book, strategy) => (await w.get('/api/hedge/requests', { bookId: book.id })).items.find((r) => r.strategyId === strategy.id);

export default [
  {
    id: 'reconnection',
    title: 'Hedge requests that waited while positions changed are refreshed against current exposure on reconnection',
    proves: 'A request made while the hedge service is away waits; when the service returns it is asked in place for the exposure as it is then; a request whose position was closed is closed and not sent; no request is duplicated; and a recommendation that arrives executes nothing.',
    world: { engine: 'on' },
    expected: 'With the hedge service away, five positions are bought from the Marketplace: 300 HGR, 400 HSH, 200 HCL and 100 HUN with a complete context, and 100 HIN without one. Each gets one request: four "awaiting connection", one "incomplete". While they wait HGR is doubled to 600, 300 of HSH are sold (100 left) and HCL is closed. Nothing is sent meanwhile and there are still five requests. The service comes back (a scripted fixture answering every request with one protective-put package). Then: HGR\'s request is "recommendation ready" for 600 and current; HSH\'s for 100; HUN\'s for 100; HCL\'s is "closed" with the reason and was never sent; HIN\'s is still "incomplete" and was not sent: exactly three requests reached the service. There are still five requests, the same ids, one per position. Nothing was executed: no order, fill, ledger entry or position was added by the reconnection, and each strategy instance has the orders it had. Refreshing again, more engine cycles and the service going away and coming back add no request and execute nothing. After HGR is reduced again its recommendation is stale and its package cannot be previewed for execution until the request is refreshed; refreshed, it is for the new quantity. Only an explicit preview and confirmation of the package creates orders, and they carry the request id. With the service away again the recommendations already received stay, shown as not reachable now.',
    levels: {
      engine: 'the engine level of this workflow is test/core/hedge.test.js ("reconnection refreshes waiting requests against current exposure", "one request per primary")',
      api: async (w, c) => {
        const { book, inst, s } = await waitingRequests(w);
        const all = async () => (await w.get('/api/hedge/requests', { bookId: book.id })).items;
        const of = async (strategy) => (await all()).find((r) => r.strategyId === strategy.id);
        const ids0 = (await all()).map((r) => r.id).sort();
        c.eq(ids0.length, 5, 'five requests, one per Marketplace position');
        c.eq(await Promise.all([s.grew, s.shrank, s.closed, s.untouched, s.incomplete].map(async (x) => (await of(x)).state)), ['awaiting_connection', 'awaiting_connection', 'awaiting_connection', 'awaiting_connection', 'incomplete'], 'four await the connection, one is incomplete');
        c.eq((await of(s.incomplete)).missing?.length > 0, true, 'the incomplete one says what is missing');
        const svc0 = await w.get('/api/hedge/service');
        c.eq(svc0.reachable, false, 'the hedge service is reported as not reachable');

        // While waiting: 300 -> 600, 400 -> 100, 200 -> 0.
        const confirm = async (pv) => (await w.must('POST', '/api/strategies', w.confirmBody(pv))).strategy;
        await confirm(await w.post(`/api/strategies/${s.grew.id}/preview-action`, { action: 'resize', factor: 2 }));
        await confirm(await w.post(`/api/strategies/${s.shrank.id}/preview-action`, { action: 'close', positionIds: [s.shrank.positions[0].positionId], qty: 300 }));
        await confirm(await w.post(`/api/strategies/${s.closed.id}/preview-action`, { action: 'close' }));
        await w.tick(); await w.tick();
        c.eq((await all()).map((r) => r.id).sort(), ids0, 'while waiting: still the same five requests');
        const beforeBooks = await w.books(book.id);
        const ordersOf = () => Object.fromEntries(Object.entries(s).map(([k, x]) => [k, w.sql('SELECT COUNT(*) AS n FROM orders WHERE strategy_id = ?', x.id)[0].n]));
        const orders0 = ordersOf();
        const hist = w.history();

        // The service comes back.
        const loaded = await w.post('/api/demo/hedge-script', { responses: [{ packages: [scriptedPut(inst.HGR)] }], repeat: true });
        c.eq(loaded.service?.reachable, true, 'the scripted service is reported as reachable');
        await w.tick(); await w.tick();
        const [g, sh, cl, un, inc] = await Promise.all([s.grew, s.shrank, s.closed, s.untouched, s.incomplete].map(of));
        c.eq([g.state, g.request.primary.quantity, g.freshness?.status], ['recommendation_ready', 600, 'current'], 'HGR: recommendation ready for 600, current');
        c.eq([sh.state, sh.request.primary.quantity, sh.freshness?.status], ['recommendation_ready', 100, 'current'], 'HSH: recommendation ready for 100, current');
        c.eq([un.state, un.request.primary.quantity], ['recommendation_ready', 100], 'HUN: recommendation ready for 100');
        c.eq(cl.state, 'closed', 'HCL: the request is closed');
        c.match(cl.message, /position this request was for was closed/, 'and says why');
        c.eq(cl.response ?? null, null, 'it carries no recommendation');
        c.eq(inc.state, 'incomplete', 'HIN: still incomplete');
        c.eq(inc.response ?? null, null, 'and not answered');
        const used = (await w.get('/api/demo/hedge-script')).used;
        c.eq(used, 3, 'exactly three requests reached the service');
        c.eq([g.source?.kind, /fixture/i.test(g.source?.label || '')], ['test-fixture', true], 'the recommendation is labelled as coming from a test fixture');
        c.eq((await all()).map((r) => r.id).sort(), ids0, 'still the same five requests: refreshed in place, none added');
        c.eq(w.sql('SELECT strategy_id, COUNT(*) AS n FROM hedge_requests WHERE book_id = ? GROUP BY strategy_id HAVING COUNT(*) > 1', book.id), [], 'no position has two requests');

        // Receiving recommendations executed nothing.
        const afterBooks = await w.books(book.id);
        w.sameBooks(c, beforeBooks, afterBooks, 'the reconnection');
        c.eq([afterBooks.counts.orders, afterBooks.counts.fills, afterBooks.counts.entries, afterBooks.counts.positions, afterBooks.counts.strategies], [beforeBooks.counts.orders, beforeBooks.counts.fills, beforeBooks.counts.entries, beforeBooks.counts.positions, beforeBooks.counts.strategies], 'no order, fill, ledger entry, position or strategy instance was added');
        c.eq(ordersOf(), orders0, 'each strategy instance has the orders it had');
        w.historyIntact(c, hist, 'the reconnection', { anyNew: true });

        // Again and again: nothing more.
        await w.post('/api/hedge/refresh');
        for (let i = 0; i < 3; i++) await w.tick();
        await w.post('/api/demo/hedge-script', { clear: true });
        await w.tick();
        const away = await of(s.grew);
        c.eq([away.state, away.connection?.reachable], ['recommendation_ready', false], 'service away again: the recommendation stays, and the service is shown as not reachable now');
        await w.post('/api/demo/hedge-script', { responses: [{ packages: [scriptedPut(inst.HGR)] }], repeat: true });
        await w.tick(); await w.tick();
        await new Promise((r) => setTimeout(r, 2500)); // the engine timer cycles by itself
        c.eq((await all()).map((r) => r.id).sort(), ids0, 'after refreshing, cycles, and the service away and back: the same five requests');
        const b2 = await w.books(book.id);
        c.eq([b2.counts.orders, b2.counts.fills, b2.counts.entries], [beforeBooks.counts.orders, beforeBooks.counts.fills, beforeBooks.counts.entries], 'and still nothing executed');

        // A position that changes after its recommendation arrived.
        await confirm(await w.post(`/api/strategies/${s.grew.id}/preview-action`, { action: 'close', positionIds: [s.grew.positions[0].positionId], qty: 200 }));
        await w.tick();
        let g2 = await of(s.grew);
        c.eq(g2.freshness?.status, 'stale', 'HGR reduced to 400: its recommendation is stale');
        const stalePv = await w.req('POST', `/api/hedge/requests/${g2.id}/preview`, { packageId: 'scripted-put' });
        c.ok(stalePv.ok ? stalePv.body.blocking >= 1 && stalePv.body.checks.some((x) => x.code === 'hedge-stale') : stalePv.status < 500, 'the stale package cannot be previewed for execution', stalePv.ok ? JSON.stringify(stalePv.body.checks.map((x) => x.code)) : stalePv.error);
        await w.post(`/api/hedge/requests/${g2.id}/refresh`);
        g2 = await of(s.grew);
        c.eq([g2.id, g2.state, g2.request.primary.quantity, g2.freshness?.status], [g.id, 'recommendation_ready', 400, 'current'], 'refreshed in place: the same request, for 400, current');

        // Execution is an explicit preview and confirmation.
        // The option of the package has no quote: the desk states its fill price (a manual input), as the popup asks.
        const bare = await w.post(`/api/hedge/requests/${g2.id}/preview`, { packageId: 'scripted-put' });
        c.ok(bare.hedge?.completion?.missing?.length > 0 || bare.legs[0].price?.executable === false, 'without a stated price the unquoted option leg says what is missing', JSON.stringify(bare.hedge?.completion?.missing));
        const pv = await w.post(`/api/hedge/requests/${g2.id}/preview`, { packageId: 'scripted-put', statedPrices: { 1: 1.10 } });
        c.eq(pv.blocking, 0, 'the current package previews without a block');
        const ordersBefore = (await w.books(book.id)).counts.orders;
        c.eq(ordersBefore, b2.counts.orders + 1, 'previewing created no order (the one new order is the reduction of HGR)');
        const exec = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        const hedgeOrders = w.sql(`SELECT json_extract(data, '$.hedgeLinkId') AS link FROM orders WHERE book_id = ? AND json_extract(data, '$.hedgeLinkId') IS NOT NULL`, book.id);
        c.eq(hedgeOrders.map((o) => o.link), [g2.id], 'confirming it created one hedge order, carrying the request id');
        c.ok(['executing', 'executed'].includes((await of(s.grew)).state), 'the request is now executing or executed', (await of(s.grew)).state);
        void exec;
        await w.clean(c, book.id);
      },
      browser: async (b, c) => b.cases.hedgeReconnection(b, c),
    },
  },
];
