import type { Database as SqliteDatabase } from 'better-sqlite3'
import { NotFoundError } from '@main/database/errors'
import {
  mapBudget,
  mapCategory,
  mapRecurringRule,
  mapSubscription,
  type BudgetRow,
  type CategoryRow,
  type RecurringRuleRow,
  type SubscriptionRow
} from '@main/database/mappers'
import type {
  AppSettings,
  BillingCycle,
  Budget,
  BudgetProgress,
  DashboardPeriodMode,
  DashboardRange,
  DateFormat,
  RecurrenceFrequency,
  RecurringRule,
  RecurringRuleInput,
  Subscription,
  SubscriptionInput,
  ThemeMode,
  TransactionWithRefs
} from '@shared/types'
import { BILLING_CYCLES, CYCLES_PER_YEAR, RECURRENCE_FREQUENCIES } from '@shared/types'
import { DEFAULT_CURRENCY, isSupportedCurrency, minorUnitScale } from '@shared/lib/money'
import { addDays, addMonths, addYears, nowIso, today } from '@shared/lib/dates'
import { clampCycleStartDay, cycleFromKey, MAX_CYCLE_START_DAY, MIN_CYCLE_START_DAY } from '@shared/lib/periods'
import { lookupRate, type RateTable } from '@shared/lib/rates'
import { SETTINGS_KEYS } from '@shared/constants'
import {
  assertNoErrors,
  optionalDate,
  requireAmount,
  requireCurrency,
  requireEnum,
  requireId,
  type FieldErrors
} from './validation'

const DATE_FORMATS: readonly DateFormat[] = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY']
const THEMES: readonly ThemeMode[] = ['light', 'dark', 'system']
const PERIOD_MODES: readonly DashboardPeriodMode[] = ['natural', 'cycle', 'custom']

/**
 * Parse the stored custom dashboard window.
 *
 * Returns null for anything malformed rather than throwing or repairing: the
 * caller then falls back to a cycle, which is always computable. A range that
 * cannot be trusted must never reach a query, because a wrong FROM/TO pair still
 * returns plausible-looking numbers.
 */
function parseDashboardRange(value: string | undefined): DashboardRange | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Partial<DashboardRange>
  const from = typeof candidate.from === 'string' ? candidate.from : ''
  const to = typeof candidate.to === 'string' ? candidate.to : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return null
  return {
    from,
    to,
    label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label : null,
    budgetAmount:
      typeof candidate.budgetAmount === 'number' && Number.isFinite(candidate.budgetAmount)
        ? Math.trunc(candidate.budgetAmount)
        : null
  }
}

/** Empty string is how a cleared nullable setting is stored. */
function nullIfEmpty(value: string | undefined): string | null {
  return value ? value : null
}

// ---------------------------------------------------------------------------
// Settings (spec §29)
// ---------------------------------------------------------------------------

/**
 * Application settings, persisted in the `settings` key/value table.
 *
 * Settings live in SQLite rather than a config file so that a database backup
 * carries the user's preferences with it — restoring a backup should restore the
 * whole app state, not just the ledger.
 *
 * Every value is read through an explicit coercion with a fallback, so a
 * corrupted or hand-edited row degrades to a default instead of throwing during
 * render. A settings read must never be able to blank the window.
 */
export class SettingsService {
  constructor(private readonly db: SqliteDatabase) {}

