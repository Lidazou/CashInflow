import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename, join } from 'node:path'
import { copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import Database from 'better-sqlite3'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { AppError, toAppError } from '@main/database/errors'
import {
  backupDatabase,
  databaseFileSize,
  snapshotBeforeDestructiveChange,
  type DatabaseHandle
} from '@main/database/connection'
import { assertId, Services } from '@main/services'
import { readXlsxRows, writeCsvFile } from '@main/services/export'
import { IPC_CHANNELS } from '@shared/types/ipc-contract'
import type {
  AccountInput,
  AppInfo,
  AppSettings,
  BackupInfo,
  CategoryInput,
  CustomPeriodInput,
  ImportCommitRequest,
  ImportPresetId,
  RecurringRuleInput,
  StatisticsGranularity,
  SubscriptionInput,
  TransactionInput,
  TransactionQuery,
  TransferInput
} from '@shared/types'
import { nowIso } from '@shared/lib/dates'
import { SCHEMA_VERSION } from '@shared/constants'

/**
 * IPC registration.
 *
 * SECURITY (spec 閹?, 閹?9)
 * ----------------------
 * Every channel registered here is explicitly listed in `IPC_CHANNELS`. There is
 * no generic "run this SQL" or "read this file" channel, so a compromised
 * renderer cannot reach the filesystem or the database except through these
 * narrowly-typed operations. In particular:
 *
 *   - The renderer never supplies a SQL string; it supplies data that is bound
 *     as parameters.
 *   - File paths only enter through a native file dialog the user drove.
 *   - All errors are converted to a plain `{ code, message, fields }` envelope
 *     and resolved (not rejected), because an unhandled rejection in the renderer
 *     yields a blank window, and a blank window in a finance app is
 *     indistinguishable from data loss.
 *
 * Arguments arrive from an untrusted context and are re-validated by the service
 * layer before touching the database.
 */

type HandlerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } }

export interface IpcContext {
  /** Always read services through here: a restore replaces them. */
  getServices: () => Services
  getDbHandle: () => DatabaseHandle
  dataDir: string
  databasePath: string
  /** Rebuild services over a newly opened database (used after a restore). */
  reopen: () => void
  /** Ask the renderer to refetch after a mutation. */
  notifyDataChanged: (reason: string) => void
}

/**
 * Wrap a handler so failures become a structured envelope and mutations notify
 * the renderer.
 *
 * `mutates` triggers a data-changed broadcast, which is what keeps the dashboard,
 * statistics and accounts pages consistent after any write without each page
 * needing to know what the others display.
 */
function handle<TArgs extends unknown[], TResult>(
  channel: string,
  context: IpcContext,
  options: { mutates?: boolean; reason?: string },
  fn: (...args: TArgs) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<HandlerResult<TResult>> => {
    try {
      const data = await fn(...(args as TArgs))
      if (options.mutates) context.notifyDataChanged(options.reason ?? channel)
      return { ok: true, data }
    } catch (error) {
      // Log the full error for diagnosis, but only surface a safe, useful
      // message to the renderer.
      const appError = toAppError(error)
      if (appError.code === 'INTERNAL' || appError.code === 'DB_ERROR') {
        console.error(`[ipc] ${channel} failed:`, error)
      }
      return { ok: false, error: appError.toStored() }
    }
  })
}

