// Execution templates.
//
// A template describes how a package's legs are assembled. It is not an investment
// recommendation and not a server-generated signal: investment Strategies and Models live in
// Shaffer Analytics Lab. A signal may pre-fill a template's inputs, but the legs still go through
// the same preview, confirmation and per-leg checks.
//
// Contract quantities are derived from each contract's own deliverable and multiplier.

import { AppError, need, num } from './util.js';

const STOCK = 'stock', OPT = 'options', FUT = 'futures';

/** Field groups a template needs on the Strategy page. */
export const TEMPLATES = [
  { id: 'long', name: 'Long', group: 'Directional', legs: 'Buy the underlying.', needs: [STOCK] },
  { id: 'short', name: 'Short', group: 'Directional', legs: 'Arrange a simulated securities borrow and sell the borrowed security.', needs: [STOCK, 'borrow'] },
  { id: 'protective_put', name: 'Protective Put / Long + Put Cover', group: 'Hedged stock', legs: 'Buy or use long underlying, and buy a put.', needs: [STOCK, 'existing', OPT], strikes: ['put'] },
  { id: 'protective_call', name: 'Protective Call / Short + Call Cover', group: 'Hedged stock', legs: 'Borrow and short the underlying, or use an existing short, and buy a call.', needs: [STOCK, 'existing', 'borrow', OPT], strikes: ['call'] },
  { id: 'covered_call', name: 'Covered Call', group: 'Hedged stock', legs: 'Buy or use long underlying, and sell a call against it.', needs: [STOCK, 'existing', OPT], strikes: ['call'] },
  { id: 'covered_put', name: 'Covered Put', group: 'Hedged stock', legs: 'Borrow and short the underlying, or use an existing short, and sell a put against it; show the remaining upside exposure.', needs: [STOCK, 'existing', 'borrow', OPT], strikes: ['put'] },
  { id: 'long_collar', name: 'Long Collar', group: 'Hedged stock', legs: 'Buy or use long underlying, buy a lower-strike put, and sell a higher-strike call.', needs: [STOCK, 'existing', OPT], strikes: ['put', 'call'] },
  { id: 'short_collar', name: 'Short Collar', group: 'Hedged stock', legs: 'Borrow and short the underlying, or use an existing short, buy a higher-strike call, and sell a lower-strike put.', needs: [STOCK, 'existing', 'borrow', OPT], strikes: ['put', 'call'] },
  { id: 'cash_secured_put', name: 'Cash-Secured Put', group: 'Options', legs: 'Sell a put and reserve the required exercise cash.', needs: [OPT], strikes: ['put'] },
  { id: 'long_call', name: 'Long Call', group: 'Options', legs: 'Buy a call.', needs: [OPT], strikes: ['call'] },
  { id: 'long_put', name: 'Long Put', group: 'Options', legs: 'Buy a put.', needs: [OPT], strikes: ['put'] },
  { id: 'bull_call_spread', name: 'Bull Call Spread', group: 'Vertical spreads', legs: 'Buy a lower-strike call and sell a higher-strike call with the same expiration.', needs: [OPT], strikes: ['lower', 'upper'], net: true },
  { id: 'bear_put_spread', name: 'Bear Put Spread', group: 'Vertical spreads', legs: 'Buy a higher-strike put and sell a lower-strike put with the same expiration.', needs: [OPT], strikes: ['lower', 'upper'], net: true },
  { id: 'bull_put_spread', name: 'Bull Put Spread', group: 'Vertical spreads', legs: 'Sell a higher-strike put and buy a lower-strike put with the same expiration.', needs: [OPT], strikes: ['lower', 'upper'], net: true },
  { id: 'bear_call_spread', name: 'Bear Call Spread', group: 'Vertical spreads', legs: 'Sell a lower-strike call and buy a higher-strike call with the same expiration.', needs: [OPT], strikes: ['lower', 'upper'], net: true },
  { id: 'long_straddle', name: 'Long Straddle', group: 'Volatility', legs: 'Buy a call and put with the same strike and expiration.', needs: [OPT], strikes: ['middle'], net: true },
  { id: 'long_strangle', name: 'Long Strangle', group: 'Volatility', legs: 'Buy a lower-strike put and higher-strike call with the same expiration.', needs: [OPT], strikes: ['put', 'call'], net: true },
  { id: 'iron_condor', name: 'Iron Condor', group: 'Volatility', legs: 'Sell an inner put and inner call, and buy a lower-strike put and higher-strike call with the same expiration.', needs: [OPT], strikes: ['wingLower', 'put', 'call', 'wingUpper'], net: true },
  { id: 'iron_butterfly', name: 'Iron Butterfly', group: 'Volatility', legs: 'Sell a call and put at the same middle strike, and buy lower-strike put and higher-strike call wings with the same expiration.', needs: [OPT], strikes: ['wingLower', 'middle', 'wingUpper'], net: true },
  { id: 'long_butterfly', name: 'Long Call or Put Butterfly', group: 'Volatility', legs: 'Buy one lower-strike option, sell two middle-strike options, and buy one higher-strike option of the same type, using equal strike spacing and one expiration.', needs: [OPT, 'right'], strikes: ['lower', 'middle', 'upper'], net: true },
  { id: 'long_calendar', name: 'Long Calendar Spread', group: 'Time spreads', legs: 'Sell a nearer-expiration option and buy a later-expiration option of the same type at the same strike.', needs: [OPT, 'right', 'farExpiration'], strikes: ['middle'], net: true },
  { id: 'long_diagonal', name: 'Long Diagonal Spread', group: 'Time spreads', legs: 'Sell a nearer-expiration option and buy a later-expiration option of the same type at a different strike.', needs: [OPT, 'right', 'farExpiration'], strikes: ['near', 'far'], net: true },
  { id: 'synthetic_long', name: 'Synthetic Long', group: 'Synthetics', legs: 'Buy a call and sell a put at the same strike and expiration.', needs: [OPT], strikes: ['middle'], net: true },
  { id: 'synthetic_short', name: 'Synthetic Short', group: 'Synthetics', legs: 'Buy a put and sell a call at the same strike and expiration.', needs: [OPT], strikes: ['middle'], net: true },
  { id: 'pairs_trade', name: 'Pairs Trade', group: 'Relative value', legs: 'Buy one security and borrow/short another using a specified sizing ratio.', needs: [STOCK, 'pair', 'borrow'] },
  { id: 'futures_hedge', name: 'Futures Hedge', group: 'Futures', legs: 'Combine an existing or new underlying exposure with a specified futures position and hedge ratio.', needs: [STOCK, 'existing', FUT] },
  { id: 'futures_calendar', name: 'Futures Calendar Spread', group: 'Futures', legs: 'Buy one contract month and sell another contract month on the same underlying.', needs: [FUT, 'farFuture'] },
  { id: 'custom', name: 'Custom Multi-Leg', group: 'Custom', legs: 'Build a validated package of supported instruments, financing, and hedging legs.', needs: ['legs'] },
];
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
export const getTemplate = (id) => BY_ID.get(id) || null;