  private readRaw(): Map<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    return new Map(rows.map((row) => [row.key, row.value]))
  }

  get(): AppSettings {
    const raw = this.readRaw()

    const baseCurrency = raw.get(SETTINGS_KEYS.baseCurrency) ?? DEFAULT_CURRENCY
    const displayCurrency = raw.get(SETTINGS_KEYS.displayCurrency) ?? baseCurrency
    const dateFormat = raw.get(SETTINGS_KEYS.dateFormat) as DateFormat | undefined
    const theme = raw.get(SETTINGS_KEYS.theme) as ThemeMode | undefined
    const startOfWeek = raw.get(SETTINGS_KEYS.startOfWeek)
    const lastBackupAt = nullIfEmpty(raw.get(SETTINGS_KEYS.lastBackupAt))
    const cycleStartDay = raw.get(SETTINGS_KEYS.cycleStartDay)

    return {
      // A currency that is no longer supported would otherwise break every
      // formatting call that consults this setting.
      baseCurrency: isSupportedCurrency(baseCurrency) ? baseCurrency : DEFAULT_CURRENCY,
      displayCurrency: isSupportedCurrency(displayCurrency) ? displayCurrency : DEFAULT_CURRENCY,
      startOfWeek: startOfWeek === '0' ? 0 : 1,
      dateFormat: dateFormat && DATE_FORMATS.includes(dateFormat) ? dateFormat : 'DD MMM YYYY',
      theme: theme && THEMES.includes(theme) ? theme : 'light',
      locale: raw.get(SETTINGS_KEYS.locale) ?? 'zh-CN',
      hasCompletedOnboarding: raw.get(SETTINGS_KEYS.hasCompletedOnboarding) === 'true',
      lastBackupAt,
      demoDataLoaded: raw.get(SETTINGS_KEYS.demoDataLoaded) === 'true',
      // Clamped on read as well as on write, so a hand-edited database row
      // cannot produce a 31-day cycle that changes length between months.
      cycleStartDay: clampCycleStartDay(cycleStartDay ? Number(cycleStartDay) : 1),
      showOriginalCurrency: raw.get(SETTINGS_KEYS.showOriginalCurrency) !== 'false',
      ratesAutoRefresh: raw.get(SETTINGS_KEYS.ratesAutoRefresh) !== 'false',
      // 'cycle' is the default because it is a strict generalisation of a
      // calendar month: with an anchor of 1 the two are identical, so a user who
      // never opens the toggle still sees exactly what they expect.
      dashboardPeriodMode: PERIOD_MODES.includes(raw.get(SETTINGS_KEYS.dashboardPeriodMode) as DashboardPeriodMode)
        ? (raw.get(SETTINGS_KEYS.dashboardPeriodMode) as DashboardPeriodMode)
        : 'cycle',
      dashboardRange: parseDashboardRange(raw.get(SETTINGS_KEYS.dashboardRange))
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const errors: FieldErrors = {}

    if (patch.baseCurrency !== undefined && !isSupportedCurrency(patch.baseCurrency)) {
      errors.baseCurrency = `不支持的货币「${patch.baseCurrency}」。`
    }
    if (patch.displayCurrency !== undefined && !isSupportedCurrency(patch.displayCurrency)) {
      errors.displayCurrency = `不支持的货币「${patch.displayCurrency}」。`
    }
    if (patch.startOfWeek !== undefined && patch.startOfWeek !== 0 && patch.startOfWeek !== 1) {
      errors.startOfWeek = '每周起始日必须是周日或周一。'
    }
    if (patch.dateFormat !== undefined && !DATE_FORMATS.includes(patch.dateFormat)) {
      errors.dateFormat = '不支持的日期格式。'
    }
    if (patch.theme !== undefined && !THEMES.includes(patch.theme)) {
      errors.theme = '主题必须是浅色、深色或跟随系统。'
    }
    if (patch.dashboardPeriodMode !== undefined && !PERIOD_MODES.includes(patch.dashboardPeriodMode)) {
      errors.dashboardPeriodMode = '统计周期只能是自然月、结算周期或自定义区间。'
    }
    if (patch.dashboardRange !== undefined && patch.dashboardRange !== null) {
      const range = patch.dashboardRange
      const malformed =
        typeof range.from !== 'string' ||
        typeof range.to !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(range.from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(range.to)
      if (malformed) {
        errors.dashboardRange = '自定义区间的开始和结束日期格式不正确。'
      } else if (range.from > range.to) {
        errors.dashboardRange = '自定义区间的开始日期不能晚于结束日期。'
      }
    }
    // Switching to custom WITHOUT supplying a window would leave the dashboard
    // with nothing to report on, so it is refused here rather than silently
    // falling back to a cycle and looking like the toggle did nothing.
    if (patch.dashboardPeriodMode === 'custom' && patch.dashboardRange === undefined) {
      const existing = parseDashboardRange(this.readRaw().get(SETTINGS_KEYS.dashboardRange))
      if (!existing) errors.dashboardRange = '请先选择自定义区间的开始和结束日期。'
    }
    if (patch.cycleStartDay !== undefined) {
      if (!Number.isFinite(patch.cycleStartDay)) {
        errors.cycleStartDay = '结算起始日必须是数字。'
      } else if (patch.cycleStartDay < MIN_CYCLE_START_DAY || patch.cycleStartDay > MAX_CYCLE_START_DAY) {
        // 29-31 are refused rather than silently clamped, so the user learns why
        // instead of wondering why their 31st became a 28th.
        errors.cycleStartDay = `结算起始日必须在 ${MIN_CYCLE_START_DAY} 到 ${MAX_CYCLE_START_DAY} 之间。选择 29-31 会让周期在不同月份长度不一，导致同一笔交易落入不同周期。`
      }
    }

    assertNoErrors(errors, '设置无法保存。')

    const write = this.db.transaction(() => {
      const set = (key: string, value: string): void => {
        this.db
          .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          )
          .run(key, value, nowIso())
      }

      if (patch.baseCurrency !== undefined) set(SETTINGS_KEYS.baseCurrency, patch.baseCurrency)
      if (patch.displayCurrency !== undefined) set(SETTINGS_KEYS.displayCurrency, patch.displayCurrency)
      if (patch.startOfWeek !== undefined) set(SETTINGS_KEYS.startOfWeek, String(patch.startOfWeek))
      if (patch.dateFormat !== undefined) set(SETTINGS_KEYS.dateFormat, patch.dateFormat)
      if (patch.theme !== undefined) set(SETTINGS_KEYS.theme, patch.theme)
      if (patch.locale !== undefined) set(SETTINGS_KEYS.locale, patch.locale)
      if (patch.cycleStartDay !== undefined) {
        set(SETTINGS_KEYS.cycleStartDay, String(clampCycleStartDay(patch.cycleStartDay)))
      }
      if (patch.showOriginalCurrency !== undefined) {
        set(SETTINGS_KEYS.showOriginalCurrency, String(patch.showOriginalCurrency))
      }
      if (patch.ratesAutoRefresh !== undefined) {
        set(SETTINGS_KEYS.ratesAutoRefresh, String(patch.ratesAutoRefresh))
      }
      if (patch.dashboardPeriodMode !== undefined) {
        set(SETTINGS_KEYS.dashboardPeriodMode, patch.dashboardPeriodMode)
      }
      if (patch.dashboardRange !== undefined) {
        // Empty string is how a cleared range is stored, matching `nullIfEmpty`
        // above: the column is NOT NULL, and a sentinel keeps the read path simple.
        set(
          SETTINGS_KEYS.dashboardRange,
          patch.dashboardRange === null ? '' : JSON.stringify(patch.dashboardRange)
        )
      }
      if (patch.hasCompletedOnboarding !== undefined) {
        set(SETTINGS_KEYS.hasCompletedOnboarding, String(patch.hasCompletedOnboarding))
      }
      if (patch.lastBackupAt !== undefined) set(SETTINGS_KEYS.lastBackupAt, patch.lastBackupAt ?? '')
      if (patch.demoDataLoaded !== undefined) set(SETTINGS_KEYS.demoDataLoaded, String(patch.demoDataLoaded))
    })

    write()
    return this.get()
  }

  /** Record that a backup was taken, surfaced as "Last backup" in Settings. */
  markBackupTaken(): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(SETTINGS_KEYS.lastBackupAt, nowIso(), nowIso())
  }
}

