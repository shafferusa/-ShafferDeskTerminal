// Product-specific contract forms. One schema per engine family drives the registry's
// "new instrument" form, the financing tickets in Books and Treasury, and bespoke legs on the
// Strategy page. A swap is entered leg by leg (side, type, currency, rate or index, schedule); it
// is never reduced to "buy/sell swap".
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { currentBook, fmtQty, get, isNum, unitLabel, useStore } from './core.js';
import { Button, Check, Field, Holdings, Num, Select, Text } from './ui.js';

const DAY_COUNTS = ['ACT/360', 'ACT/365', 'ACT/ACT', '30/360', '30E/360'].map((d) => ({ value: d, label: d }));
const yes = () => true;
const opt = (list) => list.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x }));

/**
 * Search-and-pick an instrument from the registry. Every match, and the picked instrument, shows
 * what the current Book already holds in it.
 */
export function InstrumentPicker({ value, onChange, families, placeholder = 'Type a ticker or name', disabled, showHeld = true }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const seq = useRef(0);
  const bookId = currentBook()?.id;
  const tick = useStore((s) => s.tick);
  const want = useRef(value);
  want.current = value;
  useEffect(() => {
    if (!value) { setPicked(null); return; }
    // A reply that arrives after the value was changed or cleared is dropped.
    get(`/api/instruments/${value}`, { bookId }).then((i) => { if (want.current === value) setPicked(i); }, () => { if (want.current === value) setPicked(null); });
  }, [value, bookId, tick]);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    get('/api/instruments', { q, limit: 60, bookId, arrangements: families?.some((f) => ['loan', 'repo', 'secloan'].includes(f)) ? '1' : undefined }).then((r) => {
      if (n !== seq.current) return;
      const list = r.items.filter((i) => !families || families.includes(i.family));
      // Instruments already held come first: they are the likeliest thing being looked for.
      setItems([...list.filter((i) => i.holdings), ...list.filter((i) => !i.holdings)].slice(0, 30));
    }, () => {});
  }, [q, open, bookId]);
  if (picked && !open) {
    return html`<div><div class="row" style="flex-wrap:nowrap"><div style="flex:1;min-width:0;height:30px;display:flex;align-items:center;padding:0 8px;border:1px solid var(--rule-strong);border-radius:4px;overflow:hidden;white-space:nowrap">
      <b style="margin-right:6px">${picked.symbol || picked.name}</b><span class="muted small" style="overflow:hidden;text-overflow:ellipsis">${picked.symbol ? picked.name : picked.support.productName}</span></div>
      <${Button} small disabled=${disabled} onClick=${() => { setOpen(true); setQ(''); }}>Change<//></div>
      ${showHeld && picked.holdings !== undefined ? html`<div class="hint" style="margin-top:3px"><${Holdings} h=${picked.holdings} detail /></div>` : null}</div>`;
  }
  return html`<div style="position:relative">
    <${Text} type="search" value=${q} onInput=${(v) => { setQ(v); setOpen(true); }} placeholder=${placeholder} disabled=${disabled} />
    ${!open ? html`<div style="position:absolute;inset:0;cursor:text" onClick=${() => setOpen(true)}></div>` : null}
    ${open ? html`<div class="picklist">
      ${items.length ? items.map((i) => html`<button class="pick" onClick=${() => { setPicked(i); setOpen(false); onChange(i.id, i); }}>
        <span class="what"><b>${i.symbol || i.name}</b> <span class="muted small">${i.symbol ? i.name : ''}, ${i.support.productName.replace(/ \(.*\)$/, '')}, ${i.tradingCcy}</span></span>
        ${showHeld ? html`<${Holdings} h=${i.holdings} />` : null}</button>`)
        : html`<div class="note" style="padding:8px 10px">Nothing in the registry matches. Reference-data search arrives with the Shaffer MarketData connection; register the instrument by hand under Instruments.</div>`}
      <div style="padding:4px 8px;border-top:1px solid var(--rule)"><button class="btn link small" onClick=${() => setOpen(false)}>Close</button></div></div>` : null}
  </div>`;
}

/** Pick one of a unit's open positions (optionally of given families or one instrument). */
export function PositionPicker({ value, onChange, bookId, unitId, families, instrumentId, direction, placeholder = 'Choose a position' }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    if (!bookId || !unitId) return;
    get(`/api/books/${bookId}/accounting/positions`, { scope: unitId }).then((r) => {
      setRows(r.positions.filter((p) => (!families || families.includes(p.family)) && (!instrumentId || p.instrument.id === instrumentId) && (!direction || (direction === 'long' ? p.qty > 0 : p.qty < 0))));
    }, () => setRows([]));
  }, [bookId, unitId, instrumentId]);
  return html`<${Select} value=${value} onChange=${(v) => onChange(v, rows.find((p) => p.positionId === v))} placeholder=${rows.length ? placeholder : 'No matching position in this Account'}
    options=${rows.map((p) => ({ value: p.positionId, label: `${p.instrument.symbol || p.instrument.name}: ${fmtQty(p.qty)}${p.strategy ? ` (${p.strategy.name})` : ''}` }))} />`;
}

