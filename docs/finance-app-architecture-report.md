# Architecture patterns for a Windows desktop personal-finance app
**Sources:** securo, kakutey, Actual Budget, Firefly III, Money Manager Ex (MMEX), Ghostfolio, Wealthfolio + Electron/SQLite packaging research. Verified 2026-09-26. Column names below are read from primary sources.

## 1. Data model lessons

Four transfer models exist. Pick deliberately.

| Project | Transfer model |
|---|---|
| **MMEX** | **One row**: `CHECKINGACCOUNT_V1(TRANSCODE ∈ {Withdrawal,Deposit,Transfer}, ACCOUNTID, TOACCOUNTID, TOTRANSAMOUNT)` — `TOTRANSAMOUNT` holds the credited amount for cross-currency |
| **Actual** | **Paired rows** in one `transactions` table linked by `transferred_id`; the counterpart is a synthetic payee via `payees.transfer_acct → accounts.id` |
| **Firefly III** | **Double-entry**: `transaction_groups` → `transaction_journals` (exactly 2 `transactions` rows) → `transactions(account_id, amount, identifier)`; `transaction_journals.transaction_type_id` ∈ {Withdrawal, Deposit, Transfer, Opening balance, …} |
| **Wealthfolio** | **Paired rows** (`TRANSFER_OUT`/`TRANSFER_IN`) linked by `source_group_id`, paired lazily at calc time |

MMEX's single row cannot express a transfer whose legs post on different dates with independent cleared state — the real ACH/wire case. Actual's docs are explicit that both legs exist and are kept in sync on payee/amount/notes, while `cleared`, `reconciled`, `category` and `date` stay independent; deleting either leg deletes both. **Use paired rows.** Actual also leaves the category **NULL** for on-budget↔on-budget transfers (rendered as `Transfer`); MMEX reserves category id 57.

```sql
CREATE TABLE currencies(code TEXT PRIMARY KEY, scale INTEGER NOT NULL, symbol TEXT);
CREATE TABLE accounts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,   -- checking|savings|credit|loan|asset|investment
  currency TEXT NOT NULL REFERENCES currencies(code),
  on_budget INTEGER NOT NULL DEFAULT 1, closed INTEGER NOT NULL DEFAULT 0,
  tombstone INTEGER NOT NULL DEFAULT 0, sort_order REAL NOT NULL DEFAULT 0,
  starting_balance INTEGER NOT NULL, starting_date TEXT NOT NULL);  -- 'YYYY-MM-DD'
CREATE TABLE transactions(
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,                     -- local calendar date, 'YYYY-MM-DD'
  amount INTEGER NOT NULL,                -- signed minor units; the ONLY money column
  payee_id TEXT REFERENCES payees(id),
  category_id TEXT REFERENCES categories(id),    -- NULL for internal transfers
  transfer_id TEXT,                       -- self-FK to the opposite leg
  is_parent INTEGER NOT NULL DEFAULT 0, parent_id TEXT REFERENCES transactions(id),
  cleared INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0,
  imported_id TEXT, import_hash TEXT, idempotency_key TEXT UNIQUE,
  notes TEXT, tombstone INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX ix_tx_acct_date ON transactions(account_id, date) WHERE tombstone = 0;
CREATE UNIQUE INDEX ux_tx_transfer ON transactions(transfer_id) WHERE transfer_id IS NOT NULL;
```

Splits: Actual self-references (`isParent`/`isChild`/`parent_id`) in the same table; MMEX uses child rows `SPLITTRANSACTIONS_V1(TRANSID, CATEGID, SPLITTRANSAMOUNT, NOTES)`; Firefly makes a split = one journal with N legs. **Self-reference wins** — one query shape, and children are ordinary re-categorisable rows. Enforce child sums = parent with a trigger.

