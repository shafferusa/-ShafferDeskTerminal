// Option arithmetic for trade previews.
//
// Expiry payoffs are exact contract arithmetic. The Black-Scholes function is used ONLY to draw
// scenario views for structures whose legs expire on different dates (calendars, diagonals), and
// only when a volatility input is available (from supplied chain data or a figure the user
// states). It is a preview approximation, not a valuation model: marks, risk and hedge figures
// belong to Shaffer Analytics Lab.

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Intrinsic value per unit of underlying. */
export function intrinsic(right, S, K) {
  return right === 'C' ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

/** Black-Scholes price per unit of underlying. T in years; r, q, sigma decimals. */
export function blackScholes({ S, K, T, r = 0, q = 0, sigma, right }) {
  if (!(T > 0) || !(sigma > 0) || !(S > 0) || !(K > 0)) return intrinsic(right, S, K);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  if (right === 'C') return S * Math.exp(-q * T) * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * Math.exp(-q * T) * normCdf(-d1);
}

/** Black-Scholes delta per unit of underlying (used for the preview's hedge-ratio hint only). */
export function bsDelta({ S, K, T, r = 0, q = 0, sigma, right }) {
  if (!(T > 0) || !(sigma > 0) || !(S > 0) || !(K > 0)) {
    if (right === 'C') return S > K ? 1 : 0;
    return S < K ? -1 : 0;
  }
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return right === 'C' ? Math.exp(-q * T) * normCdf(d1) : Math.exp(-q * T) * (normCdf(d1) - 1);
}