// ---- field schemas ----------------------------------------------------------------------------------------
// path: where the value lives in the draft: 'terms.x', 'terms.a.b', or a top-level key.
const F = {
  security: [
    { path: 'terms.lotSize', label: 'Lot size', type: 'number', hint: 'Optional' },
    { path: 'multiplier', label: 'Multiplier', type: 'number', hint: 'Value per unit of price. Usually 1.', show: (d) => ['manual', 'spot'].includes(d.family) },
    { path: 'terms.settleDays', label: 'Settlement lag (business days)', type: 'number', hint: 'Leave empty for the Book default' },
  ],
  option: [
    { path: 'underlyingId', label: 'Underlying', type: 'instrument', families: ['equity', 'fund', 'future', 'spot', 'crypto', 'bond'], span: 2, required: true },
    { path: 'terms.right', label: 'Type', type: 'select', options: opt([['C', 'Call'], ['P', 'Put']]), required: true },
    { path: 'terms.strike', label: 'Strike', type: 'number', required: true },
    { path: 'terms.expiration', label: 'Expiration', type: 'date', required: true },
    { path: 'terms.exercise', label: 'Exercise style', type: 'select', options: opt([['american', 'American'], ['european', 'European']]), default: 'american' },
    { path: 'terms.settlement', label: 'Settlement', type: 'select', options: opt([['physical', 'Physical delivery'], ['cash', 'Cash']]), default: 'physical' },
    { path: 'multiplier', label: 'Premium multiplier per contract', type: 'number', required: true, hint: 'Not assumed. 100 for a standard US equity option.' },
    { path: 'terms.deliverable.units', label: 'Deliverable units per contract', type: 'number', hint: 'Defaults to the multiplier; to 1 future for an option on a future' },
  ],
  otcoption: [
    { path: 'underlyingId', label: 'Underlying instrument', type: 'instrument', span: 2, hint: 'Or name a rate fixing instead' },
    { path: 'terms.fixingRate', label: 'Fixing rate code', type: 'text', hint: 'For options on a rate' },
    { path: 'terms.right', label: 'Type', type: 'select', options: opt([['C', 'Call'], ['P', 'Put']]), required: true },
    { path: 'terms.strike', label: 'Strike', type: 'number', required: true },
    { path: 'terms.expiration', label: 'Expiration', type: 'date', required: true },
    { path: 'terms.optionType', label: 'Payoff', type: 'select', default: 'vanilla', options: opt([['vanilla', 'Vanilla'], ['digital', 'Digital (cash or nothing)'], ['barrier', 'Barrier'], ['asian', 'Asian (manual settlement)'], ['lookback', 'Lookback (manual settlement)'], ['basket', 'Basket (manual settlement)'], ['spread', 'Spread (manual settlement)'], ['quanto', 'Quanto (manual settlement)'], ['compound', 'Compound (manual settlement)'], ['swaption', 'Swaption (manual exercise)']]) },
    { path: 'terms.payout', label: 'Digital payout per unit', type: 'number', show: (d) => d.terms.optionType === 'digital' },
    { path: 'terms.barrier.type', label: 'Barrier', type: 'select', options: opt([['up-in', 'Up and in'], ['up-out', 'Up and out'], ['down-in', 'Down and in'], ['down-out', 'Down and out']]), show: (d) => d.terms.optionType === 'barrier' },
    { path: 'terms.barrier.level', label: 'Barrier level', type: 'number', show: (d) => d.terms.optionType === 'barrier' },
    { path: 'terms.exercise', label: 'Exercise style', type: 'select', options: opt([['european', 'European'], ['american', 'American']]), default: 'european' },
    { path: 'terms.settlement', label: 'Settlement', type: 'select', options: opt([['cash', 'Cash'], ['physical', 'Physical delivery']]), default: 'cash' },
    { path: 'multiplier', label: 'Multiplier', type: 'number', hint: 'Usually 1: quantity is underlying units' },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
    { path: 'terms.collateralBasis', type: 'collateral' },
    { path: 'terms.collateral', label: 'Other collateral terms', type: 'text', span: 2, hint: 'Free text. Recorded, not simulated.' },
  ],
  future: [
    { path: 'underlyingId', label: 'Underlying', type: 'instrument', span: 2, hint: 'Optional' },
    { path: 'terms.root', label: 'Contract root', type: 'text', hint: 'Shared by all months of one contract' },
    { path: 'terms.perpetual', label: 'Perpetual (no expiry)', type: 'check' },
    { path: 'terms.expiration', label: 'Last trading day', type: 'date', show: (d) => !d.terms.perpetual, required: true },
    { path: 'multiplier', label: 'Contract multiplier (point value)', type: 'number', required: true },
    { path: 'terms.tickSize', label: 'Tick size', type: 'number' },
    { path: 'terms.initialMargin', label: 'Initial margin per contract', type: 'number', hint: 'From contract data. None is posted if left empty.' },
    { path: 'terms.settlement', label: 'Settlement', type: 'select', options: opt([['cash', 'Cash'], ['physical', 'Physical (closed out in cash here)']]), default: 'cash' },
    { path: 'terms.priceUnits', label: 'Quoted in', type: 'text', span: 2, hint: 'The unit of its price, shown on the ticket: index points, % of par, 100 minus the rate, JPY per EUR, USD per barrel. "Contract price" if left empty.' },
  ],
  fx: [
    { path: 'terms.base', label: 'Base currency', type: 'text', required: true },
    { path: 'terms.quote', label: 'Quote currency', type: 'text', required: true },
    { path: 'terms.settleDays', label: 'Spot settlement lag', type: 'number', default: 2 },
  ],
  forward: [
    { path: 'terms.forwardType', label: 'Kind of forward', type: 'select', required: true, options: opt([['fx', 'Deliverable FX forward'], ['ndf', 'Non-deliverable forward'], ['asset', 'Forward on an asset'], ['fra', 'Forward-rate agreement']]) },
    { path: 'terms.base', label: 'Base currency', type: 'text', show: (d) => ['fx', 'ndf'].includes(d.terms.forwardType) },
    { path: 'terms.quote', label: 'Quote currency', type: 'text', show: (d) => ['fx', 'ndf'].includes(d.terms.forwardType) },
    { path: 'terms.valueDate', label: 'Value date', type: 'date', show: (d) => d.terms.forwardType !== 'fra', required: true },
    { path: 'terms.fixingDate', label: 'Fixing date', type: 'date', show: (d) => d.terms.forwardType === 'ndf' },
    { path: 'terms.settleCcy', label: 'Settlement currency', type: 'text', show: (d) => d.terms.forwardType === 'ndf' },
    { path: 'underlyingId', label: (d) => (d.terms.forwardType === 'ndf' ? 'Fixing source (currency pair)' : 'Underlying'), type: 'instrument', span: 2, show: (d) => ['ndf', 'asset'].includes(d.terms.forwardType) },
    { path: 'terms.settlement', label: 'Settlement', type: 'select', options: opt([['cash', 'Cash against a fixing'], ['physical', 'Physical delivery']]), show: (d) => d.terms.forwardType === 'asset' },
    { path: 'multiplier', label: 'Multiplier', type: 'number', show: (d) => d.terms.forwardType === 'asset' },
    { path: 'terms.periodStart', label: 'Interest period start', type: 'date', show: (d) => d.terms.forwardType === 'fra' },
    { path: 'terms.periodEnd', label: 'Interest period end', type: 'date', show: (d) => d.terms.forwardType === 'fra' },
    { path: 'terms.fixingRate', label: 'Reference rate code', type: 'text', show: (d) => d.terms.forwardType === 'fra' },
    { path: 'terms.dayCount', label: 'Day count', type: 'select', options: DAY_COUNTS, show: (d) => d.terms.forwardType === 'fra' },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
    { path: 'terms.collateralBasis', type: 'collateral' },
    { path: 'terms.collateral', label: 'Other collateral terms', type: 'text', span: 2, hint: 'Free text. Recorded, not simulated.' },
  ],
  bond: [
    { path: 'terms.couponType', label: 'Coupon', type: 'select', default: 'fixed', options: opt([['fixed', 'Fixed'], ['zero', 'Zero coupon / discount'], ['float', 'Floating']]) },
    { path: 'terms.couponRate', label: 'Coupon rate (decimal)', type: 'number', hint: '0.045 = 4.5%', show: (d) => d.terms.couponType === 'fixed', required: true },
    { path: 'terms.referenceRate', label: 'Reference rate code', type: 'text', show: (d) => d.terms.couponType === 'float' },
    { path: 'terms.spread', label: 'Spread (decimal)', type: 'number', show: (d) => d.terms.couponType === 'float' },
    { path: 'terms.currentCoupon', label: 'Current coupon (decimal)', type: 'number', hint: 'From the last fixing, if known', show: (d) => d.terms.couponType === 'float' },
    { path: 'terms.frequency', label: 'Payments per year', type: 'select', default: 2, options: opt([[1, 'Annual'], [2, 'Semi-annual'], [4, 'Quarterly'], [12, 'Monthly']]), show: (d) => d.terms.couponType !== 'zero' },
    { path: 'terms.perpetual', label: 'Perpetual (no maturity)', type: 'check' },
    { path: 'terms.maturity', label: 'Maturity', type: 'date', show: (d) => !d.terms.perpetual, required: true },
    { path: 'terms.anchorDate', label: 'A coupon date', type: 'date', show: (d) => d.terms.perpetual },
    { path: 'terms.issueDate', label: 'Issue (dated) date', type: 'date' },
    { path: 'terms.dayCount', label: 'Day count', type: 'select', options: DAY_COUNTS, default: 'ACT/ACT' },
    { path: 'terms.redemption', label: 'Redemption (% of par)', type: 'number', default: 100 },
    { path: 'terms.factor', label: 'Pool factor', type: 'number', hint: 'For securitised paper. 1 otherwise.' },
    { path: 'terms.minDenomination', label: 'Minimum denomination (face)', type: 'number', hint: 'A trade must be a multiple of it. 1 if left empty.' },
    { path: 'terms.seniority', label: 'Seniority', type: 'text' },
  ],
  loan: [
    { path: 'terms.loanType', label: 'Arrangement', type: 'select', default: 'unsecured', options: opt([['unsecured', 'Unsecured'], ['margin', 'Margin loan'], ['secured', 'Secured'], ['deposit', 'Deposit'], ['cd', 'Certificate of deposit'], ['facility', 'Credit facility drawing']]) },
    { path: 'terms.rateType', label: 'Rate', type: 'select', default: 'fixed', options: opt([['fixed', 'Fixed'], ['floating', 'Floating']]) },
    { path: 'terms.rate', label: 'Rate (decimal a year)', type: 'number', hint: '0.05 = 5%. Not assumed for you.', show: (d) => d.terms.rateType !== 'floating', required: true },
    { path: 'terms.referenceRate', label: 'Reference rate code', type: 'text', show: (d) => d.terms.rateType === 'floating' },
    { path: 'terms.spread', label: 'Spread (decimal)', type: 'number', show: (d) => d.terms.rateType === 'floating' },
    { path: 'terms.dayCount', label: 'Day count', type: 'select', options: opt(['ACT/360', 'ACT/365']), default: 'ACT/360' },
    { path: 'terms.maturity', label: 'Maturity', type: 'date', hint: 'Leave empty for open-ended' },
    { path: 'terms.interestPayment', label: 'Interest paid', type: 'select', default: 'maturity', options: opt([['maturity', 'At maturity'], ['monthly', 'Monthly']]), show: (d) => Boolean(d.terms.maturity), },
    { path: 'terms._openEnded', label: 'Interest paid', type: 'note', text: 'Monthly, because an open-ended arrangement has no maturity to pay at.', show: (d) => !d.terms.maturity },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
  ],
  repo: [
    { path: 'terms.collateralInstrumentId', label: 'Collateral security', type: 'instrument', families: ['bond', 'equity', 'fund'], span: 2, required: true },
    { path: 'terms.collateralQty', label: 'Collateral quantity', type: 'number', required: true },
    { path: 'terms.haircut', label: 'Haircut (decimal)', type: 'number', hint: '0.02 = 2%', default: 0.02 },
    { path: 'terms.rateType', label: 'Repo rate', type: 'select', default: 'fixed', options: opt([['fixed', 'Fixed'], ['floating', 'Floating']]) },
    { path: 'terms.rate', label: 'Rate (decimal a year)', type: 'number', hint: 'Not assumed for you', show: (d) => d.terms.rateType !== 'floating', required: true },
    { path: 'terms.referenceRate', label: 'Reference rate code', type: 'text', show: (d) => d.terms.rateType === 'floating' },
    { path: 'terms.spread', label: 'Spread (decimal)', type: 'number', show: (d) => d.terms.rateType === 'floating' },
    { path: 'terms.term', label: 'Term', type: 'select', default: 'term', options: opt([['overnight', 'Overnight'], ['term', 'Term'], ['open', 'Open']]) },
    { path: 'terms.endDate', label: 'End date', type: 'date', show: (d) => d.terms.term === 'term' },
    { path: 'terms.style', label: 'Structure', type: 'select', default: 'classic', options: opt([['classic', 'Classic repo'], ['buy_sell_back', 'Buy/sell-back']]) },
    { path: 'terms.collateralType', label: 'Collateral type', type: 'select', default: 'gc', options: opt([['gc', 'General collateral'], ['special', 'Special']]) },
    { path: 'terms.triparty', label: 'Tri-party', type: 'check' },
    { path: 'terms.agent', label: 'Tri-party agent', type: 'text', show: (d) => d.terms.triparty },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
  ],
  secloan: [
    { path: 'underlyingId', label: 'Security', type: 'instrument', families: ['equity', 'fund', 'bond'], span: 2, required: true },
    { path: 'terms.feeRate', label: 'Fee (decimal a year)', type: 'number', hint: '0.005 = 0.5%. Not assumed for you.', required: true },
    { path: 'terms.collateralPct', label: 'Cash collateral (share of value)', type: 'number', default: 1.02, hint: '1.02 = 102%' },
    { path: 'terms.collateralAmount', label: 'Collateral amount', type: 'number', hint: 'Only if no price is available' },
    { path: 'terms.recallable', label: 'Recallable', type: 'check', default: true },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
  ],
  swap: [
    { path: 'terms.effective', label: 'Effective date', type: 'date', required: true },
    { path: 'terms.maturity', label: 'Maturity', type: 'date', required: true },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
    { path: 'terms.collateralBasis', type: 'collateral' },
    { path: 'terms.collateral', label: 'Other collateral terms', type: 'text', span: 2, hint: 'Free text. Recorded, not simulated.' },
    { path: 'terms.legs', type: 'legs' },
  ],
  cds: [
    { path: 'terms.referenceEntity', label: 'Reference entity or index', type: 'text', span: 2, required: true },
    { path: 'terms.coupon', label: 'Running coupon (decimal)', type: 'number', hint: '0.01 = 100 bp', required: true },
    { path: 'terms.effective', label: 'Effective date', type: 'date' },
    { path: 'terms.maturity', label: 'Maturity', type: 'date', required: true },
    { path: 'terms.recovery', label: 'Recovery assumption', type: 'number', default: 0.4 },
    { path: 'terms.indexFactor', label: 'Index factor', type: 'number', hint: 'For index CDS. 1 otherwise.' },
    { path: 'terms.seniority', label: 'Seniority', type: 'text' },
    { path: 'terms.counterparty', label: 'Counterparty', type: 'text' },
    { path: 'terms.collateralBasis', type: 'collateral' },
    { path: 'terms.collateral', label: 'Other collateral terms', type: 'text', span: 2, hint: 'Free text. Recorded, not simulated.' },
  ],
};
for (const f of ['equity', 'fund', 'spot', 'crypto', 'manual']) F[f] = F.security;
export const FAMILY_FIELDS = F;

