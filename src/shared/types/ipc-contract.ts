/**
 * The IPC contract.
 *
 * This file is the single source of truth for what the renderer may ask the main
 * process to do. It is imported by main (to register handlers), by preload (to
 * expose the bridge) and by the renderer (for types), so the three can never
 * drift apart.
 *
 * SECURITY MODEL (spec §5, §39)
 * ----------------------------
 * The renderer has no Node access, no filesystem access and no SQL. It can only
 * invoke a channel named in `IPC_CHANNELS`, and every argument crosses a
 * structured-clone boundary where it is validated again in the main process.
 * SQL text is never sent over the bridge —only data —so there is no path by
 * which renderer code can influence a query's shape.
 *
 * All handlers resolve to `IpcResult<T>` rather than rejecting, because an
 * unhandled rejection in the renderer blanks the screen, and a blank screen in a
 * finance app is indistinguishable from data loss.
 */

import type {
  AccountInput,
  AccountWithBalance,
  AppInfo,
  AppSettings,
  BackupInfo,
  BiggestExpense,
  Budget,
  BudgetProgress,
  CalendarMonth,
  Category,
  CategoryInput,
  CustomPeriod,
  CustomPeriodInput,
  CustomPeriodStatistics,
  CycleInfo,
  DashboardSummary,
  DatabaseInfo,
  ExchangeRateInfo,
  ImportBatch,
  ImportCommitRequest,
  ImportCommitResult,
  ImportPreview,
  ImportPresetId,
  IpcDateRange,
  KlineGranularity,
  KlineSeries,
  MultiCurrencyTotals,
  OcrResult,
  OcrStatus,
  RecurringRule,
  RecurringRuleInput,
  RestoreResult,
  SearchResult,
  StatisticsGranularity,
  StatisticsResult,
  Subscription,
  SubscriptionInput,
  Transaction,
  TransactionInput,
  TransactionPage,
  TransactionQuery,
  TransactionWithRefs,
  TransferInput
} from './index'

