# CashInflow

A local-first personal finance manager for Windows, built for **Chinese students
studying abroad**.

Records income and expenses across accounts in several currencies, shows what you
have right now, and reports spending over the period your money actually arrives
in. Everything is stored in a SQLite database on your own machine. There is no
account to create, no server, and no network access beyond a single exchange-rate
lookup — the app is fully usable offline.

> **The one-sentence goal:** open the app and immediately know how much money you
> have, what you earned this period, what you spent, what is left, what you spent
> today, and what your largest expense was — in whichever currency you are
> thinking in today.

---

## 功能一览 (What it does)

**总览 Dashboard** — a three-column home screen: a large 3D donut breaking down
the period's spending by category with the remaining figure in the centre,
today's transactions, and the five largest expenses with a link to the full
ranking. A currency switcher and a live exchange-rate ticker sit at the top.

**多币种 Multi-currency** — hold accounts in CNY, MYR, SGD, USD, HKD and more.
Switch the display currency at any time and every figure re-converts instantly.
Stored amounts are never modified by a currency switch; only the presentation
changes.

**结算周期 Settlement cycles** — if your allowance arrives on the 5th, set the
cycle to start on the 5th and "this period" means 5 Aug – 4 Sep instead of the
calendar month. Every figure — dashboard, statistics, budget — follows.

**自定义区间 Custom periods** — pick any two dates, optionally enter a total, and
see spend against it with a pace projection. Save a period (a semester, a trip)
to reuse it.

**账户 Accounts** — cash, bank, e-wallet, credit card and other accounts, each with
its own currency and opening balance. Balances are always derived from the ledger,
so they cannot drift out of sync.

**交易明细 Transactions** — income, expense and transfer, grouped by day with daily
subtotals. Every row can be viewed, edited and deleted, and transfers are always
kept consistent across both accounts.

**统计分析 Statistics** — day, week, month and year views with an expense trend, a
category breakdown, and a calendar view where any day can be opened.

**预算 Budget** — an overall period budget plus per-category limits, with restrained
over-budget warnings rather than alarm-red screens.

**订阅与周期 Subscriptions** — track recurring charges and see your true estimated
monthly cost. Recurring rules are reminders; nothing is written to the ledger
without your confirmation.

**导入账单 Import** — read a CSV or XLSX statement exported from your bank, WeChat
Pay, Alipay, Maybank or CIMB. Flow: *select file → parse → preview → detect
duplicates → confirm*. Nothing is written until you confirm.

**搜索 Search** — search every transaction by merchant, note, category or account,
with date, amount, type, account and category filters.

**设置 Settings** — currency, date format, start of week, settlement cycle,
exchange rates (including manual rates), light/dark/system theme, category
management, backup and restore, CSV export, and a security panel that tells you
exactly where your data is.

---

## 汇率 Live exchange rates

Rates come from free public providers and need **no API key**:

| Provider | Notes |
|---|---|
| `open.er-api.com` | 160+ currencies, updated daily |
| `api.exchangerate-api.com` | Same data, different host — used as a mirror when the first is unreachable |
| `api.frankfurter.app` | ECB reference rates, served from the EU |

They are tried in order, and the fallback chain is not decoration: a student in
mainland China, a student in Kuala Lumpur and a student on a campus VPN will not
all reach the same host.

**How it behaves**

- Rates are **cached in SQLite** with their fetch time and provider, so the app
  works completely offline using the last known rates.
- The UI reports the **age and freshness** of the rates. A finance app that shows
  a week-old rate without saying so is worse than one that shows nothing, because
  you will budget against a number that is quietly wrong.
- Fetches happen in the **main process**, not the renderer. The
  Content-Security-Policy forbids the renderer from making any outbound
  connection — that restriction is what guarantees your financial data cannot be
  sent anywhere — so the one permitted network call is made where it can be
  audited.
- **Manual rates** override the fetched table when you trust your bank's rate
  more than a public mid-market one, and are never silently overwritten.
- Rates are used **only to convert for display**. No converted figure is ever
  written back into the ledger, so the books always balance in the currency the
  money actually moved in.

**What the providers do not give you**

