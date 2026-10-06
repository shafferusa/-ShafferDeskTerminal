// Hedge workflow screens.
//
// Shaffer Hedge runs in Analytics Lab. It selects hedge structures and sizes their legs. The
// Terminal's part, shown here, is to display what was requested, the packages that came back
// (or the waiting state while Analytics Lab is not connected), the quotes and indicative terms
// available for each leg, and to run confirmed paper execution through the normal package
// engine. Nothing in this file chooses or sizes a hedge.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, toast, toastError } from '../lib/core.js';
import { Awaiting, Button, Checks, Empty, ErrorNote, Field, KV, Missing, Modal, Money, Notice, Num, Pill, Prov, Select, Text } from '../lib/ui.js';
import { PreviewModal } from './preview.js';

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
  return html`<tr>
    <td><span class="leg-n">${leg.n}</span>${leg.dependsOn?.length ? html`<div class="dep">after ${leg.dependsOn.join(', ')}</div>` : null}</td>
    <td class="wrap"><div class="strong">${leg.label}</div>
      <div class="sub">${leg.purpose === 'financing' ? 'Financing' : leg.hedgeFamily || leg.kindLabel}${leg.riskAddressed ? `, addresses ${String(leg.riskAddressed).toLowerCase()}` : ''}</div>
      ${leg.sizingBasis || isNum(leg.hedgeRatio) ? html`<div class="sub">Sized by ${leg.sizingBasis || 'the ratio supplied'}${isNum(leg.hedgeRatio) ? `, ratio ${leg.hedgeRatio}` : ''}</div>` : null}
      ${leg.instrument?.details?.length ? html`<details><summary class="note">Contract terms</summary><dl class="terms">${leg.instrument.details.map(([k, v]) => html`<dt>${k}</dt><dd>${String(v)}</dd>`)}</dl></details>` : null}
      ${(leg.econNotes || []).map((n) => html`<div class="sub">${n}</div>`)}</td>
    <td class="r">${fmtQty(leg.qty)}<div class="sub">${leg.qtyLabel}</div></td>
    <td class="wrap" style="min-width:200px">
      ${leg.kind === 'trade' ? html`<div>${isNum(p?.estimate) ? html`<span class="price"><span class="v">${fmtPrice(p.estimate)}</span></span>` : html`<span class="missing" title=${p?.reason || ''}>no executable quote</span>`}${p?.observation ? html` <${Prov} obs=${p.observation} />` : null}</div>
        <div class="sub">${p?.label || ''}</div>
        ${leg.indicative ? html`<div class="sub">Indicative terms ${fmtPrice(leg.indicative.value)} (${leg.indicative.status}, ${leg.indicative.source}). Not an executable quote.</div>` : null}` : html`<span class="muted">${leg.kindLabel}</span>`}</td>
    <td class="r nowrap">${isNum(leg.cash) ? html`<${Money} value=${leg.cash} ccy=${leg.currency} signed />` : leg.kind === 'trade' ? html`<${Missing} reason="Needs a price" />` : ''}${leg.feeTotal ? html`<div class="sub">fees ${fmtMoney(leg.feeTotal, leg.currency)}</div>` : null}</td>
    <td class="r nowrap">${isNum(leg.notional) ? fmtMoney(leg.notional, leg.currency) : ''}${leg.initialMargin ? html`<div class="sub">margin ${fmtMoney(leg.initialMargin, leg.currency)}</div>` : null}</td>
  </tr>`;
}

