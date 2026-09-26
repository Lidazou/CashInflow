/**
 * Migration 1 — initial schema.
 *
 * DESIGN NOTES
 * ------------
 * Money: every amount column is INTEGER in the currency's minor unit.
 * SQLite has no decimal type, and REAL would reintroduce binary float error into
 * the one place it is least tolerable. INTEGER also makes SUM() exact.
 *
 * Dates: `date` columns hold a local calendar date as 'YYYY-MM-DD'. SQLite treats
 * that as a first-class time value, so lexicographic comparison and
 * strftime()/date() both work. We deliberately avoid epoch milliseconds for
 * date-only data — an instant would shift a 23:30 purchase onto the next day
 * when the machine's timezone changes.
 *
 * Balances are NOT stored. An account's balance is always derived as
 * opening_balance + the signed sum of its transactions. A persisted running
 * balance is a second source of truth that silently drifts; a finance app that
 * reports the wrong balance is worse than one that is marginally slower.
 *
 * Transfers: each transfer writes exactly two `transactions` rows with
 * type='transfer' (one negative leg out of the source account, one positive leg
 * into the destination), linked by a row in `transfers`. Because transfers carry
 * their own type, every income/expense aggregate simply filters
 * `type IN ('income','expense')` and transfers can never be double-counted as
 * spending. See spec §14.
 */

