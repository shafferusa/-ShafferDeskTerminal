// Hedge workflow screens.
//
// Shaffer Hedge runs in Analytics Lab. It selects hedge structures and sizes their legs. The
// Terminal's part, shown here, is to display what was requested, the packages that came back
// (or the waiting state while Analytics Lab is not connected), the quotes and indicative terms
// available for each leg, and to run confirmed paper execution through the normal package
// engine. Nothing in this file chooses or sizes a hedge.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, toast, toastError, useLive } from '../lib/core.js';
import { Awaiting, Button, Checks, Empty, ErrorNote, Field, KV, Missing, Modal, Money, Notice, Num, Pill, Prov, Select, Text } from '../lib/ui.js';
import { expectedOf, PreviewModal } from './preview.js';

export const OBJECTIVES = [
  { value: 'downside_protection', label: 'Downside protection' }, { value: 'upside_protection_short', label: 'Upside protection for shorts' },
  { value: 'market_sector_reduction', label: 'Market / sector exposure reduction' }, { value: 'currency_protection', label: 'Currency protection' },
  { value: 'rate_protection', label: 'Rate protection' }, { value: 'credit_protection', label: 'Credit protection' },
  { value: 'volatility_protection', label: 'Volatility protection' }, { value: 'server_defined', label: 'Other (defined by the Strategy on the server)' },
];
export const SCOPES = [{ value: 'trade', label: 'This trade' }, { value: 'strategy_package', label: 'Strategy package' }, { value: 'account', label: 'Account' }, { value: 'book', label: 'Book' }];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.value, s.label]));
const TRIGGER = { post_trade: 'Requested automatically after your fill', strategy_page: 'Requested from the Strategy page', review: 'Requested because the hedged exposure changed', manual: 'Requested by hand' };
const notSupplied = html`<${Missing} reason="Not supplied by Shaffer Hedge" />`;
const val = (x, unit) => (isNum(x) ? `${fmtNum(x, Math.abs(x) >= 100 ? 0 : 2, { sign: false })}${unit ? ` ${unit}` : ''}` : x ? String(x) : notSupplied);

/** What the Terminal sent: the facts a hedge request must carry. */
export function RequestSummary({ r }) {
  const q = r.request;
  const p = q.primary;
  const proposed = (q.proposedLegs || []).filter((l) => l.isProtection).length;
  return html`<${KV} rows=${[
    ['Instrument', p?.instrument ? `${p.instrument.symbol || p.instrument.name}${p.instrument.symbol ? `, ${p.instrument.name}` : ''}` : html`<${Missing} reason="No single instrument for this scope" />`],
    p ? ['Direction and amount', `${p.direction === 'short' ? 'Short' : 'Long'} ${isNum(p.quantity) ? fmtQty(p.quantity) : ''}${isNum(p.notional) ? ` (${fmtMoney(p.notional, p.currency)} notional)` : ''}${p.status === 'filled' ? `, filled at ${fmtPrice(p.averagePrice)}` : ', proposed'}`] : null,
    ['Book and Account', `${q.book.name} / ${q.account ? (q.account.kind === 'treasury' ? 'Treasury' : q.account.name) : 'whole Book'}`],
    ['Hedge scope', SCOPE_LABEL[q.scope.type] || q.scope.type],
    ['Investment Strategy', q.investmentStrategy?.name || html`<${Missing} reason="Not set" />`],
    ['Intended holding period', q.holdingPeriod?.days ? `${q.holdingPeriod.days} days` : q.holdingPeriod?.until || q.holdingPeriod?.label || html`<${Missing} reason="Not set" />`],
    ['Hedge objective', q.objective?.label || html`<${Missing} reason="Not set" />`],
    ['Protection already held', q.existingHedges.length ? q.existingHedges.map((h) => `${fmtQty(h.quantity)} ${h.instrument.symbol || h.instrument.name}`).join(', ') : 'None'],
    proposed ? ['Protection in the template', `${proposed} leg${proposed > 1 ? 's' : ''}, sent as proposed protection`] : null,
    ['Exposures sent', `${q.exposures.positions.length} open position${q.exposures.positions.length === 1 ? '' : 's'} in the ${q.exposures.scope === 'book' ? 'Book' : 'Account'} (facts only; sensitivities are computed by Analytics Lab)`],
    ['Request', `${r.id}, ${fmtTime(r.createdAt)}`],
  ]} />`;
}

