// Browser checks closing the workers' open items (i1): the loading state of every equity tab with a slowed answer;
// the drawer opened from a Strategies-page leg and from a hedge-package leg; a trade from the detail page recording
// its origin; a PDF document in the sandboxed viewer and its new-tab path; hover titles on chart points; the sticky
// header's height at 1024 x 768.
//
// Run by test/workspace/run-browser.mjs on its demo server, or alone:
//   node --disable-warning=ExperimentalWarning test/workspace/checks/i1-open-items.mjs
export default async function i1OpenItems({ page, api, goto, check, alfa }) {
  const mode = (dataset, m, extra = {}) => api('/api/demo/fixtures/server', { dataset, mode: m, ...extra });
  const reset = () => api('/api/demo/fixtures/server', { reset: true });
  const panel = (key) => page.locator(`[data-ws-dataset="${key}"]`).first();
  const settled = async (key, timeout = 15_000) => { await page.locator(`[data-ws-dataset="${key}"]:not([data-ws-state=loading])`).first().waitFor({ timeout }); return panel(key); };
  const reopen = async (hash) => { await goto(hash); await page.reload(); await page.locator('.shell .topbar').waitFor(); };
  const drawerHead = () => page.getByRole('dialog').filter({ has: page.locator('[data-testid=ws-header]') }).last().locator('[data-testid=ws-header]');
  const closeAll = async () => { for (let i = 0; i < 8 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape'); };
  const SP3E = 'fixture-strat-sp3e';
  await reset();

  // ---- loading state per equity tab, with a slowed answer ------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/analytics`);
  await page.locator('.ws-strat select').selectOption(SP3E);
  for (const [tab, ds] of [['overview', 'profile'], ['history', 'history'], ['earnings', 'earnings'], ['statements', 'statements'], ['filings', 'filings'], ['actions', 'corporateActions'], ['news', 'news'], ['analytics', 'analytics']]) {
    await mode(ds, 'slow', { delayMs: 2500 });
    await reopen(`#/instrument/${alfa.id}/${tab}`);
    const sawLoading = await page.locator(`[data-ws-dataset="${ds}"][data-ws-state=loading]`).first().waitFor({ timeout: 2000 }).then(() => true, () => false);
    const loadingText = sawLoading ? await panel(ds).innerText().catch(() => '') : '';
    const end = await (await settled(ds)).getAttribute('data-ws-state');
    check(`slow answer: ${tab} shows its own loading state, then the answer`, sawLoading && /Loading/.test(loadingText) && end === 'available', `${sawLoading} ${end} ${loadingText.slice(0, 80)}`);
    await mode(ds, 'available');
  }
  await reset();

  // ---- trade from the detail page: origin recorded, hedge workflow after the fill -----------------------------------
  await goto(`#/instrument/${alfa.id}`);
  await page.getByRole('button', { name: 'Trade', exact: true }).first().click();
  let dr = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^Trade/ }) }).last();
  await dr.waitFor();
  await dr.locator('.field', { has: page.locator('label', { hasText: /^Shares/ }) }).locator('input').fill('20');
  await dr.getByRole('button', { name: /^Preview buy/ }).click();
  const pv = page.locator('.modal').last();
  await pv.waitFor();
  const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/strategies');
  await pv.getByRole('button', { name: /^Confirm/ }).click();
  const sub = await (await submitted).json();
  check('trade from the detail page: the package records origin "instrument-detail"', sub.strategy?.params?.origin === 'instrument-detail', JSON.stringify(sub.strategy?.params || sub).slice(0, 200));
  // Close the ticket drawer (and the preview) only, so the hedge prompt that follows the fill stays
  for (let i = 0; i < 4 && await page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^Trade/ }) }).count() && !(await page.locator('.modal header h2', { hasText: /^Hedge for/ }).count()); i++) await page.keyboard.press('Escape');
  const prompt = page.locator('.modal header h2', { hasText: /^Hedge for/ });
  check('trade from the detail page: the hedge workflow opens after the fill', await prompt.waitFor({ timeout: 25_000 }).then(() => true, () => false));

  // ---- the drawer from a hedge-package leg (the hedge prompt that followed the fill above) --------------------------
  // The prompt asks for the missing context first; with it saved the demo hedge fixture answers with packages. A leg
  // on a registered instrument (the index-future overlay) carries "Open instrument"; a drafted option leg does not.
  const hm = page.locator('.modal').filter({ has: page.locator('header h2', { hasText: /^Hedge for/ }) }).last();
  let fromHedge = null, hedgeDetail = '';
  if (await hm.count()) {
    const hp = hm.locator('.field', { has: page.locator('label', { hasText: /^Intended holding period/ }) }).locator('input');
    if (await hp.count()) {
      await hp.fill('60');
      await hm.locator('.field', { has: page.locator('label', { hasText: /^Hedge objective/ }) }).locator('select').selectOption({ label: 'Downside protection' });
      await hm.getByRole('button', { name: 'Save request' }).click();
    }
    const overlay = hm.getByRole('button', { name: /Index Future overlay/ });
    await overlay.waitFor({ timeout: 15_000 }).catch(() => {});
    if (await overlay.count()) {
      await overlay.click();
      const legBtn = hm.getByRole('button', { name: 'Open instrument' }).first();
      await legBtn.waitFor({ timeout: 10_000 }).catch(() => {});
      if (await legBtn.count()) {
        await legBtn.click();
        await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] [data-testid=ws-header]')].length > 0, null, { timeout: 8000 }).catch(() => {});
        fromHedge = await drawerHead().getAttribute('data-ws-inst').catch(() => null);
        const inst = fromHedge ? (await api(`/api/instruments/${fromHedge}/detail`)).instrument : null;
        hedgeDetail = `${fromHedge} ${inst?.family} ${inst?.symbol}`;
        fromHedge = inst?.family === 'future' && (await hm.isVisible()) ? fromHedge : null;
      } else hedgeDetail = 'no "Open instrument" on the overlay leg';
    } else hedgeDetail = `no packages: ${(await hm.innerText()).slice(0, 160)}`;
  } else hedgeDetail = 'no hedge prompt';
  check('drawer: "Open instrument" on a hedge-package leg (a futures overlay) opens that future\'s workspace above the hedge dialog', Boolean(fromHedge), hedgeDetail);
  await closeAll();

  // ---- the drawer from a Strategies-page leg (Custom Multi-Leg) ------------------------------------------------------
  await goto(`#/strategy/for/${alfa.id}`);
  const tsel = page.locator('main .field', { has: page.locator('label', { hasText: /^Execution template/ }) }).locator('select');
  await tsel.waitFor();
  await tsel.selectOption({ label: 'Custom Multi-Leg' });
  await page.getByRole('button', { name: 'Add a leg' }).click();
  const legDlg = page.locator('.modal').filter({ has: page.locator('header h2', { hasText: 'Add a leg' }) }).last();
  await legDlg.waitFor();
  await legDlg.getByPlaceholder('Type a ticker or name').fill('BRVO');
  await legDlg.locator('.picklist button.pick', { hasText: 'BRVO' }).first().click();
  await legDlg.locator('.field', { has: page.locator('label', { hasText: /^(Quantity|Shares|Units)/ }) }).locator('input').first().fill('10');
  await legDlg.getByRole('button', { name: 'Add leg' }).click();
  const legOpen = page.locator('main').getByRole('button', { name: 'Open instrument' }).first();
  await legOpen.waitFor({ timeout: 10_000 }).catch(() => {});
  let fromStrategy = null;
  const brvoId = (await api('/api/instruments?q=BRVO')).items.find((i) => i.symbol === 'BRVO')?.id;
  if (await legOpen.count()) { await legOpen.click(); await drawerHead().waitFor({ timeout: 8000 }).catch(() => {}); fromStrategy = await drawerHead().getAttribute('data-ws-inst').catch(() => null); }
  check('drawer: "Open instrument" on a Strategies-page leg opens that leg\'s workspace', fromStrategy === brvoId, `${fromStrategy} vs ${brvoId}`);
  await closeAll();

  // ---- a PDF document in the viewer ----------------------------------------------------------------------------------
  const filings = await api(`/api/server/filings/${alfa.id}?all=1`);
  const withPdf = filings.items.find((f) => f.documents.some((d) => /pdf/.test(d.mediaType)));
  const pdfDoc = withPdf?.documents.find((d) => /pdf/.test(d.mediaType));
  const head = await page.evaluate(async (id) => { const r = await fetch(`/api/server/documents/${id}`); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options'), magic: String.fromCharCode(...b.slice(0, 5)), size: b.length }; }, pdfDoc?.id || 'none');
  check('PDF: the fixture PDF is served by the proxy as application/pdf, sandboxed, nosniff, and is a PDF', head.status === 200 && /application\/pdf/.test(head.type) && /sandbox/.test(head.csp || '') && head.nosniff === 'nosniff' && head.magic === '%PDF-', JSON.stringify(head));
  await goto(`#/instrument/${alfa.id}/filings`);
  await settled('filings');
  await page.locator(`[data-filing="${withPdf.id}"] .fl-docs button`, { hasText: /pdf/i }).click();
  const viewer = page.locator('[data-testid=doc-viewer]');
  await page.locator('[data-testid=doc-viewer][data-doc-state=ready]').waitFor({ timeout: 8000 }).catch(() => {});
  const frame = viewer.locator('iframe');
  const vText = await viewer.innerText().catch(() => '');
  const nt = page.locator('[data-testid=doc-newtab]');
  check('PDF: the viewer frames the proxy route sandboxed, says to open a PDF in a new tab if it does not display, and offers that tab',
    await frame.count() === 1 && await frame.getAttribute('sandbox') === '' && await frame.getAttribute('src') === `/api/server/documents/${pdfDoc.id}` && /If the PDF does not display in the frame, open it in a new tab/.test(vText)
    && await nt.getAttribute('href') === `/api/server/documents/${pdfDoc.id}` && await nt.getAttribute('target') === '_blank', vText.slice(0, 160));
  await closeAll();

  // ---- hover titles on chart points ----------------------------------------------------------------------------------
  await goto(`#/instrument/${alfa.id}/history`);
  await settled('history');
  const hist = await api(`/api/server/history/${alfa.id}`);
  const titles = await page.locator('[data-testid=history-hits] rect title').allTextContents();
  check('chart: each bar has a hover title with its date and close', titles.length > 0 && titles.every((t) => /^\d{4}-\d{2}-\d{2}: close /.test(t)), `${titles.length} titles; ${titles[0]}`);
  void hist;

  // ---- the sticky header at 1024 x 768 ---------------------------------------------------------------------------------
  const vp = page.viewportSize();
  await page.setViewportSize({ width: 1024, height: 768 });
  await goto(`#/instrument/${alfa.id}/overview`);
  await page.locator('.ws-sticky.page [data-testid=ws-header]').waitFor();
  await page.waitForTimeout(300);
  const hH = await page.locator('.ws-sticky.page').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  // Measured before the compaction (app.css, "acceptance pass (i1)"): 208 px; after: 184 px with a Strategy chosen
  check('header at 1024 x 768: the sticky page header is compacted (at most 200 px, was 208)', hH <= 200, `${hH} px of 768`);
  await page.setViewportSize(vp);
  await reset();
}

// Standalone run: its own sandboxed demo server and browser.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { createSandbox } = await import('../../matrix/lib/sandbox.mjs');
  const { startServer } = await import('../../matrix/lib/server.mjs');
  const { launchBrowser } = await import('../../matrix/drivers/browser.mjs');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); };
  const sandbox = createSandbox('i1-open-items');
  const server = await startServer(sandbox, { demo: true, engine: 'on' });
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
    await i1OpenItems({ page, api, goto, check, alfa: await find('ALFA') });
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
