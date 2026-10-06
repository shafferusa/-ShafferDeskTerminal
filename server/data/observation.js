// The single observation shape used for every market fact the Terminal displays or books against.
//
// An observation is either present (an object like the one below) or missing (null). Missing is
// never turned into zero. Every present observation says where it came from, when, in what
// currency and units, and how fresh it is.

/**
 * @typedef {Object} Observation
 * @property {'price'|'fx'|'rate'|'borrow'|'fixing'} kind
 * @property {string} subject          instrument id, currency pair 'EUR/USD', or rate code
 * @property {number|null} value       last / mark / rate level
 * @property {number|null} bid
 * @property {number|null} ask
 * @property {number|null} bidSize     in the instrument's quantity units
 * @property {number|null} askSize
 * @property {number|null} prevClose
 * @property {string|null} currency
 * @property {string|null} units       e.g. 'per share', '% of par (clean)', 'percent p.a.', 'quote per base'
 * @property {string} source           human name: 'Shaffer MarketData', 'Shaffer Analytics Lab', 'Manual entry', 'Simulated demo feed'
 * @property {string} providerId       'shaffer-marketdata' | 'shaffer-analytics' | 'manual' | 'demo'
 * @property {string} status           real-time | delayed | end-of-day | indicative | model-derived | reconstructed | manual | simulated
 *                                    (observed quotes, indicative OTC terms, model marks, reconstructed prices and manual inputs stay distinguishable)
 * @property {number|null} delayMinutes
 * @property {string|null} asOf        ISO instant the observation refers to
 * @property {string|null} forDate     business date for closes / fixings
 * @property {string} receivedAt       ISO instant the Terminal obtained it
 * @property {string[]} assumptions
 * @property {Object} extra
 */

export const STATUSES = ['real-time', 'delayed', 'end-of-day', 'indicative', 'model-derived', 'reconstructed', 'manual', 'simulated'];

export const STATUS_LABEL = {
  'real-time': 'Real-time',
  delayed: 'Delayed',
  'end-of-day': 'End-of-day',
  indicative: 'Indicative',
  'model-derived': 'Model-derived',
  reconstructed: 'Reconstructed',
  manual: 'Manually entered',
  simulated: 'Simulated (demo feed)',
};

/** Statuses that represent a market quote one could plausibly execute against. */
export const EXECUTABLE_STATUSES = new Set(['real-time', 'delayed', 'simulated']);

export function makeObservation(o) {
  return {
    kind: o.kind || 'price',
    subject: o.subject,
    value: fin(o.value),
    bid: fin(o.bid),
    ask: fin(o.ask),
    bidSize: fin(o.bidSize),
    askSize: fin(o.askSize),
    prevClose: fin(o.prevClose),
    currency: o.currency ?? null,
    units: o.units ?? null,
    source: o.source,
    providerId: o.providerId,
    status: o.status,
    delayMinutes: fin(o.delayMinutes),
    asOf: o.asOf ?? null,
    forDate: o.forDate ?? null,
    receivedAt: o.receivedAt,
    assumptions: o.assumptions || [],
    extra: o.extra || {},
    id: o.id ?? undefined,
  };
}

function fin(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/** Mid of bid/ask when both exist, otherwise the last/mark value. Null when nothing is known. */
export function midOf(obs) {
  if (!obs) return null;
  if (obs.bid !== null && obs.ask !== null && obs.bid > 0 && obs.ask > 0) return (obs.bid + obs.ask) / 2;
  return obs.value;
}

/** Price used to value a position: last/mark if present, else the mid. */
export function markOf(obs) {
  if (!obs) return null;
  return obs.value !== null ? obs.value : midOf(obs);
}

/** Adds age and freshness for display. */
export function withFreshness(obs, nowMs, freshness) {
  if (!obs) return null;
  const asOfMs = obs.asOf ? Date.parse(obs.asOf) : null;
  const ageSec = asOfMs ? Math.max(0, Math.round((nowMs - asOfMs) / 1000)) : null;
  let fresh = 'unknown';
  if (obs.status === 'manual') fresh = 'manual';
  else if (ageSec !== null) {
    const limit = (freshness[obs.status] ?? 600) + (obs.delayMinutes ? obs.delayMinutes * 60 : 0);
    fresh = ageSec <= limit ? 'fresh' : 'stale';
  }
  return { ...obs, ageSec, freshness: fresh, statusLabel: STATUS_LABEL[obs.status] || obs.status };
}

/** Standard "not available" result for port calls that return a payload rather than a map. */
export const unavailable = (reason, message) => ({ available: false, reason, message });

export const AWAITING_MESSAGE = 'Awaiting Shaffer data connection';
