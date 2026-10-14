// Browser test of the instrument-detail workspace (w1): navigation sources, request discipline under rapid switching
// with a slowed fixture, the as-of separation, and the three header actions (Trade, Build strategy, Hedge), including
// the post-fill hedge prompt for a trade placed from the full page.
//
//   npm run test:workspace            (headless; SDT_HEADED=1 to watch)
//
// Starts its own demo server in a sandbox (engine timer on, as a user's Terminal runs), drives Chromium, and stops the
// server by its PID. Fixtures stand in only for the Shaffer services (demo fixture controls, docs/SERVER-CLIENT.md).
import { createSandbox } from '../matrix/lib/sandbox.mjs';
import { startServer } from '../matrix/lib/server.mjs';
import { launchBrowser } from '../matrix/drivers/browser.mjs';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); };

const sandbox = createSandbox('workspace');
const server = await startServer(sandbox, { demo: true, engine: 'on' });
const browser = await launchBrowser({ headed: Boolean(process.env.SDT_HEADED) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const base = server.url;
const api = (path, body) => page.evaluate(async ([u, b]) => { const r = await fetch(u, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return r.json(); }, [`${base}${path}`, body]);
const goto = async (hash) => { await page.goto(`${base}/${hash}`); await page.locator('.shell .topbar').waitFor(); };
const drawerOf = () => page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: /^Trade/ }) });
const closeAll = async () => { for (let i = 0; i < 6 && await page.getByRole('dialog').count(); i++) await page.keyboard.press('Escape'); };

