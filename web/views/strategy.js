// Strategy page.
//
// Builds a package from an execution template: choose the Book's Account, the instrument, the
// template, the amount and the contract parameters; the page asks Shaffer Hedge for the
// applicable hedge package, and everything goes through one preview and one confirmation.
//
// Execution templates only assemble legs. Investment Strategies, Models and signals belong to
// Shaffer Analytics Lab: a signal may fill in this form, but the package still passes every
// borrow, funding, collateral and per-leg check before it can be confirmed.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js';
import { fmtMoney, fmtNum, fmtPrice, fmtQty, fmtTime, get, isNum, openOverlay, post, useLive } from '../lib/core.js';
import { Awaiting, Button, Check, Empty, ErrorNote, Field, Missing, Modal, Notice, Num, Panel, Pill, Price, Prov, Seg, Select, Signed, StrategyStatus, Table, Text } from '../lib/ui.js';
import { ContractFields, draftToContract, InstrumentPicker, newDraft, PositionPicker } from '../lib/contracts.js';
import { defaultUnit, HedgeContext, hedgeContextInput, OrderFields, UnitSelect } from './instrument.js';
import { PreviewModal } from './preview.js';
import { PackageDetail, PackageList, RequestState, RequestSummary, SCOPES, usePackagePreview } from './hedge.js';

const STOCK = 'stock', OPT = 'options', FUT = 'futures';
const SECURITIES = ['equity', 'fund', 'spot', 'crypto', 'bond', 'manual'];
const SHORT_SIDE = ['protective_call', 'covered_put', 'short_collar'];
const STRIKE_LABEL = { put: 'Put strike', call: 'Call strike', lower: 'Lower strike', upper: 'Upper strike', middle: 'Strike', wingLower: 'Lower wing (put bought)', wingUpper: 'Upper wing (call bought)', near: 'Near-dated strike (sold)', far: 'Far-dated strike (bought)' };
const STRIKE_OVERRIDE = {
  long_collar: { put: 'Put strike (bought)', call: 'Call strike (sold)' }, short_collar: { put: 'Put strike (sold)', call: 'Call strike (bought)' },
  iron_condor: { put: 'Inner put (sold)', call: 'Inner call (sold)' }, iron_butterfly: { middle: 'Middle strike (call and put sold)' },
  long_butterfly: { lower: 'Lower strike (bought)', middle: 'Middle strike (two sold)', upper: 'Upper strike (bought)' },
  bull_call_spread: { lower: 'Lower strike (bought)', upper: 'Upper strike (sold)' }, bear_put_spread: { lower: 'Lower strike (sold)', upper: 'Upper strike (bought)' },
  bull_put_spread: { lower: 'Lower strike (bought)', upper: 'Upper strike (sold)' }, bear_call_spread: { lower: 'Lower strike (sold)', upper: 'Upper strike (bought)' },
};
const ACTION_LABEL = { buy: 'Buy', sell: 'Sell', sell_short: 'Sell short', buy_to_cover: 'Buy to cover' };
const CONTRACT_ACTIONS = {
  swap: [['buy', 'Enter as written'], ['sell', 'Enter the opposite side']], cds: [['buy', 'Buy protection (pay premium)'], ['sell', 'Sell protection (receive premium)']],
  forward: [['buy', 'Buy forward'], ['sell', 'Sell forward']], otcoption: [['buy', 'Buy'], ['sell', 'Sell / write']],
};
const EMPTY_ORDER = { orderType: 'market', limitPrice: null, stopPrice: null, tif: 'day' };
let legKey = 0;

