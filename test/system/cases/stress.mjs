// Execution under stress: partial fills, a failed dependent leg and its recovery actions, cancellations,
// repeated requests, and a restart at each stage of a trade's life. (Killing the server mid-request and the
// engine timer are in nodup.mjs and at the end of this file; duplicate clicks and connection loss are browser
// cases.)
//
// Figures: a market buy fills at the ask and a market sell at the bid, at most the displayed size per engine
// cycle; commission is 0.005 a share with a 1.00 minimum per ORDER (not per fill); option commission is 0.65 a
// contract; US equities and listed options settle T+1.

import { readFileSync } from 'node:fs';
import { checkLife, LIFE_END, lifeDigest, liveDayByDay, openLife, sameLife } from '../lib/life.mjs';
import { evening, FRI, MON, THU, TUE, WED } from '../lib/world.mjs';

export const area = 'stress';
const both = (fn) => ({ engine: fn, api: fn });
const QUOTE = { bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000 };
const put = (und, symbol) => ({ productId: 'equity_option', name: `${symbol} 2026-06-19 50 Put`, symbol: `${symbol} 260619P50`, marketView: 'US_DERIV', venue: 'CBOE', venueType: 'exchange', venueCountry: 'US', underlyingId: und.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'P', strike: 50, expiration: '2026-06-19', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
const commission = async (w, book) => (await w.balance(book.id, book.accountId, 'pnl.commission')) + (await w.balance(book.id, book.accountId, 'pnl.fee'));

/** A package whose protective leg fails: 100 shares bought, a day limit order for 1 put (limit 1.00, ask 2.10) that never fills. */
async function brokenPackage(w, symbol) {
  const book = await w.book(`Stress ${symbol}`);
  const stock = await w.stock(symbol, QUOTE);
  const opt = await w.instrument(put(stock, symbol));
  await w.fixture('quote', { instrumentId: opt.id, bid: 2.00, ask: 2.10, last: 2.05, bidSize: 50, askSize: 50 });
  const pv = await w.post('/api/strategies/preview', { bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: stock.id, legs: [
    { kind: 'trade', action: 'buy', instrumentId: stock.id, qty: 100, role: 'underlying', orderType: 'market', tif: 'day' },
    { kind: 'trade', action: 'buy', instrumentId: opt.id, qty: 1, role: 'put', purpose: 'hedge', dependsOn: [1], orderType: 'limit', limitPrice: 1.00, tif: 'day' }] });
  if (pv.blocking) throw new Error(`setup blocked: ${JSON.stringify(pv.checks)}`);
  const s = (await w.must('POST', '/api/strategies', w.confirmBody(pv))).strategy;
  return { book, stock, opt, s };
}
const attentionAlerts = async (w, book) => (await w.get(`/api/books/${book.id}/alerts`)).items.filter((a) => a.code === 'strategy.attention');

export default [
  // ---------------------------------------------------------------------------------------------------
  {
    id: 'partial-fills',
    title: 'Partial fills: the remainder keeps working, a dependent leg follows, fees total once',
    proves: 'An order larger than the displayed size fills in parts over engine cycles; a leg that depends on it is scaled to what filled and never exceeds it; the fee schedule and its minimum apply to the order once, however many fills it takes.',
    expected: 'Buy 1,000 shares (300 displayed at the ask 50.02) with 10 protective puts (ask 2.10) depending on the stock. Cycle 1: 300 shares fill, the order is partly filled with 700 remaining and working; 3 puts fill (30% of 10). Cycle 2: 600 shares, 6 puts. The stock order is then cancelled with 600 filled: the puts end at 6 (reduced to match), never more. Holdings: 600 shares at cost 30,012.00, 6 puts at cost 1,260.00. Commission: stock 600 x 0.005 = 3.00 (1.50 + 1.50), puts 6 x 0.65 = 3.90, 6.90 in all. A second order for 150 shares against 100 displayed fills 100 then 50 and pays the 1.00 minimum once (1.00 on the first fill, 0.00 on the second).',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Stress partial fills');
        const stock = await w.stock('SPF', { ...QUOTE, askSize: 300, bidSize: 300 });
        const opt = await w.instrument(put(stock, 'SPF'));
        await w.fixture('quote', { instrumentId: opt.id, bid: 2.00, ask: 2.10, last: 2.05, bidSize: 50, askSize: 50 });
        const pv = await w.post('/api/strategies/preview', { bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: stock.id, legs: [
          { kind: 'trade', action: 'buy', instrumentId: stock.id, qty: 1_000, role: 'underlying', orderType: 'market', tif: 'gtc' },
          { kind: 'trade', action: 'buy', instrumentId: opt.id, qty: 10, role: 'put', purpose: 'hedge', dependsOn: [1], orderType: 'market', tif: 'gtc' }] });
        c.eq(pv.blocking, 0, 'the package previews without a block');
        let s = (await w.must('POST', '/api/strategies', w.confirmBody(pv))).strategy;
        const leg = (n) => s.orders.find((o) => o.legNo === n);
        c.eq([leg(1).status, leg(1).filledQty, leg(1).remainingQty], ['partial', 300, 700], 'cycle 1: 300 of 1,000 shares filled, 700 remaining');
        c.eq(leg(2).filledQty, 3, 'cycle 1: 3 of 10 puts filled (30%)');
        c.eq(s.status, 'partial', 'the package is partly filled');
        c.eq(s.complete, false, 'and is not complete');
        const pend = await w.get(`/api/books/${book.id}/accounting/pending`, { scope: 'book' });
        c.ok(pend.partiallyFilled.some((o) => o.remainingQty === 700), 'the Pending tab lists the order as partly filled with 700 remaining', JSON.stringify(pend.partiallyFilled.map((o) => o.remainingQty)));
        await w.tick();
        s = await w.strategy(s.id);
        c.eq([leg(1).filledQty, leg(2).filledQty], [600, 6], 'cycle 2: 600 shares and 6 puts');
        const cancel = await w.req('POST', `/api/orders/${leg(1).id}/cancel`);
        c.ok(cancel.ok, 'the remainder of the stock order is cancelled', cancel.error);
        await w.tick(); await w.tick();
        s = await w.strategy(s.id);
        c.eq([leg(1).status, leg(1).filledQty], ['cancelled', 600], 'the stock order ends cancelled with 600 filled');
        c.eq([leg(2).status, leg(2).filledQty, leg(2).qty], ['filled', 6, 6], 'the put leg ends at 6 contracts, reduced to match');
        c.eq(leg(1).fills.map((f) => [f.qty, f.price, f.fees.reduce((a, x) => a + x.amount, 0)]), [[300, 50.02, 1.5], [300, 50.02, 1.5]], 'stock fills: 300 + 300 at 50.02, commission 1.50 each');
        c.eq(leg(2).fills.map((f) => [f.qty, f.price]), [[3, 2.1], [3, 2.1]], 'put fills: 3 + 3 at 2.10');
        const pos = s.positions.map((p) => [p.family, p.qty, p.cost]).sort();
        c.eq(pos, [['equity', 600, 30_012], ['option', 6, 1_260]], 'holdings: 600 shares at 30,012.00 and 6 puts at 1,260.00');
        c.near(await commission(w, book), 6.90, 'commission in all: 3.00 + 3.90');

        // The minimum fee binds on the whole order, once.
        const small = await w.stock('SPM', { ...QUOTE, askSize: 100, bidSize: 100 });
        let m = await w.trade(w.ticketInput(book, small, 'buy', 150, { order: { tif: 'gtc' } }));
        c.eq(m.orders[0].filledQty, 100, '150 against 100 displayed: 100 filled first');
        await w.tick();
        m = await w.strategy(m.id);
        c.eq(m.orders[0].fills.map((f) => [f.qty, f.fees.reduce((a, x) => a + x.amount, 0)]), [[100, 1], [50, 0]], 'fills of 100 and 50; the 1.00 minimum is charged once, on the first');
        c.near(await commission(w, book), 7.90, 'commission in all: 6.90 + 1.00');
        await w.clean(c, book.id);
      }),
      browser: 'partial fills are produced by the engine against displayed size, not by a user action; the partly filled order is read on the Pending tab in SB:stress:cancel-partial',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'failed-leg-cancel',
    title: 'A failed dependent leg: cancelling the working leg',
    proves: 'Cancelling the unfilled leg of a package whose other leg filled leaves a package that asks for attention, never one called complete; cancelling again does nothing.',
    expected: '100 shares fill at 50.02; the dependent put order (limit 1.00 against an ask of 2.10) is working. "Cancel working legs": the put order is cancelled, the package is in attention (not complete) with the put leg listed as residual, one alert says so, and retry, unwind and accept are offered. The ledger is exactly as after the stock fill (5,002.00 cost, 1.00 commission), nothing is reserved for the cancelled leg. Cancelling working legs again is refused (nothing is working); cancelling the same order again is refused (409); neither adds a row.',
    levels: {
      ...both(async (w, c) => {
        const { book, s } = await brokenPackage(w, 'SFC');
        c.eq(s.orders.map((o) => [o.status, o.filledQty]), [['filled', 100], ['working', 0]], 'the stock leg is filled, the put leg is working');
        const before = await w.books(book.id);
        const r = await w.req('POST', `/api/strategies/${s.id}/action`, { action: 'cancel_working' });
        c.ok(r.ok, 'cancel working legs', r.error);
        const v = await w.strategy(s.id);
        c.eq([v.status, v.complete], ['attention', false], 'the package needs attention and is not complete');
        c.eq(v.residual.map((x) => x.legNo), [2], 'the put leg is listed as residual');
        c.eq(v.actions.filter((a) => ['retry', 'unwind', 'accept'].includes(a)), ['retry', 'unwind', 'accept'], 'retry, unwind and accept are offered');
        c.eq((await attentionAlerts(w, book)).length, 1, 'one alert says the package needs attention');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'cancelling');
        c.near((await w.cash(book.id, book.accountId)).reserved, 0, 'nothing is reserved for the cancelled leg');
        c.refused(await w.req('POST', `/api/strategies/${s.id}/action`, { action: 'cancel_working' }), { status: 400, text: /no working legs/ }, 'cancel working legs again');
        c.refused(await w.req('POST', `/api/orders/${s.orders[1].id}/cancel`), { status: 409, text: /already cancelled/ }, 'cancel the same order again');
        w.sameRows(c, after, await w.books(book.id), 'the repeated cancellations');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.failedLegRecovery(b, c, 'cancel'),
    },
  },
  {
    id: 'failed-leg-retry',
    title: 'A failed dependent leg: retry',
    proves: 'Retrying re-submits only the leg that failed, through a new preview and confirmation, and completes the package without duplicating anything.',
    expected: 'The put order expires unfilled at the end of Monday: the package is in attention with one alert. Tuesday, retry: the preview holds one leg (the put); confirmed as a market order it fills 1 contract at 2.10. The package is open and complete, the alert is gone, and the instance has three legs in all (stock filled, put expired and marked dealt with, put filled). Sending the same confirmation again reports a duplicate and adds nothing. Holdings: 100 shares at 5,002.00 and 1 put at 210.00; commission 1.00 + 0.65.',
    levels: {
      ...both(async (w, c) => {
        const { book, s } = await brokenPackage(w, 'SFR');
        await w.clock(evening('2026-03-02'));
        let v = await w.strategy(s.id);
        c.eq(v.orders.map((o) => o.status), ['filled', 'expired'], 'Monday evening: the put day order has expired');
        c.eq(v.status, 'attention', 'the package needs attention');
        c.eq((await attentionAlerts(w, book)).length, 1, 'one alert');
        await w.clock(TUE);
        const retry = await w.post(`/api/strategies/${s.id}/preview-action`, { action: 'retry' });
        c.eq(retry.legs.map((l) => [l.kind, l.action, l.qty]), [['trade', 'buy', 1]], 'the retry preview holds only the failed put leg');
        const pv = await w.post('/api/strategies/preview', { ...retry.input, legs: retry.legs.map((l) => ({ ...l, orderType: 'market', limitPrice: null })), clientToken: retry.token });
        c.eq(pv.blocking, 0, 'as a market order it previews without a block');
        const body = w.confirmBody(pv);
        const first = await w.must('POST', '/api/strategies', body);
        v = first.strategy;
        c.eq([v.status, v.complete], ['open', true], 'the package is open and complete');
        c.eq(v.orders.map((o) => [o.legNo, o.status, o.filledQty]), [[1, 'filled', 100], [2, 'expired', 0], [3, 'filled', 1]], 'three legs: stock filled, put expired, put filled');
        c.eq(v.orders[1].resolved, true, 'the expired leg is marked as dealt with');
        c.eq((await attentionAlerts(w, book)).length, 0, 'the alert is gone');
        const afterFirst = await w.books(book.id);
        const again = await w.must('POST', '/api/strategies', body);
        c.eq(again.duplicate, true, 'the same confirmation sent again is reported as a duplicate');
        w.sameRows(c, afterFirst, await w.books(book.id), 'the repeated confirmation');
        c.eq(v.positions.map((p) => [p.family, p.qty, p.cost]).sort(), [['equity', 100, 5_002], ['option', 1, 210]], 'holdings: 100 shares at 5,002.00 and 1 put at 210.00');
        c.near(await commission(w, book), 1.65, 'commission 1.00 + 0.65');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.failedLegRecovery(b, c, 'retry'),
    },
  },
  {
    id: 'failed-leg-unwind',
    title: 'A failed dependent leg: unwind',
    proves: 'Unwinding sells what did fill, through a preview and confirmation, and leaves the package closed with nothing held.',
    expected: 'The put order expires unfilled; the package is in attention. Tuesday, unwind: the preview sells the 100 shares; confirmed, they sell at the bid 50.00. The package is closed, nothing is held, the alert is gone. Realized P&L is 100 x (50.00 - 50.02) = -2.00 and commission 1.00 + 1.00. After Wednesday\'s settlement cash is 500,000.00 - 2.00 - 2.00 = 499,996.00 with nothing payable or receivable.',
    levels: {
      ...both(async (w, c) => {
        const { book, s } = await brokenPackage(w, 'SFU');
        await w.clock(evening('2026-03-02'));
        await w.clock(TUE);
        c.eq((await w.strategy(s.id)).status, 'attention', 'the package needs attention');
        const pv = await w.post(`/api/strategies/${s.id}/preview-action`, { action: 'unwind' });
        c.eq(pv.legs.map((l) => [l.action, l.qty]), [['sell', 100]], 'the unwind preview sells the 100 shares');
        const v = (await w.must('POST', '/api/strategies', w.confirmBody(pv))).strategy;
        c.eq([v.status, v.positions.length], ['closed', 0], 'the package is closed and holds nothing');
        c.eq(v.orders.at(-1).avgPrice, 50.00, 'sold at the bid');
        c.eq((await attentionAlerts(w, book)).length, 0, 'the alert is gone');
        c.near(await w.balance(book.id, book.accountId, 'pnl.realized'), 2, 'realized loss 2.00');
        c.near(await commission(w, book), 2, 'commission 1.00 + 1.00');
        await w.clock(WED);
        const cash = await w.cash(book.id, book.accountId);
        c.eq([cash.settled, cash.payable, cash.receivable], [499_996, 0, 0], 'after settlement: 499,996.00, nothing payable or receivable');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.failedLegRecovery(b, c, 'unwind'),
    },
  },
  {
    id: 'failed-leg-accept',
    title: 'A failed dependent leg: accept as it stands',
    proves: 'Accepting records, once, that the position no longer matches its template; it moves no money.',
    expected: 'The put order expires unfilled; the package is in attention. Accept: the package is open with a note that it no longer matches its template, one "accepted" event is in the audit trail, the alert is gone, and no ledger entry was posted (cash, positions and balances exactly as before). Accepting again is refused and adds nothing.',
    levels: {
      ...both(async (w, c) => {
        const { book, s } = await brokenPackage(w, 'SFA');
        await w.clock(evening('2026-03-02'));
        const before = await w.books(book.id);
        const r = await w.req('POST', `/api/strategies/${s.id}/action`, { action: 'accept' });
        c.ok(r.ok, 'accept', r.error);
        const v = await w.strategy(s.id);
        c.eq(v.status, 'open', 'the package is open');
        c.match(v.note, /no longer matches its template/, 'its note says it no longer matches its template');
        c.eq((await attentionAlerts(w, book)).length, 0, 'the alert is gone');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'accepting');
        c.eq(after.counts.entries, before.counts.entries, 'accepting posts no ledger entry');
        c.eq(w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'strategy.accepted'`, book.id)[0].n, 1, 'one accepted event');
        c.refused(await w.req('POST', `/api/strategies/${s.id}/action`, { action: 'accept' }), { status: 400, text: /Only a package with failed legs/ }, 'accept again');
        w.sameRows(c, after, await w.books(book.id), 'accepting again');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.failedLegRecovery(b, c, 'accept'),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'cancellations',
    title: 'Cancellations: a working order, a partly filled order, cancelling twice',
    proves: 'A cancelled order never fills afterwards; what had filled stays; a second cancellation, or the cancellation of an order that is already complete, is refused and changes nothing.',
    expected: '(a) A resting limit buy (limit 40.00, ask 50.02): cancelled, with one cancellation event, no ledger entry, nothing reserved; three cycles later still unfilled although the quote has dropped to the limit. (b) A market buy of 1,000 against 300 displayed: 300 filled; cancelled: the order is cancelled with 300 filled, the 300 shares stay, and three more cycles fill nothing. (c) Cancelling either order again: 409, no new event. (d) Cancelling a filled order: 409. (e) An order id that does not exist: 404.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Stress cancellations');
        const a = await w.stock('SCA', QUOTE);
        const rest = await w.trade(w.ticketInput(book, a, 'buy', 100, { order: { orderType: 'limit', limitPrice: 40, tif: 'gtc' } }));
        c.eq(rest.orders[0].status, 'working', '(a) the limit order is working');
        const before = await w.books(book.id);
        let r = await w.req('POST', `/api/orders/${rest.orders[0].id}/cancel`);
        c.eq(r.body?.status, 'cancelled', '(a) cancelled');
        await w.fixture('quote', { instrumentId: a.id, bid: 39.98, ask: 40.00, last: 40.00, bidSize: 5000, askSize: 5000 });
        await w.tick(); await w.tick(); await w.tick();
        let v = await w.strategy(rest.id);
        c.eq([v.orders[0].status, v.orders[0].filledQty, v.positions.length], ['cancelled', 0, 0], '(a) three cycles later, with the quote at its limit: still cancelled, unfilled, no position');
        let now = await w.books(book.id);
        c.eq(now.counts.entries, before.counts.entries, '(a) no ledger entry');
        c.eq(now.counts.events, before.counts.events + 1, '(a) one cancellation event');
        c.near((await w.cash(book.id, book.accountId)).reserved, 0, '(a) nothing reserved');
        c.refused(await w.req('POST', `/api/orders/${rest.orders[0].id}/cancel`), { status: 409, text: /already cancelled/ }, '(c) cancel it again');
        w.sameRows(c, now, await w.books(book.id), '(c) the second cancellation');

        const b = await w.stock('SCB', { ...QUOTE, askSize: 300, bidSize: 300 });
        const part = await w.trade(w.ticketInput(book, b, 'buy', 1_000, { order: { tif: 'gtc' } }));
        c.eq([part.orders[0].status, part.orders[0].filledQty], ['partial', 300], '(b) 300 of 1,000 filled');
        r = await w.req('POST', `/api/orders/${part.orders[0].id}/cancel`);
        c.eq([r.body?.status, r.body?.filledQty], ['cancelled', 300], '(b) cancelled with 300 filled');
        const mid = await w.books(book.id);
        await w.tick(); await w.tick(); await w.tick();
        v = await w.strategy(part.id);
        c.eq([v.orders[0].filledQty, v.orders[0].fills.length, v.positions[0]?.qty], [300, 1, 300], '(b) three more cycles fill nothing: one fill, 300 shares held');
        w.sameBooks(c, mid, await w.books(book.id), '(b) the cycles after the cancellation');
        now = await w.books(book.id);
        c.refused(await w.req('POST', `/api/orders/${part.orders[0].id}/cancel`), { status: 409, text: /already cancelled/ }, '(c) cancel the partly filled order again');
        const full = await w.buy(book, a, 10);
        c.refused(await w.req('POST', `/api/orders/${full.orders[0].id}/cancel`), { status: 409, text: /already filled/ }, '(d) cancel a filled order');
        c.refused(await w.req('POST', '/api/orders/ORD-0000000000/cancel'), { status: 404 }, '(e) cancel an order that does not exist');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.cancelPartial(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'restart-stages',
    title: 'Application restart at each stage of a trade\'s life',
    proves: 'Stopping and starting the Terminal at any stage loses nothing and repeats nothing: a working order is still working, a partly filled order resumes, an unsettled trade settles once, an open lifecycle item runs once.',
    expected: 'A limit buy of 1,000 at 49.00 (GTC). Stage 1, working (ask 50.02): restart. Stage 2, partly filled (ask drops to 49.00 with 300 displayed; 300 fill): restart; the remaining 700 fill over the next cycles (300, 300, 100). Stage 3, filled and unsettled (49,005.00 payable: 49,000.00 plus 5.00 commission): restart. Stage 4, Tuesday, settled (cash 450,995.00): restart. Stage 5, a dividend of 0.25 a share with ex-date Wednesday and pay date Friday is recorded and Wednesday passes (the item is open): restart. Friday: 250.00 is received once (cash 451,245.00). At every restart the books before and after are identical (ledger, positions, cash, row counts) and the integrity check is clean; at the end there is one order, four fills, one settlement payment and one dividend event.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Stress restart stages');
        const inst = await w.stock('SRS', QUOTE);
        const s = await w.trade(w.ticketInput(book, inst, 'buy', 1_000, { order: { orderType: 'limit', limitPrice: 49, tif: 'gtc' } }));
        const order = async () => (await w.strategy(s.id)).orders[0];
        const restartHere = async (stage) => {
          const before = await w.books(book.id);
          const fp = w.fingerprint();
          await w.restart();
          const after = await w.books(book.id);
          w.sameBooks(c, before, after, `restart at "${stage}"`);
          w.sameRows(c, before, after, `restart at "${stage}"`);
          w.sameStored(c, fp, w.fingerprint(), `restart at "${stage}": every stored row is as it was`);
          c.ok(after.ok, `restart at "${stage}": integrity is clean`, after.problems.join(' | '));
        };
        c.eq((await order()).status, 'working', 'stage 1: the order is working');
        await restartHere('working');
        await w.tick();
        c.eq([(await order()).status, (await order()).filledQty], ['working', 0], 'after the restart it is still working, unfilled');

        await w.fixture('quote', { instrumentId: inst.id, bid: 48.98, ask: 49.00, last: 49.00, bidSize: 300, askSize: 300 });
        await w.tick();
        c.eq([(await order()).status, (await order()).filledQty], ['partial', 300], 'stage 2: 300 filled at the limit');
        await restartHere('partly filled');
        await w.tick(); await w.tick(); await w.tick();
        let o = await order();
        c.eq([o.status, o.filledQty, o.fills.map((f) => f.qty)], ['filled', 1_000, [300, 300, 300, 100]], 'after the restart the remainder fills: 300, 300, 100');
        c.eq(o.fills.reduce((a, f) => a + f.fees.reduce((x, y) => x + y.amount, 0), 0), 5, 'commission 5.00 in all (1,000 x 0.005)');
        let cash = await w.cash(book.id, book.accountId);
        c.eq([cash.settled, cash.payable], [500_000, 49_005], 'stage 3: filled, unsettled: 49,005.00 payable');
        await restartHere('filled, unsettled');

        await w.clock(TUE);
        cash = await w.cash(book.id, book.accountId);
        c.eq([cash.settled, cash.payable], [450_995, 0], 'stage 4: settled, cash 450,995.00');
        await restartHere('settled');
        await w.tick();
        c.eq((await w.cash(book.id, book.accountId)).settled, 450_995, 'a cycle after the restart does not pay again');

        const ca = await w.req('POST', '/api/corporate-actions', { instrumentId: inst.id, type: 'cash_dividend', exDate: '2026-03-04', payDate: '2026-03-06', amount: 0.25 });
        c.ok(ca.ok, 'a dividend of 0.25 is recorded (ex Wednesday, paid Friday)', ca.error);
        await w.clock(THU);
        c.eq((await w.cash(book.id, book.accountId)).settled, 450_995, 'stage 5: Thursday, the dividend is not yet paid');
        await restartHere('open lifecycle item');
        await w.clock(FRI);
        await w.tick();
        c.eq((await w.cash(book.id, book.accountId)).settled, 451_245, 'Friday: 250.00 received (1,000 x 0.25)');
        await restartHere('after the dividend');
        await w.tick(); await w.tick();
        c.eq((await w.cash(book.id, book.accountId)).settled, 451_245, 'further cycles and a restart do not pay it again');
        const n = (type) => w.sql('SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = ?', book.id, type)[0].n;
        c.eq([n('trade.fill'), n('settlement.pay'), n('dividend')], [4, 4, 1], 'in the end: four fill events, four settlement payments (one per fill), one dividend');
        c.eq((await w.books(book.id)).counts.orders, 1, 'and one order');
        await w.clean(c, book.id);
      }),
      browser: 'a restart is an operation on the server process; the product matrix restarts every scenario at browser level and reads the screens again, and SB:stress:connection-loss covers the browser across a restart',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'repeated-requests',
    title: 'Repeated identical requests to every mutating route',
    proves: 'Sending the same mutating request twice has one effect, for every route that changes something: by its client token where the route takes one, by its own nature or state where it needs none.',
    expected: 'Every POST, PUT and DELETE route of server/api.js is listed here with how a repeat is made safe, and the list is checked against the routes the server really has (a route that is missing from it fails the case). "token": sent twice with the same clientToken, the second answer carries duplicate: true and nothing more is stored (the stored rows after the first and after the second request are identical); the same token with a different body is refused (409 token_reused). "state": the second request is refused (4xx) because the first already took effect. "natural": the second request succeeds and stores nothing new. "read-only" and "engine": the route stores nothing of the paper books by repeating. For contrast, a deposit sent twice WITHOUT a token is two deposits: without a token every request is a new instruction.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Stress repeated requests');
        const stock = await w.stock('SRR', QUOTE);
        await w.fixture('rate', { code: 'TEST-3M', value: 4.0 });
        const held = await w.trade({ ...w.ticketInput(book, stock, 'buy', 200), investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } });
        await w.tick();
        const position = held.positions[0];
        const loan = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'loan', action: 'borrow_cash', qty: 50_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'Repeat test loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-06-01' } } }] });
        const working = await w.trade(w.ticketInput(book, stock, 'buy', 10, { order: { orderType: 'limit', limitPrice: 40, tif: 'gtc' } }));
        const working2 = await w.trade(w.ticketInput(book, stock, 'buy', 10, { order: { orderType: 'limit', limitPrice: 41, tif: 'gtc' } }));
        const agr = await w.post(`/api/books/${book.id}/agreements`, { name: 'CSA repeat', counterparty: 'Dealer R', kind: 'bilateral', unitIds: [book.accountId], terms: { variationMargin: true } });
        const swap = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 100_000, statedPrice: 0, contract: { productId: 'interest_rate_swap', name: 'IRS repeat', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer R', collateralBasis: { type: 'agreement', agreementId: agr.id }, legs: [
          { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' }, { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } } }] });
        const hedge = (await w.get('/api/hedge/requests', { bookId: book.id })).items.find((r) => r.strategyId === held.id);
        c.ok(hedge, 'setup: the Marketplace purchase has its post-trade hedge request');
        const task = w.sql(`SELECT id FROM tasks WHERE book_id = ? AND status = 'pending' LIMIT 1`, book.id)[0];
        c.ok(task, 'setup: a pending lifecycle item exists');
        const list = await w.post('/api/watchlists', { name: 'Repeat list', marketView: 'US_CASH' });
        let seq = 0;
        const token = () => `sys-repeat-${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 10)}`;
        const covered = new Set();

        /** how: token | state | natural | read-only | engine. `body` may be a function of the attempt number for routes whose natural repeat differs. */
        async function repeat(route, how, path, body, { label = route, changes = true, second = null } = {}) {
          covered.add(route);
          const method = route.split(' ')[0];
          const before = w.fingerprint();
          const t = how === 'token' ? token() : null;
          const send = () => w.req(method, path, t ? { ...(body || {}), clientToken: t } : body);
          const r1 = await send();
          if (!c.ok(r1.ok, `${label}: the first request goes through`, r1.error)) return r1;
          const mid = w.fingerprint();
          if (changes && how !== 'read-only') c.ok(JSON.stringify(mid) !== JSON.stringify(before), `${label}: the first request stored something`);
          const r2 = await send();
          const after = w.fingerprint();
          if (how === 'token') {
            c.ok(r2.ok && r2.body?.duplicate === true, `${label}: the repeat is answered as a duplicate`, r2.ok ? JSON.stringify(r2.body).slice(0, 200) : r2.error);
            w.sameStored(c, mid, after, `${label}: the repeat stored nothing`);
            const other = await w.req(method, path, { ...(body || {}), clientToken: t, note: 'a different request under the same token', amount: 123.45, name: 'different' });
            c.refused(other, { status: 409, code: 'token_reused' }, `${label}: the same token with another body`);
            w.sameStored(c, mid, w.fingerprint(), `${label}: and that stored nothing either`);
          } else if (how === 'state') {
            c.refused(r2, second || {}, `${label}: the repeat`);
            w.sameStored(c, mid, after, `${label}: the repeat stored nothing`);
          } else if (how === 'natural') {
            c.ok(r2.ok, `${label}: the repeat succeeds`, r2.error);
            w.sameStored(c, mid, after, `${label}: the repeat stored nothing new`);
          } else {
            c.ok(r2.ok, `${label}: the repeat succeeds`, r2.error);
            if (how === 'read-only') w.sameStored(c, before, after, `${label}: nothing is stored by either request`);
          }
          return r1;
        }
        const B = `/api/books/${book.id}`;

        // ---- Books, cash ----
        await repeat('POST /api/books', 'state', '/api/books', { name: 'Repeat second Book', reportingCcy: 'USD' }, { second: { status: 409, text: /already exists/ } });
        await repeat('POST /api/books', 'token', '/api/books', { name: 'Repeat third Book', reportingCcy: 'USD' }, { label: 'POST /api/books (with a token)' });
        await repeat('PUT /api/books/:id', 'natural', B, { name: 'Stress repeated requests renamed' });
        await repeat('PUT /api/books/:id', 'token', B, { settings: { fees: { equity: { perUnit: 0.006 } } } }, { label: 'PUT /api/books/:id (settings, with a token)' });
        await repeat('POST /api/books/:id/accounts', 'state', `${B}/accounts`, { name: 'Beta' }, { second: { status: 409, text: /already has an Account named/ } });
        const dep = await repeat('POST /api/books/:id/capital', 'token', `${B}/capital`, { type: 'deposit', ccy: 'USD', amount: 1_000, note: 'repeat test' });
        await repeat('POST /api/books/:id/transfers', 'token', `${B}/transfers`, { fromUnitId: book.treasuryId, toUnitId: book.accountId, ccy: 'USD', amount: 2_000, purpose: 'repeat test' });
        await repeat('POST /api/books/:id/adjustments', 'token', `${B}/adjustments`, { unitId: book.accountId, ccy: 'USD', amount: -3, category: 'fee', note: 'Custody fee, repeat test' });
        await repeat('POST /api/events/:id/reverse', 'state', `/api/events/${dep.body?.eventId}/reverse`, { note: 'repeat test' }, { second: { status: 409, text: /already been corrected/ } });
        // Without a token a repeat is a second instruction: two deposits.
        const cash0 = (await w.cash(book.id, book.treasuryId)).settled;
        await w.post(`${B}/capital`, { type: 'deposit', ccy: 'USD', amount: 500 });
        await w.post(`${B}/capital`, { type: 'deposit', ccy: 'USD', amount: 500 });
        c.near((await w.cash(book.id, book.treasuryId)).settled, cash0 + 1_000, 'a deposit sent twice without a token is two deposits');

        // ---- packages and orders ----
        covered.add('POST /api/strategies/preview'); covered.add('POST /api/strategies');
        {
          const fp0 = w.fingerprint();
          const input = w.ticketInput(book, stock, 'buy', 30);
          const pv = await w.post('/api/strategies/preview', input);
          await w.post('/api/strategies/preview', { ...input, legs: pv.legs, clientToken: pv.token });
          c.eq(w.fingerprint(), fp0, 'POST /api/strategies/preview: previewing twice stores nothing');
          const body = w.confirmBody(pv);
          const r1 = await w.must('POST', '/api/strategies', body);
          const mid = w.fingerprint();
          const r2 = await w.must('POST', '/api/strategies', body);
          c.eq([r1.duplicate, r2.duplicate, r2.strategy.id], [false, true, r1.strategy.id], 'POST /api/strategies: the repeat is answered as a duplicate with the same strategy instance');
          c.eq(w.fingerprint(), mid, 'POST /api/strategies: the repeat stored nothing');
          c.eq(r2.strategy.orders.length, 1, 'POST /api/strategies: one order, not two');
        }
        await repeat('POST /api/strategies/:id/preview-action', 'read-only', `/api/strategies/${held.id}/preview-action`, { action: 'close' });
        await repeat('POST /api/orders/:id/cancel', 'state', `/api/orders/${working.orders[0].id}/cancel`, undefined, { second: { status: 409 } });
        await repeat('POST /api/strategies/:id/action', 'state', `/api/strategies/${working2.id}/action`, { action: 'cancel_working' }, { second: { status: 400, text: /no working legs/ } });

        // ---- events recorded by hand ----
        await repeat('POST /api/positions/:id/lifecycle', 'token', `/api/positions/${position.positionId}/lifecycle`, { action: 'cashflow', category: 'fee', amount: -2.5, note: 'Depositary fee, repeat test' });
        await repeat('POST /api/instruments/:id/lifecycle', 'token', `/api/instruments/${loan.positions[0].instrument.id}/lifecycle`, { action: 'set_rate', rate: 0.055 });
        await repeat('POST /api/tasks/:id/settlement-amount', 'natural', `/api/tasks/${task.id}/settlement-amount`, { amount: 12 });
        await repeat('POST /api/corporate-actions', 'natural', '/api/corporate-actions', { instrumentId: stock.id, type: 'cash_dividend', exDate: '2026-03-10', payDate: '2026-03-12', amount: 0.1 }, { label: 'POST /api/corporate-actions (the same dividend recorded twice is one record)' });

        // ---- registry, prices, watchlists ----
        await repeat('POST /api/instruments', 'token', '/api/instruments', { productId: 'common_stock', name: 'Repeat Registered Co', symbol: 'SRRX', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
        await repeat('PUT /api/instruments/:id', 'natural', `/api/instruments/${stock.id}`, { name: 'SRR Test Works Inc. (renamed)' });
        await repeat('POST /api/observations', 'token', '/api/observations', { kind: 'price', subject: stock.id, value: 50.5, currency: 'USD', note: 'repeat test' });
        await repeat('POST /api/watchlists', 'token', '/api/watchlists', { name: 'Repeat list two', marketView: 'US_CASH' });
        await repeat('PUT /api/watchlists/:id', 'natural', `/api/watchlists/${list.id}`, { name: 'Repeat list renamed' });
        await repeat('POST /api/watchlists/:id/items', 'natural', `/api/watchlists/${list.id}/items`, { instrumentId: stock.id });
        await repeat('DELETE /api/watchlists/:id/items/:instrumentId', 'natural', `/api/watchlists/${list.id}/items/${stock.id}`);
        await repeat('DELETE /api/watchlists/:id', 'natural', `/api/watchlists/${list.id}`);

        // ---- hedge ----
        await repeat('POST /api/hedge/requests', 'natural', '/api/hedge/requests', { bookId: book.id, unitId: book.accountId, strategyId: held.id, trigger: 'manual' }, { changes: false, label: 'POST /api/hedge/requests (one request per position: the open one is reused)' });
        c.eq((await w.get('/api/hedge/requests', { bookId: book.id })).items.filter((r) => r.strategyId === held.id).length, 1, 'still one hedge request for the position');
        await repeat('POST /api/hedge/requests/:id/complete', 'natural', `/api/hedge/requests/${hedge.id}/complete`, { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 90 }, objective: { type: 'downside_protection' } });
        await repeat('POST /api/hedge/requests/:id/refresh', 'natural', `/api/hedge/requests/${hedge.id}/refresh`, undefined, { changes: false });
        await repeat('POST /api/hedge/requests/:id/preview', 'read-only', `/api/hedge/requests/${hedge.id}/preview`, { packageId: (await w.get(`/api/hedge/requests/${hedge.id}`)).response?.packages?.[0]?.id || 'none' }).catch(() => {});
        await repeat('POST /api/hedge/requests/:id/seen', 'natural', `/api/hedge/requests/${hedge.id}/seen`, undefined, { changes: false });
        await repeat('POST /api/hedge/refresh', 'natural', '/api/hedge/refresh', undefined, { changes: false });
        await repeat('POST /api/hedge/requests/:id/dismiss', 'natural', `/api/hedge/requests/${hedge.id}/dismiss`);
        {
          const listed = (await w.get('/api/analytics/strategies', { bookId: book.id }));
          const first = (listed.strategies || listed.items || listed.available || [])[0];
          c.ok(first?.id, 'setup: the demo fixture lists investment Strategies with ids', JSON.stringify(listed).slice(0, 300));
          await repeat('POST /api/analytics/strategies/resolve', 'natural', '/api/analytics/strategies/resolve', { bookId: book.id, name: 'Core Equity', id: first?.id }, { changes: false });
        }

        // ---- collateral ----
        await repeat('POST /api/books/:id/agreements', 'state', `${B}/agreements`, { name: 'CSA repeat two', counterparty: 'Dealer S', kind: 'bilateral', unitIds: [book.accountId], terms: {} }, { second: { status: 409 } });
        // Saving an agreement writes an audit event each time it is saved (no ledger effect), so a repeat needs its token.
        await repeat('PUT /api/books/:id/agreements/:agreementId', 'token', `${B}/agreements/${agr.id}`, { terms: { variationMargin: true, threshold: 5_000 } });
        await repeat('POST /api/books/:id/collateral/retry', 'natural', `${B}/collateral/retry`, undefined, { changes: false });
        {
          // The basis of a position is recorded once for its life: both attempts are refused and store nothing.
          covered.add('PUT /api/books/:id/positions/:positionId/collateral-basis');
          const fp = w.fingerprint();
          for (const n of ['first', 'second']) c.refused(await w.req('PUT', `${B}/positions/${swap.positions[0].positionId}/collateral-basis`, { basis: { type: 'uncollateralized' } }), { text: /already has its collateral basis on record/ }, `PUT collateral-basis on a position that has one (${n} attempt)`);
          w.sameStored(c, fp, w.fingerprint(), 'PUT collateral-basis: nothing stored');
        }
        {
          const again = await w.post(`${B}/agreements`, { name: 'CSA to close', counterparty: 'Dealer T', kind: 'bilateral', unitIds: [book.accountId], terms: {} });
          await repeat('POST /api/books/:id/agreements/:agreementId/close', 'state', `${B}/agreements/${again.id}/close`, undefined, { second: { text: /closed/ } });
        }

        // ---- alerts, settings, data connection, calendars ----
        const alert = (await w.get(`${B}/alerts`)).items[0];
        if (alert) await repeat('POST /api/alerts/:id/dismiss', 'natural', `/api/alerts/${alert.id}/dismiss`);
        else { covered.add('POST /api/alerts/:id/dismiss'); const r = await w.req('POST', '/api/alerts/999999/dismiss'); c.ok(r.ok, 'POST /api/alerts/:id/dismiss: dismissing an alert that is not open does nothing', r.error); await w.req('POST', '/api/alerts/999999/dismiss'); }
        await repeat('PUT /api/data/connection', 'natural', '/api/data/connection', { requestTimeoutMs: 9000 });
        await repeat('PUT /api/data/refresh', 'natural', '/api/data/refresh', { uiPollMs: 5000 });
        await repeat('POST /api/data/test', 'read-only', '/api/data/test', { port: 'market' });
        try { await repeat('PUT /api/calendars/:id/holidays', 'natural', '/api/calendars/US/holidays', { dates: ['2026-07-06'] }); } finally { await w.req('PUT', '/api/calendars/US/holidays', { dates: [] }); }

        // ---- engine and demo controls ----
        await repeat('POST /api/engine/tick', 'engine', '/api/engine/tick', undefined, { changes: false });
        const now = (await w.get('/api/status')).now;
        const fpTick = w.fingerprint();
        await repeat('POST /api/demo/advance', 'engine', '/api/demo/advance', { to: now }, { changes: false });
        c.eq(w.fingerprint(), fpTick, 'two engine cycles and two clock moves to the same instant store nothing when nothing is due');
        await repeat('POST /api/demo/fixtures/:kind', 'natural', '/api/demo/fixtures/quote', { instrumentId: stock.id, bid: 50.10, ask: 50.12, last: 50.11, bidSize: 5000, askSize: 5000 });
        await repeat('POST /api/demo/hedge-fixture', 'natural', '/api/demo/hedge-fixture', { enabled: false }, { changes: false });
        await repeat('POST /api/demo/hedge-script', 'natural', '/api/demo/hedge-script', { clear: true }, { changes: false });

        // ---- the list is complete -------------------------------------------------------------------------
        const source = readFileSync(new URL('../../../server/api.js', import.meta.url), 'utf8');
        const mutating = [...source.matchAll(/\br\.(post|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
        c.ok(mutating.length >= 45, 'the mutating routes were read from server/api.js', `${mutating.length} found`);
        const missing = [...new Set(mutating)].filter((r) => !covered.has(r));
        c.eq(missing, [], 'every mutating route of server/api.js is in this case');
        c.note(`${new Set(mutating).size} mutating routes, all repeated`);

        // The header form of the token (API level: a real HTTP header).
        if (w.level === 'api') {
          const key = token();
          const send = () => fetch(`${w.t.url}${B}/capital`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ type: 'deposit', ccy: 'USD', amount: 77 }) }).then((r) => r.json());
          const before = (await w.cash(book.id, book.treasuryId)).settled;
          const [a, b] = [await send(), await send()];
          c.eq([Boolean(a.duplicate), b.duplicate, b.eventId], [false, true, a.eventId], 'Idempotency-Key header: the repeat is a duplicate with the same event');
          c.near((await w.cash(book.id, book.treasuryId)).settled, before + 77, 'Idempotency-Key header: one deposit');
          const both = await Promise.all([token()].flatMap((k) => [0, 1, 2, 3].map(() => fetch(`${w.t.url}${B}/capital`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': k }, body: JSON.stringify({ type: 'deposit', ccy: 'USD', amount: 11 }) }).then((r) => r.json()))));
          c.eq(new Set(both.map((x) => x.eventId)).size, 1, 'four identical requests sent at once under one token are one event');
          c.near((await w.cash(book.id, book.treasuryId)).settled, before + 88, 'and one deposit');
        }
        await w.clean(c, book.id);
      }),
      browser: 'repeated requests are sent by a program, not typed; what a user can do twice (clicking a confirming button twice) is the browser case SB:stress:double-click-*',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'retries',
    title: 'Retries: a refused confirmation, an item waiting for a fixing',
    proves: 'Trying again after a refusal or while something is missing never produces a second effect: the retry either does the one thing, or reports that it was already done.',
    expected: '(a) A purchase is previewed at the ask 50.02; before it is confirmed the ask moves to 51.00 (1.96%, beyond the 0.5% tolerance). The confirmation is refused (409 preview_changed) with the changed figures, was and now, and the new preview; nothing is stored. Confirming the new preview fills 100 at 51.00. Sending the first, refused confirmation again does not buy a second time: it is answered as a duplicate of the one submission. (b) A call option expires on Friday with no closing price for its underlying: on Saturday the expiry item is blocked and says which fixing it waits for; five more cycles leave it blocked with no expiry event. When the closing price (98.00) is supplied, the next cycle expires the option once; later cycles add nothing.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Stress retries');
        const inst = await w.stock('SRT', QUOTE);
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, inst, 'buy', 100));
        const stale = w.confirmBody(pv);
        await w.fixture('quote', { instrumentId: inst.id, bid: 50.98, ask: 51.00, last: 50.99, bidSize: 5000, askSize: 5000 });
        const before = await w.books(book.id);
        const refused = await w.req('POST', '/api/strategies', stale);
        c.refused(refused, { status: 409, code: 'preview_changed' }, '(a) confirming figures that have moved');
        c.ok((refused.details?.changes || []).some((x) => x.was !== undefined && x.now !== undefined), '(a) the refusal lists what changed, was and now', JSON.stringify(refused.details?.changes).slice(0, 300));
        w.sameRows(c, before, await w.books(book.id), '(a) the refused confirmation');
        const next = refused.details?.preview;
        c.ok(next && next.blocking === 0, '(a) the refusal carries the new preview');
        const done = await w.must('POST', '/api/strategies', w.confirmBody(next));
        c.eq([done.strategy.orders[0].status, done.strategy.orders[0].avgPrice], ['filled', 51], '(a) the new figures are confirmed and filled at 51.00');
        const after = await w.books(book.id);
        const again = await w.req('POST', '/api/strategies', stale);
        c.ok(again.ok && again.body.duplicate === true && again.body.strategy.id === done.strategy.id, '(a) the first confirmation sent again is a duplicate of the one submission', again.ok ? JSON.stringify({ duplicate: again.body.duplicate }) : again.error);
        w.sameRows(c, after, await w.books(book.id), '(a) the repeated confirmation');

        const und = await w.stock('SRU', { bid: 100.00, ask: 100.10, last: 100.05, bidSize: 5000, askSize: 5000 });
        const opt = await w.instrument({ productId: 'equity_option', name: 'SRU 2026-03-06 100 Call', symbol: 'SRU 260306C100', marketView: 'US_DERIV', venue: 'CBOE', venueType: 'exchange', venueCountry: 'US', underlyingId: und.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'C', strike: 100, expiration: '2026-03-06', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
        await w.fixture('quote', { instrumentId: opt.id, bid: 2.00, ask: 2.10, last: 2.05, bidSize: 50, askSize: 50 });
        const os = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: und.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: opt.id, qty: 1 }] });
        await w.fixture('quote', { instrumentId: und.id, clear: true }); // no price source for the underlying on expiry day
        await w.clock('2026-03-07T15:00:00.000Z');
        const item = async () => (await w.get(`/api/books/${book.id}/accounting/pending`, { scope: 'book' })).lifecycle.find((t) => t.type === 'option.expiry');
        let it = await item();
        c.eq(it?.status, 'blocked', '(b) Saturday: the expiry item is blocked');
        c.match(it?.reason, /2026-03-06/, '(b) it says which fixing it waits for');
        const expiries = () => w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE 'option.ex%'`, book.id)[0].n;
        const mid = await w.books(book.id);
        for (let i = 0; i < 5; i++) await w.tick();
        c.eq([(await item())?.status, expiries()], ['blocked', 0], '(b) five more cycles: still blocked, no expiry event');
        w.sameBooks(c, mid, await w.books(book.id), '(b) the cycles while the fixing is missing');
        await w.fixture('close', { instrumentId: und.id, date: '2026-03-06', value: 98 });
        await w.tick();
        c.eq([expiries(), (await w.strategy(os.id)).positions.length], [1, 0], '(b) the fixing arrives: one expiry event, the option is gone');
        await w.tick(); await w.tick();
        c.eq(expiries(), 1, '(b) later cycles add nothing');
        await w.clean(c, book.id);
      }),
      browser: 'the refused confirmation and its second confirmation are read from the preview dialog in SB:stress:confirm-changed',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'kill-mid-confirmation',
    title: 'The server is killed while a twelve-leg package is being confirmed',
    proves: 'An interrupted submission leaves the database consistent: every ledger event is whole or absent, the legs that had not executed resume, nothing is duplicated, and the client can find out what happened by sending the same confirmation again.',
    expected: 'A package of twelve purchases (100 shares each of twelve stocks, asks 10.01 to 21.01) is confirmed, and the server process is killed (SIGKILL) a few milliseconds later; twelve trials with the kill at different moments, each in a new Book. After the restart, for every trial: the integrity check is clean (every event balanced, no fill without its ledger event, no entry without its event); either nothing of the package is stored, or the strategy instance exists with all twelve orders, each either completely filled once or not filled at all. The client then sends the same confirmation again: it is answered (as a duplicate when the first attempt had been stored) and there is still exactly one strategy instance with twelve orders. After one engine cycle all twelve are filled exactly once: twelve fills, 1,200 shares, and the Account owes the hand-calculated 18,624.00 (12 x 100 shares at 10.01, 11.01, ... 21.01 = 18,612.00, plus 12 x 1.00 commission).',
    levels: {
      engine: 'killing a process needs a process: API level only',
      api: async (w, c) => {
        const stocks = [];
        for (let i = 0; i < 12; i++) stocks.push(await w.stock(`K${String.fromCharCode(65 + i)}C`, { bid: 10 + i, ask: 10.01 + i, last: 10.005 + i, bidSize: 50_000, askSize: 50_000 }));
        const pack = async (book) => w.confirmBody(await w.post('/api/strategies/preview', { bookId: book.id, unitId: book.accountId, template: 'custom', legs: stocks.map((s) => ({ kind: 'trade', action: 'buy', instrumentId: s.id, qty: 100, orderType: 'market', tif: 'gtc' })) }));
        // How long an undisturbed confirmation takes, to spread the kills over it.
        let took = Infinity;
        for (const n of [1, 2, 3]) {
          const body = await pack(await w.book(`Kill confirm probe ${n}`));
          const t0 = performance.now();
          await w.must('POST', '/api/strategies', body);
          took = Math.min(took, performance.now() - t0);
        }
        c.note(`an undisturbed confirmation takes ${took.toFixed(0)} ms`);
        const seen = { nothing: 0, partly: 0, all: 0 };
        const TRIALS = 12;
        for (let i = 0; i < TRIALS; i++) {
          const book = await w.book(`Kill confirm ${i + 1}`);
          const body = await pack(book);
          const base = w.fingerprint();
          const url = w.t.url;
          const sent = fetch(`${url}/api/strategies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch((err) => ({ lost: String(err.cause?.code || err.message) }));
          await new Promise((r) => setTimeout(r, Math.max(0, (took * 1.2 * i) / (TRIALS - 1))));
          await w.t.kill();
          const answer = await sent;
          await w.t.start();
          const label = `trial ${i + 1} (${answer.lost ? 'no answer reached the client' : 'answered before the kill'})`;
          const integ = await w.integrity(book.id);
          c.ok(integ.ok, `${label}: integrity is clean after the restart`, integ.problems.join(' | '));
          const orders = w.sql('SELECT id, qty, filled_qty, status FROM orders WHERE book_id = ?', book.id);
          const strategies = w.sql('SELECT id FROM strategies WHERE book_id = ?', book.id);
          if (!strategies.length) {
            seen.nothing++;
            c.eq(orders.length, 0, `${label}: no strategy instance, so no order`);
            w.sameStored(c, base, w.fingerprint(), `${label}: nothing at all of the package is stored`);
          } else {
            c.eq([strategies.length, orders.length], [1, 12], `${label}: one strategy instance with all twelve orders`);
            c.ok(orders.every((o) => o.filled_qty === 0 || o.filled_qty === o.qty), `${label}: each order is filled completely or not at all`, JSON.stringify(orders.map((o) => o.filled_qty)));
            const filled = orders.filter((o) => o.filled_qty > 0).length;
            c.eq(w.sql('SELECT COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ?', book.id)[0].n, filled, `${label}: one fill for each filled order`);
            c.eq(w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'trade.fill'`, book.id)[0].n, filled, `${label}: one ledger event for each fill`);
            if (filled === 12) seen.all++; else seen.partly++;
          }
          // The client asks again with the same confirmation.
          const retry = await w.req('POST', '/api/strategies', body);
          c.ok(retry.ok, `${label}: the same confirmation sent again is answered`, retry.error);
          if (strategies.length) c.eq([retry.body?.duplicate, retry.body?.strategy?.id], [true, strategies[0].id], `${label}: as a duplicate of what was stored`);
          await w.tick();
          const end = await w.books(book.id);
          c.eq([end.counts.strategies, end.counts.orders, end.counts.fills], [1, 12, 12], `${label}: in the end one strategy instance, twelve orders, twelve fills`);
          c.eq(w.sql('SELECT qty, filled_qty, status FROM orders WHERE book_id = ?', book.id).every((o) => o.status === 'filled' && o.filled_qty === 100), true, `${label}: every order filled with 100`);
          // 100 x (10.01 + 11.01 + ... + 21.01) = 100 x 186.12 = 18,612.00; commission 12 x max(1.00, 100 x 0.005) = 12.00
          c.near((await w.cash(book.id, book.accountId)).payable, 18_624, `${label}: the Account owes 18,624.00`);
          c.eq(end.ledger.positions.reduce((a, p) => a + p.qty, 0), 1_200, `${label}: 1,200 shares held`);
          c.ok(end.ok, `${label}: integrity is clean at the end`, end.problems.join(' | '));
        }
        c.note(`state found after the kill, over ${TRIALS} trials: nothing stored ${seen.nothing}, some legs filled ${seen.partly}, all legs filled ${seen.all}`);
        c.ok(seen.nothing + seen.partly > 0, 'at least one kill landed before the package was complete', JSON.stringify(seen));
      },
      browser: 'a killed server seen from the browser is SB:stress:connection-loss',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'kill-mid-cycle',
    title: 'The server is killed during an engine cycle that catches up fifteen days',
    proves: 'An engine cycle interrupted at any point resumes after the restart without repeating what it had already booked and without losing what it had not.',
    expected: 'The "life" Book (lib/life.mjs) is put on on Monday 2 March. The clock is moved to Tuesday 17 March, which starts the catch-up cycle (settlements, a dividend, an option expiry, a loan maturity, fifteen days of accruals, a collateral call), and the server process is killed a few milliseconds into it; eight trials with the kill at different moments. After the restart the clock is put at 17 March again if the move had not been stored, and the engine runs. Every trial ends with a clean integrity check, the hand-calculated figures of lib/life.mjs, and books identical to an uninterrupted day-by-day run.',
    levels: {
      engine: 'killing a process needs a process: API level only',
      api: async (w, c) => {
        const r = await w.open({ tag: 'kill-cycle-reference' });
        const refLife = await openLife(r);
        await liveDayByDay(r);
        const ref = await lifeDigest(r, refLife);
        // How long an undisturbed catch-up takes.
        const p = await w.open({ tag: 'kill-cycle-probe' });
        await openLife(p);
        const t0 = performance.now();
        await p.clock(LIFE_END);
        const took = performance.now() - t0;
        c.note(`an undisturbed catch-up cycle takes ${took.toFixed(0)} ms`);
        const TRIALS = 8;
        const found = [];
        for (let i = 0; i < TRIALS; i++) {
          const k = await w.open({ tag: `kill-cycle-${i + 1}` });
          const L = await openLife(k);
          const before = k.sql('SELECT COUNT(*) AS n FROM events')[0].n;
          const sent = fetch(`${k.t.url}/api/demo/advance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: LIFE_END }) }).then((x) => x.json()).catch((err) => ({ lost: String(err.cause?.code || err.message) }));
          await new Promise((res) => setTimeout(res, Math.max(0, (took * 1.2 * i) / (TRIALS - 1))));
          await k.t.kill();
          await sent;
          await k.t.start();
          const booked = k.sql('SELECT COUNT(*) AS n FROM events')[0].n - before;
          found.push(booked);
          const label = `trial ${i + 1} (${booked} events had been booked when it was killed)`;
          const mid = await k.integrity(L.book.id);
          c.ok(mid.ok, `${label}: integrity is clean right after the restart`, mid.problems.join(' | '));
          await k.clock(LIFE_END);
          await k.tick(); await k.tick();
          await checkLife(k, c, L, label);
          sameLife(c, ref, await lifeDigest(k, L), label);
        }
        c.note(`events booked before each kill: ${found.join(', ')}`);
        c.ok(new Set(found).size > 1, 'the kills landed at different points of the cycle', found.join(', '));
      },
      browser: 'a killed server seen from the browser is SB:stress:connection-loss',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'service-stops-answering',
    title: 'A Shaffer service address that stops answering',
    proves: 'When a configured service address stops answering, the Terminal says so within its timeout, keeps showing waiting states, and loses no paper history; when the address answers again nothing has changed.',
    world: { demo: false },
    expected: 'Normal mode (no demo feed). A Book holds 100 shares bought at a stated price of 50.00 and marked by hand at 51.00. A MarketData address is configured that answers: the connection test reports it reachable; data still shows "Awaiting Shaffer data connection" (no service contract exists yet) and prices are the manual ones. The address then stops answering in two ways: the connection is refused, and the connection is accepted but never answered. Each time the connection test answers within the configured timeout (1.5 seconds, plus a margin) and reports the address unreachable with the reason; quotes still carry the waiting message and the manual mark; the engine cycle completes; every stored row of the paper books is identical to before, and the net asset value is unchanged (1,000,000.00 + 100 x (51.00 - 50.00) = 1,000,100.00). When the address answers again it is reported reachable, and still nothing has changed.',
    levels: {
      engine: 'a service that stops answering is a network condition: API level only',
      api: async (w, c) => {
        const { createServer } = await import('node:http');
        const { createServer: createTcp } = await import('node:net');
        const book = await w.book('Service stops answering', { settings: null });
        // Normal mode runs on the real clock: the instrument trades every day so the case does not depend on the weekday.
        const inst = await w.instrument({ productId: 'common_stock', name: 'Away Works Inc.', symbol: 'AWAY', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {}, conventions: { tradingCalendar: 'ALLDAYS' } });
        const s = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 100, statedPrice: 50 }] });
        c.eq(s.orders[0].status, 'filled', 'setup: 100 shares bought at the stated price');
        await w.post('/api/observations', { kind: 'price', subject: inst.id, value: 51, currency: 'USD', note: 'manual mark' });
        const nav = async () => (await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' })).nav.value;
        c.near(await nav(), 1_000_100, 'setup: net asset value 1,000,100.00 on the manual mark');

        const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
        const close = (srv) => new Promise((res) => { srv.closeAllConnections?.(); srv.close(() => res()); });
        let stub = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"service":"stub"}'); });
        const port = await listen(stub);
        w.defer(() => close(stub).catch(() => {}));
        await w.put('/api/data/connection', { marketDataUrl: `http://127.0.0.1:${port}`, requestTimeoutMs: 1500 });
        const test = async () => { const t0 = performance.now(); const r = await w.post('/api/data/test', { port: 'market' }); return { ...r.result, ms: performance.now() - t0 }; };
        const waiting = async (label) => {
          const q = await w.get('/api/quotes', { ids: inst.id });
          c.eq(q.awaitingMessage, 'Awaiting Shaffer data connection', `${label}: quotes carry the waiting message`);
          c.eq([q.quotes[inst.id].observation?.value, q.quotes[inst.id].observation?.status], [51, 'manual'], `${label}: the price shown is the manual mark, labelled manual`);
          const st = await w.get('/api/status');
          c.match(st.data.awaitingMessage, /Awaiting Shaffer data connection/, `${label}: the status says awaiting`);
        };
        let r = await test();
        c.eq(r.reachable, true, 'the configured address answers: reported reachable');
        await waiting('address answering');
        const fp = w.fingerprint();
        const before = await w.books(book.id);

        // 1. Connection refused.
        await close(stub);
        r = await test();
        c.eq(r.reachable, false, 'connection refused: reported unreachable');
        c.match(r.detail, /Could not reach the configured address/, 'with the reason');
        c.ok(r.ms < 2500, 'answered within the timeout', `${r.ms.toFixed(0)} ms`);
        await waiting('connection refused');
        const tick1 = await w.tick();
        c.ok(tick1 && !tick1.error, 'the engine cycle completes', JSON.stringify(tick1));
        w.sameStored(c, fp, w.fingerprint(), 'connection refused: every stored row is as before');

        // 2. Accepts the connection and never answers.
        const held = new Set();
        const hang = createTcp((socket) => { held.add(socket); socket.on('close', () => held.delete(socket)); socket.on('error', () => {}); /* accept and say nothing */ });
        await new Promise((res) => hang.listen(port, '127.0.0.1', res));
        const stopHanging = () => new Promise((res) => { for (const sk of held) sk.destroy(); hang.close(() => res()); });
        w.defer(() => stopHanging().catch(() => {}));
        r = await test();
        c.eq(r.reachable, false, 'no answer: reported unreachable');
        c.ok(r.ms >= 1400 && r.ms < 3500, 'after the configured 1.5 second timeout, not later', `${r.ms.toFixed(0)} ms`);
        await waiting('no answer');
        const t1 = performance.now();
        const tick2 = await w.tick();
        c.ok(tick2 && !tick2.error && performance.now() - t1 < 3000, 'the engine cycle completes without waiting for the service', `${(performance.now() - t1).toFixed(0)} ms ${JSON.stringify(tick2)}`);
        const pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq(pos.positions.length, 1, 'the Accounting page still loads its positions');
        w.sameStored(c, fp, w.fingerprint(), 'no answer: every stored row is as before');
        await stopHanging();

        // 3. Answering again.
        stub = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"service":"stub"}'); });
        await new Promise((res) => stub.listen(port, '127.0.0.1', res));
        r = await test();
        c.eq(r.reachable, true, 'the address answers again: reported reachable');
        await w.restart();
        w.sameStored(c, fp, w.fingerprint(), 'after reconnection and a restart: every stored row is as before');
        w.sameBooks(c, before, await w.books(book.id), 'after reconnection and a restart');
        c.near(await nav(), 1_000_100, 'net asset value unchanged');
        await w.clean(c, book.id);
      },
      browser: async (b, c) => b.cases.serviceAway(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  // Duplicate clicks on every confirming button (browser level only: a click is a browser event; what a
  // program can send twice is SE/SA:stress:repeated-requests and SE/SA:nodup:concurrent-confirmations).
  {
    id: 'double-click-confirm',
    title: 'Double click on "Confirm paper trade"',
    proves: 'Double-clicking the confirmation of a trade preview submits the package once.',
    expected: 'A purchase of 100 shares at the ask 50.02 is previewed from the ticket and its Confirm button is double-clicked. Whatever the page sends, there is one strategy instance, one order and one fill of 100 at 50.02, and the Account owes 5,003.00 once.',
    levels: { engine: 'a click is a browser event', api: 'a click is a browser event', browser: (b, c) => b.cases.doubleClickConfirm(b, c) },
  },
  {
    id: 'double-click-transfer',
    title: 'Double click on "Record transfer" and "Record deposit"',
    proves: 'Double-clicking a button that records a cash movement records it once.',
    expected: 'A transfer of 25,000.00 from Treasury to the Account is entered and "Record transfer" is double-clicked: one request leaves the page, one transfer is recorded, the Account holds 525,000.00. A deposit of 40,000.00 with "Record deposit" double-clicked: one request, one deposit, Treasury holds 515,000.00.',
    levels: { engine: 'a click is a browser event', api: 'a click is a browser event', browser: (b, c) => b.cases.doubleClickTransfer(b, c) },
  },

  {
    id: 'connection-loss',
    title: 'The browser loses the server mid-session and recovers',
    proves: 'A lost answer, a server that goes away and a server that comes back never leave a stale screen that looks current, and never turn one instruction into two.',
    world: { engine: 'on' },
    expected: '(1) A transfer of 10,000.00 is recorded by the server but its answer is lost before it reaches the page: the dialog says the server could not be reached and keeps what was typed; the user presses "Record transfer" again; there is exactly one transfer of 10,000.00 in the books. (2) The server process is killed: within the page\'s refresh interval the page itself says that it cannot reach the server; a transfer tried meanwhile is refused on the dialog with that reason. (3) The server is started again and 3,000.00 is deposited behind the page\'s back: nothing was recorded for the attempt made while it was away; the notice disappears and the Treasury page shows 493,000.00 without being reloaded; a transfer of 7,000.00 is then recorded once. In the end two transfers exist (10,000.00 and 7,000.00) and the integrity check is clean.',
    levels: { engine: 'a browser losing its server needs a browser and a server', api: 'the server side of this (kill, restart, same token again) is SA:stress:kill-mid-confirmation and SA:stress:repeated-requests', browser: (b, c) => b.cases.connectionLoss(b, c) },
  },
];