Categories: make income a property of the **group**, not the row (Actual's `category_groups.is_income` / `categories.cat_group`); MMEX nests via `CATEGORY_V1.PARENTID` (`-1` = root).

**Avoid double-counting by construction:** never compute income/expense from `SUM(amount)`. Filter `WHERE parent_id IS NULL AND transfer_id IS NULL AND tombstone = 0` and exclude the opening-balance anchor. Transfers then net to zero with no special-casing. Backfilling old unlinked transfers (Actual's approach): match `amount = -amount`, different accounts, dates within 3 days, **only when exactly one candidate exists**.

## 2. Money representation

**MMEX** uses `numeric` (SQLite NUMERIC → REAL) with `CURRENCYFORMATS_V1.SCALE` (100; BTC 100000000) — **lossy**. **Actual** uses **INTEGER minor units** (`amount INTEGER`), exposed as `Decimal`. **Firefly III** uses `decimal(32,12)` model-cast to a PHP **string** so no float touches it — yet still produced ["off by 36.120000000000"](https://github.com/orgs/firefly-iii/discussions/10887). **Ghostfolio** uses Prisma `Float` → `DOUBLE PRECISION` with all math in `big.js`. **Wealthfolio** uses `rust_decimal::Decimal` stored as **TEXT**, in a migration that explicitly converted *from* DOUBLE.

**Recommend integer minor units (i64)** with `scale` on the currency row (JPY 0, USD 2, BHD 3, BTC 8), formatting only at the UI edge. Decimal-as-TEXT is the acceptable second choice. Never `REAL`.

## 3. Balance computation

Firefly is the only project with a canonical balance table, and it pairs it with an invalidation flag: `account_balances(account_id, date, balance)` plus per-leg running `balance_before`/`balance_after` and a **`balance_dirty`** bool. MMEX derives from `INITIALBAL`+`INITIALDATE`; Actual derives from a `starting_balance_flag` anchor; Ghostfolio has no ledger balance at all (Redis-cached snapshot); Wealthfolio keeps `holdings_snapshots`/`daily_account_valuation` tables that migrations deliberately `DELETE` to force recompute — caches, not truth.

Derived is safer. Do: a view `starting_balance + SUM(amount)`; if you cache, copy Firefly's `dirty` flag rather than trusting it; keep bank truth in **separate nullable columns** (Actual physically carries `balance_current/available/limit INTEGER` as bank-sync residue) so "ledger vs bank" is two numbers, never silently reconciled. Ship `recompute_balances()`. Wealthfolio's trick is worth copying: `total_value = cash_balance + investment_value` with cash in its own map, so holdings and cash cannot double-count.

## 4. Electron architecture

`main` (Node) owns SQLite; `preload` exposes a **narrow named API** via `contextBridge` (never raw `ipcRenderer`); `renderer` is sandboxed React with no Node. Skip kakutey's spawned FastAPI+HTTP sidecar and Actual's child-process DB server — extra processes and ports to supervise, no MVP gain.

IPC: one `ipcMain.handle` channel per use case (`tx:list`, `tx:create`), args validated in main, **no SQL string ever crosses the bridge**. Renderers are sandboxed since Electron 20 and sandboxed preloads may only `require` electron/events/timers/url ([sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)) — keep DB code in main.

Migrations: run in main **before** creating the window, inside a transaction, after copying to `.bak`. Use a version table — Actual uses `__migrations__(id INT PK, name)` with files `packages/loot-core/migrations/<epoch_ms>_<name>.sql` and deliberately **removed** its old `db_version` (`1548957970627_remove-db-version.sql`); MMEX reads `PRAGMA user_version` with `dbLatestVersion = 21`. Name files `TIMESTAMP_description.sql` and **never drop columns** ([Actual's guide](https://raw.githubusercontent.com/actualbudget/actual/master/packages/docs/docs/contributing/project-details/migrations.md)).

## 5. Packaging (Windows, version-pinned)

- **electron-vite v5**: `dependencies` are externalised for main/preload automatically (`externalizeDepsPlugin` deprecated → `build.externalizeDeps`). Keep the driver in `dependencies`, **not** `devDependencies` ([docs](https://electron-vite.org/guide/dependency-handling)).
- **better-sqlite3 v13.0.x** moved to **N-API** (`NAPI_VERSION=10`) and ships prebuilds directly, so `NODE_MODULE_VERSION` mismatches are structurally gone. electron-builder's `npmRebuild` defaults to **true** — set it **false**, or `@electron/rebuild` rebuilds anything with a `binding.gyp`, skipping the prebuild ([v13 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0), [issue #1503](https://github.com/WiseLibs/better-sqlite3/issues/1503)). pnpm: `allowBuilds: { better-sqlite3: false }`; yarn: `dependenciesMeta`.
- **electron-builder**: `asar: true`, `asarUnpack: ["node_modules/better-sqlite3/**"]` (the docs' own fix for runtime native crashes), `npmRebuild: false`. `smartUnpack` defaults true — set it explicitly anyway. Adding any positive `files` pattern drops the implicit `**/*` ([contents](https://www.electron.build/v26/docs/contents/)).
- **DB path**: `path.join(app.getPath('userData'), 'finance.db')`. Inside the asar it is read-only → `SQLITE_CANTOPEN`.
- **node:sqlite** ships from Electron 35 (Node 22.14); `require('node:sqlite')` regressed in 37.2.0 ("No such binding: sqlite") and was fixed by [electron#47706](https://github.com/electron/electron/pull/47706). Use 37.2.1+/38+. Stability **1.2 Release candidate**, sync-only, main/utility process only.

## 6. Recommended stack for a solo MVP

**electron-vite + electron-builder + node:sqlite on Electron ≥38.**

electron-vite over plain Vite (it owns the main/preload/renderer convention and the externalisation rules) and over vite-plugin-electron (thinner, more DIY). `node:sqlite` is the lowest-risk route to a working `.exe`: nothing to compile, nothing to unpack, no ABI, no `npmRebuild` interaction, no MSVC toolchain on the build machine — the whole failure class in §5 disappears. Its costs (RC API, sync-only, no extensions) are acceptable for a single-user ledger. Wrap it behind a ~30-line `Db` facade (`prepare/run/all/exec/transaction`) so switching to better-sqlite3@13 later touches one file. If you already need better-sqlite3's API or perf, that is the equally safe fallback — just set `npmRebuild: false` and `asarUnpack`.

## 7. Top 10 pitfalls

1. **ABI mismatch** — `NODE_MODULE_VERSION`. Historically #1; gone for `node:sqlite`/better-sqlite3 v13, back the moment you add an older native dep.
2. **asar paths** — `.node` cannot be `dlopen`ed from inside `app.asar`; `__dirname` in a packaged main bundle points into the archive.
3. **userData path** — a DB beside the `.exe` fails under `Program Files` and dies on update.
4. **Migrations** — no version table, no pre-migration backup, running after the window opens, or `DROP COLUMN` (irreversible).
5. **Timezone/date grouping** — UTC timestamps make "spent on the 1st" wrong for half the world. Store a **local calendar date** (Actual stores `date` as an INTEGER, not a timestamp). Securo makes timezone an explicit per-workspace setting for exactly this.
6. **Floating point** — MMEX's NUMERIC/REAL, Firefly's `36.120000000000`. Sum integers.
7. **Transfer double-counting** — two legs both counted inflates income *and* expense. Filter on the link column; leave the category NULL.
8. **Deleted accounts with transactions** — hard delete orphans or cascade-deletes history. Use `closed` + `tombstone`.
9. **Category deletion** — history must survive. Copy Actual's **redirect tables**: `category_mapping(id, transferId)` and `payee_mapping(id, targetId)` repoint deleted ids at a survivor so old rows still resolve. MMEX uses `ACTIVE`, Actual `tombstone`+`hidden`.
10. **Import duplicates** — dedupe on the bank id (`imported_id`) *plus* a fallback hash. Actual's [bug #6678](https://github.com/actualbudget/actual/issues/6678): merging two transactions dropped the `imported_id`, so the next import recreated it. Wealthfolio uses `idempotency_key UNIQUE`; Firefly stores `import_hash_v2`.

**Bonus patterns worth stealing:** kakutey's append-only revisions (`revision` + `deleted_at`, never `UPDATE`/`DELETE`) for free undo and audit; securo's rule that a missing FX key yields a 1:1 fallback **with a visible warning** rather than silently wrong numbers; Wealthfolio's FX tolerance of `Decimal::new(1, 6)` when pairing transfer legs.