try {
  await goto('#/accounting');
  const find = async (sym) => (await api(`/api/instruments?q=${encodeURIComponent(sym)}`)).items.find((i) => i.symbol === sym);
  const alfa = await find('ALFA'), brvo = await find('BRVO'), gov = await find('SIMGOV31');
  const strategies = (await api('/api/analytics/strategies')).items;

  // ---- 1. navigation sources -----------------------------------------------------------------------------------------
  await goto('#/markets/US_CASH/equities');
  await page.getByPlaceholder(/Filter by symbol/).fill('ALFA');
  await page.locator('main table tbody tr').filter({ has: page.locator('.sym', { hasText: /^ALFA$/ }) }).first().click();
  let dr = drawerOf();
  await dr.waitFor();
  check('Marketplace row opens the drawer with the workspace header', await dr.locator('[data-testid=ws-header]').getAttribute('data-ws-inst') === alfa.id);
  check('drawer keeps its Trade, Overview, Positions and History tabs', (await dr.getByRole('tab').allInnerTexts()).join('|').match(/Trade.*Overview.*Positions.*History and actions/s));
  await dr.getByRole('button', { name: 'Open full page', exact: true }).click();
  await page.locator('.ws-page').waitFor();
  check('Open full page goes to #/instrument/<id>', (await page.evaluate(() => location.hash)).startsWith(`#/instrument/${alfa.id}`));
  check('the drawer closes when the page opens', await page.getByRole('dialog').count() === 0);
  check('the page says where Back returns', /Back to US Based/.test(await page.locator('.ws-back').innerText()));
  await page.goBack();
  await page.locator('main table').first().waitFor();
  check('browser Back returns to the Marketplace tab', (await page.evaluate(() => location.hash)).startsWith('#/markets/US_CASH/equities'));
  // Registry row.
  await goto('#/instruments');
  await page.getByPlaceholder(/Filter by symbol/).first().fill('SIMGOV31');
  await page.locator('main table tbody tr').filter({ hasText: 'SIMGOV31' }).first().click();
  dr = drawerOf(); await dr.waitFor();
  check('registry row opens the same drawer', await dr.locator('[data-testid=ws-header]').getAttribute('data-ws-inst') === gov.id);
  await closeAll();
  // Search on the page switches instrument and keeps the tab.
  await goto(`#/instrument/${alfa.id}/history`);
  await page.locator('[data-ws-dataset=history]').waitFor();
  await page.getByPlaceholder(/Open another instrument/).fill('BRVO');
  await page.locator('.ws-hits a', { hasText: 'BRVO' }).first().click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=ws-header]')?.dataset.wsInst === id, brvo.id);
  check('page search opens the other instrument on the same tab', (await page.evaluate(() => location.hash)) === `#/instrument/${brvo.id}/history`);

  // A position: buy ALFA from the full page's Trade action (ticket in the drawer), so holdings exist for the sources below.
  // ---- 6. trading from the detail page, and the hedge prompt after the fill ------------------------------------------
  await goto(`#/instrument/${alfa.id}`);
  await page.locator('.ws-strat select').selectOption(strategies[0].id);
  await page.getByRole('button', { name: 'Trade', exact: true }).first().click();
  dr = drawerOf(); await dr.waitFor();
  check('Trade on the page opens the ticket on the Trade tab', await dr.getByRole('tab', { name: /^Trade/ }).getAttribute('aria-selected') === 'true');
  check('the ticket carries the Strategy chosen in the header', (await dr.locator('[data-testid=ticket-strategy]').innerText()).includes(strategies[0].id));
  const owner = await dr.locator('.field', { has: page.locator('label', { hasText: /^Trading owner/ }) }).locator('select').evaluate((s) => s.options[s.selectedIndex].text);
  check('the ticket uses the trading owner in use', owner && owner !== 'Choose an owner', owner);
  await dr.locator('.field', { has: page.locator('label', { hasText: /^Shares/ }) }).locator('input').fill('100');
  await dr.getByRole('button', { name: /^Preview buy/ }).click();
  const pv = page.locator('.modal').last();
  await pv.waitFor();
  const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/strategies');
  await pv.getByRole('button', { name: /^Confirm/ }).click();
  const sub = await (await submitted).json();
  check('the paper trade is recorded from the page', Boolean(sub.strategy?.id), JSON.stringify(sub).slice(0, 200));
  check('the order carries the header Strategy', sub.strategy?.investmentStrategy?.id === strategies[0].id || JSON.stringify(sub).includes(strategies[0].id));
  await closeAll();
  const prompt = page.locator('.modal header h2', { hasText: /^Hedge for/ });
  await prompt.waitFor({ timeout: 25_000 }).catch(() => {});
  check('a fill from the detail page opens the hedge workflow', await prompt.count() > 0);
  await closeAll();

  // Accounting position row and Treasury inventory open the same drawer.
  await goto(`#/accounting/positions/${sub.strategy.unit.id}`);
  await page.locator('main a', { hasText: /^ALFA$/ }).first().click();
  dr = drawerOf(); await dr.waitFor();
  check('Accounting position row opens the drawer', await dr.locator('[data-testid=ws-header]').getAttribute('data-ws-inst') === alfa.id);
  check('the header shows the holding long with its Account', /Long 100/.test(await dr.locator('.ws-held').innerText()));
  await closeAll();
  await goto('#/treasury/collateral');
  const tLink = page.locator('main a', { hasText: /^ALFA$/ }).first();
  await tLink.waitFor({ timeout: 8000 }).catch(() => {});
  if (await tLink.count()) { await tLink.click(); dr = drawerOf(); await dr.waitFor(); check('Treasury securities row opens the drawer', await dr.locator('[data-testid=ws-header]').getAttribute('data-ws-inst') === alfa.id); await closeAll(); }
  else check('Treasury securities row opens the drawer', false, 'no ALFA link on #/treasury/collateral');

  // Build strategy and Hedge from the page.
  await goto(`#/instrument/${alfa.id}`);
  await page.getByRole('button', { name: 'Build strategy', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/strategy/for/'));
  const field = page.locator('main .field', { has: page.locator('label', { hasText: /^Investment Strategy/ }) }).first().locator('select');
  await field.waitFor();
  check('Build strategy opens the Strategies page with the instrument and Strategy', (await page.evaluate(() => location.hash)) === `#/strategy/for/${alfa.id}` && await field.inputValue() === strategies[0].id);
  await goto(`#/instrument/${alfa.id}`);
  await page.getByRole('button', { name: 'Hedge', exact: true }).click();
  await page.locator('.modal header h2', { hasText: /^Hedge for/ }).waitFor({ timeout: 10_000 }).catch(() => {});
  check('Hedge opens the hedge request for the position', await page.locator('.modal header h2', { hasText: /^Hedge for/ }).count() > 0);
  await closeAll();

  // ---- 4. request discipline: rapid switching with slowed fixtures ---------------------------------------------------
  await api('/api/demo/fixtures/server', { reset: true });
  for (const d of ['profile', 'reference']) await api('/api/demo/fixtures/server', { dataset: d, mode: 'slow', delayMs: 2500 });
  // The previous instrument's detail answer is slowed too, at the browser.
  await page.route(`**/api/instruments/${alfa.id}/detail*`, async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); });
  await goto(`#/instrument/${alfa.id}/overview`);
  await page.waitForTimeout(300);
  await page.evaluate((id) => { location.hash = `#/instrument/${id}/overview`; }, brvo.id);
  await page.waitForTimeout(250);
  await page.evaluate((id) => { location.hash = `#/instrument/${id}/overview`; }, alfa.id);
  await page.waitForTimeout(250);
  await page.evaluate((id) => { location.hash = `#/instrument/${id}/overview`; }, brvo.id);
  // While BRVO's slowed answers are on their way nothing of ALFA may be drawn under BRVO's header.
  let mixed = [];
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(300);
    mixed = mixed.concat(await page.evaluate((want) => {
      const out = [];
      const h = document.querySelector('[data-testid=ws-header]');
      if (h && h.dataset.wsInst !== want) out.push(`header ${h.dataset.wsInst}`);
      for (const p of document.querySelectorAll('[data-ws-dataset]')) if (p.dataset.wsInst !== want) out.push(`${p.dataset.wsDataset} ${p.dataset.wsInst}`);
      if (/Alfa Industries/.test(document.querySelector('.ws-page')?.innerText || '')) out.push('Alfa text on the page');
      return out;
    }, brvo.id));
  }
  check('rapid switching never shows one instrument\'s data under another\'s header', mixed.length === 0, mixed.slice(0, 5).join('; '));
  const profileText = await page.locator('[data-ws-dataset=profile]').innerText();
  check('the last selection\'s slowed answer is drawn', /Bravo/i.test(profileText), profileText.slice(0, 160));
  const disc = await page.evaluate(() => window.__sdtWs.discards.map((d) => `${d.id}:${d.key}:${d.reason}`));
  check('superseded requests were aborted or discarded', disc.some((d) => d.startsWith(`${alfa.id}:`)), disc.slice(-6).join(' | '));
  await page.unroute(`**/api/instruments/${alfa.id}/detail*`);
  await api('/api/demo/fixtures/server', { reset: true });
  // Loading is drawn per panel while a slowed answer is on its way.
  await api('/api/demo/fixtures/server', { dataset: 'profile', mode: 'slow', delayMs: 2500 });
  await goto(`#/instrument/${alfa.id}/overview`);
  await page.locator('[data-ws-dataset=profile][data-ws-state=loading]').waitFor({ timeout: 2000 }).catch(() => {});
  check('a slow dataset shows its own loading state', await page.locator('[data-ws-dataset=profile][data-ws-state=loading]').count() === 1);
  await api('/api/demo/fixtures/server', { reset: true });

  // ---- 5. as-of: research date apart from the paper-trading clock ----------------------------------------------------
  const asked = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) asked.push(u); });
  await goto(`#/instrument/${alfa.id}/statements`);
  await page.locator('[data-ws-dataset=statements][data-ws-state=available]').waitFor({ timeout: 8000 });
  const headCurrent = await page.locator('[data-testid=ws-header] .ws-q').first().innerText();
  await page.locator('#ws-research-date').fill('2025-06-30');
  await page.waitForFunction(() => location.hash.endsWith('/asof/2025-06-30'));
  await page.locator('[data-ws-dataset=statements]:not([data-ws-state=loading])').waitFor();
  const stmt = await page.locator('[data-ws-dataset=statements]').innerText();
  check('a panel in as-of mode says "as of <date>, as it was known then" or that the contract does not support it', /As of 2025-06-30, as it was known then|not supported by the server contract/.test(stmt), stmt.slice(0, 200));
  const bar = await page.locator('[data-testid=asof-bar]').innerText();
  check('the research date is shown apart from the paper-trading clock', /Research date/.test(bar) && /Paper-trading clock/.test(bar));
  const sReq = asked.filter((u) => u.pathname.startsWith('/api/server/statements/') && u.searchParams.get('asOf') === '2025-06-30');
  const headReq = asked.filter((u) => (u.pathname.endsWith('/detail') || u.pathname.startsWith('/api/server/analytics/') || u.pathname.startsWith('/api/server/reference/')) && u.searchParams.get('asOf'));
  check('research panels ask the server as of the date', sReq.length > 0);
  check('the header\'s execution quote context is never asked as of the date', headReq.length === 0, headReq.map((u) => u.pathname).join(', '));
  const headAsOf = await page.locator('[data-testid=ws-header] .ws-q').first().innerText();
  check('the header quote is the same live quote kind in as-of mode', headAsOf.split('\n')[0] === headCurrent.split('\n')[0] && !/2025-06-30/.test(headAsOf));
  await page.getByRole('tab', { name: /^My positions and trades/ }).click();
  await page.locator('[data-ws-dataset=ledger]').waitFor();
  check('local paper records say a research date does not apply', /Current information: a research date does not apply/.test(await page.locator('[data-ws-dataset=ledger]').innerText()));

  // ---- 3. coverage: a bond lists issuer statements as not covered and links its issuer ------------------------------
  await goto(`#/instrument/${gov.id}`);
  await page.locator('[data-testid=not-covered]').waitFor();
  check('a bond lists earnings and statements under Not covered for this product', /Earnings and financial statements/.test(await page.locator('[data-testid=not-covered]').innerText()));
  check('a bond has no Financial statements tab', await page.getByRole('tab', { name: /^Financial statements/ }).count() === 0);

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