These are indicative mid-market rates, not the rate your bank will charge you.
Card and remittance rates include a spread, so a converted figure here is a
reference, not a quote.

---

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron 44 | Produces a real Windows `.exe` and installer |
| UI | React 19 + TypeScript | Fast to build, predictable to maintain |
| Build | electron-vite 5 + Vite 7 | Separate main/preload/renderer bundles from one config |
| Database | SQLite via better-sqlite3 13 | A real embedded relational database, synchronous, zero configuration |
| Charts | Hand-written SVG | No charting dependency; the app needs five chart shapes |
| State | Zustand | Small, and only genuinely global state lives in it |
| Spreadsheets | ExcelJS | MIT-licensed XLSX reading with real streaming |
| Tests | Vitest | Fast, and runs the real database rather than mocks |

There are exactly two runtime dependencies: `better-sqlite3` and `exceljs`.

---

## Architecture

The dependency direction is strictly one-way. The renderer has no Node access,
no filesystem access and no SQL.

```
┌──────────────────────────────────────────────┐
│  Renderer  (React, sandboxed, no Node)       │
│  pages / components / hooks                  │
└───────────────────┬──────────────────────────┘
                    │  window.api.<method>()
                    │  (contextBridge, allow-listed channels only)
┌───────────────────▼──────────────────────────┐
│  Preload  (the only bridge)                  │
│  one method per channel, no raw ipcRenderer  │
└───────────────────┬──────────────────────────┘
                    │  ipcRenderer.invoke(channel, data only)
┌───────────────────▼──────────────────────────┐
│  Main process                                │
│  ipc/       validation + error envelope      │
│  services/  all business rules               │
│  database/  connection, migrations, mappers  │
└───────────────────┬──────────────────────────┘
                    │  prepared statements, bound parameters
┌───────────────────▼──────────────────────────┐
│  SQLite  (%APPDATA%\CashInflow\spendwise.db)  │
└──────────────────────────────────────────────┘
```

Key properties of this design:

- **No SQL crosses the bridge.** The renderer sends data; the main process
  decides what query that data becomes. There is no channel that accepts a query
  string.
- **Filesystem paths only enter through a native file dialog** that the user
  drove.
- **Failures never reject across IPC.** Every handler resolves to an envelope
  (`{ ok: true, data }` or `{ ok: false, error }`). An unhandled rejection in the
  renderer blanks the window, and a blank window in a finance app is
  indistinguishable from data loss. The preload rethrows a real `Error` with the
  original `code` and per-field messages attached.
- **Validation happens twice** — in the form for immediate feedback, and again in
  the main process, which is the authority.

---

## Database structure

The database is created and migrated automatically on first launch. Schema
version is tracked with SQLite's `user_version` pragma, and every migration runs
in a transaction. Migrations are append-only: an applied migration is never
edited, because every existing database has already run the old version and has no
way to re-run it.

Schema version 2 added the exchange-rate cache and saved custom periods.

### `accounts`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT | Unique per currency |
| `type` | TEXT | `cash` · `bank` · `wallet` · `credit_card` · `other` |
| `currency` | TEXT | ISO code, default `MYR` |
| `opening_balance` | INTEGER | Minor units; may be negative for a credit card |
| `color`, `icon` | TEXT | Presentation only |
| `archived` | INTEGER | 0/1 — archived accounts keep their history |
| `note` | TEXT | |
| `sort_order` | INTEGER | |
| `created_at`, `updated_at` | TEXT | ISO-8601 UTC |

### `categories`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT | Unique per type |
| `type` | TEXT | `income` · `expense` |
| `icon`, `color` | TEXT | |
| `is_system` | INTEGER | 1 for the seeded presets |
| `sort_order`, `created_at` | | |

Seeded expense categories: Food, Transport, Shopping, Housing, Entertainment,
Education, Health, Travel, Bills, Subscription, Other.
Seeded income categories: Salary, Freelance, Investment, Gift, Refund, Other.

