// Database schema. Migrations are append-only: add a new entry, never edit an old one.
// Paper-trading state (books, ledger, positions, orders, fills) is never rewritten by
// market-data refreshes: refreshable data lives only in `quote_cache`.

export const MIGRATIONS = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE engine_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  reporting_ccy TEXT NOT NULL DEFAULT 'USD',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived_at TEXT
);

-- A unit is the Treasury or one Account of a Book. Every transaction belongs to a Book and one unit.
CREATE TABLE units (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  kind TEXT NOT NULL CHECK (kind IN ('treasury','account')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (book_id, name)
);

-- Instrument registry. IDs are Terminal IDs; tickers are optional. external_ids holds the
-- Shaffer MarketData instrument ID (and any others) once reference data is connected.
CREATE TABLE instruments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  family TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT,
  market_view TEXT NOT NULL CHECK (market_view IN ('US_CASH','US_DERIV','FOREIGN_CASH','FOREIGN_DERIV')),
  tags TEXT NOT NULL DEFAULT '[]',
  issuer TEXT,
  domicile TEXT,
  venue TEXT,
  venue_type TEXT NOT NULL DEFAULT 'exchange',
  underlying_id TEXT,
  underlying_geo TEXT,
  trading_ccy TEXT NOT NULL,
  settle_ccy TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  terms TEXT NOT NULL DEFAULT '{}',
  external_ids TEXT NOT NULL DEFAULT '{}',
  ref_source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_instruments_view ON instruments(market_view, family);
CREATE INDEX idx_instruments_symbol ON instruments(symbol);
CREATE INDEX idx_instruments_underlying ON instruments(underlying_id);

CREATE TABLE watchlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  market_view TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE watchlist_items (
  watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watchlist_id, instrument_id)
);

-- Append-only store of observations the Terminal has persisted: manual entries, and the exact
-- price / FX / rate observations used for a fill, a ledger posting or a valuation snapshot.
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- price | fx | rate | borrow | fixing
  subject TEXT NOT NULL,           -- instrument id, 'EUR/USD', or rate code
  value REAL,
  bid REAL,
  ask REAL,
  bid_size REAL,
  ask_size REAL,
  currency TEXT,
  units TEXT,
  source TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL,
  as_of TEXT,
  for_date TEXT,                   -- business date the observation refers to (fixings, closes)
  received_at TEXT NOT NULL,
  origin TEXT NOT NULL,            -- manual-entry | used
  note TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  superseded_by INTEGER
);
CREATE INDEX idx_obs_subject ON observations(kind, subject, id);

-- Refreshable cache of the latest observation per subject. Safe to delete at any time.
CREATE TABLE quote_cache (
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, subject)
);

-- Audit trail. Rows are never updated or deleted; a correction is a new event that points at
-- the original through corrects_event_id.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  business_date TEXT NOT NULL,
  book_id TEXT NOT NULL,
  unit_id TEXT,
  type TEXT NOT NULL,
  instrument_id TEXT,
  strategy_id TEXT,
  order_id TEXT,
  position_id TEXT,
  summary TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  corrects_event_id INTEGER,
  actor TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX idx_events_book ON events(book_id, id);
CREATE INDEX idx_events_unit ON events(unit_id, id);
CREATE INDEX idx_events_strategy ON events(strategy_id);

-- Double-entry ledger lines. For every event, amounts sum to zero per unit per currency.
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  account TEXT NOT NULL,
  ccy TEXT NOT NULL,
  amount REAL NOT NULL,
  amount_rc REAL,                  -- reporting-currency equivalent at posting time; NULL when no FX observation existed
  fx_rate REAL,
  fx_obs_id INTEGER,
  instrument_id TEXT,
  strategy_id TEXT,
  position_id TEXT,
  business_date TEXT NOT NULL
);
CREATE INDEX idx_entries_unit ON entries(unit_id, account, ccy);
CREATE INDEX idx_entries_event ON entries(event_id);
CREATE INDEX idx_entries_position ON entries(position_id, account);
CREATE INDEX idx_entries_book_date ON entries(book_id, business_date);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,          -- signed total cost in trading currency (short positions negative)
  pledged_qty REAL NOT NULL DEFAULT 0,
  onloan_qty REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (unit_id, instrument_id, strategy_id)
);
CREATE INDEX idx_positions_unit ON positions(unit_id);
CREATE INDEX idx_positions_book ON positions(book_id);
CREATE INDEX idx_positions_strategy ON positions(strategy_id);

CREATE TABLE position_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  business_date TEXT NOT NULL,
  qty REAL NOT NULL
);
CREATE INDEX idx_poshist ON position_history(position_id, id);