// ---------------------------------------------------------------------------
// Budgets (spec §22)
// ---------------------------------------------------------------------------

/**
 * Monthly budgets: one optional overall budget plus per-category budgets.
 *
 * Spending is always recomputed from the ledger for the requested month, so a
 * budget cannot report progress that disagrees with the transactions list. A
 * stored "spent" figure would be a second source of truth and would drift.
 */
export class BudgetsService {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Budget[] {
    const rows = this.db
      .prepare('SELECT * FROM budgets ORDER BY category_id IS NULL DESC, category_id ASC')
      .all() as BudgetRow[]
    return rows.map(mapBudget)
  }

  /**
   * Create or replace a budget.
   *
   * `categoryId: null` addresses the single overall budget. SQLite treats NULLs
   * as distinct inside a UNIQUE index, so the schema uses two PARTIAL unique
   * indexes; the upserts below must therefore repeat the same WHERE predicate as
   * the index they target, otherwise SQLite cannot infer which index applies.
   */
  set(input: { categoryId: number | null; limitAmount: number; currency?: string }): Budget {
    const errors: FieldErrors = {}
    const limitAmount = requireAmount(errors, 'limitAmount', input.limitAmount, { label: 'Budget limit' })

    if (input.categoryId !== null && input.categoryId !== undefined) {
      const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(input.categoryId) as
        | CategoryRow
        | undefined
      if (!row) errors.categoryId = 'That category does not exist.'
      else if (mapCategory(row).type !== 'expense') {
        // A budget on an income category is not meaningful.
        errors.categoryId = 'Budgets can only be set on expense categories.'
      }
    }

    assertNoErrors(errors, 'The budget could not be saved.')

    const timestamp = nowIso()
    const currency = input.currency ?? DEFAULT_CURRENCY

    if (input.categoryId === null || input.categoryId === undefined) {
      this.db
        .prepare(
          `INSERT INTO budgets (category_id, period, limit_amount, currency, created_at, updated_at)
           VALUES (NULL, 'monthly', ?, ?, ?, ?)
           ON CONFLICT(period) WHERE category_id IS NULL
           DO UPDATE SET limit_amount = excluded.limit_amount, currency = excluded.currency, updated_at = excluded.updated_at`
        )
        .run(limitAmount, currency, timestamp, timestamp)

      return mapBudget(this.db.prepare('SELECT * FROM budgets WHERE category_id IS NULL').get() as BudgetRow)
    }

    this.db
      .prepare(
        `INSERT INTO budgets (category_id, period, limit_amount, currency, created_at, updated_at)
         VALUES (?, 'monthly', ?, ?, ?, ?)
         ON CONFLICT(category_id) WHERE category_id IS NOT NULL
         DO UPDATE SET limit_amount = excluded.limit_amount, currency = excluded.currency, updated_at = excluded.updated_at`
      )
      .run(input.categoryId, limitAmount, currency, timestamp, timestamp)

    return mapBudget(this.db.prepare('SELECT * FROM budgets WHERE category_id = ?').get(input.categoryId) as BudgetRow)
  }