### `transactions`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `account_id` | INTEGER FK | `ON DELETE RESTRICT` |
| `type` | TEXT | `income` · `expense` · `transfer` |
| **`amount`** | **INTEGER** | **Signed minor units — the only money column** |
| `category_id` | INTEGER FK | `NULL` for transfers |
| `date` | TEXT | Local calendar date `YYYY-MM-DD` |
| `time` | TEXT | `HH:MM` or NULL |
| `merchant`, `note` | TEXT | |
| `transfer_id` | INTEGER FK | Links a transfer's two legs |
| `import_batch_id` | INTEGER FK | Which import created this row |
| `source_id`, `import_hash` | TEXT | Duplicate detection |
| `created_at`, `updated_at` | TEXT | |

### `transfers`

Holds the authoritative pairing of a transfer: `from_account_id`,
`to_account_id`, `amount` (positive), `date`, `time`, `note`. Deleting this row
cascades to both transaction legs.

### Other tables

- **`budgets`** — `category_id` (NULL = overall), `period`, `limit_amount`.
- **`subscriptions`** — `name`, `amount`, `cycle`, `next_charge_date`, `active`.
- **`recurring_rules`** — reminders only; never writes to the ledger by itself.
- **`import_batches`** — one row per confirmed import, so a batch can be rolled back.
- **`settings`** — key/value, so a backup carries your preferences too.
- **`schema_migrations`** — human-readable audit trail of applied migrations.

### How money is stored

Every amount is an **integer count of the currency's minor unit**:

```
¥28.00     ->  stored as  2800   (fen)
RM 18.50   ->  stored as  1850   (sen)
$1,234.56  ->  stored as  123456 (cents)
```

This is not a stylistic choice. In IEEE-754 binary floating point:

```js
0.1 + 0.2            // 0.30000000000000004
100.1 + 200.2        // 300.29999999999995
```

With integers, `10010 + 20020 === 30030` exactly, always. Formatting happens once,
at the edge, in the renderer.

### How conversion works

Conversion is the one place the integer rule has to admit a decimal step, so the
discipline changes rather than disappears:

1. **One multiplication, one rounding.** The rate keeps its full published
   precision, the amount is multiplied once, and the result is rounded
   half-away-from-zero to the target currency's minor unit. ¥100 at 0.606575 is
   exactly MYR 60.66 (60.6575 → 60.66), not 60.65.
2. **Never chain conversions.** CNY → USD → MYR accumulates two rounding errors
   and disagrees with the published CNY → MYR cross rate, which is computed as a
   single ratio of two published rates.
3. **Never sum across currencies.** The obvious `SELECT SUM(amount)` adds fen to
   sen the moment two currencies are held, and the result looks entirely
   plausible. Aggregates are grouped by currency first; each subtotal is exact,
   then converted, then combined — so there is exactly one rounding step per
   currency, at the end.
4. **An unavailable rate is never treated as 1:1.** The amount is shown in its own
   currency with a `*` marker, and the UI says rates are missing. A fabricated
   1:1 rate is the most dangerous possible failure here, because the number looks
   completely normal.

### How balances are computed

An account's balance is **always derived**, never stored:

```sql
opening_balance + (SELECT SUM(amount) FROM transactions WHERE account_id = a.id)
```

A stored running balance is a second copy of the truth that drifts the first time
a write path forgets to update it. At personal-ledger scale the `SUM` is
instant, so correctness wins.

### How transfers avoid being counted as spending

A transfer writes **two** rows with `type = 'transfer'`, one negative leg from the
source account and one positive leg into the destination, both linked to a row in
`transfers`. Because both legs carry their own type, every income/expense
aggregate filters on `type IN ('income','expense')` and a transfer is excluded
*by construction* — there is no report-time special case that someone can forget.

For Maybank → Cash RM 500:

```
Maybank   -500.00     transfer leg
Cash      +500.00     transfer leg
period expense        unchanged
total balance         unchanged
```

### How settlement cycles tile the calendar

A cycle anchored on day *N* runs from the *N*th to the day before the next *N*th,
so consecutive cycles tile the calendar with **no gap and no overlap**. That
property is what keeps every transaction in exactly one period; a gap would
silently drop rows from every report and an overlap would double-count them. It is
asserted directly in `tests/periods.test.ts`.

