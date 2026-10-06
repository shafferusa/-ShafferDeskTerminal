// Settings.
//
// Appearance (system, light or dark), the current Book's paper-desk assumptions, and what this
// Terminal is. The assumptions are the parameters the simulation engine reads for fees, fills,
// settlement, short selling, short options and dividends. They are editable assumptions of the
// paper desk, not market data and not a risk model. Only values the engine uses are shown.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, fmtNum, fmtTime, get, isNum, put, refreshStatus, setTheme, toast, useLive, useStore } from '../lib/core.js';
import { Button, Check, ErrorNote, KV, Notice, Num, Panel, Pill, Seg } from '../lib/ui.js';

const FAMILY_LABEL = { equity: 'Equities', fund: 'Funds', spot: 'Spot assets', crypto: 'Digital assets', manual: 'Manually valued holdings', option: 'Listed options', future: 'Futures', fx: 'Spot FX', bond: 'Debt securities', forward: 'Forwards and FRAs', otcoption: 'OTC options', swap: 'Swaps', cds: 'Credit default swaps', foreignCash: 'Foreign-listed cash securities' };
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = { ...obj };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = { ...(cur[keys[i]] || {}) }; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = value;
  return out;
}
const days = (v) => (v === 0 ? 'Same day' : `T+${v}`);
const show = (v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

// Every setting shown here is read by the engine. Each group: { id, title, intro, cols, rows: [{ label, hint, paths, reads }] }.
const FEE_FAMILIES = ['equity', 'fund', 'spot', 'crypto', 'manual', 'option', 'future', 'fx', 'bond', 'forward', 'otcoption', 'swap', 'cds'];
const FEE_UNIT = { option: 'per contract', future: 'per contract', equity: 'per share', fund: 'per share', bond: 'per unit of face', swap: 'per unit of notional', cds: 'per unit of notional', forward: 'per unit of notional', fx: 'per unit of base currency' };
const SPREAD_FAMILIES = ['equity', 'fund', 'spot', 'crypto', 'manual', 'fx', 'bond', 'forward', 'swap', 'cds'];
const SETTLE_FAMILIES = ['equity', 'fund', 'foreignCash', 'option', 'bond', 'crypto', 'spot', 'manual', 'otcoption', 'swap', 'cds'];
const GROUPS = [
  { id: 'fees', title: 'Fees and commissions', wide: true,
    intro: 'Charged on every simulated fill, in the instrument\'s trading currency: an amount per unit, plus basis points of the principal traded. If a minimum is set, it applies whenever a fee is charged. For swaps, credit default swaps and forwards the principal is the notional.',
    cols: ['Per unit', 'Basis points', 'Minimum per fill'],
    rows: FEE_FAMILIES.map((f) => ({ label: FAMILY_LABEL[f], hint: FEE_UNIT[f] ? `Per unit is ${FEE_UNIT[f]}` : '', paths: [`fees.${f}.perUnit`, `fees.${f}.bps`, `fees.${f}.minimum`] })) },
  { id: 'fill', title: 'Fill model',
    intro: 'How a paper order fills. A quoted bid and ask is always used when there is one: buys at the ask, sells at the bid. The spread assumptions below apply only when a price has no bid and ask of its own. Fair prices from Analytics Lab are never used to fill an order.',
    cols: ['Value'],
    rows: [
      { label: 'Slippage', hint: 'Extra adverse move, in basis points of price, added to every fill except one at a price you state.', paths: ['fill.slippageBps'], reads: (v) => `${v} bp` },
      { label: 'Participation', hint: 'Share of the displayed bid or ask size one matching cycle may take. The rest keeps working.', paths: ['fill.participation'], reads: (v) => `${fmtNum(v * 100, 0)}% of displayed size` },
      { label: 'Maximum quote age', hint: 'A quote older than this, in seconds, cannot fill an order. A stated delay on delayed data is added to it.', paths: ['fill.maxQuoteAgeSec'], reads: (v) => `${v} s` },
      { label: 'Fill against end-of-day prices', hint: 'Off: an order with only an end-of-day price waits for a fresh quote or a stated fill price.', paths: ['fill.allowEndOfDayFills'] },
      { label: 'Listed options, half spread', hint: 'Percent of premium, never less than one tick.', paths: ['fill.optionHalfSpreadPct'], reads: (v) => `${v}% of premium` },
      { label: 'Futures, half spread', hint: 'In ticks of the contract. A contract with no tick size uses 0.01% of price as one tick.', paths: ['fill.futureHalfSpreadTicks'], reads: (v) => `${v} tick${v === 1 ? '' : 's'}` },
    ] },
  { id: 'spread', title: 'Assumed half spread by product',
    intro: 'Basis points of price added to a buy and taken off a sell when only a last or manually entered price exists. OTC options fill at the stated or marked price with no spread.',
    cols: ['Basis points'],
    rows: SPREAD_FAMILIES.map((f) => ({ label: FAMILY_LABEL[f], paths: [`fill.halfSpreadBps.${f}`], reads: (v) => `${v} bp` })) },
  { id: 'settlement', title: 'Settlement lags',
    intro: 'Business days from trade date to settlement. An instrument\'s own lag is used where it has one. Spot FX settles on the lag of the currency pair (T+2 unless the pair says otherwise), futures settle the same day and forwards on their value date, so they have no setting here.',
    cols: ['Business days'],
    rows: SETTLE_FAMILIES.map((f) => ({ label: FAMILY_LABEL[f], hint: f === 'foreignCash' ? 'Equities, funds, spot assets and manually valued holdings in the Foreign Based view use this lag instead of their own row.' : '', paths: [`settlement.${f}`], reads: days })) },
  { id: 'short', title: 'Short selling',
    intro: 'A short sale always needs a securities borrow. Its proceeds are held as restricted collateral, never as buying power.',
    cols: ['Decimal'],
    rows: [
      { label: 'Cash collateral on borrowed securities', hint: 'Share of market value held as collateral, marked daily. The part above 1 is topped up from free cash.', paths: ['short.collateralPct'], reads: (v) => `${fmtNum(v * 100, 1)}% of market value` },
      { label: 'Margin on short positions', hint: 'Further free cash reserved per unit of short market value.', paths: ['short.marginPct'], reads: (v) => `${fmtNum(v * 100, 1)}% of market value` },
    ] },
  { id: 'options', title: 'Short options',
    intro: 'The largest loss of an option structure is reserved in full: a short put is fully cash-secured and a credit spread reserves its width. Stock held covers short calls unit for unit. Only the uncovered-call rule is adjustable.',
    cols: ['Decimal'],
    rows: [{ label: 'Uncovered short calls', hint: 'Share of the underlying\'s value reserved for each uncovered short call unit. The loss itself is unbounded.', paths: ['margin.nakedCallPct'], reads: (v) => `${fmtNum(v * 100, 1)}% of underlying value` }] },
  { id: 'dividends', title: 'Dividends',
    intro: 'Applied to cash dividends received on long positions.',
    cols: ['Percent'],
    rows: [{ label: 'Withholding', hint: 'Percent of the gross dividend withheld. 15 means 15%.', paths: ['dividends.withholdingPct'], reads: (v) => `${v}% withheld` }] },
];
const ALL_PATHS = GROUPS.flatMap((g) => g.rows.flatMap((r) => r.paths));

function Group({ g, draft, saved, defaults, set }) {
  const differs = (p) => getPath(saved, p) !== getPath(defaults, p);
  const changed = g.rows.filter((r) => r.paths.some(differs)).length;
  const reads = g.rows.some((r) => r.reads);
  return html`<${Panel} title=${g.title} note=${changed ? `${changed} changed from the default` : 'All at the defaults'} flush>
    <div class="small muted" style="padding:8px 12px;border-bottom:1px solid var(--rule)">${g.intro}</div>
    <div class="tablewrap"><table class="ledger"><thead><tr><th>Assumption</th>${g.cols.map((c) => html`<th class="r">${c}</th>`)}${reads ? html`<th>Reads as</th>` : null}<th>Default</th></tr></thead>
      <tbody>${g.rows.map((r) => {
        const off = r.paths.filter(differs);
        const dirty = r.paths.some((p) => getPath(draft, p) !== getPath(saved, p));
        const atDefault = r.paths.every((p) => getPath(draft, p) === getPath(defaults, p));
        const v = getPath(draft, r.paths[0]);
        return html`<tr>
          <td class="wrap" style="min-width:200px"><div>${r.label}</div>${r.hint ? html`<div class="sub">${r.hint}</div>` : null}</td>
          ${r.paths.map((p) => { const x = getPath(draft, p); return html`<td class="r">${typeof getPath(defaults, p) === 'boolean'
            ? html`<${Check} checked=${x} onChange=${(b) => set(p, b)}>${x ? 'On' : 'Off'}<//>`
            : html`<div class=${`set-num ${isNum(x) && x >= 0 ? '' : 'bad'}`}><${Num} value=${x} onInput=${(n) => set(p, n)} /></div>`}</td>`; })}
          ${reads ? html`<td class="muted nowrap">${r.reads && isNum(v) ? r.reads(v) : ''}</td>` : null}
          <td class="nowrap">${off.length ? html`<${Pill} tone="warn" title="The saved value differs from the default">changed<//> ` : null}${dirty ? html`<${Pill} tone="pen">not saved<//> ` : null}
            <span class="muted">${r.paths.map((p) => show(getPath(defaults, p))).join(' / ')}</span>
            ${atDefault ? null : html` <button class="btn link small" title="Puts the default back in the form. Save to apply it." onClick=${() => r.paths.forEach((p) => set(p, getPath(defaults, p)))}>Reset</button>`}</td>
        </tr>`; })}</tbody></table></div><//>`;
}

function Assumptions({ book }) {
  const defs = useLive(() => get('/api/defaults'), [], { interval: false });
  const [draft, setDraft] = useState(book.settings);
  const [saved, setSaved] = useState(book.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dirty = ALL_PATHS.filter((p) => getPath(draft, p) !== getPath(saved, p));
  // Follow the Book when nothing is being edited (a save made elsewhere, or a reload).
  useEffect(() => { if (!dirty.length) { setDraft(book.settings); setSaved(book.settings); } }, [JSON.stringify(book.settings)]);
  if (!defs.data) return defs.error ? html`<${ErrorNote} error=${defs.error} />` : html`<div class="note">Loading the assumptions…</div>`;
  const defaults = defs.data.book;
  const invalid = ALL_PATHS.filter((p) => typeof getPath(defaults, p) === 'number' && !(isNum(getPath(draft, p)) && getPath(draft, p) >= 0));
  const off = ALL_PATHS.filter((p) => getPath(saved, p) !== getPath(defaults, p));
  const set = (p, v) => { setError(null); setDraft((d) => setPath(d, p, v)); };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      // Only what changed is sent; the server merges it into the Book's overrides.
      let patch = {};
      for (const p of dirty) patch = setPath(patch, p, getPath(draft, p));
      const b = await put(`/api/books/${book.id}`, { settings: patch });
      setSaved(b.settings); setDraft(b.settings);
      await refreshStatus(); bump();
      toast('Assumptions saved.');
    } catch (err) { setError(err); }
    setBusy(false);
  };
  const resetAll = () => setDraft((d) => ALL_PATHS.reduce((acc, p) => setPath(acc, p, getPath(defaults, p)), d));
  const wide = GROUPS.filter((g) => g.wide), rest = GROUPS.filter((g) => !g.wide);
  const column = (list) => html`<div class="stack">${list.map((g) => html`<${Group} key=${g.id} g=${g} draft=${draft} saved=${saved} defaults=${defaults} set=${set} />`)}</div>`;
  return html`<div class="stack">
    <${Notice}>These are editable assumptions of the paper desk for <b>${book.name}</b>. They are not market data and not a risk model. An instrument's own terms and supplied data (a quoted bid and ask, a contract's margin, a settlement lag, a borrow fee) are used ahead of them wherever they exist.<//>
    <div class=${`set-bar ${dirty.length ? 'pinned' : ''}`}>
      <span>${dirty.length ? html`<b>${dirty.length} change${dirty.length > 1 ? 's' : ''} not saved.</b>` : off.length ? `${off.length} value${off.length > 1 ? 's differ' : ' differs'} from the defaults.` : 'Every value is at its default.'}
        ${invalid.length ? html` <span class="loss">${invalid.length} value${invalid.length > 1 ? 's are' : ' is'} empty or negative. Enter a number of zero or more.</span>` : null}</span>
      <span class="grow"></span>
      ${off.length || dirty.length ? html`<${Button} small disabled=${ALL_PATHS.every((p) => getPath(draft, p) === getPath(defaults, p))} onClick=${resetAll} title="Puts every default back in the form. Save to apply them.">Reset all to defaults<//>` : null}
      ${dirty.length ? html`<${Button} small onClick=${() => { setDraft(saved); setError(null); }}>Discard changes<//>` : null}
      <${Button} kind="primary" busy=${busy} disabled=${!dirty.length || invalid.length > 0} onClick=${save}>Save assumptions<//>
    </div>
    <${ErrorNote} error=${error} />
    ${column(wide)}
    <div class="cols-2">${column(rest.filter((_, i) => i % 2 === 0))}${column(rest.filter((_, i) => i % 2 === 1))}</div>
    <p class="note">Saved assumptions apply from the next preview, fill and daily mark. Fills already booked are not restated. Each save is recorded in the Book's history.</p>
  </div>`;
}

const THEMES = [{ value: '', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

function Appearance() {
  const theme = useStore((s) => s.theme);
  const systemDark = Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const now = theme ? (theme === 'dark' ? 'Dark mode is on.' : 'Light mode is on.') : `Following this device, which is set to ${systemDark ? 'dark' : 'light'} right now.`;
  return html`<${Panel} title="Appearance">
    <div class="stack">
      <div class="row"><${Seg} value=${theme} onChange=${setTheme} options=${THEMES} /><span class="strong">${now}</span></div>
      <p class="note">System follows the light or dark setting of this device and changes with it. The choice is kept in this browser. The button at the top right switches between light and dark at any time.</p>
    </div><//>`;
}

function About({ status }) {
  const e = status.engine;
  const conn = (s) => ({ connected: 'Connected', demo: 'Demo feed', error: 'Error', configured: 'Configured, not verified', awaiting: status.data.awaitingMessage }[s.connection] || s.connection);
  return html`<${Panel} title="About this Terminal">
    <div class="stack">
      <${Notice} tone="warn"><b>Simulated only.</b> ${status.simulatedOnly}<//>
      ${e.lastError ? html`<${Notice} tone="err">The engine reported an error on its last cycle: ${String(e.lastError)}<//>` : null}
      <div class="set-kv"><${KV} rows=${[
        ['Version', `${status.name} ${status.version}`],
        ['Mode', status.demo ? 'Demo mode: simulated feed and a separate demo database' : 'Paper desk on your own database'],
        ['Engine', html`<${Pill} tone=${e.running ? 'ok' : 'bad'}>${e.running ? 'running' : 'stopped'}<//> ${e.running ? `one cycle every ${fmtNum(e.tickMs / 1000, 0)} seconds` : 'orders and settlements are not being processed'}`],
        ['Last engine cycle', e.lastTick ? fmtTime(e.lastTick, { seconds: true }) : 'Not yet run'],
        ['Last end-of-day run', e.lastEndOfDay ? `For business date ${e.lastEndOfDay}` : 'Not yet run'],
        e.nextEndOfDay ? ['Next end-of-day run', fmtTime(e.nextEndOfDay)] : null,
        ['Business date', `${status.today}${status.clockSimulated ? ' (demo clock moved)' : ''}`],
        ['On file', `${status.counts.books} Book${status.counts.books === 1 ? '' : 's'}, ${status.counts.instruments} instrument${status.counts.instruments === 1 ? '' : 's'}`],
        ['Shaffer MarketData', conn(status.data.market)],
        ['Shaffer Analytics Lab', conn(status.data.analytics)],
      ]} /></div>
      <p class="note">The engine matches working orders, settles cash on its due date and runs lifecycle events (coupons, interest, expirations, maturities) on each cycle, and marks the books once at the end of each business day. After downtime it catches up in date order.</p>
      <div><a class="btn" href="#/data">Open Data connection</a></div>
    </div><//>`;
}

export default function Settings({ book, status }) {
  return html`<div>
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Appearance, the paper-desk assumptions of the current Book, and what this Terminal is.</div></div></div>
    <div class="stack">
      <div class="cols-2" style="align-items:start">
        <div class="stack"><${Appearance} />
          <${Panel} title=${`Book: ${book.name}`}>
            <div class="set-kv"><${KV} rows=${[['Reporting currency', html`<b>${book.reportingCcy}</b>`], ['Structure', `One Treasury, ${book.units.length - 1} Account${book.units.length === 2 ? '' : 's'}`]]} /></div>
            <p class="note" style="margin-top:8px">The reporting currency is set when a Book is created and cannot be changed afterwards: every ledger entry keeps its ${book.reportingCcy} amount at the FX rate of the day it was posted. To report in another currency, create a new Book. Rename the Book under <a href="#/books">Manage Books</a>; add Accounts under <a href="#/treasury">Treasury</a>.</p><//>
        </div>
        <${About} status=${status} />
      </div>
      <h2 style="margin-top:6px">Paper-desk assumptions</h2>
      <${Assumptions} book=${book} />
    </div>
  </div>`;
}
