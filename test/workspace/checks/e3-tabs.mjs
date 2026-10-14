// Browser checks of the Corporate actions, News and events, Analytics and risk and My positions and trades tabs (e3),
// run by test/workspace/run-browser.mjs on its demo server and page. Fixtures stand in for the Shaffer services only
// (docs/SERVER-CLIENT.md section 4); the routes, the paper ledger and its idempotent recording are the real ones.
// Expected values are read from the server's own answers, never copied from the screen.
export default async function e3Tabs({ page, api, goto, check, alfa, brvo }) {
  const mode = (dataset, m, extra = {}) => api('/api/demo/fixtures/server', { dataset, mode: m, ...extra });
  const reset = () => api('/api/demo/fixtures/server', { reset: true });
  const panel = (key) => page.locator(`[data-ws-dataset=${key}]`).first();
  const settled = async (key, timeout = 15_000) => { await page.locator(`[data-ws-dataset=${key}]:not([data-ws-state=loading])`).first().waitFor({ timeout }); return panel(key); };
  const stateOf = async (key) => (await settled(key)).getAttribute('data-ws-state');
  const textOf = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
  // A fixture mode applies to the next request: the page is loaded afresh (the same address would not reload it).
  const reopen = async (hash) => { await goto(hash); await page.reload(); await page.locator('.shell .topbar').waitFor(); };
  const find = async (sym) => (await api(`/api/instruments?q=${encodeURIComponent(sym)}`)).items.find((i) => i.symbol === sym);
  const kaij = await find('KAIJ');
  const book = (await api('/api/books')).items[0];
  // The investment Strategy is chosen in the header, as a user does (it is kept for the browser tab).
  const chooseStrategy = async (id) => { const s = page.locator('.ws-strat select'); await s.waitFor(); await s.selectOption(id || ''); };
  await reset();

  // ---- Corporate actions: the duplicate delivery recorded once through the interface ----------------------------------
  const listed = await api(`/api/server/corporate-actions/${alfa.id}`);
  const dup = listed.items.find((x) => x.deliveries === 2);
  const ledgerCount = async () => (await api(`/api/server/ledger/${alfa.id}?bookId=${book.id}`)).data.recordedCorporateActions.filter((x) => x.type === dup.type && x.ex_date === dup.exDate).length;
  const dividendEvents = async () => (await api(`/api/books/${book.id}/accounting/history?type=dividend&limit=500`)).events.length;
  const before = { count: await ledgerCount(), dividends: await dividendEvents() };
  await goto(`#/instrument/${alfa.id}/actions`);
  check('actions: available, events split into "in the paper ledger" and "informational"', await stateOf('corporateActions') === 'available'
    && await page.locator('[data-testid=ca-processed]').count() === 1 && await page.locator('[data-testid=ca-informational]').count() === 1);
  const dupRows = page.locator(`[data-ca-event="${dup.eventId}"]`);
  check('actions: the event delivered twice is listed once, saying it was delivered twice', await dupRows.count() === 1 && /Delivered 2 times/.test(await textOf(dupRows)));
  check('actions: before recording it is informational, with a Record action', before.count === 0 && await page.locator(`[data-testid=ca-informational] [data-ca-event="${dup.eventId}"] button`, { hasText: 'Record in the paper ledger' }).count() === 1);
  const buyback = listed.items.find((x) => x.type === 'buyback');
  check('actions: a buyback is informational only, with no Record action', await page.locator(`[data-ca-event="${buyback.eventId}"] button`).count() === 0
    && /informational/.test(await textOf(page.locator(`[data-ca-event="${buyback.eventId}"]`))));
  await page.locator(`[data-ca-event="${dup.eventId}"] button`, { hasText: 'Record in the paper ledger' }).click();
  const modal = page.locator('.modal').last();
  await modal.waitFor();
  check('actions: recording asks for confirmation and names the idempotency key', /recorded once/.test(await textOf(modal)) && (await textOf(modal)).includes(dup.idempotencyKey));
  const rec = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/server/corporate-actions/record');
  await modal.getByRole('button', { name: 'Record in the paper ledger' }).click();
  const recBody = await (await rec).json();
  check('actions: the record goes through the idempotent route and posts', recBody.recorded === true && recBody.duplicate === false, JSON.stringify(recBody));
  await page.locator(`[data-testid=ca-processed] [data-ca-event="${dup.eventId}"]`).waitFor({ timeout: 10_000 });
  const procRow = await textOf(page.locator(`[data-testid=ca-processed] [data-ca-event="${dup.eventId}"]`));
  check('actions: once recorded it moves to "in the paper ledger" with "recorded in the ledger on <date>"', /Recorded in the ledger on \w{3} \d{2}, \d{4}/.test(procRow) && /Matched by the server event ID/.test(procRow), procRow.slice(0, 200));
  // The same event received again: both deliveries recorded once more through the route, and a fresh delivery from the server.
  const again1 = await api('/api/server/corporate-actions/record', { instrumentId: alfa.id, eventId: dup.eventId });
  const again2 = await api('/api/server/corporate-actions/record', { instrumentId: alfa.id, eventId: dup.eventId });
  await page.locator('[data-ws-dataset=corporateActions] header button', { hasText: 'Refresh' }).click();
  await page.waitForTimeout(800);
  await settled('corporateActions');
  check('actions: receiving and recording the same event again posts nothing (duplicate answers, one ledger record)', again1.duplicate === true && again2.duplicate === true && again2.caId === recBody.caId && await ledgerCount() === 1, JSON.stringify([again1, again2]));
  check('actions: after a fresh delivery the event is still listed once, as processed', await page.locator(`[data-ca-event="${dup.eventId}"]`).count() === 1 && await page.locator(`[data-testid=ca-processed] [data-ca-event="${dup.eventId}"]`).count() === 1);
  check('actions: no dividend was posted twice', await dividendEvents() - before.dividends <= 1);
  const integ = await api(`/api/books/${book.id}/integrity`);
  check('actions: the integrity route is clean after recording', integ.ok === true, JSON.stringify(integ.checks?.filter((c) => !c.ok)).slice(0, 300));
  // States.
  for (const [m, want, re] of [['error', 'error', /could not be loaded/], ['forbidden', 'error', /refused access/], ['stale', 'stale', /Stale/], ['empty', 'unavailable', /No corporate actions/], ['partial', 'incomplete', /Incomplete/]]) {
    await mode('corporateActions', m);
    await reopen(`#/instrument/${alfa.id}/actions`);
    const st = await stateOf('corporateActions');
    check(`actions: ${m} fixture renders the ${want} state usefully`, st === want && re.test(await textOf(panel('corporateActions'))), `${st}: ${(await textOf(panel('corporateActions'))).slice(0, 160)}`);
  }
  await mode('corporateActions', 'slow', { delayMs: 2000 });
  await reopen(`#/instrument/${alfa.id}/actions`);
  await page.locator('[data-ws-dataset=corporateActions][data-ws-state=loading]').waitFor({ timeout: 2000 }).catch(() => {});
  const sawLoading = await page.locator('[data-ws-dataset=corporateActions][data-ws-state=loading]').count() === 1;
  check('actions: slow fixture shows loading, then the events', sawLoading && await stateOf('corporateActions') === 'available');
  await reset();
  await goto(`#/instrument/${kaij.id}/actions`);
  check('actions: KAIJ server error (built in) is drawn as an error after retries', await stateOf('corporateActions') === 'error');
  await goto(`#/instrument/${alfa.id}/actions/asof/2026-01-15`);
  const asofText = await textOf(await settled('corporateActions'));
  check('actions: as of a research date the contract\'s answer is shown, and nothing can be recorded', /not supported by the server contract|As of 2026-01-15/.test(asofText) && await page.locator('[data-ws-dataset=corporateActions] button', { hasText: 'Record in the paper ledger' }).count() === 0, asofText.slice(0, 160));

  // ---- News and events ----------------------------------------------------------------------------------------------
  const news1 = await api(`/api/server/news/${alfa.id}?page=1&pageSize=10`);
  await goto(`#/instrument/${alfa.id}/news`);
  check('news: available, the first page of the server\'s pages', await stateOf('news') === 'available' && await page.locator('[data-news]').count() === news1.items.length
    && /Page 1 of 3/.test(await textOf(page.locator('[data-testid=news-pager]'))));
  const first = news1.items[0];
  const firstText = await textOf(page.locator(`[data-news="${first.id}"]`));
  const pubTitle = await page.locator(`[data-news="${first.id}"] [data-testid=news-published]`).getAttribute('title');
  check('news: source and publication time are kept as supplied', firstText.includes(`Source: ${first.source}`) && pubTitle.includes(first.publishedAt), pubTitle);
  const withInterp = news1.items.find((n) => n.interpretation), econ = news1.items.find((n) => n.facts?.length);
  check('news: facts, classification and interpretation are drawn as separate parts', await page.locator(`[data-news="${econ.id}"] [data-part=facts]`).innerText().then((t) => t.includes(econ.facts[0].label))
    && /classified by/.test(await page.locator(`[data-news="${first.id}"] [data-part=classification]`).innerText())
    && await page.locator(`[data-news="${withInterp.id}"] [data-part=interpretation]`).count() === 1
    && await page.locator('[data-part=interpretation]').count() === news1.items.filter((n) => n.interpretation).length);
  await page.getByRole('button', { name: 'Next page' }).click();
  const news2 = await api(`/api/server/news/${alfa.id}?page=2&pageSize=10`);
  await page.locator(`[data-news="${news2.items[0].id}"]`).waitFor({ timeout: 8000 });
  check('news: Next page asks the server for page 2', /Page 2 of 3/.test(await textOf(page.locator('[data-testid=news-pager]'))) && await page.locator(`[data-news="${first.id}"]`).count() === 0);
  await page.locator('[data-testid=news-kind] button', { hasText: 'Economic' }).click();
  const scopes = await page.locator('[data-news]').evaluateAll((els) => els.map((e) => e.dataset.scope));
  check('news: the kind filter shows economic items only', scopes.length > 0 && scopes.every((s) => s === 'economy'), scopes.join(','));
  await goto(`#/instrument/${brvo.id}/news`);
  await page.locator('[data-ws-dataset=news][data-ws-state=loading]').waitFor({ timeout: 1500 }).catch(() => {});
  check('news: BRVO (slow, built in) shows loading, then its items', await page.locator('[data-ws-dataset=news][data-ws-state=loading]').count() === 1 && await stateOf('news') === 'available');
  await goto(`#/instrument/${kaij.id}/news`);
  check('news: KAIJ (empty, built in) says there is no news', await stateOf('news') === 'unavailable' && /No news and events/.test(await textOf(panel('news'))));
  for (const [m, want] of [['stale', 'stale'], ['error', 'error'], ['forbidden', 'error'], ['partial', 'incomplete']]) {
    await mode('news', m);
    await reopen(`#/instrument/${alfa.id}/news`);
    check(`news: ${m} fixture renders the ${want} state`, await stateOf('news') === want);
  }
  await reset();
  await goto(`#/instrument/${alfa.id}/news/asof/2026-10-10`);
  check('news: as of a research date the panel says what point in time it shows', /As of 2026-10-10, as it was known then/.test(await textOf(await settled('news'))));

  // ---- Analytics and risk ---------------------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/analytics`);
  const strategyBefore = await page.locator('.ws-strat select').inputValue();
  await chooseStrategy('DEMO-IS-001');
  await page.locator('[data-ws-dataset=analytics][data-ws-state=unavailable]').waitFor({ timeout: 10_000 }).catch(() => {});
  check('analytics: a Strategy with no outputs says so', await stateOf('analytics') === 'unavailable' && /No analytics|no outputs/i.test(await textOf(panel('analytics'))), (await textOf(panel('analytics'))).slice(0, 160));
  await chooseStrategy('');
  await page.locator('[data-testid=an-tab]').waitFor();
  check('analytics: with no Strategy chosen it asks for one and asks the server nothing', /Choose an investment Strategy/.test(await textOf(page.locator('[data-testid=an-tab]'))) && await page.locator('[data-ws-dataset=analytics]').count() === 0);
  await chooseStrategy('fixture-strat-sp3e');
  const cur = await api(`/api/server/analytics/${alfa.id}?strategyId=fixture-strat-sp3e`);
  const runsApi = await api(`/api/server/analytics/${alfa.id}/runs?strategyId=fixture-strat-sp3e`);
  const hist = runsApi.items.find((r) => r.historical);
  await page.locator(`[data-ws-dataset=analytics] [data-run="${cur.data.runId}"]`).waitFor({ timeout: 10_000 }).catch(() => {});
  check('analytics: SP3E outputs of the current run, with run, version, calculation time, cutoff and horizon', await stateOf('analytics') === 'available'
    && await page.locator(`[data-ws-dataset=analytics] [data-run="${cur.data.runId}"][data-historical="0"]`).count() === 1
    && await (async () => { const t = await textOf(panel('analytics')); return ['Run and version', 'Calculated', 'Input data cutoff', 'Horizon', 'Availability'].every((k) => t.includes(k)); })() && (await textOf(panel('analytics'))).includes(cur.data.version));
  const grid = await textOf(page.locator('[data-testid=an-grid]'));
  check('analytics: EFS, scores, both fair values and gaps with the reference price, uncertainty, timing, flags, sizing and hedge',
    ['EFS', 'Sector Score', 'Equity Score', 'Fundamental Fair Value', 'Realistic Fair Value', 'Fundamental Gap %', 'Realistic Gap %', 'Uncertainty', 'Timing eligibility', 'Outlier flags', 'Sizing', 'Hedge'].every((k) => grid.includes(k))
    && grid.includes(cur.data.gapReference.price.toFixed(2)) && grid.includes(`+${cur.data.fundamentalGapPct.toFixed(2)}%`), grid.slice(0, 300));
  const runRows = page.locator('[data-testid=an-runs] tbody tr');
  check('analytics: the run list marks the historical run as historical', await runRows.count() === runsApi.items.length
    && /historical/.test(await textOf(page.locator(`[data-testid=an-runs] tr[data-run="${hist.runId}"]`))) && await page.locator('[data-testid=an-runs] tr[data-historical="1"]').count() === runsApi.items.filter((r) => r.historical).length);
  await page.locator(`[data-testid=an-runs] tr[data-run="${hist.runId}"] button`).click();
  await page.locator(`[data-ws-dataset=analytics] [data-run="${hist.runId}"]`).waitFor({ timeout: 8000 });
  const histText = await textOf(page.locator('[data-testid=an-historical]'));
  check('analytics: a historical run is shown as historical, never as a current recommendation', /not a current recommendation/.test(histText) && histText.includes(cur.data.runId), histText);
  check('analytics: the header keeps the current run while a historical one is shown below', (await textOf(page.locator('[data-testid=ws-header]'))).includes(cur.data.runId) && !(await textOf(page.locator('[data-testid=ws-header]'))).includes(hist.runId));
  await goto(`#/instrument/${brvo.id}/analytics`);
  const brvoText = await textOf(await settled('analytics'));
  check('analytics: BRVO partial record is incomplete and its missing values stay missing', await stateOf('analytics') === 'incomplete' && /equityScore/.test(brvoText)
    && await page.locator('[data-an=equityScore] .missing').count() === 1);
  for (const [m, want] of [['stale', 'stale'], ['error', 'error'], ['forbidden', 'error'], ['empty', 'unavailable']]) {
    await mode('analytics', m);
    await reopen(`#/instrument/${alfa.id}/analytics`);
    check(`analytics: ${m} fixture renders the ${want} state`, await stateOf('analytics') === want);
  }
  await reset();
  await goto(`#/instrument/${alfa.id}/analytics/asof/2026-08-01`);
  await settled('analytics');
  check('analytics: as of a research date the run available then is shown as historical', await page.locator(`[data-ws-dataset=analytics] [data-run="${hist.runId}"][data-historical="1"]`).count() === 1 && await page.locator('[data-testid=an-historical]').count() === 1);

  // ---- My positions and trades -----------------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/positions`);
  await settled('ledger');
  const led = await api(`/api/server/ledger/${alfa.id}?bookId=${book.id}`);
  const tabText = await textOf(page.locator('[data-testid=pos-tab]'));
  check('positions: labelled as local paper records, apart from server market history', /Local paper records of/.test(tabText) && /apart from the server's market history/.test(tabText));
  const acc = await api(`/api/books/${book.id}/accounting/positions?scope=book`);
  const accRows = acc.positions.filter((p) => p.instrument.id === alfa.id);
  const shownPos = await page.locator('[data-testid=pos-positions] tr[data-position]').evaluateAll((trs) => trs.map((t) => t.dataset.position).sort());
  check('positions: the same positions as the Accounting positions route', shownPos.join() === accRows.map((p) => p.positionId).sort().join() && shownPos.length > 0, `${shownPos} vs ${accRows.map((p) => p.positionId)}`);
  const byOwner = await page.locator('[data-testid=pos-holdings] tr[data-unit]').evaluateAll((trs) => trs.map((t) => [...t.querySelectorAll('td')].slice(0, 4).map((x) => x.innerText.trim())));
  await goto('#/accounting/positions');
  const accScreenRow = page.locator('main table tbody tr').filter({ has: page.locator('.sym', { hasText: /^ALFA$/ }) }).first();
  await accScreenRow.waitFor({ timeout: 10_000 });
  const accScreen = await textOf(accScreenRow);
  check('positions: the holdings by Account match the Accounting screen', byOwner.length === led.data.holdings.length && byOwner.every(([, l, s]) => (!l || accScreen.includes(`Long ${l}`)) && (!s || accScreen.includes(`Short ${s}`))), `${JSON.stringify(byOwner)} | ${accScreen.slice(0, 200)}`);
  await goto(`#/instrument/${alfa.id}/positions`);
  await settled('ledger');
  check('positions: fills and accounting history come from the ledger interface', await page.locator('[data-testid=pos-fills] tbody tr').count() >= Math.min(led.data.fills.length, 1) && await page.locator('[data-testid=pos-history] tr[data-event]').count() === led.data.history.length);
  const sLink = page.locator('[data-testid=pos-packages] tr[data-strategy] a').first();
  await sLink.click();
  await page.getByRole('dialog').first().waitFor({ timeout: 8000 });
  check('positions: a package opens the strategy drawer', await page.getByRole('dialog').count() > 0);
  for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
  const hLink = page.locator('[data-testid=pos-packages] a', { hasText: /^Hedge request/ }).first();
  if (await hLink.count()) {
    await hLink.click();
    await page.locator('.modal header h2', { hasText: /^Hedge for/ }).waitFor({ timeout: 10_000 }).catch(() => {});
    check('positions: a hedge request opens the hedge popup', await page.locator('.modal header h2', { hasText: /^Hedge for/ }).count() > 0);
    for (let i = 0; i < 4 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape');
  } else check('positions: a hedge request opens the hedge popup', false, 'no hedge request listed for the packages');
  const accLink = page.locator('[data-testid=pos-holdings] a', { hasText: 'Open in Accounting' }).first();
  await accLink.click();
  await page.waitForFunction(() => location.hash.startsWith('#/accounting/positions/'));
  check('positions: Open in Accounting goes to that Account\'s positions', true);
  await goto(`#/instrument/${alfa.id}/analytics`);
  await chooseStrategy(strategyBefore);
}