// ---- option parameters -------------------------------------------------------------------------------
function OptionParams({ und, tpl, o, set, usesStock }) {
  const chain = useLive(() => (und ? get(`/api/instruments/${und.id}/chain`, { expiration: o.expiration }) : null), [und?.id, o.expiration], { interval: false });
  const d = chain.data;
  const has = Boolean(d?.available);
  const strikes = has ? d.chain.strikes : [];
  const exps = has ? d.chain.expirations : [];
  const spot = has ? d.chain.underlying.price : null;
  const labelOf = (k) => STRIKE_OVERRIDE[tpl.id]?.[k] || STRIKE_LABEL[k] || k;
  const setStrike = (k, v) => set({ strikes: { ...o.strikes, [k]: v } });
  const spec = o.contractSpec;
  if (!und) return html`<p class="note">Choose the instrument first; expirations and strikes are listed from its option chain.</p>`;
  return html`<div class="stack">
    ${d && !has ? html`<${Awaiting} compact what="No option chain is available for this underlying. Enter the expiration and strikes by hand, and give the contract's own multiplier and deliverable: the Terminal does not assume 100 shares per contract." />` : null}
    <div class="grid-form">
      <${Field} label=${tpl.needs.includes('farExpiration') ? 'Near expiration (sold)' : 'Expiration'}>
        ${has ? html`<${Select} value=${o.expiration} onChange=${(v) => set({ expiration: v })} options=${exps.map((e) => ({ value: e, label: e }))} placeholder="Choose…" />` : html`<${Text} type="date" value=${o.expiration} onInput=${(v) => set({ expiration: v })} />`}<//>
      ${tpl.needs.includes('farExpiration') ? html`<${Field} label="Far expiration (bought)">
        ${has ? html`<${Select} value=${o.farExpiration} onChange=${(v) => set({ farExpiration: v })} options=${exps.filter((e) => !o.expiration || e > o.expiration).map((e) => ({ value: e, label: e }))} placeholder="Choose…" />` : html`<${Text} type="date" value=${o.farExpiration} onInput=${(v) => set({ farExpiration: v })} />`}<//>` : null}
      ${tpl.needs.includes('right') ? html`<${Field} label="Built from"><${Seg} value=${o.right} onChange=${(v) => set({ right: v })} options=${[{ value: 'C', label: 'Calls' }, { value: 'P', label: 'Puts' }]} /><//>` : null}
      ${(tpl.strikes || []).map((k) => html`<${Field} label=${labelOf(k)} key=${k}>
        ${strikes.length ? html`<${Select} value=${o.strikes[k] ?? ''} onChange=${(v) => setStrike(k, v === '' ? null : Number(v))} placeholder="Choose…"
          options=${strikes.map((s) => ({ value: s, label: `${fmtPrice(s)}${isNum(spot) && Math.abs(s - spot) <= (strikes[1] - strikes[0]) / 2 ? '  (at the money)' : ''}` }))} />`
          : html`<${Num} value=${o.strikes[k] ?? null} onInput=${(v) => setStrike(k, v)} />`}<//>`)}
      <${Field} label="Contracts" hint=${usesStock ? 'Leave empty to size from the share quantity and each contract\'s deliverable' : 'Per leg of the structure'}>
        <${Num} value=${o.contracts} onInput=${(v) => set({ contracts: v })} placeholder=${usesStock ? 'from quantity' : ''} /><//>
    </div>
    ${d && !has ? html`<div class="grid-form">
      <${Field} label="Premium multiplier per contract" hint="Required unless the contract is registered"><${Num} value=${spec.multiplier} onInput=${(v) => set({ contractSpec: { ...spec, multiplier: v } })} /><//>
      <${Field} label="Deliverable units per contract" hint="Defaults to the multiplier"><${Num} value=${spec.deliverableUnits} onInput=${(v) => set({ contractSpec: { ...spec, deliverableUnits: v } })} /><//>
      <${Field} label="Exercise style"><${Select} value=${spec.exercise} onChange=${(v) => set({ contractSpec: { ...spec, exercise: v } })} options=${[{ value: 'american', label: 'American' }, { value: 'european', label: 'European' }]} /><//>
      <${Field} label="Settlement"><${Select} value=${spec.settlement} onChange=${(v) => set({ contractSpec: { ...spec, settlement: v } })} options=${[{ value: 'physical', label: 'Physical delivery' }, { value: 'cash', label: 'Cash' }]} /><//>
    </div>` : null}
    ${has ? html`<div class="note">Chain source: ${d.chain.source} (${d.chain.status}). Underlying ${fmtPrice(spot)} ${d.chain.underlying.currency}. Multiplier and deliverable come from each contract.</div>` : null}
  </div>`;
}

function FutureSelect({ value, onChange, exclude, placeholder = 'Choose a contract month' }) {
  const res = useLive(() => get('/api/instruments', { family: 'future', limit: 500 }), [], { interval: false });
  const items = (res.data?.items || []).filter((i) => i.id !== exclude);
  return html`<${Select} value=${value} onChange=${onChange} placeholder=${items.length ? placeholder : 'No futures are registered yet'}
    options=${items.map((i) => ({ value: i.id, label: `${i.symbol || i.name}${i.terms.expiration ? `, ${i.terms.expiration}` : ''}, x${i.multiplier}` }))} />`;
}

// ---- custom legs ----------------------------------------------------------------------------------------
const LEG_TYPES = [
  { value: 'instrument', label: 'Trade a registered instrument' }, { value: 'option', label: 'Listed option on the underlying' },
  { value: 'contract', label: 'New OTC contract (swap, forward, CDS, OTC option)' }, { value: 'loan', label: 'Cash borrowing or lending' }, { value: 'link', label: 'Use a position already held' },
];

function describeLeg(l) {
  if (l.kind === 'borrow_sec') return `Borrow ${fmtQty(l.qty)} ${l._name}`;
  if (l.kind === 'link') return `Use existing ${fmtQty(l.qty)} ${l._name}`;
  if (l.kind === 'loan') return `${l.action === 'borrow_cash' ? 'Borrow' : 'Lend'} ${fmtMoney(l.qty, l.contract.tradingCcy)}`;
  if (l.option) return `${l.action === 'buy' ? 'Buy' : 'Sell'} ${fmtQty(l.qty)} ${l._name} ${l.option.expiration} ${fmtPrice(l.option.strike)} ${l.option.right === 'C' ? 'call' : 'put'}`;
  if (l.contract) return `${l._actionLabel}: ${l.contract.name} (${fmtQty(l.qty)} notional)`;
  return `${ACTION_LABEL[l.action] || l._actionLabel || l.action} ${fmtQty(l.qty)} ${l._name}`;
}

function LegDialog({ book, unitId, und, catalog, defaultPurpose, onAdd, onClose }) {
  const [type, setType] = useState('instrument');
  const [purpose, setPurpose] = useState(defaultPurpose);
  const [inst, setInst] = useState(null);
  const [action, setAction] = useState('buy');
  const [qty, setQty] = useState(null);
  const [o, setO] = useState(EMPTY_ORDER);
  const [stated, setStated] = useState(null);
  const [borrow, setBorrow] = useState({ available: true, feeRate: null });
  const [opt, setOpt] = useState({ expiration: '', strikes: {}, right: 'P', contracts: null, contractSpec: { multiplier: null, deliverableUnits: null, exercise: 'american', settlement: 'physical' } });
  const [productId, setProductId] = useState('');
  const [draft, setDraft] = useState(null);
  const [pos, setPos] = useState(null);
  const [error, setError] = useState(null);
  const products = (catalog?.products || []).filter((p) => (type === 'loan' ? p.family === 'loan' : ['swap', 'cds', 'forward', 'otcoption'].includes(p.family)));
  const product = products.find((p) => p.id === productId) || null;
  useEffect(() => { setProductId(''); setDraft(null); setAction(type === 'loan' ? 'borrow_cash' : 'buy'); if (type === 'loan') setPurpose('financing'); }, [type]);
  useEffect(() => { if (product) { setDraft(newDraft(product, { tradingCcy: und?.tradingCcy || book.reportingCcy, underlyingId: ['otcoption', 'forward'].includes(product.family) ? und?.id || '' : '' })); if (type === 'contract') setAction('buy'); } }, [productId]);
  const chain = useLive(() => (type === 'option' && und ? get(`/api/instruments/${und.id}/chain`, { expiration: opt.expiration }) : null), [type, und?.id, opt.expiration], { interval: false });

  const order = () => ({ orderType: o.orderType, limitPrice: o.limitPrice, stopPrice: o.stopPrice, tif: o.tif, statedPrice: stated });
  const add = () => {
    setError(null);
    const key = ++legKey;
    const base = { key, purpose, role: purpose === 'hedge' ? 'hedge' : 'leg', afterKeys: [] };
    try {
      if (!(qty > 0)) throw new Error('Enter the quantity or amount.');
      if (type === 'instrument') {
        if (!inst) throw new Error('Choose the instrument.');
        const name = inst.symbol || inst.name;
        const legs = [];
        if (action === 'sell_short') {
          legs.push({ ...base, key: ++legKey, purpose: 'financing', role: 'borrow', kind: 'borrow_sec', action: 'borrow_sec', instrumentId: inst.id, qty, borrow: isNum(borrow.feeRate) ? borrow : null, _name: name, note: 'Simulated securities borrow. The short sale cannot execute without it.' });
          legs.push({ ...base, kind: 'trade', action, instrumentId: inst.id, qty, ...order(), afterKeys: [legKey], _name: name });
        } else legs.push({ ...base, kind: 'trade', action, instrumentId: inst.id, qty, ...order(), _name: name, _actionLabel: inst.actionLabels?.[action] });
        onAdd(legs);
      } else if (type === 'option') {
        if (!und) throw new Error('Choose the underlying at the top of the page first.');
        const strike = opt.strikes.k;
        if (!opt.expiration || !(strike > 0)) throw new Error('Choose the expiration and strike.');
        const c = chain.data?.available ? (opt.right === 'C' ? chain.data.chain.calls : chain.data.chain.puts).find((x) => x.strike === strike) : null;
        const reg = (chain.data?.registered || []).find((i) => i.terms.expiration === opt.expiration && i.terms.right === opt.right && i.terms.strike === strike);
        const meta = c ? { multiplier: c.multiplier, deliverableUnits: c.deliverable?.shares ?? c.deliverable?.units ?? c.multiplier, exercise: c.exercise || 'american', settlement: c.settlement || 'physical' }
          : reg ? { multiplier: reg.multiplier, deliverableUnits: reg.terms.deliverable?.units ?? reg.multiplier, exercise: reg.terms.exercise, settlement: reg.terms.settlement }
            : opt.contractSpec.multiplier > 0 ? { ...opt.contractSpec, deliverableUnits: opt.contractSpec.deliverableUnits ?? opt.contractSpec.multiplier } : null;
        if (!meta) throw new Error('No contract data for this option. Enter its multiplier and deliverable; 100 shares per contract is not assumed.');
        onAdd([{ ...base, kind: 'trade', action, qty, group: 'options', option: { underlyingId: und.id, expiration: opt.expiration, strike, right: opt.right, ...meta }, ...order(), _name: und.symbol || und.name }]);
      } else if (type === 'contract' || type === 'loan') {
        if (!draft) throw new Error('Choose the product.');
        const contract = draftToContract({ ...draft, name: draft.name || `${product.name.replace(/ \(.*\)$/, '')} ${draft.tradingCcy}` });
        if (type === 'loan') onAdd([{ ...base, purpose: 'financing', role: 'loan', kind: 'loan', action, qty, contract }]);
        else onAdd([{ ...base, kind: 'trade', action, qty, contract, ...order(), _actionLabel: (CONTRACT_ACTIONS[product.family] || []).find((a) => a[0] === action)?.[1] || action }]);
      } else if (type === 'link') {
        if (!pos) throw new Error('Choose the position to use.');
        if (qty > Math.abs(pos.qty)) throw new Error(`That position is ${fmtQty(Math.abs(pos.qty))}.`);
        onAdd([{ ...base, purpose: 'primary', role: 'underlying', kind: 'link', action: 'use_existing', instrumentId: pos.instrument.id, qty, sourcePositionId: pos.positionId, _name: pos.instrument.symbol || pos.instrument.name, note: 'Uses the existing position; nothing is bought or sold.' }]);
      }
      onClose();
    } catch (err) { setError(err); }
  };

  const actions = type === 'instrument' ? (inst?.actions || ['buy', 'sell']).filter((a) => a !== 'buy_to_cover').map((a) => ({ value: a, label: inst?.actionLabels?.[a] || ACTION_LABEL[a] || a }))
    : type === 'loan' ? [{ value: 'borrow_cash', label: 'Borrow cash' }, { value: 'lend_cash', label: 'Lend cash' }]
      : type === 'contract' && product ? (CONTRACT_ACTIONS[product.family] || []).map(([value, label]) => ({ value, label }))
        : [{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell / write' }];
  const qtyLabel = type === 'instrument' ? inst?.qtyLabel || 'Quantity' : type === 'option' ? 'Contracts' : type === 'loan' ? 'Principal' : type === 'link' ? 'Quantity to use' : product ? { swap: 'Notional', cds: 'Notional', forward: 'Amount (base currency or units)', otcoption: 'Underlying units' }[product.family] : 'Quantity';
  const d = chain.data;
  return html`<${Modal} size="mid" title="Add a leg" sub="Each leg becomes its own order with its own status. Product terms are entered in full; a swap is never reduced to buy or sell." onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Cancel<//><${Button} kind="primary" onClick=${add}>Add leg<//>`}>
    <div class="stack">
      <${ErrorNote} error=${error} />
      <div class="grid-form">
        <${Field} label="Leg" span=${2}><${Select} value=${type} onChange=${setType} options=${LEG_TYPES} /><//>
        ${type !== 'loan' && type !== 'link' ? html`<${Field} label="Purpose"><${Seg} value=${purpose} onChange=${setPurpose} options=${[{ value: 'primary', label: 'Primary' }, { value: 'hedge', label: 'Hedge' }]} /><//>` : null}
        ${type === 'instrument' ? html`<${Field} label="Instrument" span="all"><${InstrumentPicker} value=${inst?.id || ''} onChange=${(id, i) => { setInst(i); setAction((i.actions || ['buy'])[0]); }} /><//>` : null}
        ${type === 'contract' || type === 'loan' ? html`<${Field} label="Product" span="all"><${Select} value=${productId} onChange=${setProductId} placeholder="Choose the product…" options=${products.map((p) => ({ value: p.id, label: p.name, group: p.group }))} /><//>` : null}
        ${type === 'link' ? html`<${Field} label="Position" span="all"><${PositionPicker} value=${pos?.positionId || ''} onChange=${(v, p) => { setPos(p || null); if (p) setQty(Math.abs(p.qty)); }} bookId=${book.id} unitId=${unitId} /><//>` : null}
        ${type !== 'link' ? html`<${Field} label="Side" span=${2}><${Select} value=${action} onChange=${setAction} options=${actions} /><//>` : null}
        <${Field} label=${qtyLabel}><${Num} value=${qty} onInput=${setQty} /><//>
      </div>
      ${type === 'option' ? (und ? html`<div class="grid-form">
        <${Field} label="Type"><${Seg} value=${opt.right} onChange=${(v) => setOpt({ ...opt, right: v })} options=${[{ value: 'C', label: 'Call' }, { value: 'P', label: 'Put' }]} /><//>
        <${Field} label="Expiration">${d?.available ? html`<${Select} value=${opt.expiration} onChange=${(v) => setOpt({ ...opt, expiration: v })} options=${d.chain.expirations.map((e) => ({ value: e, label: e }))} placeholder="Choose…" />` : html`<${Text} type="date" value=${opt.expiration} onInput=${(v) => setOpt({ ...opt, expiration: v })} />`}<//>
        <${Field} label="Strike">${d?.available ? html`<${Select} value=${opt.strikes.k ?? ''} onChange=${(v) => setOpt({ ...opt, strikes: { k: v === '' ? null : Number(v) } })} options=${d.chain.strikes.map((s) => ({ value: s, label: fmtPrice(s) }))} placeholder="Choose…" />` : html`<${Num} value=${opt.strikes.k ?? null} onInput=${(v) => setOpt({ ...opt, strikes: { k: v } })} />`}<//>
        ${d && !d.available ? html`<${Field} label="Premium multiplier per contract" hint="Not assumed"><${Num} value=${opt.contractSpec.multiplier} onInput=${(v) => setOpt({ ...opt, contractSpec: { ...opt.contractSpec, multiplier: v } })} /><//>
          <${Field} label="Deliverable units per contract"><${Num} value=${opt.contractSpec.deliverableUnits} onInput=${(v) => setOpt({ ...opt, contractSpec: { ...opt.contractSpec, deliverableUnits: v } })} /><//>` : null}
      </div>` : html`<${Notice} tone="warn">Choose the underlying at the top of the page first.<//>`) : null}
      ${draft ? html`<div class="grid-form">
        <${Field} label="Contract name" span=${2}><${Text} value=${draft.name} onInput=${(v) => setDraft({ ...draft, name: v })} placeholder=${product.name.replace(/ \(.*\)$/, '')} /><//>
        <${Field} label="Currency"><${Text} value=${draft.tradingCcy} onInput=${(v) => setDraft({ ...draft, tradingCcy: v.toUpperCase() })} /><//>
        <${ContractFields} draft=${draft} onChange=${setDraft} />
      </div>
      ${product.support !== 'full' ? html`<${Notice}>Paper support for ${product.name}: ${product.support === 'partial' ? 'partly manual' : 'manual inputs'}. ${product.note}<//>` : null}` : null}
      ${type === 'instrument' && action === 'sell_short' ? html`<div class="grid-form">
        <${Field} label="Borrow assumption" hint="Used only when no borrow data is supplied for the security" span=${2}><${Check} checked=${borrow.available} onChange=${(v) => setBorrow({ ...borrow, available: v })}>Assume the security can be borrowed<//><//>
        <${Field} label="Borrow fee (decimal a year)" hint="0.005 = 0.5%"><${Num} value=${borrow.feeRate} onInput=${(v) => setBorrow({ ...borrow, feeRate: v })} /><//></div>
        <p class="note">A securities borrow leg is added ahead of the short sale. If the borrow fails, the short sale is rejected with it.</p>` : null}
      ${['instrument', 'option', 'contract'].includes(type) ? html`<div class="grid-form"><${OrderFields} o=${o} set=${(p) => setO({ ...o, ...p })} />
        <${Field} label="State a fill price" hint="Optional. Recorded as a manual input, not a market quote."><${Num} value=${stated} onInput=${setStated} placeholder="none" /><//></div>` : null}
      ${type === 'contract' ? html`<p class="note">Listed options, futures, bonds and other securities are registered once under Instruments and then traded as a registered instrument. Repo and securities-lending tickets are in Books and Treasury.</p>` : null}
    </div>
  <//>`;
}

function CustomLegs({ legs, setLegs, book, unitId, und, catalog, defaultPurpose }) {
  const add = () => openOverlay((close) => html`<${LegDialog} book=${book} unitId=${unitId} und=${und} catalog=${catalog} defaultPurpose=${defaultPurpose} onClose=${close} onAdd=${(more) => setLegs((cur) => [...cur, ...more])} />`);
  const remove = (key) => setLegs((cur) => cur.filter((l) => l.key !== key && !l.afterKeys.includes(key)).map((l) => ({ ...l })));
  const setAfter = (key, v) => setLegs((cur) => cur.map((l) => (l.key === key ? { ...l, afterKeys: v ? [Number(v)] : [] } : l)));
  return html`<div class="stack">
    ${legs.length ? html`<div class="tablewrap"><table class="ledger margin"><thead><tr><th></th><th>Leg</th><th>Purpose</th><th>Order</th><th>Runs after</th><th></th></tr></thead><tbody>
      ${legs.map((l, i) => html`<tr key=${l.key}><td><span class="leg-n">${i + 1}</span></td>
        <td class="wrap"><div class="strong">${describeLeg(l)}</div>${l.note ? html`<div class="sub">${l.note}</div>` : null}</td>
        <td>${{ primary: 'Primary', hedge: 'Hedge', financing: 'Financing' }[l.purpose]}</td>
        <td>${l.kind === 'trade' ? `${{ market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit' }[l.orderType] || 'Market'}${isNum(l.limitPrice) ? ` ${fmtPrice(l.limitPrice)}` : ''}${isNum(l.statedPrice) ? `, stated fill ${fmtPrice(l.statedPrice)}` : ''}` : ''}</td>
        <td>${l.kind === 'borrow_sec' ? '' : html`<${Select} value=${l.afterKeys[0] ?? ''} onChange=${(v) => setAfter(l.key, v)} placeholder="No dependency" options=${legs.filter((x) => x.key !== l.key).map((x) => ({ value: x.key, label: `Leg ${legs.indexOf(x) + 1}` }))} />`}</td>
        <td class="r"><button class="x" title="Remove this leg" onClick=${() => remove(l.key)}>×</button></td></tr>`)}
    </tbody></table></div>` : html`<${Empty} title="No legs yet">Add the legs of the package one at a time: registered instruments, listed options, new OTC contracts, borrowing, or a position already held.<//>`}
    <div><${Button} onClick=${add}>Add a leg<//></div>
  </div>`;
}
const customToSpecs = (legs) => legs.map((l) => {
  const { key, afterKeys, _name, _actionLabel, ...rest } = l;
  return { ...rest, dependsOn: afterKeys.map((k) => legs.findIndex((x) => x.key === k) + 1).filter((n) => n > 0) };
});

// ---- hedge panel (Workflow 1) ------------------------------------------------------------------------------
function useHedgeRequest(key, body) {
  const [state, setState] = useState({ r: null, error: null, loading: false });
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    if (!key) { setState({ r: null, error: null, loading: false }); return undefined; }
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      post('/api/hedge/requests', body).then(
        (r) => { if (n === seq.current) setState({ r, error: null, loading: false }); },
        (error) => { if (n === seq.current) setState({ r: null, error, loading: false }); });
    }, 900);
    return () => clearTimeout(t);
  }, [key]);
  return state;
}

function PackageModal({ r, packageId, onClose }) {
  const pkg = r.response.packages.find((p) => p.id === packageId);
  const box = usePackagePreview(r.id, packageId);
  return html`<${Modal} size="wide" title=${`Hedge package: ${pkg.label}`} sub=${`${r.response.source}${r.response.asOf ? `, ${fmtTime(r.response.asOf)}` : ''}. Shown on its own here; in the package preview its legs follow the primary trade.`} onClose=${onClose}
    footer=${html`<span class="grow"></span><${Button} onClick=${onClose}>Close<//>`}><${PackageDetail} pkg=${pkg} pv=${box.pv} loading=${box.loading} error=${box.error} /><//>`;
}

function HedgePanel({ hedge, ready, waitingFor, sel, setSel }) {
  const [sent, setSent] = useState(false);
  const r = hedge.r;
  const packages = r?.response?.packages || [];
  return html`<${Panel} title="Hedge" note="From Shaffer Hedge in Analytics Lab">
    <div class="stack">
      ${!ready ? html`<p class="note">A hedge request is sent automatically once the ${waitingFor.join(' and ')} ${waitingFor.length > 1 ? 'are' : 'is'} set. It carries the Book, Account, investment Strategy, holding period, objective, existing position, hedges already held and the Account's exposures.</p>` : null}
      ${ready && hedge.loading && !r ? html`<p class="note">Requesting the hedge package…</p>` : null}
      <${ErrorNote} error=${hedge.error} />
      ${r ? html`
        ${packages.length ? html`
          <${PackageList} response=${r.response} selected=${sel} onSelect=${setSel} allowNone />
          ${sel ? html`<div class="row"><${Button} small onClick=${() => openOverlay((close) => html`<${PackageModal} r=${r} packageId=${sel} onClose=${close} />`)}>Legs, quotes and costs<//>
            <span class="note">Its legs are added to the preview, after the primary and financing legs.</span></div>` : null}
          <p class="note">Hedge legs depend on the primary trade: if it fills only in part, the protection is scaled to what filled.</p>` : html`<${RequestState} r=${r} />`}
        ${r.request.templateNote ? html`<div class="note">${r.request.templateNote}</div>` : null}
        ${r.missing?.length && packages.length ? html`<div class="note">Not yet in the request: ${r.missing.join(', ')}.</div>` : null}
        <button class="btn link small" style="align-self:flex-start" onClick=${() => setSent(!sent)}>${sent ? 'Hide' : 'Show'} what was sent${hedge.loading ? ' (updating…)' : ''}</button>
        ${sent ? html`<${RequestSummary} r=${r} />` : null}` : null}
    </div>
  <//>`;
}

function SignalsPanel({ book, onUse }) {
  const res = useLive(() => get('/api/analytics/signals', { bookId: book.id }), [book.id], { interval: false });
  const d = res.data;
  return html`<${Panel} title="Signals" note="From Analytics Lab">
    ${!d ? html`<p class="note">Loading…</p>` : !d.available ? html`<${Awaiting} compact what="Strategy and Model signals appear here once Analytics Lab is connected. A signal can fill in this form; it never trades by itself." />`
      : d.items.length ? html`<div class="stack">${d.items.map((s) => html`<div class="row" style="align-items:flex-start;border-bottom:1px solid var(--rule);padding-bottom:8px">
          <div style="flex:1;min-width:0"><div class="strong">${s.strategy || 'Signal'}${s.model ? `, ${s.model}` : ''}</div>
            <div class="sub muted small">${s.direction || ''} ${s.instrumentId || ''}${s.sizing?.quantity ? `, ${fmtQty(s.sizing.quantity)}` : s.sizing?.notional ? `, ${fmtNum(s.sizing.notional, 0)} notional` : ''}${s.timingEligibility ? `, timing: ${s.timingEligibility}` : ''}</div>
            ${s.outlierFlags?.length ? html`<div class="sub small" style="color:var(--amber)">Outlier flags: ${s.outlierFlags.join(', ')}</div>` : null}
            ${s.note ? html`<div class="sub small">${s.note}</div>` : null}<div class="sub muted small">${s.modelRun ? `Run ${s.modelRun}, ` : ''}${fmtTime(s.asOf)}</div></div>
          <${Button} small onClick=${() => onUse(s)}>Fill the form<//></div>`)}
        <p class="note">A signal only fills in the form. The package still needs your preview and confirmation.</p></div>`
        : html`<p class="note">No current signals for this Book.</p>`}
  <//>`;
}

function Instances({ book, reloadKey }) {
  const [which, setWhich] = useState('active');
  const res = useLive(() => get('/api/strategies', { bookId: book.id, status: which === 'active' ? 'active' : undefined }), [book.id, which, reloadKey]);
  const open = async (id) => { const m = await import('./strategy-detail.js'); m.openStrategy(id); };
  return html`<${Panel} title="Strategy instances in this Book" flush actions=${html`<${Seg} value=${which} onChange=${setWhich} options=${[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />`}>
    <${Table} margin rows=${res.data?.items || []} rowKey=${(s) => s.id} onRowClick=${(s) => open(s.id)} columns=${[
      { label: 'Strategy instance', render: (s) => html`<div class="strong">${s.name}</div><div class="sub">${s.id}</div>` },
      { label: 'Template', render: (s) => s.templateName },
      { label: 'Held in', render: (s) => (s.unit.kind === 'treasury' ? 'Treasury' : s.unit.name) },
      { label: 'Status', render: (s) => html`<${StrategyStatus} status=${s.status} />${s.hedgeReview ? html` <${Pill} tone="warn" title="The hedged exposure changed. Request updated hedge instructions.">hedge review<//>` : null}` },
      { label: 'Legs', align: 'r', render: (s) => `${s.legs}${s.working ? `, ${s.working} working` : ''}${s.failedLegs ? `, ${s.failedLegs} failed` : ''}` },
      { label: 'Open positions', align: 'r', render: (s) => s.positions },
      { label: 'Investment Strategy', render: (s) => s.investmentStrategy?.name || html`<${Missing} reason="Not set" />` },
      { label: 'Submitted', render: (s) => fmtTime(s.createdAt) },
    ]} empty=${{ title: which === 'active' ? 'No active strategy instances' : 'No strategy instances yet', children: 'Confirm a package above and it appears here with every leg, fill and position linked under one ID.' }} />
  <//>`;
}

// ---- page -------------------------------------------------------------------------------------------------------
export default function Strategy({ args, book, status }) {
  const attachId = args[0] === 'attach' ? args[1] : '';
  const meta = useLive(async () => { const [t, c] = await Promise.all([get('/api/templates'), get('/api/catalog')]); return { templates: t.templates, catalog: c }; }, [], { interval: false });
  const attach = useLive(() => (attachId ? get(`/api/strategies/${attachId}`) : null), [attachId], { interval: false });
  const templates = meta.data?.templates || [];

  const [unitId, setUnitId] = useState(defaultUnit(book));
  const [tplId, setTplId] = useState(attachId ? 'custom' : 'long');
  const [undId, setUndId] = useState(args[0] === 'for' ? args[1] || '' : '');
  const [mode, setMode] = useState('new');
  const [existingId, setExistingId] = useState('');
  const [sizeBy, setSizeBy] = useState('quantity');
  const [qty, setQty] = useState(null);
  const [notional, setNotional] = useState(null);
  const [direction, setDirection] = useState('long');
  const [hedgeRatio, setHedgeRatio] = useState(1);
  const [o, setO] = useState({ expiration: '', farExpiration: '', right: 'C', strikes: {}, contracts: null, contractSpec: { multiplier: null, deliverableUnits: null, exercise: 'american', settlement: 'physical' } });
  const [fut, setFut] = useState({ instrumentId: '', farInstrumentId: '', contracts: null });
  const [pair, setPair] = useState({ instrumentId: '', ratio: 1 });
  const [borrow, setBorrow] = useState({ available: true, feeRate: null });
  const [order, setOrder] = useState(EMPTY_ORDER);
  const [netLimit, setNetLimit] = useState(null);
  const [fin, setFin] = useState({ mode: 'none', rate: null });
  const [ctx, setCtx] = useState({ strategy: '', days: null, objective: '', scope: 'trade' });
  const [legs, setLegs] = useState([]);
  const [signalRef, setSignalRef] = useState(null);
  const [hedgeSel, setHedgeSel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(0);

  useEffect(() => { if (attach.data) { setUnitId(attach.data.unit.id); if (attach.data.underlying) setUndId(attach.data.underlying.id); } }, [attach.data?.id]);
  const tpl = templates.find((t) => t.id === tplId) || { id: tplId, name: '', legs: '', needs: tplId === 'custom' ? ['legs'] : [], strikes: [] };
  const uses = (x) => tpl.needs.includes(x);
  const custom = tpl.id === 'custom';
  const existing = mode === 'existing' && uses('existing');
  useEffect(() => { setError(null); if (!uses('existing')) setMode('new'); }, [tplId]);
  useEffect(() => { setExistingId(''); setO((cur) => ({ ...cur, expiration: '', farExpiration: '', strikes: {} })); }, [undId]);

  const detail = useLive(() => (undId ? get(`/api/instruments/${undId}/detail`, { bookId: book.id }) : null), [undId, book.id]);
  const und = detail.data?.instrument?.id === undId ? detail.data.instrument : null;
  const obs = und ? detail.data.observation : null;
  const an = und ? detail.data.analytics : null;
  const hasBorrowData = Boolean(und && detail.data.borrow?.obs);
  const needsBorrow = uses('borrow') && !existing;
  const px = isNum(obs?.value) ? obs.value : null;
  const approxQty = sizeBy === 'notional' && notional > 0 && px && und ? Math.floor(notional / (px * (und.multiplier || 1))) : null;

  // ---- the package input, shared by the preview and the hedge request -------------------------------------
  const input = useMemo(() => {
    const base = { bookId: book.id, unitId, template: tpl.id, underlyingId: undId || undefined, origin: 'strategy_page', signalRef: signalRef || undefined, ...hedgeContextInput(ctx) };
    if (attachId) return { ...base, attachTo: attachId, intent: 'adjust', origin: undefined, legs: customToSpecs(legs) };
    if (custom) return { ...base, legs: customToSpecs(legs), financing: fin.mode === 'none' ? null : fin.mode === 'treasury' ? { mode: 'treasury' } : { mode: 'loan', rateType: 'fixed', rate: fin.rate } };
    return {
      ...base,
      mode: existing ? 'existing' : 'new', existingPositionId: existing ? existingId : undefined,
      quantity: uses(STOCK) ? (existing ? qty : sizeBy === 'quantity' ? qty : null) : undefined, targetNotional: uses(STOCK) && !existing && sizeBy === 'notional' ? notional : undefined,
      direction: tpl.id === 'futures_hedge' ? direction : undefined, hedgeRatio: (uses(STOCK) && uses(OPT)) || tpl.id === 'futures_hedge' ? hedgeRatio : undefined,
      options: uses(OPT) ? { expiration: o.expiration, farExpiration: uses('farExpiration') ? o.farExpiration : undefined, right: uses('right') ? o.right : undefined, strikes: o.strikes, contracts: o.contracts, contractSpec: o.contractSpec.multiplier > 0 ? o.contractSpec : undefined } : undefined,
      futures: uses(FUT) ? { instrumentId: fut.instrumentId, farInstrumentId: uses('farFuture') ? fut.farInstrumentId : undefined, contracts: fut.contracts } : undefined,
      pair: uses('pair') ? pair : undefined,
      borrow: needsBorrow && !hasBorrowData && isNum(borrow.feeRate) ? borrow : null,
      orderType: order.orderType, limitPrice: order.limitPrice, stopPrice: order.stopPrice, tif: order.tif, netLimit: tpl.net ? netLimit : undefined,
      financing: fin.mode === 'none' ? null : fin.mode === 'treasury' ? { mode: 'treasury' } : { mode: 'loan', rateType: 'fixed', rate: fin.rate },
    };
  }, [book.id, unitId, tplId, templates.length, undId, mode, existingId, sizeBy, qty, notional, direction, hedgeRatio, o, fut, pair, borrow, hasBorrowData, order, netLimit, fin, ctx, legs, signalRef, attachId]);

  // ---- hedge request: sent automatically once the instrument and amount are set ------------------------------
  const haveInstrument = custom ? legs.length > 0 : uses(STOCK) || uses(OPT) ? Boolean(undId) : Boolean(fut.instrumentId);
  const haveAmount = custom ? legs.length > 0 : existing ? Boolean(existingId) : uses(STOCK) ? (sizeBy === 'quantity' ? qty > 0 : notional > 0) : uses(OPT) ? o.contracts > 0 : fut.contracts > 0;
  const hedgeReady = !attachId && Boolean(unitId) && haveInstrument && haveAmount;
  const hedgeBody = hedgeReady ? {
    bookId: book.id, unitId, scope: { type: ctx.scope }, trigger: 'strategy_page', instrumentId: undId || undefined, notional: sizeBy === 'notional' && !existing ? notional : undefined,
    investmentStrategy: ctx.strategy ? { name: ctx.strategy } : null, holdingPeriod: ctx.days ? { days: ctx.days } : null, objective: ctx.objective ? { type: ctx.objective } : null,
    package: { ...input, financing: null },
  } : null;
  const hedgeKey = hedgeBody ? JSON.stringify([hedgeBody, submitted]) : '';
  const hedge = useHedgeRequest(hedgeKey, hedgeBody);
  useEffect(() => { setHedgeSel(hedge.r?.response?.recommendedId || ''); }, [hedge.r?.id]);

  const preview = async () => {
    setBusy(true); setError(null);
    try {
      const withHedge = hedgeSel && hedge.r ? { hedgeLinkId: hedge.r.id, hedgePackageId: hedgeSel, appendHedge: true } : {};
      const pv = await post('/api/strategies/preview', { ...input, ...withHedge });
      openOverlay((close) => html`<${PreviewModal} preview=${pv} onClose=${close} confirmLabel=${attachId ? 'Confirm added legs' : 'Confirm paper trade'}
        onDone=${() => { setQty(null); setNotional(null); setLegs([]); setO((cur) => ({ ...cur, contracts: null })); setFut((cur) => ({ ...cur, contracts: null })); setSignalRef(null); setSubmitted((n) => n + 1); if (attachId) location.hash = '#/strategy'; }} />`);
    } catch (err) { setError(err); }
    setBusy(false);
  };
  const useSignal = (s) => {
    if (s.instrumentId) setUndId(s.instrumentId);
    setTplId(templates.some((t) => t.id === s.template) ? s.template : s.direction === 'short' ? 'short' : 'long');
    if (s.sizing?.quantity > 0) { setSizeBy('quantity'); setQty(s.sizing.quantity); } else if (s.sizing?.notional > 0) { setSizeBy('notional'); setNotional(s.sizing.notional); }
    setCtx((c) => ({ ...c, strategy: s.strategy || c.strategy }));
    setSignalRef(s.id || null);
  };

  const pickerFamilies = uses(STOCK) ? (uses(OPT) || uses(FUT) || uses('pair') ? ['equity', 'fund', 'bond', 'spot', 'crypto'] : SECURITIES) : undefined;
  const waitingFor = [!haveInstrument ? 'instrument' : null, !haveAmount ? 'amount' : null].filter(Boolean);
  const canPreview = Boolean(unitId) && (custom ? legs.length > 0 : haveInstrument);

  return html`<div>
    <div class="page-head"><div><h1>${attachId ? 'Add legs to a strategy' : 'Strategy'}</h1>
      <div class="sub">${attachId ? 'New legs join the existing strategy instance and are linked to its positions. Nothing is submitted until you confirm the preview.'
        : 'Build a package from an execution template, review every leg, then confirm once. Templates only assemble legs; investment Strategies and Models stay in Analytics Lab.'}</div></div></div>
    ${attachId && attach.data ? html`<div style="margin-bottom:10px"><${Notice}>Adding to <b>${attach.data.name}</b> (${attach.data.templateName}) in ${attach.data.unit.kind === 'treasury' ? 'Treasury' : attach.data.unit.name}. <a href="#/strategy">Start a new package instead</a><//></div>` : null}
    <div class="split">
      <div class="stack">
        ${!attachId ? html`<${Panel} title="Account and intent">
          <div class="grid-form">
            <${Field} label="Account" hint=${`Book: ${book.name}`}><${UnitSelect} value=${unitId} onChange=${setUnitId} book=${book} /><//>
            <${HedgeContext} c=${ctx} set=${(p) => setCtx({ ...ctx, ...p })} />
            <${Field} label="Hedge scope"><${Select} value=${ctx.scope} onChange=${(v) => setCtx({ ...ctx, scope: v })} options=${SCOPES} /><//>
          </div><//>` : null}

        ${!attachId ? html`<${Panel} title="Instrument and template">
          <div class="stack">
            <div class="grid-form">
              <${Field} label="Execution template" span=${2}><${Select} value=${tplId} onChange=${setTplId} options=${templates.map((t) => ({ value: t.id, label: t.name, group: t.group }))} /><//>
              ${tpl.id !== 'futures_calendar' ? html`<${Field} label=${custom ? 'Underlying (optional, for option legs and the payoff view)' : uses(STOCK) ? 'Ticker or instrument' : 'Underlying of the options'} span=${2}>
                <${InstrumentPicker} value=${undId} onChange=${(id) => setUndId(id)} families=${pickerFamilies} /><//>` : null}
            </div>
            <div class="note">${tpl.legs}</div>
            ${und ? html`<div class="row" style="gap:18px;align-items:flex-end">
              <div><div class="note">Current market price</div><div style="font-size:18px"><${Price} obs=${obs} reason=${status.data.market.connection === 'awaiting' ? status.data.awaitingMessage : 'No price available'} /></div></div>
              <div><div class="note">Bid / ask</div><div>${obs && isNum(obs.bid) ? `${fmtPrice(obs.bid)} / ${fmtPrice(obs.ask)}` : html`<${Missing} />`}</div></div>
              <div><div class="note">Fair price</div><div>${isNum(an?.realisticFairValue) ? fmtPrice(an.realisticFairValue) : html`<${Missing} reason="Supplied by Analytics Lab when connected" />`}</div></div>
              <div><div class="note">Gap %</div><div>${isNum(an?.realisticGap) ? html`<${Signed} value=${an.realisticGap} suffix="%" />` : html`<${Missing} reason="Supplied by Analytics Lab when connected" />`}</div></div>
              <span class="spacer"></span><span class="note">${und.support.productName.replace(/ \(.*\)$/, '')}, ${und.tradingCcy}</span>
            </div>` : null}
            ${und && !obs ? html`<${Awaiting} compact what="There is no price for this instrument. Legs would wait as working orders until a price is supplied, entered by hand, or stated in the preview." />` : null}

            ${uses('existing') ? html`<${Field} label="Underlying position"><${Seg} value=${mode} onChange=${setMode} options=${[{ value: 'new', label: 'Establish a new position' }, { value: 'existing', label: 'Hedge an existing position' }]} /><//>` : null}
            ${uses(STOCK) ? html`<div class="grid-form">
              ${existing ? html`<${Field} label=${`Existing ${SHORT_SIDE.includes(tpl.id) ? 'short' : tpl.id === 'futures_hedge' ? '' : 'long'} position to use`} span=${2} hint="The underlying is not bought or sold again.">
                  <${PositionPicker} value=${existingId} onChange=${(v, p) => { setExistingId(v); if (p) setQty(Math.abs(p.qty)); }} bookId=${book.id} unitId=${unitId} instrumentId=${undId || '~'} direction=${SHORT_SIDE.includes(tpl.id) ? 'short' : tpl.id === 'futures_hedge' ? undefined : 'long'} /><//>
                <${Field} label="Quantity to cover" hint="Defaults to the whole position"><${Num} value=${qty} onInput=${setQty} /><//>`
                : html`<${Field} label="Size by"><${Seg} value=${sizeBy} onChange=${setSizeBy} options=${[{ value: 'quantity', label: 'Quantity' }, { value: 'notional', label: 'Notional' }]} /><//>
                  ${sizeBy === 'quantity' ? html`<${Field} label=${und?.qtyLabel || 'Quantity'}><${Num} value=${qty} onInput=${setQty} /><//>`
                    : html`<${Field} label=${`Target notional${und ? ` (${und.tradingCcy})` : ''}`} hint=${approxQty !== null ? `About ${fmtQty(approxQty)} at the current price` : 'Needs a price for the instrument'}><${Num} value=${notional} onInput=${setNotional} /><//>`}
                  ${tpl.id === 'futures_hedge' ? html`<${Field} label="Underlying exposure"><${Seg} value=${direction} onChange=${setDirection} options=${[{ value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} /><//>` : null}`}
              ${(uses(OPT) || tpl.id === 'futures_hedge') ? html`<${Field} label="Hedge ratio" hint="1 covers the whole quantity"><${Num} value=${hedgeRatio} onInput=${setHedgeRatio} /><//>` : null}
            </div>` : null}
          </div><//>` : null}

        ${uses(OPT) && !custom ? html`<${Panel} title="Option contracts"><${OptionParams} und=${und} tpl=${tpl} o=${o} set=${(p) => setO({ ...o, ...p })} usesStock=${uses(STOCK)} /><//>` : null}

        ${uses(FUT) ? html`<${Panel} title="Futures contracts">
          <div class="grid-form">
            <${Field} label=${uses('farFuture') ? 'Contract month to buy' : 'Futures contract for the hedge'} span=${2}><${FutureSelect} value=${fut.instrumentId} onChange=${(v) => setFut({ ...fut, instrumentId: v })} /><//>
            ${uses('farFuture') ? html`<${Field} label="Contract month to sell" span=${2}><${FutureSelect} value=${fut.farInstrumentId} exclude=${fut.instrumentId} onChange=${(v) => setFut({ ...fut, farInstrumentId: v })} /><//>` : null}
            <${Field} label="Contracts" hint=${uses('farFuture') ? '' : 'Leave empty to size from the hedge ratio and both prices'}><${Num} value=${fut.contracts} onInput=${(v) => setFut({ ...fut, contracts: v })} placeholder=${uses('farFuture') ? '' : 'from ratio'} /><//>
          </div>
          <p class="note" style="margin-top:8px">Futures post initial margin and settle variation daily; the notional is not paid. Contract months come from the registry until Shaffer MarketData supplies derivative contract data.</p><//>` : null}

        ${uses('pair') ? html`<${Panel} title="Short leg of the pair">
          <div class="grid-form">
            <${Field} label="Security to borrow and sell short" span=${2}><${InstrumentPicker} value=${pair.instrumentId} onChange=${(id) => setPair({ ...pair, instrumentId: id })} families=${['equity', 'fund', 'bond']} /><//>
            <${Field} label="Sizing ratio" hint="Short quantity per unit of long quantity"><${Num} value=${pair.ratio} onInput=${(v) => setPair({ ...pair, ratio: v })} /><//>
          </div><//>` : null}

        ${needsBorrow && und ? html`<${Panel} title="Securities borrow">
          ${hasBorrowData && !uses('pair') ? html`<div><${Pill} tone=${detail.data.borrow.available ? 'ok' : 'bad'}>${detail.data.borrow.available ? 'Available to borrow' : 'Not available to borrow'}<//> fee ${fmtNum(detail.data.borrow.feeRate * 100, 3)}% a year${isNum(detail.data.borrow.quantity) ? `, ${fmtQty(detail.data.borrow.quantity)} available` : ''} <${Prov} obs=${detail.data.borrow.obs} /></div>`
            : html`<div class="grid-form">
              <${Field} label="Borrow assumption" span=${2} hint="Used when no borrow availability data is supplied. Recorded as a manual assumption."><${Check} checked=${borrow.available} onChange=${(v) => setBorrow({ ...borrow, available: v })}>Assume the security can be borrowed<//><//>
              <${Field} label="Borrow fee (decimal a year)" hint="0.005 = 0.5%"><${Num} value=${borrow.feeRate} onInput=${(v) => setBorrow({ ...borrow, feeRate: v })} /><//></div>`}
          <p class="note" style="margin-top:8px">The borrow is its own financing leg. If it fails, the dependent short sale is rejected. Sale proceeds are held as restricted collateral, not buying power.</p><//>` : null}

        ${custom ? html`<${Panel} title=${attachId ? 'Legs to add' : 'Legs'}><${CustomLegs} legs=${legs} setLegs=${setLegs} book=${book} unitId=${unitId} und=${und} catalog=${meta.data?.catalog} defaultPurpose=${attachId ? 'hedge' : 'primary'} /><//>` : null}

        <${Panel} title="Order and funding">
          <div class="grid-form">
            ${!custom ? html`<${OrderFields} o=${order} set=${(p) => setOrder({ ...order, ...p })} />` : null}
            ${tpl.net ? html`<${Field} label="Net limit for the option legs" hint="Largest net debit you accept. Use a negative number for a minimum credit."><${Num} value=${netLimit} onInput=${setNetLimit} placeholder="none" /><//>` : null}
            ${!attachId ? html`<${Field} label="If cash is short" span=${2}><${Select} value=${fin.mode} onChange=${(v) => setFin({ ...fin, mode: v })} options=${[{ value: 'none', label: 'Do not finance (the package is blocked)' }, { value: 'treasury', label: 'Fund the shortfall from Treasury' }, { value: 'loan', label: 'Borrow the shortfall (simulated lender)' }]} /><//>` : null}
            ${fin.mode === 'loan' ? html`<${Field} label="Loan rate (decimal a year)" hint="0.06 = 6%. Not assumed for you."><${Num} value=${fin.rate} onInput=${(v) => setFin({ ...fin, rate: v })} /><//>` : null}
          </div>
          ${custom ? html`<p class="note" style="margin-top:8px">Each custom leg carries its own order instructions.</p>` : tpl.net ? html`<p class="note" style="margin-top:8px">Multi-leg option structures work as market orders within the net limit; each leg still fills and is tracked separately.</p>` : null}<//>

        <div class="stack">
          <${ErrorNote} error=${error} />
          <div class="row"><${Button} kind="primary" busy=${busy} disabled=${!canPreview} onClick=${preview}>Preview package<//>
            <span class="note">${hedgeSel && hedge.r ? 'Includes the selected hedge package. ' : ''}Nothing is submitted until you confirm the preview.</span></div>
        </div>
      </div>

      <div class="stack">
        ${!attachId ? html`<${HedgePanel} hedge=${hedge} ready=${hedgeReady} waitingFor=${waitingFor} sel=${hedgeSel} setSel=${setHedgeSel} />` : null}
        ${!attachId ? html`<${SignalsPanel} book=${book} onUse=${useSignal} />` : null}
        ${attachId && attach.data ? html`<${Panel} title="Positions in this strategy" flush>
          <${Table} rows=${attach.data.positions} rowKey=${(p) => p.positionId} columns=${[{ label: 'Position', render: (p) => p.instrument.symbol || p.instrument.name }, { label: 'Quantity', align: 'r', render: (p) => fmtQty(p.qty) }, { label: 'Role', render: (p) => ({ primary: 'Primary', hedge: 'Hedge', financing: 'Financing' }[p.purpose] || p.purpose) }]} empty="No open positions" /><//>` : null}
      </div>
    </div>
    <div style="margin-top:16px"><${Instances} book=${book} reloadKey=${submitted} /></div>
  </div>`;
}