const LEG_TYPES = opt([['fixed', 'Fixed rate'], ['float', 'Floating rate'], ['ois', 'Compounded overnight rate'], ['return', 'Return on a reference asset'], ['price', 'Price of a reference asset'], ['cap', 'Cap'], ['floor', 'Floor']]);
const MONTHS = opt([[0, 'At maturity only'], [1, 'Monthly'], [3, 'Quarterly'], [6, 'Semi-annual'], [12, 'Annual']]);

/** Starting legs for each swap product, so the ticket opens with the right structure. */
export function presetLegs(productId, ccy = 'USD') {
  const fixed = (side, extra = {}) => ({ side, type: 'fixed', ccy, rate: null, months: 6, dayCount: '30/360', ...extra });
  const float = (side, extra = {}) => ({ side, type: 'float', ccy, index: '', spread: 0, months: 3, dayCount: 'ACT/360', ...extra });
  switch (productId) {
    case 'ois': return [fixed('pay', { months: 12, dayCount: 'ACT/360' }), { side: 'receive', type: 'ois', ccy, index: '', spread: 0, months: 12, dayCount: 'ACT/360' }];
    case 'basis_swap': case 'cms_spread_swap': return [float('pay'), float('receive')];
    case 'cross_currency_swap': case 'cross_currency_basis_swap': case 'non_deliverable_swap':
      return [float('pay', { exchangeNotional: productId !== 'non_deliverable_swap' }), float('receive', { ccy: 'EUR', notionalFactor: 1, exchangeNotional: productId !== 'non_deliverable_swap' })];
    case 'zc_inflation_swap': return [fixed('pay', { months: 0 }), { side: 'receive', type: 'return', ccy, months: 0, underlyingId: '' }];
    case 'yoy_inflation_swap': return [fixed('pay', { months: 12 }), { side: 'receive', type: 'return', ccy, months: 12, underlyingId: '' }];
    case 'equity_swap': case 'equity_index_swap': case 'equity_basket_swap': case 'commodity_index_swap':
      return [{ side: 'receive', type: 'return', ccy, months: 3, underlyingId: '', resetNotional: false, passDividends: false }, float('pay')];
    case 'equity_trs': case 'bond_trs': case 'loan_trs': case 'index_trs':
      return [{ side: 'receive', type: 'return', ccy, months: 3, underlyingId: '', resetNotional: false, passDividends: true }, float('pay')];
    case 'commodity_swap': case 'energy_swap': case 'electricity_swap': case 'freight_swap': case 'dividend_swap':
      return [{ side: 'pay', type: 'price', ccy, months: 1, units: 1, fixedPrice: null }, { side: 'receive', type: 'price', ccy, months: 1, units: 1, underlyingId: '' }];
    case 'commodity_basis_swap': return [{ side: 'pay', type: 'price', ccy, months: 1, units: 1, underlyingId: '' }, { side: 'receive', type: 'price', ccy, months: 1, units: 1, underlyingId: '' }];
    case 'interest_rate_cap': return [{ side: 'receive', type: 'cap', ccy, index: '', strike: null, months: 3, dayCount: 'ACT/360' }];
    case 'interest_rate_floor': return [{ side: 'receive', type: 'floor', ccy, index: '', strike: null, months: 3, dayCount: 'ACT/360' }];
    case 'interest_rate_collar': return [{ side: 'receive', type: 'cap', ccy, index: '', strike: null, months: 3, dayCount: 'ACT/360' }, { side: 'pay', type: 'floor', ccy, index: '', strike: null, months: 3, dayCount: 'ACT/360' }];
    default: return [fixed('pay'), float('receive')];
  }
}