/** The waiting or error state of a request that has no packages. */
export function RequestState({ r }) {
  if (r.status === 'error') return html`<${Notice} tone="err">Shaffer Hedge did not answer: ${r.message}<//>`;
  if (r.status === 'received' && !r.response?.packages?.length) return html`<${Notice}>${r.message || 'Shaffer Hedge returned no packages for this request.'}<//>`;
  if (r.status === 'awaiting') {
    return html`<${Awaiting} what="The hedge request was built and stored. Shaffer Hedge returns its recommended package and alternatives here once Analytics Lab is connected. The Terminal does not choose or size hedges itself.">
      ${r.missing?.length ? html`<div class="why">Still needed for a complete request: ${r.missing.join(', ')}.</div>` : null}<//>`;
  }
  return null;
}

/** Packages returned by Shaffer Hedge, recommended first. */
export function PackageList({ response, selected, onSelect, allowNone }) {
  const list = [...response.packages].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  const item = (id, title, sub, pills) => html`<button type="button" key=${id} onClick=${() => onSelect(id)} aria-pressed=${selected === id}
    style=${`display:block;width:100%;text-align:left;padding:8px 10px;border:1px solid ${selected === id ? 'var(--pen)' : 'var(--rule-strong)'};border-left-width:${selected === id ? 4 : 1}px;border-radius:4px;background:var(--sheet);color:var(--ink);cursor:pointer;font:inherit`}>
    <div class="row" style="gap:6px"><b>${title}</b>${pills}</div>${sub ? html`<div class="sub muted small" style="white-space:normal">${sub}</div>` : null}</button>`;
  return html`<div class="stack" style="gap:6px">
    ${allowNone ? item('', 'No hedge with this package', 'The primary trade goes ahead on its own.') : null}
    ${list.map((p) => item(p.id, p.label, p.intendedProtection || (p.riskAddressed || []).join(', '),
      html`${p.recommended ? html`<${Pill} tone="ok">recommended<//>` : html`<${Pill}>alternative<//>`}${response.fixture ? html`<${Pill} tone="warn" title="Canned demo data, not Shaffer Hedge output">demo fixture<//>` : null}`))}
  </div>`;
}

