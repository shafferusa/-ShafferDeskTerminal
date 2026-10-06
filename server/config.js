// Configuration. Three layers, later wins:
//   1. defaults below
//   2. environment variables (service credentials live ONLY here, never in the database or browser)
//   3. settings saved from the Terminal's Settings page (service addresses, refresh timings)

import { resolve } from 'node:path';

export const DEFAULT_CONNECTION = {
  // Shaffer services. Empty until the real service addresses are supplied.
  marketDataUrl: '',
  analyticsUrl: '',
  gatewayUrl: '',          // approved authenticated gateway/proxy, if the services sit behind one
  requestTimeoutMs: 8000,
};

export const DEFAULT_REFRESH = {
  quotesMs: 5000,          // price refresh for instruments on screen / with working orders
  fxMs: 15000,
  ratesMs: 15 * 60 * 1000,
  referenceMs: 6 * 60 * 60 * 1000,
  analyticsMs: 5 * 60 * 1000,
  engineTickMs: 3000,      // order matching / settlement / lifecycle cycle
  uiPollMs: 4000,
  // Freshness: an observation older than this (seconds) is flagged stale.
  freshness: { 'real-time': 60, delayed: 1200, indicative: 600, 'end-of-day': 4 * 86400, simulated: 60, 'model-derived': 86400 },
};

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const demo = argv.includes('--demo') || env.SDT_DEMO === '1';
  const dataDir = resolve(env.SDT_DATA_DIR || 'data');
  const portArg = argv.find((a) => a.startsWith('--port='));
  return {
    demo,
    host: env.SDT_HOST || env.HOST || '127.0.0.1',
    port: Number(portArg ? portArg.split('=')[1] : env.SDT_PORT || env.PORT || (demo ? 8788 : 8787)),
    dataDir,
    // Demo mode uses its own database so simulated trades never mix with the real paper books.
    dbFile: env.SDT_DB_FILE || resolve(dataDir, demo ? 'demo.db' : 'terminal.db'),
    // Optional password for hosted deployments (HTTP Basic). Unset = no login (local use).
    password: env.SDT_PASSWORD || '',
    connectionEnv: {
      marketDataUrl: env.SHAFFER_MARKETDATA_URL || '',
      analyticsUrl: env.SHAFFER_ANALYTICS_URL || '',
      gatewayUrl: env.SHAFFER_GATEWAY_URL || '',
    },
    // Credentials are read from the environment at call time and are never returned by the API.
    credentials: {
      header: env.SHAFFER_AUTH_HEADER || 'Authorization',
      token: env.SHAFFER_API_TOKEN || '',
      hasToken: Boolean(env.SHAFFER_API_TOKEN),
    },
    engine: { autoStart: env.SDT_ENGINE !== 'off' },
  };
}