function LegsEditor({ legs, onChange, ccy }) {
  const set = (i, patch) => onChange(legs.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return html`<div class="span-all stack">
    <div class="row"><h4>Legs</h4><span class="note">Each leg states who pays, what, in which currency and on what schedule. "Enter as written" takes the sides as stated here.</span></div>
    ${legs.map((l, i) => html`<div class="panel"><header><b>Leg ${String.fromCharCode(65 + i)}</b><span class="grow"></span>${legs.length > 1 ? html`<${Button} small onClick=${() => onChange(legs.filter((_, k) => k !== i))}>Remove<//>` : null}</header>
      <div class="body grid-form">
        <${Field} label="Side"><${Select} value=${l.side} onChange=${(v) => set(i, { side: v })} options=${opt([['pay', 'Pay'], ['receive', 'Receive']])} /><//>
        <${Field} label="Leg type"><${Select} value=${l.type} onChange=${(v) => set(i, { type: v })} options=${LEG_TYPES} /><//>
        <${Field} label="Currency"><${Text} value=${l.ccy} onInput=${(v) => set(i, { ccy: v.toUpperCase() })} /><//>
        <${Field} label="Notional factor" hint="1 = the trade notional"><${Num} value=${l.notionalFactor ?? 1} onInput=${(v) => set(i, { notionalFactor: v })} /><//>
        ${l.type === 'fixed' ? html`<${Field} label="Fixed rate (decimal)" hint="0.04 = 4%"><${Num} value=${l.rate} onInput=${(v) => set(i, { rate: v })} /><//>` : null}
        ${['float', 'ois', 'cap', 'floor'].includes(l.type) ? html`<${Field} label="Index (rate code)" hint="Financing benchmark"><${Text} value=${l.index} onInput=${(v) => set(i, { index: v })} /><//>` : null}
        ${['float', 'ois'].includes(l.type) ? html`<${Field} label="Spread (decimal)"><${Num} value=${l.spread} onInput=${(v) => set(i, { spread: v })} /><//>` : null}
        ${['cap', 'floor'].includes(l.type) ? html`<${Field} label="Strike rate (decimal)"><${Num} value=${l.strike} onInput=${(v) => set(i, { strike: v })} /><//>` : null}
        ${['return', 'price'].includes(l.type) ? html`<${Field} label="Reference asset" span=${2}><${InstrumentPicker} value=${l.underlyingId} onChange=${(v) => set(i, { underlyingId: v })} /><//>` : null}
        ${l.type === 'price' ? html`<${Field} label="Units per unit of notional"><${Num} value=${l.units} onInput=${(v) => set(i, { units: v })} /><//>
          <${Field} label="Fixed price" hint="Leave empty for the floating price"><${Num} value=${l.fixedPrice} onInput=${(v) => set(i, { fixedPrice: v })} /><//>` : null}
        <${Field} label=${['return', 'price'].includes(l.type) ? 'Reset and payment' : 'Payment'}><${Select} value=${l.months} onChange=${(v) => set(i, { months: Number(v) })} options=${MONTHS} /><//>
        ${!['return', 'price'].includes(l.type) ? html`<${Field} label="Day count"><${Select} value=${l.dayCount} onChange=${(v) => set(i, { dayCount: v })} options=${DAY_COUNTS} /><//>` : null}
        ${l.type === 'return' ? html`<${Field} label="Options"><${Check} checked=${l.passDividends} onChange=${(v) => set(i, { passDividends: v })}>Total return (pass income through)<//><${Check} checked=${l.resetNotional} onChange=${(v) => set(i, { resetNotional: v })}>Notional resets<//><//>` : null}
        ${['fixed', 'float', 'ois'].includes(l.type) ? html`<${Field} label="Notional"><${Check} checked=${l.exchangeNotional} onChange=${(v) => set(i, { exchangeNotional: v })}>Exchanged at start and maturity<//><//>` : null}
      </div></div>`)}
    <div><${Button} small onClick=${() => onChange([...legs, { side: 'receive', type: 'float', ccy: ccy || 'USD', index: '', spread: 0, months: 3, dayCount: 'ACT/360' }])}>Add a leg<//></div>
  </div>`;
}

const BASIS_OPTIONS = opt([['agreement', 'Under a collateral agreement of this Book'], ['position', 'Position-level terms, entered here'], ['uncollateralized', 'Uncollateralized (paper assumption)']]);
const IA_OPTIONS = opt([['none', 'None'], ['pct', 'Share of notional'], ['fixed', 'Fixed amount']]);

/**
 * The "Collateral terms" group of an OTC contract (swap, credit default swap, forward, OTC option).
 * The contract states one basis: an agreement of the selected Book, terms entered here, or the
 * explicit choice of no collateral. Nothing is pre-selected and nothing is assumed from the product.
 * value: null | { type: 'agreement', agreementId } | { type: 'position', independentAmount, variationMargin, threshold, minimumTransfer } | { type: 'uncollateralized' }
 */
export function CollateralBasisFields({ value, onChange, ccy, legacyPct, unitId }) {
  const bookId = currentBook()?.id;
  const inUse = useStore((s) => s.unitId);
  const tick = useStore((s) => s.tick);
  const [agreements, setAgreements] = useState(null);
  useEffect(() => {
    if (!bookId) return;
    get(`/api/books/${bookId}/agreements`).then((r) => setAgreements(r.items.filter((a) => a.status === 'active')), () => setAgreements([]));
  }, [bookId, tick]);
  const v = value || {};
  const unit = currentBook()?.units.find((u) => u.id === (unitId || inUse));
  const set = (patch) => onChange({ ...v, ...patch });
  const ia = v.independentAmount || { type: 'none' };
  const picked = (agreements || []).find((a) => a.id === v.agreementId);
  const covers = (a) => !unit || a.unitIds.includes(unit.id);
  const pick = (type) => onChange(!type ? null : type === 'position' ? { type, independentAmount: { type: 'none' }, variationMargin: false, threshold: 0, minimumTransfer: 0 } : { type });
  return html`<div class="span-all coll-terms">
    <div class="row"><h4>Collateral terms</h4><span class="note">Collateral follows what is chosen here and nothing else. No rule is applied because of the product.</span></div>
    <div class="grid-form">
      <${Field} label=${html`Collateral basis <span class="muted">(required)</span>`} span=${2}
        hint=${!v.type && isNum(legacyPct) ? `This contract carries an independent amount of ${(legacyPct * 100).toFixed(2)}% from the older field. It applies as position-level terms unless a basis is chosen here.` : !v.type ? 'A new position cannot be previewed until one of the three is chosen.' : undefined}>
        <${Select} value=${v.type || ''} onChange=${pick} options=${BASIS_OPTIONS} placeholder="Choose…" /><//>
      ${v.type === 'agreement' ? html`<${Field} label=${html`Agreement <span class="muted">(required)</span>`} span=${2}
          hint=${agreements && !agreements.length ? html`This Book has no active agreement. Record one under <a href="#/treasury/collateral">Treasury, Collateral</a>, then choose it here.` : picked && !covers(picked) ? `${picked.name} does not cover ${unitLabel(unit)}. Add ${unitLabel(unit)} to the agreement, or trade from a unit it covers.` : undefined}>
          <${Select} value=${v.agreementId || ''} onChange=${(id) => set({ agreementId: id })} placeholder=${agreements === null ? 'Loading agreements…' : 'Choose…'}
            options=${(agreements || []).map((a) => ({ value: a.id, label: `${a.name}, ${a.counterparty} (${a.kindLabel})${covers(a) ? '' : `, does not cover ${unitLabel(unit)}`}` }))} /><//>
        ${picked ? html`<div class="span-all note">${picked.summary}${picked.termRows.some((r) => !r.simulated) ? ` ${picked.termRows.filter((r) => !r.simulated).length} of its terms are recorded, not simulated: see the agreement.` : ''}</div>` : null}` : null}
      ${v.type === 'position' ? html`
        <${Field} label="Independent amount"><${Select} value=${ia.type || 'none'} onChange=${(t) => set({ independentAmount: { type: t } })} options=${IA_OPTIONS} /><//>
        ${ia.type === 'pct' ? html`<${Field} label="Share of notional (decimal)" hint="0.05 = 5%. Posted in cash when the position opens, returned when it ends."><${Num} value=${ia.pct ?? null} onInput=${(x) => set({ independentAmount: { type: 'pct', pct: x } })} /><//>` : null}
        ${ia.type === 'fixed' ? html`<${Field} label=${`Amount${ccy ? ` (${ccy})` : ''}`} hint="Posted in cash when the position opens, returned when it ends."><${Num} value=${ia.amount ?? null} onInput=${(x) => set({ independentAmount: { type: 'fixed', amount: x } })} /><//>` : null}
        <${Field} label="Variation margin"><${Check} checked=${Boolean(v.variationMargin)} onChange=${(x) => set({ variationMargin: x })}>Exchanged each end of day against the mark<//><//>
        ${v.variationMargin ? html`<${Field} label=${`Threshold${ccy ? ` (${ccy})` : ''}`} hint="No call while the mark is inside it"><${Num} value=${v.threshold ?? 0} onInput=${(x) => set({ threshold: x })} /><//>
          <${Field} label=${`Minimum transfer amount${ccy ? ` (${ccy})` : ''}`} hint="Smaller transfers are not made"><${Num} value=${v.minimumTransfer ?? 0} onInput=${(x) => set({ minimumTransfer: x })} /><//>` : null}
        <div class="span-all note">Posted and received in ${ccy || 'the contract currency'} cash by the unit that holds the position. This position is its own netting set.</div>` : null}
      ${v.type === 'uncollateralized' ? html`<div class="span-all note">Nothing is posted and nothing is received on this contract, whatever its mark. It is recorded on the position as an explicit paper assumption.</div>` : null}
    </div></div>`;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = { ...obj };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) { cur[keys[i]] = { ...(cur[keys[i]] || {}) }; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = value;
  return out;
}

/**
 * Renders the family's contract fields for a draft of shape
 * { productId, family, name, tradingCcy, underlyingId, multiplier, terms: {...}, ... }.
 * `skip` hides paths the caller sets itself.
 */
export function ContractFields({ draft, onChange, skip = [] }) {
  const fields = (F[draft.family] || []).filter((f) => !skip.includes(f.path) && (f.show || yes)(draft));
  return fields.map((f) => {
    const v = getPath(draft, f.path);
    const set = (x) => onChange(setPath(draft, f.path, x));
    const label = typeof f.label === 'function' ? f.label(draft) : f.label;
    if (f.type === 'legs') return html`<${LegsEditor} legs=${v || []} ccy=${draft.tradingCcy} onChange=${set} />`;
    if (f.type === 'collateral') return html`<${CollateralBasisFields} value=${v} onChange=${set} ccy=${draft.tradingCcy} legacyPct=${draft.terms?.initialMarginPct} />`;
    if (f.type === 'note') return html`<${Field} label=${label}><div class="note" style="padding-top:6px">${f.text}</div><//>`;
    const req = f.required ? html`${label} <span class="muted">(required)</span>` : label;
    if (f.type === 'instrument') return html`<${Field} label=${req} hint=${f.hint} span=${f.span}><${InstrumentPicker} value=${v} onChange=${set} families=${f.families} /><//>`;
    if (f.type === 'select') return html`<${Field} label=${req} hint=${f.hint} span=${f.span}><${Select} value=${v ?? f.default ?? ''} onChange=${(x) => set(f.options.some((o) => typeof o.value === 'number') ? Number(x) : x)} options=${f.options} placeholder=${f.default === undefined ? 'Choose…' : undefined} /><//>`;
    if (f.type === 'check') return html`<${Field} label=${label} hint=${f.hint}><${Check} checked=${v ?? f.default ?? false} onChange=${set}>Yes<//><//>`;
    if (f.type === 'number') return html`<${Field} label=${req} hint=${f.hint} span=${f.span}><${Num} value=${v ?? null} onInput=${set} placeholder=${f.default !== undefined ? String(f.default) : ''} /><//>`;
    return html`<${Field} label=${req} hint=${f.hint} span=${f.span}><${Text} type=${f.type === 'date' ? 'date' : 'text'} value=${v ?? ''} onInput=${(x) => set(f.type === 'text' && /Ccy|base|quote/.test(f.path) ? x.toUpperCase() : x)} /><//>`;
  });
}

/** A new draft for a catalog product, with sensible structural defaults (never rates or prices). */
export function newDraft(product, preset = {}) {
  const d = { productId: product.id, family: product.family, name: '', symbol: '', marketView: preset.marketView || (product.cls === 'deriv' ? 'US_DERIV' : 'US_CASH'), venueType: ['option', 'future', 'equity', 'fund'].includes(product.family) ? 'exchange' : 'otc', tradingCcy: preset.tradingCcy || 'USD', underlyingId: preset.underlyingId || '', multiplier: null, terms: {}, ...preset };
  d.terms = { ...(preset.terms || {}) };
  for (const f of F[product.family] || []) if (f.default !== undefined && getPath(d, f.path) === undefined) Object.assign(d, setPath(d, f.path, f.default));
  if (product.family === 'swap' && !d.terms.legs) d.terms.legs = presetLegs(product.id, d.tradingCcy);
  if (product.family === 'forward' && !d.terms.forwardType) d.terms.forwardType = { fx_forward: 'fx', fx_swap: 'fx', ndf: 'ndf', fra: 'fra' }[product.id] || 'asset';
  if (product.family === 'bond' && ['treasury_bill', 'strips', 'zero_coupon_bond', 'commercial_paper', 'abcp', 'bankers_acceptance', 'foreign_gov_bill'].includes(product.id)) d.terms.couponType = 'zero';
  if (product.family === 'bond' && ['floating_rate_note', 'syndicated_loan', 'leveraged_loan', 'clo'].includes(product.id)) d.terms.couponType = 'float';
  if (product.family === 'otcoption') d.terms.optionType = { digital_option: 'digital', barrier_option: 'barrier', asian_option: 'asian', lookback_option: 'lookback', basket_option: 'basket', spread_option: 'spread', quanto_option: 'quanto', compound_option: 'compound', swaption: 'swaption', cds_swaption: 'swaption' }[product.id] || 'vanilla';
  if (product.family === 'loan') d.terms.loanType = { margin_loan: 'margin', secured_loan: 'secured', securities_backed_loan: 'secured', bank_deposit: 'deposit', term_deposit: 'deposit', certificate_of_deposit: 'cd', revolving_credit_facility: 'facility' }[product.id] || 'unsecured';
  return d;
}

/** The request body for POST /api/instruments, or a leg's `contract`. */
export function draftToContract(d) {
  const terms = JSON.parse(JSON.stringify(d.terms || {}));
  return {
    productId: d.productId, name: d.name, symbol: d.symbol || undefined, marketView: d.marketView, venueType: d.venueType, venue: d.venue || undefined, venueCountry: d.venueCountry || undefined,
    issuer: d.issuer || undefined, domicile: d.domicile || undefined, underlyingGeo: d.underlyingGeo || undefined, underlyingId: d.underlyingId || undefined,
    tradingCcy: (d.tradingCcy || '').toUpperCase(), settleCcy: d.settleCcy ? d.settleCcy.toUpperCase() : undefined, multiplier: d.multiplier ?? undefined, tags: d.tags || [], externalIds: d.externalIds || {}, terms,
  };
}
