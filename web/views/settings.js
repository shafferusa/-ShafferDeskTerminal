// Settings.
//
// Appearance (system, light or dark), the market calendars settlement dates are worked out on,
// the current Book's paper-desk assumptions, and what this Terminal is. The calendars are the
// Terminal's own rule-based ones, with holidays added by hand, until Shaffer MarketData supplies
// market calendars; a market with none falls back to weekends only and is flagged wherever a date
// is shown. The assumptions are the parameters the simulation engine reads for fees, fills,
// settlement, short selling, short options and dividends, and the tolerances a confirmation is held
// to. They are editable assumptions of the paper desk, not market data and not a risk model. Only
// values the engine uses are shown.
import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { bump, fmtNum, fmtTime, get, isNum, put, refreshStatus, setTheme, toast, useLive, useStore } from '../lib/core.js';
import { Button, Check, ErrorNote, KV, Notice, Num, Panel, Pill, Seg, Select, Text } from '../lib/ui.js';
import { COUNTRY_CALENDAR } from './registry.js';

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
    intro: 'Charged on every simulated fill, in the instrument\'s trading currency: an amount per unit, plus basis points of the principal traded. A minimum applies once to an order, not to each fill: an order filled in parts pays in total what the schedule gives for the quantity it filled, and its first fill carries the minimum. For swaps, credit default swaps and forwards the principal is the notional.',
    cols: ['Per unit', 'Basis points', 'Minimum per order'],
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
  { id: 'confirmation', title: 'Confirmation tolerances',
    intro: 'A confirmation executes the figures that were displayed. When you confirm, the legs are priced again as one snapshot and compared with what was on screen, leg by leg and in total. A figure that moved by more than its tolerance refuses the confirmation and shows what changed, was and now. A changed term (settlement date, quote status, financing terms, borrow availability, a missing leg) is refused whatever these values say. Zero accepts no movement. A difference the tolerances allow is recorded on the order and its fill.',
    cols: ['Value'],
    rows: [
      { label: 'Leg price', hint: 'How far the estimated fill price of one leg may move, in percent of the price displayed.', paths: ['confirmation.legPricePct'], reads: (v) => `${v}% of price` },
      { label: 'Leg amounts', hint: 'Cash, fees, accrued interest, margin, collateral, notional and financing amount of one leg, each in percent of the amount displayed.', paths: ['confirmation.legAmountPct'], reads: (v) => `${v}% of amount` },
      { label: 'Package totals', hint: 'Each total per currency: cash required, net cash, purchases, proceeds, fees, margin, collateral, financing and the funding shortfall.', paths: ['confirmation.packageCashPct'], reads: (v) => `${v}% of total` },
      { label: 'Gross cash and notional', hint: 'The legs\' absolute cash amounts added together, and their notionals, per currency. Offsetting moves in two legs cannot cancel out in these.', paths: ['confirmation.grossCashPct'], reads: (v) => `${v}% of gross` },
      { label: 'Preview age', hint: 'A preview older than this many seconds has to be priced again before it can be confirmed. Zero sets no limit.', paths: ['confirmation.maxPreviewAgeSec'], reads: (v) => (v ? `${v} s` : 'no limit') },
    ] },
  { id: 'spread', title: 'Assumed half spread by product',
    intro: 'Basis points of price added to a buy and taken off a sell when only a last or manually entered price exists. OTC options fill at the stated or marked price with no spread.',
    cols: ['Basis points'],
    rows: SPREAD_FAMILIES.map((f) => ({ label: FAMILY_LABEL[f], paths: [`fill.halfSpreadBps.${f}`], reads: (v) => `${v} bp` })) },
  { id: 'settlement', title: 'Settlement lags',
    intro: 'Business days from trade date to settlement, counted on the instrument\'s settlement calendar. A lag set on the instrument (Instruments, Calendars and settlement) is used ahead of these, and a settlement date or lag can be stated for one trade on its ticket or in the preview. Spot FX settles on the lag of the currency pair (T+2 unless the pair says otherwise), futures settle the same day and forwards on their value date, so they have no setting here.',
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

/**
 * The settings as the engine applies them. A Book that changed the single confirmation threshold of
 * earlier versions (fill.maxPreviewDriftPct) and has not set the package tolerance since keeps that
 * value as its package tolerance, so that is the value shown.
 */
function applied(b) {
  const legacy = b.settingsOverrides?.fill?.maxPreviewDriftPct;
  if (isNum(legacy) && b.settingsOverrides?.confirmation?.packageCashPct === undefined) return setPath(b.settings, 'confirmation.packageCashPct', legacy);
  return b.settings;
}

function Assumptions({ book }) {
  const defs = useLive(() => get('/api/defaults'), [], { interval: false });
  const [draft, setDraft] = useState(applied(book));
  const [saved, setSaved] = useState(applied(book));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dirty = ALL_PATHS.filter((p) => getPath(draft, p) !== getPath(saved, p));
  // Follow the Book when nothing is being edited (a save made elsewhere, or a reload).
  useEffect(() => { if (!dirty.length) { setDraft(applied(book)); setSaved(applied(book)); } }, [JSON.stringify(book.settings)]);
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
      setSaved(applied(b)); setDraft(applied(b));
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

// ---- market calendars ---------------------------------------------------------------------------------------------
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
/** A real calendar date written YYYY-MM-DD (2026-02-31 is not one). */
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s).getTime()) && utc(s).toISOString().slice(0, 10) === s;
const longDate = (iso) => `${DAY_NAME[utc(iso).getUTCDay()]} ${utc(iso).getUTCDate()} ${MONTH_NAME[utc(iso).getUTCMonth()]} ${iso.slice(0, 4)}`;
/** Which venues and currencies a built-in calendar serves. */
function usedFor(id, byCcy) {
  const countries = Object.keys(COUNTRY_CALENDAR).filter((c) => COUNTRY_CALENDAR[c] === id && c !== 'UK');
  const ccys = Object.keys(byCcy).filter((c) => byCcy[c] === id);
  if (id === 'US') return 'Venues in US and instruments in a US market view, except debt securities.';
  if (id === 'USBOND') return 'Debt securities on a US venue or in a US market view.';
  if (id === 'USD') return 'US dollar payments. Every spot FX value date must also be a US dollar banking day.';
  if (id === 'WEEKEND') return 'Any venue country or currency with no calendar here. Holidays entered for it apply to all of those markets together.';
  if (id === 'ALLDAYS') return 'Digital assets. No day is a holiday.';
  return [countries.length ? `Venues in ${countries.join(', ')}` : '', ccys.length ? `${ccys.join(', ')} payments` : ''].filter(Boolean).join('; ') + '.';
}

