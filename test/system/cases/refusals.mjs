// Refusals and blocks: what the Terminal must not do, and how it says so.
//
// Every case states the safe behaviour first (`expected`), then provokes the situation. A refusal
// counts only if it is visible (a blocking check in the preview, an error answer with its reason, a
// rejected or waiting order with its reason, a row on the Failed tab, an alert) and leaves the
// books as they were: w.sameBooks compares ledger balances by owner, account and currency, every
// position and all cash buckets; w.sameRows compares the stored row counts.
//
// Figures: a market buy fills at the ask, a market sell at the bid; commission is 0.005 a share with
// a 1.00 minimum per order (the Book settings in lib/world.mjs); US equities settle T+1.

import { evening, FRI, MON, MON2, SAT, THU, TUE, WED } from '../lib/world.mjs';

export const area = 'refusals';

const errorsOf = (pv) => (pv.checks || []).filter((x) => x.level === 'error');
const errorText = (pv) => errorsOf(pv).map((x) => x.message).join(' | ');
/** A preview answer must block: either the route refuses, or the preview carries a blocking error matching `text`. */
function blocked(c, res, text, label) {
  if (!res.ok) return c.refused(res, { text }, label);
  const pv = res.body;
  const ok = c.ok(pv.blocking >= 1, `${label}: the preview blocks`, `blocking=${pv.blocking}; checks: ${JSON.stringify(pv.checks)}`);
  if (ok && c.match(errorText(pv), text, `${label}: the blocking reason`)) c.note(`${label}: "${errorText(pv)}"`);
  return ok;
}
/** Confirming a blocked preview anyway (the screen disables the button; a client could still send it) must be refused. */
async function confirmRefused(w, c, pv, label) {
  const r = await w.confirm(pv);
  c.refused(r, { status: 422, code: 'preview_failed' }, `${label}: confirming the blocked preview anyway`);
}

const both = (fn) => ({ engine: fn, api: fn });