/** Every channel the renderer is permitted to call. Nothing else is registered. */
export const IPC_CHANNELS = {
  // --- app / meta --------------------------------------------------------
  appInfo: 'app:info',
  appOpenExternal: 'app:openExternal',

  // --- settings ----------------------------------------------------------
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // --- accounts ----------------------------------------------------------
  accountsList: 'accounts:list',
  accountsGet: 'accounts:get',
  accountsCreate: 'accounts:create',
  accountsUpdate: 'accounts:update',
  accountsDelete: 'accounts:delete',
  accountsArchive: 'accounts:archive',
  accountsBalances: 'accounts:balances',

  // --- categories --------------------------------------------------------
  categoriesList: 'categories:list',
  categoriesCreate: 'categories:create',
  categoriesUpdate: 'categories:update',
  categoriesDelete: 'categories:delete',
  categoriesUsage: 'categories:usage',

  // --- transactions ------------------------------------------------------
  transactionsList: 'transactions:list',
  transactionsGet: 'transactions:get',
  transactionsCreate: 'transactions:create',
  transactionsUpdate: 'transactions:update',
  transactionsDelete: 'transactions:delete',
  transactionsTransfer: 'transactions:transfer',
  transactionsTransferUpdate: 'transactions:transferUpdate',
  transactionsSearch: 'transactions:search',

  // --- dashboard / statistics ------------------------------------------
  /**
   * Named `dashboard:summary` rather than `stats:dashboard` so that the derived
   * bridge method name is `dashboardSummary`, matching the naming used
   * everywhere else. The completeness check below enforces this correspondence.
   */
  dashboardSummary: 'dashboard:summary',
  statsBiggestExpenses: 'stats:biggestExpenses',
  statsStatistics: 'stats:statistics',
  statsRange: 'stats:range',
  statsKline: 'stats:kline',
  statsCalendar: 'stats:calendar',
  statsDayTotals: 'stats:dayTotals',
  statsMonths: 'stats:months',
  statsDailySeries: 'stats:dailySeries',

  // --- exchange rates ----------------------------------------------------
  ratesInfo: 'rates:info',
  ratesRefresh: 'rates:refresh',
  ratesSetManual: 'rates:setManual',
  ratesClear: 'rates:clear',

  // --- settlement cycle & custom periods ---------------------------------
  cycleInfo: 'cycle:info',
  cycleShift: 'cycle:shift',
  customPeriodsList: 'customPeriods:list',
  customPeriodsSave: 'customPeriods:save',
  customPeriodsDelete: 'customPeriods:delete',
  customPeriodStats: 'customPeriod:stats',

  // --- import / export ---------------------------------------------------
  importPickFile: 'import:pickFile',
  importParse: 'import:parse',
  importCommit: 'import:commit',
  importBatches: 'import:batches',
  importRollback: 'import:rollback',
  exportCsv: 'export:csv',

  // --- backup ------------------------------------------------------------
  backupCreate: 'backup:create',
  backupRestore: 'backup:restore',
  databaseInfo: 'database:info',
  databaseReveal: 'database:reveal',

  // --- budget ------------------------------------------------------------
  budgetsList: 'budgets:list',
  budgetsSet: 'budgets:set',
  budgetsDelete: 'budgets:delete',
  budgetsProgress: 'budgets:progress',

  // --- subscriptions -----------------------------------------------------
  subscriptionsList: 'subscriptions:list',
  subscriptionsCreate: 'subscriptions:create',
  subscriptionsUpdate: 'subscriptions:update',
  subscriptionsDelete: 'subscriptions:delete',
  subscriptionsMonthlyEstimate: 'subscriptions:monthlyEstimate',

  // --- recurring ---------------------------------------------------------
  recurringList: 'recurring:list',
  recurringCreate: 'recurring:create',
  recurringUpdate: 'recurring:update',
  recurringDelete: 'recurring:delete',
  recurringDue: 'recurring:due',
  recurringConfirm: 'recurring:confirm',

  // --- demo data ---------------------------------------------------------
  demoSeed: 'demo:seed',
  demoClear: 'demo:clear',

  // --- receipt OCR (v1.5.2) ----------------------------------------------
  ocrStatus: 'ocr:status',
  ocrPickImage: 'ocr:pickImage',
  ocrRecognize: 'ocr:recognize',

  // --- events pushed from main to renderer ------------------------------
  eventDataChanged: 'event:dataChanged'
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/**
 * Maps each channel to its argument tuple and resolved data type.
 *
 * `args` is a tuple so a handler with two parameters cannot be called with one,
 * and `result` is the unwrapped payload —the `IpcResult` envelope is applied
 * uniformly by the bridge, so callers see either `data` or a thrown AppError
 * reconstructed on the renderer side.
 */
export interface IpcContract {
  [IPC_CHANNELS.appInfo]: { args: []; result: AppInfo }
  [IPC_CHANNELS.appOpenExternal]: { args: [url: string]; result: { opened: true } }

  [IPC_CHANNELS.settingsGet]: { args: []; result: AppSettings }
  [IPC_CHANNELS.settingsUpdate]: { args: [patch: Partial<AppSettings>]; result: AppSettings }

  [IPC_CHANNELS.accountsList]: { args: [options?: { includeArchived?: boolean }]; result: AccountWithBalance[] }
  [IPC_CHANNELS.accountsGet]: { args: [id: number]; result: AccountWithBalance }
  [IPC_CHANNELS.accountsCreate]: { args: [input: AccountInput]; result: AccountWithBalance }
  [IPC_CHANNELS.accountsUpdate]: { args: [id: number, input: Partial<AccountInput>]; result: AccountWithBalance }
  [IPC_CHANNELS.accountsDelete]: { args: [id: number]; result: { deleted: true } }
  [IPC_CHANNELS.accountsArchive]: { args: [id: number, archived: boolean]; result: AccountWithBalance }
  [IPC_CHANNELS.accountsBalances]: {
    args: []
    result: Array<{ currency: string; balance: number; accountCount: number }>
  }

  [IPC_CHANNELS.categoriesList]: {
    args: [options?: { type?: 'income' | 'expense'; includeUsage?: boolean }]
    result: Category[]
  }
  [IPC_CHANNELS.categoriesCreate]: { args: [input: CategoryInput]; result: Category }
  [IPC_CHANNELS.categoriesUpdate]: { args: [id: number, input: Partial<CategoryInput>]; result: Category }
  [IPC_CHANNELS.categoriesDelete]: {
    args: [id: number, options?: { reassignTo?: number | null }]
    result: { deleted: true; reassigned: number }
  }
  [IPC_CHANNELS.categoriesUsage]: { args: []; result: Array<{ categoryId: number; transactionCount: number }> }

  [IPC_CHANNELS.transactionsList]: { args: [query?: TransactionQuery]; result: TransactionPage }
  [IPC_CHANNELS.transactionsGet]: { args: [id: number]; result: TransactionWithRefs }
  [IPC_CHANNELS.transactionsCreate]: { args: [input: TransactionInput]; result: TransactionWithRefs }
  [IPC_CHANNELS.transactionsUpdate]: { args: [id: number, input: Partial<TransactionInput>]; result: TransactionWithRefs }
  [IPC_CHANNELS.transactionsDelete]: { args: [id: number]; result: { deleted: true; deletedLegs: number } }
  [IPC_CHANNELS.transactionsTransfer]: {
    args: [input: TransferInput]
    result: { transferId: number; from: Transaction; to: Transaction }
  }
  [IPC_CHANNELS.transactionsTransferUpdate]: {
    args: [id: number, input: Partial<TransferInput>]
    result: { transferId: number; from: Transaction; to: Transaction }
  }
  [IPC_CHANNELS.transactionsSearch]: { args: [query: TransactionQuery]; result: SearchResult }

  /**
   * The display currency is read from settings inside the main process rather
   * than passed from the renderer, so a figure can never be computed in one
   * currency and formatted in another.
   *
   * `cycleStartDay` IS passed, because the dashboard lets the user pick which
   * period they are looking at. It is a reporting choice, not a stored
   * preference: viewing a calendar month while the saved cycle anchor stays at 5
   * must not rewrite the user's setting.
   */
  [IPC_CHANNELS.dashboardSummary]: {
    args: [cycleKey: string, range?: IpcDateRange | null, cycleStartDay?: number]
    result: DashboardSummary
  }
  [IPC_CHANNELS.statsBiggestExpenses]: {
    args: [cycleKey: string, limit?: number, range?: IpcDateRange | null]
    result: BiggestExpense[]
  }
  [IPC_CHANNELS.statsStatistics]: {
    args: [granularity: StatisticsGranularity, anchor: string]
    result: StatisticsResult
  }
  /**
   * Statistics over explicit dates. Separate from `statsStatistics` rather than
   * an optional argument on it, because the granularity anchor and a concrete
   * range are alternatives, not layers.
   */
  [IPC_CHANNELS.statsRange]: {
    args: [from: string, to: string]
    result: StatisticsResult
  }
  /**
   * The balance/flow candle series behind the dashboard's K-line view.
   *
   * `granularity` defaults to 'auto' in the service, which picks a bucket size
   * from the span of the recorded history. The renderer can also pin one, but
   * normally lets the service decide and re-buckets locally when the user zooms —
   * see `KlineSeries.daily`.
   */
  [IPC_CHANNELS.statsKline]: {
    args: [granularity?: KlineGranularity | 'auto', maWindows?: number[]]
    result: KlineSeries
  }
  [IPC_CHANNELS.statsCalendar]: { args: [monthKey: string]; result: CalendarMonth }
  [IPC_CHANNELS.statsDayTotals]: { args: [date: string]; result: MultiCurrencyTotals }
  [IPC_CHANNELS.statsMonths]: { args: []; result: string[] }
  [IPC_CHANNELS.statsDailySeries]: { args: [monthKey: string]; result: Array<{ date: string; expense: number; income: number }> }

  [IPC_CHANNELS.ratesInfo]: { args: [quoteTargets?: string[]]; result: ExchangeRateInfo }
  [IPC_CHANNELS.ratesRefresh]: {
    args: [force?: boolean]
    result: { updated: boolean; info: ExchangeRateInfo; error: string | null }
  }
  [IPC_CHANNELS.ratesSetManual]: {
    args: [rates: Record<string, number>, base?: string]
    result: ExchangeRateInfo
  }
  [IPC_CHANNELS.ratesClear]: { args: []; result: { cleared: true } }

  [IPC_CHANNELS.cycleInfo]: { args: [cycleKey: string]; result: CycleInfo }
  [IPC_CHANNELS.cycleShift]: { args: [cycleKey: string, delta: number]; result: { key: string; info: CycleInfo } }
  [IPC_CHANNELS.customPeriodsList]: { args: []; result: CustomPeriod[] }
  [IPC_CHANNELS.customPeriodsSave]: { args: [input: CustomPeriodInput]; result: CustomPeriod }
  [IPC_CHANNELS.customPeriodsDelete]: { args: [id: number]; result: { deleted: true } }
  [IPC_CHANNELS.customPeriodStats]: {
    args: [input: { from: string; to: string; budgetAmount?: number | null; currency?: string }]
    result: CustomPeriodStatistics
  }

  [IPC_CHANNELS.importPickFile]: {
    args: []
    result: { canceled: boolean; filePath: string | null; fileName: string | null; kind: 'csv' | 'xlsx' | null }
  }
  [IPC_CHANNELS.importParse]: { args: [filePath: string, presetId: ImportPresetId]; result: ImportPreview }
  [IPC_CHANNELS.importCommit]: { args: [request: ImportCommitRequest]; result: ImportCommitResult }
  [IPC_CHANNELS.importBatches]: { args: []; result: ImportBatch[] }
  [IPC_CHANNELS.importRollback]: { args: [batchId: number]; result: { deleted: number } }

  [IPC_CHANNELS.exportCsv]: { args: [query: TransactionQuery]; result: { canceled: boolean; path: string | null; rows: number } }

  [IPC_CHANNELS.backupCreate]: { args: []; result: { canceled: boolean; backup: BackupInfo | null } }
  [IPC_CHANNELS.backupRestore]: { args: []; result: { canceled: boolean; restore: RestoreResult | null } }
  [IPC_CHANNELS.databaseInfo]: { args: []; result: DatabaseInfo }
  [IPC_CHANNELS.databaseReveal]: { args: []; result: { opened: true } }

  [IPC_CHANNELS.budgetsList]: { args: []; result: Budget[] }
  [IPC_CHANNELS.budgetsSet]: {
    args: [input: { categoryId: number | null; limitAmount: number; currency?: string }]
    result: Budget
  }
  [IPC_CHANNELS.budgetsDelete]: { args: [id: number]; result: { deleted: true } }
  [IPC_CHANNELS.budgetsProgress]: { args: [monthKey: string]; result: BudgetProgress[] }

  [IPC_CHANNELS.subscriptionsList]: { args: []; result: Subscription[] }
  [IPC_CHANNELS.subscriptionsCreate]: { args: [input: SubscriptionInput]; result: Subscription }
  [IPC_CHANNELS.subscriptionsUpdate]: { args: [id: number, input: Partial<SubscriptionInput>]; result: Subscription }
  [IPC_CHANNELS.subscriptionsDelete]: { args: [id: number]; result: { deleted: true } }
  [IPC_CHANNELS.subscriptionsMonthlyEstimate]: { args: []; result: { amount: number; currency: string } }

  [IPC_CHANNELS.recurringList]: { args: []; result: RecurringRule[] }
  [IPC_CHANNELS.recurringCreate]: { args: [input: RecurringRuleInput]; result: RecurringRule }
  [IPC_CHANNELS.recurringUpdate]: { args: [id: number, input: Partial<RecurringRuleInput>]; result: RecurringRule }
  [IPC_CHANNELS.recurringDelete]: { args: [id: number]; result: { deleted: true } }
  [IPC_CHANNELS.recurringDue]: { args: [asOf?: string]; result: Array<{ rule: RecurringRule; dueDate: string }> }
  [IPC_CHANNELS.recurringConfirm]: { args: [ruleId: number, date: string]; result: TransactionWithRefs }

  [IPC_CHANNELS.demoSeed]: { args: [monthKey?: string]; result: { accounts: number; transactions: number } }
  [IPC_CHANNELS.demoClear]: { args: []; result: { removedTransactions: number } }

  // --- receipt OCR -------------------------------------------------------
  [IPC_CHANNELS.ocrStatus]: { args: []; result: OcrStatus }
  [IPC_CHANNELS.ocrPickImage]: {
    args: []
    result: { canceled: boolean; filePath: string | null; fileName: string | null; sizeBytes: number | null }
  }
  [IPC_CHANNELS.ocrRecognize]: { args: [filePath: string]; result: OcrResult }
}

/**
 * The shape `window.api` takes inside the renderer.
 *
 * Written out with method names rather than derived from `IpcContract`, because
 * the contract is keyed by channel string ('accounts:list') while the bridge
 * exposes a method per channel ('accountsList'). Deriving the API from the
 * contract keys would produce `window.api['accounts:list']`, which is not what
 * the preload actually exposes.
 *
 * The `_AssertEveryChannelExposed` check at the bottom of this file makes the
 * explicit list safe: adding a channel to `IpcContract` without adding the
 * matching method here is a compile error, so the two cannot drift apart.
 */
export interface CashInflowApi {
  // --- app ---------------------------------------------------------------
  appInfo: () => Promise<AppInfo>
  appOpenExternal: (url: string) => Promise<{ opened: true }>

  // --- settings ----------------------------------------------------------
  settingsGet: () => Promise<AppSettings>
  settingsUpdate: (patch: Partial<AppSettings>) => Promise<AppSettings>

  // --- accounts ----------------------------------------------------------
  accountsList: (options?: { includeArchived?: boolean }) => Promise<AccountWithBalance[]>
  accountsGet: (id: number) => Promise<AccountWithBalance>
  accountsCreate: (input: AccountInput) => Promise<AccountWithBalance>
  accountsUpdate: (id: number, input: Partial<AccountInput>) => Promise<AccountWithBalance>
  accountsDelete: (id: number) => Promise<{ deleted: true }>
  accountsArchive: (id: number, archived: boolean) => Promise<AccountWithBalance>
  accountsBalances: () => Promise<Array<{ currency: string; balance: number; accountCount: number }>>

  // --- categories --------------------------------------------------------
  categoriesList: (options?: { type?: 'income' | 'expense'; includeUsage?: boolean }) => Promise<Category[]>
  categoriesCreate: (input: CategoryInput) => Promise<Category>
  categoriesUpdate: (id: number, input: Partial<CategoryInput>) => Promise<Category>
  categoriesDelete: (id: number, options?: { reassignTo?: number | null }) => Promise<{ deleted: true; reassigned: number }>
  categoriesUsage: () => Promise<Array<{ categoryId: number; transactionCount: number }>>

  // --- transactions ------------------------------------------------------
  transactionsList: (query?: TransactionQuery) => Promise<TransactionPage>
  transactionsGet: (id: number) => Promise<TransactionWithRefs>
  transactionsCreate: (input: TransactionInput) => Promise<TransactionWithRefs>
  transactionsUpdate: (id: number, input: Partial<TransactionInput>) => Promise<TransactionWithRefs>
  transactionsDelete: (id: number) => Promise<{ deleted: true; deletedLegs: number }>
  transactionsTransfer: (
    input: TransferInput
  ) => Promise<{ transferId: number; from: Transaction; to: Transaction }>
  transactionsTransferUpdate: (
    id: number,
    input: Partial<TransferInput>
  ) => Promise<{ transferId: number; from: Transaction; to: Transaction }>
  transactionsSearch: (query: TransactionQuery) => Promise<SearchResult>

  // --- dashboard & statistics -------------------------------------------
  dashboardSummary: (
    cycleKey: string,
    range?: IpcDateRange | null,
    cycleStartDay?: number
  ) => Promise<DashboardSummary>
  statsBiggestExpenses: (
    cycleKey: string,
    limit?: number,
    range?: IpcDateRange | null
  ) => Promise<BiggestExpense[]>
  statsStatistics: (granularity: StatisticsGranularity, anchor: string) => Promise<StatisticsResult>
  statsRange: (from: string, to: string) => Promise<StatisticsResult>
  statsKline: (
    granularity?: KlineGranularity | 'auto',
    maWindows?: number[]
  ) => Promise<KlineSeries>
  statsCalendar: (monthKey: string) => Promise<CalendarMonth>
  statsDayTotals: (date: string) => Promise<MultiCurrencyTotals>
  statsMonths: () => Promise<string[]>
  statsDailySeries: (monthKey: string) => Promise<Array<{ date: string; expense: number; income: number }>>

  // --- exchange rates ----------------------------------------------------
  ratesInfo: (quoteTargets?: string[]) => Promise<ExchangeRateInfo>
  ratesRefresh: (force?: boolean) => Promise<{ updated: boolean; info: ExchangeRateInfo; error: string | null }>
  ratesSetManual: (rates: Record<string, number>, base?: string) => Promise<ExchangeRateInfo>
  ratesClear: () => Promise<{ cleared: true }>

  // --- settlement cycle & custom periods ---------------------------------
  cycleInfo: (cycleKey: string) => Promise<CycleInfo>
  cycleShift: (cycleKey: string, delta: number) => Promise<{ key: string; info: CycleInfo }>
  customPeriodsList: () => Promise<CustomPeriod[]>
  customPeriodsSave: (input: CustomPeriodInput) => Promise<CustomPeriod>
  customPeriodsDelete: (id: number) => Promise<{ deleted: true }>
  customPeriodStats: (input: {
    from: string
    to: string
    budgetAmount?: number | null
    currency?: string
  }) => Promise<CustomPeriodStatistics>

  // --- import / export ---------------------------------------------------
  importPickFile: () => Promise<{
    canceled: boolean
    filePath: string | null
    fileName: string | null
    kind: 'csv' | 'xlsx' | null
  }>
  importParse: (filePath: string, presetId: ImportPresetId) => Promise<ImportPreview>
  importCommit: (request: ImportCommitRequest) => Promise<ImportCommitResult>
  importBatches: () => Promise<ImportBatch[]>
  importRollback: (batchId: number) => Promise<{ deleted: number }>
  exportCsv: (query: TransactionQuery) => Promise<{ canceled: boolean; path: string | null; rows: number }>

  // --- backup ------------------------------------------------------------
  backupCreate: () => Promise<{ canceled: boolean; backup: BackupInfo | null }>
  backupRestore: () => Promise<{ canceled: boolean; restore: RestoreResult | null }>
  databaseInfo: () => Promise<DatabaseInfo>
  databaseReveal: () => Promise<{ opened: true }>

  // --- budgets -----------------------------------------------------------
  budgetsList: () => Promise<Budget[]>
  budgetsSet: (input: { categoryId: number | null; limitAmount: number; currency?: string }) => Promise<Budget>
  budgetsDelete: (id: number) => Promise<{ deleted: true }>
  budgetsProgress: (monthKey: string) => Promise<BudgetProgress[]>

  // --- subscriptions -----------------------------------------------------
  subscriptionsList: () => Promise<Subscription[]>
  subscriptionsCreate: (input: SubscriptionInput) => Promise<Subscription>
  subscriptionsUpdate: (id: number, input: Partial<SubscriptionInput>) => Promise<Subscription>
  subscriptionsDelete: (id: number) => Promise<{ deleted: true }>
  subscriptionsMonthlyEstimate: () => Promise<{ amount: number; currency: string }>

  // --- recurring ---------------------------------------------------------
  recurringList: () => Promise<RecurringRule[]>
  recurringCreate: (input: RecurringRuleInput) => Promise<RecurringRule>
  recurringUpdate: (id: number, input: Partial<RecurringRuleInput>) => Promise<RecurringRule>
  recurringDelete: (id: number) => Promise<{ deleted: true }>
  recurringDue: (asOf?: string) => Promise<Array<{ rule: RecurringRule; dueDate: string }>>
  recurringConfirm: (ruleId: number, date: string) => Promise<TransactionWithRefs>

  // --- receipt OCR (v1.5.2) ----------------------------------------------
  ocrStatus: () => Promise<OcrStatus>
  /** Opens a native image picker. Returns the chosen path, or null when cancelled. */
  ocrPickImage: () => Promise<{ canceled: boolean; filePath: string | null; fileName: string | null; sizeBytes: number | null }>
  /**
   * Recognise text in an image on disk.
   *
   * The image NEVER crosses this boundary: the renderer sends a path it just received from the
   * picker and gets text back. A receipt is a photograph of somebody's bank statement, and the
   * cheapest way to be sure it is not copied anywhere is for it never to be in the other process.
   */
  ocrRecognize: (filePath: string) => Promise<OcrResult>

  // --- demo data ---------------------------------------------------------
  demoSeed: (monthKey?: string) => Promise<{ accounts: number; transactions: number }>
  demoClear: () => Promise<{ removedTransactions: number }>

  /** Subscribe to main-process data-change notifications. Returns an unsubscribe fn. */
  onDataChanged: (callback: (payload: { reason: string }) => void) => () => void
}

/**
 * Compile-time completeness check.
 *
 * `IpcContract` is keyed by channel string ('accounts:list') while `CashInflowApi`
 * is keyed by bridge method name ('accountsList'). Both are written by hand, so
 * this asserts that every channel declared in `IPC_CHANNELS` has a corresponding
 * bridge method. Forgetting to expose a newly declared channel becomes a compile
 * error instead of a runtime "No response from the application".
 *
 * The event channel is excluded: it is pushed from main to renderer and is
 * deliberately not an invocable request.
 */
type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S
type ColonToCamel<S extends string> = S extends `${infer Head}:${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : CamelCase<S>

type InvocableChannels = Exclude<(typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS], typeof IPC_CHANNELS.eventDataChanged>
type ExpectedApiMethods = ColonToCamel<InvocableChannels>

/**
 * Resolves to `true` only when every declared channel has a bridge method.
 * If one is missing, this type becomes the missing method name and the
 * annotated constant below fails to compile with that name in the error.
 */
type MissingBridgeMethods = Exclude<ExpectedApiMethods, keyof CashInflowApi>
type AllChannelsExposed = [MissingBridgeMethods] extends [never] ? true : MissingBridgeMethods

const _assertEveryChannelExposed: AllChannelsExposed = true
void _assertEveryChannelExposed

/** Channel names grouped for the main-process registrar. */
export const ALL_IPC_CHANNELS: readonly string[] = Object.values(IPC_CHANNELS)
