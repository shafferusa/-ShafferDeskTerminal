// Product-family registry. Each registry instrument belongs to exactly one family, and the
// family's plugin owns its contract terms, accounting conventions, valuation and lifecycle.
// Adding a product family means adding a plugin here; nothing else in the core changes.

import { bond } from './bond.js';
import { loan, repo, secloan } from './financing.js';
import { future } from './future.js';
import { forward, fx } from './fx.js';
import { option, otcoption } from './option.js';
import { crypto, equity, fund, manual, spot } from './security.js';
import { cds, swap } from './swap.js';

const PLUGINS = { equity, fund, spot, crypto, manual, option, otcoption, future, fx, forward, bond, loan, repo, secloan, swap, cds };

export function createProducts() {
  return {
    get(family) {
      const p = PLUGINS[family];
      if (!p) throw new Error(`No product plugin for family "${family}"`);
      return p;
    },
    has: (family) => Boolean(PLUGINS[family]),
    families: () => Object.keys(PLUGINS),
    all: () => Object.values(PLUGINS),
  };
}
