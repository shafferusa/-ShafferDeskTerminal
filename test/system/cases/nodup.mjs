// No duplicates, ever: fills, hedge requests, accruals, payments, ledger postings and collateral movements,
// after catch-up over missed days, across restarts, with overlapping engine cycles and with the engine timer
// running. Every case lives the same fifteen days (lib/life.mjs, where the figures are worked out by hand),
// under a different regime, and must end with the same books.

import { checkLife, DAY_BY_DAY, LIFE_END, lifeDigest, liveDayByDay, openLife, sameLife } from '../lib/life.mjs';

export const area = 'nodup';
const both = (fn) => ({ engine: fn, api: fn });

/** The day-by-day run in a Terminal of its own: the reference the other regimes are compared with. */
async function reference(w) {
  const r = await w.open({ tag: 'life-reference', engine: 'off' });
  const L = await openLife(r, 'Life');
  await liveDayByDay(r);
  return lifeDigest(r, L);
}

export default [
  {
    id: 'day-by-day',
    title: 'Fifteen days lived one day at a time: every recurring item exactly once',
    proves: 'With the Terminal running through fifteen days, each accrual, payment, expiry, settlement, collateral movement and hedge request happens once, and the totals are the hand-calculated ones.',
    expected: 'The figures at the top of test/system/lib/life.mjs: dividend 250.00 once; borrow fee 5.83 accrued; loan repaid with 194.44 interest; option premium 420.00 lost once; one 5,000.00 variation-margin movement; one hedge request for each of the two Marketplace trades; restricted cash 15,300.00, margin 5,000.00, settled cash 944,301.76; nothing payable or receivable; no fill, settlement, accrual-for-a-day, lifecycle item or order exists twice; integrity clean. Six further engine cycles and a restart at the end change nothing.',
    levels: {
      ...both(async (w, c) => {
        const L = await openLife(w);
        await liveDayByDay(w);
        await checkLife(w, c, L, 'day by day');
        const before = await lifeDigest(w, L);
        const fp = w.fingerprint();
        for (let i = 0; i < 6; i++) await w.tick();
        await w.restart();
        await w.tick();
        sameLife(c, before, await lifeDigest(w, L), 'six more cycles and a restart');
        w.sameStored(c, fp, w.fingerprint(), 'six more cycles and a restart store nothing');
      }),
      browser: 'time passing is not a user action; the screens are read after catch-up in SB:nodup:catch-up-screens',
    },
  },
  {
    id: 'catch-up',
    title: 'Catch-up over fifteen missed days in one engine cycle',
    proves: 'A Terminal that was not running for fifteen days books, when it next runs, exactly what it would have booked day by day: nothing missed, nothing twice.',
    expected: 'Everything is put on on Monday 2 March; the next engine cycle is on Tuesday 17 March. After it (and one more cycle for work that follows from the first) the hand-calculated figures of lib/life.mjs hold, and every ledger balance, position, cash bucket, settlement, collateral movement, completed lifecycle item and once-only event count is identical to the day-by-day run. Further cycles change nothing.',
    levels: {
      ...both(async (w, c) => {
        const ref = await reference(w);
        const L = await openLife(w);
        await w.clock(LIFE_END);
        await w.tick();
        await checkLife(w, c, L, 'catch-up');
        const got = await lifeDigest(w, L);
        sameLife(c, ref, got, 'catch-up');
        for (let i = 0; i < 4; i++) await w.tick();
        sameLife(c, got, await lifeDigest(w, L), 'four more cycles after the catch-up');
      }),
      browser: async (b, c) => b.cases.catchUpScreens(b, c),
    },
  },
  {
    id: 'catch-up-restarts',
    title: 'Catch-up in three stages with a restart between each',
    proves: 'Stopping and starting the Terminal between catch-ups neither loses nor repeats what fell due.',
    expected: 'Everything is put on on Monday 2 March. The Terminal is restarted, then moved to Thursday 5 March; restarted, moved to Wednesday 11 March; restarted, moved to Tuesday 17 March. The end state is identical to the day-by-day run, with the hand-calculated figures.',
    levels: {
      ...both(async (w, c) => {
        const ref = await reference(w);
        const L = await openLife(w);
        for (const t of ['2026-03-05T15:00:00.000Z', '2026-03-11T14:00:00.000Z', LIFE_END]) {
          await w.restart();
          await w.clock(t);
          await w.tick();
        }
        await w.restart();
        await w.tick();
        await checkLife(w, c, L, 'catch-up with restarts');
        sameLife(c, ref, await lifeDigest(w, L), 'catch-up with restarts');
      }),
      browser: 'a restart is an operation on the server process (see SE/SA:stress:restart-stages)',
    },
  },
  {
    id: 'overlapping-cycles',
    title: 'Overlapping engine cycles and requests',
    proves: 'Engine cycles that are asked for while one is already running do not run on top of it, and trades confirmed while a cycle runs are booked once.',
    expected: 'The fifteen days are lived day by day, but at every step five engine cycles are requested at once together with the clock move, and the opening trades are confirmed while cycles are being requested. At engine level the data adapter is given latency (every refresh yields to other work, as a real service call does), so cycles and requests really interleave at every point where the engine waits for data: a cycle requested while one is running reports that it was skipped and does nothing. At API level the same burst is sent as concurrent HTTP requests (there the demo data source has no latency, so the server serves them one after another; the number that overlapped is reported). In both the end state is identical to the plain day-by-day run, with the hand-calculated figures.',
    levels: {
      ...both(async (w, c) => {
        const ref = await reference(w);
        if (w.level === 'engine') {
          // The stand-in for the Shaffer services answers with a delay, as a network call would.
          const data = w.t.app.data, refresh = data.refresh.bind(data);
          data.refresh = async (...args) => { await new Promise((r) => setImmediate(r)); return refresh(...args); };
        }
        const noise = () => Promise.all([w.tick(), w.tick(), w.tick()]);
        const background = noise();
        const L = await openLife(w);
        await background;
        let skipped = 0, ran = 0;
        for (const t of DAY_BY_DAY) {
          const out = await Promise.all([w.clock(t), w.tick(), w.tick(), w.tick(), w.tick(), w.tick()]);
          for (const s of out) { if (s && s.skipped) skipped++; else ran++; }
        }
        await w.tick(); await w.tick();
        if (w.level === 'engine') c.ok(skipped > 0, 'cycles requested while one was running were skipped, not run on top of it', `skipped ${skipped}, ran ${ran}`);
        c.note(`${ran} cycles ran, ${skipped} overlapping requests were skipped`);
        await checkLife(w, c, L, 'overlapping cycles');
        sameLife(c, ref, await lifeDigest(w, L), 'overlapping cycles');
      }),
      browser: 'engine cycles are not a user action',
    },
  },

  {
    id: 'concurrent-confirmations',
    title: 'The same confirmation sent three times at once, six of them, with engine cycles in between',
    proves: 'Confirmations that arrive together, including the same one several times (a triple click, a client retry racing its first attempt), create one order each and fill once.',
    expected: 'Six different purchases of 100 shares (ask 50.02) are previewed. Then all six confirmations are sent three times each, at the same moment, together with four engine cycles (at engine level with latency in the data adapter, so the calls really interleave). Afterwards there are exactly six strategy instances, six orders and six fills of 100 at 50.02; the Account owes 6 x (5,002.00 + 1.00) = 30,018.00 and holds 600 shares in six lots; the integrity check is clean. A transfer sent three times at once under one client token is one transfer.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Concurrent confirmations');
        const inst = await w.stock('CCF', { bid: 50.00, ask: 50.02, last: 50.01, bidSize: 50_000, askSize: 50_000 });
        if (w.level === 'engine') {
          const data = w.t.app.data, refresh = data.refresh.bind(data);
          data.refresh = async (...args) => { await new Promise((r) => setImmediate(r)); return refresh(...args); };
        }
        const bodies = [];
        for (let i = 0; i < 6; i++) bodies.push(w.confirmBody(await w.post('/api/strategies/preview', w.ticketInput(book, inst, 'buy', 100))));
        const calls = [];
        for (const b of bodies) for (let k = 0; k < 3; k++) calls.push(w.req('POST', '/api/strategies', b));
        for (let k = 0; k < 4; k++) calls.push(w.tick());
        const out = await Promise.all(calls);
        const answers = out.slice(0, 18);
        c.ok(answers.every((r) => r.ok), 'every confirmation was answered without an error', JSON.stringify(answers.filter((r) => !r.ok).map((r) => r.error)));
        c.eq(new Set(answers.map((r) => r.body?.strategy?.id)).size, 6, 'the eighteen answers name six strategy instances');
        await w.tick();
        const b = await w.books(book.id);
        c.eq([b.counts.strategies, b.counts.orders, b.counts.fills, b.counts.positions], [6, 6, 6, 6], 'six strategy instances, six orders, six fills, six positions');
        c.eq(w.sql('SELECT qty, price FROM fills ORDER BY rowid').map((f) => [f.qty, f.price]), Array(6).fill([100, 50.02]), 'each fill is 100 at 50.02');
        const cash = await w.cash(book.id, book.accountId);
        c.near(cash.payable, 30_018, 'payable: 6 x 5,003.00');
        c.eq(b.ledger.positions.reduce((a, p) => a + p.qty, 0), 600, '600 shares held');
        // A transfer under one token, three times at once.
        const token = `sys-concurrent-${Date.now().toString(36)}`;
        const before = (await w.cash(book.id, book.treasuryId)).settled;
        const tr = await Promise.all([0, 1, 2].map(() => w.req('POST', `/api/books/${book.id}/transfers`, { fromUnitId: book.treasuryId, toUnitId: book.accountId, ccy: 'USD', amount: 1_000, clientToken: token })));
        c.ok(tr.every((r) => r.ok), 'the three transfer requests are answered', JSON.stringify(tr.map((r) => r.error)));
        c.eq(new Set(tr.map((r) => r.body?.eventId)).size, 1, 'they name one event');
        c.near((await w.cash(book.id, book.treasuryId)).settled, before - 1_000, 'Treasury paid 1,000.00 once');
        await w.clean(c, book.id);
      }),
      browser: 'the browser form of this is clicking a confirming button twice: SB:stress:double-click-*',
    },
  },
  {
    id: 'timer-on',
    title: 'The engine timer running, with manual cycles on top and a restart on the way',
    proves: 'With the engine cycling by itself (as a user\'s Terminal does) while requests, manual cycles and clock moves arrive, and across a restart, nothing is booked twice.',
    world: { engine: 'on' },
    expected: 'The server runs with its engine timer on (a cycle every second, the shortest the Terminal allows). The fifteen days are lived day by day with a burst of four manual cycles at every step and a restart after the first week; the timer keeps firing in between (the engine status shows it running and its last cycle advancing). The end state is identical to a day-by-day run with the timer off, with the hand-calculated figures. Ten more seconds of nothing but the timer change nothing.',
    levels: {
      engine: 'the engine level calls cycles explicitly; the timer exists only in a running server',
      api: async (w, c) => {
        const ref = await reference(w); // lived with the timer off
        await w.put('/api/data/refresh', { engineTickMs: 1000 });
        const status0 = (await w.get('/api/status')).engine;
        c.eq(status0.running, true, 'the engine timer is running');
        const L = await openLife(w);
        let n = 0;
        for (const t of DAY_BY_DAY) {
          await Promise.all([w.clock(t), w.tick(), w.tick(), w.tick(), w.tick()]);
          if (++n === 9) { await w.restart(); c.eq((await w.get('/api/status')).engine.running, true, 'after the restart the timer is running again'); }
          if (n % 5 === 0) await new Promise((r) => setTimeout(r, 1100)); // let the timer fire by itself on the way
        }
        await w.tick();
        await checkLife(w, c, L, 'timer on');
        const got = await lifeDigest(w, L);
        sameLife(c, ref, got, 'timer on');
        const seen = (await w.get('/api/status')).engine.lastTick;
        const fp = w.fingerprint();
        await new Promise((r) => setTimeout(r, 10_000));
        const later = (await w.get('/api/status')).engine;
        c.ok(later.lastTick > seen, 'the timer went on cycling by itself for ten seconds', `${seen} -> ${later.lastTick}`);
        c.eq(later.lastError, null, 'without an engine error');
        w.sameStored(c, fp, w.fingerprint(), 'ten seconds of timer cycles store nothing');
        sameLife(c, got, await lifeDigest(w, L), 'ten seconds of timer cycles');
      },
      browser: 'the browser level runs with the timer on in SB:stress:connection-loss and SB:hedge:reconnection; the books are compared here',
    },
  },
];
