// Browser checks of the product-specific detail pages (p1, web/views/tabs/product/), run by ../run-browser.mjs
// (npm run test:workspace) on its page and demo server, or alone: node test/workspace/checks/p1-product-pages.mjs
//
// One instrument per family (bond, option, future, fund, FX, swap, credit default swap, and the other products: a
// spot asset and a loan): every tab opens and settles; each product dataset goes through the fixture controls'
// states (available, stale, unavailable, error, forbidden, partial, slow); a research date is honoured or declined
// per dataset; related issuer / underlying links point at the right workspace. Expected values are read from the
// server's own answers (fixtures stand in for the Shaffer server only), never from the screen.

const fmt = (x, dp) => Number(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** ctx: { page, api(path, body?), goto(hash), check(name, ok, detail) } on a demo server. */
export default async function p1ProductPages({ page, api, goto: go, check }) {
  const goto = async (hash) => { await page.goto('about:blank'); await go(hash); };
  const reset = () => api('/api/demo/fixtures/server', { reset: true });
  const mode = (dataset, m, extra = {}) => api('/api/demo/fixtures/server', { dataset, mode: m, ...extra });
  const settled = async (key) => { const l = page.locator(`[data-ws-dataset="${key}"]:not([data-ws-state=loading])`).first(); await l.waitFor({ timeout: 15_000 }); return l; };
  const stateOf = async (key) => (await settled(key)).getAttribute('data-ws-state');
  const text = async (sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');
  await reset();

  // ---- the instruments: demo ones, and one per family registered as a user would ------------------------------------
  const list = (await api('/api/instruments?limit=500')).items;
  const by = (s) => list.find((i) => i.symbol === s);
  const reg = async (d) => by(d.symbol) || api('/api/instruments', d);
  const alfa = by('ALFA'), gov = by('SIMGOV31'), corp = by('SIMCORP29'), fut = by('S5 2026-12') || list.find((i) => i.family === 'future' && i.terms.root === 'S5'), fx = by('EUR/USD');
  const chain = await api(`/api/instruments/${alfa.id}/chain`);
  const exp = chain.chain.expirations[Math.min(2, chain.chain.expirations.length - 1)];
  const strike = chain.chain.strikes[Math.floor(chain.chain.strikes.length / 2)];
  const option = await reg({ productId: 'equity_option', name: `ALFA ${exp} ${strike} call (p1 check)`, symbol: `P1ALFA${exp.replace(/-/g, '')}C${strike}`, marketView: 'US_DERIV', venue: 'SIM Options', venueType: 'exchange', venueCountry: 'US', tradingCcy: 'USD', underlyingId: alfa.id, multiplier: 100, terms: { right: 'C', strike, expiration: exp, exercise: 'american', settlement: 'physical', deliverable: { units: 100 } } });
  const fund = await reg({ productId: 'mutual_fund', name: 'Lakemont Balanced Fund (p1 check)', symbol: 'P1LKBIX', marketView: 'US_CASH', venue: 'Lakemont Funds transfer agent', venueType: 'otc', venueCountry: 'US', issuer: 'Lakemont Funds Trust', domicile: 'US', tradingCcy: 'USD', terms: {} });
  const swap = await reg({ productId: 'interest_rate_swap', name: 'USD IRS 4.00% v TSFR3M (p1 check)', symbol: 'P1IRS', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01, conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
    terms: { effective: '2026-03-05', maturity: '2028-03-06', counterparty: 'Dealer A', collateralBasis: { type: 'position', independentAmount: { type: 'pct', pct: 0.02 }, variationMargin: true, threshold: 50000, minimumTransfer: 10000 },
      legs: [{ side: 'pay', type: 'fixed', ccy: 'USD', rate: 0.04, months: 6, dayCount: '30/360' }, { side: 'receive', type: 'float', ccy: 'USD', index: 'TSFR3M', spread: 0, months: 3, dayCount: 'ACT/360' }] } });
  const cds = await reg({ productId: 'cds_single_name', name: 'Halvorsen Freight 5Y CDS (p1 check)', symbol: 'P1CDS', marketView: 'US_DERIV', venueType: 'otc', venueCountry: 'US', tradingCcy: 'USD', multiplier: 0.01, conventions: { tradingCalendar: 'USD', settlementCalendar: 'USD', paymentCalendar: 'USD' },
    terms: { referenceEntity: 'Halvorsen Freight Lines Inc.', seniority: 'Senior unsecured', coupon: 0.01, effective: '2026-03-20', maturity: '2031-06-20', recovery: 0.4, convention: 'standard', creditEventSet: 'corporate_xr', settlement: 'auction', counterparty: 'Dealer K', collateralBasis: { type: 'uncollateralized' } } });
  const spot = await reg({ productId: 'physical_commodity', name: 'Uranium concentrate (p1 check)', symbol: 'P1U3O8', marketView: 'US_CASH', venue: 'Northline (OTC broker)', venueType: 'otc', venueCountry: 'US', issuer: 'Northline Nuclear Fuels Inc.', tradingCcy: 'USD', multiplier: 2.2046226, terms: { quantityUnit: 'kilograms U3O8', priceUnits: 'USD per pound U3O8' } });
  const loan = await api('/api/instruments', { productId: 'unsecured_loan', name: 'Term loan from Bank X (p1 check)', marketView: 'US_CASH', venueType: 'otc', tradingCcy: 'USD', terms: { rateType: 'fixed', rate: 0.05, dayCount: 'ACT/360', maturity: '2027-10-14' } });
  check('p1: one instrument per family registered', [option, fund, swap, cds, spot, loan].every((i) => i && i.id), JSON.stringify([option, fund, swap, cds, spot, loan].map((i) => i?.id || i?.error)));

  // ---- every tab of every family opens and settles ------------------------------------------------------------------
  const families = [
    ['bond', gov, ['Overview and terms', 'Schedules', 'Ratings and covenants']], ['option', option, ['Contract terms', 'Chain', 'Greeks and volatility']],
    ['future', fut, ['Contract terms and margin', 'Curve and contract months']], ['fund', fund, ['Overview, NAV and fees', 'Holdings', 'NAV history', 'Distributions']],
    ['fx', fx, ['Overview and conventions', 'Rates and curves']], ['swap', swap, ['Legs and terms', 'Schedules', 'Marks and history']],
    ['cds', cds, ['Protection terms', 'Schedules', 'Marks and history']], ['spot', spot, ['Terms and records']], ['loan', loan, ['Terms and records']],
  ];
  for (const [fam, inst, want] of families) {
    await goto(`#/instrument/${inst.id}`);
    await page.locator('.ws-tabs').waitFor({ timeout: 15_000 });
    const tabs = (await page.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\s*(awaiting|error)$/, '').trim());
    check(`p1 ${fam}: product tabs present`, want.every((w) => tabs.includes(w)), tabs.join(' | '));
    const bad = [];
    for (const label of tabs) {
      await page.getByRole('tab', { name: label, exact: false }).first().click();
      await page.waitForTimeout(150);
      const stuck = await page.waitForFunction(() => !document.querySelector('[data-ws-tab] [data-ws-state=loading]'), null, { timeout: 15_000 }).then(() => null, () => page.evaluate(() => [...document.querySelectorAll('[data-ws-tab] [data-ws-state=loading]')].map((p) => p.dataset.wsDataset).join(', ')));
      if (stuck) bad.push(`${label}: ${stuck} stays loading`);
      const body = await page.locator('[data-ws-tab]').innerText();
      if (!body.trim()) bad.push(`${label}: empty`);
      if (/could not be loaded/.test(body) && !/KAIJ/.test(inst.symbol || '')) bad.push(`${label}: an error panel`);
    }
    check(`p1 ${fam}: every tab opens and settles with content`, bad.length === 0, bad.join('; '));
    check(`p1 ${fam}: "Not covered for this product" is explained`, await page.locator('[data-testid=not-covered] dd').count() > 0);
  }

  // ---- each envelope state through the fixture controls -------------------------------------------------------------
  const STATES = [['stale', 'stale'], ['unavailable', 'unavailable'], ['empty', 'unavailable'], ['error', 'error'], ['forbidden', 'error'], ['partial', 'incomplete']];
  const datasets = [
    ['ratingsCovenants', corp, 'bond-credit'], ['yieldSpread', corp, 'bond-terms'], ['optionGreeks', option, 'opt-greeks'], ['futuresCurve', fut, 'fut-curve'], ['exchangeMargin', fut, 'fut-terms'],
    ['fundHoldings', fund, 'fund-holdings'], ['fundFacts', fund, 'fund-overview'], ['otcMarks', swap, 'otc-marks'], ['fxCurve', fx, 'fx-rates'],
  ];
  for (const [ds, inst, tab] of datasets) {
    const seen = {};
    await reset();
    await goto(`#/instrument/${inst.id}/${tab}`);
    seen.builtIn = await stateOf(ds);
    for (const [m] of STATES) {
      await mode(ds, m);
      await goto(`#/instrument/${inst.id}/${tab}`);
      seen[m] = await stateOf(ds);
      if (m === 'forbidden') seen.forbiddenText = /refused access/.test(await text(`[data-ws-dataset="${ds}"]`));
    }
    await mode(ds, 'slow', { delayMs: 2500 });
    await goto(`#/instrument/${inst.id}/${tab}`);
    seen.slow = await page.locator(`[data-ws-dataset="${ds}"][data-ws-state=loading]`).first().waitFor({ timeout: 2000 }).then(() => 'loading', () => 'not seen');
    seen.slowThen = await stateOf(ds);
    await reset();
    const okBuilt = ds === 'fundFacts' ? ['available', 'incomplete'].includes(seen.builtIn) : seen.builtIn === 'available';
    check(`p1 states ${ds}: built-in ${seen.builtIn}, stale, unavailable, empty, error, forbidden (not retried), partial, slow`,
      okBuilt && STATES.every(([m, s]) => seen[m] === s) && seen.forbiddenText && seen.slow === 'loading' && ['available', 'incomplete'].includes(seen.slowThen), JSON.stringify(seen));
  }

  // ---- research date: honoured where the contract supports it, declined (nothing substituted) where not ------------
  const asOf = '2026-09-01';
  await goto(`#/instrument/${corp.id}/bond-credit/asof/${asOf}`);
  await settled('ratingsCovenants');
  check('p1 as of: ratings are shown as known then', /As of 2026-09-01, as it was known then/.test(await text('[data-ws-dataset=ratingsCovenants]')));
  await goto(`#/instrument/${corp.id}/bond-terms/asof/${asOf}`);
  await settled('yieldSpread');
  const ysText = await text('[data-ws-dataset=yieldSpread]');
  check('p1 as of: yield and spread say the contract does not support it, nothing in its place', /not supported by the server contract/.test(ysText) && await stateOf('yieldSpread') === 'unavailable', ysText.slice(0, 200));
  await settled('contractFacts');
  check('p1 as of: the Terminal\'s own contract facts say a research date does not apply', /a research date does not apply/.test(await text('[data-ws-dataset=contractFacts]')));
  const marksDay = new Date(Date.parse(`${(await api('/api/status')).today}T00:00:00Z`) - 3 * 86400e3).toISOString().slice(0, 10);
  await goto(`#/instrument/${swap.id}/otc-marks/asof/${marksDay}`);
  await settled('otcMarks');
  const marksPit = await api(`/api/server/marks/${swap.id}?asOf=${marksDay}`);
  check('p1 as of: supplied marks are those struck on or before the date', new RegExp(`As of ${marksDay}, as it was known then`).test(await text('[data-ws-dataset=otcMarks]')) && marksPit.items.every((m) => m.date <= marksDay)
    && await page.locator('[data-ws-dataset=otcMarks] tbody tr').count() === marksPit.items.length, `${marksPit.items.length} marks`);

  // ---- family-specific content, against the server's own answers ----------------------------------------------------
  const book = (await api('/api/books')).items[0];
  // Bond: the paper engine's accrued interest, labelled; ratings as supplied; the issuer link or its absence.
  const facts = await api(`/api/instruments/${corp.id}/contract-facts?bookId=${book.id}`);
  await goto(`#/instrument/${corp.id}/bond-terms`);
  await settled('contractFacts');
  check('p1 bond: accrued interest is the paper engine\'s figure, labelled as such', (await text('[data-testid=bond-accrued]')) === fmt(facts.accrued.per100, 6) && /paper engine/.test(await text('[data-ws-dataset=contractFacts]')), `${await text('[data-testid=bond-accrued]')} vs ${facts.accrued.per100}`);
  const ys = await api(`/api/server/yield-spread/${corp.id}`);
  check('p1 bond: yield and spread as supplied, with the price they were struck on', (await text('[data-testid=bond-yield]')).includes(`${fmt(ys.data.yield.value, 3)}%`) && (await text('[data-testid=bond-yield]')).includes(`${ys.data.spread.valueBps} bp`));
  check('p1 bond: the issuer financials link says no equity of the issuer is registered', /No equity of Sim Corp is registered/.test(await text('.ws-page')));
  await page.getByRole('tab', { name: 'Schedules' }).click();
  await page.locator('[data-testid=bond-schedule] [data-ws-dataset=contractFacts][data-ws-state=available] tbody tr').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const rows = await page.locator('[data-testid=bond-schedule] [data-ws-dataset=contractFacts]').first().locator('tbody tr').count();
  check('p1 bond: coupons and redemption from the contract', rows === facts.coupons.rows.length + 1, `${rows} rows vs ${facts.coupons.rows.length} coupons + redemption`);
  // Option: underlying link to its own statements, chain with this contract marked, Greeks as supplied.
  await goto(`#/instrument/${option.id}/opt-terms`);
  await page.locator('[data-testid=opt-terms]').waitFor();
  check('p1 option: Issuer financials link to the underlying\'s own statements, not the option\'s', await page.locator(`a[href="#/instrument/${alfa.id}/statements"]`).count() >= 1 && /not this contract's/.test(await text('.ws-page')));
  await page.getByRole('tab', { name: 'Chain' }).click();
  await page.locator('[data-testid=opt-chain] tr[data-mine]').first().waitFor({ timeout: 10_000 }).catch(() => {});
  check('p1 option: the chain marks this contract', await page.locator('[data-testid=opt-chain] tr[data-mine]').count() === 1);
  const g = await api(`/api/server/option-greeks/${option.id}`);
  await page.getByRole('tab', { name: 'Greeks and volatility' }).click();
  await settled('optionGreeks');
  check('p1 option: implied volatility as supplied, with provider and time', (await text('[data-testid=opt-iv]')) === `${fmt(g.data.impliedVol * 100, 2)}%` && /Supplied by Shaffer MarketData \(demo fixture\), calculated/.test(await text('[data-ws-dataset=optionGreeks]')));
  // Future: the Book's clearing terms apart from the exchange's margin; the curve marks this month.
  await goto(`#/instrument/${fut.id}/fut-terms`);
  await settled('exchangeMargin');
  check('p1 future: the Book\'s registered margin and the exchange margin are shown apart', (await text('[data-testid=fut-book-margin]')).includes(fmt(fut.terms.initialMargin, 2)) && (await text('[data-testid=fut-exch-initial]')).includes('12,650.00'));
  await page.getByRole('tab', { name: 'Curve and contract months' }).click();
  await settled('futuresCurve');
  const curve = await api(`/api/server/futures-curve/${fut.id}`);
  check('p1 future: one row per month supplied, this contract marked', await page.locator('[data-ws-dataset=futuresCurve] tbody tr').count() === curve.items.length && /this contract/.test(await text('[data-ws-dataset=futuresCurve]')));
  // Fund: holdings and weights as listed, the listed share worked out from the weights shown.
  const hold = await api(`/api/server/fund-holdings/${fund.id}`);
  await goto(`#/instrument/${fund.id}/fund-holdings`);
  await settled('fundHoldings');
  const sum = hold.items.reduce((a, h) => a + h.weightPct, 0); // 6.8 + 6.1 + 5.2 + 4.9 + 4.6 + 4.1 + 3.9 + 3.7 + 3.6 + 3.4 = 46.3
  check('p1 fund: holdings listed with weights and the listed share', await page.locator('[data-ws-dataset=fundHoldings] tbody tr').count() === hold.items.length && (await text('[data-ws-dataset=fundHoldings]')).includes(`add up to ${fmt(sum, 1)}%`));
  check('p1 fund: a holding registered in the Terminal links to its own workspace', await page.locator(`[data-ws-dataset=fundHoldings] a[href="#/instrument/${alfa.id}"]`).count() === 1);
  // FX: the value date of a trade today, and forward points as supplied.
  const det = await api(`/api/instruments/${fx.id}/detail?bookId=${book.id}`);
  await goto(`#/instrument/${fx.id}/fx-overview`);
  await page.locator('[data-testid=fx-terms]').waitFor();
  check('p1 fx: both calendars and the value date of a trade today', /TARGET \(payment calendar of EUR\)/.test(await text('[data-testid=fx-terms]')) && (await text('[data-testid=fx-terms]')).includes(det.settlement.date));
  await page.getByRole('tab', { name: 'Rates and curves' }).click();
  await settled('fxCurve');
  check('p1 fx: forward points as supplied, the outright left missing', /9\.20/.test(await text('[data-ws-dataset=fxCurve]')) && /does not add points to spot/.test(await text('[data-ws-dataset=fxCurve]')));
  // Swap: legs pay and receive, the next payment from the contract, supplied marks with their kinds.
  await goto(`#/instrument/${swap.id}/swap-terms`);
  await page.locator('[data-testid=swap-terms]').waitFor();
  const legsText = await text('[data-testid=swap-terms] .p1-legs');
  check('p1 swap: each leg with its pay or receive side and terms', /Pay Fixed 4\.000%/.test(legsText) && /Receive Floating TSFR3M/.test(legsText), legsText.slice(0, 200));
  const sf = await api(`/api/instruments/${swap.id}/contract-facts?bookId=${book.id}`);
  await page.getByRole('tab', { name: 'Schedules' }).click();
  await settled('contractFacts');
  const schedText = await text('[data-ws-dataset=contractFacts]');
  check('p1 swap: the next payment of each leg from the contract', sf.legs.every((l) => l.next && schedText.includes(`Next payment ${l.next.payDate}`)), schedText.slice(0, 300));
  await page.getByRole('tab', { name: 'Marks and history' }).click();
  await settled('otcMarks');
  const mt = await text('[data-ws-dataset=otcMarks]');
  check('p1 swap: supplied marks with dealer, clearing and model kinds and providers', /dealer/.test(mt) && /clearing/.test(mt) && /model/.test(mt) && /Shaffer Analytics Lab \(demo fixture\)/.test(mt));
  check('p1 swap: the mark in use and the marks entered by hand are the Terminal\'s own', await page.locator('[data-testid=mark-in-use]').count() === 1 && await page.locator('[data-testid=manual-marks]').count() === 1);
  // Other products: a loan has terms and Book records, and no market price panel.
  await goto(`#/instrument/${loan.id}/other-terms`);
  await page.locator('[data-testid=other-terms]').waitFor();
  check('p1 loan: terms and the Book\'s records, no market price of its own', /5\.000% fixed/.test(await text('[data-testid=other-terms]')) && await page.locator('[data-testid=mark-in-use]').count() === 0 && /Treasury, Borrowings and lending/.test(await text('[data-testid=other-terms]')));
  await reset();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { createSandbox } = await import('../../matrix/lib/sandbox.mjs');
  const { startServer } = await import('../../matrix/lib/server.mjs');
  const { launchBrowser } = await import('../../matrix/drivers/browser.mjs');
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); };
  const sandbox = createSandbox('p1-product-pages');
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
    await p1ProductPages({ page, api, goto, check });
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