The anchor is capped at 28 because a cycle starting on the 31st has no 31st in
February, so its length would vary between 28 and 31 days and the same transaction
could fall into different cycles depending on the month.

---

## Where your data lives

```
C:\Users\<you>\AppData\Roaming\CashInflow\spendwise.db
```

The exact path is shown in **Settings → Security**, with a button to reveal the
file in Explorer.

It is deliberately **not** stored next to the executable or in the project
folder, because an installed application's directory may be read-only, a database
beside the `.exe` is trivially exposed to anyone browsing the install folder, and
uninstalling or updating should never destroy your financial history. The
uninstaller does not remove this folder either.

SQLite runs in WAL mode, so you will also see `spendwise.db-wal` and
`spendwise.db-shm` alongside it. Those are normal and are folded back into the
main file when the app closes cleanly.

---

## Getting started

**Requirements:** Windows 10 or 11. No Node.js, Python or other runtime is needed
to *use* the app — only to build it.

### Install from the installer

1. Run `CashInflow-1.0.0-x64-setup.exe`.
2. Choose an install location (or accept the default).
3. Launch CashInflow from the Start menu or desktop shortcut.

### Or run the portable build

`CashInflow-1.0.0-x64-portable.exe` is a single self-contained file. Run it with
no installation. It stores its data in the same AppData location.

### First run

```
Launch
  ↓
Welcome screen
  ↓
Create your first account  (name, type, currency, opening balance)
  ↓
Dashboard
```

If you would rather look around before entering real data, press **Explore with
sample data** on the welcome screen. Sample data can only be added to an empty
ledger and is removed again in one step, so it can never mix with your own
records.

---

## Development

**Requirements:** Node.js 22.12 or newer.

```bash
# Install dependencies
npm install

# Run the app with hot reload
npm run dev

# Type-check both the Node and the browser code
npm run typecheck

# Run the test suite
npm test

# Build without packaging
npm run build
```

> **Note on the npm cache.** The `.npmrc` in this project points the npm cache at
> a workspace-local directory. Some sandboxed environments export
> `npm_config_cache` as an environment variable, and npm gives environment
> variables higher precedence than project `.npmrc` files; if an install fails
> with `EPERM ... npm-cache`, pass the cache explicitly:
> `npm install --cache "C:\path\to\.npm-cache"`.

### Project layout

```
src/
├── main/                     Electron main process (Node)
│   ├── database/
│   │   ├── connection.ts     Open, configure (WAL, foreign keys), migrate, back up
│   │   ├── migrations/       Versioned schema, each in a transaction
│   │   ├── mappers.ts        SQLite rows -> domain objects
│   │   └── errors.ts         Typed errors with stable codes
│   ├── services/             All business rules
│   │   ├── accounts.ts       CRUD + derived balances
│   │   ├── transactions.ts   Ledger, transfers, aggregates
│   │   ├── statistics.ts     Dashboard, trends, calendar
│   │   ├── import.ts         Parse -> validate -> dedupe -> commit
│   │   ├── csv.ts            RFC 4180 parser, date/amount normalisation
│   │   ├── import-presets.ts Per-provider column mappings
│   │   ├── settings.ts       Settings, budgets, subscriptions, recurring
│   │   ├── demo.ts           Seeded sample data, isolated from real data
│   │   └── validation.ts     Input validation
│   ├── ipc/index.ts          Channel registration, error envelope
│   └── index.ts              Startup, window, security configuration
├── preload/index.ts          The contextBridge allow-list
├── renderer/
│   ├── index.html            Includes the Content-Security-Policy
│   └── src/
│       ├── components/       Shell, dialogs, icons, charts
│       ├── pages/            One file per route
│       ├── hooks/useData.ts  Query + mutation hooks
│       ├── store/            Zustand stores (app settings, UI)
│       └── styles/           Design tokens and global CSS
└── shared/                   Imported by BOTH processes
    ├── types/                Domain types + the IPC contract
    ├── lib/money.ts          Integer money arithmetic and formatting
    ├── lib/dates.ts          Local calendar date handling
    └── constants/            App constants and seeded categories

tests/                        Vitest suites, run against a real SQLite file
```

---

## Building