function LegLine({ leg }) {
  const p = leg.price;
  const fee = leg.feeTotal || 0;
  return html`<tr>
    <td><span class="leg-n">${leg.n}</span>${leg.dependsOn?.length ? html`<div class="dep">after ${leg.dependsOn.join(', ')}</div>` : null}</td>
    <td class="wrap"><div class="strong">${leg.label}</div>
      <div class="sub">${leg.purpose === 'financing' ? 'Financing' : leg.hedgeFamily || leg.kindLabel}${leg.riskAddressed ? `, addresses ${String(leg.riskAddressed).toLowerCase()}` : ''}</div>
      ${leg.sizingBasis || isNum(leg.hedgeRatio) ? html`<div class="sub">Sized by ${leg.sizingBasis || 'the ratio supplied'}${isNum(leg.hedgeRatio) ? `, ratio ${leg.hedgeRatio}` : ''}</div>` : null}
      ${leg.instrument?.details?.length ? html`<details open=${Boolean(leg.instrument.draft) && leg.instrument.family !== 'option'}><summary class="note">Contract terms</summary><dl class="terms">${leg.instrument.details.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl></details>` : null}</td>
    <td class="r">${fmtQty(leg.qty)}<div class="sub">${leg.qtyLabel}</div></td>
    <td class="wrap" style="min-width:190px">
      ${leg.kind === 'trade' ? html`<div>${isNum(p?.estimate) ? html`<span class="price"><span class="v">${fmtPrice(p.estimate)}</span></span>` : html`<span class="missing" title=${p?.reason || ''}>no executable quote</span>`}${p?.observation ? html` <${Prov} obs=${p.observation} />` : null}</div>
        <div class="sub">${p?.label || ''}</div>
        ${leg.indicative ? html`<div class="sub">Indicative terms ${fmtPrice(leg.indicative.value)} (${leg.indicative.status}, ${leg.indicative.source}). Not an executable quote.</div>` : null}` : html`<span class="muted">${leg.kindLabel}</span>`}</td>
    <td class="r nowrap">${isNum(leg.cash) ? html`<${Money} value=${leg.cash} ccy=${leg.currency} signed />` : leg.kind === 'trade' && !leg.initialMargin ? html`<${Missing} reason="Needs a price" />` : ''}</td>
    <td class="r nowrap">${fee ? fmtMoney(-fee, leg.currency, { sign: true }) : ''}</td>
    <td class="r nowrap">${leg.initialMargin ? fmtMoney(leg.initialMargin, leg.currency) : ''}</td>
    <td class="r nowrap">${isNum(leg.notional) ? fmtMoney(leg.notional, leg.currency) : ''}</td>
  </tr>`;
}

/**
 * Cost and cash requirement of the package. Every figure is taken from the legs as the Terminal
 * priced them in ONE snapshot, so the lines add up to the total and match what would be confirmed.
 */
function CostTable({ pv }) {
  const rows = Object.values(pv.totals.cash || {});
  if (!rows.length) return html`<p class="note">No cash moves at trade for this package.</p>`;
  const optionLegs = pv.legs.filter((l) => l.kind === 'trade' && ['option', 'otcoption'].includes(l.instrument?.family) && isNum(l.cash));
  const premPaid = (ccy) => optionLegs.filter((l) => l.currency === ccy && l.cash < 0).reduce((a, l) => a - l.cash, 0);
  const premRecv = (ccy) => optionLegs.filter((l) => l.currency === ccy && l.cash > 0).reduce((a, l) => a + l.cash, 0);
  const line = (label, f, opts = {}) => (rows.some((r) => Math.abs(f(r)) > 0.004) || opts.always ? html`<tr class=${opts.strong ? 'strong' : ''}><td>${label}</td>${rows.map((r) => html`<td class="r">${Math.abs(f(r)) > 0.004 || opts.always ? fmtMoney(f(r), r.ccy) : ''}</td>`)}</tr>` : null);
  return html`<table class="ledger"><thead><tr><th>From the legs below, one snapshot</th>${rows.map((r) => html`<th class="r">${r.ccy}</th>`)}</tr></thead><tbody>
    ${line('Option premiums paid', (r) => premPaid(r.ccy))}
    ${line('Other purchases', (r) => r.purchases - premPaid(r.ccy))}
    ${line('Fees and commissions', (r) => r.fees)}
    ${line('Margin and collateral to post', (r) => r.margin + r.collateral)}
    ${line('Cash reserved against written options', (r) => r.reserved)}
    ${line('Cash required', (r) => r.required, { always: true, strong: true })}
    ${line('Option premiums received', (r) => premRecv(r.ccy))}
    ${line('Other sale proceeds', (r) => r.proceeds - premRecv(r.ccy))}
    ${line('Available to trade now', (r) => r.available, { always: true })}
    <tr><td>Shortfall</td>${rows.map((r) => html`<td class=${`r ${r.shortfall > 0 ? 'loss strong' : ''}`}>${r.shortfall > 0 ? fmtMoney(r.shortfall, r.ccy) : 'none'}</td>`)}</tr>
  </tbody></table>`;
}

/** One package: what Shaffer Hedge said about it, and what the Terminal found when it priced and validated the legs. */
export function PackageDetail({ pkg, pv, loading, error, onRefresh, onAcknowledge }) {
  const c = pkg.costs;
  // The estimate that came with the recommendation is kept apart from the Terminal's own figures.
  const est = c ? [['premiums', c.premiums], ['upfront cash', c.upfrontCash], ['expected ongoing cost', c.expectedOngoing], ['margin', c.margin], ['collateral', c.collateral], ['borrowing', c.borrowing], ['funding', c.funding]].filter(([, v]) => isNum(v) && v !== 0) : [];
  const prot = pv?.protection;
  return html`<div class="stack">
    <${KV} rows=${[
      ['Risk addressed', pkg.riskAddressed?.length ? pkg.riskAddressed.join(', ') : notSupplied],
      ['Intended protection', pkg.intendedProtection || notSupplied],
      ['Horizon', pkg.horizon?.until ? `Until ${pkg.horizon.until}` : pkg.horizon?.days ? `${pkg.horizon.days} days` : notSupplied],
      ['Upside surrendered', pkg.upsideSurrendered || notSupplied],
      ['Valuation and availability', pkg.valuation ? `${pkg.valuation.source}${pkg.valuation.status ? ` (${pkg.valuation.status})` : ''}${pkg.valuation.asOf ? `, ${fmtTime(pkg.valuation.asOf)}` : ''}${pkg.valuation.availability ? `. ${pkg.valuation.availability}` : ''}` : notSupplied],
    ]} />
    ${pkg.exposure?.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Exposure measure</th><th class="r">Before</th><th class="r">After</th><th class="r">Residual</th><th>Basis risk</th></tr></thead><tbody>
      ${pkg.exposure.map((e) => html`<tr><td>${e.measure}</td><td class="r">${val(e.before, e.unit)}</td><td class="r">${val(e.after, e.unit)}</td><td class="r">${val(e.residual, e.unit)}</td><td class="wrap">${e.basisRisk || notSupplied}</td></tr>`)}
    </tbody></table></div>` : null}
    ${pkg.scenarios?.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Scenario</th><th class="r">Unhedged</th><th class="r">Hedged</th></tr></thead><tbody>
      ${pkg.scenarios.map((s) => html`<tr><td>${s.label}</td><td class="r">${val(s.unhedged, s.unit)}</td><td class="r">${val(s.hedged, s.unit)}</td></tr>`)}</tbody></table></div>` : null}
    ${(pkg.notes || []).map((n) => html`<div class="note">${n}</div>`)}
    <div class="row"><h4>Legs, priced and checked by the Terminal</h4><span class="grow"></span>
      ${pv ? html`<span class="note">One snapshot, priced at ${fmtTime(pv.generatedAt, { date: false, seconds: true })}</span>` : null}
      ${onRefresh ? html`<${Button} small busy=${loading} onClick=${onRefresh}>Refresh prices<//>` : null}</div>
    <${ErrorNote} error=${error} />
    ${!pv ? (error ? null : html`<${Empty}>${loading ? 'Pricing the legs…' : ''}<//>`) : html`
      <div class="tablewrap"><table class="ledger legs margin"><thead><tr><th></th><th>Leg</th><th class="r">Quantity</th><th>Quote or indicative terms</th><th class="r">Premium or price paid</th><th class="r">Fees</th><th class="r">Collateral</th><th class="r">Notional</th></tr></thead>
        <tbody>${pv.legs.map((l) => html`<${LegLine} key=${l.n} leg=${l} />`)}</tbody></table></div>
      <${CostTable} pv=${pv} />
      ${est.length ? html`<div class="note">Estimate that came with the recommendation${c.basis ? ` (${c.basis})` : ''}: ${est.map(([k, v]) => `${k} ${fmtMoney(v, c.currency)}`).join(', ')}. It was made when the package was proposed and is for comparison only: the figures above are the ones a confirmation would use.</div>` : null}
      ${prot?.needsAcknowledgement && !prot.acknowledged && onAcknowledge ? html`<${Notice} tone="warn"><b>Protection is already in place.</b> ${prot.prior.map((x) => x.label).join('; ')}. ${prot.explain}
        <div style="margin-top:6px"><${Button} small onClick=${onAcknowledge}>Add this protection deliberately<//></div><//>` : null}
      <${Checks} checks=${pv.checks.filter((k) => !(k.code === 'extra-protection' && k.level === 'error' && onAcknowledge))} />`}
  </div>`;
}

/** Load the Terminal's priced, validated view of one proposed package. `reload` prices it again; `set` replaces it. */
export function usePackagePreview(requestId, packageId) {
  const [box, setBox] = useState({ pv: null, error: null, loading: false });
  const [extra, setExtra] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => { setExtra(false); }, [requestId, packageId]);
  useEffect(() => {
    if (!requestId || !packageId) { setBox({ pv: null, error: null, loading: false }); return undefined; }
    let live = true;
    setBox((b) => ({ pv: n ? b.pv : null, error: null, loading: true }));
    post(`/api/hedge/requests/${requestId}/preview`, { packageId, extraProtection: extra || undefined }).then(
      (pv) => { if (live) setBox({ pv, error: null, loading: false }); },
      (error) => { if (live) setBox({ pv: null, error, loading: false }); });
    return () => { live = false; };
  }, [requestId, packageId, extra, n]);
  return { ...box, reload: () => setN((x) => x + 1), acknowledge: () => setExtra(true), set: (pv) => setBox({ pv, error: null, loading: false }) };
}

/**
 * The Hedge popup. Opens after a direct Marketplace fill (Workflow 2), and from a strategy when a
 * hedge is requested or needs review. While Analytics Lab is away it shows the waiting state and
 * the request stays in the review queue. Dismissing it leaves the primary position unchanged.
 */
export function HedgePopup({ request, onClose, onDone }) {
  const [r, setR] = useState(request);
  const q = r.request;
  const packages = r.response?.packages || [];
  const [sel, setSel] = useState(r.response?.recommendedId || packages[0]?.id || '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [ctx, setCtx] = useState({ strategy: q.investmentStrategy?.name || '', days: q.holdingPeriod?.days ?? null, objective: q.objective?.type || '', scope: q.scope.type });
  const pkg = packages.find((p) => p.id === sel) || null;
  const box = usePackagePreview(r.id, pkg?.id);
  const acted = ['executed', 'dismissed', 'superseded'].includes(r.status);
  const ctxChanged = ctx.strategy !== (q.investmentStrategy?.name || '') || (ctx.days ?? null) !== (q.holdingPeriod?.days ?? null) || ctx.objective !== (q.objective?.type || '') || ctx.scope !== q.scope.type;

  const again = async () => {
    setBusy('again'); setError(null);
    try {
      const next = await post('/api/hedge/requests', {
        bookId: r.bookId, unitId: r.unitId, strategyId: r.strategyId || undefined, scope: { type: ctx.scope }, trigger: r.trigger === 'post_trade' ? 'post_trade' : 'manual',
        instrumentId: q.primary?.instrument?.terminalId, direction: q.primary?.direction, quantity: q.primary?.quantity,
        investmentStrategy: ctx.strategy ? { name: ctx.strategy } : null, holdingPeriod: ctx.days ? { days: ctx.days } : null, objective: ctx.objective ? { type: ctx.objective } : null,
      });
      if (next.trigger === 'post_trade') await post(`/api/hedge/requests/${next.id}/seen`);
      setR(next);
      setSel(next.response?.recommendedId || next.response?.packages?.[0]?.id || '');
      bump();
    } catch (err) { setError(err); }
    setBusy('');
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try { if (!acted) await post(`/api/hedge/requests/${r.id}/dismiss`); bump(); onClose(); } catch (err) { setError(err); setBusy(''); }
  };
  const done = (s) => { bump(); onDone?.(s); onClose(); };
  const inspect = (pv, banner) => openOverlay((close) => html`<${PreviewModal} preview=${pv} onClose=${close} onDone=${done} confirmLabel="Confirm hedge" banner=${banner} />`);
  // Execute now submits the package exactly as it is displayed: the same legs, under the same
  // confirmation token, together with the cash requirement on screen. The server validates quotes,
  // exposure, funding and collateral again; if anything blocks, or prices have moved away from what
  // is displayed, nothing is submitted and the updated figures are shown instead.
  const execute = async () => {
    const pv = box.pv;
    if (busy || !pv) return;
    const review = pv.checks.filter((k) => k.level !== 'info');
    if (review.length) { inspect(pv, html`<${Notice} tone="warn">${review.length} item${review.length > 1 ? 's need' : ' needs'} a decision before this hedge can be submitted. Deal with ${review.length > 1 ? 'them' : 'it'} here, then confirm.<//>`); return; }
    setBusy('execute'); setError(null);
    try {
      const out = await post('/api/strategies', { ...pv.input, legs: pv.legs, clientToken: pv.token, confirm: true, expected: expectedOf(pv) });
      const working = out.strategy.orders.filter((o) => ['pending', 'working', 'partial'].includes(o.status) && o.submission === pv.token).length;
      toast(working ? `Hedge submitted. ${working} leg${working > 1 ? 's are' : ' is'} working.` : 'Hedge executed and linked to the position.', working ? 'warn' : 'ok', 6000);
      done(out.strategy);
      return;
    } catch (err) {
      if (err.details?.preview) box.set(err.details.preview);
      setError(err);
    }
    setBusy('');
  };

  const title = q.primary?.instrument ? `Hedge for ${q.primary.direction === 'short' ? 'short' : 'long'} ${q.primary.instrument.symbol || q.primary.instrument.name}` : `Hedge for ${q.account?.name || q.book.name}`;
  return html`<${Modal} size="wide" title=${title} sub=${`${TRIGGER[r.trigger] || ''}${r.response ? `, ${r.response.source}${r.response.asOf ? `, ${fmtTime(r.response.asOf)}` : ''}` : ''}`} onClose=${onClose}
    footer=${html`<span class="note">${packages.length ? 'Closing this leaves the primary position exactly as it is.' : 'The request stays on the position and in the hedge review queue.'}</span><span class="grow"></span>
      ${acted || !packages.length ? html`<${Button} onClick=${onClose}>Close<//>` : html`<${Button} busy=${busy === 'dismiss'} onClick=${dismiss}>Dismiss, no hedge<//>`}
      ${!acted && !packages.length ? html`<${Button} busy=${busy === 'dismiss'} onClick=${dismiss} title="Remove this request from the review queue">Withdraw the request<//>` : null}
      ${pkg && !acted ? html`<${Button} disabled=${!box.pv} onClick=${() => inspect(box.pv)}>Inspect or edit<//>
        <${Button} kind="primary" busy=${busy === 'execute'} disabled=${Boolean(busy) || box.loading || !box.pv} onClick=${execute}>Execute now<//>` : null}`}>
    <div class="stack">
      <${ErrorNote} error=${error} />
      ${r.status === 'executed' ? html`<${Notice} tone="ok">This hedge was executed and is linked to the position.<//>` : null}
      ${r.status === 'dismissed' ? html`<${Notice}>This hedge request was dismissed. Request again to see current instructions.<//>` : null}
      ${q.existingHedges?.length && packages.length ? html`<${Notice}>Protection already held on this position: ${q.existingHedges.map((h) => `${fmtQty(Math.abs(h.quantity))} ${h.instrument.symbol || h.instrument.name}`).join(', ')}. It was sent with the request, so anything proposed here is for what remains.<//>` : null}
      <div class="split" style="grid-template-columns:minmax(0,1fr) 320px">
        <div class="stack">
          ${packages.length ? html`<${PackageDetail} pkg=${pkg} pv=${box.pv} loading=${box.loading} error=${box.error} onRefresh=${acted ? null : box.reload} onAcknowledge=${acted ? null : box.acknowledge} />` : html`<${RequestState} r=${r} />`}
          ${!packages.length ? html`<p class="note">You can still add protection by hand: open the position's strategy and choose Add legs, or build a package on the Strategy page with "hedge an existing position".</p>` : null}
        </div>
        <div class="stack">
          ${packages.length ? html`<section class="panel"><header><h3>Packages</h3></header><div class="body"><${PackageList} response=${r.response} selected=${sel} onSelect=${setSel} /></div></section>` : null}
          <section class="panel"><header><h3>What was sent</h3></header><div class="body stack">
            <${RequestSummary} r=${r} />
            ${!acted ? html`<details open=${Boolean(r.missing?.length)}><summary class="note">Change the request</summary>
              <div class="grid-form" style="margin-top:8px">
                <${Field} label="Investment Strategy" span=${2}><${Text} value=${ctx.strategy} onInput=${(v) => setCtx({ ...ctx, strategy: v })} placeholder="Name of the Shaffer Strategy" /><//>
                <${Field} label="Holding period (days)"><${Num} value=${ctx.days} onInput=${(v) => setCtx({ ...ctx, days: v })} /><//>
                <${Field} label="Hedge objective"><${Select} value=${ctx.objective} onChange=${(v) => setCtx({ ...ctx, objective: v })} options=${OBJECTIVES} placeholder="Not set" /><//>
                <${Field} label="Scope" span="all"><${Select} value=${ctx.scope} onChange=${(v) => setCtx({ ...ctx, scope: v })} options=${SCOPES} /><//>
              </div>
              <div style="margin-top:8px"><${Button} small busy=${busy === 'again'} disabled=${!ctxChanged && r.status !== 'error'} onClick=${again}>Request again<//></div></details>` : null}
          </div></section>
        </div>
      </div>
    </div>
  <//>`;
}

/**
 * Hedge review queue of the selected Book: requests still waiting for Shaffer Hedge, requests
 * answered and not yet acted on, and hedged positions whose exposure has changed.
 */
export function HedgeQueue({ book, compact }) {
  const res = useLive(() => get('/api/hedge/queue', { bookId: book.id }), [book.id]);
  const [busy, setBusy] = useState(false);
  const d = res.data;
  if (!d || (!d.items.length && !d.reviews.length)) return compact ? null : html`<p class="note">Nothing is waiting for a hedge decision in this Book.</p>`;
  const refresh = async () => { setBusy(true); try { const out = await post('/api/hedge/refresh'); toast(out.refreshed.length ? `${out.refreshed.length} request${out.refreshed.length > 1 ? 's' : ''} refreshed against current exposure.` : d.canAnswer ? 'Nothing new came back.' : `${d.awaitingMessage}. The requests stay in the queue.`, out.refreshed.length ? 'ok' : 'warn'); bump(); } catch (err) { toastError(err); } setBusy(false); };
  const openStrategy = async (id) => { const m = await import('./strategy-detail.js'); m.openStrategy(id); };
  const STATE = { awaiting: ['', 'awaiting Shaffer Hedge'], received: ['ok', 'recommendation ready'], error: ['bad', 'request failed'] };
  return html`<section class="panel"><header><h3>Hedge review queue</h3><span class="note">Nothing here is traded until you confirm it</span><span class="grow"></span>
      ${d.items.some((x) => x.status !== 'received') ? html`<${Button} small busy=${busy} onClick=${refresh}>Ask again now<//>` : null}</header>
    <div class="body flush"><div class="tablewrap"><table class="ledger margin"><thead><tr><th>Position</th><th>Held in</th><th>State</th><th>Asked</th><th></th></tr></thead><tbody>
      ${d.items.map((x) => html`<tr key=${x.id}>
        <td class="wrap"><div class="strong">${x.primary ? `${x.primary.direction === 'short' ? 'Short' : 'Long'} ${fmtQty(x.primary.quantity)} ${x.primary.symbol || x.primary.name}` : `Scope: ${SCOPE_LABEL[x.scope.type] || x.scope.type}`}</div>
          ${x.strategy ? html`<div class="sub"><a href="javascript:void 0" onClick=${() => openStrategy(x.strategy.id)}>${x.strategy.name}</a></div>` : null}</td>
        <td>${x.owner || book.name}</td>
        <td><${Pill} tone=${STATE[x.status][0]}>${STATE[x.status][1]}<//>${x.status === 'received' ? html` <span class="sub">${x.packages} package${x.packages === 1 ? '' : 's'}${x.refreshedAt ? ', refreshed on current exposure' : ''}</span>` : x.status === 'error' ? html` <span class="sub">${x.message}</span>` : ''}</td>
        <td class="nowrap">${fmtTime(x.createdAt)}</td>
        <td class="r"><${Button} small onClick=${() => openHedgeRequest(x.id)}>${x.status === 'received' ? 'Review' : 'Open'}<//></td></tr>`)}
      ${d.reviews.map((x) => html`<tr key=${`rv-${x.strategy.id}`}>
        <td class="wrap"><div class="strong"><a href="javascript:void 0" onClick=${() => openStrategy(x.strategy.id)}>${x.strategy.name}</a></div><div class="sub">${x.reason}</div></td>
        <td>${x.owner}</td><td><${Pill} tone="warn">exposure changed<//></td><td class="nowrap">${fmtTime(x.since)}</td>
        <td class="r"><${Button} small onClick=${() => openStrategy(x.strategy.id)}>Open the strategy<//></td></tr>`)}
    </tbody></table></div></div></section>`;
}

/** Request hedge instructions for an existing strategy's position and open the popup. */
export async function openHedgeFor(strategy, { trigger = 'manual', scope = 'trade', onDone } = {}) {
  try {
    const r = await post('/api/hedge/requests', {
      bookId: strategy.bookId, unitId: strategy.unit.id, strategyId: strategy.id, scope: { type: scope }, trigger,
      investmentStrategy: strategy.investmentStrategy, holdingPeriod: strategy.holdingPeriod, objective: strategy.params?.hedgeObjective || null,
    });
    openOverlay((close) => html`<${HedgePopup} request=${r} onClose=${close} onDone=${onDone} />`);
    return r;
  } catch (err) { toastError(err); return null; }
}

/** Reopen a stored hedge request. */
export async function openHedgeRequest(id, { onDone } = {}) {
  try {
    const r = await get(`/api/hedge/requests/${id}`);
    openOverlay((close) => html`<${HedgePopup} request=${r} onClose=${close} onDone=${onDone} />`);
  } catch (err) { toastError(err); }
}