-- A strategy instance: one confirmed package of legs created from an execution template.
CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  template TEXT NOT NULL,
  name TEXT NOT NULL,
  underlying_id TEXT,
  status TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  preview TEXT NOT NULL DEFAULT '{}',
  client_token TEXT UNIQUE,
  signal_ref TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_strategies_book ON strategies(book_id, status);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  submission TEXT NOT NULL,             -- groups the legs submitted by one confirmation
  leg_no INTEGER NOT NULL,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  instrument_id TEXT,
  kind TEXT NOT NULL,                   -- trade | borrow_sec | return_sec | loan | repay | repo_open | repo_close | lend_sec | recall_sec | reserve | link | funding
  action TEXT NOT NULL,
  role TEXT,
  qty REAL NOT NULL,
  filled_qty REAL NOT NULL DEFAULT 0,
  avg_price REAL,
  order_type TEXT NOT NULL DEFAULT 'market',
  limit_price REAL,
  stop_price REAL,
  tif TEXT NOT NULL DEFAULT 'day',
  status TEXT NOT NULL,                 -- pending | working | partial | filled | rejected | cancelled | expired
  status_reason TEXT,
  depends_on TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  good_until TEXT
);
CREATE INDEX idx_orders_strategy ON orders(strategy_id, leg_no);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_book ON orders(book_id, status);

CREATE TABLE fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  ts TEXT NOT NULL,
  business_date TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL,
  gross REAL,
  ccy TEXT,
  fees TEXT NOT NULL DEFAULT '[]',
  fill_model TEXT NOT NULL,
  fill_note TEXT,
  price_obs_id INTEGER,
  fx_obs_id INTEGER,
  settle_date TEXT,
  event_id INTEGER
);
CREATE INDEX idx_fills_order ON fills(order_id);

-- Cash movements that follow execution: pending until the settlement date, then settled or failed.
CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  fill_id TEXT,
  order_id TEXT,
  instrument_id TEXT,
  strategy_id TEXT,
  position_id TEXT,
  kind TEXT NOT NULL,
  due_date TEXT NOT NULL,
  ccy TEXT NOT NULL,
  amount REAL NOT NULL,                  -- positive: unit receives cash; negative: unit pays cash
  accounts TEXT NOT NULL DEFAULT '["cash"]',   -- cash buckets to receive into / pay from, in order
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | settled | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  event_id INTEGER
);
CREATE INDEX idx_settlements_due ON settlements(status, due_date);
CREATE INDEX idx_settlements_unit ON settlements(unit_id, status);

-- Reserved cash. Reduces available cash without moving it.
CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  ccy TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT NOT NULL,                    -- order | exercise_cash | option_margin | short_margin | manual
  ref_type TEXT,
  ref_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX idx_holds_unit ON holds(unit_id, released_at);
CREATE INDEX idx_holds_ref ON holds(ref_type, ref_id);

-- Scheduled lifecycle work: coupons, expirations, maturities, resets, payments, recalls.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  position_id TEXT,
  instrument_id TEXT,
  strategy_id TEXT,
  type TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | blocked | done | cancelled | failed
  blocked_reason TEXT,
  needs TEXT NOT NULL DEFAULT '[]',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  done_at TEXT,
  event_id INTEGER
);
CREATE INDEX idx_tasks_due ON tasks(status, due_date);
CREATE INDEX idx_tasks_position ON tasks(position_id, status);

CREATE TABLE corporate_actions (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  type TEXT NOT NULL,                    -- cash_dividend | split | other
  ex_date TEXT NOT NULL,
  pay_date TEXT,
  amount REAL,
  ccy TEXT,
  ratio_num REAL,
  ratio_den REAL,
  source TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_ca_instrument ON corporate_actions(instrument_id, ex_date);

-- End-of-day valuation snapshots per unit, with the observations used.
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  complete INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (date, unit_id)
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  book_id TEXT,
  unit_id TEXT,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  resolved_at TEXT
);
CREATE INDEX idx_alerts_open ON alerts(resolved_at, book_id);
`,
  },
  {
    id: 2,
    name: 'hedge requests',
    sql: `
