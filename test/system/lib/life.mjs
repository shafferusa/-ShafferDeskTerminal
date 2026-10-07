// "Life": one Book with a little of everything that recurs or falls due, followed for fifteen days.
// The no-duplicates and interruption cases run it under different regimes (day by day, one catch-up
// jump, across restarts, with overlapping engine cycles, with the engine timer on, with the server
// killed mid-cycle) and compare the outcome with figures worked out by hand here and with each other.
//
// Monday 2 March 2026, 10:00 New York. Treasury 1,000,000.00 USD, Account "Alpha" 1,000,000.00 USD.
//   (1) long    buy 1,000 LFA at the ask 50.02                         cost 50,020.00, commission 5.00
//               dividend 0.25 a share, ex Wednesday 4 March, paid Friday 6 March      250.00
//   (2) short   sell short 300 LFB at the bid 49.98 against a borrow at 1.00% a year  proceeds 14,994.00, commission 1.50
//               borrow fee on market value at the last price 50.00, ACT/360, from the trade date
//               collateral 102% of market value held as restricted cash                15,300.00
//   (3) loan    borrow 100,000.00 at 5% fixed, ACT/360, due Monday 16 March            interest 100,000 x 0.05 x 14 / 360 = 194.44
//   (4) option  buy 2 LFA calls, strike 100, expiring Friday 6 March, at 2.10          cost 420.00, commission 1.30
//               LFA closes at 50.00 on Friday: they expire worthless                   realized -420.00
//   (5) swap    interest-rate swap, 100,000 notional, under an agreement with variation margin;
//               marked at -5 per 100: value -5,000.00, so 5,000.00 is posted once      (first payments fall in June)
//   (6) hedge   the two Marketplace trades, (1) and (2), each get one post-trade hedge request: (1) is complete
//               (investment Strategy, holding period, objective) and is answered by the demo fixture; (2) is not, and waits
//
// By Tuesday 17 March, 10:00 New York (the last end-of-day run was Monday 16 March):
//   borrow fee accrued   300 x 50.00 x 0.01 x 14 / 360 = 5.8333 -> 5.83  (not yet paid: it is paid monthly)
//   loan                 repaid on the 16th: principal 100,000.00 and interest 194.44
//   all cash of Alpha    1,000,000 - 50,025 + 250 + 14,994 - 1.50 - 194.44 - 421.30 = 964,601.76
//                        of which restricted 15,300.00 and margin 5,000.00, so settled 944,301.76

import { evening } from './world.mjs';

export const LIFE_END = '2026-03-17T14:00:00.000Z';
const at10 = (date) => `${date}T${date < '2026-03-08' ? '15' : '14'}:00:00.000Z`;
export const WEEKDAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-16'];
/** Every instant a Terminal left running would see something happen at: each weekday evening (end of day) and each next morning. */
export const DAY_BY_DAY = [...WEEKDAYS.flatMap((d, i) => (i === 0 ? [evening(d)] : [at10(d), evening(d)])), LIFE_END];

const CTX = { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };

