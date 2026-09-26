/**
 * Migration 2 — multi-currency exchange rates and settlement cycles.
 *
 * Added for the Chinese-international-student use case:
 *   - amounts must be viewable in CNY / MYR / SGD / USD / HKD at live rates
 *   - a monthly allowance paid on the 5th means the reporting period is
 *     5 Aug – 4 Sep, not 1–31 Aug
 *
 * Kept as a separate migration rather than editing migration 1 so that a database
 * created by the previous build upgrades in place instead of needing to be
 * deleted. Migrations are append-only: an applied migration is never edited,
 * because every existing database has already run the old version and has no way
 * to re-run it.
 */

export const MIGRATION_2 = `
-- ---------------------------------------------------------------------------
-- Exchange rates
-- ---------------------------------------------------------------------------
-- Rates are DECIMAL values, unlike every money column in this schema. That is
-- deliberate and is the one place a float is correct: an exchange rate is a
-- published quote (0.606575), not an amount of money, and storing it as an
-- integer would quantise it and lose real precision. The amounts it produces are
-- immediately rounded to integer minor units before they are ever displayed or
-- stored. See shared/lib/rates.ts.
CREATE TABLE exchange_rates (
  base        TEXT    NOT NULL,
  quote       TEXT    NOT NULL,
  rate        REAL    NOT NULL CHECK (rate > 0),
  provider    TEXT    NOT NULL,
  fetched_at  TEXT    NOT NULL,
  PRIMARY KEY (base, quote)
);

CREATE INDEX idx_rates_base ON exchange_rates(base);

-- Single-row key/value metadata for the cached table: which base currency it is
-- expressed against, when it was fetched, and whether the user typed it by hand.
CREATE TABLE exchange_rate_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Saved custom statistics periods
-- ---------------------------------------------------------------------------
-- The statistics page supports an arbitrary date range. Saving one lets a user
-- keep a named period such as a semester or a trip, with its own budget, instead
-- of re-entering the dates every time.
CREATE TABLE custom_periods (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  from_date     TEXT    NOT NULL,
  to_date       TEXT    NOT NULL,
  -- Optional total for the period, in minor units. NULL means "no budget set".
  budget_amount INTEGER CHECK (budget_amount IS NULL OR budget_amount > 0),
  currency      TEXT    NOT NULL DEFAULT 'CNY',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  CHECK (from_date <= to_date)
);

CREATE INDEX idx_custom_periods_range ON custom_periods(from_date, to_date);
`