/** One package: what Shaffer Hedge said about it, and what the Terminal found when it priced and validated the legs. */
export function PackageDetail({ pkg, pv, loading, error }) {
  const c = pkg.costs;
  const cash = pv ? Object.values(pv.totals.cash || {}) : [];
  return html`<div class="stack">
    <div class="cols-2">
      <${KV} rows=${[
        ['Risk addressed', pkg.riskAddressed?.length ? pkg.riskAddressed.join(', ') : notSupplied],
        ['Intended protection', pkg.intendedProtection || notSupplied],
        ['Horizon', pkg.horizon?.until ? `Until ${pkg.horizon.until}` : pkg.horizon?.days ? `${pkg.horizon.days} days` : notSupplied],
        ['Upside surrendered', pkg.upsideSurrendered || notSupplied],
        ['Valuation', pkg.valuation ? `${pkg.valuation.source}${pkg.valuation.status ? ` (${pkg.valuation.status})` : ''}${pkg.valuation.asOf ? `, ${fmtTime(pkg.valuation.asOf)}` : ''}` : notSupplied],
        ['Availability', pkg.valuation?.availability || notSupplied],
      ]} />
      <${KV} rows=${[
        ['Upfront cash', c ? val(c.upfrontCash, c.currency) : notSupplied], ['Premiums', c ? val(c.premiums, c.currency) : notSupplied],
        ['Expected ongoing cost', c ? val(c.expectedOngoing, c.currency) : notSupplied], ['Margin', c ? val(c.margin, c.currency) : notSupplied],
        ['Collateral', c ? val(c.collateral, c.currency) : notSupplied], ['Borrowing and funding', c ? html`${val(c.borrowing, c.currency)} / ${val(c.funding, c.currency)}` : notSupplied],
      ]} />
    </div>
    ${pkg.exposure?.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Exposure measure</th><th class="r">Before</th><th class="r">After</th><th class="r">Residual</th><th>Basis risk</th></tr></thead><tbody>
      ${pkg.exposure.map((e) => html`<tr><td>${e.measure}</td><td class="r">${val(e.before, e.unit)}</td><td class="r">${val(e.after, e.unit)}</td><td class="r">${val(e.residual, e.unit)}</td><td class="wrap">${e.basisRisk || notSupplied}</td></tr>`)}
    </tbody></table></div>` : null}
    ${pkg.scenarios?.length ? html`<div class="tablewrap"><table class="ledger"><thead><tr><th>Scenario</th><th class="r">Unhedged</th><th class="r">Hedged</th></tr></thead><tbody>
      ${pkg.scenarios.map((s) => html`<tr><td>${s.label}</td><td class="r">${val(s.unhedged, s.unit)}</td><td class="r">${val(s.hedged, s.unit)}</td></tr>`)}</tbody></table></div>` : null}
    ${(pkg.notes || []).map((n) => html`<div class="note">${n}</div>`)}
    <h4>Legs, priced and checked by the Terminal</h4>
    <${ErrorNote} error=${error} />
    ${!pv ? (error ? null : html`<${Empty}>${loading ? 'Pricing the legs…' : ''}<//>`) : html`
      <div class="tablewrap"><table class="ledger legs margin"><thead><tr><th></th><th>Leg</th><th class="r">Quantity</th><th>Quote or indicative terms</th><th class="r">Cash</th><th class="r">Notional</th></tr></thead>
        <tbody>${pv.legs.map((l) => html`<${LegLine} key=${l.n} leg=${l} />`)}</tbody></table></div>
      ${cash.length ? html`<div class="row small">${cash.map((r) => html`<span>Cash required <b>${fmtMoney(r.required, r.ccy)}</b>${r.margin ? `, of which margin ${fmtMoney(r.margin, r.ccy)}` : ''}${r.reserved ? `, reserved ${fmtMoney(r.reserved, r.ccy)}` : ''}; available ${fmtMoney(r.available, r.ccy)}${r.shortfall > 0 ? html`; <span class="loss strong">short ${fmtMoney(r.shortfall, r.ccy)}</span>` : ''}.</span>`)}</div>` : null}
      <${Checks} checks=${pv.checks} />`}
  </div>`;
}

/** Load the Terminal's priced, validated view of one proposed package. */
export function usePackagePreview(requestId, packageId) {
  const [box, setBox] = useState({ pv: null, error: null, loading: false });
  useEffect(() => {
    if (!requestId || !packageId) { setBox({ pv: null, error: null, loading: false }); return undefined; }
    let live = true;
    setBox({ pv: null, error: null, loading: true });
    post(`/api/hedge/requests/${requestId}/preview`, { packageId }).then(
      (pv) => { if (live) setBox({ pv, error: null, loading: false }); },
      (error) => { if (live) setBox({ pv: null, error, loading: false }); });
    return () => { live = false; };
  }, [requestId, packageId]);
  return box;
}

/**
 * The Hedge popup. Opens after a direct Marketplace fill (Workflow 2), and from a strategy when a
 * hedge is requested or needs review. Dismissing it leaves the primary position unchanged.
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
    } catch (err) { setError(err); }
    setBusy('');
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try { if (!acted) await post(`/api/hedge/requests/${r.id}/dismiss`); bump(); onClose(); } catch (err) { setError(err); setBusy(''); }
  };
  const done = (s) => { bump(); onDone?.(s); onClose(); };
  const inspect = (pv, banner) => openOverlay((close) => html`<${PreviewModal} preview=${pv} onClose=${close} onDone=${done} extra=${{ hedgePackageId: pkg.id }} confirmLabel="Confirm hedge" banner=${banner} />`);
  const openInspect = async () => {
    setBusy('inspect'); setError(null);
    try { inspect(await post(`/api/hedge/requests/${r.id}/preview`, { packageId: pkg.id })); } catch (err) { setError(err); }
    setBusy('');
  };
  // Execute now: validate quotes, exposure, funding and collateral first. A clean package is
  // submitted on this one click; anything to review opens the full preview instead.
  const execute = async () => {
    if (busy) return;
    setBusy('execute'); setError(null);
    try {
      const pv = await post(`/api/hedge/requests/${r.id}/preview`, { packageId: pkg.id });
      const review = pv.checks.filter((c) => c.level !== 'info');
      if (review.length) {
        inspect(pv, html`<${Notice} tone="warn">Validation found ${review.length} item${review.length > 1 ? 's' : ''} to review, so the hedge was not submitted. Resolve or accept them here, then confirm.<//>`);
      } else {
        const out = await post('/api/strategies', { ...pv.input, hedgePackageId: pkg.id, legs: pv.legs, clientToken: pv.token, confirm: true });
        const working = out.strategy.orders.filter((o) => ['pending', 'working', 'partial'].includes(o.status) && o.submission === pv.token).length;
        toast(working ? `Hedge submitted. ${working} leg${working > 1 ? 's are' : ' is'} working.` : 'Hedge executed and linked to the position.', working ? 'warn' : 'ok', 6000);
        done(out.strategy);
        return;
      }
    } catch (err) {
      if (err.details?.preview) inspect(err.details.preview, html`<${Notice} tone="err">${err.message}<//>`);
      else setError(err);
    }
    setBusy('');
  };

  const title = q.primary?.instrument ? `Hedge for ${q.primary.direction === 'short' ? 'short' : 'long'} ${q.primary.instrument.symbol || q.primary.instrument.name}` : `Hedge for ${q.account?.name || q.book.name}`;
  return html`<${Modal} size="wide" title=${title} sub=${`${TRIGGER[r.trigger] || ''}${r.response ? `, ${r.response.source}${r.response.asOf ? `, ${fmtTime(r.response.asOf)}` : ''}` : ''}`} onClose=${onClose}
    footer=${html`<span class="note">Closing this leaves the primary position exactly as it is.</span><span class="grow"></span>
      ${acted ? html`<${Button} onClick=${onClose}>Close<//>` : html`<${Button} busy=${busy === 'dismiss'} onClick=${dismiss}>${packages.length ? 'Dismiss, no hedge' : 'Close'}<//>`}
      ${pkg && !acted ? html`<${Button} busy=${busy === 'inspect'} onClick=${openInspect}>Inspect or edit<//>
        <${Button} kind="primary" busy=${busy === 'execute'} disabled=${Boolean(busy) || box.loading} onClick=${execute}>Execute now<//>` : null}`}>
    <div class="stack">
      <${ErrorNote} error=${error} />
      ${r.status === 'executed' ? html`<${Notice} tone="ok">This hedge was executed and is linked to the position.<//>` : null}
      ${r.status === 'dismissed' ? html`<${Notice}>This hedge request was dismissed. Request again to see current instructions.<//>` : null}
      <div class="split" style="grid-template-columns:minmax(0,1fr) 320px">
        <div class="stack">
          ${packages.length ? html`<${PackageDetail} pkg=${pkg} pv=${box.pv} loading=${box.loading} error=${box.error} />` : html`<${RequestState} r=${r} />`}
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
