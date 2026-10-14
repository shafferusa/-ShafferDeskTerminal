// Browser checks of the equity tabs Overview, Price history and Earnings (web/views/tabs/), run by ../run-browser.mjs
// (npm run test:workspace) on its page and server, or alone: node test/workspace/checks/e1-tabs.mjs
//
// Per tab: the available, partial, stale, error and as-of states (fixture controls, docs/SERVER-CLIENT.md section 4),
// plus for Price history the adjusted / unadjusted switch (offered only when both series exist; the adjusted series is
// stood in by a labelled test fixture at the browser, since the demo feed supplies none), gaps, short coverage, an
// unavailable interval and the table view; for Earnings the document proxy links and the separate eligibility panel.

/** ctx: { page, api(path, body?), goto(hash), check(name, ok, detail) } on a demo server. */
export default async function e1Tabs({ page, api, goto: go, check }) {
  // A fresh document for every visit: the same address twice would otherwise keep the tab's state and earlier answers.
  const goto = async (hash) => { await page.goto('about:blank'); await go(hash); };
  const waitState = (key, want) => page.locator(`[data-ws-dataset="${key}"][data-ws-state="${want}"]`).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const find = async (sym) => (await api(`/api/instruments?q=${encodeURIComponent(sym)}`)).items.find((i) => i.symbol === sym);
  const alfa = await find('ALFA'), brvo = await find('BRVO'), kaij = await find('KAIJ');
  const mode = (dataset, m) => api('/api/demo/fixtures/server', { dataset, mode: m });
  const reset = () => api('/api/demo/fixtures/server', { reset: true });
  const settled = async (key) => { const l = page.locator(`[data-ws-dataset="${key}"]:not([data-ws-state=loading])`).first(); await l.waitFor({ timeout: 15_000 }); return l; };
  const stateOf = async (key) => (await settled(key)).getAttribute('data-ws-state');
  const text = async (sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');
  const asked = [];
  const onReq = (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/server/')) asked.push(u); };
  page.on('request', onReq);
  await reset();

  // ---- Price history ------------------------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/history`);
  check('history: available state with a chart', await stateOf('history') === 'available' && await page.locator('[data-testid=history-chart]').count() === 1);
  check('history: the series is identified as unadjusted', /Unadjusted series/.test(await text('[data-testid=series-id]')));
  check('history: no switch when only the unadjusted series exists, and the reason is given', await page.locator('[data-testid=series-control] .seg').count() === 0
    && /Unadjusted only/.test(await text('[data-testid=series-control]')) && /no adjusted series/i.test(await text('[data-testid=series-why]')));
  check('history: corporate actions are annotated on the chart and listed with their placement', await page.locator('[data-testid=history-chart] g.ann').count() > 0
    && /Dividend 0.55 USD \(on its date\)/.test(await text('[data-testid=history-annotations]')));
  const perf = await text('[data-testid=history-perf]');
  check('history: the change states its basis (which closes, which series, price only)', /from the close of \d{4}-\d{2}-\d{2} .* to the close of .* on the unadjusted series/.test(perf) && /Price change only/.test(perf), perf.slice(0, 220));
  await page.locator('[data-testid=history-controls] .seg button', { hasText: 'Table' }).click();
  check('history: table view lists the bars with OHLC and volume', await page.locator('[data-testid=history-table] tbody tr').count() > 20
    && /Open.*High.*Low.*Close.*Volume/.test(await text('[data-testid=history-table] thead')));
  await page.locator('[data-testid=history-controls] .seg button', { hasText: 'Chart' }).click();
  // The demo feed serves any range asked for, so a history that starts late is stood in by a labelled test fixture.
  await page.route('**/api/server/history/**', async (route) => {
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    const env = await res.json();
    if (env.items?.length > 60) { env.items = env.items.slice(40); env.source = { kind: 'test-fixture', label: 'Test fixture', fixture: true }; }
    return route.fulfill({ json: env }).catch(() => {});
  });
  await page.locator('[data-testid=history-controls] select').first().selectOption('1y');
  await settled('history');
  await page.locator('[data-testid=series-id]').waitFor();
  await page.waitForFunction(() => /Insufficient coverage/.test(document.querySelector('[data-ws-dataset=history]')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {});
  check('history: insufficient coverage is said, not filled', /Insufficient coverage\. The server's history starts on/.test(await text('[data-ws-dataset=history]')));
  await page.unroute('**/api/server/history/**', { behavior: 'ignoreErrors' }).catch(() => page.unroute('**/api/server/history/**'));
  await page.locator('[data-testid=history-controls] select').nth(1).selectOption('1wk');
  check('history: an unavailable interval is shown as unavailable', await waitState('history', 'unavailable') && /No price history|interval 1wk/i.test(await text('[data-ws-dataset=history]')));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=history-controls] select option')].some((o) => /not supplied/.test(o.textContent)));
  check('history: the interval list marks it as not supplied', true);

  // Adjusted and unadjusted both supplied (adjusted stood in at the browser by a labelled test fixture): the switch appears.
  await page.route('**/api/server/history/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get('adjusted') !== '1') return route.continue().catch(() => {});
    u.searchParams.set('adjusted', '0');
    const res = await route.fetch({ url: u.toString() }).catch(() => null);
    if (!res) return;
    const env = await res.json();
    env.requestId = new URL(route.request().url()).searchParams.get('requestId');
    env.items = (env.items || []).map((b) => ({ ...b, open: b.open * 0.99, high: b.high * 0.99, low: b.low * 0.99, close: b.close * 0.99 }));
    env.data = { ...(env.data || {}), adjusted: true, adjustmentBasis: 'Test fixture: adjusted for dividends' };
    env.source = { kind: 'test-fixture', label: 'Test fixture', fixture: true };
    return route.fulfill({ json: env }).catch(() => {});
  });
  await goto(`#/instrument/${alfa.id}/history`);
  await settled('history');
  await page.locator('[data-testid=series-control] .seg').waitFor({ timeout: 8000 }).catch(() => {});
  check('history: the adjusted / unadjusted switch is offered when both series exist', await page.locator('[data-testid=series-control] .seg button').count() === 2);
  await page.locator('[data-testid=series-control]').getByRole('button', { name: 'Adjusted', exact: true }).click();
  await page.waitForFunction(() => /Adjusted series/.test(document.querySelector('[data-testid=series-id]')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const sid = await text('[data-testid=series-id]');
  check('history: switching shows the adjusted series, identified with its basis', /Adjusted series: Test fixture: adjusted for dividends/.test(sid), sid.slice(0, 160));
  check('history: on the adjusted series the change is not called price only', /on the adjusted series/.test(await text('[data-testid=history-perf]')) && !/Price change only/.test(await text('[data-testid=history-perf]')));
  await page.locator('[data-testid=series-control]').getByRole('button', { name: 'Unadjusted', exact: true }).click();
  check('history: switching back shows the unadjusted series', /Unadjusted series/.test(await text('[data-testid=series-id]')));
  await page.unroute('**/api/server/history/**');

  await goto(`#/instrument/${kaij.id}/history`);
  await settled('history');
  const gapText = await page.locator('[data-testid=history-gaps]').count() ? await text('[data-testid=history-gaps]') : `(no gaps notice)`;
  check('history: a stated gap is listed and left empty on the chart', /No bars from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}, stated by the server/.test(gapText) && await page.locator('[data-testid=history-chart] rect.gap').count() === 1, gapText.slice(0, 300));

  for (const [m, want, re] of [['partial', 'incomplete', /Incomplete/], ['stale', 'stale', /Stale/], ['error', 'error', /could not be loaded/]]) {
    await mode('history', m);
    await goto(`#/instrument/${alfa.id}/history`);
    const st = await stateOf('history');
    const body = await text('[data-ws-dataset=history]');
    check(`history: ${m} fixture renders as ${want}`, st === want && re.test(body) && (m === 'error' || await page.locator('[data-testid=history-chart]').count() === 1), `${st}: ${body.slice(0, 160)}`);
    await reset();
  }
  asked.length = 0;
  await goto(`#/instrument/${alfa.id}/history/asof/2026-09-30`);
  await settled('history');
  const hreq = asked.filter((u) => u.pathname.startsWith('/api/server/history/'));
  check('history as of a date: the range ends on the research date and the panel says history is dated', /Research date 2026-09-30: bars up to that date/.test(await text('[data-testid=history-asof]'))
    && hreq.length > 0 && hreq.every((u) => u.searchParams.get('to') === '2026-09-30' && !u.searchParams.get('asOf')), hreq.map((u) => u.search).join(' | ').slice(0, 300));
  const lastBar = /to (\d{4}-\d{2}-\d{2})\./.exec(await text('[data-testid=series-id]'))?.[1];
  check('history as of a date: no bar after the research date', lastBar && lastBar <= '2026-09-30', lastBar);

  // ---- Overview -------------------------------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/overview`);
  check('overview: available', await stateOf('profile') === 'available');
  check('overview: company and listing in separate panels', /Industrials/.test(await text('[data-ws-dataset=profile]')) && !/Market capitalization/.test(await text('[data-ws-dataset=profile]'))
    && /Market capitalization/.test(await text('[data-ws-dataset="profile.listing"]')) && /Shares outstanding/.test(await text('[data-ws-dataset="profile.listing"]')));
  const capRow = await text('[data-field="listing.marketCap"]');
  check('overview: a figure carries its units, as-of date and source', /75,200,000,000/.test(capRow) && /USD/.test(capRow) && /\d{4}-\d{2}-\d{2}, Demo fixture/.test(capRow), capRow);
  check('overview: a missing field is named, not blank', /Revenue, trailing twelve months.*Not supplied/.test(await text('[data-field="highlights.revenueTTM"]')));
  check('overview: next earnings shown with confirmed or estimated', /estimated/.test(await text('[data-testid=overview-next-earnings]')));
  for (const [m, want, re] of [['partial', 'incomplete', /Incomplete/], ['stale', 'stale', /Stale/], ['error', 'error', /could not be loaded/], ['empty', 'unavailable', /No company and listing profile/], ['forbidden', 'error', /refused access/]]) {
    await mode('profile', m);
    await goto(`#/instrument/${alfa.id}/overview`);
    const st = await stateOf('profile');
    const body = await text('[data-ws-dataset=profile]');
    check(`overview: ${m} fixture renders as ${want}`, st === want && re.test(body), `${st}: ${body.slice(0, 160)}`);
    if (m === 'partial') check('overview: partial names the missing fields', await page.locator('[data-missing]').count() > 0);
    await reset();
  }
  await goto(`#/instrument/${alfa.id}/overview/asof/2026-09-30`);
  await settled('profile');
  check('overview as of a date: the unsupported profile is not replaced by current data', /not supported by the server contract/.test(await text('[data-ws-dataset=profile]')) && await page.locator('[data-testid=issuer-fields]').count() === 0);
  await page.getByRole('button', { name: 'Show current information' }).first().click();
  await page.locator('[data-testid=issuer-fields]').waitFor({ timeout: 8000 }).catch(() => {});
  check('overview as of a date: current information only on request, marked as current', /Current information, not as of 2026-09-30/.test(await text('[data-testid=overview-current]')) && await page.locator('[data-testid=issuer-fields]').count() === 1);

  // ---- Earnings ---------------------------------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/earnings`);
  check('earnings: available', await stateOf('earnings') === 'available');
  check('earnings: the upcoming release shows its date as estimated', /estimated/.test(await text('[data-testid=earnings-upcoming]')));
  const past = await text('[data-testid=earnings-past]');
  check('earnings: reported, consensus, prior and surprise per metric, with reporting time and revision', /Reported Consensus Prior Change vs prior Surprise Surprise %/.test(past) && /Revenue/.test(past) && /EPS, diluted/.test(past) && /Reported \w{3} \d{2}, \d{4}, \d{2}:\d{2}:\d{2} ET/.test(past) && /revised/.test(past), past.slice(0, 300));
  check('earnings: the EPS sentence says displaying it does not change SP3E\'s inputs', /displaying it does not change SP3E's inputs/.test(await text('[data-testid=eps-note]')));
  const href = await page.locator('[data-testid=earnings-past] .e1-docs a').first().getAttribute('href');
  const doc = await page.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, type: r.headers.get('content-type') }; }, href);
  check('earnings: release documents open through the document proxy', href.startsWith('/api/server/documents/') && doc.status === 200, `${href} ${JSON.stringify(doc)}`);
  const win = await text('[data-ws-dataset=earningsWindow]');
  check('earnings: eligibility is a separate Analytics Lab panel with run and input cutoff', await stateOf('earningsWindow') === 'available' && /Eligible/.test(win) && /fixture-run-alfa-0002/.test(win) && /Input-data cutoff \w{3} \d{2}, \d{4}/.test(win) && !/Eligib/.test(await text('[data-ws-dataset=earnings]')), win.slice(0, 300));
  for (const [m, want, re] of [['partial', 'incomplete', /Incomplete/], ['stale', 'stale', /Stale/], ['error', 'error', /could not be loaded/]]) {
    await mode('earnings', m);
    await goto(`#/instrument/${alfa.id}/earnings`);
    const st = await stateOf('earnings');
    const body = await text('[data-ws-dataset=earnings]');
    check(`earnings: ${m} fixture renders as ${want}`, st === want && re.test(body) && await stateOf('earningsWindow') === 'available', `${st}: ${body.slice(0, 160)}`);
    await reset();
  }
  await mode('earningsWindow', 'forbidden');
  await goto(`#/instrument/${alfa.id}/earnings`);
  check('earnings: a refused eligibility leaves the calendar facts shown', await stateOf('earningsWindow') === 'error' && await stateOf('earnings') === 'available');
  await reset();
  await goto(`#/instrument/${alfa.id}/earnings/asof/2025-12-31`);
  await settled('earnings');
  await settled('earningsWindow');
  const eAsOf = await text('[data-ws-dataset=earnings]');
  const releases = [...eAsOf.matchAll(/Release (\w{3} \d{2}, \d{4})/g)].map((x) => new Date(x[1]).toISOString().slice(0, 10));
  check('earnings as of a date: as it was known then, no release after the date and no later "upcoming" date', /As of 2025-12-31, as it was known then/.test(eAsOf) && releases.length > 0 && releases.every((d) => d <= '2025-12-31') && /No upcoming release/.test(eAsOf), `${releases.join(',')} ${eAsOf.slice(0, 200)}`);
  check('earnings as of a date: eligibility says when the contract does not support the date', /not supported by the server contract|as it was known then/.test(await text('[data-ws-dataset=earningsWindow]')));
  await goto(`#/instrument/${brvo.id}/earnings`);
  await settled('earnings');
  check('earnings: a confirmed upcoming date is shown as confirmed', /confirmed/.test(await text('[data-testid=earnings-upcoming]')));
  page.off('request', onReq);
  await reset();
}

// ---- standalone ----------------------------------------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { createSandbox } = await import('../../matrix/lib/sandbox.mjs');
  const { startServer } = await import('../../matrix/lib/server.mjs');
  const { launchBrowser } = await import('../../matrix/drivers/browser.mjs');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); };
  const sandbox = createSandbox('e1-tabs');
  const server = await startServer(sandbox, { demo: true });
  const browser = await launchBrowser({ headed: Boolean(process.env.SDT_HEADED) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const api = (path, body) => page.evaluate(async ([u, b]) => { const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); }, [`${server.url}${path}`, body]);
  const goto = async (hash) => { await page.goto(`${server.url}/${hash}`); await page.locator('.shell .topbar').waitFor(); };
  try {
    await goto('#/accounting');
    await e1Tabs({ page, api, goto, check });
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
