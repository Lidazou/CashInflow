/**
 * Shared domain types.
 *
 * These types are the contract between the SQLite data layer (main process),
 * the IPC bridge (preload) and the React UI (renderer). Both processes import
 * from this single file so a schema change cannot silently desynchronise the
 * two sides.
 *
 * MONEY: every `amount`, `balance`, `openingBalance` and `limitAmount` field is
 * an INTEGER in the currency's minor unit (sen/fen/cents). See shared/lib/money.ts.
 *
 * DATES: `date` fields are local calendar dates as 'YYYY-MM-DD' strings, not
 * epoch timestamps. A transaction made at 23:30 on the 26th must stay on the
 * 26th no matter what timezone the app is opened in later — storing an instant
 * would move it to the 27th for a user who travels. `createdAt`/`updatedAt` are
 * true instants and are stored as ISO-8601 UTC strings.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const ACCOUNT_TYPES = ['cash', 'bank', 'wallet', 'credit_card', 'other'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export interface Account {
  id: number
  name: string
  type: AccountType
  currency: string
  /** Balance before any recorded transaction, in minor units. May be negative for credit cards. */
  openingBalance: number
  /** Display-only hex colour used for the account dot. */
  color: string
  icon: string
  archived: boolean
  note: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/**
 * An account plus its computed balance.
 *
 * Balance is DERIVED on every read from openingBalance + signed transaction
 * sums. We deliberately do not persist a running `balance` column: a stored
 * balance is a second source of truth that drifts the moment a write path
 * forgets to update it, and a finance app that reports a wrong balance is worse
 * than one that is slightly slower. See spec §10.
 */
export interface AccountWithBalance extends Account {
  /** openingBalance + all transaction effects, in minor units. */
  balance: number
  /** Number of transactions affecting this account. */
  transactionCount: number
}

