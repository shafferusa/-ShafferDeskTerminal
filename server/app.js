// Application container: wires the database, the data adapter, the paper ledger and the engine.
//
// The three concerns stay separate:
//   app.data.market      market facts        (Shaffer MarketData; awaiting until connected)
//   app.data.analytics   analytical outputs  (Shaffer Analytics Lab; awaiting until connected)
//   app.ledger / books / positions / orders / packages / accounting   the Terminal's own paper books

import { clock as systemClock, createClock } from './core/clock.js';
import { createAccounting } from './core/accounting.js';
import { createBooks } from './core/books.js';
import { createCorporateActions } from './core/corpactions.js';
import { createEngine } from './core/engine.js';
import { createHedge } from './core/hedge.js';
import { createInstruments } from './core/instruments.js';
import { createLedger } from './core/ledger.js';
import { createOrders } from './core/orders.js';
import { createPackages } from './core/packages.js';
import { createPositions } from './core/positions.js';
import { createSettlement } from './core/settlement.js';
import { createAlerts, createTasks } from './core/tasks.js';
import { createValuation } from './core/valuation.js';
import { createDataAdapter } from './data/index.js';
import { openDatabase } from './db/db.js';
import { createProducts } from './products/index.js';

export function createApp({ config, clock, db } = {}) {
  const app = { config };
  app.clock = clock || (config.testClock ? createClock() : systemClock);
  app.db = db || openDatabase(config.dbFile);
  app.products = createProducts();
  app.data = createDataAdapter({ db: app.db, config, clock: app.clock });
  app.ledger = createLedger(app);
  app.alerts = createAlerts(app);
  app.tasks = createTasks(app);
  app.books = createBooks(app);
  app.positions = createPositions(app);
  app.instruments = createInstruments(app);
  app.data.setInstrumentResolver((id) => app.instruments.get(id));
  app.settle = createSettlement(app);
  app.valuation = createValuation(app);
  app.orders = createOrders(app);
  app.packages = createPackages(app);
  app.hedge = createHedge(app);
  app.corpactions = createCorporateActions(app);
  app.accounting = createAccounting(app);
  app.engine = createEngine(app);
  return app;
}
