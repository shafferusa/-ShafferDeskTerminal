// Default paper-desk assumptions for a Book. Every one of these is a simulation parameter the
// user can change per Book (Settings). They are assumptions of the paper desk, not market
// data: where Shaffer MarketData supplies the real figure (borrow fees, futures margins,
// settlement calendars) the supplied figure is used instead.

export const BOOK_DEFAULTS = {
  // Commissions and fees charged on simulated fills.
  fees: {
    equity: { perUnit: 0, minimum: 0, bps: 0 },
    fund: { perUnit: 0, minimum: 0, bps: 0 },
    spot: { perUnit: 0, minimum: 0, bps: 0 },
    crypto: { perUnit: 0, minimum: 0, bps: 10 },
    manual: { perUnit: 0, minimum: 0, bps: 0 },
    option: { perUnit: 0.65, minimum: 0, bps: 0 }, // per contract
    future: { perUnit: 2.25, minimum: 0, bps: 0 }, // per contract
    fx: { perUnit: 0, minimum: 0, bps: 0 },
    bond: { perUnit: 0, minimum: 0, bps: 0 },
    forward: { perUnit: 0, minimum: 0, bps: 0 },
    otcoption: { perUnit: 0, minimum: 0, bps: 0 },
    swap: { perUnit: 0, minimum: 0, bps: 0 },
    cds: { perUnit: 0, minimum: 0, bps: 0 },
  },
  // Fill model used when an observation has no executable bid/ask of its own.
  fill: {
    // Assumed half bid/ask spread, in basis points of price, by family.
    halfSpreadBps: { equity: 2, fund: 0, spot: 5, crypto: 5, manual: 0, fx: 0.5, bond: 3, forward: 0, otcoption: 0, swap: 0, cds: 0 },
    optionHalfSpreadPct: 1, // % of premium, minimum one tick
    futureHalfSpreadTicks: 0.5,
    slippageBps: 0, // extra adverse move applied to every simulated fill
    participation: 1, // share of the displayed bid/ask size that one matching cycle may take
    allowEndOfDayFills: false, // fill against end-of-day observations (off: orders wait for a fresh price)
    maxQuoteAgeSec: 120, // an executable quote older than this cannot fill an order
    maxPreviewDriftPct: 0.5, // a confirmation is refused if the cash required moved more than this since the preview shown
  },
  // Settlement lag in business days after trade date.
  settlement: { equity: 1, fund: 1, option: 1, bond: 1, crypto: 0, spot: 2, fx: 2, manual: 2, otcoption: 2, swap: 2, cds: 1, forward: 0, future: 0, foreignCash: 2 },
  // Short selling. A short sale always needs a securities borrow; these size its collateral and margin.
  short: {
    collateralPct: 1.02, // cash collateral held against borrowed securities, as a share of market value
    marginPct: 0.3, // additional free cash that must remain available per unit of short market value
  },
  // Short options. Short puts are always fully cash-secured.
  margin: {
    nakedCallPct: 0.2, // share of underlying value reserved per uncovered short call unit
  },
  dividends: { withholdingPct: 0 },
};

export function mergeSettings(base, over) {
  if (over === null || over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeSettings(base[k], v) : v;
  return out;
}
