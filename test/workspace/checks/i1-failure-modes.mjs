// Browser checks of the owner's failure-mode list (OWNER_REQUEST3 section 8) on the real interface (i1): empty and
// partial answers, missing fields, stale data, revisions arriving after the first display, pagination, server errors
// and throttling, disconnection and reconnection of the gateway with every panel recovering without a reload, rapid
// instrument switching in the drawer and on the page (chart and statements grid included), duplicate deliveries, unit
// and currency mismatches, and persistence across a reload and a server restart.
//
// Run by test/workspace/run-browser.mjs on its demo server, or alone:
//   node --disable-warning=ExperimentalWarning test/workspace/checks/i1-failure-modes.mjs
// Every outcome is set by a demo fixture control (POST /api/demo/fixtures/server), never by timing luck: waits are
// for a state to be drawn, with a bound. Fixtures stand in for the Shaffer services only; the routes, the paper ledger
// and the screens are the real ones.
export default async function i1FailureModes({ page, api, goto, check, alfa, brvo, restartServer }) {
  const mode = (dataset, m, extra = {}) => api('/api/demo/fixtures/server', { dataset, mode: m, ...extra });
  const reset = () => api('/api/demo/fixtures/server', { reset: true });
  const panel = (key) => page.locator(`[data-ws-dataset="${key}"]`).first();
  const settled = async (key, timeout = 15_000) => { await page.locator(`[data-ws-dataset=${key}]:not([data-ws-state=loading])`).first().waitFor({ timeout }); return panel(key); };
  const stateOf = async (key) => (await settled(key)).getAttribute('data-ws-state');
  const textOf = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
  const reopen = async (hash) => { await goto(hash); await page.reload(); await page.locator('.shell .topbar').waitFor(); };
  const refresh = async (key) => { await panel(key).locator('header button', { hasText: 'Refresh' }).click(); await page.waitForTimeout(150); return settled(key); };
  const waitState = (key, want, timeout = 15_000) => page.waitForFunction(([k, w]) => document.querySelector(`[data-ws-dataset=${k}]`)?.dataset.wsState === w, [key, want], { timeout }).then(() => true, () => false);
  const find = async (sym) => (await api(`/api/instruments?q=${encodeURIComponent(sym)}`)).items.find((i) => i.symbol === sym);
  const kaij = await find('KAIJ');
  const chrl = await find('CHRL');
  const SP3E = 'fixture-strat-sp3e';
  const chooseStrategy = async (id) => { const s = page.locator('.ws-strat select'); await s.waitFor(); await s.selectOption(id || ''); };
  await reset();
  await page.evaluate(() => { try { sessionStorage.removeItem('sdt.ws.statements'); } catch { /* fresh view choices */ } });

  // ---- 1. empty, partial, missing fields: every equity tab's own dataset -------------------------------------------
  const TABS = [['overview', 'profile'], ['history', 'history'], ['earnings', 'earnings'], ['statements', 'statements'], ['filings', 'filings'], ['actions', 'corporateActions'], ['news', 'news'], ['analytics', 'analytics']];
  await goto(`#/instrument/${alfa.id}/analytics`);
  await chooseStrategy(SP3E);
  for (const [tab, ds] of TABS) {
    await mode(ds, 'empty');
    await reopen(`#/instrument/${alfa.id}/${tab}`);
    const e = await stateOf(ds);
    const et = await textOf(panel(ds));
    await mode(ds, 'partial');
    await reopen(`#/instrument/${alfa.id}/${tab}`);
    const p = await stateOf(ds);
    const pt = await textOf(panel(ds));
    check(`empty / partial: ${tab} draws "unavailable" for an empty answer and "incomplete" naming what is missing for a partial one`,
      e === 'unavailable' && /No |no data|nothing is shown|returned no/i.test(et) && p === 'incomplete' && /Incomplete/.test(pt) && /missing/i.test(pt), `${e}: ${et.slice(0, 100)} | ${p}: ${pt.slice(0, 160)}`);
    await mode(ds, 'available');
  }
  // A missing value in the statements grid is drawn as missing (a dash with its reason), never as 0
  await mode('statements', 'partial');
  await reopen(`#/instrument/${alfa.id}/statements`);
  await settled('statements');
  const inc = await api(`/api/server/statements/${alfa.id}?statement=income&period=quarterly&periods=8`);
  const nulled = inc.data.lines.filter((l) => l.values[inc.data.periods[0].key] === null).map((l) => l.key);
  const cells = await Promise.all(nulled.map((k) => page.locator(`[data-ws-dataset=statements] [data-st-cell="${k}:${inc.data.periods[0].key}"]`).first().innerHTML().catch(() => '')));
  check('missing fields: values withheld by a partial answer are drawn as missing with their reason, never as 0', nulled.length === 3 && cells.every((h) => /class="missing"/.test(h) && !/>0(\.0+)?</.test(h)), `${nulled.join(',')}: ${cells.map((h) => h.slice(0, 80)).join(' | ')}`);
  await reset();

  // ---- 2. stale ------------------------------------------------------------------------------------------------------
  await mode('profile', 'stale');
  await reopen(`#/instrument/${alfa.id}/overview`);
  const staleText = await textOf(await settled('profile'));
  check('stale: the overview says Stale with the age, and still shows the last values marked as such', await stateOf('profile') === 'stale' && /Stale\./.test(staleText) && /old \(stale after/.test(staleText) && /Alfa Industries/.test(staleText), staleText.slice(0, 200));
  await reset();

  // ---- 3. revisions arriving after the first display ---------------------------------------------------------------
  // Statements: first display, then the server restates the latest quarter; Refresh draws it restated with the original beside it
  await reopen(`#/instrument/${alfa.id}/statements`);
  await waitState('statements', 'available');
  const p0 = inc.data.periods.find((p) => p.basis === 'reported' && p.periodType !== 'ttm');
  const before = await textOf(page.locator(`[data-ws-dataset=statements] [data-st-cell="revenue:${p0.key}"]`).first());
  await mode('statements', 'revised');
  await refresh('statements');
  await page.locator(`[data-ws-dataset=statements] th[data-st-col="${p0.key}:original"]`).waitFor({ timeout: 8000 }).catch(() => {});
  const restatedHead = await textOf(page.locator(`[data-ws-dataset=statements] th[data-st-col="${p0.key}"]`).first());
  const orig = await textOf(page.locator(`[data-ws-dataset=statements] [data-st-cell="revenue:${p0.key}:original"]`).first()).catch(() => '');
  const now = await textOf(page.locator(`[data-ws-dataset=statements] [data-st-cell="revenue:${p0.key}"]`).first());
  const num = (s) => Number(String(s).replace(/[^0-9.\-−]/g, '').replace('−', '-'));
  check('revision: a restatement arriving after the first display is drawn restated, the original kept beside it', /restated/.test(restatedHead) && num(orig) === num(before) && num(now) === Math.round(num(before) * 1.02 * 10) / 10, `${restatedHead.slice(0, 80)} | before ${before} original ${orig} now ${now}`);
  await reset();
  // Earnings: the estimated date is revised (a week later, confirmed) after the first display
  await reopen(`#/instrument/${alfa.id}/earnings`);
  await waitState('earnings', 'available');
  const up0 = await textOf(page.locator('[data-testid=earnings-upcoming] tbody tr').first());
  await mode('earnings', 'revised');
  await refresh('earnings');
  const up1 = await textOf(page.locator('[data-testid=earnings-upcoming] tbody tr').first());
  check('revision: a revised earnings date is drawn with its new date, confirmed, marked revised', /estimated/.test(up0) && /confirmed/.test(up1) && /revised/.test(up1) && up0 !== up1, `${up0.slice(0, 120)} -> ${up1.slice(0, 160)}`);
  await reset();
  // Corporate action: recorded, then revised by the server: the revision is drawn, the ledger record unchanged
  const book = (await api('/api/books')).items[0];
  const ca0 = await api(`/api/server/corporate-actions/${alfa.id}`);
  const dup = ca0.items.find((x) => x.deliveries === 2);
  const rec = await api('/api/server/corporate-actions/record', { instrumentId: alfa.id, eventId: dup.eventId });
  const ledgerBefore = JSON.stringify((await api(`/api/server/ledger/${alfa.id}?bookId=${book.id}`)).data.recordedCorporateActions);
  await mode('corporateActions', 'revised');
  await reopen(`#/instrument/${alfa.id}/actions`);
  await settled('corporateActions');
  const row = page.locator(`[data-testid=ca-processed] [data-ca-event="${dup.eventId}"]`);
  await row.waitFor({ timeout: 8000 }).catch(() => {});
  await row.locator('[data-testid=ca-revision]', { hasText: 'The ledger recorded' }).waitFor({ timeout: 8000 }).catch(() => {});
  const rowText = await textOf(row).catch(() => '');
  const again = await api('/api/server/corporate-actions/record', { instrumentId: alfa.id, eventId: dup.eventId });
  const ledgerAfter = JSON.stringify((await api(`/api/server/ledger/${alfa.id}?bookId=${book.id}`)).data.recordedCorporateActions);
  check('revision: a revised corporate action after recording says the server now states other terms; the ledger is not changed or posted again',
    (rec.recorded || rec.duplicate) && /Revised by the server/.test(rowText) && /The ledger recorded 0\.55 USD/.test(rowText) && /0\.6 USD|0\.60 USD/.test(rowText) && again.duplicate === true && ledgerAfter === ledgerBefore, rowText.slice(0, 400));
  await reset();

  // ---- 4. pagination ------------------------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/news`);
  await waitState('news', 'available');
  const firstIds = await page.locator('[data-news]').evaluateAll((n) => n.map((x) => x.dataset.news));
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction((id) => !document.querySelector(`[data-news="${id}"]`), firstIds[0], { timeout: 8000 }).catch(() => {});
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.locator('[data-testid=news-pager]', { hasText: 'Page 3 of 3' }).waitFor({ timeout: 8000 }).catch(() => {});
  const lastIds = await page.locator('[data-news]').evaluateAll((n) => n.map((x) => x.dataset.news));
  check('pagination: news pages 1 to 3 (10 + 10 + 5 of 25), no item on two pages, Next disabled on the last', firstIds.length === 10 && lastIds.length === 5 && !lastIds.some((x) => firstIds.includes(x))
    && await page.getByRole('button', { name: 'Next page' }).isDisabled(), `${firstIds.length} / ${lastIds.length}`);

  // ---- 5. server errors and throttling ----------------------------------------------------------------------------
  await mode('news', 'throttled');
  await reopen(`#/instrument/${alfa.id}/news`);
  const thr = await textOf(await settled('news', 20_000));
  check('throttling: a 429 is retried within the bound, then drawn as an error that offers Refresh (3 attempts)', await stateOf('news') === 'error' && /429/.test(thr) && /3 attempts/.test(thr) && /Choose Refresh/.test(thr), thr.slice(0, 200));
  await mode('news', 'error');
  await reopen(`#/instrument/${alfa.id}/news`);
  const err = await textOf(await settled('news', 20_000));
  check('server error: a 500 is retried, then drawn as an error with its attempts', await stateOf('news') === 'error' && /500/.test(err) && /3 attempts/.test(err), err.slice(0, 200));
  await reset();

  // ---- 6. disconnection and reconnection: every panel recovers without a reload ------------------------------------
  for (const tab of ['overview', 'statements', 'earnings']) {
    await goto(`#/instrument/${alfa.id}/${tab}`);
    await page.locator('.ws-page [data-ws-dataset]:not([data-ws-state=loading])').first().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => ![...document.querySelectorAll('.ws-page [data-ws-dataset]')].some((p) => p.dataset.wsState === 'loading'), null, { timeout: 15_000 }).catch(() => {});
    // Every server panel on the page (the local ledger panel is never remote)
    const sel = '.ws-page [data-ws-dataset]:not([data-ws-dataset=ledger])';
    const keys = await page.locator(sel).evaluateAll((ps) => ps.map((p) => p.dataset.wsDataset));
    const states0 = await page.locator(sel).evaluateAll((ps) => ps.map((p) => p.dataset.wsState));
    await page.evaluate(() => { window.__i1NoReload = 1; });
    await mode('all', 'offline');
    for (let i = 0; i < keys.length; i++) await page.locator(sel).nth(i).locator('header button', { hasText: 'Refresh' }).click();
    const allDown = await page.waitForFunction((q) => [...document.querySelectorAll(q)].every((p) => p.dataset.wsState === 'error'), sel, { timeout: 20_000 }).then(() => true, () => false);
    const downText = await textOf(page.locator(sel).first());
    await reset(); // the gateway is back
    const back = await page.waitForFunction(([q, s0]) => { const s = [...document.querySelectorAll(q)].map((p) => p.dataset.wsState); return s.length === s0.length && s.every((x, i) => x === s0[i]); }, [sel, states0], { timeout: 20_000 }).then(() => true, () => false);
    const noReload = await page.evaluate(() => window.__i1NoReload === 1);
    const statesNow = await page.locator(sel).evaluateAll((ps) => ps.map((p) => `${p.dataset.wsDataset}:${p.dataset.wsState}`).join(' '));
    check(`disconnection: on ${tab}, every panel (${keys.join(', ')}) shows the gateway error, then recovers on its own after reconnection, without a reload`,
      keys.length >= 1 && allDown && /cannot be reached/.test(downText) && back && noReload, `down ${allDown}, back ${back}, reload ${!noReload}: ${statesNow} (was ${states0.join(' ')})`);
  }
  // The drawer: its server-fed part is the header's fair price and Gap % for the chosen Strategy (the analytics dataset)
  await goto(`#/instrument/${alfa.id}/overview`);
  await chooseStrategy(SP3E);
  await mode('all', 'offline');
  await goto('#/markets/US_CASH/equities');
  await page.getByPlaceholder(/Filter by symbol/).fill('ALFA');
  await page.locator('main table tbody tr').filter({ has: page.locator('.sym', { hasText: /^ALFA$/ }) }).first().click();
  const drawer = page.getByRole('dialog').filter({ has: page.locator('[data-testid=ws-header]') }).last();
  await drawer.waitFor();
  await page.evaluate(() => { window.__i1NoReload = 2; });
  const fairQ = drawer.locator('[data-testid=ws-header] .ws-q', { hasText: 'Fair price' });
  const dDown = await page.waitForFunction(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const q = [...d.querySelectorAll('.ws-q')].find((x) => /Fair price/.test(x.innerText)); return q && /Analytics could not be loaded/.test(q.querySelector('.missing')?.title || ''); }, null, { timeout: 20_000 }).then(() => true, () => false);
  await reset();
  const dBack = await page.waitForFunction(() => { const d = [...document.querySelectorAll('[role=dialog]')].pop(); const q = [...d.querySelectorAll('.ws-q')].find((x) => /Fair price/.test(x.innerText)); return q && /\d/.test(q.querySelector('.v')?.innerText || ''); }, null, { timeout: 20_000 }).then(() => true, () => false);
  check('disconnection: the drawer header\'s fair price says analytics could not be loaded while the gateway is down, and comes back on its own', dDown && dBack && await page.evaluate(() => window.__i1NoReload === 2), `down ${dDown} back ${dBack}: ${await textOf(fairQ).catch(() => '')}`);
  for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');

  // ---- 7. rapid instrument switching: ten switches in a second with slowed fixtures --------------------------------
  const order = [alfa, brvo, kaij, chrl, alfa, kaij, brvo, chrl, brvo, alfa]; // ends on ALFA (quarterly statements, a chart)
  const last = order[order.length - 1];
  const names = { [alfa.id]: /Alfa Industries/, [brvo.id]: /Bravo Biotech/, [kaij.id]: /Kaiju Motors/, [chrl.id]: /Charlie Holdings/ };
  const others = order.filter((i) => i.id !== last.id).map((i) => names[i.id]);
  const mixedOn = (scope, want) => page.evaluate(([sc, w]) => {
    const out = [];
    const roots = sc === 'page' ? [document.querySelector('.ws-page')] : [...document.querySelectorAll('[role=dialog]')].filter((d) => d.querySelector('[data-testid=ws-header]'));
    for (const r of roots.filter(Boolean)) {
      const h = r.querySelector('[data-testid=ws-header]');
      const hid = h?.dataset.wsInst;
      if (sc === 'page' && hid !== w) out.push(`header ${hid}`);
      for (const p of r.querySelectorAll('[data-ws-dataset]')) if (p.dataset.wsInst !== hid) out.push(`${p.dataset.wsDataset} ${p.dataset.wsInst} under ${hid}`);
      for (const x of r.querySelectorAll('[data-ws-inst]')) if (x.dataset.wsInst !== hid) out.push(`element ${x.className || x.tagName} ${x.dataset.wsInst} under ${hid}`);
    }
    return out;
  }, [scope, want]);
  for (const ds of ['history', 'statements', 'profile', 'reference', 'analytics', 'corporateActions']) await mode(ds, 'slow', { delayMs: 1500 });
  for (const tab of ['history', 'statements']) {
    await goto(`#/instrument/${order[0].id}/${tab}`);
    await page.locator('.ws-page').waitFor();
    // Ten switches, 100 ms apart, by the address (as the page search and Back do)
    await page.evaluate(async ([ids, t]) => { for (const id of ids) { location.hash = `#/instrument/${id}/${t}`; await new Promise((r) => setTimeout(r, 100)); } }, [order.map((i) => i.id), tab]);
    let mixed = [];
    let foreignText = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      mixed = mixed.concat(await mixedOn('page', last.id));
      const txt = await page.locator('.ws-page').innerText();
      foreignText = foreignText.concat(others.filter((re) => re.test(txt)).map(String));
    }
    await settled(tab === 'history' ? 'history' : 'statements', 15_000);
    const okFinal = tab === 'history'
      ? await page.locator('[data-ws-dataset=history] [data-testid=history-chart]').count() === 1 && /of ALFA/.test(await page.locator('[data-ws-dataset=history] [data-testid=history-chart]').getAttribute('aria-label'))
      : num(await page.locator(`[data-ws-dataset=statements] [data-st-cell="revenue:${inc.data.periods[0].key}"]`).first().innerText()) === inc.data.lines.find((l) => l.key === 'revenue').values[inc.data.periods[0].key];
    check(`rapid switching (page, ${tab === 'history' ? 'chart' : 'statements grid'}): ten switches in a second, nothing of another instrument under the header, the last one drawn`, mixed.length === 0 && foreignText.length === 0 && okFinal, `${mixed.slice(0, 4).join('; ')} ${[...new Set(foreignText)].join(',')} final ${okFinal}`);
  }
  // The drawer: ten switches (close, open the next) 100 ms apart
  await goto('#/markets/US_CASH/equities');
  await page.locator('main table tbody tr').first().waitFor();
  await page.evaluate(async (ids) => {
    const m = await import('/views/instrument.js');
    for (const id of ids) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); m.openInstrument(id, { tab: 'overview' }); await new Promise((r) => setTimeout(r, 100)); }
  }, order.map((i) => i.id));
  let dMixed = [];
  let dForeign = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    dMixed = dMixed.concat(await mixedOn('drawer', last.id));
    const top = page.getByRole('dialog').filter({ has: page.locator('[data-testid=ws-header]') }).last();
    const hid = await top.locator('[data-testid=ws-header]').getAttribute('data-ws-inst').catch(() => null);
    const txt = await top.innerText().catch(() => '');
    if (hid) dForeign = dForeign.concat(Object.entries(names).filter(([id, re]) => id !== hid && re.test(txt)).map(([id]) => `${id} under ${hid}`));
  }
  const topHead = await page.getByRole('dialog').filter({ has: page.locator('[data-testid=ws-header]') }).last().locator('[data-testid=ws-header]').getAttribute('data-ws-inst');
  check('rapid switching (drawer): ten switches in a second, every drawer shows only its own instrument, the last one on top', dMixed.length === 0 && dForeign.length === 0 && topHead === last.id, `${dMixed.slice(0, 4).join('; ')} ${dForeign.slice(0, 3).join('; ')} top ${topHead}`);
  for (let i = 0; i < 12 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
  await reset();

  // ---- 8. duplicate deliveries -------------------------------------------------------------------------------------
  await mode('news', 'duplicate');
  await reopen(`#/instrument/${alfa.id}/news`);
  await waitState('news', 'available');
  const nIds = await page.locator('[data-news]').evaluateAll((n) => n.map((x) => x.dataset.news));
  check('duplicates: the same news item delivered twice is listed once', nIds.length === 10 && new Set(nIds).size === 10, nIds.join(','));
  await mode('analyticsRuns', 'duplicate');
  await reopen(`#/instrument/${alfa.id}/analytics`);
  await chooseStrategy(SP3E);
  await waitState('analyticsRuns', 'available');
  const runRows = await page.locator('[data-testid=an-runs] tr[data-run]').evaluateAll((r) => r.map((x) => x.dataset.run));
  // The same analytics record delivered again (Refresh): the header's fair price and gap do not change or double
  const head1 = await textOf(page.locator('[data-testid=ws-header] .ws-quote'));
  await refresh('analytics');
  const head2 = await textOf(page.locator('[data-testid=ws-header] .ws-quote'));
  const fair = (s) => (s.match(/Fair price (.*?) fundamental/) || [])[1];
  check('duplicates: the same analytics run delivered twice is listed once; delivered again it changes nothing in the header', runRows.length === 2 && new Set(runRows).size === 2 && fair(head1) && fair(head1) === fair(head2), `${runRows.join(',')} | ${fair(head1)} | ${fair(head2)}`);
  await mode('corporateActions', 'duplicate');
  await reopen(`#/instrument/${alfa.id}/actions`);
  await settled('corporateActions');
  const evIds = await page.locator('[data-ca-event]').evaluateAll((r) => r.map((x) => x.dataset.caEvent));
  check('duplicates: corporate actions delivered twice are listed once each, saying so', evIds.length === new Set(evIds).size && await page.locator('[data-testid=ca-deliveries]').count() === 2, evIds.join(','));
  await reset();

  // ---- 9. unit and currency mismatches -----------------------------------------------------------------------------
  const gapReason = async () => page.locator('[data-testid=ws-header] .ws-q', { hasText: 'Gap %' }).locator('.missing').first().getAttribute('title').catch(() => null);
  await goto(`#/instrument/${alfa.id}/overview`);
  await chooseStrategy(SP3E);
  await page.waitForFunction(() => /\d%/.test(document.querySelector('[data-testid=ws-header] .ws-quote')?.innerText.split('Gap %')[1] || ''), null, { timeout: 10_000 }).catch(() => {});
  const gapShown = /\d%/.test((await page.locator('[data-testid=ws-header] .ws-quote').innerText()).split('Gap %')[1] || '');
  await mode('analytics', 'currency-mismatch');
  await reopen(`#/instrument/${alfa.id}/overview`);
  await page.locator('[data-testid=ws-header] .ws-q', { hasText: 'Gap %' }).locator('.missing').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const whyCcy = await gapReason();
  const fairCcy = await textOf(page.locator('[data-testid=ws-header] .ws-q', { hasText: 'Fair price' }));
  await mode('analytics', 'unit-mismatch');
  await reopen(`#/instrument/${alfa.id}/overview`);
  await page.locator('[data-testid=ws-header] .ws-q', { hasText: 'Gap %' }).locator('.missing').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const whyUnits = await gapReason();
  check('mismatch: Gap % shown when the fair price matches the quote; withheld with the reason for a EUR fair price or one per 100 shares',
    gapShown && /withheld: the fair price is in EUR and the market price in USD/.test(whyCcy || '') && /EUR/.test(fairCcy) && /withheld: the fair price is quoted per 100 shares/.test(whyUnits || ''), `${gapShown} | ${whyCcy} | ${whyUnits}`);
  await mode('statements', 'unit-mismatch');
  await reopen(`#/instrument/${alfa.id}/statements`);
  await page.getByRole('button', { name: 'Annual', exact: true }).click();
  const ttmBox = page.getByText('Supplied TTM');
  if (!(await page.locator('[data-ws-dataset=statementsTtm]').count())) await ttmBox.click();
  await page.locator('[data-ws-dataset=statementsTtm]:not([data-ws-state=loading])').waitFor({ timeout: 10_000 }).catch(() => {});
  const ttmText = await textOf(page.locator('[data-ws-dataset=statementsTtm]')).catch(() => '');
  const annualFacts = await textOf(page.locator('[data-ws-dataset=statements] .st-facts').first()).catch(() => '');
  check('mismatch: a TTM statement in thousands beside annual figures in millions is labelled and said not comparable', /different scales, shown as supplied and not compared/.test(ttmText) && /thousands/.test(ttmText) && /millions/.test(annualFacts), `${ttmText.slice(0, 240)} | ${annualFacts}`);
  await reset();

  // ---- 10. persistence: reload and server restart ------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/statements`);
  await chooseStrategy(SP3E);
  await waitState('statements', 'available');
  await page.getByRole('button', { name: 'Quarterly', exact: true }).click();
  await page.getByRole('button', { name: 'Cash flow statement', exact: true }).click();
  await page.locator('.st-count select').selectOption('4');
  await page.locator('#ws-research-date').fill('2025-12-31');
  await page.waitForFunction(() => location.hash.endsWith('/asof/2025-12-31'));
  const want = `#/instrument/${alfa.id}/statements/asof/2025-12-31`;
  const kept = async () => ({
    hash: await page.evaluate(() => location.hash), strat: await page.locator('.ws-strat select').inputValue().catch(() => null),
    stmt: await page.getByRole('button', { name: 'Cash flow statement', exact: true }).getAttribute('aria-pressed').catch(() => null) ?? await page.getByRole('button', { name: 'Cash flow statement', exact: true }).getAttribute('class').catch(() => null),
    count: await page.locator('.st-count select').inputValue().catch(() => null), date: await page.locator('#ws-research-date').inputValue().catch(() => null),
  });
  const pressed = (v) => v === 'true' || /\b(on|active|sel|selected)\b/.test(String(v));
  await page.reload();
  await page.locator('.shell .topbar').waitFor();
  await settled('statements');
  const k1 = await kept();
  check('persistence: after a reload the tab, research date, Strategy, statement view and period count are kept', k1.hash === want && k1.strat === SP3E && pressed(k1.stmt) && k1.count === '4' && k1.date === '2025-12-31', JSON.stringify(k1));
  if (restartServer) {
    await mode('filings', 'stale'); // a fixture control is a setting: kept across the restart
    await restartServer();
    await page.reload();
    await page.locator('.shell .topbar').waitFor();
    await settled('statements');
    const k2 = await kept();
    const fx = await api('/api/demo/fixtures/server');
    const st = await api('/api/server/state');
    check('persistence: after a server restart the same view is kept (browser tab and address), fixture controls kept, no server response cache or auth block kept',
      k2.hash === want && k2.strat === SP3E && pressed(k2.stmt) && k2.count === '4' && fx.modes.filings.mode === 'stale' && Object.values(st.datasets).every((d) => !d.authBlocked), JSON.stringify(k2));
  } else check('persistence: server restart (needs the runner\'s restartServer)', true, 'skipped: no restart available');
  await reset();
  await page.evaluate(() => { try { sessionStorage.removeItem('sdt.ws.statements'); sessionStorage.removeItem('sdt.ws.strategy'); } catch { /* clean for the next checks */ } });
}