  remove(id: number): { deleted: true } {
    const result = this.db.prepare('DELETE FROM budgets WHERE id = ?').run(id)
    if (result.changes === 0) throw new NotFoundError('Budget', id)
    return { deleted: true }
  }

  /**
   * Progress against each budget for a reporting period.
   *
   * TWO CORRECTNESS REQUIREMENTS, BOTH SATISFIED HERE
   * ------------------------------------------------
   * 1. **The window is a settlement cycle, not a calendar month.** With
   *    `cycleStartDay = 5` the period is 5 Aug – 4 Sep. Using `${key}-01` to
   *    `endOfMonth(key)` would describe a different window from the one the
   *    budget card is labelled with, so the label and the figure would disagree.
   *
   * 2. **Spending is converted before it is summed.** Categories span accounts,
   *    so a single `SUM(amount)` adds fen to sen the moment two currencies are in
   *    play. Rows are grouped by category AND currency, then each currency's
   *    subtotal is converted once and combined.
   *
   * Only `type = 'expense'` rows count: a transfer moves money between the user's
   * own accounts and is not spending, so it must never consume budget.
   */
  progress(
    cycleKey: string,
    cycleStartDay = 1,
    // Deliberately `string`, not the `CurrencyCode` union: a provider can return
    // a currency the app's shortlist does not name, and the display currency is
    // whatever the user selected. `minorUnitScale` and `lookupRate` both handle
    // an unknown-but-valid code without falling back to a wrong scale.
    displayCurrency: string = DEFAULT_CURRENCY,
    rates: RateTable | null = null
  ): BudgetProgress[] {
    const cycle = cycleFromKey(cycleKey, cycleStartDay)
    const from = cycle.start
    const to = cycle.end

    const budgets = this.list()

    // Grouped by category AND currency so every SUM stays within one currency.
    const rows = this.db
      .prepare(
        `SELECT
           t.category_id AS category_id,
           a.currency AS currency,
           COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.type = 'expense' AND t.date >= ? AND t.date <= ?
         GROUP BY t.category_id, a.currency`
      )
      .all(from, to) as Array<{ category_id: number | null; currency: string; total: number }>

    const displayScale = minorUnitScale(displayCurrency)
    const spendByCategory = new Map<number, number>()
    let totalExpenseMajor = 0

    for (const row of rows) {
      const rate = lookupRate(rates, row.currency, displayCurrency)
      if (rate === null) continue
      const magnitude = Math.abs(row.total)
      const major = (magnitude / minorUnitScale(row.currency)) * rate
      totalExpenseMajor += major
      if (row.category_id !== null) {
        spendByCategory.set(row.category_id, (spendByCategory.get(row.category_id) ?? 0) + major)
      }
    }

    const totalExpense = Math.round(totalExpenseMajor * displayScale)
    for (const [categoryId, major] of spendByCategory) {
      spendByCategory.set(categoryId, Math.round(major * displayScale))
    }

    return budgets.map((budget) => {
      let spent: number
      let categoryName: string | null = null
      let categoryIcon: string | null = null
      let categoryColor: string | null = null

      if (budget.categoryId === null) {
        spent = totalExpense
        // Named in the main process because the renderer needs a stable marker to
        // recognise the overall budget; it maps this to a Chinese label.
        categoryName = 'All categories'
      } else {
        spent = spendByCategory.get(budget.categoryId) ?? 0
        const row = this.db.prepare('SELECT * FROM categories WHERE id = ?').get(budget.categoryId) as
          | CategoryRow
          | undefined
        if (row) {
          const category = mapCategory(row)
          categoryName = category.name
          categoryIcon = category.icon
          categoryColor = category.color
        } else {
          // The category was deleted; the budget row is removed by ON DELETE
          // CASCADE, so this is only reachable if the database was edited externally.
          categoryName = 'Deleted category'
        }
      }

      // A budget's limit is expressed in the same currency the spending is
      // reported in, so the comparison is like-for-like.
      return {
        budget: { ...budget, currency: displayCurrency },
        categoryName,
        categoryIcon,
        categoryColor,
        spent,
        remaining: budget.limitAmount - spent,
        // Clamped so a bar never renders wider than its track. The over-budget
        // state is communicated separately by `overBudget`, which lets the UI
        // choose a restrained treatment rather than an alarming full bar.
        ratio: budget.limitAmount > 0 ? Math.min(spent / budget.limitAmount, 1) : 0,
        overBudget: spent > budget.limitAmount
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Subscriptions (spec §24)
// ---------------------------------------------------------------------------

/**
 * Recurring subscriptions and the estimated monthly cost they imply.
 *
 * A subscription is a DESCRIPTIVE record, not a ledger entry. It never writes to
 * `transactions` on its own — the spec forbids modifying financial data without
 * the user's confirmation (spec §23, §24). When a charge is confirmed, it goes
 * through the normal transaction path so all validation still applies.
 */
export class SubscriptionsService {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Subscription[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM subscriptions ORDER BY active DESC, next_charge_date IS NULL, next_charge_date ASC, name ASC'
      )
      .all() as SubscriptionRow[]
    return rows.map(mapSubscription)
  }

  get(id: number): Subscription {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as SubscriptionRow | undefined
    if (!row) throw new NotFoundError('Subscription', id)
    return mapSubscription(row)
  }

  create(input: SubscriptionInput): Subscription {
    const data = this.validate(input, null)
    const timestamp = nowIso()
    const info = this.db
      .prepare(
        `INSERT INTO subscriptions
           (name, amount, currency, cycle, next_charge_date, account_id, category_id, active, note, created_at, updated_at)
         VALUES
           (@name, @amount, @currency, @cycle, @nextChargeDate, @accountId, @categoryId, @active, @note, @createdAt, @updatedAt)`
      )
      .run({ ...data, createdAt: timestamp, updatedAt: timestamp })

    return this.get(Number(info.lastInsertRowid))
  }

  update(id: number, input: Partial<SubscriptionInput>): Subscription {
    const existing = this.get(id)
    const data = this.validate(
      {
        name: input.name ?? existing.name,
        amount: input.amount ?? existing.amount,
        currency: input.currency ?? existing.currency,
        cycle: input.cycle ?? existing.cycle,
        nextChargeDate: input.nextChargeDate === undefined ? existing.nextChargeDate : input.nextChargeDate,
        accountId: input.accountId === undefined ? existing.accountId : input.accountId,
        categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
        active: input.active ?? existing.active,
        note: input.note === undefined ? existing.note : input.note
      },
      id
    )

    this.db
      .prepare(
        `UPDATE subscriptions SET
           name = @name, amount = @amount, currency = @currency, cycle = @cycle,
           next_charge_date = @nextChargeDate, account_id = @accountId, category_id = @categoryId,
           active = @active, note = @note, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({ ...data, id, updatedAt: nowIso() })

    return this.get(id)
  }

  remove(id: number): { deleted: true } {
    const result = this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id)
    if (result.changes === 0) throw new NotFoundError('Subscription', id)
    return { deleted: true }
  }

  /**
   * Estimated monthly recurring cost.
   *
   * Each active subscription contributes amount * occurrencesPerYear / 12, using
   * integer arithmetic rounded per item (a yearly RM120 charge contributes
   * 12000 * 1 / 12 = 1000 exactly).
   *
   * Only one currency can produce a meaningful single figure, so the currency
   * with the most active subscriptions wins and others are excluded rather than
   * added — summing RM and ¥ would be a confidently wrong number.
   */
  monthlyEstimate(): { amount: number; currency: string } {
    const active = this.list().filter((subscription) => subscription.active)
    if (active.length === 0) return { amount: 0, currency: DEFAULT_CURRENCY }

    const counts = new Map<string, number>()
    for (const subscription of active) {
      counts.set(subscription.currency, (counts.get(subscription.currency) ?? 0) + 1)
    }
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]

    let total = 0
    for (const subscription of active) {
      if (subscription.currency !== currency) continue
      total += Math.round((subscription.amount * CYCLES_PER_YEAR[subscription.cycle]) / 12)
    }

    return { amount: total, currency }
  }

  private validate(input: SubscriptionInput, excludeId: number | null) {
    const errors: FieldErrors = {}

    const name = String(input.name ?? '').trim()
    if (!name) errors.name = 'Subscription name is required.'
    else if (name.length > 80) errors.name = 'Subscription name must be 80 characters or fewer.'

    const amount = requireAmount(errors, 'amount', input.amount, { label: 'Amount' })
    const currency = requireCurrency(errors, 'currency', input.currency)
    const cycle = requireEnum(errors, 'cycle', input.cycle, BILLING_CYCLES, { label: 'Billing cycle' }) as BillingCycle
    const nextChargeDate = optionalDate(errors, 'nextChargeDate', input.nextChargeDate, { label: 'Next charge date' })

    if (input.accountId !== null && input.accountId !== undefined) {
      requireId(errors, 'accountId', input.accountId, { label: 'Account' })
      if (!this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(input.accountId)) {
        errors.accountId = 'That account does not exist.'
      }
    }
    if (input.categoryId !== null && input.categoryId !== undefined) {
      requireId(errors, 'categoryId', input.categoryId, { label: 'Category' })
      if (!this.db.prepare('SELECT id FROM categories WHERE id = ?').get(input.categoryId)) {
        errors.categoryId = 'That category does not exist.'
      }
    }

    if (excludeId === null) {
      const duplicate = this.db.prepare('SELECT id FROM subscriptions WHERE name = ?').get(name) as
        | { id: number }
        | undefined
      if (duplicate) errors.name = `A subscription named "${name}" already exists.`
    }

    assertNoErrors(errors, 'The subscription could not be saved.')

    return {
      name,
      amount,
      currency,
      cycle,
      nextChargeDate,
      accountId: input.accountId ?? null,
      categoryId: input.categoryId ?? null,
      active: input.active === false ? 0 : 1,
      note: input.note ? String(input.note).trim().slice(0, 300) : null
    }
  }
}

// ---------------------------------------------------------------------------
// Recurring rules (spec §23)
// ---------------------------------------------------------------------------

/**
 * Recurring rules, implemented as REMINDERS rather than automation.
 *
 * The spec is explicit that the MVP surfaces a suggested transaction which the
 * user confirms, because silently writing to someone's ledger is unacceptable
 * behaviour for a finance app. `due()` therefore only REPORTS what has come due;
 * `confirm()` is the explicit user action that creates a real transaction, and it
 * is the only place this class writes to the ledger.
 */
export class RecurringService {
  constructor(private readonly db: SqliteDatabase) {}

  list(): RecurringRule[] {
    const rows = this.db
      .prepare('SELECT * FROM recurring_rules ORDER BY active DESC, next_due_date ASC, label ASC')
      .all() as RecurringRuleRow[]
    return rows.map(mapRecurringRule)
  }

  get(id: number): RecurringRule {
    const row = this.db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(id) as RecurringRuleRow | undefined
    if (!row) throw new NotFoundError('Recurring rule', id)
    return mapRecurringRule(row)
  }

  create(input: RecurringRuleInput): RecurringRule {
    const data = this.validate(input)
    const timestamp = nowIso()
    const info = this.db
      .prepare(
        `INSERT INTO recurring_rules
           (label, type, amount, account_id, category_id, merchant, note, frequency,
            day_of_period, month_of_year, last_run_date, next_due_date, active, created_at, updated_at)
         VALUES
           (@label, @type, @amount, @accountId, @categoryId, @merchant, @note, @frequency,
            @dayOfPeriod, @monthOfYear, NULL, @nextDueDate, @active, @createdAt, @updatedAt)`
      )
      .run({ ...data, createdAt: timestamp, updatedAt: timestamp })

    return this.get(Number(info.lastInsertRowid))
  }

  update(id: number, input: Partial<RecurringRuleInput>): RecurringRule {
    const existing = this.get(id)
    const data = this.validate({
      label: input.label ?? existing.label,
      type: input.type ?? existing.type,
      amount: input.amount ?? existing.amount,
      accountId: input.accountId ?? existing.accountId,
      categoryId: input.categoryId === undefined ? existing.categoryId : input.categoryId,
      merchant: input.merchant === undefined ? existing.merchant : input.merchant,
      note: input.note === undefined ? existing.note : input.note,
      frequency: input.frequency ?? existing.frequency,
      dayOfPeriod: input.dayOfPeriod ?? existing.dayOfPeriod,
      monthOfYear: input.monthOfYear === undefined ? existing.monthOfYear : input.monthOfYear,
      nextDueDate: input.nextDueDate ?? existing.nextDueDate,
      active: input.active ?? existing.active
    })

    this.db
      .prepare(
        `UPDATE recurring_rules SET
           label = @label, type = @type, amount = @amount, account_id = @accountId,
           category_id = @categoryId, merchant = @merchant, note = @note, frequency = @frequency,
           day_of_period = @dayOfPeriod, month_of_year = @monthOfYear, next_due_date = @nextDueDate,
           active = @active, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({ ...data, id, updatedAt: nowIso() })

    return this.get(id)
  }

  remove(id: number): { deleted: true } {
    const result = this.db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(id)
    if (result.changes === 0) throw new NotFoundError('Recurring rule', id)
    return { deleted: true }
  }

  /** Rules whose next due date has arrived, as of `asOf` (defaults to today). */
  due(asOf: string = today()): Array<{ rule: RecurringRule; dueDate: string }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM recurring_rules
         WHERE active = 1 AND next_due_date <= ?
         ORDER BY next_due_date ASC`
      )
      .all(asOf) as RecurringRuleRow[]

    return rows.map((row) => {
      const rule = mapRecurringRule(row)
      return { rule, dueDate: rule.nextDueDate }
    })
  }

  /**
   * Turn a due rule into a real transaction, at the user's explicit request.
   *
   * The next due date advances from the CONFIRMED date rather than the old due
   * date, so confirming a week late does not immediately queue up a backlog of
   * missed occurrences for the user to dismiss.
   */
  confirm(
    ruleId: number,
    date: string,
    transactions: {
      create: (input: {
        accountId: number
        type: 'income' | 'expense'
        amount: number
        categoryId: number | null
        date: string
        merchant: string | null
        note: string | null
      }) => TransactionWithRefs
    }
  ): TransactionWithRefs {
    const rule = this.get(ruleId)

    const run = this.db.transaction((): TransactionWithRefs => {
      const created = transactions.create({
        accountId: rule.accountId,
        type: rule.type,
        amount: rule.amount,
        categoryId: rule.categoryId,
        date,
        merchant: rule.merchant,
        note: rule.note
      })

      const next = advanceDate(rule.frequency, date)
      this.db
        .prepare('UPDATE recurring_rules SET last_run_date = ?, next_due_date = ?, updated_at = ? WHERE id = ?')
        .run(date, next, nowIso(), ruleId)

      return created
    })

    return run()
  }

  private validate(input: RecurringRuleInput) {
    const errors: FieldErrors = {}

    const label = String(input.label ?? '').trim()
    if (!label) errors.label = 'A label is required.'
    else if (label.length > 80) errors.label = 'The label must be 80 characters or fewer.'

    const type = requireEnum(errors, 'type', input.type, ['income', 'expense'] as const, { label: 'Type' })
    const amount = requireAmount(errors, 'amount', input.amount, { label: 'Amount' })
    const frequency = requireEnum(errors, 'frequency', input.frequency, RECURRENCE_FREQUENCIES, {
      label: 'Frequency'
    }) as RecurrenceFrequency
    const nextDueDate = optionalDate(errors, 'nextDueDate', input.nextDueDate, { label: 'Next due date' })

    requireId(errors, 'accountId', input.accountId, { label: 'Account' })
    if (!this.db.prepare('SELECT id FROM accounts WHERE id = ?').get(input.accountId)) {
      errors.accountId = 'That account does not exist.'
    }

    if (input.categoryId !== null && input.categoryId !== undefined) {
      const category = this.db.prepare('SELECT type FROM categories WHERE id = ?').get(input.categoryId) as
        | { type: string }
        | undefined
      if (!category) errors.categoryId = 'That category does not exist.'
      else if (category.type !== type) {
        errors.categoryId = `That category is for ${category.type}, but this rule is for ${type}.`
      }
    }

    const dayOfPeriod = input.dayOfPeriod
    if (frequency === 'weekly') {
      if (!Number.isInteger(dayOfPeriod) || dayOfPeriod < 0 || dayOfPeriod > 6) {
        errors.dayOfPeriod = 'For a weekly rule, choose a weekday from Sunday (0) to Saturday (6).'
      }
    } else if (!Number.isInteger(dayOfPeriod) || dayOfPeriod < 1 || dayOfPeriod > 31) {
      errors.dayOfPeriod = 'Choose a day of the month between 1 and 31.'
    }

    if (frequency === 'yearly' && input.monthOfYear != null) {
      if (!Number.isInteger(input.monthOfYear) || input.monthOfYear < 1 || input.monthOfYear > 12) {
        errors.monthOfYear = 'Choose a month between 1 and 12.'
      }
    }

    assertNoErrors(errors, 'The recurring rule could not be saved.')

    return {
      label,
      type,
      amount,
      accountId: input.accountId,
      categoryId: input.categoryId ?? null,
      merchant: input.merchant ? String(input.merchant).trim().slice(0, 120) : null,
      note: input.note ? String(input.note).trim().slice(0, 300) : null,
      frequency,
      dayOfPeriod,
      monthOfYear: frequency === 'yearly' ? (input.monthOfYear ?? null) : null,
      nextDueDate: nextDueDate ?? today(),
      active: input.active === false ? 0 : 1
    }
  }
}

/**
 * The next occurrence after `from`.
 *
 * Monthly and yearly advancement clamps to the target month's length, so a rule
 * set for the 31st lands on 28 February rather than overflowing into March.
 * That clamping is implemented in `addMonths`/`addYears`.
 */
function advanceDate(frequency: RecurrenceFrequency, from: string): string {
  switch (frequency) {
    case 'weekly':
      return addDays(from, 7)
    case 'yearly':
      return addYears(from, 1)
    case 'monthly':
    default:
      return addMonths(from, 1)
  }
}