```bash
npm run build      # type-check, then bundle main + preload + renderer into out/
```

`out/` then contains `main/index.js`, `preload/index.js` and `renderer/`.

---

## Packaging a Windows installer

```bash
npm run dist
```

This runs the build and then electron-builder, producing in `release/`:

| Artifact | Description |
|---|---|
| `CashInflow-1.0.0-x64-setup.exe` | NSIS installer — choose the install directory, creates Start-menu and desktop shortcuts |
| `CashInflow-1.0.0-x64-portable.exe` | Single self-contained executable, no installation |

`npm run dist:dir` produces an unpacked `release/win-unpacked/` directory instead,
which is quicker when you only want to smoke-test the packaged app.

### The one packaging detail that matters

`electron-builder.yml` sets **`npmRebuild: false`** and unpacks the native module:

```yaml
npmRebuild: false
asar: true
asarUnpack:
  - node_modules/better-sqlite3/**
```

better-sqlite3 v13 is built on N-API and ships prebuilt binaries for win32-x64.
electron-builder's `npmRebuild` defaults to `true`, which makes `@electron/rebuild`
recompile anything with a `binding.gyp` — discarding the shipped prebuild in
favour of one built against a different ABI that then fails to load at runtime
with a module-version mismatch. Separately, a `.node` binary cannot be loaded
from inside an `app.asar` archive, which is why `asarUnpack` is required rather
than optional.

If you change the database driver, revisit those two lines first.

---

## Backing up and restoring

### Export Database (backup)

**Settings → Data → Export Database**. Choose where to save the `.db` file.

The backup is produced with SQLite's `VACUUM INTO`, not a file copy. While WAL
mode is active, copying `spendwise.db` directly would omit everything still in the
write-ahead log; `VACUUM INTO` asks SQLite for a complete, consistent,
defragmented snapshot. The resulting file is a fully working database on its own.

### Import Backup (restore)

**Settings → Data → Import Backup**. Pick a `.db` file.

Before anything is replaced, the app:

1. **Validates the candidate** — opens it read-only and checks that the expected
   tables exist and that its schema version is not newer than this build. A file
   that is not a CashInflow backup is rejected *before* your data is touched.
2. **Takes a safety snapshot** of your current database into the app data folder.
3. **Closes, swaps the file, and reopens.**

Restore is a file replacement rather than a row-by-row copy, so the result is
byte-for-byte the backup you chose. A restore always asks for confirmation first.

### Manual backup

You can also simply copy the whole `%APPDATA%\CashInflow` folder while the app is
closed. To restore, put it back.

### Export CSV

**Settings → Data → Export CSV** (or the Export button on the search and
biggest-expenses pages) writes transactions as CSV. The file starts with a UTF-8
BOM so Excel opens it correctly instead of misreading non-ASCII merchant names,
and fields containing commas, quotes or newlines are quoted per RFC 4180.

---

## Importing statements

CashInflow does **not** connect to bank, WeChat or Alipay APIs. Export a statement
from the provider's app or website, then import the file.

### Supported formats

| Preset | Notes |
|---|---|
| **Custom CSV** | Auto-detects columns, delimiter and header position |
| **WeChat Pay** | 微信支付账单明细 — the header is located automatically |
| **Alipay** | 支付宝电子客户回单 — GBK encoded with a long preamble |
| **Maybank** | Separate Debit and Credit columns |
| **CIMB** | Separate Debit and Credit columns |
| **Any XLSX** | Reads the first worksheet |

### How the parser copes with real files

- **Junk preambles.** WeChat and Alipay prepend many lines, and the count varies
  between exports. The parser scans for the row that actually looks like a header
  instead of trusting a fixed offset.
- **Footer summaries.** Rows like `共43笔记录` and `总计` are skipped, not imported
  as transactions.
- **Encoding.** Files are sniffed: valid UTF-8 is read as UTF-8, otherwise
  GB18030/GBK. A wrongly guessed encoding silently corrupts every merchant name,
  so a preset that declares GBK still reads a UTF-8 file correctly.
- **Amounts.** `¥28.16`, `￥50.0`, `RM1,234.56`, `(123.45)`, `123.45-` and the
  European `1.234,56` are all understood. A dash or an empty cell means "no
  amount", not zero.