/** Monday morning: create the Book and put everything on. Returns the ids the checks need. */
export async function openLife(w, name = 'Life') {
  const book = await w.book(name, { capital: 2_000_000, funding: 1_000_000 });
  await w.fixture('rate', { code: 'TEST-3M', value: 4.0 });
  const lfa = await w.stock('LFA', { bid: 50.00, ask: 50.02, last: 50.00, bidSize: 50_000, askSize: 50_000 });
  const lfb = await w.stock('LFB', { bid: 49.98, ask: 50.02, last: 50.00, bidSize: 50_000, askSize: 50_000 });
  await w.fixture('borrow', { instrumentId: lfb.id, available: true, quantity: 100_000, feeRate: 0.01 });
  const call = await w.instrument({ productId: 'equity_option', name: 'LFA 2026-03-06 100 Call', symbol: 'LFA 260306C100', marketView: 'US_DERIV', venue: 'CBOE', venueType: 'exchange', venueCountry: 'US', underlyingId: lfa.id, tradingCcy: 'USD', multiplier: 100, terms: { right: 'C', strike: 100, expiration: '2026-03-06', exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
  await w.fixture('quote', { instrumentId: call.id, bid: 2.00, ask: 2.10, last: 2.05, bidSize: 500, askSize: 500 });
  await w.fixture('close', { instrumentId: lfa.id, date: '2026-03-06', value: 50 });

  const long = await w.trade({ ...w.ticketInput(book, lfa, 'buy', 1_000), ...CTX });
  await w.post('/api/corporate-actions', { instrumentId: lfa.id, type: 'cash_dividend', exDate: '2026-03-04', payDate: '2026-03-06', amount: 0.25 });
  const short = await w.short(book, lfb, 300);
  const loan = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'loan', action: 'borrow_cash', qty: 100_000, purpose: 'financing', contract: { productId: 'unsecured_loan', name: 'Life loan', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-03-16' } } }] });
  const option = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', underlyingId: lfa.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: call.id, qty: 2 }] });
  const agr = await w.post(`/api/books/${book.id}/agreements`, { name: 'Life CSA', counterparty: 'Dealer L', kind: 'bilateral', unitIds: [book.accountId], terms: { variationMargin: true } });
  const swap = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', qty: 100_000, statedPrice: 0, contract: { productId: 'interest_rate_swap', name: 'Life IRS', marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer L', collateralBasis: { type: 'agreement', agreementId: agr.id }, legs: [
    { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' }, { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } } }] });
  await w.post('/api/observations', { kind: 'price', subject: swap.positions[0].instrument.id, value: -5, units: 'per 100 notional' });
  return {
    book, lfa, lfb, call,
    strategies: { long: long.id, short: short.id, loan: loan.id, option: option.id, swap: swap.id },
    positions: {
      long: long.positions[0].positionId, short: short.positions.find((p) => p.family === 'equity').positionId, borrow: short.positions.find((p) => p.family === 'secloan').positionId,
      loan: loan.positions[0].positionId, option: option.positions[0].positionId, swap: swap.positions[0].positionId,
    },
  };
}

/** The figures worked out by hand at the top of this file, checked on Tuesday 17 March. */
export async function checkLife(w, c, L, label = 'life') {
  const { book } = L;
  const sum = (positionId, account) => w.sql('SELECT COALESCE(SUM(amount), 0) AS s FROM entries WHERE position_id = ? AND account = ?', positionId, account)[0].s;
  const near = (actual, expected, what) => c.near(Math.round(actual * 100) / 100, expected, `${label}: ${what}`);
  const n = (sql, ...p) => w.sql(sql, book.id, ...p)[0].n;
  // (1) long and dividend
  near(sum(L.positions.long, 'pos'), 50_020, 'long: 1,000 LFA at cost 50,020.00');
  near(-sum(L.positions.long, 'pnl.dividend'), 250, 'dividend income 250.00, once');
  c.eq(n(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = 'dividend'`), 1, `${label}: one dividend event`);
  // (2) short, borrow fee, collateral
  near(-sum(L.positions.borrow, 'accrued.liab'), 5.83, 'borrow fee accrued: 300 x 50.00 x 1% x 14 / 360 = 5.83');
  near(sum(L.positions.borrow, 'pnl.borrow'), 5.83, 'borrow fee expensed: 5.83');
  near(sum(L.positions.short, 'cash.restricted'), 15_300, 'short collateral: 102% x 300 x 50.00 = 15,300.00 restricted');
  // (3) loan
  near(sum(L.positions.loan, 'loan.liab'), 0, 'loan principal repaid in full');
  near(sum(L.positions.loan, 'pnl.funding'), 194.44, 'loan interest: 100,000 x 5% x 14 / 360 = 194.44, once');
  near(sum(L.positions.loan, 'accrued.liab'), 0, 'no loan interest left accrued');
  c.eq(n(`SELECT COUNT(DISTINCT e.event_id) AS n FROM entries e WHERE e.book_id = ? AND e.account = 'loan.liab'`), 2, `${label}: two events moved the loan principal (drawdown, repayment)`);
  // (4) option
  near(sum(L.positions.option, 'pnl.realized'), 420, 'option: 420.00 premium lost at expiry, once');
  near(sum(L.positions.option, 'pos'), 0, 'option: nothing left at cost');
  c.eq(n(`SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE 'option.exp%'`), 1, `${label}: one expiry event`);
  // (5) swap collateral
  c.eq(w.sql(`SELECT kind, amount FROM collateral_movements WHERE book_id = ? ORDER BY id`, book.id).map((r) => [r.kind, r.amount]), [['variation', 5_000]], `${label}: one collateral movement: 5,000.00 of variation margin posted`);
  // (6) hedge request
  c.eq(w.sql(`SELECT strategy_id, COUNT(*) AS n FROM hedge_requests WHERE book_id = ? GROUP BY strategy_id`, book.id).map((r) => [r.strategy_id, r.n]).sort(), [[L.strategies.long, 1], [L.strategies.short, 1]].sort(), `${label}: one hedge request for the long and one for the short, and no other`);
  // cash
  const cash = await w.cash(book.id, book.accountId);
  near(cash.restricted, 15_300, 'restricted cash 15,300.00');
  near(cash.margin, 5_000, 'margin posted 5,000.00');
  near(cash.settled, 944_301.76, 'settled cash 944,301.76');
  near(cash.settled + cash.restricted + cash.margin, 964_601.76, 'all cash of the Account 964,601.76');
  c.eq([cash.payable, cash.receivable], [0, 0], `${label}: nothing payable or receivable`);
  // nothing twice
  const twice = (sql, what) => { const rows = w.sql(sql, book.id); c.ok(rows.length === 0, `${label}: no ${what} exists twice`, JSON.stringify(rows).slice(0, 300)); };
  twice(`SELECT order_id, COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ? GROUP BY order_id HAVING COUNT(*) > 1`, 'fill of a single-fill order');
  twice(`SELECT fill_id, COUNT(*) AS n FROM settlements WHERE book_id = ? AND fill_id IS NOT NULL GROUP BY fill_id, kind, (amount > 0) HAVING COUNT(*) > 1`, 'settlement of a fill');
  twice(`SELECT json_extract(data, '$.settlementId') AS s, COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE 'settlement.%' GROUP BY s HAVING COUNT(*) > 1`, 'settlement event');
  twice(`SELECT position_id, type, business_date, COUNT(*) AS n FROM events WHERE book_id = ? AND type LIKE 'accrual%' AND position_id IS NOT NULL GROUP BY position_id, type, business_date, json_extract(data, '$.through') HAVING COUNT(*) > 1`, 'accrual of one position for one day');
  twice(`SELECT position_id, type, due_date, COUNT(*) AS n FROM tasks WHERE book_id = ? AND status = 'done' GROUP BY position_id, type, due_date, json_extract(data, '$.key') HAVING COUNT(*) > 1`, 'completed lifecycle item');
  twice(`SELECT submission, leg_no, COUNT(*) AS n FROM orders WHERE book_id = ? GROUP BY submission, leg_no HAVING COUNT(*) > 1`, 'order');
  const integ = await w.clean(c, book.id, `${label}: integrity`);
  return integ;
}

/**
 * What must be the same however the fifteen days were lived: every ledger balance, every position, cash, the
 * settlements, the collateral movements, the completed lifecycle items, and the number of events of each kind
 * that must happen exactly once. (Daily accrual events are not counted: a Terminal that was running books one a
 * day and a catch-up books one for the whole gap; their totals are in the ledger balances.)
 */
export async function lifeDigest(w, L) {
  const { book } = L;
  const b = await w.books(book.id);
  const names = Object.fromEntries(Object.entries(b.ledger.trial).map(([id, v]) => [id, v.owner]));
  const once = ['trade.fill', 'settlement.pay', 'settlement.receive', 'dividend', 'interest.payment', 'loan.drawdown', 'loan.repayment', 'option.expired', 'collateral.variation', 'collateral.call_failed', 'secloan.borrow', 'strategy.submitted', 'capital.deposit', 'transfer.funding'];
  const count = (type) => w.sql('SELECT COUNT(*) AS n FROM events WHERE book_id = ? AND type = ?', book.id, type)[0].n;
  const inst = (id) => w.sql('SELECT COALESCE(symbol, name) AS s FROM instruments WHERE id = ?', id)[0]?.s || id;
  return {
    balances: Object.fromEntries(Object.entries(b.ledger.trial).map(([id, v]) => [names[id], v.accounts])),
    positions: w.sql('SELECT instrument_id, qty, cost FROM positions WHERE book_id = ?', book.id).map((p) => `${inst(p.instrument_id)} ${p.qty} ${p.cost}`).sort(),
    cash: b.ledger.cash.map((x) => ({ ...x, owner: names[x.owner] })),
    settlements: w.sql('SELECT kind, ccy, amount, status FROM settlements WHERE book_id = ?', book.id).map((s) => `${s.kind} ${s.amount} ${s.ccy} ${s.status}`).sort(),
    collateral: w.sql('SELECT kind, ccy, amount FROM collateral_movements WHERE book_id = ?', book.id).map((s) => `${s.kind} ${s.amount} ${s.ccy}`).sort(),
    lifecycleDone: w.sql(`SELECT type, due_date FROM tasks WHERE book_id = ? AND status = 'done'`, book.id).map((t) => `${t.type} ${t.due_date}`).sort(),
    lifecycleOpen: w.sql(`SELECT type, due_date, status FROM tasks WHERE book_id = ? AND status IN ('pending','blocked','failed')`, book.id).map((t) => `${t.type} ${t.due_date} ${t.status}`).sort(),
    orders: w.sql('SELECT kind, action, qty, filled_qty, status FROM orders WHERE book_id = ?', book.id).map((o) => `${o.kind} ${o.action} ${o.filled_qty}/${o.qty} ${o.status}`).sort(),
    fills: w.sql('SELECT COUNT(*) AS n FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ?', book.id)[0].n,
    hedgeRequests: w.sql('SELECT status, trigger FROM hedge_requests WHERE book_id = ?', book.id).map((h) => `${h.trigger} ${h.status}`).sort(),
    onceEvents: Object.fromEntries(once.map((t) => [t, count(t)])),
    integrity: b.ok ? 'clean' : b.problems.join(' | '),
  };
}

/** Compare two digests section by section. */
export function sameLife(c, reference, actual, label) {
  for (const k of Object.keys(reference)) c.eq(actual[k], reference[k], `${label}: ${k} as in the day-by-day run`);
}

/** Live the fifteen days one evening and one morning at a time, as a Terminal left running would. */
export async function liveDayByDay(w) {
  for (const t of DAY_BY_DAY) await w.clock(t);
  await w.tick();
}