/**
 * Assemble a template's legs.
 * ctx supplies facts the template needs but does not own:
 *   ctx.underlying          registry instrument (or null for futures-only / custom templates)
 *   ctx.price(instrumentId) estimated current price or null
 *   ctx.optionMeta({expiration, strike, right}) -> { multiplier, deliverableUnits, exercise, settlement } or null
 *   ctx.position(positionId) -> position or null
 */
export function buildLegs(input, ctx) {
  const tpl = getTemplate(input.template);
  need(tpl, 'Unknown strategy template.');
  if (tpl.id === 'custom') {
    need(Array.isArray(input.legs) && input.legs.length, 'Add at least one leg to the custom package.');
    return input.legs.map((l) => ({ purpose: 'primary', ...l }));
  }
  const und = ctx.underlying;
  const o = input.options || {};
  const strikes = o.strikes || {};
  const existing = input.mode === 'existing';
  const legs = [];
  const uses = (x) => tpl.needs.includes(x);

  // ---- underlying quantity ----------------------------------------------------------------
  let shares = null;
  if (uses(STOCK)) {
    need(und, 'Choose the ticker or instrument.');
    if (existing && uses('existing')) {
      const p = ctx.position(input.existingPositionId);
      need(p && p.instrument_id === und.id, 'Choose the existing position to use, so the underlying is not purchased twice.');
      const wantShort = ['protective_call', 'covered_put', 'short_collar'].includes(tpl.id);
      need(wantShort ? p.qty < 0 : p.qty > 0, wantShort ? 'This template needs an existing short position.' : 'This template needs an existing long position.');
      shares = Math.min(Math.abs(p.qty), num(input.quantity) ?? Math.abs(p.qty));
    } else {
      shares = num(input.quantity);
      if (!(shares > 0) && num(input.targetNotional) > 0) {
        const px = ctx.price(und.id);
        need(px > 0, 'Sizing by target notional needs a price for the underlying, and none is available. Enter a quantity instead.');
        shares = Math.floor(num(input.targetNotional) / (px * und.multiplier));
      }
    }
    need(shares > 0, 'Enter a quantity or a target notional.');
  }

  // ---- option contracts ---------------------------------------------------------------------
  const optionLeg = (role, right, strikeKey, side, { expiration = o.expiration, ratio = 1, dependsOn = [], purpose = 'primary' } = {}) => {
    const strike = num(strikes[strikeKey]);
    need(und, 'Choose the underlying for the options.');
    need(expiration, 'Choose an expiration.');
    need(strike > 0, `Enter the ${strikeLabel(strikeKey)} strike.`);
    const meta = ctx.optionMeta({ expiration, strike, right }) || (o.contractSpec?.multiplier ? { multiplier: num(o.contractSpec.multiplier), deliverableUnits: num(o.contractSpec.deliverableUnits) ?? num(o.contractSpec.multiplier), exercise: o.contractSpec.exercise || 'american', settlement: o.contractSpec.settlement || 'physical' } : null);
    if (!meta) throw new AppError('No contract data is available for this option. Enter the contract multiplier and deliverable (the Terminal does not assume 100 shares per contract).', { code: 'contract_spec_required' });
    let contracts = num(o.contracts);
    if (!(contracts > 0)) {
      need(shares > 0, 'Enter the number of contracts.');
      contracts = Math.floor((shares * (num(input.hedgeRatio) ?? 1)) / meta.deliverableUnits);
      need(contracts >= 1, `The quantity covers less than one contract (one contract delivers ${meta.deliverableUnits} units).`);
    }
    return { purpose, role, kind: 'trade', action: side, qty: contracts * ratio, option: { underlyingId: und.id, expiration, strike, right, ...meta }, dependsOn, group: 'options' };
  };

  const stockLong = () => (existing
    ? { purpose: 'primary', role: 'underlying', kind: 'link', action: 'use_existing', instrumentId: und.id, qty: shares, sourcePositionId: input.existingPositionId, note: 'Uses the existing long position; nothing is purchased.' }
    : { purpose: 'primary', role: 'underlying', kind: 'trade', action: 'buy', instrumentId: und.id, qty: shares });
  const stockShort = (instrument = und, qty = shares, tag = '') => (existing && !tag
    ? [{ purpose: 'primary', role: 'underlying', kind: 'link', action: 'use_existing', instrumentId: instrument.id, qty, sourcePositionId: input.existingPositionId, note: 'Uses the existing short position and its borrow; nothing new is sold.' }]
    : [
      { purpose: 'financing', role: `borrow${tag}`, kind: 'borrow_sec', action: 'borrow_sec', instrumentId: instrument.id, qty, borrow: input.borrow || null, note: 'Simulated securities borrow. The short sale cannot execute without it.' },
      { purpose: 'primary', role: `underlying${tag}`, kind: 'trade', action: 'sell_short', instrumentId: instrument.id, qty, dependsOn: [`borrow${tag}`] },
    ]);

  switch (tpl.id) {
    case 'long': legs.push(stockLong()); break;
    case 'short': legs.push(...stockShort()); break;
    case 'protective_put': legs.push(stockLong(), optionLeg('put', 'P', 'put', 'buy', { purpose: 'hedge' })); break;
    case 'protective_call': legs.push(...stockShort(), optionLeg('call', 'C', 'call', 'buy', { purpose: 'hedge' })); break;
    case 'covered_call': legs.push(stockLong(), optionLeg('call', 'C', 'call', 'sell', { dependsOn: ['underlying'], purpose: 'hedge' })); break;
    case 'covered_put': legs.push(...stockShort(), optionLeg('put', 'P', 'put', 'sell', { dependsOn: ['underlying'], purpose: 'hedge' })); break;
    case 'long_collar':
      need(num(strikes.put) < num(strikes.call), 'A collar needs the put strike below the call strike.');
      legs.push(stockLong(), optionLeg('put', 'P', 'put', 'buy', { purpose: 'hedge' }), optionLeg('call', 'C', 'call', 'sell', { dependsOn: ['underlying'], purpose: 'hedge' }));
      break;
    case 'short_collar':
      need(num(strikes.put) < num(strikes.call), 'A short collar needs the put strike below the call strike.');
      legs.push(...stockShort(), optionLeg('call', 'C', 'call', 'buy', { purpose: 'hedge' }), optionLeg('put', 'P', 'put', 'sell', { dependsOn: ['underlying'], purpose: 'hedge' }));
      break;
    case 'cash_secured_put': {
      const put = optionLeg('put', 'P', 'put', 'sell', { dependsOn: ['reserve'] });
      legs.push({ purpose: 'financing', role: 'reserve', kind: 'reserve', action: 'reserve_cash', qty: put.qty, reserve: { ccy: und.trading_ccy, amount: put.qty * put.option.deliverableUnits * put.option.strike }, note: 'Reserves the cash needed if the put is exercised.' }, put);
      break;
    }
    case 'long_call': legs.push(optionLeg('call', 'C', 'call', 'buy')); break;
    case 'long_put': legs.push(optionLeg('put', 'P', 'put', 'buy')); break;
    case 'bull_call_spread': ordered(strikes, 'lower', 'upper'); legs.push(optionLeg('long_call', 'C', 'lower', 'buy'), optionLeg('short_call', 'C', 'upper', 'sell', { dependsOn: ['long_call'] })); break;
    case 'bear_put_spread': ordered(strikes, 'lower', 'upper'); legs.push(optionLeg('long_put', 'P', 'upper', 'buy'), optionLeg('short_put', 'P', 'lower', 'sell', { dependsOn: ['long_put'] })); break;
    case 'bull_put_spread': ordered(strikes, 'lower', 'upper'); legs.push(optionLeg('long_put', 'P', 'lower', 'buy'), optionLeg('short_put', 'P', 'upper', 'sell', { dependsOn: ['long_put'] })); break;
    case 'bear_call_spread': ordered(strikes, 'lower', 'upper'); legs.push(optionLeg('long_call', 'C', 'upper', 'buy'), optionLeg('short_call', 'C', 'lower', 'sell', { dependsOn: ['long_call'] })); break;
    case 'long_straddle': legs.push(optionLeg('call', 'C', 'middle', 'buy'), optionLeg('put', 'P', 'middle', 'buy')); break;
    case 'long_strangle': ordered(strikes, 'put', 'call'); legs.push(optionLeg('put', 'P', 'put', 'buy'), optionLeg('call', 'C', 'call', 'buy')); break;
    case 'iron_condor':
      ordered(strikes, 'wingLower', 'put', 'call', 'wingUpper');
      legs.push(optionLeg('long_put', 'P', 'wingLower', 'buy'), optionLeg('long_call', 'C', 'wingUpper', 'buy'), optionLeg('short_put', 'P', 'put', 'sell', { dependsOn: ['long_put'] }), optionLeg('short_call', 'C', 'call', 'sell', { dependsOn: ['long_call'] }));
      break;
    case 'iron_butterfly':
      ordered(strikes, 'wingLower', 'middle', 'wingUpper');
      legs.push(optionLeg('long_put', 'P', 'wingLower', 'buy'), optionLeg('long_call', 'C', 'wingUpper', 'buy'), optionLeg('short_put', 'P', 'middle', 'sell', { dependsOn: ['long_put'] }), optionLeg('short_call', 'C', 'middle', 'sell', { dependsOn: ['long_call'] }));
      break;
    case 'long_butterfly': {
      ordered(strikes, 'lower', 'middle', 'upper');
      const lo = num(strikes.lower), mid = num(strikes.middle), hi = num(strikes.upper);
      need(Math.abs(mid - lo - (hi - mid)) < 1e-6, 'A butterfly needs equal spacing between its three strikes.');
      const r = right(o);
      legs.push(optionLeg('long_lower', r, 'lower', 'buy'), optionLeg('long_upper', r, 'upper', 'buy'), optionLeg('short_middle', r, 'middle', 'sell', { ratio: 2, dependsOn: ['long_lower', 'long_upper'] }));
      break;
    }
    case 'long_calendar': {
      need(o.farExpiration && o.farExpiration > o.expiration, 'A calendar spread needs a later expiration for the option you buy.');
      const r = right(o);
      legs.push(optionLeg('long_far', r, 'middle', 'buy', { expiration: o.farExpiration }), optionLeg('short_near', r, 'middle', 'sell', { dependsOn: ['long_far'] }));
      break;
    }
    case 'long_diagonal': {
      need(o.farExpiration && o.farExpiration > o.expiration, 'A diagonal spread needs a later expiration for the option you buy.');
      need(num(strikes.near) !== num(strikes.far), 'A diagonal spread uses two different strikes. For the same strike use a calendar spread.');
      const r = right(o);
      legs.push(optionLeg('long_far', r, 'far', 'buy', { expiration: o.farExpiration }), optionLeg('short_near', r, 'near', 'sell', { dependsOn: ['long_far'] }));
      break;
    }
    case 'synthetic_long': legs.push(optionLeg('call', 'C', 'middle', 'buy'), optionLeg('put', 'P', 'middle', 'sell')); break;
    case 'synthetic_short': legs.push(optionLeg('put', 'P', 'middle', 'buy'), optionLeg('call', 'C', 'middle', 'sell')); break;
    case 'pairs_trade': {
      const other = ctx.instrument(input.pair?.instrumentId);
      need(other, 'Choose the security to short against the long leg.');
      need(other.id !== und.id, 'The two legs of a pair must be different securities.');
      const ratio = num(input.pair?.ratio);
      need(ratio > 0, 'Enter the sizing ratio (short quantity per unit of long quantity).');
      const q2 = Math.round(shares * ratio);
      need(q2 >= 1, 'The sizing ratio gives a short quantity below one.');
      legs.push({ purpose: 'primary', role: 'underlying', kind: 'trade', action: 'buy', instrumentId: und.id, qty: shares }, ...stockShort(other, q2, '_short'));
      break;
    }
    case 'futures_hedge': {
      const fut = ctx.instrument(input.futures?.instrumentId);
      need(fut && fut.family === 'future', 'Choose the futures contract for the hedge.');
      let contracts = num(input.futures?.contracts);
      const ratio = num(input.hedgeRatio) ?? 1;
      if (!(contracts > 0)) {
        const pu = ctx.price(und.id), pf = ctx.price(fut.id);
        need(pu > 0 && pf > 0, 'Sizing the futures leg from the hedge ratio needs prices for both the underlying and the future. Enter the number of contracts instead.');
        contracts = Math.round((ratio * shares * pu * und.multiplier) / (pf * fut.multiplier));
        need(contracts >= 1, 'The hedge ratio gives less than one futures contract.');
      }
      // The futures leg always opposes the underlying exposure it hedges.
      const longExposure = existing ? ctx.position(input.existingPositionId).qty > 0 : input.direction !== 'short';
      if (existing) legs.push({ purpose: 'primary', role: 'underlying', kind: 'link', action: 'use_existing', instrumentId: und.id, qty: shares, sourcePositionId: input.existingPositionId, note: 'Uses the existing position; nothing is purchased.' });
      else if (longExposure) legs.push({ purpose: 'primary', role: 'underlying', kind: 'trade', action: 'buy', instrumentId: und.id, qty: shares });
      else legs.push(...stockShort());
      legs.push({ purpose: 'hedge', role: 'future', kind: 'trade', action: longExposure ? 'sell' : 'buy', instrumentId: fut.id, qty: contracts, note: `Hedge ratio ${ratio}. Futures post margin; the notional is not paid.` });
      break;
    }
    case 'futures_calendar': {
      const a = ctx.instrument(input.futures?.instrumentId), b = ctx.instrument(input.futures?.farInstrumentId);
      need(a && a.family === 'future' && b && b.family === 'future', 'Choose the two contract months.');
      need(a.id !== b.id, 'A calendar spread needs two different contract months.');
      need((a.terms.root || a.underlying_id) === (b.terms.root || b.underlying_id), 'Both contract months must be on the same underlying.');
      const contracts = num(input.futures?.contracts);
      need(contracts > 0, 'Enter the number of contracts.');
      legs.push({ purpose: 'primary', role: 'buy_month', kind: 'trade', action: 'buy', instrumentId: a.id, qty: contracts }, { purpose: 'primary', role: 'sell_month', kind: 'trade', action: 'sell', instrumentId: b.id, qty: contracts });
      break;
    }
    default:
      throw new AppError(`Template ${tpl.id} is not implemented.`);
  }
  return legs;
}

const strikeLabel = (k) => ({ put: 'put', call: 'call', lower: 'lower', upper: 'upper', middle: 'middle', wingLower: 'lower wing', wingUpper: 'upper wing', near: 'near-dated', far: 'far-dated' }[k] || k);
function ordered(strikes, ...keys) {
  for (let i = 1; i < keys.length; i++) {
    const a = num(strikes[keys[i - 1]]), b = num(strikes[keys[i]]);
    need(a > 0 && b > 0, `Enter the ${strikeLabel(keys[i - 1])} and ${strikeLabel(keys[i])} strikes.`);
    need(a < b, `The ${strikeLabel(keys[i - 1])} strike must be below the ${strikeLabel(keys[i])} strike.`);
  }
}
function right(o) {
  const r = String(o.right || '').toUpperCase();
  need(r === 'C' || r === 'P', 'Choose calls or puts for this structure.');
  return r;
}