- **Dates.** `2026-09-26 14:05:00`, `26/09/2026`, `09/26/2026`, `26 Sep 2026`,
  `19 Jul 2024` and `20260926` are all recognised. Ambiguous `03/04/2026` follows
  your date-format setting; when a component is greater than 12 the format is
  unambiguous and the setting is ignored.
- **Quoted fields.** A description containing a comma, a quote or a newline is
  handled per RFC 4180.

### Duplicate detection

Re-importing the same file must not double your spending, yet two genuine RM 4.50
coffees on the same day must both survive. Those requirements conflict for any
key built only from date, amount and payee, so CashInflow uses:

1. **The provider's own transaction id** when the file has one (WeChat 交易单号,
   Alipay 交易订单号).
2. **Otherwise a content hash** over the account, date, amount, normalised payee
   and description — plus an **occurrence counter** counting earlier rows in the
   same batch that share account, date, amount and payee.

The occurrence counter is what reconciles the two requirements: two identical
coffees become index 0 and index 1 and both import, while re-importing the same
file reproduces indices 0 and 1 exactly and collides with the stored hashes.

Rows flagged as duplicates are **unticked but not blocked** — you can still
include them, because a genuine second purchase is not an error. A partial
`UNIQUE` index on `transactions.import_hash` is the final guard, so a duplicate
cannot slip through even if the pre-check were bypassed.

The hash is computed once, at import, and never recomputed. That matters: if it
were recomputed after you renamed a merchant, the edited row would look brand new
and the next import would recreate it.

### Rolling back an import

Every confirmed import is recorded in **Settings → Import history**, where the
whole batch can be rolled back. Only rows from that batch are removed; anything
you added by hand is untouched.

---

## Design decisions that matter

**Data correctness beats everything.** Balances are derived, amounts are integers,
transfers are typed rather than special-cased, and the database is the single
source of truth. No figure on any screen is hardcoded — every number comes from a
query, which is why the dashboard after one transaction runs the same code as the
dashboard after a year.

**Nothing fails silently.** A failed load shows a message and a retry button. A
failed write toasts the real reason plus "No changes were made", because every
mutation is wrapped in a transaction. An empty list and a failed query look
identical to a user, and in a finance app the difference is everything.

**The app never rewrites your financial data on its own.** Recurring rules produce
*suggested* transactions that you confirm. Nothing is posted automatically.

**Categories cannot be deleted out from under history.** Deleting a category that
is in use is refused, and the app then offers to move its transactions somewhere
else — an explicit choice, never a silent reassignment to "Other".

**Accounts with history cannot be deleted.** The foreign key is `RESTRICT`, so
deleting an account with transactions is refused and archiving is offered instead.
Uncategorised tidying must never destroy records.

**Currencies are never summed together.** RM 5,000 and ¥5,000 are not the same
quantity. Balances are reported per currency, and a single total appears only when
one currency is in play. Transfers between different currencies are rejected
rather than approximated, because the app has no exchange rate.

**Dates are local calendar dates, not instants.** A purchase at 23:30 on the 26th
stays on the 26th regardless of the machine's timezone. Storing an instant would
move it a day for some users and make "today's transactions" disagree with the
bank statement.

---

## Testing

```bash
npm test
```

204 tests across ten suites. They run against a **real temporary SQLite file**,
not mocks — the failures that matter (a footer imported as a transaction, a
re-import doubling spending, a GBK file read as UTF-8) only appear when real bytes
meet a real database.

| Suite | Covers |
|---|---|
| `money.test.ts` | Integer arithmetic, parsing, formatting, and the float failure modes being avoided |
| `dates.test.ts` | Local date formatting, month/year boundaries, ISO weeks, leap years |
| `ledger.test.ts` | Schema and migrations, balances, transfers, validation, referential integrity, persistence |
| `import-parser.test.ts` | RFC 4180 parsing, delimiter sniffing, header detection, amount and date normalisation |
| `import-e2e.test.ts` | Full import pipeline against real files, duplicate detection, WeChat/Alipay presets, GBK |
| `acceptance.test.ts` | The numbered acceptance criteria from the specification, executed |
| `manual-seed.test.ts` | Skipped by default; seeds the live database for visual inspection |