export default [
  // ---------------------------------------------------------------------------------------------------
  {
    id: 'cash-trade',
    title: 'Insufficient cash: a purchase larger than the cash available',
    proves: 'A trade the Account cannot pay for is blocked before anything is ordered.',
    expected: 'Buying 20,000 shares at 50.02 (1,000,400.00 plus 100.00 commission) with 500,000.00 available: the preview carries a blocking error naming the shortfall of 500,500.00 USD; a confirmation sent anyway is refused (422 preview_failed); no order, fill, event or entry is stored; cash and positions are unchanged; a purchase that fits (200 shares) still goes through afterwards.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal cash trade');
        const inst = await w.stock('RFCT');
        const before = await w.books(book.id);
        const res = await w.preview(w.ticketInput(book, inst, 'buy', 20_000));
        if (blocked(c, res, /short 500,500\.00 USD/, 'buy 20,000') && res.ok) {
          // 20,000 x 50.02 = 1,000,400; commission 20,000 x 0.005 = 100; required 1,000,500; available 500,000; shortfall 500,500
          c.near(res.body.totals.cash.USD.required, 1_000_500, 'cash required in the preview');
          c.near(res.body.totals.cash.USD.shortfall, 500_500, 'shortfall in the preview');
          await confirmRefused(w, c, res.body, 'buy 20,000');
        }
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refusal');
        w.sameRows(c, before, after, 'after the refusal');
        const s = await w.buy(book, inst, 200);
        c.eq(s.orders[0].status, 'filled', 'a purchase that fits is filled');
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks (the same preview, read from the dialog)',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'cash-transfer',
    title: 'Insufficient cash: a transfer larger than the settled cash that is free',
    proves: 'A transfer cannot overdraw its source, cannot take cash that is committed to an unsettled purchase, and never converts currency.',
    expected: 'With 500,000.00 USD in the Account: a transfer of 600,000.00 to Treasury is refused (400 insufficient_cash) naming 500,000.00 available. After buying 200 shares (10,005.00 payable tomorrow) a transfer of 495,000.00 is refused naming 489,995.00 available, and 489,995.00 goes through. A transfer in EUR (none held), of zero or of a negative amount is refused. Every refusal stores nothing.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal cash transfer');
        const inst = await w.stock('RFTR');
        const path = `/api/books/${book.id}/transfers`;
        const out = (amount, ccy = 'USD') => w.req('POST', path, { fromUnitId: book.accountId, toUnitId: book.treasuryId, ccy, amount });
        let before = await w.books(book.id);
        c.refused(await out(600_000), { status: 400, code: 'insufficient_cash', text: /500,000\.00 USD/ }, 'transfer 600,000');
        c.refused(await out(1_000, 'EUR'), { status: 400, code: 'insufficient_cash', text: /0\.00 EUR/ }, 'transfer 1,000 EUR with no EUR held');
        c.refused(await out(0), { status: 400, text: /positive amount/ }, 'transfer of zero');
        c.refused(await out(-50), { status: 400, text: /positive amount/ }, 'transfer of a negative amount');
        c.refused(await w.req('POST', path, { fromUnitId: book.accountId, toUnitId: book.accountId, ccy: 'USD', amount: 10 }), { status: 400, text: /different/ }, 'transfer to itself');
        let after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refused transfers');
        w.sameRows(c, before, after, 'after the refused transfers');
        await w.buy(book, inst, 200); // 200 x 50.02 + 1.00 = 10,005.00 payable on Tuesday
        before = await w.books(book.id);
        c.refused(await out(495_000), { status: 400, code: 'insufficient_cash', text: /489,995\.00 USD/ }, 'transfer of cash committed to an unsettled purchase');
        after = await w.books(book.id);
        w.sameRows(c, before, after, 'after the refused transfer of committed cash');
        const ok = await out(489_995);
        c.ok(ok.ok, 'the free 489,995.00 can be transferred', ok.error);
        const cash = await w.cash(book.id, book.accountId);
        c.near(cash.settled, 10_005, 'settled cash left in the Account');
        await w.clock(TUE);
        const end = await w.cash(book.id, book.accountId);
        c.near(end.settled, 0, 'after settlement the Account has paid for its purchase and holds no cash');
        c.near(end.payable, 0, 'nothing is left payable');
        await w.clean(c, book.id);
      }),
      browser: (b, c) => b.cases.transferRefused(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'cash-withdrawal',
    title: 'Insufficient cash: a capital withdrawal larger than Treasury holds',
    proves: 'Capital cannot be withdrawn beyond the settled cash Treasury has free.',
    expected: 'Treasury holds 500,000.00 USD after funding the Account: a withdrawal of 600,000.00 is refused (400 insufficient_cash) naming 500,000.00; nothing is stored. Withdrawing exactly 500,000.00 goes through, and a further 0.01 is refused. The Account\'s 500,000.00 is never drawn on.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal cash withdrawal');
        const path = `/api/books/${book.id}/capital`;
        const before = await w.books(book.id);
        c.refused(await w.req('POST', path, { type: 'withdrawal', ccy: 'USD', amount: 600_000 }), { status: 400, code: 'insufficient_cash', text: /500,000\.00 USD/ }, 'withdraw 600,000');
        c.refused(await w.req('POST', path, { type: 'withdrawal', ccy: 'USD', amount: 0 }), { status: 400, text: /positive amount/ }, 'withdraw zero');
        c.refused(await w.req('POST', path, { type: 'withdrawal', ccy: 'USD', amount: -5 }), { status: 400, text: /positive amount/ }, 'withdraw a negative amount');
        c.refused(await w.req('POST', path, { type: 'payout', ccy: 'USD', amount: 5 }), { status: 400 }, 'an unknown capital movement');
        let after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refused withdrawals');
        w.sameRows(c, before, after, 'after the refused withdrawals');
        const ok = await w.req('POST', path, { type: 'withdrawal', ccy: 'USD', amount: 500_000 });
        c.ok(ok.ok, 'withdrawing exactly what Treasury holds goes through', ok.error);
        c.refused(await w.req('POST', path, { type: 'withdrawal', ccy: 'USD', amount: 0.01 }), { status: 400, code: 'insufficient_cash', text: /0\.00 USD/ }, 'withdraw 0.01 from an empty Treasury');
        after = await w.books(book.id);
        c.near((await w.cash(book.id, book.accountId)).settled, 500_000, 'the Account still holds its 500,000.00');
        c.near((await w.cash(book.id, book.treasuryId)).settled, 0, 'Treasury holds nothing');
        await w.clean(c, book.id);
      }),
      browser: (b, c) => b.cases.withdrawalRefused(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'cash-repayment',
    title: 'Insufficient cash: repaying a loan early, and at maturity',
    proves: 'A repayment the borrower cannot cover is not made in part and never overdraws; it stays visible until cash arrives, and is then made once.',
    expected: 'The Account borrows 100,000.00 USD at 5% fixed (ACT/360) due 1 April, then sends 590,000.00 to Treasury, leaving 10,000.00. Early repayment: the preview blocks naming the 90,000.00 shortfall, a confirmation sent anyway is refused, the liability stays 100,000.00. At maturity (1 April) the repayment fails visibly: one lifecycle failure on the Failed tab and a funding alert; cash stays 10,000.00, not negative. Further cycles add nothing. After 200,000.00 of funding the next cycle repays once: principal 100,000.00 plus interest 100,000 x 5% x 30 / 360 = 416.67; cash 109,583.33; no liability, no accrual left; exactly two events ever touched the loan principal (drawdown and repayment).',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal cash repayment');
        const leg = { kind: 'loan', action: 'borrow_cash', qty: 100_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'System test loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-04-01' } } };
        const s = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [leg] });
        await w.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.accountId, toUnitId: book.treasuryId, ccy: 'USD', amount: 590_000 });
        const acctCash = async () => (await w.cash(book.id, book.accountId)).settled;
        const liab = async () => -(await w.balance(book.id, book.accountId, 'loan.liab'));
        c.near(await acctCash(), 10_000, 'cash after sending 590,000.00 to Treasury');

        // early repayment
        const before = await w.books(book.id);
        const pv = await w.req('POST', `/api/strategies/${s.id}/preview-action`, { action: 'close' });
        if (blocked(c, pv, /short 90,000\.00 USD/, 'early repayment') && pv.ok) await confirmRefused(w, c, pv.body, 'early repayment');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refused early repayment');
        w.sameRows(c, before, after, 'after the refused early repayment');

        // maturity without the cash
        await w.clock('2026-04-01T15:00:00.000Z'); // 11:00 New York on the maturity date
        let failed = await w.get(`/api/books/${book.id}/accounting/failed`, { scope: 'book' });
        c.eq(failed.lifecycleFailures.length, 1, 'one lifecycle failure is listed on the Failed tab');
        if (failed.lifecycleFailures[0]) c.note(`Failed tab: "${failed.lifecycleFailures[0].reason || failed.lifecycleFailures[0].blockedReason || JSON.stringify(failed.lifecycleFailures[0]).slice(0, 200)}"`);
        let alerts = (await w.get(`/api/books/${book.id}/alerts`)).items;
        c.ok(alerts.some((a) => a.code === 'funding.failed'), 'a funding alert is raised', JSON.stringify(alerts.map((a) => a.code)));
        c.near(await acctCash(), 10_000, 'cash did not go negative to repay');
        c.near(await liab(), 100_000, 'the principal is still owed in full: no part repayment');
        const mid = await w.books(book.id);
        await w.tick(); await w.tick(); await w.tick();
        const mid2 = await w.books(book.id);
        w.sameBooks(c, mid, mid2, 'three more cycles while the cash is missing');
        c.eq(mid2.counts.entries, mid.counts.entries, 'retries post no ledger entries');

        // funding arrives
        await w.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.treasuryId, toUnitId: book.accountId, ccy: 'USD', amount: 200_000 });
        await w.tick();
        c.near(await liab(), 0, 'the loan is repaid');
        // 10,000 + 200,000 - 100,000 - 416.67 (100,000 x 0.05 x 30 / 360)
        c.near(await acctCash(), 109_583.33, 'cash after repayment of principal and 416.67 interest');
        c.eq(await w.balance(book.id, book.accountId, 'accrued.liab'), 0, 'no accrued interest is left');
        c.near(await w.balance(book.id, book.accountId, 'pnl.funding'), 416.67, 'funding expense is the interest, once');
        await w.tick(); await w.tick();
        c.near(await acctCash(), 109_583.33, 'further cycles do not repay again');
        const principalEvents = w.sql(`SELECT COUNT(DISTINCT event_id) AS n FROM entries WHERE book_id = ? AND account = 'loan.liab'`, book.id)[0].n;
        c.eq(principalEvents, 2, 'events that ever moved the loan principal (drawdown, repayment)');
        failed = await w.get(`/api/books/${book.id}/accounting/failed`, { scope: 'book' });
        c.eq(failed.lifecycleFailures.length, 0, 'the Failed tab is clear again');
        alerts = (await w.get(`/api/books/${book.id}/alerts`)).items;
        c.ok(!alerts.some((a) => a.code === 'funding.failed'), 'the funding alert is resolved');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.repaymentRefused(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'cash-settlement-day',
    title: 'Insufficient cash on settlement day',
    proves: 'A purchase whose cash has not arrived by its settlement date fails visibly, is never funded silently, and settles exactly once when the cash is there.',
    expected: 'Account funded with 100,000.00. Monday: buy 1,000 AAA at 50.02 (50,025.00 with commission, paid Tuesday; cash 49,975.00). Tuesday: sell the 1,000 at 50.00 with settlement stated as T+3 (49,995.00 due Friday) and buy 1,800 BBB at 50.02 (90,045.00 due Wednesday; allowed because 49,975.00 + 49,995.00 = 99,970.00 is available to trade). Wednesday: the 90,045.00 payment fails: one settlement failure on the Failed tab naming 49,975.00 available and 90,045.00 due; settled cash stays 49,975.00; the payable stays; the BBB position stands. More cycles and Thursday change nothing and post nothing. Friday: the sale proceeds arrive and the purchase settles: cash 9,925.00, nothing payable, no failure, and exactly one payment event exists for that settlement.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal settlement day', { funding: 100_000 });
        const aaa = await w.stock('AAA');
        const bbb = await w.stock('BBB');
        const cashOf = () => w.cash(book.id, book.accountId);
        const s1 = await w.buy(book, aaa, 1_000);
        await w.clock(TUE);
        c.near((await cashOf()).settled, 49_975, 'cash on Tuesday after paying for AAA');
        await w.closeOut(s1.id, { positionIds: [s1.positions[0].positionId], qty: 1_000, order: { orderType: 'market', tif: 'day', settle: { lag: 3 } } });
        let cash = await cashOf();
        c.near(cash.receivable, 49_995, 'receivable from the sale that settles on Friday');
        const s2 = await w.buy(book, bbb, 1_800);
        c.eq(s2.orders[0].fills[0].settleDate, '2026-03-04', 'the BBB purchase settles on Wednesday');
        const stl = w.sql(`SELECT id FROM settlements WHERE book_id = ? AND amount < 0 AND due_date = '2026-03-04'`, book.id);
        c.eq(stl.length, 1, 'one payment is queued for Wednesday');

        await w.clock(WED);
        let failed = await w.get(`/api/books/${book.id}/accounting/failed`, { scope: 'book' });
        c.eq(failed.settlementFailures.length, 1, 'Wednesday: one settlement failure is listed on the Failed tab');
        c.match(failed.settlementFailures[0]?.error, /49,975\.00 USD available, 90,045\.00 USD due/, 'the failure names what is available and what is due');
        cash = await cashOf();
        c.near(cash.settled, 49_975, 'settled cash did not go negative, and was not part-used');
        c.near(cash.payable, 90_045, 'the amount is still payable');
        const held = (await w.strategy(s2.id)).positions[0];
        c.eq(held?.qty, 1_800, 'the trade itself stands: 1,800 BBB are held');
        const wed = await w.books(book.id);
        await w.tick(); await w.tick();
        await w.clock(THU);
        const thu = await w.books(book.id);
        w.sameBooks(c, wed, thu, 'retries on Wednesday and Thursday');
        c.eq(thu.counts.entries, wed.counts.entries, 'retries post no ledger entries');
        c.eq((await w.get(`/api/books/${book.id}/accounting/failed`, { scope: 'book' })).settlementFailures.length, 1, 'Thursday: still exactly one failure, not one per retry');

        await w.clock(FRI);
        await w.tick();
        cash = await cashOf();
        c.near(cash.settled, 9_925, 'Friday: 49,975.00 + 49,995.00 - 90,045.00');
        c.near(cash.payable, 0, 'nothing is payable');
        c.near(cash.receivable, 0, 'nothing is receivable');
        failed = await w.get(`/api/books/${book.id}/accounting/failed`, { scope: 'book' });
        c.eq(failed.settlementFailures.length, 0, 'the Failed tab is clear');
        const paid = w.sql(`SELECT s.status, s.attempts, (SELECT COUNT(*) FROM events e WHERE e.type = 'settlement.pay' AND json_extract(e.data, '$.settlementId') = s.id) AS events FROM settlements s WHERE s.id = ?`, stl[0]?.id);
        c.eq(paid[0]?.status, 'settled', 'the settlement is settled');
        c.eq(paid[0]?.events, 1, 'exactly one payment event exists for it');
        await w.clean(c, book.id);
      }),
      browser: 'the failure is produced by time passing, not by a user action; the Failed tab row it leaves is read at browser level in SB:refusals:failed-tab',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'borrow-unavailable',
    title: 'Securities borrow unavailable: the short sale is blocked',
    proves: 'A short sale never executes without its borrow, whether the borrow is refused in the preview or at execution.',
    expected: 'No borrow data at all: the preview blocks (nothing is assumed). Borrow marked unavailable: the preview blocks naming the instrument; a confirmation sent anyway is refused; nothing is stored. Borrow available when confirmed on a Saturday (both legs wait for Monday, each with the reason shown) but withdrawn on Sunday: on Monday the borrow leg is rejected with the reason, the dependent short sale is rejected because its dependency failed, the package is failed (not complete), and there is no position, no restricted cash and no ledger entry.',
    world: { at: MON },
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal borrow unavailable');
        const inst = await w.stock('RFBU');
        const before = await w.books(book.id);
        blocked(c, await w.preview(w.ticketInput(book, inst, 'sell_short', 100)), /no borrow availability data for RFBU/, 'short with no borrow data');
        await w.fixture('borrow', { instrumentId: inst.id, available: false, quantity: 0, feeRate: 0.01 });
        const res = await w.preview(w.ticketInput(book, inst, 'sell_short', 100));
        if (blocked(c, res, /RFBU is not available to borrow/, 'short with the borrow unavailable') && res.ok) await confirmRefused(w, c, res.body, 'short with the borrow unavailable');
        let after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the blocked previews');
        w.sameRows(c, before, after, 'after the blocked previews');

        // Available at confirmation, gone at execution.
        await w.fixture('borrow', { instrumentId: inst.id, available: true, quantity: 1_000, feeRate: 0.01 });
        await w.clock(SAT);
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, inst, 'sell_short', 100, { order: { tif: 'gtc' } }));
        c.eq(pv.blocking, 0, 'Saturday: the short previews without a block');
        c.ok(pv.checks.some((x) => x.code === 'not-trading-day' && /will be matched on 2026-03-09/.test(x.message)), 'the preview says the market is closed and when the order will be matched', JSON.stringify(pv.checks.map((x) => x.code)));
        const sub = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        let s = sub.strategy;
        c.ok(s.orders.every((o) => ['working', 'pending'].includes(o.status) && o.filledQty === 0), 'both legs wait, unfilled', JSON.stringify(s.orders.map((o) => [o.status, o.filledQty])));
        for (const o of s.orders) c.match(o.statusReason, /Market closed today on calendar US \(2026-03-07 is a Saturday\); will be matched on 2026-03-09|Waiting on leg 1/, `the waiting ${o.kind} leg says why`);
        c.eq(s.positions.length, 0, 'nothing is held while the market is closed');
        await w.fixture('borrow', { instrumentId: inst.id, available: false, quantity: 0, feeRate: 0.01 });
        await w.clock(MON2);
        s = await w.strategy(s.id);
        c.eq(s.orders.map((o) => o.status), ['rejected', 'rejected'], 'Monday: the borrow leg and the short sale are both rejected');
        c.match(s.orders[0].statusReason, /Borrow unavailable for RFBU/, 'the borrow leg says why');
        c.match(s.orders[1].statusReason, /Dependency failed/, 'the short sale says its dependency failed');
        c.eq(s.status, 'failed', 'the package is failed');
        c.eq(s.complete, false, 'and is not called complete');
        c.eq(s.positions.length, 0, 'no position exists');
        after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the rejected short');
        c.eq(after.counts.entries, before.counts.entries, 'no ledger entry was posted');
        c.eq(after.counts.fills, 0, 'no fill exists');
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks (short sale with the borrow unavailable)',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'borrow-exhausted',
    title: 'Securities borrow exhausted: more than is available to borrow',
    proves: 'A short sale cannot be larger than the quantity available to borrow.',
    expected: '300 shares are available to borrow: a short sale of 500 is blocked in the preview naming 300 available and 500 needed; a confirmation sent anyway is refused; nothing is stored. A short sale of 300 executes: position -300 at the bid 50.00, proceeds of 15,000.00 restricted (not buying power).',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal borrow exhausted');
        const inst = await w.stock('RFBE');
        await w.fixture('borrow', { instrumentId: inst.id, available: true, quantity: 300, feeRate: 0.01 });
        const before = await w.books(book.id);
        const res = await w.preview(w.ticketInput(book, inst, 'sell_short', 500));
        if (blocked(c, res, /only 300 RFBE is available to borrow.*500 is needed/, 'short 500 with 300 available') && res.ok) await confirmRefused(w, c, res.body, 'short 500 with 300 available');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refusal');
        w.sameRows(c, before, after, 'after the refusal');
        const s = await w.short(book, inst, 300);
        c.eq(s.orders.map((o) => o.status), ['filled', 'filled'], 'a short sale of 300 executes');
        c.eq(s.positions.find((p) => p.family === 'equity')?.qty, -300, 'position is short 300');
        c.near(s.orders[1].avgPrice, 50.00, 'sold at the bid');
        const cash = await w.cash(book.id, book.accountId);
        // The 15,000.00 of proceeds (300 x 50.00) is not buying power, and 30% of the short's market value
        // (300 x 50.01 last = 15,003.00; 30% = 4,500.90) is reserved as margin: at most 500,000.00 - 4,500.90 can be traded with.
        c.ok(cash.availableToTrade <= 495_499.10 + 0.005, 'available to trade does not include the sale proceeds and is reduced by the 30% margin hold', `available to trade ${cash.availableToTrade}`);
        c.near(cash.settled, 500_000, 'settled cash is unchanged on trade date');
        await w.clock(TUE);
        const cash2 = await w.cash(book.id, book.accountId);
        // Collateral held against the borrow is 102% of market value: 1.02 x 300 x 50.01 (last) = 15,303.06
        c.near(cash2.restricted, 15_303.06, 'restricted cash after settlement and the collateral mark: 102% x 300 x 50.01');
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks (quantity above the borrow available)',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'borrow-recalled',
    title: 'Securities borrow recalled by the lender',
    proves: 'A recalled borrow is covered once, at the deadline, by one forced buy-in; recalling again does not double it.',
    expected: 'Short 300 at the bid 50.00 against a borrow of 300. The lender recalls the borrow with two business days\' notice: an alert names the recall and its deadline (Wednesday 4 March); the short stays open meanwhile. A second recall of the same borrow before the deadline does not create a second buy-in. On Wednesday one forced buy-in of 300 fills at the ask 50.02 and the 300 borrowed shares are returned: exactly one buy-in event, one cover order with one fill, no position, no restricted cash, no margin hold; realized P&L is 300 x (50.00 - 50.02) = -6.00 and commissions 2 x 1.50 = 3.00. Later cycles add nothing.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal borrow recalled');
        const inst = await w.stock('RFBR');
        await w.fixture('borrow', { instrumentId: inst.id, available: true, quantity: 1_000, feeRate: 0.01 });
        const s = await w.short(book, inst, 300);
        const loan = s.positions.find((p) => p.family === 'secloan');
        const r1 = await w.req('POST', `/api/positions/${loan.positionId}/lifecycle`, { action: 'recall', days: 2 });
        c.ok(r1.ok, 'the recall is recorded', r1.error);
        c.eq(r1.body?.result?.due, '2026-03-04', 'the deadline is two business days on');
        const alerts = (await w.get(`/api/books/${book.id}/alerts`)).items;
        c.ok(alerts.some((a) => a.code === 'secloan.recalled' && /2026-03-04/.test(a.message)), 'an alert names the recall and its deadline', JSON.stringify(alerts.map((a) => [a.code, a.message])));
        const r2 = await w.req('POST', `/api/positions/${loan.positionId}/lifecycle`, { action: 'recall', days: 2 });
        c.note(`second recall: ${r2.ok ? 'accepted' : `refused (${r2.error})`}`);
        const tasks = w.sql(`SELECT COUNT(*) AS n FROM tasks WHERE book_id = ? AND position_id = ? AND type = 'secloan.recall' AND status IN ('pending','blocked','failed')`, book.id, loan.positionId)[0].n;
        c.eq(tasks, 1, 'one recall deadline is scheduled for the borrow, not two');
        await w.clock(TUE);
        c.eq((await w.strategy(s.id)).positions.find((p) => p.family === 'equity')?.qty, -300, 'Tuesday: the short is still open');
        await w.clock(WED);
        await w.tick();
        const v = await w.strategy(s.id);
        c.eq(v.positions.length, 0, 'Wednesday: no position is left');
        c.eq(v.status, 'closed', 'the strategy instance is closed');
        const cover = v.orders.filter((o) => o.action === 'buy_to_cover');
        c.eq(cover.map((o) => [o.status, o.filledQty, o.avgPrice, o.fills.length]), [['filled', 300, 50.02, 1]], 'one forced cover of 300 at the ask, in one fill');
        c.eq(w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'secloan.buy_in'`, book.id)[0].n, 1, 'exactly one buy-in event');
        await w.clock(THU); await w.tick();
        const cash = await w.cash(book.id, book.accountId);
        c.near(cash.restricted, 0, 'no restricted cash is left');
        c.near(cash.reserved, 0, 'no margin hold is left');
        c.near(await w.balance(book.id, book.accountId, 'pnl.realized'), 6, 'realized loss of 6.00: 300 x (50.02 - 50.00)');
        c.near(await w.balance(book.id, book.accountId, 'pnl.commission'), 3, 'commissions 1.50 + 1.50');
        const end = await w.books(book.id);
        await w.tick(); await w.tick();
        w.sameRows(c, end, await w.books(book.id), 'later cycles');
        await w.clean(c, book.id);
      }),
      browser: 'a lender recall is recorded by hand on the borrow position; the form is exercised with the other hand-recorded events in SB:stress:double-click-event, and the buy-in itself is produced by time passing',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'collateral-repo',
    title: 'Insufficient collateral: repo',
    proves: 'A repo cannot raise more cash than its collateral supports, pledge more than is held free, or pledge the same holding twice.',
    expected: 'Treasury holds 1,000,000 face of a Treasury note priced at 100.00. A repo with a 2% haircut: (a) pledging 2,000,000 face is blocked naming 1,000,000 unencumbered; (b) asking for 2,000,000.00 of cash against the 1,000,000 face is blocked because the collateral does not support it after the haircut; each refused if confirmed anyway, with nothing pledged and no cash moved. (c) A repo of 900,000.00 against the 1,000,000 face goes through: cash up 900,000.00, the holding fully pledged. (d) A second repo on the same holding is blocked naming 0 unencumbered.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal collateral repo', { capital: 3_000_000, funding: 0 });
        const bond = await w.instrument({ productId: 'treasury_note', name: 'Test Treasury 4% 15-Mar-2031', symbol: 'TTSY31', marketView: 'US_CASH', venueType: 'otc', issuer: 'Test Treasury', domicile: 'US', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2031-03-15', issueDate: '2021-03-15', dayCount: 'ACT/ACT', redemption: 100 } });
        await w.fixture('quote', { instrumentId: bond.id, bid: 99.98, ask: 100.00, last: 100.00, bidSize: 5e6, askSize: 5e6 });
        const hold = await w.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: bond.id, qty: 1_000_000 }] });
        await w.clock(TUE);
        const posId = hold.positions[0].positionId;
        const repo = (cash, face) => ({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'repo_open', action: 'repo', qty: cash, purpose: 'financing', collateralPositionId: posId, contract: { productId: 'term_repo', name: `Repo TTSY31 ${cash}/${face}`, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: bond.id, collateralQty: face, haircut: 0.02, rateType: 'fixed', rate: 0.045, term: 'term', endDate: '2026-03-10' } } }] });
        const before = await w.books(book.id);
        const cashBefore = (await w.cash(book.id, book.treasuryId)).settled;
        let res = await w.preview(repo(980_000, 2_000_000));
        if (blocked(c, res, /Only 1,000,000 of the collateral is unencumbered; 2,000,000 is needed/, '(a) pledging more than is held') && res.ok) await confirmRefused(w, c, res.body, '(a)');
        // Collateral value: 1,000,000 face at 100.00 plus accrued interest is a little over 1,000,000.00; after the 2% haircut it
        // supports about 980,000 (plus 98% of the accrued interest). 2,000,000.00 is roughly twice that.
        res = await w.preview(repo(2_000_000, 1_000_000));
        if (blocked(c, res, /collateral|haircut/i, '(b) more cash than the collateral supports') && res.ok) await confirmRefused(w, c, res.body, '(b)');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refused repos');
        w.sameRows(c, before, after, 'after the refused repos');
        const s = await w.trade(repo(900_000, 1_000_000));
        c.eq(s.orders[0].status, 'filled', '(c) a repo within the collateral goes through');
        c.near((await w.cash(book.id, book.treasuryId)).settled, cashBefore + 900_000, '(c) cash is up by the 900,000.00 raised');
        res = await w.preview(repo(50_000, 100_000));
        blocked(c, res, /Only 0 of the collateral is unencumbered; 100,000 is needed/, '(d) pledging the same holding again');
        await w.clean(c, book.id);
      }),
      browser: 'the repo ticket and its block are exercised by the loans and repo product scenarios at browser level; this case adds no interface path of its own',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'collateral-pledged-position',
    title: 'Insufficient collateral: selling a pledged position',
    proves: 'A holding pledged as repo collateral cannot be sold while it is pledged, and trying to does not disturb the holding.',
    expected: 'Treasury holds 1,000,000 face of a note, all pledged to a repo. Selling it is blocked in the preview naming that 0 is unencumbered; a confirmation sent anyway is refused; no order is created, the strategy instance holding the note keeps its status, and the books are unchanged. After the repo is repaid the same sale previews without a block.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal pledged position', { capital: 3_000_000, funding: 0 });
        const bond = await w.instrument({ productId: 'treasury_note', name: 'Test Treasury 4% 15-Mar-2031', symbol: 'TTSY31', marketView: 'US_CASH', venueType: 'otc', issuer: 'Test Treasury', domicile: 'US', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2, maturity: '2031-03-15', issueDate: '2021-03-15', dayCount: 'ACT/ACT', redemption: 100 } });
        await w.fixture('quote', { instrumentId: bond.id, bid: 99.98, ask: 100.00, last: 100.00, bidSize: 5e6, askSize: 5e6 });
        const hold = await w.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: bond.id, qty: 1_000_000 }] });
        await w.clock(TUE);
        const posId = hold.positions[0].positionId;
        const repo = await w.trade({ bookId: book.id, unitId: book.treasuryId, template: 'custom', legs: [{ kind: 'repo_open', action: 'repo', qty: 900_000, purpose: 'financing', collateralPositionId: posId, contract: { productId: 'term_repo', name: 'Repo TTSY31', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: bond.id, collateralQty: 1_000_000, haircut: 0.02, rateType: 'fixed', rate: 0.045, term: 'term', endDate: '2026-03-10' } } }] });
        const before = await w.books(book.id);
        const statusBefore = (await w.strategy(hold.id)).status;
        const res = await w.req('POST', `/api/strategies/${hold.id}/preview-action`, { action: 'close' });
        if (blocked(c, res, /unencumbered|pledged/i, 'selling the pledged note') && res.ok) await confirmRefused(w, c, res.body, 'selling the pledged note');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refused sale');
        w.sameRows(c, before, after, 'after the refused sale');
        c.eq((await w.strategy(hold.id)).status, statusBefore, 'the holding\'s strategy instance keeps its status');
        // Repay the repo; the note is free again.
        await w.closeOut(repo.id);
        const again = await w.req('POST', `/api/strategies/${hold.id}/preview-action`, { action: 'close' });
        c.ok(again.ok && again.body.blocking === 0, 'after the repo is repaid the sale previews without a block', again.ok ? errorText(again.body) : again.error);
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks only for securities tickets; a pledged bond is reached through the bond and repo product scenarios',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'collateral-independent-amount',
    title: 'Insufficient collateral: an OTC independent amount that cannot be posted',
    proves: 'An OTC trade whose independent amount exceeds the settled cash that is free is blocked; collateral is never funded silently.',
    expected: 'The Account holds 30,000.00. Under a bilateral agreement with an independent amount of 5% of notional, a credit default swap of 1,000,000 notional needs 50,000.00: the preview blocks naming 50,000.00 against 30,000.00 free and shows a shortfall of 20,000.00; a confirmation sent anyway is refused; nothing is posted or stored. 600,000 notional needs exactly 30,000.00 and goes through with 30,000.00 posted as margin. A contract with no collateral basis at all cannot be previewed.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal independent amount', { funding: 30_000 });
        const agr = await w.post(`/api/books/${book.id}/agreements`, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [book.accountId], terms: { independentAmount: { type: 'pct', pct: 0.05 } } });
        const cds = (qty, basis) => ({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty, statedPrice: 0, contract: { productId: 'cds_single_name', name: `CDS Acme ${qty}`, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { referenceEntity: 'Acme Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4, counterparty: 'Dealer A', ...(basis ? { collateralBasis: basis } : {}) } } }] });
        const before = await w.books(book.id);
        const res = await w.preview(cds(1_000_000, { type: 'agreement', agreementId: agr.id }));
        if (blocked(c, res, /independent amount of 50,000\.00 USD .* cannot be posted: Alpha has 30,000\.00 USD/, '1,000,000 notional') && res.ok) {
          c.near(res.body.totals.cash.USD.shortfall, 20_000, 'shortfall in the preview');
          await confirmRefused(w, c, res.body, '1,000,000 notional');
        }
        blocked(c, await w.preview(cds(1_000_000, null)), /collateral/i, 'a contract with no collateral basis');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after the refusals');
        w.sameRows(c, before, after, 'after the refusals');
        const s = await w.trade(cds(600_000, { type: 'agreement', agreementId: agr.id }));
        c.eq(s.orders[0].status, 'filled', '600,000 notional goes through');
        const cash = await w.cash(book.id, book.accountId);
        c.near(cash.margin, 30_000, '30,000.00 is posted as margin');
        c.near(cash.settled, 0, 'and has left settled cash');
        await w.clean(c, book.id);
      }),
      browser: 'the OTC contract ticket is exercised by the swaps product scenarios at browser level; the block itself is the same preview read in SB:refusals:ticket-blocks',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'collateral-margin-call',
    title: 'Insufficient collateral: a variation-margin call that cannot be met',
    proves: 'A margin call the Account cannot meet posts nothing, is recorded once, stays visible, and is delivered exactly once when cash arrives.',
    expected: 'The Account holds 30,000.00 and has an interest-rate swap of 1,000,000 notional under an agreement with variation margin. A mark of -5 per 100 values it at -50,000.00, so the end-of-day call is 50,000.00: nothing is posted, cash stays 30,000.00, one alert names the 50,000.00 call and the 30,000.00 available, and the failure is in the audit trail once. Three more cycles change nothing and add no failure event. After 100,000.00 of funding the next cycle posts 50,000.00 (cash 80,000.00) and the alert clears. Further cycles and the next end of day at the same mark post nothing more: exactly one variation-margin movement exists.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal margin call', { funding: 30_000 });
        await w.fixture('rate', { code: 'TEST-3M', value: 4.0 });
        const agr = await w.post(`/api/books/${book.id}/agreements`, { name: 'CSA Dealer A', counterparty: 'Dealer A', kind: 'bilateral', unitIds: [book.accountId], terms: { variationMargin: true } });
        const s = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 1_000_000, statedPrice: 0, contract: { productId: 'interest_rate_swap', name: 'IRS system test', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer A', collateralBasis: { type: 'agreement', agreementId: agr.id }, legs: [
          { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' },
          { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } } }] });
        const instId = s.positions[0].instrument.id;
        await w.post('/api/observations', { kind: 'price', subject: instId, value: -5, units: 'per 100 notional' }); // 1,000,000 x -5 / 100 = -50,000
        await w.clock(evening('2026-03-02'));
        let cash = await w.cash(book.id, book.accountId);
        c.near(cash.margin, 0, 'nothing is posted');
        c.near(cash.settled, 30_000, 'cash is untouched, not part-used');
        let alerts = (await w.get(`/api/books/${book.id}/alerts`)).items.filter((a) => a.code === 'collateral.call_failed');
        c.eq(alerts.length, 1, 'one alert for the failed call');
        c.match(alerts[0]?.message, /call of 50,000\.00 USD .* failed: Alpha has 30,000\.00 USD/, 'the alert names the call and what is available');
        const failEvents = () => w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'collateral.call_failed'`, book.id)[0].n;
        c.eq(failEvents(), 1, 'the failure is in the audit trail once');
        const mid = await w.books(book.id);
        await w.tick(); await w.tick(); await w.tick();
        w.sameBooks(c, mid, await w.books(book.id), 'three retries without cash');
        c.eq(failEvents(), 1, 'retries do not add failure events');
        await w.post(`/api/books/${book.id}/transfers`, { fromUnitId: book.treasuryId, toUnitId: book.accountId, ccy: 'USD', amount: 100_000 });
        await w.tick();
        cash = await w.cash(book.id, book.accountId);
        c.near(cash.margin, 50_000, 'the call is delivered: 50,000.00 posted');
        c.near(cash.settled, 80_000, 'cash is 30,000.00 + 100,000.00 - 50,000.00');
        alerts = (await w.get(`/api/books/${book.id}/alerts`)).items.filter((a) => a.code === 'collateral.call_failed');
        c.eq(alerts.length, 0, 'the alert is cleared');
        await w.tick(); await w.tick();
        await w.clock(evening('2026-03-03'));
        cash = await w.cash(book.id, book.accountId);
        c.near(cash.margin, 50_000, 'no double posting after more cycles and the next end of day');
        c.eq(w.sql(`SELECT COUNT(*) AS n FROM collateral_movements WHERE book_id = ? AND kind = 'variation'`, book.id)[0].n, 1, 'exactly one variation-margin movement exists');
        c.eq(w.sql(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'collateral.variation'`, book.id)[0].n, 1, 'exactly one variation-margin event exists');
        await w.clean(c, book.id);
      }),
      browser: 'the call is produced by the end-of-day pass, not by a user action; the alert it raises is read at browser level in SB:refusals:failed-tab',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'quote-missing',
    title: 'Missing quote: trade preview, order and valuation',
    proves: 'Without a price nothing is estimated, filled or valued at an invented figure; the net asset value says it is provisional and names the holding.',
    expected: 'Trade: an instrument with no quote previews with no estimated fill (missing, not zero) and a warning that the leg would wait and that cash cannot be fully computed; confirmed, the order is working with the reason, fills nothing over three cycles and posts no ledger entry; cancelled, it leaves no position. Valuation: a holding of 100 bought at 50.02 whose quote is then withdrawn shows no price, no value and no unrealized P&L (missing, never zero); the Book net asset value is provisional and not complete, names the holding and its owner as unpriced, and carries it at cost: 1,000,000.00 - 1.00 commission = 999,999.00. When the quote returns (last 50.01) the net asset value is final again at 999,998.00.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal quote missing');
        const nq = await w.stock('RFQM', null);
        const before = await w.books(book.id);
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, nq, 'buy', 100, { order: { tif: 'gtc' } }));
        c.eq(pv.legs[0].price.estimate, null, 'the preview has no estimated fill');
        c.eq(pv.legs[0].price.executable, false, 'and says the leg is not executable');
        c.ok(pv.checks.some((x) => x.code === 'no-price' && /no price for RFQM/.test(x.message)), 'a warning names the instrument with no price', JSON.stringify(pv.checks));
        c.ok(pv.checks.some((x) => x.code === 'cash-unknown'), 'a warning says the cash requirement cannot be fully computed', JSON.stringify(pv.checks.map((x) => x.code)));
        const sub = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        const order = sub.strategy.orders[0];
        c.eq([order.status, order.filledQty], ['working', 0], 'confirmed: the order is working, unfilled');
        c.match(order.statusReason, /No price is available/, 'the order says why it waits');
        await w.tick(); await w.tick(); await w.tick();
        let now = await w.books(book.id);
        w.sameBooks(c, before, now, 'three cycles with no price');
        c.eq(now.counts.fills, 0, 'no fill was made at an invented price');
        c.eq(now.counts.entries, before.counts.entries, 'no ledger entry was posted');
        const cancel = await w.req('POST', `/api/orders/${order.id}/cancel`);
        c.ok(cancel.ok && cancel.body.status === 'cancelled', 'the working order can be cancelled', cancel.error);
        c.eq((await w.strategy(sub.strategy.id)).positions.length, 0, 'no position exists');

        // valuation
        const held = await w.stock('RFQH');
        await w.buy(book, held, 100); // 100 x 50.02 = 5,002.00 + 1.00 commission
        let pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq([pos.nav.provisional, pos.nav.value], [false, 999_998], 'priced: net asset value 1,000,000 - 1.00 commission - 1.00 unrealized (100 x (50.01 - 50.02)), not provisional');
        await w.fixture('quote', { instrumentId: held.id, clear: true });
        pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        const row = pos.positions.find((p) => p.instrument.id === held.id);
        c.eq([row.price, row.unrealized], [null, null], 'quote withdrawn: the position shows no price and no unrealized P&L (missing, not zero)');
        c.ok(row.mv === null || row.mv === undefined, 'and no market value', String(row.mv));
        c.eq([pos.nav.provisional, pos.nav.complete], [true, false], 'the net asset value is provisional and not complete');
        c.eq(pos.nav.affected.map((x) => [x.kind, x.instrument?.symbol, x.owner]), [['unpriced', 'RFQH', 'Alpha']], 'it names the holding and its owner');
        c.near(pos.nav.value, 999_999, 'the holding is carried at cost: 1,000,000.00 - 1.00 commission');
        const ov = await w.get(`/api/books/${book.id}`);
        c.eq(ov.overview.navProvisional, true, 'the Book overview says provisional too');
        const bs = await w.get(`/api/books/${book.id}/accounting/balance`, { scope: 'book' });
        c.eq(bs.nav.provisional, true, 'and so does the balance sheet');
        await w.fixture('quote', { instrumentId: held.id, bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000 });
        pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq([pos.nav.provisional, pos.nav.value], [false, 999_998], 'the quote returns: final again at 999,998.00');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.provisionalNav(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'quote-stale',
    title: 'Stale quote: trade preview, order and valuation',
    proves: 'A quote that is too old does not fill an order; a holding valued on it keeps its value but the net asset value is provisional and names it.',
    expected: 'Trade: a quote one hour old (the Book allows 120 seconds) gives no estimated fill and a warning that says how old the quote is; confirmed, the order is working and fills nothing over three cycles. When a fresh quote arrives (ask 20.10) the next cycle fills all 100 at 20.10, once. Valuation: a holding of 100 whose last price 50.01 is two hours old is still valued at 5,001.00, and the Book net asset value 999,998.00 is provisional (complete, but provisional) naming the holding and the time of its mark.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal quote stale');
        const st = await w.stock('RFQS', { bid: 20.00, ask: 20.02, last: 20.01, bidSize: 5000, askSize: 5000, asOf: '2026-03-02T14:00:00.000Z' });
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, st, 'buy', 100, { order: { tif: 'gtc' } }));
        c.eq(pv.legs[0].price.estimate, null, 'no estimated fill from a stale quote');
        c.ok(pv.checks.some((x) => x.code === 'not-executable' && /3600 seconds old/.test(x.message)), 'a warning says how old the quote is', JSON.stringify(pv.checks));
        const sub = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        c.eq([sub.strategy.orders[0].status, sub.strategy.orders[0].filledQty], ['working', 0], 'confirmed: working, unfilled');
        await w.tick(); await w.tick(); await w.tick();
        c.eq((await w.books(book.id)).counts.fills, 0, 'three cycles: nothing filled on the stale quote');
        await w.fixture('quote', { instrumentId: st.id, bid: 20.08, ask: 20.10, last: 20.09, bidSize: 5000, askSize: 5000 });
        await w.tick();
        let s = await w.strategy(sub.strategy.id);
        c.eq([s.orders[0].status, s.orders[0].filledQty, s.orders[0].avgPrice, s.orders[0].fills.length], ['filled', 100, 20.10, 1], 'a fresh quote: filled at the fresh ask, in one fill');
        await w.tick();
        s = await w.strategy(sub.strategy.id);
        c.eq(s.orders[0].fills.length, 1, 'another cycle does not fill again');

        const held = await w.stock('RFQT');
        await w.buy(book, held, 100);
        await w.fixture('quote', { instrumentId: held.id, bid: 50.00, ask: 50.02, last: 50.01, bidSize: 5000, askSize: 5000, asOf: '2026-03-02T13:00:00.000Z' });
        await w.fixture('quote', { instrumentId: st.id, bid: 20.08, ask: 20.10, last: 20.10, bidSize: 5000, askSize: 5000 }); // RFQS at cost, so only RFQT moves the total
        const pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        const row = pos.positions.find((p) => p.instrument.id === held.id);
        c.eq([row.price, row.mv], [50.01, 5_001], 'the holding is still valued on its stale mark');
        c.eq([pos.nav.provisional, pos.nav.complete], [true, true], 'the net asset value is provisional, though complete');
        const hit = pos.nav.affected.find((x) => x.kind === 'stale-price');
        c.eq([hit?.instrument?.symbol, hit?.owner, hit?.asOf], ['RFQT', 'Alpha', '2026-03-02T13:00:00.000Z'], 'it names the holding, its owner and the time of the mark');
        // 1,000,000 - 1.00 (RFQS commission) - 1.00 (RFQT commission) - 1.00 (RFQT unrealized: 100 x (50.01 - 50.02)) = 999,997.00
        c.near(pos.nav.value, 999_997, 'net asset value');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.provisionalNav(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'fx-missing',
    title: 'Missing FX rate: trade preview and valuation',
    proves: 'Without a conversion rate nothing is converted at an invented rate: reporting-currency amounts are missing, the preview says so, and the net asset value is provisional and names the currency.',
    expected: 'Treasury receives 1,000,000 SEK while no SEK/USD rate exists: the deposit is booked in SEK with its USD equivalent missing (NULL, not zero); the Book net asset value is provisional and not complete, names SEK as having no conversion rate, and totals the USD balances only (1,000,000.00). A purchase of a SEK stock paid from that SEK previews with a warning that names the missing SEK/USD rate (the trade itself is in SEK and is not blocked); executed, its entries also carry no USD equivalent. When a rate of 0.10 is supplied the net asset value is final: 1,000,000.00 + 0.10 x (SEK cash + holding at last price).',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal fx missing');
        const dep = await w.req('POST', `/api/books/${book.id}/capital`, { type: 'deposit', ccy: 'SEK', amount: 1_000_000 });
        c.ok(dep.ok, 'the SEK deposit is booked', dep.error);
        const rcOf = (eventId) => w.sql('SELECT amount, amount_rc, fx_rate FROM entries WHERE event_id = ? AND ccy = ?', eventId, 'SEK');
        c.ok(rcOf(dep.body.eventId).every((e) => e.amount_rc === null && e.fx_rate === null), 'its USD equivalent is missing (NULL), not zero and not invented', JSON.stringify(rcOf(dep.body.eventId)));
        let pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq([pos.nav.provisional, pos.nav.complete, pos.nav.value], [true, false, 1_000_000], 'net asset value: provisional, not complete, USD balances only');
        c.ok(pos.nav.affected.some((x) => x.kind === 'fx-missing' && x.ccy === 'SEK'), 'it names SEK as having no conversion rate', JSON.stringify(pos.nav.affected));

        const se = await w.instrument({ productId: 'common_stock', name: 'Nordholm Verkstad AB', symbol: 'NORD', marketView: 'FOREIGN_CASH', venue: 'XSTO', venueType: 'exchange', venueCountry: 'SE', issuer: 'Nordholm Verkstad AB', domicile: 'SE', underlyingGeo: 'SE', tradingCcy: 'SEK', terms: {} });
        await w.fixture('quote', { instrumentId: se.id, bid: 100.00, ask: 100.20, last: 100.10, bidSize: 5000, askSize: 5000 });
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, se, 'buy', 100, { unitId: book.treasuryId }));
        c.ok(pv.checks.some((x) => /SEK\/USD|SEK.*conversion rate|conversion rate.*SEK/i.test(x.message) && ['warning', 'error'].includes(x.level)), 'the preview names the missing SEK/USD conversion rate', JSON.stringify(pv.checks.map((x) => `${x.level}:${x.code}`)));
        c.eq(pv.blocking, 0, 'the SEK purchase itself is not blocked: it is paid in SEK');
        const sub = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        c.eq(sub.strategy.orders[0].status, 'filled', 'it executes in SEK');
        const fillEntries = w.sql(`SELECT amount_rc FROM entries WHERE book_id = ? AND ccy = 'SEK' AND strategy_id = ?`, book.id, sub.strategy.id);
        c.ok(fillEntries.length > 0 && fillEntries.every((e) => e.amount_rc === null), 'its entries carry no USD equivalent either', JSON.stringify(fillEntries));

        await w.fixture('fx', { pair: 'SEK/USD', rate: 0.10 });
        pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        // SEK: cash 1,000,000 with 10,020.00 + 1.00 owed (100 x 100.20, commission 100 x 0.005 = 0.50 raised to the 1.00 minimum), holding 100 x 100.10 = 10,010.00
        // net SEK assets 1,000,000 - 10,021 + 10,010 = 999,989; x 0.10 = 99,998.90; plus 1,000,000.00 USD
        c.eq([pos.nav.provisional, pos.nav.complete], [false, true], 'with a rate the net asset value is final');
        c.near(pos.nav.value, 1_099_998.90, 'and converts the SEK balances at 0.10');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.provisionalNav(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'fx-stale',
    title: 'Stale FX rate: trade preview and valuation',
    proves: 'A conversion rate that is no longer current still converts, but the result is provisional and says which rate is stale.',
    expected: 'Treasury holds 1,000,000 SEK and the only SEK/USD rate (0.10) is two hours old: the Book net asset value is 1,100,000.00, complete but provisional, and names SEK as converted at a rate that is not current, with the time of the rate. A purchase of a SEK stock previews with a warning that names the stale SEK/USD rate. With a current rate the net asset value is final again.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal fx stale');
        await w.fixture('fx', { pair: 'SEK/USD', rate: 0.10 });
        await w.post(`/api/books/${book.id}/capital`, { type: 'deposit', ccy: 'SEK', amount: 1_000_000 });
        let pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq([pos.nav.provisional, pos.nav.value], [false, 1_100_000], 'current rate: 1,000,000.00 USD + 1,000,000 SEK x 0.10, final');
        await w.fixture('fx', { pair: 'SEK/USD', rate: 0.10, asOf: '2026-03-02T13:00:00.000Z' });
        pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq([pos.nav.provisional, pos.nav.complete, pos.nav.value], [true, true, 1_100_000], 'stale rate: the same figure, complete but provisional');
        const hit = pos.nav.affected.find((x) => x.kind === 'fx-stale');
        c.eq([hit?.ccy, hit?.asOf], ['SEK', '2026-03-02T13:00:00.000Z'], 'it names SEK and the time of the rate');
        const bs = await w.get(`/api/books/${book.id}/accounting/balance`, { scope: 'book' });
        c.eq(bs.nav.provisional, true, 'the balance sheet says provisional too');
        const se = await w.instrument({ productId: 'common_stock', name: 'Nordholm Verkstad AB', symbol: 'NORD', marketView: 'FOREIGN_CASH', venue: 'XSTO', venueType: 'exchange', venueCountry: 'SE', issuer: 'Nordholm Verkstad AB', domicile: 'SE', underlyingGeo: 'SE', tradingCcy: 'SEK', terms: {} });
        await w.fixture('quote', { instrumentId: se.id, bid: 100.00, ask: 100.20, last: 100.10, bidSize: 5000, askSize: 5000 });
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, se, 'buy', 100, { unitId: book.treasuryId }));
        c.ok(pv.checks.some((x) => /SEK\/USD|SEK.*rate|rate.*SEK/i.test(x.message) && /not current|stale|old/i.test(x.message)), 'the preview names the stale SEK/USD rate', JSON.stringify(pv.checks.map((x) => `${x.level}:${x.code}:${x.message}`)));
        await w.fixture('fx', { pair: 'SEK/USD', rate: 0.10 });
        pos = await w.get(`/api/books/${book.id}/accounting/positions`, { scope: 'book' });
        c.eq(pos.nav.provisional, false, 'a current rate: final again');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.provisionalNav(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'incomplete-terms',
    title: 'Incomplete contract terms',
    proves: 'A contract missing a term its product needs cannot be registered or traded; the Terminal never fills the gap with a default.',
    expected: 'Each of these is refused with a message naming what is missing, and nothing is registered: a loan with no rate; an option with no strike; a swap with no legs; a future with no multiplier; a bond with no maturity; a repo with no collateral security; an instrument with no product; a currency pair with no quote currency. A credit default swap with every term but its collateral basis registers, but cannot be previewed for trading until a basis is stated. A package leg that names its contract inline with a missing term is refused the same way and stores nothing.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal incomplete terms');
        const before = await w.books(book.id);
        const count = () => w.sql('SELECT COUNT(*) AS n FROM instruments')[0].n;
        const n0 = count();
        const drafts = {
          'a loan with no rate': [{ productId: 'unsecured_loan', name: 'Loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed' } }, /rate/i],
          'an option with no strike': [{ productId: 'equity_option', name: 'Option', marketView: 'US_DERIV', venueType: 'exchange', tradingCcy: 'USD', multiplier: 100, terms: { right: 'C', expiration: '2026-06-19' } }, /strike/i],
          'a swap with no legs': [{ productId: 'interest_rate_swap', name: 'Swap', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02' } }, /leg/i],
          'a future with no multiplier': [{ productId: 'equity_index_future', name: 'Future', marketView: 'US_DERIV', venueType: 'exchange', tradingCcy: 'USD', terms: { expiration: '2026-06-19' } }, /multiplier/i],
          'a bond with no maturity': [{ productId: 'treasury_note', name: 'Bond', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { couponType: 'fixed', couponRate: 0.04, frequency: 2 } }, /maturity/i],
          'a repo with no collateral security': [{ productId: 'term_repo', name: 'Repo', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralQty: 1000, rateType: 'fixed', rate: 0.04 } }, /collateral/i],
          'an instrument with no product': [{ name: 'Nothing', marketView: 'US_CASH', tradingCcy: 'USD' }, /product/i],
          'a currency pair with no quote currency': [{ productId: 'fx_spot', name: 'Pair', symbol: 'USD/???', marketView: 'FOREIGN_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { base: 'USD' } }, /currenc/i],
        };
        for (const [label, [draft, text]] of Object.entries(drafts)) c.refused(await w.req('POST', '/api/instruments', draft), { status: 400, text }, label);
        c.eq(count(), n0, 'nothing was registered');
        // Inline contract on a package leg.
        const inline = await w.preview({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'loan', action: 'borrow_cash', qty: 50_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'Inline loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed' } } }] });
        blocked(c, inline, /rate/i, 'a package leg whose inline loan has no rate');
        c.eq(count(), n0, 'still nothing registered');
        // A CDS with no collateral basis: registers, cannot be traded.
        const cds = await w.req('POST', '/api/instruments', { productId: 'cds_single_name', name: 'CDS Acme no basis', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { referenceEntity: 'Acme Corp', coupon: 0.01, effective: '2026-03-02', maturity: '2031-03-20', recovery: 0.4 } });
        c.ok(cds.ok, 'a CDS without a collateral basis can be registered', cds.error);
        if (cds.ok) {
          const pv = await w.preview({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: cds.body.id, qty: 1_000_000, statedPrice: 0 }] });
          if (blocked(c, pv, /collateral/i, 'trading it') && pv.ok) await confirmRefused(w, c, pv.body, 'trading it');
        }
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after every refusal');
        w.sameRows(c, before, after, 'after every refusal');
      }),
      browser: async (b, c) => b.cases.incompleteTerms(b, c),
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'invalid-quantity',
    title: 'Invalid quantities',
    proves: 'A quantity that is zero, negative, not a number, fractional where shares are whole, more than is held, or more than is short is refused before anything is ordered.',
    expected: 'With 200 shares held and a separate short of 100: buying 0, -5 or "abc" shares is refused (quantity must be positive); buying 10.5 shares is blocked (whole shares only); selling 300 of the 200 held is blocked naming 200 held; covering 150 of the 100 short is blocked naming 100 short; exercising 5 option contracts when 2 are held is refused; a transfer or deposit of a non-numeric amount is refused. None of these stores anything. (More than the borrow available: SE:refusals:borrow-exhausted.)',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal invalid quantity');
        const inst = await w.stock('RFIQ');
        const sh = await w.stock('RFIS');
        await w.fixture('borrow', { instrumentId: sh.id, available: true, quantity: 1_000, feeRate: 0.01 });
        const long = await w.buy(book, inst, 200);
        const short = await w.short(book, sh, 100);
        const und = await w.stock('RFIU', { bid: 100.00, ask: 100.10, last: 100.05, bidSize: 5000, askSize: 5000 });
        const opt = await w.instrument({ productId: 'equity_option', name: 'RFIU 2026-06-19 100 Call', symbol: 'RFIU 260619C100', marketView: 'US_DERIV', venue: 'CBOE', venueType: 'exchange', venueCountry: 'US', underlyingId: und.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'C', strike: 100, expiration: '2026-06-19', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
        await w.fixture('quote', { instrumentId: opt.id, bid: 2.00, ask: 2.10, last: 2.05, bidSize: 50, askSize: 50 });
        const os = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: und.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: opt.id, qty: 2 }] });
        const before = await w.books(book.id);
        for (const q of [0, -5, 'abc', null]) blocked(c, await w.preview(w.ticketInput(book, inst, 'buy', q)), /quantity must be positive/i, `buy ${JSON.stringify(q)} shares`);
        const frac = await w.preview(w.ticketInput(book, inst, 'buy', 10.5));
        if (blocked(c, frac, /multiple of 1/, 'buy 10.5 shares') && frac.ok) await confirmRefused(w, c, frac.body, 'buy 10.5 shares');
        blocked(c, await w.preview({ bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: und.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: opt.id, qty: 1.5 }] }), /multiple of 1/, 'buy 1.5 option contracts');
        const over = await w.req('POST', `/api/strategies/${long.id}/preview-action`, { action: 'close', positionIds: [long.positions[0].positionId], qty: 300 });
        if (blocked(c, over, /200/, 'sell 300 of the 200 held') && over.ok) await confirmRefused(w, c, over.body, 'sell 300 of the 200 held');
        const shortPos = short.positions.find((p) => p.family === 'equity');
        const cover = await w.req('POST', `/api/strategies/${short.id}/preview-action`, { action: 'close', positionIds: [shortPos.positionId], qty: 150 });
        if (blocked(c, cover, /100/, 'cover 150 of the 100 short') && cover.ok) await confirmRefused(w, c, cover.body, 'cover 150 of the 100 short');
        c.refused(await w.req('POST', `/api/positions/${os.positions[0].positionId}/lifecycle`, { action: 'exercise', contracts: 5 }), { status: 400 }, 'exercise 5 contracts of the 2 held');
        c.refused(await w.req('POST', `/api/positions/${os.positions[0].positionId}/lifecycle`, { action: 'exercise', contracts: 0 }), { status: 400 }, 'exercise 0 contracts');
        c.refused(await w.req('POST', `/api/positions/${os.positions[0].positionId}/lifecycle`, { action: 'exercise', contracts: 1.5 }), { status: 400 }, 'exercise 1.5 contracts');
        c.refused(await w.req('POST', `/api/books/${book.id}/transfers`, { fromUnitId: book.accountId, toUnitId: book.treasuryId, ccy: 'USD', amount: 'lots' }), { status: 400 }, 'a transfer of "lots"');
        c.refused(await w.req('POST', `/api/books/${book.id}/capital`, { type: 'deposit', ccy: 'USD', amount: 'lots' }), { status: 400 }, 'a deposit of "lots"');
        c.refused(await w.req('POST', `/api/books/${book.id}/capital`, { type: 'deposit', ccy: 'dollars', amount: 5 }), { status: 400 }, 'a deposit in "dollars"');
        const after = await w.books(book.id);
        w.sameBooks(c, before, after, 'after every refusal');
        w.sameRows(c, before, after, 'after every refusal');
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks (zero, fractional and more-than-held quantities typed into the ticket)',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'expired-contract',
    title: 'Expired contracts',
    proves: 'An expired contract cannot be traded, a working order in it never fills after expiry, and its expiry is processed exactly once.',
    expected: 'Two calls (strike 100, expiring Friday 6 March) are held and a resting limit order to buy one more at 0.50 is working. The underlying closes at 98.00 on Friday. On Saturday the catch-up processes the expiry: one "expired worthless" event for the 2 contracts, the position is gone, the premium paid (2 x 100 x 2.10 = 420.00) is a realized loss, once. Three more cycles and a restart add no event and no row. A new order in the expired contract is blocked naming the expiry date, and refused if confirmed anyway. The resting order does not fill after expiry even when the quote would allow it: it is no longer active, with a reason, and no position appears.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal expired contract');
        const und = await w.stock('RFEX', { bid: 100.00, ask: 100.10, last: 100.05, bidSize: 5000, askSize: 5000 });
        const opt = await w.instrument({ productId: 'equity_option', name: 'RFEX 2026-03-06 100 Call', symbol: 'RFEX 260306C100', marketView: 'US_DERIV', venue: 'CBOE', venueType: 'exchange', venueCountry: 'US', underlyingId: und.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'C', strike: 100, expiration: '2026-03-06', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
        await w.fixture('quote', { instrumentId: opt.id, bid: 2.00, ask: 2.10, last: 2.05, bidSize: 50, askSize: 50 });
        const input = (qty, order = {}) => ({ bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: und.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: opt.id, qty, orderType: 'market', tif: 'day', ...order }] });
        const s = await w.trade(input(2));
        const rest = await w.trade(input(1, { orderType: 'limit', limitPrice: 0.5, tif: 'gtc' }));
        c.eq(rest.orders[0].status, 'working', 'the resting limit order is working');
        await w.fixture('close', { instrumentId: und.id, date: '2026-03-06', value: 98 });
        await w.clock(SAT);
        const expEvents = () => w.sql(`SELECT id, summary FROM events WHERE book_id = ? AND type LIKE 'option.exp%'`, book.id);
        c.eq(expEvents().length, 1, 'one expiry event');
        c.match(expEvents()[0]?.summary, /Expired worthless: 2 RFEX 260306C100/, 'it says 2 contracts expired worthless');
        c.eq((await w.strategy(s.id)).positions.length, 0, 'the position is gone');
        c.near(await w.balance(book.id, book.accountId, 'pnl.realized'), 420, 'the 420.00 premium is a realized loss');
        const after1 = await w.books(book.id);
        await w.tick(); await w.tick(); await w.tick();
        await w.restart();
        await w.tick();
        const after2 = await w.books(book.id);
        c.eq(expEvents().length, 1, 'still one expiry event after three more cycles and a restart');
        c.near(await w.balance(book.id, book.accountId, 'pnl.realized'), 420, 'the loss is not taken twice');
        c.eq(w.sql(`SELECT COUNT(*) AS n FROM tasks WHERE book_id = ? AND type = 'option.expiry' AND status = 'done'`, book.id)[0].n, 1, 'the expiry item ran once');
        w.sameBooks(c, after1, after2, 'more cycles and a restart');

        const res = await w.preview(input(1));
        if (blocked(c, res, /expired on 2026-03-06/, 'a new order in the expired contract') && res.ok) await confirmRefused(w, c, res.body, 'a new order in the expired contract');
        // The resting order: give it a quote it could fill against, on the next trading day.
        await w.fixture('quote', { instrumentId: opt.id, bid: 0.40, ask: 0.45, last: 0.45, bidSize: 50, askSize: 50 });
        await w.clock(MON2);
        await w.tick();
        const r = await w.strategy(rest.id);
        c.eq(r.orders[0].filledQty, 0, 'the resting order did not fill after expiry');
        c.ok(!['working', 'pending', 'partial'].includes(r.orders[0].status), 'it is no longer an active order', `status ${r.orders[0].status}: ${r.orders[0].statusReason}`);
        c.match(r.orders[0].statusReason, /expir/i, 'and says the contract expired');
        c.eq(r.positions.length, 0, 'no position in the expired contract exists');
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks (ticket on an expired option)',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'calendar-settlement',
    title: 'Calendar conflicts: a stated settlement date that cannot be honoured',
    proves: 'A settlement date stated for one trade is refused, not moved, when it is not a business day of the settlement calendar or is before the trade date.',
    expected: 'On Monday 2 March 2026 a purchase with settlement stated as: Saturday 7 March is blocked (a Saturday; nearest business days 6 and 9 March); Good Friday 3 April is blocked (a holiday; nearest 2 and 6 April); Friday 27 February is blocked (before the trade date); a lag of 1.5 days or of -1 is blocked. Wednesday 4 March entered by hand as a market holiday: a purchase stated to settle that day is blocked, and a normal T+1 purchase made on Tuesday settles Thursday 5 March. Each block is refused if confirmed anyway and stores nothing. A stated date that is a business day (Thursday 5 March, T+3) is accepted and the fill carries it.',
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal calendar settlement');
        const inst = await w.stock('RFCS');
        const before = await w.books(book.id);
        const stated = (settle) => w.preview(w.ticketInput(book, inst, 'buy', 100, { order: { settle } }));
        const cases = [
          ['settling on Saturday 7 March', { date: '2026-03-07' }, /2026-03-07 \(Saturday\) is a Saturday.*nearest business days are 2026-03-06 and 2026-03-09/],
          ['settling on Good Friday', { date: '2026-04-03' }, /2026-04-03 \(Friday\) is a holiday.*nearest business days are 2026-04-02 and 2026-04-06/],
          ['settling before the trade date', { date: '2026-02-27' }, /2026-02-27 is before the trade date 2026-03-02/],
          ['a date that does not exist', { date: '2026-02-31' }, /not a calendar date/],
          ['a lag of 1.5 days', { lag: 1.5 }, /whole number of business days/],
          ['a lag of -1 days', { lag: -1 }, /whole number of business days/],
        ];
        for (const [label, settle, text] of cases) {
          const res = await stated(settle);
          if (blocked(c, res, text, label) && res.ok) await confirmRefused(w, c, res.body, label);
        }
        w.sameRows(c, before, await w.books(book.id), 'after the blocked previews');
        try {
          const cal = await w.req('PUT', '/api/calendars/US/holidays', { dates: ['2026-03-04'] });
          c.ok(cal.ok, 'Wednesday 4 March is entered as a market holiday', cal.error);
          blocked(c, await stated({ date: '2026-03-04' }), /2026-03-04 \(Wednesday\) is .*not a business day/, 'settling on the hand-entered holiday');
          w.sameRows(c, before, await w.books(book.id), 'after the block on the hand-entered holiday');
          const ok = await w.trade(w.ticketInput(book, inst, 'buy', 100, { order: { settle: { date: '2026-03-05' } } }));
          c.eq(ok.orders[0].fills[0]?.settleDate, '2026-03-05', 'a stated business day (Thursday 5 March) is accepted and the fill carries it');
          await w.clock(TUE);
          const t1 = await w.buy(book, inst, 100);
          c.eq(t1.orders[0].fills[0]?.settleDate, '2026-03-05', 'a T+1 purchase on Tuesday skips the holiday and settles Thursday');
        } finally {
          await w.req('PUT', '/api/calendars/US/holidays', { dates: [] });
        }
        await w.clean(c, book.id);
      }),
      browser: 'covered at browser level by SB:refusals:ticket-blocks (a settlement date on a Saturday typed into the ticket)',
    },
  },

  // ---------------------------------------------------------------------------------------------------
  {
    id: 'calendar-closed-day',
    title: 'Calendar: an order on a day its market is closed waits, visibly, and fills once',
    proves: 'An order does not fill on a day that is closed in its instrument\'s trading calendar; it waits with the reason and is matched once on the next trading day.',
    expected: 'A market order for 100 shares placed on Saturday 7 March: the preview warns that the market is closed and that the order will be matched on Monday 9 March, with settlement counted from Monday (Tuesday 10 March); confirmed, the order is working with that reason; three more cycles on Saturday and one on Sunday fill nothing, post nothing and add no further event. On Monday it fills once at the ask, trade date 9 March, settlement 10 March. On Good Friday (3 April, an NYSE holiday) a second order waits the same way, naming the holiday, and fills on Monday 6 April; a Day order placed on the holiday is still good on Monday. Cash accruals and settlements are not held back by the closed day.',
    world: { at: SAT },
    levels: {
      ...both(async (w, c) => {
        const book = await w.book('Refusal closed day');
        const inst = await w.stock('RFCD');
        const pv = await w.post('/api/strategies/preview', w.ticketInput(book, inst, 'buy', 100));
        c.eq(pv.blocking, 0, 'Saturday: the order is not blocked');
        const warn = pv.checks.find((x) => x.code === 'not-trading-day');
        c.match(warn?.message, /closed today on calendar US \(2026-03-07 is a Saturday\).*matched on 2026-03-09/, 'the preview says the market is closed and when the order will be matched');
        c.eq(pv.legs[0].settleDate, '2026-03-10', 'settlement is counted from Monday');
        const sub = await w.must('POST', '/api/strategies', w.confirmBody(pv));
        let o = sub.strategy.orders[0];
        c.eq([o.status, o.filledQty], ['working', 0], 'confirmed: working, unfilled');
        c.match(o.statusReason, /Market closed today on calendar US \(2026-03-07 is a Saturday\); will be matched on 2026-03-09/, 'the order says why it waits');
        const sat = await w.books(book.id);
        await w.tick(); await w.tick(); await w.tick();
        w.sameRows(c, sat, await w.books(book.id), 'three more cycles on Saturday');
        await w.clock('2026-03-08T15:00:00.000Z');
        const sun = await w.books(book.id);
        c.eq(sun.counts.fills, 0, 'Sunday: still no fill');
        w.sameBooks(c, sat, sun, 'through Sunday');
        await w.clock(MON2);
        let s = await w.strategy(sub.strategy.id);
        o = s.orders[0];
        c.eq([o.status, o.filledQty, o.avgPrice, o.fills.length], ['filled', 100, 50.02, 1], 'Monday: filled once at the ask');
        c.eq([o.fills[0]?.businessDate, o.fills[0]?.settleDate], ['2026-03-09', '2026-03-10'], 'trade date Monday, settlement Tuesday');
        await w.tick();
        c.eq((await w.strategy(sub.strategy.id)).orders[0].fills.length, 1, 'another cycle does not fill again');

        // Good Friday 3 April 2026: NYSE closed. 10:00 New York is 14:00 UTC (daylight time).
        await w.clock('2026-04-03T14:00:00.000Z');
        const pv2 = await w.post('/api/strategies/preview', w.ticketInput(book, inst, 'buy', 50));
        c.match(pv2.checks.find((x) => x.code === 'not-trading-day')?.message, /2026-04-03 is a holiday.*matched on 2026-04-06/, 'Good Friday: the preview names the holiday and Monday 6 April');
        const sub2 = await w.must('POST', '/api/strategies', w.confirmBody(pv2));
        c.eq(sub2.strategy.orders[0].status, 'working', 'the Day order waits');
        await w.clock(evening('2026-04-03'));
        c.eq((await w.strategy(sub2.strategy.id)).orders[0].status, 'working', 'it is not expired at the end of the holiday: a Day order placed on a closed day is good for the next trading day');
        await w.clock('2026-04-06T14:00:00.000Z');
        s = await w.strategy(sub2.strategy.id);
        c.eq([s.orders[0].status, s.orders[0].filledQty, s.orders[0].fills.length, s.orders[0].fills[0]?.businessDate], ['filled', 50, 1, '2026-04-06'], 'Monday 6 April: filled once, trade date 6 April');
        await w.clean(c, book.id);
      }),
      browser: async (b, c) => b.cases.closedDay(b, c),
    },
  },
];