-- A hedge request sent (or ready to send) to Shaffer Hedge in Analytics Lab, the response received,
-- and what was done with it. Legs executed from a response carry this id as their hedge link.
CREATE TABLE hedge_requests (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT,
  scope_type TEXT NOT NULL,              -- trade | strategy_package | account | book
  scope_id TEXT,
  strategy_id TEXT,                      -- strategy instance holding the primary position, if any
  trigger TEXT NOT NULL,                 -- strategy_page | post_trade | review | manual
  request TEXT NOT NULL,
  response TEXT,
  status TEXT NOT NULL,                  -- awaiting | received | error | dismissed | executed | superseded
  message TEXT,
  selected_package TEXT,
  executed_submission TEXT,
  prompt_seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_hedge_strategy ON hedge_requests(strategy_id, created_at);
CREATE INDEX idx_hedge_book ON hedge_requests(book_id, status);
`,
  },
  {
    id: 3,
    name: 'listing venue country',
    sql: `
-- ISO country of the listing venue. It selects the settlement calendar; the market view, issuer
-- domicile and underlying geography remain separate fields.
ALTER TABLE instruments ADD COLUMN venue_country TEXT;
`,
  },
  {
    id: 4,
    name: 'protection allocations',
    sql: `
-- What protects what. One row allocates capacity of one hedge position to one protected position.
-- A hedge counts as protection for a position only through an active row here: an explicit link
-- (legs executed from that position's hedge request), protection built into the execution
-- template, or an allocation returned by the service (Analytics Lab). The Terminal validates and
-- stores these; it does not decide applicability or sizing for anything not explicitly linked.
CREATE TABLE protection_allocations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  hedge_position_id TEXT NOT NULL,
  protected_position_id TEXT NOT NULL,
  strategy_id TEXT,                      -- strategy instance of the protected position
  units REAL,                            -- units of the protected instrument covered; NULL = linked, no unit measure
  capacity REAL,                         -- hedge capacity in the same units: the Terminal's rule, or stated by the service
  basis TEXT NOT NULL,                   -- explicit_link | template | service
  source TEXT,                           -- JSON { kind, label, version, receivedAt } of whoever identified it
  request_id TEXT,                       -- hedge request the link or the assessment came from
  status TEXT NOT NULL,                  -- active | released | expired | rejected
  reason TEXT,                           -- why it was released, expired or rejected
  note TEXT,
  hedge_qty REAL,                        -- quantities when the allocation was recorded
  protected_qty REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_protalloc_hedge ON protection_allocations(hedge_position_id, status);
CREATE INDEX idx_protalloc_protected ON protection_allocations(protected_position_id, status);
CREATE INDEX idx_protalloc_unit ON protection_allocations(unit_id, status);
-- A hedge the service looked at and judged unrelated to a position. Kept so the position can say
-- "unrelated" (assessed) rather than "assessment unavailable" (never assessed).
CREATE TABLE protection_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  hedge_position_id TEXT NOT NULL,
  protected_position_id TEXT NOT NULL,
  verdict TEXT NOT NULL,                 -- unrelated
  note TEXT,
  source TEXT,
  request_id TEXT,
  hedge_qty REAL,
  created_at TEXT NOT NULL,
  UNIQUE (hedge_position_id, protected_position_id)
);
`,
  },
  {
    id: 5,
    name: 'collateral agreements',
    sql: `
-- A paper collateral agreement (bilateral CSA-style, cleared, or an explicit uncollateralized
-- assumption). It belongs to exactly one Book and covers units of that Book only.
CREATE TABLE agreements (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  name TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bilateral','cleared','uncollateralized')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  posting_unit_id TEXT REFERENCES units(id),   -- set only for a shared arrangement: the unit that posts and receives
  terms TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (book_id, name)
);
CREATE TABLE agreement_units (
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  unit_id TEXT NOT NULL REFERENCES units(id),
  PRIMARY KEY (agreement_id, unit_id)
);

-- Register of OTC collateral movements. One row per ledger event and Account the amount is
-- allocated to; the rows of an event add up to what the ledger moved.
-- amount: change in the signed balance (+ posted by us, - held from the counterparty).
CREATE TABLE collateral_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  business_date TEXT NOT NULL,
  book_id TEXT NOT NULL,
  agreement_id TEXT,                     -- NULL for position-level terms
  set_key TEXT NOT NULL,                 -- netting set: P:<position> | A:<agreement>:<unit> | S:<agreement>
  kind TEXT NOT NULL,                    -- independent | variation
  holder_unit_id TEXT NOT NULL,          -- the unit whose ledger moved
  allocated_unit_id TEXT NOT NULL,       -- the Account whose positions the amount collateralises
  position_id TEXT,
  ccy TEXT NOT NULL,
  amount REAL NOT NULL
);
CREATE INDEX idx_collmov_set ON collateral_movements(set_key, kind);
CREATE INDEX idx_collmov_book ON collateral_movements(book_id, id);
CREATE INDEX idx_collmov_position ON collateral_movements(position_id);
CREATE INDEX idx_collmov_agreement ON collateral_movements(agreement_id);

-- Latest valuation of each requirement: IA:<position> or VM:<netting set>.
CREATE TABLE collateral_state (
  key TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  agreement_id TEXT,
  kind TEXT NOT NULL,                    -- independent | variation
  holder_unit_id TEXT,
  ccy TEXT,
  status TEXT NOT NULL,                  -- ok | failed | cannot_value | closed
  required REAL,
  held REAL,
  pending REAL,
  reason TEXT,
  as_of TEXT,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  last_event_id INTEGER
);
CREATE INDEX idx_collstate_book ON collateral_state(book_id, status);
`,
  },
  {
    id: 6,
    name: 'instrument conventions and fill reconciliation',
    sql: `
-- Calendars and settlement convention set on the instrument itself (JSON):
-- { tradingCalendar, settlementCalendar, paymentCalendar, settleLag }. NULL: nothing set, so the
-- venue country, the currency and the Book's settlement lags decide, as before.
ALTER TABLE instruments ADD COLUMN conventions TEXT;
-- How a fill compares with the figures confirmed for its order (JSON):
-- { confirmed, actual, variance, exact, within, tolerances, reason }. NULL for fills booked before this.
ALTER TABLE fills ADD COLUMN confirm TEXT;
`,
  },
];
