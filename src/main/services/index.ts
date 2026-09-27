import type { Database as SqliteDatabase } from 'better-sqlite3'
import { AccountsService } from './accounts'
import { CategoriesService } from './categories'
import { TransactionsService } from './transactions'
import { StatisticsService } from './statistics'
import { KlineService } from './kline'
import { ImportService } from './import'
import { BudgetsService, RecurringService, SettingsService, SubscriptionsService } from './settings'
import { DemoDataService } from './demo'
import { ExchangeRateService } from './exchange'
import { AppError } from '@main/database/errors'
import { DEFAULT_CURRENCY } from '@shared/lib/money'
import { nowIso } from '@shared/lib/dates'

/**
 * Service container.
 *
 * One place that constructs every service and wires their dependencies, so the
 * IPC layer never has to know how they fit together and tests can build the same
 * graph over a temporary database.
 */
export class Services {
  readonly accounts: AccountsService
  readonly categories: CategoriesService
  readonly transactions: TransactionsService
  readonly statistics: StatisticsService
  readonly kline: KlineService
  readonly imports: ImportService
  readonly settings: SettingsService
  readonly budgets: BudgetsService
  readonly subscriptions: SubscriptionsService
  readonly recurring: RecurringService
  readonly demo: DemoDataService
  readonly exchange: ExchangeRateService

  /** Remembers the last rate-refresh failure so the UI can report it honestly. */
  lastRateError: string | null = null

  constructor(readonly db: SqliteDatabase) {
    this.accounts = new AccountsService(db)
    this.categories = new CategoriesService(db)
    this.transactions = new TransactionsService(db, this.accounts, this.categories)
    this.settings = new SettingsService(db)
    this.exchange = new ExchangeRateService(db)

    // Statistics needs the cached rate table, and the rate table lives in the
    // database. This is a lazy read rather than a construction-time value so a
    // later refresh is picked up without rebuilding the service graph.
    this.statistics = new StatisticsService(db, () => this.exchange.getTable())

    // The K-line chart reads the same cached table through the same lazy provider
    // as statistics, for the same reason: a rates refresh must be picked up
    // without rebuilding the service graph, and a rates failure must not take the
    // chart down.
    this.kline = new KlineService(db, () => this.exchange.getTable())

    this.budgets = new BudgetsService(db)
    this.subscriptions = new SubscriptionsService(db)
    this.recurring = new RecurringService(db)
    this.demo = new DemoDataService(db)

    this.imports = new ImportService({
      db,
      resolveAccount: (name, currency) => this.resolveAccountId(name, currency),
      resolveCategory: (name, type, create) => this.resolveCategoryId(name, type, create)
    })
  }

  /**
   * Fetch rates if the cache is missing or stale.
   *
   * Called on startup and by the refresh button. Never throws: an offline user
   * keeps working from the last known rates, and `lastRateError` lets the UI say
   * so rather than showing a silently ageing figure.
   */
  async ensureRates(options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.exchange.ensureRates(this.settings.get().displayCurrency, options)
      this.lastRateError = null
    } catch (error) {
      this.lastRateError = error instanceof Error ? error.message : String(error)
    }
  }

  /** The display currency, with a safe fallback if settings are unreadable. */
  displayCurrency(): string {
    try {
      return this.settings.get().displayCurrency
    } catch {
      return DEFAULT_CURRENCY
    }
  }

  /** The settlement cycle start day, with a safe fallback. */
  cycleStartDay(): number {
    try {
      return this.settings.get().cycleStartDay
    } catch {
      return 1
    }
  }

  /**
   * Find an account by name, falling back to the only account when the name is
   * unknown.
   *
   * Statements frequently name the account differently from the user's own
   * naming ("Maybank Islamic Visa" vs "Maybank"). Returning the sole account is
   * a reasonable convenience for a single-account user; with several accounts we
   * return null so the import preview asks rather than guessing wrong.
   */
  private resolveAccountId(name: string | null, _currency: string): number | null {
    if (name) {
      const exact = this.db
        .prepare('SELECT id FROM accounts WHERE LOWER(name) = LOWER(?)')
        .get(name.trim()) as { id: number } | undefined
      if (exact) return exact.id

      // Loose match: either name contains the other.
      const loose = this.db
        .prepare('SELECT id FROM accounts WHERE LOWER(?) LIKE "%" || LOWER(name) || "%" OR LOWER(name) LIKE "%" || LOWER(?) || "%" LIMIT 1')
        .get(name.trim(), name.trim()) as { id: number } | undefined
      if (loose) return loose.id
    }

    const all = this.db.prepare('SELECT id FROM accounts WHERE archived = 0').all() as Array<{ id: number }>
    if (all.length === 1) return all[0].id

    return null
  }

  /**
   * Find a category by name and type, optionally creating it.
   *
   * The type is part of the identity: "Other" exists as both an income and an
   * expense category, and picking the wrong one would move a transaction between
   * the two halves of every report.
   *
   * Returns whether the category was CREATED, because a caller cannot work that
   * out afterwards —by then the row it just inserted exists and looks
   * pre-existing.
   */
  private resolveCategoryId(
    name: string | null,
    type: 'income' | 'expense',
    create: boolean
  ): { id: number | null; created: boolean } {
    const fallback = (): { id: number | null; created: boolean } => {
      // No category in the file: fall back to "Other" of the right type so the
      // transaction still appears in the breakdown instead of landing in an
      // uncategorised bucket the UI would have to render as a blank.
      const row = this.db.prepare('SELECT id FROM categories WHERE name = ? AND type = ?').get('Other', type) as
        | { id: number }
        | undefined
      return { id: row?.id ?? null, created: false }
    }

    if (!name || !name.trim()) return fallback()

    const trimmed = name.trim()
    const exact = this.db
      .prepare('SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND type = ?')
      .get(trimmed, type) as { id: number } | undefined
    if (exact) return { id: exact.id, created: false }

    if (!create) return fallback()

    // Create it, inheriting a sensible colour so the chart palette stays varied.
    const palette = ['#E8833A', '#3B82F6', '#A855F7', '#0E7490', '#EC4899', '#6366F1', '#EF4444', '#14B8A6']
    const existingCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM categories WHERE type = ?').get(type) as { n: number }
    ).n

    const info = this.db
      .prepare(
        `INSERT INTO categories (name, type, icon, color, is_system, sort_order, created_at)
         VALUES (?, ?, 'tag', ?, 0, ?, ?)`
      )
      .run(trimmed, type, palette[existingCount % palette.length], existingCount, nowIso())

    return { id: Number(info.lastInsertRowid), created: true }
  }

  /** The configured base currency, with a safe fallback if settings are unreadable. */
  baseCurrency(): string {
    try {
      return this.settings.get().baseCurrency
    } catch {
      return DEFAULT_CURRENCY
    }
  }
}

/** Guard used by IPC handlers that require an argument to be a positive integer. */
export function assertId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AppError('VALIDATION', `${label} is invalid.`)
  }
  return value
}