// Standalone run: its own sandboxed demo server and browser.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { createSandbox } = await import('../../matrix/lib/sandbox.mjs');
  const { startServer } = await import('../../matrix/lib/server.mjs');
  const { launchBrowser } = await import('../../matrix/drivers/browser.mjs');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); };
  const sandbox = createSandbox('i1-failure-modes');
  let server = await startServer(sandbox, { demo: true, engine: 'on' });
  const restartServer = async () => { await server.stop(); server = await startServer(sandbox, { demo: true, engine: 'on', port: server.port }); return server; };
  const browser = await launchBrowser({ headed: Boolean(process.env.SDT_HEADED) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const api = (path, body) => page.evaluate(async ([u, b]) => { const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); }, [`${server.url}${path}`, body]);
  const goto = async (hash) => { await page.goto(`${server.url}/${hash}`); await page.locator('.shell .topbar').waitFor(); };
  try {
    await goto('#/accounting');
    const find = async (sym) => (await api(`/api/instruments?q=${encodeURIComponent(sym)}`)).items.find((i) => i.symbol === sym);
    await i1FailureModes({ page, api, goto, check, alfa: await find('ALFA'), brvo: await find('BRVO'), restartServer });
    check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (err) {
    check('the run completed', false, err.stack || String(err));
  } finally {
    await browser.close();
    await server.stop();
    sandbox.remove?.();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}