function Calendars({ today }) {
  const live = useLive(() => get('/api/calendars'), [], { interval: false });
  const [data, setData] = useState(null); // the payload returned by the last save
  const [cal, setCal] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { setData(null); }, [live.data]);
  const d = data || live.data;
  if (!d) return live.error ? html`<${ErrorNote} error=${live.error} />` : html`<div class="note">Loading the calendars…</div>`;
  const editable = d.calendars.filter((c) => c.id !== 'ALLDAYS');
  const save = async (id, dates, done) => {
    setBusy(id); setError(null);
    try { setData(await put(`/api/calendars/${id}/holidays`, { dates })); bump(); toast(done); return true; } catch (err) { setError(err); return false; } finally { setBusy(''); }
  };
  const add = async () => {
    const c = d.calendars.find((x) => x.id === cal);
    const day = date.trim();
    if (!c) return setError(new Error('Choose the calendar the holiday belongs to.'));
    if (!isDate(day)) return setError(new Error(!day ? 'Enter the date of the holiday as YYYY-MM-DD.' : /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} is not a date on the calendar. Check the month and the day.` : `"${day}" is not a date in the form YYYY-MM-DD, for example ${today}.`));
    if ([0, 6].includes(utc(day).getUTCDay())) return setError(new Error(`${day} is a ${DAY_NAME[utc(day).getUTCDay()]}. Weekends are never business days, so there is nothing to add.`));
    if (c.extra.includes(day)) return setError(new Error(`${day} is already an extra holiday of ${c.id}.`));
    if (c.holidays.includes(day)) return setError(new Error(`${day} is already a holiday of ${c.id} by its rules.`));
    if (await save(c.id, [...c.extra, day].sort(), `Holiday added to ${c.id}.`)) setDate('');
    return undefined;
  };
  const upcoming = (c) => [...new Set([...c.holidays, ...c.extra])].filter((x) => x >= today).sort();
  const columns = (c) => {
    const next = upcoming(c), shown = next.slice(0, 4), rest = next.slice(4);
    return html`<tr>
      <td><span class="sym">${c.id}</span></td>
      <td style="min-width:260px"><div>${c.label}</div><div class="sub">${usedFor(c.id, d.currencyCalendars)}</div></td>
      <td>${c.id === 'ALLDAYS' ? html`<span class="muted">None: every day is a business day</span>`
        : shown.length ? html`<div class="nowrap">${shown.map((x, n) => html`${n ? ', ' : ''}<span class="nowrap" title=${`${longDate(x)}${c.extra.includes(x) ? ', entered by hand' : ''}`} style=${c.extra.includes(x) ? 'font-weight:600' : ''}>${x}</span>`)}</div>
          ${rest.length ? html`<div class="sub" title=${rest.join(', ')}>and ${rest.length} more to the end of ${d.year + 1}</div>` : null}`
          : html`<span class="muted">${c.id === 'WEEKEND' ? 'None beyond Saturdays and Sundays' : `None left to the end of ${d.year + 1}`}</span>`}</td>
      <td style="min-width:200px">${c.id === 'ALLDAYS' ? html`<span class="muted">Not applicable</span>` : c.extra.length
        ? c.extra.map((x) => html`<div class="nowrap"><span title=${longDate(x)} class=${x < today ? 'muted' : ''}>${x}</span> <button class="btn link small" disabled=${Boolean(busy)} title=${`Remove ${x} from the extra holidays of ${c.id}`} onClick=${() => save(c.id, c.extra.filter((y) => y !== x), `Holiday removed from ${c.id}.`)}>Remove</button></div>`)
        : html`<span class="muted">None entered</span>`}</td>
    </tr>`;
  };
  return html`<div class="stack">
    <p class="small" style="margin:0;max-width:110ch">Settlement dates and payment dates are worked out on these rule-based calendars until Shaffer MarketData supplies market calendars. Rules cannot know one-off closures, such as a state funeral, a weather closure or a newly declared holiday: enter those below as extra holidays. A market with no calendar here uses weekends only, and says so in the trade preview and on the instrument. The calendars apply to every Book.</p>
    <${Panel} title="Built-in calendars" note=${`Holidays shown from ${today} to the end of ${d.year + 1}`} flush>
      <div class="tablewrap"><table class="ledger fit"><thead><tr><th>Calendar</th><th>What it covers</th><th>Upcoming holidays</th><th>Extra holidays entered by hand</th></tr></thead>
        <tbody>${d.calendars.map(columns)}</tbody></table></div>
      <div style="padding:10px 12px;border-top:1px solid var(--rule)">
        <div class="row">
          <span class="strong small">Add an extra holiday</span>
          <div style="width:330px"><${Select} value=${cal} onChange=${(v) => { setCal(v); setError(null); }} placeholder="Choose the calendar…" options=${editable.map((c) => ({ value: c.id, label: `${c.id}: ${c.label}` }))} /></div>
          <div style="width:130px"><${Text} value=${date} onInput=${(v) => { setDate(v); setError(null); }} placeholder="YYYY-MM-DD" /></div>
          <${Button} busy=${Boolean(busy)} onClick=${add}>Add holiday<//>
          <span class="note">A change applies to dates worked out from then on. Dates entered by hand are shown in bold among the upcoming holidays.</span>
        </div>
        ${error ? html`<div style="margin-top:8px"><${ErrorNote} error=${error} /></div>` : null}
      </div>
    <//>
    <div class="cols-2" style="align-items:start">
      <${Panel} title="Payment calendar by currency" note="Used for FX value dates" flush>
        <div class="tablewrap"><table class="ledger fit"><thead><tr><th>Currency</th><th>Payment calendar</th></tr></thead><tbody>
          ${Object.entries(d.currencyCalendars).map(([ccy, id]) => html`<tr><td><span class="sym">${ccy}</span></td><td><b>${id}</b> <span class="muted">${d.calendars.find((c) => c.id === id)?.label || ''}</span></td></tr>`)}
          <tr><td class="nowrap">Any other currency</td><td><${Pill} tone="warn">weekends only<//> No payment calendar is built in. FX value dates in it use weekends only, and the preview flags them.</td></tr>
        </tbody></table></div>
        <p class="note" style="margin:0;padding:8px 12px">A spot FX value date counts business days of both currencies, and must itself be a business day for both and a US dollar banking day. The same table gives the calendar of an instrument with no venue country.</p>
      <//>
      <${Panel} title="How an instrument gets its calendar" note="First rule that applies" flush>
        <div class="tablewrap"><table class="ledger fit"><tbody>
          <tr><td class="nowrap">1. Set on the instrument</td><td>A trading, settlement or payment calendar set on the instrument is used as it is. Several joined with + make a joint calendar, open only when every one of them is open. Digital assets always trade and settle on every calendar day.</td></tr>
          <tr><td class="nowrap">2. Venue country</td><td>The country of the listing venue selects the market calendar. An instrument in a US market view with no country recorded uses the US calendars.</td></tr>
          <tr><td class="nowrap">3. Trading currency</td><td>With no venue country, the payment calendar of the settlement or trading currency is used, and the instrument says it was inferred.</td></tr>
          <tr><td class="nowrap">4. Weekends only</td><td>With no calendar for the country or the currency, dates use weekends only. This is never silent: the instrument, its ticket, the Marketplaces row and every trade preview say so.</td></tr>
          <tr><td class="nowrap">Payments</td><td>Coupons, interest, maturities and resets are paid on the payment calendar set on the instrument, or else its settlement calendar, always joined with the payment calendar of each currency paid.</td></tr>
        </tbody></table></div>
        <p class="note" style="margin:0;padding:8px 12px">Each instrument states its three calendars and how each was chosen under <a href="#/instruments">Instruments</a>. Set the venue country or the calendars there to change them.</p>
      <//>
    </div>
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
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Appearance, the market calendars used for settlement dates, the paper-desk assumptions of the current Book, and what this Terminal is.</div></div></div>
    <div class="stack">
      <div class="cols-2" style="align-items:start">
        <div class="stack"><${Appearance} />
          <${Panel} title=${`Book: ${book.name}`}>
            <div class="set-kv"><${KV} rows=${[['Reporting currency', html`<b>${book.reportingCcy}</b>`], ['Structure', `One Treasury, ${book.units.length - 1} Account${book.units.length === 2 ? '' : 's'}`]]} /></div>
            <p class="note" style="margin-top:8px">The reporting currency is set when a Book is created and cannot be changed afterwards: every ledger entry keeps its ${book.reportingCcy} amount at the FX rate of the day it was posted. To report in another currency, create a new Book. Rename the Book under <a href="#/books">Manage Books</a>; add Accounts under <a href="#/treasury">Treasury</a>.</p><//>
        </div>
        <${About} status=${status} />
      </div>
      <h2 id="market-calendars" style="margin-top:6px">Market calendars</h2>
      <${Calendars} today=${status.today} />
      <h2 style="margin-top:6px">Paper-desk assumptions</h2>
      <${Assumptions} book=${book} />
    </div>
  </div>`;
}
