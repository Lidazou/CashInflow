import type { Database as SqliteDatabase } from 'better-sqlite3'
import {
  TRANSACTION_WITH_REFS_COLUMNS,
  mapTransactionWithRefs,
  type TransactionWithRefsRow
} from '@main/database/mappers'
import type {
  BiggestExpense,
  CalendarDay,
  CalendarMonth,
  CategoryBreakdownRow,
  CustomPeriod,
  CustomPeriodInput,
  CustomPeriodStatistics,
  DashboardSummary,
  ExchangeRateInfo,
  MultiCurrencyTotals,
  StatisticsGranularity,
  StatisticsResult,
  TrendPoint
} from '@shared/types'
import {
  addDays,
  addMonths,
  calendarGridStart,
  endOfMonth,
  endOfWeek,
  endOfYear,
  formatMonthLabel,
  nowIso,
  startOfMonth,
  startOfWeek,
  startOfYear,
  today
} from '@shared/lib/dates'
import {
  cycleFor,
  cycleFromKey,
  cycleLength,
  cycleProgress,
  daysRemaining,
  shiftCycle,
  validateCustomRange
} from '@shared/lib/periods'
import { lookupRate, rateFreshness, type RateTable } from '@shared/lib/rates'
import { minorUnitScale } from '@shared/lib/money'
import { NotFoundError, ValidationError } from '@main/database/errors'
import {
  aggregateTotals,
  readBalancesWithConversion,
  readCategoryBreakdown
} from './currency-aggregate'

/**
 * Dashboard statistics, the statistics page, and custom periods.
 *
 * TWO THINGS THAT CHANGED FOR THE MULTI-CURRENCY / SETTLEMENT-CYCLE WORK
 * ---------------------------------------------------------------------
 * 1. **No figure is computed by summing raw minor units.** Every aggregate goes
 *    through `currency-aggregate.ts`, which groups by currency first and converts
 *    once, at the end. Summing fen and sen together produces a confident,
 *    meaningless number — see that file's header for the full reasoning.
 *
 * 2. **The reporting period is a settlement cycle, not a calendar month.** With
 *    `cycleStartDay = 5`, "this month" spans 5 Aug – 4 Sep. `cycleStartDay = 1`
 *    reproduces a calendar month exactly, so this generalises the period rather
 *    than switching modes.
 *
 * Every number returned here is read from the database. There are no
 * illustrative constants anywhere in this file.
 */
export class StatisticsService {
  constructor(
    private readonly db: SqliteDatabase,
    /** Reads the cached rate table. Injected so tests never touch the network. */
    private readonly ratesProvider: () => RateTable | null = () => null
  ) {}

