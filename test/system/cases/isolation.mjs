// Isolation: nothing crosses from one Book to another through any route, no list leaks another
// Book's rows, nothing nets across Books; demo and normal paper databases are separate files and
// neither mode can read or write the other's; fixtures and the clock are refused in normal mode.
//
// Two Books are built side by side in one database, with the same instrument held long in one and
// short in the other and an object of every kind that has an id. The routes are read from
// server/api.js; every one must be accounted for in ROUTES below (a route missing from it fails the
// case), as one of:
//   scanned   read for Book B and searched for any id or name that belongs to Book A
//   cross     called for Book B with an id of Book A: must be refused and store nothing
//   id-only   takes one id and no Book: it acts inside the Book that owns the id; the other Book is unchanged
//   global    carries no Book data (registry, market data, calendars, settings of the Terminal, demo controls)

import { readFileSync, statSync } from 'node:fs';

export const area = 'isolation';
const both = (fn) => ({ engine: fn, api: fn });
const CTX = { investmentStrategy: { name: 'Core Equity' }, holdingPeriod: { days: 60 }, hedgeObjective: { type: 'downside_protection' } };

const ROUTES = {
  'GET /api/status': 'scanned', 'GET /api/data': 'scanned', 'GET /api/catalog': 'global', 'GET /api/calendars': 'global', 'GET /api/defaults': 'global', 'GET /api/templates': 'global',
  'PUT /api/data/connection': 'global', 'PUT /api/data/refresh': 'global', 'POST /api/data/test': 'global', 'PUT /api/calendars/:id/holidays': 'global',
  'GET /api/instruments': 'scanned', 'POST /api/instruments': 'global', 'GET /api/instruments/:id': 'scanned', 'PUT /api/instruments/:id': 'global', 'GET /api/instruments/:id/detail': 'scanned',
  'GET /api/instruments/:id/settlement': 'scanned', 'GET /api/instruments/:id/history': 'global', 'GET /api/instruments/:id/chain': 'global', 'GET /api/instruments/:id/contracts': 'global',
  'GET /api/quotes': 'global', 'POST /api/observations': 'global', 'GET /api/observations': 'global', 'GET /api/fx': 'global', 'GET /api/rates': 'global', 'GET /api/search': 'scanned',
  'GET /api/watchlists': 'global', 'POST /api/watchlists': 'global', 'PUT /api/watchlists/:id': 'global', 'DELETE /api/watchlists/:id': 'global', 'POST /api/watchlists/:id/items': 'global', 'DELETE /api/watchlists/:id/items/:instrumentId': 'global',
  'GET /api/books': 'global', 'POST /api/books': 'global', 'GET /api/books/:id': 'scanned', 'PUT /api/books/:id': 'cross', 'POST /api/books/:id/accounts': 'cross', 'POST /api/books/:id/capital': 'cross',
  'POST /api/books/:id/transfers': 'cross', 'GET /api/books/:id/treasury': 'scanned', 'GET /api/books/:id/alerts': 'scanned', 'POST /api/alerts/:id/dismiss': 'id-only',
  'GET /api/books/:id/accounting/:tab': 'cross', 'GET /api/books/:id/nav-history': 'cross', 'POST /api/books/:id/adjustments': 'cross', 'POST /api/events/:id/reverse': 'id-only',
  'POST /api/strategies/preview': 'cross', 'POST /api/strategies': 'cross', 'GET /api/strategies': 'cross', 'GET /api/strategies/:id': 'id-only', 'POST /api/strategies/:id/preview-action': 'id-only',
  'POST /api/strategies/:id/action': 'id-only', 'POST /api/orders/:id/cancel': 'id-only', 'POST /api/positions/:id/lifecycle': 'id-only', 'POST /api/instruments/:id/lifecycle': 'global',
  'POST /api/tasks/:id/settlement-amount': 'id-only', 'GET /api/corporate-actions': 'global', 'POST /api/corporate-actions': 'global',
  'GET /api/analytics/signals': 'scanned', 'GET /api/analytics/strategies': 'scanned', 'POST /api/analytics/strategies/resolve': 'cross',
  'GET /api/hedge/service': 'global', 'POST /api/hedge/requests': 'cross', 'GET /api/hedge/requests': 'scanned', 'GET /api/hedge/requests/:id': 'id-only', 'POST /api/hedge/requests/:id/complete': 'id-only',
  'POST /api/hedge/requests/:id/refresh': 'id-only', 'GET /api/books/:id/protection': 'scanned', 'POST /api/hedge/requests/:id/preview': 'id-only', 'POST /api/hedge/requests/:id/dismiss': 'id-only',
  'POST /api/hedge/requests/:id/seen': 'id-only', 'GET /api/hedge/prompts': 'scanned', 'GET /api/hedge/queue': 'scanned', 'POST /api/hedge/refresh': 'global',
  'GET /api/books/:id/agreements': 'scanned', 'POST /api/books/:id/agreements': 'cross', 'GET /api/books/:id/agreements/:agreementId': 'cross', 'PUT /api/books/:id/agreements/:agreementId': 'cross',
  'POST /api/books/:id/agreements/:agreementId/close': 'cross', 'GET /api/books/:id/collateral': 'cross', 'POST /api/books/:id/collateral/retry': 'cross', 'PUT /api/books/:id/positions/:positionId/collateral-basis': 'cross',
  'POST /api/engine/tick': 'global', 'POST /api/demo/advance': 'global', 'POST /api/demo/hedge-fixture': 'global', 'GET /api/demo/hedge-script': 'global', 'POST /api/demo/hedge-script': 'global',
  'GET /api/demo/fixtures': 'global', 'POST /api/demo/fixtures/:kind': 'global', 'GET /api/books/:id/integrity': 'scanned',
};
const apiRoutes = () => [...new Set([...readFileSync(new URL('../../../server/api.js', import.meta.url), 'utf8').matchAll(/\br\.(get|post|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`))];

const loanLeg = (name, qty) => ({ kind: 'loan', action: 'borrow_cash', qty, purpose: 'financing', contract: { productId: 'unsecured_loan', name, marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { loanType: 'unsecured', rateType: 'fixed', rate: 0.05, maturity: '2026-06-01' } } });
const swapLeg = (name, agreementId) => ({ kind: 'trade', action: 'buy', qty: 100_000, statedPrice: 0, contract: { productId: 'interest_rate_swap', name, marketView: 'US_DERIV', venueType: 'otc', tradingCcy: 'USD', terms: { effective: '2026-03-02', maturity: '2027-03-02', counterparty: 'Dealer I', collateralBasis: { type: 'agreement', agreementId }, legs: [
  { id: 'A', side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' }, { id: 'B', side: 'receive', type: 'float', ccy: 'USD', index: 'TEST-3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } } });

/** Two Books with an object of every kind. Book A: Account "Aardvark"; Book B: Account "Bison". */
async function twoBooks(w) {
  await w.fixture('rate', { code: 'TEST-3M', value: 4.0 });
  const inst = await w.stock('ISO', { bid: 50.00, ask: 50.02, last: 50.00, bidSize: 50_000, askSize: 50_000 });
  await w.fixture('borrow', { instrumentId: inst.id, available: true, quantity: 100_000, feeRate: 0.01 });
  const build = async (name, account) => {
    const book = await w.book(name, { account });
    const long = name.endsWith('A') ? await w.trade({ ...w.ticketInput(book, inst, 'buy', 200), ...CTX }) : null;
    const short = name.endsWith('B') ? await w.trade({ ...w.ticketInput(book, inst, 'sell_short', 100), ...CTX }) : null;
    const working = await w.trade(w.ticketInput(book, inst, 'buy', 10, { order: { orderType: 'limit', limitPrice: 40, tif: 'gtc' } }));
    const loan = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [loanLeg(`${name} loan`, 25_000)] });
    const agr = await w.post(`/api/books/${book.id}/agreements`, { name: 'CSA Dealer I', counterparty: 'Dealer I', kind: 'bilateral', unitIds: [book.accountId], terms: { variationMargin: true } });
    const swap = await w.trade({ bookId: book.id, unitId: book.accountId, template: 'custom', legs: [swapLeg(`${name} IRS`, agr.id)] });
    return { ...book, long, short, working, loan, agr, swap, main: long || short };
  };
  const A = await build('Iso A', 'Aardvark');
  const B = await build('Iso B', 'Bison');
  await w.tick();
  for (const X of [A, B]) {
    X.hedge = (await w.get('/api/hedge/requests', { bookId: X.id })).items.find((r) => r.strategyId === X.main.id);
    const q = (sql, ...p) => w.sql(sql, X.id, ...p).map((r) => Object.values(r)[0]);
    // Every id that belongs to this Book alone (instruments are the shared registry and are not in this list).
    X.ids = [X.id, ...q('SELECT id FROM units WHERE book_id = ?'), ...q('SELECT id FROM strategies WHERE book_id = ?'), ...q('SELECT id FROM orders WHERE book_id = ?'), ...q('SELECT id FROM positions WHERE book_id = ?'),
      ...q('SELECT id FROM agreements WHERE book_id = ?'), ...q('SELECT id FROM hedge_requests WHERE book_id = ?'), ...q('SELECT id FROM settlements WHERE book_id = ?'), ...q('SELECT id FROM tasks WHERE book_id = ?'),
      ...q('SELECT id FROM holds WHERE book_id = ?'), ...q('SELECT f.id FROM fills f JOIN orders o ON o.id = f.order_id WHERE o.book_id = ?')];
    X.names = [X.name, X.name.endsWith('A') ? 'Aardvark' : 'Bison'];
  }
  return { inst, A, B };
}
/** A preview must be refused by the route or carry a blocking error. */
function blocked(c, res, label, text) {
  if (!res.ok) return c.refused(res, text ? { text } : {}, label);
  const errs = (res.body.checks || []).filter((x) => x.level === 'error').map((x) => x.message).join(' | ');
  const ok = c.ok(res.body.blocking >= 1, `${label}: the preview blocks`, JSON.stringify(res.body.checks));
  if (ok && text) c.match(errs, text, `${label}: the reason`);
  if (ok) c.note(`${label}: "${errs.slice(0, 200)}"`);
  return ok;
}

export default [
  {
    id: 'book-routes',
    title: 'Book isolation through every API route',
    proves: 'An id of one Book used in a call scoped to another Book is refused; no read of one Book returns anything of another; a route that takes a single id acts only inside the Book that owns it.',
    expected: 'Books "Iso A" (Account Aardvark) and "Iso B" (Account Bison) each hold a position in the same stock, a working order, a loan, a collateral agreement, a swap under it and a hedge request. (1) Every route of server/api.js is classified (scanned, cross, id-only, global) and the classification covers them all. (2) Every read scoped to Book B, the instrument registry and search included, is searched for each id and name that belongs to Book A (Book, Treasury, Account, strategy instances, orders, fills, positions, settlements, lifecycle items, holds, agreement, hedge requests, and the names of the loan and swap contracts written for A): none appears; and the same the other way round. (3) Each cross-Book call (a unit, position, strategy instance, agreement, hedge request or event of A used with Book B) is refused with a 4xx answer or a blocking preview, and stores nothing in either Book. (4) Each single-id route used on an object of A changes A only: Book B\'s ledger, positions, cash and row counts are exactly as before. The integrity check, which includes "every entry and position belongs to this Book", is clean for both.',
    levels: {
      ...both(async (w, c) => {
        const { inst, A, B } = await twoBooks(w);
        // (1) the classification is complete
        const routes = apiRoutes();
        c.ok(routes.length >= 85, 'the routes were read from server/api.js', `${routes.length} found`);
        c.eq(routes.filter((r) => !ROUTES[r]), [], 'every route is classified');
        c.eq(Object.keys(ROUTES).filter((r) => !routes.includes(r)), [], 'the classification lists no route that does not exist');
        const kinds = Object.values(ROUTES).reduce((a, k) => ({ ...a, [k]: (a[k] || 0) + 1 }), {});
        c.note(`${routes.length} routes: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);

        // (2) no read of one Book returns anything of the other
        const reads = (X) => {
          const b = `/api/books/${X.id}`, q = { bookId: X.id };
          const out = [['/api/status'], ['/api/data'], ['/api/instruments', q], ['/api/instruments', { ...q, arrangements: '1' }], [`/api/instruments/${inst.id}`, q], [`/api/instruments/${inst.id}/detail`, q], [`/api/instruments/${inst.id}/settlement`, q],
            ['/api/search', { q: 'Iso', bookId: X.id }], [b], [`${b}/treasury`], [`${b}/alerts`], [`${b}/nav-history`], [`${b}/protection`], [`${b}/agreements`], [`${b}/agreements/${X.agr.id}`], [`${b}/collateral`], [`${b}/integrity`],
            ['/api/strategies', q], ['/api/strategies', { ...q, status: 'active' }], [`/api/strategies/${X.main.id}`], ['/api/analytics/signals', q], ['/api/analytics/strategies', q],
            ['/api/hedge/requests', q], [`/api/hedge/requests/${X.hedge?.id}`], ['/api/hedge/prompts', q], ['/api/hedge/queue', q]];
          for (const tab of ['pnl', 'positions', 'balance', 'borrowings', 'pending', 'failed', 'history']) for (const scope of ['book', 'treasury', 'accounts', X.accountId, `${X.treasuryId},${X.accountId}`]) out.push([`${b}/accounting/${tab}`, { scope, accruals: '1', limit: '500' }]);
          return out;
        };
        for (const [mine, other] of [[B, A], [A, B]]) {
          let scanned = 0;
          const leaks = [];
          for (const [path, query] of reads(mine)) {
            const r = await w.req('GET', path, undefined, query);
            if (!c.ok(r.ok, `reading ${path} for ${mine.name}`, r.error)) continue;
            scanned++;
            const text = JSON.stringify(r.body);
            for (const id of [...other.ids, ...other.names]) if (text.includes(id)) leaks.push(`${path}${query?.scope ? `?scope=${query.scope}` : ''} contains ${id}`);
          }
          c.eq(leaks, [], `no read of ${mine.name} contains an id or a name of ${other.name}`);
          c.note(`${scanned} reads of ${mine.name} searched for ${other.ids.length} ids and ${other.names.length} names of ${other.name}`);
        }
        for (const path of ['/api/hedge/requests', '/api/hedge/prompts']) {
          const r = await w.req('GET', path);
          c.ok(!r.ok || (r.body.items || []).length === 0, `${path} without a Book returns nothing`, JSON.stringify(r.body).slice(0, 200));
        }
        for (const path of ['/api/strategies', '/api/hedge/queue']) c.refused(await w.req('GET', path), { status: 400, text: /bookId is required/ }, `${path} without a Book`);

        // (3) ids of A in calls scoped to B
        const fpA = await w.books(A.id), fpB = await w.books(B.id), stored = w.fingerprint();
        const b = `/api/books/${B.id}`;
        const posA = A.long.positions[0].positionId, loanPosA = A.loan.positions[0].positionId, swapPosA = A.swap.positions[0].positionId;
        for (const tab of ['pnl', 'positions', 'balance', 'borrowings', 'pending', 'failed', 'history']) c.refused(await w.req('GET', `${b}/accounting/${tab}`, undefined, { scope: A.accountId }), { status: 404, text: /Unknown accounting scope/ }, `GET accounting/${tab} of B with A's Account as scope`);
        c.refused(await w.req('GET', `${b}/accounting/balance`, undefined, { scope: `${B.accountId},${A.accountId}` }), { status: 404 }, 'GET accounting of B with an Account of each Book as scope');
        c.refused(await w.req('GET', `${b}/nav-history`, undefined, { scope: A.accountId }), {}, 'GET nav-history of B with A\'s Account');
        c.refused(await w.req('GET', `${b}/collateral`, undefined, { scope: A.accountId }), {}, 'GET collateral of B with A\'s Account');
        c.refused(await w.req('GET', '/api/strategies', undefined, { bookId: B.id, scope: A.accountId }), {}, 'GET strategies of B with A\'s Account');
        c.refused(await w.req('POST', `${b}/transfers`, { fromUnitId: A.accountId, toUnitId: B.accountId, ccy: 'USD', amount: 1_000 }), { text: /different Book/ }, 'transfer from A\'s Account into B');
        c.refused(await w.req('POST', `${b}/transfers`, { fromUnitId: B.accountId, toUnitId: A.accountId, ccy: 'USD', amount: 1_000 }), { text: /different Book/ }, 'transfer from B into A\'s Account');
        c.refused(await w.req('POST', `${b}/transfers`, { fromUnitId: A.treasuryId, toUnitId: A.accountId, ccy: 'USD', amount: 1_000 }), { text: /different Book/ }, 'transfer between A\'s units through B');
        c.refused(await w.req('POST', `${b}/adjustments`, { unitId: A.accountId, ccy: 'USD', amount: 5, category: 'fee', note: 'cross-Book' }), { text: /different Book/ }, 'adjustment in B on A\'s Account');
        const eventA = w.sql('SELECT id FROM events WHERE book_id = ? ORDER BY id DESC LIMIT 1', A.id)[0].id;
        c.refused(await w.req('POST', `${b}/adjustments`, { unitId: B.accountId, ccy: 'USD', amount: 5, category: 'fee', note: 'cross-Book', correctsEventId: eventA }), { text: /not found in this Book/ }, 'adjustment in B correcting an event of A');
        const pv = (body) => w.preview({ bookId: B.id, unitId: B.accountId, template: 'custom', ...body });
        c.refused(await pv({ unitId: A.accountId, legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 10 }] }), { text: /different Book/ }, 'package in B for A\'s Account');
        blocked(c, await pv({ attachTo: A.long.id, legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 10 }] }), 'package in B attached to A\'s strategy instance');
        blocked(c, await pv({ legs: [{ kind: 'link', action: 'use_existing', instrumentId: inst.id, qty: 100, sourcePositionId: posA }] }), 'package in B using A\'s position');
        blocked(c, await pv({ legs: [{ kind: 'repay', action: 'repay_cash', qty: 25_000, targetPositionId: loanPosA }] }), 'package in B repaying A\'s loan');
        blocked(c, await pv({ legs: [{ kind: 'repo_open', action: 'repo', qty: 5_000, purpose: 'financing', collateralPositionId: posA, contract: { productId: 'term_repo', name: 'Cross repo', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { collateralInstrumentId: inst.id, collateralQty: 100, haircut: 0.02, rateType: 'fixed', rate: 0.04, term: 'term', endDate: '2026-03-10' } } }] }), 'repo in B pledging A\'s position');
        blocked(c, await pv({ legs: [{ kind: 'funding', action: 'treasury_funding', qty: 1_000, purpose: 'financing', funding: { fromUnitId: A.treasuryId, ccy: 'USD', amount: 1_000 } }, { kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 10, dependsOn: [1] }] }), 'package in B funded from A\'s Treasury', /not in this Book/);
        blocked(c, await pv({ legs: [swapLeg('Cross IRS', A.agr.id)] }), 'swap in B under A\'s agreement');
        const okPv = await w.post('/api/strategies/preview', { bookId: B.id, unitId: B.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: inst.id, qty: 10 }] });
        c.refused(await w.req('POST', '/api/strategies', { ...w.confirmBody(okPv), unitId: A.accountId }), {}, 'confirming B\'s preview for A\'s Account');
        c.refused(await w.req('POST', '/api/strategies', { ...w.confirmBody(okPv), attachTo: A.long.id, clientToken: `${okPv.token}-x` }), {}, 'confirming B\'s preview attached to A\'s strategy instance');
        c.refused(await w.req('PUT', `${b}/positions/${swapPosA}/collateral-basis`, { basis: { type: 'uncollateralized' } }), { status: 404, text: /not found in this Book/ }, 'collateral basis of A\'s position through B');
        c.refused(await w.req('GET', `${b}/agreements/${A.agr.id}`), { text: /different Book|not found/i }, 'reading A\'s agreement through B');
        c.refused(await w.req('PUT', `${b}/agreements/${A.agr.id}`, { terms: { variationMargin: false } }), { text: /different Book|not found/i }, 'editing A\'s agreement through B');
        c.refused(await w.req('POST', `${b}/agreements/${A.agr.id}/close`), { text: /different Book|not found/i }, 'closing A\'s agreement through B');
        c.refused(await w.req('GET', `/api/instruments/${A.swap.positions[0].instrument.id}`, undefined, { bookId: B.id }), { status: 404, text: /belongs to another Book/ }, 'reading A\'s swap contract on behalf of B');
        c.refused(await w.req('GET', `/api/instruments/${A.loan.positions[0].instrument.id}/detail`, undefined, { bookId: B.id }), { status: 404, text: /belongs to another Book/ }, 'opening A\'s loan contract on behalf of B');
        c.refused(await w.req('POST', `${b}/agreements`, { name: 'Cross CSA', counterparty: 'Dealer X', kind: 'bilateral', unitIds: [A.accountId], terms: {} }), {}, 'an agreement of B covering A\'s Account');
        c.refused(await w.req('POST', `${b}/agreements`, { name: 'Cross CSA 2', counterparty: 'Dealer X', kind: 'bilateral', unitIds: [B.accountId], postingUnitId: A.treasuryId, terms: {} }), {}, 'an agreement of B posted by A\'s Treasury');
        c.refused(await w.req('POST', '/api/hedge/requests', { bookId: B.id, unitId: B.accountId, strategyId: A.long.id, trigger: 'manual' }), {}, 'hedge request in B for A\'s strategy instance');
        c.refused(await w.req('POST', '/api/hedge/requests', { bookId: B.id, unitId: A.accountId, trigger: 'manual', scope: { type: 'account' } }), {}, 'hedge request in B for A\'s Account');
        c.refused(await w.req('PUT', `${b}`, { name: 'Iso A' }), { status: 409 }, 'renaming B to the name of A');
        c.refused(await w.req('POST', `${b}/accounts`, { name: 'Bison' }), { status: 409 }, 'a second Account "Bison" in B (the name is free in A, and stays free)');
        w.sameStored(c, stored, w.fingerprint(), 'the refused cross-Book calls stored nothing at all');
        // Calls that act on B only: A is untouched.
        await w.post(`${b}/capital`, { type: 'deposit', ccy: 'USD', amount: 7_000 });
        await w.post(`${b}/collateral/retry`);
        const listed = await w.get('/api/analytics/strategies', { bookId: B.id });
        const first = (listed.strategies || listed.items || listed.available || [])[0];
        const hedgeA0 = w.sql('SELECT request FROM hedge_requests WHERE id = ?', A.hedge.id)[0].request;
        const res = await w.req('POST', '/api/analytics/strategies/resolve', { bookId: B.id, name: 'Core Equity', id: first?.id });
        c.ok(res.ok, 'the typed Strategy name "Core Equity" is resolved in B', res.error);
        c.eq(w.sql('SELECT request FROM hedge_requests WHERE id = ?', A.hedge.id)[0].request, hedgeA0, 'the same typed name in A stays as it was: unresolved');
        w.sameBooks(c, fpA, await w.books(A.id), 'a deposit, a collateral retry and a Strategy resolution in B: Book A');
        w.sameRows(c, fpA, await w.books(A.id), 'a deposit, a collateral retry and a Strategy resolution in B: Book A');

        // (4) single-id routes used on A's objects change A only
        const b0 = await w.books(B.id);
        const actions = [
          ['POST', `/api/orders/${A.working.orders[0].id}/cancel`],
          ['POST', `/api/positions/${posA}/lifecycle`, { action: 'cashflow', category: 'fee', amount: -1, note: 'isolation test' }],
          ['POST', `/api/strategies/${A.long.id}/preview-action`, { action: 'close' }],
          ['POST', `/api/hedge/requests/${A.hedge.id}/seen`],
          ['POST', `/api/hedge/requests/${A.hedge.id}/refresh`],
          ['POST', `/api/hedge/requests/${A.hedge.id}/complete`, { holdingPeriod: { days: 30 } }],
          ['POST', `/api/hedge/requests/${A.hedge.id}/dismiss`],
          ['POST', `/api/events/${w.sql(`SELECT id FROM events WHERE book_id = ? AND type = 'transfer.funding' LIMIT 1`, A.id)[0].id}/reverse`, { note: 'isolation test' }],
        ];
        const taskA = w.sql(`SELECT id FROM tasks WHERE book_id = ? AND status = 'pending' LIMIT 1`, A.id)[0];
        if (taskA) actions.push(['POST', `/api/tasks/${taskA.id}/settlement-amount`, { amount: 3 }]);
        for (const [m, path, body] of actions) { const r = await w.req(m, path, body); c.ok(r.ok || r.status < 500, `${m} ${path.replace(/[A-Z]{2,4}-[0-9A-F]{10}/, ':id')} on an object of A is answered`, r.error); }
        const actionA = await w.req('POST', `/api/strategies/${A.working.id}/action`, { action: 'cancel_working' });
        c.refused(actionA, { status: 400 }, 'cancel working legs of A\'s (already cancelled) order');
        const b1 = await w.books(B.id);
        w.sameBooks(c, b0, b1, 'single-id routes used on A: Book B');
        w.sameRows(c, b0, b1, 'single-id routes used on A: Book B');
        await w.clean(c, A.id, 'Book A integrity');
        await w.clean(c, B.id, 'Book B integrity');
      }),
      browser: async (bz, c) => bz.cases.bookIsolation(bz, c),
    },
  },
  {
    id: 'no-netting',
    title: 'Nothing nets or consolidates across Books',
    proves: 'The same instrument held long in one Book and short in another stays two separate holdings with separate cash, collateral, events and totals; an event of the instrument is booked in each Book for that Book\'s own holding.',
    expected: 'Book A is long 200 ISO; Book B is short 100 ISO. Holdings: A shows long 200, short 0, net +200; B shows long 0, short 100, net -100; neither shows 100. A dividend of 0.25 a share (ex Wednesday, paid Friday): A receives 200 x 0.25 = 50.00 in A\'s ledger; B pays compensation of 100 x 0.25 = 25.00 to its lender from B\'s ledger; nothing of 25.00 net appears anywhere. Each Book\'s net asset value is its own; a deposit of 10,000.00 into A changes A\'s by 10,000.00 and B\'s by nothing. The variation-margin call on each Book\'s swap (marked -5: 5,000.00) is posted by each Book from its own cash under its own agreement (one movement per Book, each naming its own agreement). Every entry of each Book\'s events belongs to units of that Book.',
    levels: {
      ...both(async (w, c) => {
        const { inst, A, B } = await twoBooks(w);
        const holdings = async (X) => (await w.get(`/api/books/${X.id}/accounting/positions`, { scope: 'book' })).holdings.find((h) => h.instrument.id === inst.id);
        const hA = await holdings(A), hB = await holdings(B);
        c.eq([hA.long, hA.short, hA.net], [200, 0, 200], 'Book A: long 200, short 0, net +200');
        c.eq([hB.long, hB.short, hB.net], [0, 100, -100], 'Book B: long 0, short 100, net -100');
        const listA = (await w.get('/api/instruments', { bookId: A.id, q: 'ISO' })).items.find((i) => i.id === inst.id).holdings;
        const listB = (await w.get('/api/instruments', { bookId: B.id, q: 'ISO' })).items.find((i) => i.id === inst.id).holdings;
        c.eq([listA.net, listA.long, listA.short, listB.net, listB.long, listB.short], [200, 200, 0, -100, 0, 100], 'the instrument list shows each Book its own holding');
        await w.post('/api/corporate-actions', { instrumentId: inst.id, type: 'cash_dividend', exDate: '2026-03-04', payDate: '2026-03-06', amount: 0.25 });
        for (const X of [A, B]) await w.post('/api/observations', { kind: 'price', subject: X.swap.positions[0].instrument.id, value: -5, units: 'per 100 notional' });
        const navA0 = (await w.get(`/api/books/${A.id}`)).overview.nav, navB0 = (await w.get(`/api/books/${B.id}`)).overview.nav;
        await w.post(`/api/books/${A.id}/capital`, { type: 'deposit', ccy: 'USD', amount: 10_000 });
        c.near((await w.get(`/api/books/${A.id}`)).overview.nav, navA0 + 10_000, 'a deposit into A raises A\'s net asset value by 10,000.00');
        c.near((await w.get(`/api/books/${B.id}`)).overview.nav, navB0, 'and leaves B\'s as it was');
        for (const t of ['2026-03-02T22:30:00.000Z', '2026-03-04T15:00:00.000Z', '2026-03-06T15:00:00.000Z', '2026-03-06T22:30:00.000Z']) await w.clock(t);
        await w.tick();
        const div = (X) => w.sql(`SELECT e.type, e.unit_id, (SELECT SUM(amount) FROM entries x WHERE x.event_id = e.id AND x.account = 'cash') AS cash FROM events e WHERE e.book_id = ? AND e.type LIKE 'dividend%'`, X.id);
        c.eq(div(A).map((r) => [r.type, r.unit_id, r.cash]), [['dividend', A.accountId, 50]], 'Book A received 50.00 on its 200 shares');
        c.eq(div(B).map((r) => [r.type, r.unit_id, r.cash]), [['dividend.compensation', B.accountId, -25]], 'Book B paid 25.00 of compensation on its 100 borrowed shares');
        for (const X of [A, B]) {
          const mv = w.sql('SELECT kind, amount, agreement_id, holder_unit_id FROM collateral_movements WHERE book_id = ?', X.id);
          c.eq(mv.map((m) => [m.kind, m.amount, m.agreement_id, m.holder_unit_id]), [['variation', 5_000, X.agr.id, X.accountId]], `${X.name}: one variation-margin movement of 5,000.00 under its own agreement, from its own Account`);
          const foreign = w.sql(`SELECT COUNT(*) AS n FROM entries en JOIN events e ON e.id = en.event_id WHERE e.book_id = ? AND (en.book_id <> ? OR en.unit_id NOT IN (SELECT id FROM units WHERE book_id = ?))`, X.id, X.id, X.id)[0].n;
          c.eq(foreign, 0, `${X.name}: every entry of its events belongs to its own units`);
          await w.clean(c, X.id, `${X.name} integrity`);
        }
      }),
      browser: async (bz, c) => bz.cases.bookIsolation(bz, c),
    },
  },
  {
    id: 'normal-mode-refusals',
    title: 'Fixtures and the clock are refused in normal mode',
    proves: 'The demo controls (moving the clock, test fixtures, the hedge fixture and scripted service) do not exist outside demo mode, and normal mode starts empty.',
    world: { demo: false },
    expected: 'A Terminal in normal mode: it has no Book and no instrument when first started (nothing is seeded); status says it is not a demo and its clock is not simulated. Each of these is refused with 403 and stores nothing: moving the clock (by an amount and to an instant); every kind of fixture (quote, close, fx, rate, borrow); listing fixtures; switching the demo hedge fixture; reading, loading or clearing a hedge script. The top-level data mode is the Shaffer adapter with both ports awaiting. Books and manual prices work as usual.',
    levels: {
      ...both(async (w, c) => {
        const st = await w.get('/api/status');
        c.eq([st.demo, st.counts.books, st.counts.instruments], [false, 0, 0], 'not a demo; no Book and no instrument seeded');
        // The engine level drives a clock of its own; that the clock is the real one is checked against a real server.
        if (w.level === 'api') c.eq(st.clockSimulated, false, 'the clock is not simulated');
        c.eq([st.data.market.connection, st.data.analytics.connection], ['awaiting', 'awaiting'], 'both Shaffer ports are awaiting');
        const book = await w.book('Normal mode', { settings: null });
        const inst = await w.instrument({ productId: 'common_stock', name: 'Plain Works Inc.', symbol: 'PLN', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {} });
        const fp = w.fingerprint();
        const now = st.now;
        const refusals = [
          ['POST', '/api/demo/advance', { ms: 86_400_000 }], ['POST', '/api/demo/advance', { to: '2027-01-01T00:00:00.000Z' }],
          ['POST', '/api/demo/fixtures/quote', { instrumentId: inst.id, bid: 1, ask: 2, last: 1.5 }], ['POST', '/api/demo/fixtures/close', { instrumentId: inst.id, date: '2026-03-02', value: 5 }],
          ['POST', '/api/demo/fixtures/fx', { pair: 'EUR/USD', rate: 1.1 }], ['POST', '/api/demo/fixtures/rate', { code: 'X', value: 1 }], ['POST', '/api/demo/fixtures/borrow', { instrumentId: inst.id, available: true, quantity: 1, feeRate: 0.01 }],
          ['GET', '/api/demo/fixtures'], ['POST', '/api/demo/hedge-fixture', { enabled: true }], ['GET', '/api/demo/hedge-script'], ['POST', '/api/demo/hedge-script', { responses: [{ packages: [] }] }], ['POST', '/api/demo/hedge-script', { clear: true }],
        ];
        for (const [m, path, body] of refusals) c.refused(await w.req(m, path, body), { status: 403 }, `${m} ${path}${body?.to ? ' (to an instant)' : ''}`);
        w.sameStored(c, fp, w.fingerprint(), 'the refused demo controls stored nothing');
        const st2 = await w.get('/api/status');
        c.ok(Math.abs(Date.parse(st2.now) - Date.parse(now)) < 60_000, 'the clock did not move', `${now} -> ${st2.now}`);
        if (w.level === 'api') c.ok(Math.abs(Date.parse(st2.now) - Date.now()) < 60_000, 'and is the real time', st2.now);
        const q = await w.get('/api/quotes', { ids: inst.id });
        c.eq([q.quotes[inst.id].observation, q.awaitingMessage], [null, 'Awaiting Shaffer data connection'], 'no price is invented for the instrument: it is awaiting');
        await w.post('/api/observations', { kind: 'price', subject: inst.id, value: 12.5, currency: 'USD' });
        c.eq((await w.get('/api/quotes', { ids: inst.id })).quotes[inst.id].observation?.status, 'manual', 'a price entered by hand is shown, labelled manual');
        await w.clean(c, book.id);
      }),
      browser: async (bz, c) => bz.cases.normalMode(bz, c),
    },
  },
  {
    id: 'demo-normal-databases',
    title: 'Demo and normal paper databases are separate files',
    proves: 'The demo environment and the normal paper books live in two database files chosen by the mode; a Terminal in one mode never opens, reads or writes the other\'s file.',
    world: { demo: false, dbByMode: true },
    expected: 'One data directory, no database named: a server started in normal mode reports terminal.db and a server started in demo mode reports demo.db, side by side and running at the same time. The normal one has no Book until "Paper" is created in it; the demo one has its seeded "Demo Book" and gets "Demo extra". Each lists only its own Books and instruments. Trading, moving the demo clock a month ahead and running engine cycles in the demo leave every row of terminal.db identical (and the reverse: activity in normal mode leaves every row of demo.db identical). After both are stopped and started again each still has exactly its own Books, and the two files are still distinct files with different content.',
    levels: {
      engine: 'the choice of file is made by the server at start (server/config.js); the engine level opens a database it is given',
      api: async (w, c) => {
        const n = w; // normal mode, terminal.db
        const d = await w.open({ demo: true, dbByMode: true, sandbox: w.sandbox, tag: 'demo-side' });
        const fileN = n.t.server.database, fileD = d.t.server.database;
        c.match(fileN, /[\\/]terminal\.db$/, 'the normal server reports terminal.db');
        c.match(fileD, /[\\/]demo\.db$/, 'the demo server reports demo.db');
        c.ok(fileN !== fileD && fileN.replace(/terminal\.db$/, '') === fileD.replace(/demo\.db$/, ''), 'two files in the same data directory', `${fileN} | ${fileD}`);
        const names = async (x) => (await x.get('/api/books')).items.map((b) => b.name).sort();
        c.eq(await names(n), [], 'the normal Terminal starts with no Book');
        c.eq(await names(d), ['Demo Book'], 'the demo Terminal has its seeded Demo Book');
        c.eq([(await n.get('/api/status')).demo, (await d.get('/api/status')).demo], [false, true], 'each says which mode it is in');
        const paper = await n.book('Paper', { settings: null });
        const instN = await n.instrument({ productId: 'common_stock', name: 'Paper Only Inc.', symbol: 'PPRX', marketView: 'US_CASH', venue: 'NYSE', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', terms: {}, conventions: { tradingCalendar: 'ALLDAYS' } });
        await n.trade({ bookId: paper.id, unitId: paper.accountId, template: 'custom', legs: [{ kind: 'trade', action: 'buy', instrumentId: instN.id, qty: 100, statedPrice: 20 }] });
        c.eq(await names(d), ['Demo Book'], 'a Book created in normal mode does not appear in the demo');
        c.eq((await d.get('/api/instruments', { q: 'PPRX' })).items.length, 0, 'nor does its instrument');

        // Activity in the demo: terminal.db does not change.
        const fpN = n.fingerprint();
        const extra = await d.book('Demo extra');
        const instD = await d.stock('DMOX');
        await d.buy(extra, instD, 300);
        await d.post('/api/demo/advance', { ms: 30 * 86_400_000 });
        await d.tick(); await d.tick();
        n.sameStored(c, fpN, n.fingerprint(), 'demo trading, a month of demo clock and engine cycles: every row of terminal.db is as before');
        c.eq(await names(n), ['Paper'], 'the normal Terminal still lists only its own Book');
        c.eq((await n.get('/api/instruments', { q: 'DMOX' })).items.length, 0, 'the demo instrument is not in the normal registry');
        c.ok(Math.abs(Date.parse((await n.get('/api/status')).now) - Date.now()) < 60_000, 'the normal clock is still the real time');

        // Activity in normal mode: demo.db does not change.
        const fpD = d.fingerprint();
        await n.post(`/api/books/${paper.id}/capital`, { type: 'deposit', ccy: 'USD', amount: 5_000 });
        await n.post('/api/observations', { kind: 'price', subject: instN.id, value: 21, currency: 'USD' });
        await n.tick();
        d.sameStored(c, fpD, d.fingerprint(), 'activity in normal mode: every row of demo.db is as before');

        // Both stopped and started again.
        await n.restart(); await d.restart();
        c.eq(await names(n), ['Paper'], 'after a restart the normal Terminal has exactly its own Book');
        c.eq(await names(d), ['Demo Book', 'Demo extra'], 'after a restart the demo has exactly its own Books');
        c.eq([n.t.server.database, d.t.server.database], [fileN, fileD], 'each reopened its own file');
        c.ok(statSync(fileN).ino !== statSync(fileD).ino, 'the two files are distinct files');
        const tables = (x) => x.sql(`SELECT COUNT(*) AS n FROM books`)[0].n;
        c.eq([tables(n), tables(d)], [1, 2], 'terminal.db holds one Book, demo.db two');
      },
      browser: async (bz, c) => bz.cases.normalMode(bz, c),
    },
  },
];