export interface AccountInput {
  name: string
  type: AccountType
  currency: string
  openingBalance: number
  color?: string
  icon?: string
  note?: string | null
  archived?: boolean
  sortOrder?: number
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const CATEGORY_TYPES = ['income', 'expense'] as const
export type CategoryType = (typeof CATEGORY_TYPES)[number]

export interface Category {
  id: number
  name: string
  type: CategoryType
  icon: string
  color: string
  isSystem: boolean
  sortOrder: number
  createdAt: string
}

export interface CategoryInput {
  name: string
  type: CategoryType
  icon?: string
  color?: string
  sortOrder?: number
}

export interface CategoryUsage {
  categoryId: number
  transactionCount: number
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const TRANSACTION_TYPES = ['income', 'expense', 'transfer'] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export interface Transaction {
  id: number
  accountId: number
  type: TransactionType
  /** Always a positive integer in minor units. Direction comes from `type`. */
  amount: number
  categoryId: number | null
  /** Local calendar date, 'YYYY-MM-DD'. */
  date: string
  /** Local wall-clock time, 'HH:MM' or null. */
  time: string | null
  merchant: string | null
  note: string | null
  /** Groups the two legs of a transfer. Null for income/expense. */
  transferId: number | null
  /** Groups rows created by one import batch. Null for manual entry. */
  importBatchId: number | null
  createdAt: string
  updatedAt: string
}

/** A transaction joined with the display fields the UI needs. */
export interface TransactionWithRefs extends Transaction {
  accountName: string
  accountCurrency: string
  accountColor: string
  categoryName: string | null
  categoryIcon: string | null
  categoryColor: string | null
  /** For transfer legs: the other account's id and name. */
  counterpartAccountId: number | null
  counterpartAccountName: string | null
}

export interface TransactionInput {
  accountId: number
  type: TransactionType
  amount: number
  categoryId?: number | null
  date: string
  time?: string | null
  merchant?: string | null
  note?: string | null
}

export interface TransferInput {
  fromAccountId: number
  toAccountId: number
  amount: number
  date: string
  time?: string | null
  note?: string | null
}

export interface TransactionQuery {
  /** Inclusive lower bound, 'YYYY-MM-DD'. */
  from?: string
  /** Inclusive upper bound, 'YYYY-MM-DD'. */
  to?: string
  types?: TransactionType[]
  accountIds?: number[]
  categoryIds?: number[]
  /** Free-text over merchant, note, category name and account name. */
  search?: string
  /** Inclusive amount bounds in minor units. */
  minAmount?: number
  maxAmount?: number
  limit?: number
  offset?: number
  orderBy?: 'date' | 'amount' | 'created'
  orderDir?: 'asc' | 'desc'
}

export interface TransactionPage {
  items: TransactionWithRefs[]
  total: number
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const BUDGET_PERIODS = ['monthly'] as const
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number]

export interface Budget {
  id: number
  /** Null means the overall monthly budget across all categories. */
  categoryId: number | null
  period: BudgetPeriod
  /** Limit in minor units. */
  limitAmount: number
  currency: string
  createdAt: string
  updatedAt: string
}

export interface BudgetProgress {
  budget: Budget
  categoryName: string | null
  categoryIcon: string | null
  categoryColor: string | null
  spent: number
  remaining: number
  /** spent / limit, clamped to [0, 1] for bar widths. */
  ratio: number
  overBudget: boolean
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export const BILLING_CYCLES = ['weekly', 'monthly', 'quarterly', 'semiannual', 'yearly'] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

/** How many times a cycle occurs per year — used to compute a monthly estimate. */
export const CYCLES_PER_YEAR: Record<BillingCycle, number> = {
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  yearly: 1
}

export interface Subscription {
  id: number
  name: string
  amount: number
  currency: string
  cycle: BillingCycle
  /** 'YYYY-MM-DD' of the next expected charge. */
  nextChargeDate: string | null
  accountId: number | null
  categoryId: number | null
  active: boolean
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface SubscriptionInput {
  name: string
  amount: number
  currency: string
  cycle: BillingCycle
  nextChargeDate?: string | null
  accountId?: number | null
  categoryId?: number | null
  active?: boolean
  note?: string | null
}

// ---------------------------------------------------------------------------
// Recurring rules (reminders only — never auto-writes to the ledger)
// ---------------------------------------------------------------------------

export const RECURRENCE_FREQUENCIES = ['weekly', 'monthly', 'yearly'] as const
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]

export interface RecurringRule {
  id: number
  label: string
  type: Exclude<TransactionType, 'transfer'>
  amount: number
  accountId: number
  categoryId: number | null
  merchant: string | null
  note: string | null
  frequency: RecurrenceFrequency
  /** 1-31 for monthly/yearly, 0-6 (weekday) for weekly. */
  dayOfPeriod: number
  /** Month 1-12, only used when frequency is 'yearly'. */
  monthOfYear: number | null
  lastRunDate: string | null
  nextDueDate: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface RecurringRuleInput {
  label: string
  type: Exclude<TransactionType, 'transfer'>
  amount: number
  accountId: number
  categoryId?: number | null
  merchant?: string | null
  note?: string | null
  frequency: RecurrenceFrequency
  dayOfPeriod: number
  monthOfYear?: number | null
  nextDueDate: string
  active?: boolean
}

// ---------------------------------------------------------------------------
// Statistics / dashboard aggregates
// ---------------------------------------------------------------------------

export interface PeriodTotals {
  income: number
  expense: number
  /** income - expense. Transfers never contribute. */
  net: number
  /** Number of income+expense transactions in the period. */
  transactionCount: number
  /**
   * The currency these figures are expressed in.
   *
   * Carried on the totals rather than inferred at the call site, so a consumer
   * can never format a figure in a currency it was not converted into. Optional
   * because a same-currency query may legitimately leave it unset.
   */
  currency?: string
}

export interface DashboardSummary {
  /** Balance per currency, each also converted into the display currency. */
  balances: CurrencyBalance[]
  /** Period totals converted into the display currency. */
  month: MultiCurrencyTotals
  /** Today's totals converted into the display currency. */
  today: MultiCurrencyTotals
  /** The cycle being reported, e.g. '2026-09'. */
  monthKey: string
  todayDate: string
  /** Currency that figures are converted into for display. */
  displayCurrency: string
  /**
   * The user's primary currency for new accounts.
   *
   * Distinct from `displayCurrency`: this is the unit the user thinks in and
   * records in, while `displayCurrency` is what they are currently viewing. They
   * are usually the same, and differ only while the user is comparing.
   */
  baseCurrency: string
  accountCount: number
  /**
   * Total across all accounts converted into the display currency.
   * Null when any account's currency has no available rate, because a partial
   * total presented as a total is worse than no total.
   */
  netWorthInBaseCurrency: number | null
  /** The active settlement cycle, so the UI can label the period precisely. */
  cycle: {
    start: string
    end: string
    key: string
    label: string
    startDay: number
    daysTotal: number
    daysRemaining: number
    /** Fraction of the cycle elapsed, 0-1. */
    progress: number
  }
  /** Rate tables and freshness, so every converted figure can be explained. */
  rates: ExchangeRateInfo
}

export interface CurrencyBalance {
  currency: string
  balance: number
  accountCount: number
  /**
   * The balance converted into the requested display currency, in that
   * currency's minor units. Null when no rate is available for this currency.
   */
  convertedBalance?: number | null
}

/**
 * A monetary figure shown in both its own currency and a converted one.
 *
 * `originalCurrency` is the unit the money actually moved in and is what the
 * ledger stores; `converted` is a display convenience. Keeping both means the UI
 * can always show the real figure, which matters when a user is checking a
 * figure against a bank statement.
 */
export interface MoneyValue {
  minor: number
  currency: string
  /** Same amount in the display currency, or null when no rate is available. */
  convertedMinor: number | null
  convertedCurrency: string
  /** Rate used, for a tooltip that explains the number. */
  rate: number | null
  /** True when no rate was available and the value could not be converted. */
  approximate: boolean
}

/** Totals for a period, in a specific currency, with the original breakdown. */
export interface MultiCurrencyTotals extends PeriodTotals {
  currency: string
  /**
   * Mixed-currency source amounts that were converted to produce these totals.
   * Empty when every transaction was already in `currency`.
   */
  sources: Array<{ currency: string; income: number; expense: number; converted: boolean }>
  /** True when at least one amount could not be converted. */
  hasUnconverted: boolean
}

/** Live rate information for the dashboard ticker. */
export interface RateQuote {
  from: string
  to: string
  rate: number
}

/**
 * The active settlement cycle, as reported to the renderer.
 *
 * Mirrors `SettlementCycle` in shared/lib/periods.ts but travels over IPC, so it
 * must stay a plain serialisable object.
 */
export interface CycleInfo {
  start: string
  end: string
  key: string
  label: string
  startDay: number
  daysTotal: number
  daysRemaining: number
  /** Fraction of the cycle already elapsed, 0-1. */
  progress: number
}

export interface ExchangeRateInfo {
  /** False when no rates have ever been fetched (first run, offline). */
  hasRates: boolean
  base: string | null
  fetchedAt: string | null
  provider: string | null
  isManual: boolean
  ageHours: number | null
  /** How much the data should be trusted, for the UI to label honestly. */
  freshness: 'fresh' | 'today' | 'recent' | 'stale' | 'manual' | 'missing'
  /** The pairs shown in the dashboard ticker. */
  quotes: Array<RateQuote | null>
  /** Message describing the last failure, when the most recent refresh failed. */
  lastError: string | null
  /**
   * The raw conversion table, so the renderer can convert any amount locally.
   *
   * Sent with the metadata rather than fetched separately so that a rate and the
   * table it came from can never disagree — a mismatch would produce two
   * different converted figures on the same screen.
   */
  table: {
    base: string
    rates: Record<string, number>
    fetchedAt: string
    provider: string
    isManual?: boolean
  } | null
}

/** A saved arbitrary statistics period ("随意设定任意时间段"). */
export interface CustomPeriod {
  id: number
  label: string
  from: string
  to: string
  /** Optional total for the period in minor units; null when not set. */
  budgetAmount: number | null
  currency: string
  createdAt: string
  updatedAt: string
}

export interface CustomPeriodInput {
  label: string
  from: string
  to: string
  budgetAmount?: number | null
  currency?: string
}

/**
 * Statistics for an arbitrary date range, optionally measured against a total.
 *
 * This is the "enter a total amount and a date range, then see how it is going"
 * view: a student who arrives with RM 2,000 for a semester picks the semester
 * dates, enters 2000, and sees the burn-down.
 */
export interface CustomPeriodStatistics extends StatisticsResult {
  /** Optional budget for this period. */
  budget: { amount: number; currency: string } | null
  spent: number
  remaining: number | null
  /** spent / budget, clamped to [0,1] for bar widths. */
  usedRatio: number
  overBudget: boolean
  /** Average spend per day across the range, in minor units. */
  dailyAverage: number
  /** Days elapsed so far within the range (clamped to the range). */
  daysElapsed: number
  /** Total days in the range. */
  daysTotal: number
  /**
   * Projected total at the end of the range at the current pace.
   * Null when the range has not started or has no elapsed days.
   */
  projectedTotal: number | null
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface CategoryBreakdownRow {
  categoryId: number | null
  categoryName: string
  categoryIcon: string | null
  categoryColor: string | null
  total: number
  transactionCount: number
  /** Fraction of the period's expense total, 0-1. */
  share: number
}

export interface TrendPoint {
  /** Bucket key: 'YYYY-MM-DD' | 'YYYY-Www' | 'YYYY-MM' | 'YYYY'. */
  key: string
  /** Human label for the axis. */
  label: string
  income: number
  expense: number
  net: number
}

export type StatisticsGranularity = 'day' | 'week' | 'month' | 'year'

export interface StatisticsResult {
  granularity: StatisticsGranularity
  from: string
  to: string
  /** Converted into `currency`, with the original per-currency breakdown. */
  totals: MultiCurrencyTotals
  trend: TrendPoint[]
  categories: CategoryBreakdownRow[]
  topExpenses: TransactionWithRefs[]
  currency: string
}

export interface CalendarDay {
  date: string
  income: number
  expense: number
  net: number
  transactionCount: number
}

export interface CalendarMonth {
  monthKey: string
  /** First day of the month grid (may belong to the previous month). */
  gridStart: string
  days: CalendarDay[]
  totals: MultiCurrencyTotals
  currency: string
}

export interface BiggestExpense extends TransactionWithRefs {
  /** 1-based rank within the month. */
  rank: number
  /** Value relative to the largest expense, 1 = largest. Used for bar widths. */
  ratio: number
  /**
   * The expense converted into the display currency, in minor units.
   * Ranking uses this so amounts in different currencies are comparable.
   */
  convertedAmount?: number
  displayCurrency?: string
  /** False when no rate was available, so the figure is unconverted. */
  conversionAvailable?: boolean
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  items: TransactionWithRefs[]
  total: number
  /** Sum of matches, split so transfers are never counted as income/expense. */
  totals: PeriodTotals
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD MMM YYYY'
export type ThemeMode = 'light' | 'dark' | 'system'

export interface AppSettings {
  baseCurrency: string
  startOfWeek: 0 | 1
  dateFormat: DateFormat
  theme: ThemeMode
  /** Decimal + grouping preferences for input fields. */
  locale: string
  /** Show the demo dataset banner. */
  hasCompletedOnboarding: boolean
  lastBackupAt: string | null
  /** true when the database currently holds seeded demo rows. */
  demoDataLoaded: boolean
  /**
   * Day of month a settlement cycle begins on, 1-28.
   *
   * 1 renders a plain calendar month, so this setting generalises the reporting
   * period rather than switching between two modes. A student paid on the 5th
   * sets 5 and every figure then describes 5 Aug – 4 Sep.
   */
  cycleStartDay: number
  /** Currency that amounts are converted into for display. */
  displayCurrency: string
  /** Show the account's own currency next to the converted figure. */
  showOriginalCurrency: boolean
  /** Whether to refresh rates automatically when they age out. */
  ratesAutoRefresh: boolean
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportFileKind = 'csv' | 'xlsx'

export type ImportPresetId = 'generic' | 'wechat' | 'alipay' | 'maybank' | 'cimb'

export interface ImportPreset {
  id: ImportPresetId
  label: string
  description: string
  /** Number of leading junk rows to drop before the real header row. */
  skipRows: number
  /** Text encoding hint for CSV files. */
  encoding: 'utf8' | 'utf8-bom' | 'gb18030' | 'auto'
  delimiter?: string
  /** Maps canonical fields onto the file's column headers. */
  columnMap: Record<CanonicalField, string[]>
}

export const CANONICAL_FIELDS = [
  'date',
  'time',
  'description',
  'amount',
  'debit',
  'credit',
  'type',
  'category',
  'account',
  'note',
  'status'
] as const

export type CanonicalField = (typeof CANONICAL_FIELDS)[number]

/** One parsed, validated row ready for review in the import preview table. */
export interface ImportRow {
  /** Stable index within the parsed file. */
  index: number
  date: string | null
  time: string | null
  description: string
  merchant: string | null
  /** Signed minor units: negative = expense, positive = income. */
  amount: number | null
  type: TransactionType | null
  categoryName: string | null
  accountName: string | null
  note: string | null
  /** Per-row problems that prevent import. */
  errors: string[]
  /** Non-fatal problems worth surfacing. */
  warnings: string[]
  /** Set when this row matches an existing transaction. */
  duplicateOf: DuplicateMatch | null
  /** User's decision for this row in the preview UI. */
  resolution: ImportResolution
  /**
   * Content hash used for duplicate detection, computed once during parsing.
   * Persisted on commit and never recomputed, so editing the merchant or
   * category later cannot make the row look new to a subsequent import.
   */
  importHash?: string
}

export type ImportResolution = 'import' | 'skip'

export interface DuplicateMatch {
  transactionId: number
  reason: string
  /** 0-1, 1 = exact match on every compared field. */
  confidence: number
}

export interface ImportPreview {
  kind: ImportFileKind
  fileName: string
  presetId: ImportPresetId
  /** Detected header names, for display and manual remapping. */
  headers: string[]
  rows: ImportRow[]
  /** Rows that passed validation and are not duplicates. */
  importableCount: number
  duplicateCount: number
  errorCount: number
  /** Fatal problems: file unreadable, no header found, no data rows. */
  fatalError: string | null
  /** Non-fatal notes about the file (encoding fallback, skipped footer, ...). */
  notices: string[]
}

export interface ImportCommitRequest {
  fileName: string
  presetId: ImportPresetId
  rows: ImportRow[]
  /** Account to use when a row has no account name. */
  defaultAccountId: number | null
  /** Create categories that do not exist yet. */
  createMissingCategories: boolean
}

export interface ImportCommitResult {
  batchId: number
  imported: number
  skipped: number
  createdCategories: string[]
  /** Duplicate keys skipped on a second pass by the UNIQUE index. */
  rejectedDuplicates: number
}

export interface ImportBatch {
  id: number
  fileName: string
  presetId: string
  rowCount: number
  importedCount: number
  skippedCount: number
  createdAt: string
}

// ---------------------------------------------------------------------------
// Backup / export
// ---------------------------------------------------------------------------

export interface BackupInfo {
  path: string
  bytes: number
  createdAt: string
  schemaVersion: number
  accountCount: number
  transactionCount: number
}

export interface RestoreResult {
  restoredFrom: string
  /** Safety copy of the database that was replaced. */
  preRestoreBackupPath: string
  accountCount: number
  transactionCount: number
}

export interface CsvExportOptions {
  filePath: string
  query: TransactionQuery
}

export interface DatabaseInfo {
  path: string
  bytes: number
  schemaVersion: number
  journalMode: string
  foreignKeys: boolean
  accountCount: number
  transactionCount: number
  categoryCount: number
  oldestTransactionDate: string | null
  newestTransactionDate: string | null
}

// ---------------------------------------------------------------------------
// IPC envelope
// ---------------------------------------------------------------------------

export interface StoredError {
  code: string
  message: string
  /** Field-level validation failures, keyed by field name. */
  fields?: Record<string, string>
}

/**
 * Every IPC call resolves to this envelope. Rejections never cross the bridge
 * as raw exceptions: an unhandled rejection inside the renderer produces a
 * blank screen, and a blank screen in a finance app looks like data loss.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: StoredError }

export interface AppInfo {
  name: string
  version: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  v8Version: string
  platform: string
  arch: string
  userDataPath: string
  databasePath: string
  isPackaged: boolean
}
