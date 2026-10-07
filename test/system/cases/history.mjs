// History survives: what has been booked is never rewritten by anything that happens to the data
// around it. Each case first makes a week of paper history (lib/life.mjs up to Friday 6 March:
// trades, settlements, a dividend, an option expiry, daily accruals, a collateral movement,
// end-of-day snapshots), stores every row of the history tables whole (w.history()), disturbs
// the Terminal, and requires every one of those rows to be byte for byte what it was
// (w.historyIntact()). Rows may be added only where the case says so.

import { openLife } from '../lib/life.mjs';
import { evening } from '../lib/world.mjs';

export const area = 'history';
const both = (fn) => ({ engine: fn, api: fn });

async function aWeek(w) {
  const L = await openLife(w, 'History');
  for (const t of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']) { await w.clock(`${t}T15:00:00.000Z`); await w.clock(evening(t)); }
  await w.tick();
  return L;
}
const firstFill = (w, L) => w.sql(`SELECT f.price, f.price_obs_id, o.value, o.bid, o.ask, o.source FROM fills f JOIN orders ord ON ord.id = f.order_id LEFT JOIN observations o ON o.id = f.price_obs_id WHERE ord.strategy_id = ?`, L.strategies.long)[0];

export default [
  {
    id: 'data-refresh',
    title: 'History survives data refreshes and fixture changes',
    proves: 'New prices, FX rates, reference rates, borrow data and closing prices change what things are worth now; they never touch a fill, a posting, a settlement, an accrual already booked or a snapshot already taken.',
    expected: 'After a week of history every quote is replaced (LFA 50.02 -> 73.10, LFB -> 31.00, the option -> 0.01), an FX rate and a reference rate are changed, the borrow becomes unavailable at five times the fee, and the closing price of LFA on the option\'s expiry day (already processed: expired worthless at 50.00) is changed to 120.00, which would have put the calls in the money. Quotes, FX, rates, every Accounting tab and the instrument page are then read (each read refreshes data) and four engine cycles run at the same instant. Every existing history row is unchanged and nothing is added: the fill still shows 50.02 and the observation it was booked against, the option is still expired worthless (one expiry event), no accrual is re-run. Current valuation does move: the long is now valued at 73.10.',
    levels: {
      ...both(async (w, c) => {
        const L = await aWeek(w);
        const before = w.history();
        const fill0 = firstFill(w, L);
        c.eq([fill0.price, fill0.ask, fill0.source], [50.02, 50.02, 'Test fixture'], 'setup: the purchase was filled at 50.02 against a stored observation');
        await w.fixture('quote', { instrumentId: L.lfa.id, bid: 73.00, ask: 73.10, last: 73.10, bidSize: 100, askSize: 100 });
        await w.fixture('quote', { instrumentId: L.lfb.id, bid: 30.90, ask: 31.00, last: 31.00, bidSize: 100, askSize: 100 });
        await w.fixture('quote', { instrumentId: L.call.id, bid: 0.01, ask: 0.02, last: 0.01, bidSize: 1, askSize: 1 });
        await w.fixture('fx', { pair: 'EUR/USD', rate: 1.5 });
        await w.fixture('rate', { code: 'TEST-3M', value: 9.0 });
        await w.fixture('borrow', { instrumentId: L.lfb.id, available: false, quantity: 0, feeRate: 0.05 });
        await w.fixture('close', { instrumentId: L.lfa.id, date: '2026-03-06', value: 120 });
        await w.get('/api/quotes', { ids: [L.lfa.id, L.lfb.id, L.call.id].join(',') });
        await w.get('/api/fx', { pairs: 'EUR/USD,JPY/USD' });
        await w.get('/api/rates', { codes: 'TEST-3M' });
        await w.get(`/api/instruments/${L.lfa.id}/detail`, { bookId: L.book.id });
        for (const tab of ['pnl', 'positions', 'balance', 'borrowings', 'pending', 'failed', 'history']) await w.get(`/api/books/${L.book.id}/accounting/${tab}`, { scope: 'book' });
        await w.get(`/api/books/${L.book.id}/treasury`);
        await w.get(`/api/books/${L.book.id}/collateral`);
        for (let i = 0; i < 4; i++) await w.tick();
        w.historyIntact(c, before, 'after the refreshes');
        c.eq(firstFill(w, L), fill0, 'the fill still shows 50.02 and the observation it was booked against');
        c.eq(w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE 'option.ex%'`, L.book.id)[0].n, 1, 'the option is still expired once, worthless');
        const pos = await w.get(`/api/books/${L.book.id}/accounting/positions`, { scope: 'book' });
        c.eq(pos.positions.find((p) => p.positionId === L.positions.long)?.price, 73.1, 'current valuation does use the new price');
        await w.clean(c, L.book.id);
      }),
      browser: 'data refreshes are not user actions; the screens after them are the ordinary Accounting screens',
    },
  },
  {
    id: 'service-reconnection',
    title: 'History survives a service going away and coming back, and a restart',
    proves: 'Switching the hedge service off and on, loading and clearing a scripted service, changing the service addresses and restarting the Terminal leave the paper history exactly as it was.',
    expected: 'After a week of history: the demo hedge fixture is switched off and on twice; a scripted service is loaded and cleared; every waiting hedge request is refreshed; the MarketData and Analytics addresses are set, tested and cleared; the Terminal is restarted twice with engine cycles in between. Every existing history row is unchanged and nothing is added to the history. The hedge requests are still the same two (one per Marketplace trade), and nothing was traded: the orders are the ones that existed before.',
    levels: {
      ...both(async (w, c) => {
        const L = await aWeek(w);
        const before = w.history();
        const hedgeIds = () => w.sql('SELECT id FROM hedge_requests WHERE book_id = ? ORDER BY id', L.book.id).map((r) => r.id);
        const ids = hedgeIds();
        for (const enabled of [false, true, false, true]) { await w.post('/api/demo/hedge-fixture', { enabled }); await w.tick(); }
        await w.post('/api/demo/hedge-script', { responses: [{ packages: [] }], repeat: true });
        await w.post('/api/hedge/refresh');
        await w.tick();
        await w.post('/api/demo/hedge-script', { clear: true });
        await w.put('/api/data/connection', { marketDataUrl: 'http://127.0.0.1:9', analyticsUrl: 'http://127.0.0.1:9', requestTimeoutMs: 1000 });
        await w.post('/api/data/test', { port: 'market' });
        await w.post('/api/data/test', { port: 'analytics' });
        await w.put('/api/data/connection', { marketDataUrl: '', analyticsUrl: '' });
        await w.restart(); await w.tick(); await w.tick();
        await w.restart(); await w.tick();
        w.historyIntact(c, before, 'after reconnections and restarts');
        c.eq(hedgeIds(), ids, 'the hedge requests are the same two');
        await w.clean(c, L.book.id);
      }),
      browser: 'covered at browser level by SB:hedge:reconnection (the queue and the positions are read before and after)',
    },
  },
  {
    id: 'reference-edits',
    title: 'History survives instrument edits, calendar edits and settings changes',
    proves: 'Editing an instrument, a market calendar or the Book\'s paper-desk assumptions applies from then on; it never re-dates, re-prices or re-fees what is already booked.',
    expected: 'After a week of history, with a purchase of 100 LFA made on Friday still awaiting settlement on Monday 9 March: (a) the instrument LFA is renamed, given a new symbol, venue and issuer domicile, and its own settlement calendar and lag; an attempt to change its contract terms is refused because it has been traded. (b) Monday 9 March (the pending settlement date) and Tuesday 3 March (a date on which settlements were already made) are entered as US market holidays. (c) The Book\'s assumptions are changed: equity commission 0.005 -> 0.02 a share, equity settlement T+1 -> T+3, short collateral 102% -> 150%, confirmation tolerances, and the refresh timings. After each step every existing history row is unchanged: fills keep their fees and settlement dates, the pending settlement keeps its date and amount, past events keep their text. The only additions are one "settings changed" audit event per settings change. A purchase made after the changes does use them: commission 100 x 0.02 = 2.00 and settlement three business days on.',
    levels: {
      ...both(async (w, c) => {
        const L = await aWeek(w);
        await w.clock('2026-03-06T19:00:00.000Z'); // Friday 14:00 New York
        const late = await w.buy(L.book, L.lfa, 100);
        c.eq(late.orders[0].fills[0].settleDate, '2026-03-09', 'setup: a purchase made on Friday settles on Monday 9 March');
        const pendingRow = () => w.sql(`SELECT due_date, amount, status FROM settlements WHERE order_id = ?`, late.orders[0].id)[0];
        const pend0 = pendingRow();
        const before = w.history();
        try {
          // (a) instrument
          const edit = await w.req('PUT', `/api/instruments/${L.lfa.id}`, { name: 'LFA Renamed Holdings plc', symbol: 'LFAR', venue: 'NASDAQ', domicile: 'IE', issuer: 'LFA Renamed Holdings plc', conventions: { settleLag: 2, settlementCalendar: 'USBOND' } });
          c.ok(edit.ok, '(a) the instrument is renamed, given a new symbol, venue and issuer domicile, and its own settlement calendar and lag', edit.error);
          c.refused(await w.req('PUT', `/api/instruments/${L.call.id}`, { terms: { right: 'C', strike: 10, expiration: '2026-12-18', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } }), { status: 400, text: /contract terms are locked/ }, '(a) changing the terms of a traded contract');
          await w.tick();
          w.historyIntact(c, before, '(a) after the instrument edit');
          // (b) calendar
          const cal = await w.req('PUT', '/api/calendars/US/holidays', { dates: ['2026-03-03', '2026-03-09'] });
          c.ok(cal.ok, '(b) 3 March and 9 March are entered as market holidays', cal.error);
          await w.tick();
          w.historyIntact(c, before, '(b) after the calendar edit');
          c.eq(pendingRow(), pend0, '(b) the pending settlement keeps its date and amount');
          // (c) settings
          const set = await w.req('PUT', `/api/books/${L.book.id}`, { settings: { fees: { equity: { perUnit: 0.02, minimum: 1, bps: 0 } }, settlement: { equity: 3 }, short: { collateralPct: 1.5, marginPct: 0.3 }, confirmation: { legPricePct: 2, packageCashPct: 2 } } });
          c.ok(set.ok, '(c) the Book assumptions are changed', set.error);
          await w.put('/api/data/refresh', { quotesMs: 2000, uiPollMs: 6000, freshness: { simulated: 300 } });
          await w.tick();
          w.historyIntact(c, before, '(c) after the settings change', { newEvents: ['book.settings'] });
          c.eq(w.sql(`SELECT fees FROM fills WHERE order_id = ?`, late.orders[0].id)[0].fees.includes('"amount":1'), true, '(c) the earlier fill keeps its 1.00 commission');
          // What is new uses the new assumptions (the instrument now has its own lag of 2, which outranks the Book's 3).
          await w.put(`/api/instruments/${L.lfa.id}`, { conventions: null });
          const fresh = await w.buy(L.book, L.lfa, 100);
          c.eq(fresh.orders[0].fills[0].fees.reduce((a, x) => a + x.amount, 0), 2, 'a purchase made after the changes pays the new commission: 100 x 0.02 = 2.00');
          c.ok(fresh.orders[0].fills[0].settleDate > '2026-03-09', 'and settles later than T+1', fresh.orders[0].fills[0].settleDate);
          w.historyIntact(c, before, 'after the new purchase', { anyNew: true });
        } finally {
          await w.req('PUT', '/api/calendars/US/holidays', { dates: [] });
        }
        await w.clean(c, L.book.id);
      }),
      browser: async (b, c) => b.cases.historyEdits(b, c),
    },
  },
];