export const MIGRATION_1 = `
-- ---------------------------------------------------------------------------
-- Schema version bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('cash','bank','wallet','credit_card','other')),
  currency        TEXT    NOT NULL DEFAULT 'MYR',
  -- Balance before any recorded transaction, in minor units.
  -- Credit cards legitimately start negative (money owed).
  opening_balance INTEGER NOT NULL DEFAULT 0,
  color           TEXT    NOT NULL DEFAULT '#6B7280',
  icon            TEXT    NOT NULL DEFAULT 'wallet',
  archived        INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  note            TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
-- Two accounts may share a name in different currencies, but not within one.
CREATE UNIQUE INDEX idx_accounts_name_currency ON accounts(name, currency);

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('income','expense')),
  icon        TEXT    NOT NULL DEFAULT 'tag',
  color       TEXT    NOT NULL DEFAULT '#6B7280',
  -- Seeded categories are protected from deletion when they are still in use.
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_categories_name_type ON categories(name, type);

-- ---------------------------------------------------------------------------
-- Transfers (pair header)
-- ---------------------------------------------------------------------------
-- Holds the authoritative pairing; the two transaction legs reference it.
-- ON DELETE CASCADE means deleting a transfer row removes both legs atomically.
CREATE TABLE transfers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount           INTEGER NOT NULL CHECK (amount > 0),
  date             TEXT    NOT NULL,
  time             TEXT,
  note             TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  -- A transfer to the same account is meaningless and would corrupt balances.
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX idx_transfers_date ON transfers(date);
CREATE INDEX idx_transfers_from ON transfers(from_account_id);
CREATE INDEX idx_transfers_to   ON transfers(to_account_id);

-- ---------------------------------------------------------------------------
-- Import batches
-- ---------------------------------------------------------------------------
-- One row per confirmed import, so a batch can be reviewed or rolled back as a
-- unit. This is what makes "I imported the wrong file" recoverable.
CREATE TABLE import_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT    NOT NULL,
  preset_id      TEXT    NOT NULL DEFAULT 'generic',
  file_hash      TEXT,
  row_count      INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  type            TEXT    NOT NULL CHECK (type IN ('income','expense','transfer')),
  -- THE ONLY MONEY COLUMN: signed minor units. Positive credits the account,
  -- negative debits it. Because every balance is computed as
  -- opening_balance + SUM(amount), a single signed column makes the balance
  -- query correct *by construction* rather than correct only while three
  -- separate writers happen to agree.
  --
  --   income            -> +amount  (e.g. salary +300000)
  --   expense           -> -amount  (e.g. lunch     -2800)
  --   transfer out leg  -> -amount
  --   transfer in leg   -> +amount
  --
  -- An earlier draft also carried a positive mirror column alongside this one.
  -- That was dropped: two representations of one fact is exactly how a ledger
  -- ends up internally inconsistent, and the "always positive" display value is
  -- trivially recovered as abs(amount).
  amount          INTEGER NOT NULL CHECK (amount <> 0),
  category_id     INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  date            TEXT    NOT NULL,
  time            TEXT,
  merchant        TEXT,
  note            TEXT,
  transfer_id     INTEGER REFERENCES transfers(id) ON DELETE CASCADE,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  -- Stable identity for imported rows, used for duplicate detection (spec §21).
  source_id       TEXT,
  import_hash     TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,

  -- Sign must agree with the declared type. Catching this in the schema means a
  -- coding mistake fails loudly at write time instead of quietly skewing every
  -- statistic the app reports.
  CHECK (type = 'transfer' OR (type = 'income' AND amount > 0) OR (type = 'expense' AND amount < 0)),

  -- Type/leg consistency: a transfer leg must belong to a pair and carry no
  -- category (Actual Budget's rule); an income/expense row must not be paired.
  CHECK (
    (type =  'transfer' AND transfer_id IS NOT NULL AND category_id IS NULL)
    OR
    (type <> 'transfer' AND transfer_id IS NULL)
  )
);

CREATE INDEX idx_tx_date        ON transactions(date DESC);
CREATE INDEX idx_tx_account     ON transactions(account_id, date DESC);
CREATE INDEX idx_tx_category    ON transactions(category_id, date DESC);
CREATE INDEX idx_tx_type_date   ON transactions(type, date DESC);
CREATE INDEX idx_tx_transfer    ON transactions(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX idx_tx_batch       ON transactions(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX idx_tx_merchant    ON transactions(merchant);
CREATE INDEX idx_tx_amount      ON transactions(amount);
-- Duplicate detection: a partial unique index over the content hash. Manual
-- entries have no hash and are therefore never blocked by it.
CREATE UNIQUE INDEX idx_tx_import_hash ON transactions(import_hash) WHERE import_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_tx_source      ON transactions(source_id)  WHERE source_id  IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Budgets
-- ---------------------------------------------------------------------------
-- category_id NULL = the single overall monthly budget.
CREATE TABLE budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  period       TEXT    NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly')),
  limit_amount INTEGER NOT NULL CHECK (limit_amount > 0),
  currency     TEXT    NOT NULL DEFAULT 'MYR',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
-- A partial unique index is needed because SQLite treats NULLs as distinct,
-- which would otherwise allow several "overall" budget rows.
CREATE UNIQUE INDEX idx_budgets_category ON budgets(category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX idx_budgets_overall  ON budgets(period)     WHERE category_id IS NULL;

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  amount           INTEGER NOT NULL CHECK (amount > 0),
  currency         TEXT    NOT NULL DEFAULT 'MYR',
  cycle            TEXT    NOT NULL CHECK (cycle IN ('weekly','monthly','quarterly','semiannual','yearly')),
  next_charge_date TEXT,
  account_id       INTEGER REFERENCES accounts(id)   ON DELETE SET NULL,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  note             TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);
CREATE INDEX idx_subs_active ON subscriptions(active, next_charge_date);

-- ---------------------------------------------------------------------------
-- Recurring rules (reminders / suggested transactions only)
-- ---------------------------------------------------------------------------
-- The spec is explicit that the app must never silently rewrite financial data,
-- so a due rule surfaces a suggestion the user confirms; last_run_date records
-- when it was last turned into a real transaction.
CREATE TABLE recurring_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  type          TEXT    NOT NULL CHECK (type IN ('income','expense')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  account_id    INTEGER NOT NULL REFERENCES accounts(id)   ON DELETE CASCADE,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  merchant      TEXT,
  note          TEXT,
  frequency     TEXT    NOT NULL CHECK (frequency IN ('weekly','monthly','yearly')),
  -- Day-of-month (1-31) for monthly/yearly; weekday (0-6) for weekly.
  day_of_period INTEGER NOT NULL,
  month_of_year INTEGER CHECK (month_of_year IS NULL OR (month_of_year BETWEEN 1 AND 12)),
  last_run_date TEXT,
  next_due_date TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX idx_recurring_due ON recurring_rules(active, next_due_date);

-- ---------------------------------------------------------------------------
-- Settings (single-row key/value store)
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