Two tests are worth pointing at specifically:

```
RM 100.10 + RM 200.20  ->  30030 minor units, exact
                     versus  300.29999999999995 as floats
```

and the transfer invariant: after Maybank → Cash RM 500, the sum of both account
balances is unchanged and the month's expense total is untouched.

---

## Security

This is local personal-finance software, so the security posture is deliberately
narrow.

- **All data stays on this machine.** No remote database, no telemetry, no
  analytics, and no network calls of any kind. The Content-Security-Policy in
  `index.html` restricts the renderer to its own bundle; there is no code path
  that sends transaction data anywhere.
- **The renderer cannot reach SQLite or the filesystem.** `contextIsolation` is
  on, `nodeIntegration` is off, and the preload exposes a fixed list of named
  methods rather than `ipcRenderer` itself.
- **No SQL text crosses the IPC bridge** — only data, which the main process binds
  as query parameters. A merchant literally named `'; DROP TABLE transactions; --`
  is just an unusual merchant name.
- **File paths only arrive through a native file dialog** the user drove.
- **Navigation is locked down.** In-app navigation away from the bundled UI is
  blocked, new windows are denied, and permission requests (camera, geolocation,
  notifications) are refused outright.
- **The database is in the OS app-data directory**, not in the project folder or
  beside the executable.
- **No secrets in the source.** There are none to have — the app has no server,
  no API keys and no accounts.

Anyone with access to your Windows user account can read the database file, as
they could read any file in your profile. CashInflow does **not** encrypt it at
rest; whole-disk encryption such as BitLocker is the appropriate control for that
threat, and Settings → Security says so.

---

## Known limitations

These are honest gaps, not oversights.

**Not implemented**

- **No bank, WeChat or Alipay API integration.** Import is file-based only, by
  design for the MVP.
- **No encryption of the database file** at rest. Use BitLocker or similar.
- **No transaction splits** (one expense across several categories).
- **No attachments or receipt images.**
- **No cross-currency transfers.** Moving money between accounts in different
  currencies needs an exchange rate applied to the transfer itself, which would
  make the two legs unequal. Refused rather than approximated — record two
  separate transactions instead.
- **Exchange rates are indicative mid-market figures**, not the rate a bank or
  remittance service will give you. Card and transfer rates include a spread.
- **Rates are fetched at most once every six hours**, because all three providers
  publish daily. This is a daily reference rate, not a live trading quote.
- **A manual rate table replaces the fetched one entirely** and is not refreshed
  automatically until you ask, so a rate you trust is never silently overwritten.
- **No automatic categorisation** of imported rows; categories come from the file
  or from "其他".
- **No data sync between machines.** Copy a backup file instead.
- **No `.xls` (legacy Excel) or PDF import.** Re-save as `.xlsx` or CSV — the
  importer detects the old format and says so rather than producing garbage.
- **Recurring rules are reminders, not automation.** They never post to the ledger
  without confirmation.

**Worth knowing**

- **Single instance only.** Launching a second copy focuses the existing window
  rather than opening a second one, so two windows cannot show divergent data.
- **Demo data requires an empty ledger.** This is what guarantees sample rows can
  never be interleaved with your real records.
- **Renaming a category does not rewrite history** — it renames the category, and
  past transactions follow automatically because they reference its id.
- **A category's type cannot be changed** after it has been used, since that would
  reinterpret every past transaction as the opposite of what it was. Create a new
  category instead.
- **An account's currency cannot be changed** once it has transactions, for the
  same reason: the stored integers would be reinterpreted in a different unit.
- **Duplicate detection compares within one account.** Importing the same
  purchase into two different accounts will not be caught.
- **Alipay `不计收支` and WeChat neutral rows are skipped**, not converted into
  transfers, because the MVP imports income and expense only. They are listed in
  the preview with the reason so nothing disappears without explanation.

**Platform**

- Built and tested on Windows 10/11 x64. The architecture is cross-platform, but
  only Windows packaging is configured and verified.

---

## License

MIT.