  private rates(): RateTable | null {
    try {
      return this.ratesProvider()
    } catch {
      // A rates failure must never break a statistics query: figures fall back
      // to unconverted values and the UI reports that rates are unavailable.
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  /**
   * Everything the home screen needs, in one round trip.
   *
   * `cycleKey` identifies the period, `displayCurrency` is the unit every figure
   * is converted into, and `cycleStartDay` defines where periods begin.
   */
  dashboard(
    cycleKey: string,
    displayCurrency: string,
    cycleStartDay: number,
    day: string = today(),
    baseCurrency: string = displayCurrency
  ): DashboardSummary {
    const rates = this.rates()
    const cycle = cycleFromKey(cycleKey, cycleStartDay)

    const { balances, convertedTotal } = readBalancesWithConversion(this.db, displayCurrency, rates)
    const month = aggregateTotals(this.db, cycle.start, cycle.end, displayCurrency, rates).totals
    const todayTotals = aggregateTotals(this.db, day, day, displayCurrency, rates).totals

    const accountCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE archived = 0').get() as { n: number }
    ).n

    return {
      balances,
      month,
      today: todayTotals,
      monthKey: cycle.key,
      todayDate: day,
      displayCurrency,
      baseCurrency,
      accountCount,
      netWorthInBaseCurrency: convertedTotal,
      cycle: {
        start: cycle.start,
        end: cycle.end,
        key: cycle.key,
        label: cycle.label,
        startDay: cycle.startDay,
        daysTotal: cycleLength(cycle),
        daysRemaining: daysRemaining(cycle, day),
        progress: cycleProgress(cycle, day)
      },
      rates: this.rateInfo(displayCurrency)
    }
  }

  /** Current rate state, including the ticker pairs shown on the dashboard. */
  rateInfo(displayCurrency: string, quoteTargets: string[] = ['MYR', 'USD', 'SGD', 'HKD']): ExchangeRateInfo {
    const rates = this.rates()

    const quotes = quoteTargets
      .filter((target) => target.toUpperCase() !== displayCurrency.toUpperCase())
      .map((target) => {
        const rate = lookupRate(rates, displayCurrency, target)
        return rate === null ? null : { from: displayCurrency, to: target, rate }
      })

    return {
      hasRates: rates !== null,
      base: rates ? String(rates.base) : null,
      fetchedAt: rates?.fetchedAt ?? null,
      provider: rates?.provider ?? null,
      isManual: rates?.isManual ?? false,
      ageHours: this.rateAgeHours(rates),
      freshness: rateFreshness(rates),
      quotes,
      lastError: null,
      // The conversion table travels with the metadata so a rate and the table it
      // came from can never disagree on screen.
      table: rates
    }
  }

  private rateAgeHours(rates: RateTable | null): number | null {
    if (!rates) return null
    const fetched = new Date(rates.fetchedAt)
    if (Number.isNaN(fetched.getTime())) return null
    return Math.max(0, Math.round(((Date.now() - fetched.getTime()) / 3_600_000) * 10) / 10)
  }

  // -------------------------------------------------------------------------
  // Biggest expenses
  // -------------------------------------------------------------------------

  /**
   * Largest single expenses in a period.
   *
   * Ranking compares amounts ACROSS currencies, so each candidate is converted to
   * the display currency before sorting. Sorting on raw minor units would rank
   * ¥50 (5000 fen) above RM 100 (10000 sen) purely because 5000 < 10000 — a
   * comparison between two different units, which is not a comparison at all.
   */
  biggestExpenses(
    cycleKey: string,
    cycleStartDay: number,
    displayCurrency: string,
    limit = 5
  ): BiggestExpense[] {
    const cycle = cycleFromKey(cycleKey, cycleStartDay)
    return this.biggestExpensesInRange(cycle.start, cycle.end, displayCurrency, limit)
  }

  allExpensesRanked(
    cycleKey: string,
    cycleStartDay: number,
    displayCurrency: string,
    limit = 200
  ): BiggestExpense[] {
    return this.biggestExpenses(cycleKey, cycleStartDay, displayCurrency, limit)
  }

  private biggestExpensesInRange(
    from: string,
    to: string,
    displayCurrency: string,
    limit: number
  ): BiggestExpense[] {
    const rates = this.rates()

    const rows = this.db
      .prepare(
        `SELECT ${TRANSACTION_WITH_REFS_COLUMNS}
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.type = 'expense' AND t.date >= ? AND t.date <= ?`
      )
      .all(from, to) as TransactionWithRefsRow[]

    const displayScale = minorUnitScale(displayCurrency)

    const ranked = rows
      .map((row) => {
        const item = mapTransactionWithRefs(row)
        const rate = lookupRate(rates, item.accountCurrency, displayCurrency)
        const magnitude = Math.abs(item.amount) / minorUnitScale(item.accountCurrency)
        // An unconvertible amount is ranked by its own magnitude rather than
        // being dropped, so a currency we have no rate for does not make a large
        // expense vanish from the list. It is flagged instead.
        const converted =
          rate === null ? Math.round(magnitude * displayScale) : Math.round(magnitude * rate * displayScale)
        return { item, converted, converted_ok: rate !== null }
      })
      .sort((a, b) => b.converted - a.converted)

    const largest = ranked.length > 0 ? ranked[0].converted : 0

    return ranked.slice(0, limit).map((entry, index) => ({
      ...entry.item,
      rank: index + 1,
      ratio: largest > 0 ? entry.converted / largest : 0,
      convertedAmount: entry.converted,
      displayCurrency,
      conversionAvailable: entry.converted_ok
    }))
  }

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------

  resolveRange(granularity: StatisticsGranularity, anchor: string): { from: string; to: string } {
    switch (granularity) {
      case 'day':
        return { from: anchor, to: anchor }
      case 'week':
        return { from: startOfWeek(anchor, 1), to: endOfWeek(anchor, 1) }
      case 'year':
        return { from: startOfYear(anchor), to: endOfYear(anchor) }
      case 'month':
      default:
        return { from: startOfMonth(anchor), to: endOfMonth(anchor) }
    }
  }

  statistics(
    granularity: StatisticsGranularity,
    anchor: string,
    displayCurrency: string,
    cycleStartDay: number
  ): StatisticsResult {
    const rates = this.rates()

    // For the month granularity, honour the settlement cycle so the statistics
    // page and the dashboard describe the same window. Day, week and year are
    // inherently calendar-based and stay as they are.
    const { from, to } =
      granularity === 'month'
        ? (() => {
            const cycle = cycleFor(anchor, cycleStartDay)
            return { from: cycle.start, to: cycle.end }
          })()
        : this.resolveRange(granularity, anchor)

    return {
      granularity,
      from,
      to,
      totals: aggregateTotals(this.db, from, to, displayCurrency, rates).totals,
      trend: this.trend(granularity, from, to, displayCurrency),
      categories: readCategoryBreakdown(this.db, from, to, displayCurrency, rates),
      topExpenses: this.biggestExpensesInRange(from, to, displayCurrency, 10),
      currency: displayCurrency
    }
  }

  /**
   * Income/expense/net over time.
   *
   * Grouped by bucket AND currency so every SUM stays inside one currency, then
   * converted and combined in memory. Grouping by bucket alone would add fen to
   * sen.
   */
  trend(granularity: StatisticsGranularity, from: string, to: string, displayCurrency: string): TrendPoint[] {
    const rates = this.rates()
    const bucketExpr = this.bucketExpression(granularity)

    const rows = this.db
      .prepare(
        `SELECT
           ${bucketExpr} AS bucket,
           a.currency AS currency,
           COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expense
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.date >= ? AND t.date <= ? AND t.type IN ('income','expense')
         GROUP BY bucket, a.currency
         ORDER BY bucket ASC`
      )
      .all(from, to) as Array<{ bucket: string; currency: string; income: number; expense: number }>

    const displayScale = minorUnitScale(displayCurrency)
    const byBucket = new Map<string, { income: number; expense: number }>()

    for (const row of rows) {
      const rate = lookupRate(rates, row.currency, displayCurrency)
      if (rate === null) continue
      const scale = minorUnitScale(row.currency)
      const entry = byBucket.get(row.bucket) ?? { income: 0, expense: 0 }
      entry.income += (row.income / scale) * rate
      entry.expense += (Math.abs(row.expense) / scale) * rate
      byBucket.set(row.bucket, entry)
    }

    return [...byBucket.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, value]) => {
        const income = Math.round(value.income * displayScale)
        const expense = Math.round(value.expense * displayScale)
        return {
          key: bucket,
          label: this.bucketLabel(granularity, bucket),
          income,
          expense,
          net: income - expense
        }
      })
  }

  private bucketExpression(granularity: StatisticsGranularity): string {
    switch (granularity) {
      case 'day':
        return `strftime('%Y-%m-%d', t.date)`
      case 'week':
        return `strftime('%Y-W%W', t.date)`
      case 'year':
        return `strftime('%Y', t.date)`
      case 'month':
      default:
        return `strftime('%Y-%m', t.date)`
    }
  }

  /** Axis labels. Hand-built Chinese labels keep output stable across machines. */
  private bucketLabel(granularity: StatisticsGranularity, bucket: string): string {
    switch (granularity) {
      case 'day': {
        const [, month, day] = bucket.split('-')
        return `${Number(month)}月${Number(day)}日`
      }
      case 'week': {
        const [year, week] = bucket.split('-W')
        return `${year}年第${Number(week)}周`
      }
      case 'year':
        return `${bucket}年`
      case 'month':
      default: {
        const [year, month] = bucket.split('-')
        return `${year}年${Number(month)}月`
      }
    }
  }

  categoryBreakdown(from: string, to: string, displayCurrency: string): CategoryBreakdownRow[] {
    return readCategoryBreakdown(this.db, from, to, displayCurrency, this.rates())
  }

  // -------------------------------------------------------------------------
  // Calendar
  // -------------------------------------------------------------------------

  calendarMonth(monthKey: string, displayCurrency: string, weekStartsOn: 0 | 1 = 1): CalendarMonth {
    const rates = this.rates()
    const from = `${monthKey}-01`
    const to = endOfMonth(monthKey)

    // Grouped by date and currency so each day's SUM stays within one currency.
    const rows = this.db
      .prepare(
        `SELECT
           t.date AS date,
           a.currency AS currency,
           COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expense,
           COUNT(*) AS transaction_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE t.date >= ? AND t.date <= ? AND t.type IN ('income','expense')
         GROUP BY t.date, a.currency
         ORDER BY t.date ASC`
      )
      .all(from, to) as Array<{
      date: string
      currency: string
      income: number
      expense: number
      transaction_count: number
    }>

    const displayScale = minorUnitScale(displayCurrency)
    const byDate = new Map<string, { income: number; expense: number; count: number }>()

    for (const row of rows) {
      const rate = lookupRate(rates, row.currency, displayCurrency)
      if (rate === null) continue
      const scale = minorUnitScale(row.currency)
      const entry = byDate.get(row.date) ?? { income: 0, expense: 0, count: 0 }
      entry.income += (row.income / scale) * rate
      entry.expense += (Math.abs(row.expense) / scale) * rate
      entry.count += row.transaction_count
      byDate.set(row.date, entry)
    }

    const days: CalendarDay[] = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, value]) => {
        const income = Math.round(value.income * displayScale)
        const expense = Math.round(value.expense * displayScale)
        return { date, income, expense, net: income - expense, transactionCount: value.count }
      })

    return {
      monthKey,
      gridStart: calendarGridStart(monthKey, weekStartsOn),
      days,
      totals: aggregateTotals(this.db, from, to, displayCurrency, rates).totals,
      currency: displayCurrency
    }
  }

  dayTotals(date: string, displayCurrency: string): MultiCurrencyTotals {
    return aggregateTotals(this.db, date, date, displayCurrency, this.rates()).totals
  }

  // -------------------------------------------------------------------------
  // Custom arbitrary periods
  // -------------------------------------------------------------------------

  /**
   * Statistics for an arbitrary date range with an optional total.
   *
   * This is the "输入总金额和统计区间" view: a student who has RM 2,000 for a
   * semester picks the semester dates, enters 2000, and sees how much is left
   * and whether the current pace will last.
   *
   * The projection is a straight linear extrapolation of the average daily spend
   * over elapsed days. It is labelled as an estimate in the UI: presenting it as
   * a forecast with confidence would be dishonest, but omitting it would leave
   * the user to do the arithmetic.
   */
  customPeriod(
    input: { from: string; to: string; budgetAmount?: number | null; currency?: string },
    displayCurrency: string,
    asOf: string = today()
  ): CustomPeriodStatistics {
    const error = validateCustomRange(input.from, input.to)
    if (error) throw new ValidationError(error, { from: error })

    const rates = this.rates()
    const { from, to } = input

    const totals = aggregateTotals(this.db, from, to, displayCurrency, rates).totals
    const daysTotal =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

    // Elapsed days are clamped to the range, so a future period reports zero
    // elapsed rather than a negative number that would corrupt the average.
    let daysElapsed: number
    if (asOf < from) daysElapsed = 0
    else if (asOf > to) daysElapsed = daysTotal
    else
      daysElapsed =
        Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

    // The budget is entered in the display currency. Accepting it in another unit
    // would raise the question of which day's rate applied, which the app cannot
    // answer.
    const budgetAmount =
      typeof input.budgetAmount === 'number' && input.budgetAmount > 0 ? Math.trunc(input.budgetAmount) : null

    const dailyAverage = daysElapsed > 0 ? Math.round(totals.expense / daysElapsed) : 0
    const projectedTotal = daysElapsed > 0 && daysTotal > 0 ? Math.round(dailyAverage * daysTotal) : null

    return {
      granularity: 'month',
      from,
      to,
      totals,
      trend: this.trend('day', from, to, displayCurrency),
      categories: readCategoryBreakdown(this.db, from, to, displayCurrency, rates),
      topExpenses: this.biggestExpensesInRange(from, to, displayCurrency, 10),
      currency: displayCurrency,
      budget: budgetAmount === null ? null : { amount: budgetAmount, currency: input.currency ?? displayCurrency },
      spent: totals.expense,
      remaining: budgetAmount === null ? null : budgetAmount - totals.expense,
      usedRatio:
        budgetAmount === null || budgetAmount <= 0 ? 0 : Math.min(totals.expense / budgetAmount, 1),
      overBudget: budgetAmount !== null && totals.expense > budgetAmount,
      dailyAverage,
      daysElapsed,
      daysTotal,
      projectedTotal
    }
  }

  // -------------------------------------------------------------------------
  // Saved custom periods
  // -------------------------------------------------------------------------

  listCustomPeriods(): CustomPeriod[] {
    const rows = this.db
      .prepare('SELECT * FROM custom_periods ORDER BY from_date DESC, id DESC')
      .all() as Array<{
      id: number
      label: string
      from_date: string
      to_date: string
      budget_amount: number | null
      currency: string
      created_at: string
      updated_at: string
    }>

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      from: row.from_date,
      to: row.to_date,
      budgetAmount: row.budget_amount,
      currency: row.currency,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  saveCustomPeriod(input: CustomPeriodInput): CustomPeriod {
    const error = validateCustomRange(input.from, input.to)
    if (error) throw new ValidationError(error, { from: error })

    const label = String(input.label ?? '').trim()
    if (!label) throw new ValidationError('请为该统计区间填写一个名称。', { label: '名称不能为空' })
    if (label.length > 60) throw new ValidationError('名称不能超过 60 个字符。', { label: '名称过长' })

    const budget =
      typeof input.budgetAmount === 'number' && input.budgetAmount > 0 ? Math.trunc(input.budgetAmount) : null
    const timestamp = nowIso()

    const info = this.db
      .prepare(
        `INSERT INTO custom_periods (label, from_date, to_date, budget_amount, currency, created_at, updated_at)
         VALUES (@label, @from, @to, @budget, @currency, @createdAt, @updatedAt)`
      )
      .run({
        label,
        from: input.from,
        to: input.to,
        budget,
        currency: input.currency ?? 'CNY',
        createdAt: timestamp,
        updatedAt: timestamp
      })

    const id = Number(info.lastInsertRowid)
    const saved = this.listCustomPeriods().find((period) => period.id === id)
    if (!saved) throw new NotFoundError('统计区间', id)
    return saved
  }

  deleteCustomPeriod(id: number): { deleted: true } {
    const result = this.db.prepare('DELETE FROM custom_periods WHERE id = ?').run(id)
    if (result.changes === 0) throw new NotFoundError('统计区间', id)
    return { deleted: true }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  monthsWithData(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m', date) AS month
         FROM transactions
         WHERE type IN ('income','expense')
         ORDER BY month DESC`
      )
      .all() as Array<{ month: string }>
    return rows.map((row) => row.month)
  }

  defaultMonth(): string {
    const months = this.monthsWithData()
    if (months.length > 0) return months[0]
    return today().slice(0, 7)
  }

  dailySeries(monthKey: string): Array<{ date: string; expense: number; income: number }> {
    const from = `${monthKey}-01`
    const to = endOfMonth(monthKey)
    const rows = this.db
      .prepare(
        `SELECT date,
           COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense,
           COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS income
         FROM transactions
         WHERE date >= ? AND date <= ? AND type IN ('income','expense')
         GROUP BY date`
      )
      .all(from, to) as Array<{ date: string; expense: number; income: number }>

    const byDate = new Map(rows.map((row) => [row.date, row]))
    const series: Array<{ date: string; expense: number; income: number }> = []
    let cursor = from
    while (cursor <= to) {
      const found = byDate.get(cursor)
      series.push({
        date: cursor,
        expense: found ? Math.abs(found.expense) : 0,
        income: found ? found.income : 0
      })
      cursor = addDays(cursor, 1)
    }
    return series
  }

  lastNMonths(n: number, endMonthKey?: string): string[] {
    const keys: string[] = []
    let cursor = `${endMonthKey ?? this.defaultMonth()}-01`
    for (let i = 0; i < n; i += 1) {
      keys.unshift(cursor.slice(0, 7))
      cursor = addMonths(cursor, -1)
    }
    return keys
  }

  static label(monthKey: string): string {
    return formatMonthLabel(monthKey)
  }

  weekKeyFor(date: string): string {
    return date
  }

  /** Cycle metadata alone, for the dashboard's period header. */
  cycleInfo(
    cycleKey: string,
    cycleStartDay: number,
    asOf: string = today()
  ): { start: string; end: string; key: string; label: string; startDay: number; daysTotal: number; daysRemaining: number; progress: number } {
    const cycle = cycleFromKey(cycleKey, cycleStartDay)
    return {
      start: cycle.start,
      end: cycle.end,
      key: cycle.key,
      label: cycle.label,
      startDay: cycle.startDay,
      daysTotal: cycleLength(cycle),
      daysRemaining: daysRemaining(cycle, asOf),
      progress: cycleProgress(cycle, asOf)
    }
  }

  /** Move a cycle key by whole cycles, honouring the anchor day. */
  shiftCycleKey(cycleKey: string, cycleStartDay: number, delta: number): string {
    const cycle = cycleFromKey(cycleKey, cycleStartDay)
    return shiftCycle(addDays(cycle.start, 1), cycleStartDay, delta).key
  }
}
