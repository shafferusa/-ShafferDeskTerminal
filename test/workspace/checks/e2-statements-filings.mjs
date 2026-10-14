// Browser checks of the Financial statements and Filings and reports tabs (e2), run by test/workspace/run-browser.mjs.
// Expected values are read from the server's own answer (the demo fixture) and the arithmetic is done here, by hand,
// not copied from the screen.
export default async function statementsAndFilings({ page, api, goto, check, alfa, brvo }) {
  const fixture = (dataset, mode, extra = {}) => api('/api/demo/fixtures/server', { dataset, mode, ...extra });
  const panel = (key) => page.locator(`[data-ws-dataset=${key}]`);
  const settled = (key) => page.locator(`[data-ws-dataset=${key}]:not([data-ws-state=loading])`).waitFor({ timeout: 10_000 });
  const stateOf = async (key) => panel(key).getAttribute('data-ws-state');
  const cell = (line, col) => page.locator(`[data-ws-dataset=statements] [data-st-cell="${line}:${col}"]`);
  const num = (s) => Number(String(s).replace(/[^0-9.\-−]/g, '').replace('−', '-'));
  await page.evaluate(() => { try { sessionStorage.removeItem('sdt.ws.statements'); } catch { /* fresh view choices */ } });

  // ---- statements: income, quarterly, with the restated quarter and its original beside it ---------------------------
  const inc = await api(`/api/server/statements/${alfa.id}?statement=income&period=quarterly&periods=8`);
  const restated = inc.data.periods.find((p) => p.basis === 'restated');
  await goto(`#/instrument/${alfa.id}/statements`);
  await page.locator('[data-ws-dataset=statements][data-ws-state=available]').waitFor({ timeout: 10_000 });
  const heads = await page.locator('[data-ws-dataset=statements] th[data-st-col]').evaluateAll((ths) => ths.map((t) => t.dataset.stCol));
  check('statements: periods side by side, the original column right after the restated one', restated && heads.indexOf(`${restated.key}:original`) === heads.indexOf(restated.key) + 1, heads.join(','));
  const revNow = num(await cell('revenue', restated.key).innerText()), revOrig = num(await cell('revenue', `${restated.key}:original`).innerText());
  const revLine = inc.data.lines.find((l) => l.key === 'revenue');
  check('statements: restated value and the originally reported value both shown, not overwritten', revNow === revLine.values[restated.key] && revOrig === revLine.original[restated.key] && revNow !== revOrig, `${revNow} / ${revOrig}`);
  check('statements: the restated cell is marked and the column says restated', /r/.test(await cell('revenue', restated.key).locator('sup').innerText()) && /restated/.test(await page.locator(`th[data-st-col="${restated.key}"]`).innerText()));
  check('statements: every supplied line item is listed', await page.locator('[data-ws-dataset=statements] tr[data-st-line]').count() === inc.data.lines.length);
  const head0 = await page.locator(`th[data-st-col="${inc.data.periods[0].key}"]`).innerText();
  check('statements: column shows fiscal period, coverage, filing date, source and basis', /FY\d{4} Q\d/.test(head0) && /standalone quarter/.test(head0) && /3 months/.test(head0) && /filed \d{4}-\d{2}-\d{2}/.test(head0) && /Demo fixture filing/.test(head0) && /reported/.test(head0), head0);
  check('statements: statement currency and units shown', /USD/.test(await page.locator('.st-facts').innerText()) && /millions/.test(await page.locator('.st-facts').innerText()));
  check('statements: a cell whose basis differs from its column is marked (gross profit derived)', /d/.test(await cell('grossProfit', inc.data.periods[0].key).locator('sup').innerText()));
  // Pinned line labels while the periods scroll sideways.
  const sc = page.locator('[data-ws-dataset=statements] .st-scroll').first();
  const before = await page.locator('[data-ws-dataset=statements] tr[data-st-line=revenue] th.st-l').boundingBox();
  await sc.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(150);
  const after = await page.locator('[data-ws-dataset=statements] tr[data-st-line=revenue] th.st-l').boundingBox();
  const scrolled = await sc.evaluate((el) => el.scrollLeft);
  check('statements: line labels stay pinned while the periods scroll', scrolled > 0 && Math.abs(before.x - after.x) < 1, `scrollLeft ${scrolled}, x ${before.x} -> ${after.x}`);
  // How many periods.
  await page.locator('.st-count select').selectOption('4');
  await page.waitForFunction(() => document.querySelectorAll('[data-ws-dataset=statements] th[data-st-col]:not([data-st-col$=":original"])').length === 4, null, { timeout: 8000 }).catch(() => {});
  check('statements: the number of periods side by side can be chosen', await page.locator('[data-ws-dataset=statements] th[data-st-col]:not([data-st-col$=":original"])').count() === 4);
  await page.locator('.st-count select').selectOption('8');

  // ---- balance sheet: values at a date ---------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Balance sheet', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-ws-dataset=statements] th[data-st-kind]')?.dataset.stKind === 'instant', null, { timeout: 8000 }).catch(() => {});
  const kinds = await page.locator('[data-ws-dataset=statements] th[data-st-kind]').evaluateAll((ths) => ths.map((t) => t.dataset.stKind));
  check('balance sheet: every column is a value at a date', kinds.length > 0 && kinds.every((k) => k === 'instant') && /at \d{4}-\d{2}-\d{2}/.test(await page.locator('[data-ws-dataset=statements] th[data-st-col]').first().innerText()), kinds.join(','));

  // ---- cash flow: year to date never shown as a quarter; the derivation only on request and apart ---------------------
  const cf = await api(`/api/server/statements/${alfa.id}?statement=cashflow&period=quarterly&periods=8`);
  await page.getByRole('button', { name: 'Cash flow statement', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ws-dataset=statements] th[data-st-kind]')].some((t) => t.dataset.stKind === 'ytd'), null, { timeout: 8000 }).catch(() => {});
  const cfCols = await page.locator('[data-ws-dataset=statements] th[data-st-kind]').evaluateAll((ths) => ths.map((t) => [t.dataset.stCol, t.dataset.stKind, t.innerText]));
  const ytdKeys = cf.data.periods.filter((p) => p.periodType === 'ytd').map((p) => p.key);
  check('cash flow: year-to-date columns are labelled year to date, never standalone quarter', ytdKeys.length > 0 && ytdKeys.every((k) => cfCols.find((c) => c[0] === k)?.[1] === 'ytd' && /year to date/.test(cfCols.find((c) => c[0] === k)[2]) && !/standalone/.test(cfCols.find((c) => c[0] === k)[2])), JSON.stringify(cfCols.slice(0, 3)));
  check('cash flow: the view says the server supplies year-to-date figures', /Year-to-date figures/.test(await panel('statements').innerText()));
  check('cash flow: nothing is derived until asked', await page.locator('[data-testid=st-derived]').count() === 0);
  await page.getByText(/Show the difference between consecutive YTD figures/).click();
  await page.locator('[data-testid=st-derived]').waitFor();
  const dtext = await page.locator('[data-testid=st-derived]').innerText();
  check('cash flow: the derivation is labelled "derived in the Terminal, not a model input"', /derived in the Terminal, not a model input/.test(dtext));
  // By hand: the first year-to-date column with a 3-months-shorter partner of the same fiscal year.
  const later = cf.data.periods.find((p) => p.periodType === 'ytd' && cf.data.periods.some((e) => e.fiscalYear === p.fiscalYear && e.end < p.end && (e.months ?? 3) === p.months - 3));
  const earlier = cf.data.periods.find((e) => e.fiscalYear === later.fiscalYear && e.end < later.end && (e.months ?? 3) === later.months - 3);
  const cfo = cf.data.lines.find((l) => l.key === 'cfo');
  const want = Math.round((cfo.values[later.key] - cfo.values[earlier.key]) * 10) / 10;
  const dCols = await page.locator('[data-testid=st-derived] th[data-st-col]').evaluateAll((ths) => ths.map((t) => t.dataset.stCol));
  const idx = dCols.indexOf(`${later.key}:derived`);
  const got = idx < 0 ? null : num(await page.locator('[data-testid=st-derived] tbody tr').nth(cf.data.lines.indexOf(cfo)).locator('td').nth(idx).innerText());
  check('cash flow: a derived quarter is the later YTD minus the earlier one of the same fiscal year', got === want, `${later.key} - ${earlier.key}: want ${want}, got ${got}`);
  const lone = cf.data.periods.find((p) => p.periodType === 'ytd' && !cf.data.periods.some((e) => e.fiscalYear === p.fiscalYear && (e.months ?? 3) === p.months - 3));
  check('cash flow: a YTD figure without its partner of the same fiscal year is not derived', !lone || (!dCols.includes(`${lone.key}:derived`) && /Not derived/.test(dtext)));
  check('cash flow: derived values are kept apart from the supplied grid', await page.locator('[data-ws-dataset=statements] [data-testid=st-grid] th[data-st-col$=":derived"]').count() === 0);

  // ---- annual, the supplied TTM apart, and the labelled Terminal comparison ----------------------------------------------
  await page.getByRole('button', { name: 'Income statement', exact: true }).click();
  await page.getByRole('button', { name: 'Annual', exact: true }).click();
  await page.locator('[data-ws-dataset=statementsTtm][data-ws-state=available]').waitFor({ timeout: 10_000 }).catch(() => {});
  const annualKinds = await page.locator('[data-ws-dataset=statements] th[data-st-kind]').evaluateAll((ths) => ths.map((t) => t.dataset.stKind));
  check('annual: the annual grid holds fiscal years only', annualKinds.length > 0 && annualKinds.every((k) => k === 'annual'), annualKinds.join(','));
  check('annual: the supplied TTM is its own panel, marked trailing twelve months', await stateOf('statementsTtm') === 'available' && /trailing twelve months/.test(await panel('statementsTtm').innerText()) && await panel('statementsTtm').locator('th[data-st-kind=ttm]').count() === 1);
  await page.locator('.st-opts').getByText('Terminal comparison', { exact: true }).click();
  const cmp = page.locator('[data-testid=st-compare]');
  await cmp.waitFor();
  const ann = await api(`/api/server/statements/${alfa.id}?statement=income&period=annual&periods=5`);
  const [y1, y0] = ann.data.periods;
  const rev = ann.data.lines.find((l) => l.key === 'revenue').values;
  const pct = ((rev[y1.key] - rev[y0.key]) / Math.abs(rev[y0.key])) * 100;
  const cmpText = await cmp.innerText();
  const firstRev = await cmp.locator('tbody tr').first().locator('td').first().innerText();
  check('comparison: labelled as worked out in the Terminal, not a model input, in its own panel', /not supplied by the server and not a model input/.test(cmpText));
  check('comparison: revenue change against the year before, by hand', Math.abs(num(firstRev) - Math.round(pct * 10) / 10) < 0.051, `want ${pct.toFixed(2)}, got ${firstRev}`);
  await page.locator('.st-opts').getByText('Terminal comparison', { exact: true }).click();
  await page.getByRole('button', { name: 'Quarterly', exact: true }).click();

  // ---- states of the statements dataset ------------------------------------------------------------------------------
  for (const [mode, want2] of [['partial', 'incomplete'], ['stale', 'stale'], ['error', 'error'], ['forbidden', 'error'], ['empty', 'unavailable']]) {
    await fixture('statements', mode);
    await panel('statements').getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction((w) => document.querySelector('[data-ws-dataset=statements]')?.dataset.wsState === w, want2, { timeout: 15_000 }).catch(() => {});
    const st = await stateOf('statements');
    const txt = await panel('statements').innerText();
    let ok = st === want2;
    if (mode === 'partial') ok = ok && await panel('statements').locator('td .missing').count() > 0 && /Incomplete/.test(txt);
    if (mode === 'forbidden') ok = ok && /refused access/.test(txt);
    if (mode === 'error') ok = ok && /Refresh to ask again/.test(txt);
    check(`statements: fixture mode ${mode} is drawn as ${want2}`, ok, `${st}: ${txt.slice(0, 160)}`);
  }
  await api('/api/demo/fixtures/server', { reset: true });
  await panel('statements').getByRole('button', { name: 'Refresh' }).click();
  await page.locator('[data-ws-dataset=statements][data-ws-state=available]').waitFor({ timeout: 10_000 }).catch(() => {});
  await fixture('statements', 'slow', { delayMs: 2500 });
  // Another statement while the answer is slow: the previous statement is never drawn under the new title.
  await page.getByRole('button', { name: 'Balance sheet', exact: true }).click();
  await page.waitForTimeout(150);
  const slowState = await stateOf('statements');
  const slowKinds = await page.locator('[data-ws-dataset=statements] th[data-st-kind]').evaluateAll((ths) => ths.map((t) => t.dataset.stKind));
  check('statements: a slow answer shows the loading state, not the previous statement', slowState === 'loading' && slowKinds.length === 0, `${slowState} ${slowKinds.join(',')}`);
  await page.locator('[data-ws-dataset=statements][data-ws-state=available]').waitFor({ timeout: 10_000 }).catch(() => {});
  const lateKinds = await page.locator('[data-ws-dataset=statements] th[data-st-kind]').evaluateAll((ths) => ths.map((t) => t.dataset.stKind));
  check('statements: the slow answer arrives and is drawn', await stateOf('statements') === 'available' && lateKinds.length > 0 && lateKinds.every((k) => k === 'instant'));
  await page.getByRole('button', { name: 'Income statement', exact: true }).click();
  await api('/api/demo/fixtures/server', { reset: true });

  // ---- annual-only issuer, and as of a date before the restatement -----------------------------------------------------
  await goto(`#/instrument/${brvo.id}/statements`);
  await settled('statements');
  check('statements: annual-only issuer answers quarterly as unavailable and offers annual', await stateOf('statements') === 'unavailable' && await page.getByRole('button', { name: 'Show annual statements' }).count() === 1);
  await page.getByRole('button', { name: 'Show annual statements' }).click();
  await page.locator('[data-ws-dataset=statements][data-ws-state=available]').waitFor({ timeout: 10_000 }).catch(() => {});
  check('statements: the annual statements of that issuer are shown', await stateOf('statements') === 'available');
  await page.getByRole('button', { name: 'Quarterly', exact: true }).click();
  const asOf = restated.restatedAt ? new Date(new Date(`${restated.restatedAt}T00:00:00Z`).getTime() - 86400e3).toISOString().slice(0, 10) : null;
  await goto(`#/instrument/${alfa.id}/statements/asof/${asOf}`);
  await page.locator('[data-ws-dataset=statements][data-ws-state=available]').waitFor({ timeout: 10_000 }).catch(() => {});
  const asOfVal = await cell('revenue', restated.key).count() ? num(await cell('revenue', restated.key).innerText()) : null;
  check('statements as of a date: shown as filed then (the original value, no restatement yet)', asOfVal === revLine.original[restated.key] && await page.locator(`th[data-st-col="${restated.key}:original"]`).count() === 0 && /As filed on or before/.test(await panel('statements').innerText()), `${asOf}: ${asOfVal}`);

  // ---- filings: cursor pages, search over every page, type filter, document viewer -----------------------------------
  const allF = (await api(`/api/server/filings/${alfa.id}?all=1`)).items;
  const asked = [];
  const onReq = (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/server/filings/')) asked.push(u); };
  page.on('request', onReq);
  await goto(`#/instrument/${alfa.id}/filings`);
  await page.locator('[data-ws-dataset=filings][data-ws-state=available]').waitFor({ timeout: 10_000 });
  const rowsOf = () => page.locator('[data-testid=fl-table] tbody tr').evaluateAll((trs) => trs.map((t) => t.dataset.filing));
  const p1 = await rowsOf();
  check('filings: the first page of the server list with type, period, date and source', p1.length === 10 && p1[0] === allF[0].id && /Annual report|Interim report|Earnings release|Presentation/.test(await page.locator('[data-testid=fl-table]').innerText()) && /of 23/.test(await page.locator('[data-testid=fl-count]').innerText()));
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=fl-table] tbody tr')?.dataset.filing === id, allF[10].id, { timeout: 8000 }).catch(() => {});
  const p2 = await rowsOf();
  check('filings: Next page follows the server cursor', p2[0] === allF[10].id && asked.some((u) => u.searchParams.get('cursor') === 'fixture-cursor-10'), p2[0]);
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=fl-table] tbody tr')?.dataset.filing === id, allF[20].id, { timeout: 8000 }).catch(() => {});
  check('filings: the last page has the remaining filings and no Next page', (await rowsOf()).length === 3 && await page.getByRole('button', { name: 'Next page' }).isDisabled());
  await page.getByRole('button', { name: 'Previous page' }).click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=fl-table] tbody tr')?.dataset.filing === id, allF[10].id, { timeout: 8000 }).catch(() => {});
  check('filings: Previous page goes back', (await rowsOf())[0] === allF[10].id);
  await page.getByPlaceholder(/Search filings/).fill('presentation');
  const wantSearch = allF.filter((f) => /presentation/i.test(`${f.title} ${f.kind}`)).length;
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=fl-table] tbody tr').length === n, wantSearch, { timeout: 8000 }).catch(() => {});
  check('filings: search covers every page of the list', (await rowsOf()).length === wantSearch && wantSearch > 3 && /all pages searched/.test(await page.locator('[data-testid=fl-count]').innerText()) && asked.some((u) => u.searchParams.get('all') === '1'), `${(await rowsOf()).length} of ${wantSearch}`);
  await page.getByPlaceholder(/Search filings/).fill('');
  await page.locator('.fl-tools select').selectOption('annual-report');
  const wantKind = allF.filter((f) => f.kind === 'annual-report').length;
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=fl-table] tbody tr').length === n, wantKind, { timeout: 8000 }).catch(() => {});
  check('filings: the type filter keeps that type only', (await rowsOf()).length === wantKind);
  await page.locator('.fl-tools select').selectOption('');
  page.off('request', onReq);
  await page.getByRole('button', { name: 'Previous page' }).click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=fl-table] tbody tr')?.dataset.filing === id, allF[0].id, { timeout: 8000 }).catch(() => {});
  // Document viewer.
  await page.locator('[data-testid=fl-table] .fl-docs button').first().click();
  const viewer = page.locator('[data-testid=doc-viewer]');
  await page.locator('[data-testid=doc-viewer][data-doc-state=ready]').waitFor({ timeout: 8000 }).catch(() => {});
  const frame = viewer.locator('iframe');
  const docId = allF[0].documents[0].id;
  check('document viewer: the proxy route in a sandboxed frame', await frame.count() === 1 && await frame.getAttribute('sandbox') === '' && await frame.getAttribute('src') === `/api/server/documents/${docId}`);
  let ftxt = '';
  for (let i = 0; i < 25 && !/Demo fixture document/.test(ftxt); i++) {
    const fr = page.frames().find((f) => f.url().includes(`/api/server/documents/${docId}`));
    ftxt = fr ? await fr.locator('body').innerText({ timeout: 1000 }).catch(() => '') : '';
    if (!/Demo fixture document/.test(ftxt)) await page.waitForTimeout(200);
  }
  check('document viewer: the document is displayed', /Demo fixture document/.test(ftxt), ftxt.slice(0, 80));
  const nt = page.locator('[data-testid=doc-newtab]');
  check('document viewer: offers the same route in a new tab', await nt.getAttribute('href') === `/api/server/documents/${docId}` && await nt.getAttribute('target') === '_blank' && /noopener/.test(await nt.getAttribute('rel')));
  check('document viewer: names the filing type, period, date and source', /Annual report.*period .*filed \d{4}-\d{2}-\d{2}.*source Demo fixture/s.test(await page.locator('.modal header').innerText()));
  await page.keyboard.press('Escape');
  await fixture('documents', 'forbidden');
  await page.locator('[data-testid=fl-table] .fl-docs button').first().click();
  await page.locator('[data-testid=doc-viewer]:not([data-doc-state=loading])').waitFor({ timeout: 8000 }).catch(() => {});
  check('document viewer: a refused document says so and shows no frame', await viewer.getAttribute('data-doc-state') === 'error' && await viewer.locator('iframe').count() === 0 && /refused access/.test(await viewer.innerText()));
  await page.keyboard.press('Escape');
  await api('/api/demo/fixtures/server', { reset: true });

  // ---- filings: states and as of a date ---------------------------------------------------------------------------------
  const kaij = (await api('/api/instruments?q=KAIJ')).items.find((i) => i.symbol === 'KAIJ');
  await goto(`#/instrument/${kaij.id}/filings`);
  await settled('filings');
  check('filings: a 403 from the server is an error that is not asked again', await stateOf('filings') === 'error' && /refused access/.test(await panel('filings').innerText()));
  await goto(`#/instrument/${alfa.id}/filings`);
  for (const [mode, want2] of [['empty', 'unavailable'], ['stale', 'stale'], ['partial', 'incomplete'], ['error', 'error']]) {
    await fixture('filings', mode);
    await panel('filings').getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction((w) => document.querySelector('[data-ws-dataset=filings]')?.dataset.wsState === w, want2, { timeout: 15_000 }).catch(() => {});
    check(`filings: fixture mode ${mode} is drawn as ${want2}`, await stateOf('filings') === want2, await stateOf('filings'));
  }
  await api('/api/demo/fixtures/server', { reset: true });
  const cut = allF[5].filedAt.slice(0, 10);
  await goto(`#/instrument/${alfa.id}/filings/asof/${cut}`);
  await page.locator('[data-ws-dataset=filings][data-ws-state=available]').waitFor({ timeout: 10_000 }).catch(() => {});
  const asOfRows = await rowsOf();
  check('filings as of a date: only what was filed by then', asOfRows.length > 0 && asOfRows[0] === allF[5].id && /As of .*as it was known then/.test(await panel('filings').innerText()), asOfRows.slice(0, 2).join(','));
}