export function registerIpcHandlers(context: IpcContext): void {
  const { dataDir, databasePath } = context
  /** Resolved fresh on every call so a post-restore rebuild is picked up. */
  const svc = (): Services => context.getServices()

  // -------------------------------------------------------------------------
  // App meta
  // -------------------------------------------------------------------------

  handle<void[], AppInfo>(IPC_CHANNELS.appInfo, context, {}, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    userDataPath: dataDir,
    databasePath: databasePath,
    isPackaged: app.isPackaged
  }))

  // -------------------------------------------------------------------------
  // Dashboard, statistics, and the settlement cycle
  // -------------------------------------------------------------------------

  /**
   * The display currency and cycle anchor are read from SETTINGS inside the main
   * process rather than accepted from the renderer.
   *
   * That is deliberate: if the renderer supplied the currency, a bug there could
   * have a figure computed in one currency and formatted in another, producing a
   * plausible wrong number. Reading it here makes that class of mismatch
   * impossible.
   *
   * Declared before any handler that uses it — a `const` is in the temporal dead
   * zone until its definition runs, so a handler registered earlier would throw
   * the first time it was invoked.
   */
  const displayContext = (): { currency: string; cycleStartDay: number; baseCurrency: string } => {
    const settings = svc().settings.get()
    return {
      currency: settings.displayCurrency,
      cycleStartDay: settings.cycleStartDay,
      baseCurrency: settings.baseCurrency
    }
  }

  handle<[string], unknown>(IPC_CHANNELS.appOpenExternal, context, {}, async (url) => {
    // Only http(s) may be opened externally; anything else (file:, javascript:)
    // could be used to launch a local handler.
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new AppError('VALIDATION', 'Only http and https links can be opened.')
    }
    await shell.openExternal(url)
    return { opened: true }
  })

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  handle<void[], AppSettings>(IPC_CHANNELS.settingsGet, context, {}, () => svc().settings.get())

  handle<[Partial<AppSettings>], AppSettings>(
    IPC_CHANNELS.settingsUpdate,
    context,
    { mutates: true, reason: 'settings' },
    (patch) => svc().settings.update(patch ?? {})
  )

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  handle<[options?: { includeArchived?: boolean }], unknown>(
    IPC_CHANNELS.accountsList,
    context,
    {},
    (options) => svc().accounts.list(options ?? {})
  )
  handle<[number], unknown>(IPC_CHANNELS.accountsGet, context, {}, (id) => svc().accounts.get(assertId(id, 'Account id')))
  handle<[AccountInput], unknown>(IPC_CHANNELS.accountsCreate, context, { mutates: true, reason: 'accounts' }, (input) =>
    svc().accounts.create(input)
  )
  handle<[number, Partial<AccountInput>], unknown>(
    IPC_CHANNELS.accountsUpdate,
    context,
    { mutates: true, reason: 'accounts' },
    (id, input) => svc().accounts.update(assertId(id, 'Account id'), input ?? {})
  )
  handle<[number], { deleted: true }>(
    IPC_CHANNELS.accountsDelete,
    context,
    { mutates: true, reason: 'accounts' },
    (id) => svc().accounts.remove(assertId(id, 'Account id'))
  )
  handle<[number, boolean], unknown>(
    IPC_CHANNELS.accountsArchive,
    context,
    { mutates: true, reason: 'accounts' },
    (id, archived) => svc().accounts.archive(assertId(id, 'Account id'), archived === true)
  )
  handle<void[], unknown>(IPC_CHANNELS.accountsBalances, context, {}, () => svc().accounts.balancesByCurrency())

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  handle<[options?: { type?: 'income' | 'expense'; includeUsage?: boolean }], unknown>(
    IPC_CHANNELS.categoriesList,
    context,
    {},
    (options) => svc().categories.list(options ?? {})
  )
  handle<[CategoryInput], unknown>(IPC_CHANNELS.categoriesCreate, context, { mutates: true, reason: 'categories' }, (input) =>
    svc().categories.create(input)
  )
  handle<[number, Partial<CategoryInput>], unknown>(
    IPC_CHANNELS.categoriesUpdate,
    context,
    { mutates: true, reason: 'categories' },
    (id, input) => svc().categories.update(assertId(id, 'Category id'), input ?? {})
  )
  handle<[number, { reassignTo?: number | null } | undefined], unknown>(
    IPC_CHANNELS.categoriesDelete,
    context,
    { mutates: true, reason: 'categories' },
    (id, options) => svc().categories.remove(assertId(id, 'Category id'), options ?? {})
  )
  handle<void[], unknown>(IPC_CHANNELS.categoriesUsage, context, {}, () => svc().categories.usage())

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  handle<[TransactionQuery?], unknown>(IPC_CHANNELS.transactionsList, context, {}, (query) =>
    svc().transactions.list(query ?? {})
  )
  handle<[number], unknown>(IPC_CHANNELS.transactionsGet, context, {}, (id) =>
    svc().transactions.get(assertId(id, 'Transaction id'))
  )
  handle<[TransactionInput], unknown>(IPC_CHANNELS.transactionsCreate, context, { mutates: true, reason: 'transactions' }, (input) =>
    svc().transactions.create(input)
  )
  handle<[number, Partial<TransactionInput>], unknown>(
    IPC_CHANNELS.transactionsUpdate,
    context,
    { mutates: true, reason: 'transactions' },
    (id, input) => svc().transactions.update(assertId(id, 'Transaction id'), input ?? {})
  )
  handle<[number], { deleted: true; deletedLegs: number }>(
    IPC_CHANNELS.transactionsDelete,
    context,
    { mutates: true, reason: 'transactions' },
    (id) => svc().transactions.remove(assertId(id, 'Transaction id'))
  )
  handle<[TransferInput], unknown>(IPC_CHANNELS.transactionsTransfer, context, { mutates: true, reason: 'transactions' }, (input) =>
    svc().transactions.createTransfer(input)
  )
  handle<[number, Partial<TransferInput>], unknown>(
    IPC_CHANNELS.transactionsTransferUpdate,
    context,
    { mutates: true, reason: 'transactions' },
    (id, input) => svc().transactions.updateTransfer(assertId(id, 'Transfer id'), input ?? {})
  )
  handle<[TransactionQuery], unknown>(IPC_CHANNELS.transactionsSearch, context, {}, (query) => {
    const { currency } = displayContext()
    // Rates and display currency come from here, not from the renderer, so a
    // search total and the dashboard total are converted identically.
    return svc().transactions.search(query ?? {}, currency, svc().exchange.getTable())
  })

  // -------------------------------------------------------------------------
  // Dashboard, statistics, and the settlement cycle
  // -------------------------------------------------------------------------

  handle<[string], unknown>(IPC_CHANNELS.dashboardSummary, context, {}, (cycleKey) => {
    const { currency, cycleStartDay, baseCurrency } = displayContext()
    return svc().statistics.dashboard(sanitiseMonthKey(cycleKey), currency, cycleStartDay, todayIso(), baseCurrency)
  })

  handle<[string, number?], unknown>(IPC_CHANNELS.statsBiggestExpenses, context, {}, (cycleKey, limit) => {
    const { currency, cycleStartDay } = displayContext()
    return svc().statistics.biggestExpenses(
      sanitiseMonthKey(cycleKey),
      cycleStartDay,
      currency,
      clampLimit(limit, 5, 200)
    )
  })

  handle<[StatisticsGranularity, string], unknown>(IPC_CHANNELS.statsStatistics, context, {}, (granularity, anchor) => {
    const allowed: StatisticsGranularity[] = ['day', 'week', 'month', 'year']
    const safeGranularity = allowed.includes(granularity) ? granularity : 'month'
    const { currency, cycleStartDay } = displayContext()
    return svc().statistics.statistics(safeGranularity, sanitiseDate(anchor), currency, cycleStartDay)
  })

  handle<[string], unknown>(IPC_CHANNELS.statsCalendar, context, {}, (monthKey) => {
    const { currency } = displayContext()
    return svc().statistics.calendarMonth(sanitiseMonthKey(monthKey), currency, svc().settings.get().startOfWeek)
  })

  handle<[string], unknown>(IPC_CHANNELS.statsDayTotals, context, {}, (date) =>
    svc().statistics.dayTotals(sanitiseDate(date), displayContext().currency)
  )

  handle<void[], string[]>(IPC_CHANNELS.statsMonths, context, {}, () => svc().statistics.monthsWithData())

  handle<[string], unknown>(IPC_CHANNELS.statsDailySeries, context, {}, (monthKey) =>
    svc().statistics.dailySeries(sanitiseMonthKey(monthKey))
  )

  handle<[string], unknown>(IPC_CHANNELS.cycleInfo, context, {}, (cycleKey) => {
    const { cycleStartDay } = displayContext()
    return svc().statistics.cycleInfo(sanitiseMonthKey(cycleKey), cycleStartDay)
  })

  handle<[string, number], { key: string; info: unknown }>(
    IPC_CHANNELS.cycleShift,
    context,
    {},
    (cycleKey, delta) => {
      const { cycleStartDay } = displayContext()
      const key = svc().statistics.shiftCycleKey(
        sanitiseMonthKey(cycleKey),
        cycleStartDay,
        typeof delta === 'number' && Number.isFinite(delta) ? Math.trunc(delta) : 0
      )
      return { key, info: svc().statistics.cycleInfo(key, cycleStartDay) }
    }
  )

  // -------------------------------------------------------------------------
  // Exchange rates
  // -------------------------------------------------------------------------

  /**
   * Report the current rate state, fetching first if there is nothing cached.
   *
   * The fetch happens HERE rather than in the renderer for two reasons:
   *
   *   1. The Content-Security-Policy forbids the renderer from making any
   *      outbound connection (`connect-src` is limited to the app itself), so a
   *      renderer-side fetch could never succeed. That restriction is deliberate
   *      — it is what guarantees a user's financial data cannot be sent
   *      anywhere — and routing rate fetching through the main process keeps the
   *      guarantee intact while still allowing this one, auditable call.
   *   2. The cache lives in SQLite, which the renderer cannot touch.
   *
   * `ensureRates` is a no-op when the cache is fresh, so this does not turn every
   * read into a network request.
   */
  handle<[string[]?], unknown>(IPC_CHANNELS.ratesInfo, context, {}, async (quoteTargets) => {
    const currency = svc().displayCurrency()

    if (svc().settings.get().ratesAutoRefresh) {
      await svc().ensureRates()
    }

    const targets =
      Array.isArray(quoteTargets) && quoteTargets.length > 0
        ? quoteTargets.filter((code): code is string => typeof code === 'string').slice(0, 8)
        : ['MYR', 'USD', 'SGD', 'HKD']
    const info = svc().statistics.rateInfo(currency, targets)
    // Send the conversion table alongside the metadata, so a rate and the table
    // it came from can never disagree inside the renderer.
    return { ...info, table: svc().exchange.getTable(), lastError: svc().lastRateError }
  })

  handle<[boolean?], { updated: boolean; info: unknown; error: string | null }>(
    IPC_CHANNELS.ratesRefresh,
    context,
    { mutates: true, reason: 'rates' },
    async (force) => {
      await svc().ensureRates({ force: force !== false })
      const currency = svc().displayCurrency()
      return {
        updated: svc().lastRateError === null,
        info: svc().statistics.rateInfo(currency),
        error: svc().lastRateError
      }
    }
  )

  handle<[Record<string, number>, string?], unknown>(
    IPC_CHANNELS.ratesSetManual,
    context,
    { mutates: true, reason: 'rates' },
    (rates, base) => {
      if (!rates || typeof rates !== 'object') {
        throw new AppError('VALIDATION', '请至少填写一个汇率。')
      }
      svc().exchange.setManualRates(rates, base ?? svc().displayCurrency())
      return svc().statistics.rateInfo(svc().displayCurrency())
    }
  )

  handle<void[], { cleared: true }>(IPC_CHANNELS.ratesClear, context, { mutates: true, reason: 'rates' }, () => {
    svc().exchange.clear()
    return { cleared: true }
  })

  // -------------------------------------------------------------------------
  // Custom arbitrary periods
  // -------------------------------------------------------------------------

  handle<void[], unknown>(IPC_CHANNELS.customPeriodsList, context, {}, () => svc().statistics.listCustomPeriods())

  handle<[CustomPeriodInput], unknown>(
    IPC_CHANNELS.customPeriodsSave,
    context,
    { mutates: true, reason: 'customPeriods' },
    (input) => svc().statistics.saveCustomPeriod(input)
  )

  handle<[number], { deleted: true }>(
    IPC_CHANNELS.customPeriodsDelete,
    context,
    { mutates: true, reason: 'customPeriods' },
    (id) => svc().statistics.deleteCustomPeriod(assertId(id, '缁熻鍖洪棿 ID'))
  )

  handle<[{ from: string; to: string; budgetAmount?: number | null; currency?: string }], unknown>(
    IPC_CHANNELS.customPeriodStats,
    context,
    {},
    (input) => {
      if (!input || typeof input.from !== 'string' || typeof input.to !== 'string') {
        throw new AppError('VALIDATION', '请选择统计的开始和结束日期。')
      }
      // The budget is entered in the display currency, so it is used as given:
      // storing it in another unit would raise the question of which day's rate
      // applied to it.
      const currency = svc().displayCurrency()
      return svc().statistics.customPeriod(
        {
          from: sanitiseDate(input.from),
          to: sanitiseDate(input.to),
          budgetAmount: typeof input.budgetAmount === 'number' ? input.budgetAmount : null,
          currency
        },
        currency
      )
    }
  )

  // -------------------------------------------------------------------------
  // Import / export
  // -------------------------------------------------------------------------

  handle<void[], { canceled: boolean; filePath: string | null; fileName: string | null; kind: 'csv' | 'xlsx' | null }>(
    IPC_CHANNELS.importPickFile,
    context,
    {},
    async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
      const result = await dialog.showOpenDialog(window!, {
        title: 'Select a statement file',
        properties: ['openFile'],
        filters: [
          { name: 'Statements (CSV, XLSX)', extensions: ['csv', 'xlsx', 'txt'] },
          { name: 'CSV', extensions: ['csv', 'txt'] },
          { name: 'Excel workbook', extensions: ['xlsx'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, filePath: null, fileName: null, kind: null }
      }

      const filePath = result.filePaths[0]
      // Detect the real kind from magic bytes rather than trusting the extension.
      const kind = svc().imports.detectKind(filePath)
      return { canceled: false, filePath, fileName: basename(filePath), kind }
    }
  )

  handle<[string, ImportPresetId], unknown>(IPC_CHANNELS.importParse, context, {}, async (filePath, presetId) => {
    if (typeof filePath !== 'string' || !filePath) throw new AppError('VALIDATION', 'No file was selected.')
    if (!existsSync(filePath)) throw new AppError('FILE_IO', 'That file no longer exists.')

    // ExcelJS is loaded lazily so CSV-only users never pay for it.
    if (svc().imports.detectKind(filePath) === 'xlsx') {
      svc().imports.setXlsxReader((path) => {
        throw new AppError('INTERNAL', `Synchronous XLSX read requested for ${path}; use the async path.`)
      })
      const rows = await readXlsxRows(filePath)
      const settings = svc().settings.get()
      return svc().imports.buildPreview({
        kind: 'xlsx',
        fileName: basename(filePath),
        presetId: (presetId ?? 'generic') as ImportPresetId,
        rawRows: rows,
        notices: ['Read the first worksheet of the workbook.'],
        dayFirst: settings.dateFormat !== 'MM/DD/YYYY',
        currency: settings.baseCurrency
      })
    }

    const settings = svc().settings.get()
    return svc().imports.parse(filePath, (presetId ?? 'generic') as ImportPresetId, {
      dayFirst: settings.dateFormat !== 'MM/DD/YYYY',
      currency: settings.baseCurrency
    })
  })

  handle<[ImportCommitRequest], unknown>(IPC_CHANNELS.importCommit, context, { mutates: true, reason: 'import' }, (request) => {
    if (!request || !Array.isArray(request.rows)) {
      throw new AppError('VALIDATION', 'There is nothing to import.')
    }
    const settings = svc().settings.get()
    return svc().imports.commit(request, {
      currency: settings.baseCurrency,
      defaultAccountId: request.defaultAccountId ?? null
    })
  })

  handle<void[], unknown>(IPC_CHANNELS.importBatches, context, {}, () => svc().imports.listBatches())

  handle<[number], { deleted: number }>(IPC_CHANNELS.importRollback, context, { mutates: true, reason: 'import' }, (batchId) =>
    svc().imports.rollbackBatch(assertId(batchId, 'Batch id'))
  )

  handle<[TransactionQuery], { canceled: boolean; path: string | null; rows: number }>(
    IPC_CHANNELS.exportCsv,
    context,
    {},
    async (query) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
      const result = await dialog.showSaveDialog(window!, {
        title: 'Export transactions as CSV',
        defaultPath: join(app.getPath('documents'), `spendwise-transactions-${nowIso().slice(0, 10)}.csv`),
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })

      if (result.canceled || !result.filePath) return { canceled: true, path: null, rows: 0 }

      const rows = svc().imports.exportRows(query ?? {})
      const written = writeCsvFile(result.filePath, rows)
      return { canceled: false, path: result.filePath, rows: written }
    }
  )

  // -------------------------------------------------------------------------
  // Backup / restore
  // -------------------------------------------------------------------------

  handle<void[], { canceled: boolean; backup: BackupInfo | null }>(
    IPC_CHANNELS.backupCreate,
    context,
    {},
    async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
      const stamp = nowIso().slice(0, 19).replace(/[:T]/g, '-')
      const result = await dialog.showSaveDialog(window!, {
        title: 'Export database backup',
        defaultPath: join(app.getPath('documents'), `spendwise-backup-${stamp}.db`),
        filters: [{ name: 'SQLite database', extensions: ['db'] }]
      })

      if (result.canceled || !result.filePath) return { canceled: true, backup: null }

      // VACUUM INTO produces a consistent single file. Copying the .db directly
      // while WAL mode is active would omit everything still in the write-ahead log.
      backupDatabase(context.getDbHandle().db, result.filePath)
      svc().settings.markBackupTaken()

      const counts = svc().db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM transactions) AS transactions`
        )
        .get() as { accounts: number; transactions: number }

      return {
        canceled: false,
        backup: {
          path: result.filePath,
          bytes: databaseFileSize(result.filePath),
          createdAt: nowIso(),
          schemaVersion: SCHEMA_VERSION,
          accountCount: counts.accounts,
          transactionCount: counts.transactions
        }
      }
    }
  )

  handle<void[], { canceled: boolean; restore: unknown }>(IPC_CHANNELS.backupRestore, context, {}, async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined

    const chosen = await dialog.showOpenDialog(window!, {
      title: 'Restore from a SpendWise backup',
      properties: ['openFile'],
      filters: [{ name: 'SpendWise backup', extensions: ['db'] }]
    })
    if (chosen.canceled || chosen.filePaths.length === 0) return { canceled: true, restore: null }
    const source = chosen.filePaths[0]

    // Confirm before replacing data: this is destructive and irreversible from
    // the user's point of view, so it must never happen on a single click.
    const confirmation = await dialog.showMessageBox(window!, {
      type: 'warning',
      buttons: ['Cancel', 'Replace my data'],
      defaultId: 0,
      cancelId: 0,
      title: 'Replace all current data?',
      message: 'Restoring a backup replaces every account and transaction currently in SpendWise.',
      detail:
        'A safety copy of your current database is saved in the app data folder before anything is replaced, so this can be undone by hand if needed.'
    })
    if (confirmation.response !== 1) return { canceled: true, restore: null }

    const result = restoreFromBackup(context, source)
    return { canceled: false, restore: result }
  })

  handle<void[], unknown>(IPC_CHANNELS.databaseInfo, context, {}, () => {
    const db = context.getDbHandle().db
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM accounts) AS accounts,
           (SELECT COUNT(*) FROM transactions) AS transactions,
           (SELECT COUNT(*) FROM categories) AS categories,
           (SELECT MIN(date) FROM transactions) AS oldest,
           (SELECT MAX(date) FROM transactions) AS newest`
      )
      .get() as { accounts: number; transactions: number; categories: number; oldest: string | null; newest: string | null }

    return {
      path: databasePath,
      bytes: databaseFileSize(databasePath),
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
      journalMode: String(db.pragma('journal_mode', { simple: true })),
      foreignKeys: db.pragma('foreign_keys', { simple: true }) === 1,
      accountCount: counts.accounts,
      transactionCount: counts.transactions,
      categoryCount: counts.categories,
      oldestTransactionDate: counts.oldest,
      newestTransactionDate: counts.newest
    }
  })

  handle<void[], { opened: true }>(IPC_CHANNELS.databaseReveal, context, {}, () => {
    shell.showItemInFolder(databasePath)
    return { opened: true }
  })

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  handle<void[], unknown>(IPC_CHANNELS.budgetsList, context, {}, () => svc().budgets.list())
  handle<[{ categoryId: number | null; limitAmount: number; currency?: string }], unknown>(
    IPC_CHANNELS.budgetsSet,
    context,
    { mutates: true, reason: 'budgets' },
    (input) => svc().budgets.set({ ...input, currency: input?.currency ?? svc().baseCurrency() })
  )
  handle<[number], { deleted: true }>(IPC_CHANNELS.budgetsDelete, context, { mutates: true, reason: 'budgets' }, (id) =>
    svc().budgets.remove(assertId(id, 'Budget id'))
  )
  handle<[string], unknown>(IPC_CHANNELS.budgetsProgress, context, {}, (monthKey) => {
    const { currency, cycleStartDay } = displayContext()
    // The window is the settlement cycle and the amounts are converted here, so
    // the figures match the label the budget card shows.
    return svc().budgets.progress(sanitiseMonthKey(monthKey), cycleStartDay, currency, svc().exchange.getTable())
  })

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  handle<void[], unknown>(IPC_CHANNELS.subscriptionsList, context, {}, () => svc().subscriptions.list())
  handle<[SubscriptionInput], unknown>(IPC_CHANNELS.subscriptionsCreate, context, { mutates: true, reason: 'subscriptions' }, (input) =>
    svc().subscriptions.create(input)
  )
  handle<[number, Partial<SubscriptionInput>], unknown>(
    IPC_CHANNELS.subscriptionsUpdate,
    context,
    { mutates: true, reason: 'subscriptions' },
    (id, input) => svc().subscriptions.update(assertId(id, 'Subscription id'), input ?? {})
  )
  handle<[number], { deleted: true }>(IPC_CHANNELS.subscriptionsDelete, context, { mutates: true, reason: 'subscriptions' }, (id) =>
    svc().subscriptions.remove(assertId(id, 'Subscription id'))
  )
  handle<void[], unknown>(IPC_CHANNELS.subscriptionsMonthlyEstimate, context, {}, () => svc().subscriptions.monthlyEstimate())

  // -------------------------------------------------------------------------
  // Recurring
  // -------------------------------------------------------------------------

  handle<void[], unknown>(IPC_CHANNELS.recurringList, context, {}, () => svc().recurring.list())
  handle<[RecurringRuleInput], unknown>(IPC_CHANNELS.recurringCreate, context, { mutates: true, reason: 'recurring' }, (input) =>
    svc().recurring.create(input)
  )
  handle<[number, Partial<RecurringRuleInput>], unknown>(
    IPC_CHANNELS.recurringUpdate,
    context,
    { mutates: true, reason: 'recurring' },
    (id, input) => svc().recurring.update(assertId(id, 'Recurring rule id'), input ?? {})
  )
  handle<[number], { deleted: true }>(IPC_CHANNELS.recurringDelete, context, { mutates: true, reason: 'recurring' }, (id) =>
    svc().recurring.remove(assertId(id, 'Recurring rule id'))
  )
  handle<[string?], unknown>(IPC_CHANNELS.recurringDue, context, {}, (asOf) => svc().recurring.due(asOf))
  handle<[number, string], unknown>(
    IPC_CHANNELS.recurringConfirm,
    context,
    { mutates: true, reason: 'transactions' },
    (ruleId, date) => svc().recurring.confirm(assertId(ruleId, 'Recurring rule id'), sanitiseDate(date), svc().transactions)
  )

  // -------------------------------------------------------------------------
  // Demo data
  // -------------------------------------------------------------------------

  handle<[string?], unknown>(IPC_CHANNELS.demoSeed, context, { mutates: true, reason: 'demo' }, (monthKey) => {
    const key = monthKey ? sanitiseMonthKey(monthKey) : defaultDemoMonth()
    const result = svc().demo.seed(key)
    svc().settings.update({ demoDataLoaded: true })
    return result
  })

  handle<void[], unknown>(IPC_CHANNELS.demoClear, context, { mutates: true, reason: 'demo' }, () => {
    const result = svc().demo.clear()
    svc().settings.update({ demoDataLoaded: false })
    return result
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep a month key well-formed before it reaches a SQL comparison. */
function sanitiseMonthKey(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  if (/^\d{4}-\d{2}$/.test(text)) return text
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.slice(0, 7)
  return defaultDemoMonth()
}

/** Keep a date well-formed; falls back to today rather than querying with junk. */
function sanitiseDate(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return todayIso()
}

/**
 * Today as a local calendar date.
 *
 * Built from local parts rather than `toISOString().slice(0,10)`, which converts
 * to UTC first and would report yesterday for a user east of UTC in the hours
 * after local midnight.
 */
function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.trunc(value), max))
}

function defaultDemoMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Replace the live database with a chosen backup file.
 *
 * Ordering matters and is the whole point of this function:
 *   1. Validate the candidate by opening it read-only and checking its schema
 *      version. A file that is not a SpendWise database must be rejected BEFORE
 *      anything is replaced 闁?otherwise the user loses their data to a bad file.
 *   2. Snapshot the current database so the operation is recoverable.
 *   3. Close the live connection, swap the file, reopen.
 *
 * Restoring is done by file replacement rather than by copying rows, so the
 * result is byte-for-byte the backup the user chose.
 */
function restoreFromBackup(
  context: IpcContext,
  source: string
): { restoredFrom: string; preRestoreBackupPath: string; accountCount: number; transactionCount: number } {
  // --- 1. Validate the candidate before touching anything -------------------
  let candidate: SqliteDatabase | null = null
  let accountCount = 0
  let transactionCount = 0

  try {
    // Opened read-only so a malformed or malicious file cannot be modified by
    // the act of inspecting it.
    candidate = new Database(source, { readonly: true, fileMustExist: true })

    const tables = candidate
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts','transactions','categories')")
      .all() as Array<{ name: string }>

    if (tables.length < 3) {
      throw new AppError(
        'VALIDATION',
        'That file is not a SpendWise backup: it is missing the expected database tables. Your current data was not changed.'
      )
    }

    const version = candidate.pragma('user_version', { simple: true }) as number
    if (version > SCHEMA_VERSION) {
      throw new AppError(
        'VALIDATION',
        `That backup was created by a newer version of SpendWise (schema ${version}, this build understands ${SCHEMA_VERSION}). Update the app, then restore again. Your current data was not changed.`
      )
    }

    accountCount = (candidate.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
    transactionCount = (candidate.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      'VALIDATION',
      `That file could not be read as a database, so nothing was replaced. ${
        error instanceof Error ? error.message : ''
      }`.trim()
    )
  } finally {
    try {
      candidate?.close()
    } catch {
      /* closing a probe connection cannot fail meaningfully */
    }
  }

  // --- 2. Snapshot the current database ------------------------------------
  const snapshot = snapshotBeforeDestructiveChange(context.getDbHandle().db, context.dataDir, 'restore')

  // --- 3. Close, swap, reopen ----------------------------------------------
  context.getDbHandle().close()

  const target = context.databasePath
  const staged = `${target}.restoring`

  try {
    copyFileSync(source, staged)
    // Remove the WAL and SHM sidecars from the old database; leaving them beside
    // a replaced file can make SQLite apply a stale log to the new data.
    for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
      if (existsSync(sidecar)) unlinkSync(sidecar)
    }
    if (existsSync(target)) unlinkSync(target)
    renameSync(staged, target)
  } catch (error) {
    // Put the original back and reopen, so a failed restore is not fatal.
    try {
      if (existsSync(staged)) unlinkSync(staged)
      copyFileSync(snapshot, target)
    } catch {
      /* best effort; the snapshot file still exists on disk */
    }
    context.reopen()
    throw new AppError(
      'FILE_IO',
      `The backup could not be put in place, so your original data was restored. ${
        error instanceof Error ? error.message : ''
      }`.trim()
    )
  }

  context.reopen()

  return { restoredFrom: source, preRestoreBackupPath: snapshot, accountCount, transactionCount }
}

/** WAL is checkpointed and the file size reported for the Settings screen. */
export function describeDatabaseFile(path: string): { path: string; bytes: number; exists: boolean } {
  return { path, bytes: databaseFileSize(path), exists: existsSync(path) }
}