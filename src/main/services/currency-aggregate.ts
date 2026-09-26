import type { Database as SqliteDatabase } from 'better-sqlite3'
import { lookupRate, type RateTable } from '@shared/lib/rates'
import { minorUnitScale } from '@shared/lib/money'
import type { CurrencyBalance, MultiCurrencyTotals } from '@shared/types'

/**
 * Currency-aware aggregation.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * -----------------------------
 * The obvious way to total a period is:
 *
 *     SELECT SUM(amount) FROM transactions WHERE date BETWEEN ? AND ?
 *
 * That is correct only while every account shares one currency. The moment a
 * student holds a CNY account and a MYR account, it adds 2800 (fen) to 1850
 * (sen) and reports 4650 of nothing. The number looks plausible and is
 * meaningless — the worst kind of bug in a finance app.
 *
 * THE RULE: never sum across currencies. Instead, convert each currency's
 * subtotal into the display currency and add those. The subtotal for a currency
 * is itself an exact integer sum, so there is exactly ONE rounding step, applied
 * at the very end.
 *
 * Rounding per-transaction and then adding would accumulate error: a hundred
 * ¥0.50 items each rounded individually can be off by a cent or more versus
 * converting the ¥50 total once. One rounding, at the end, always.
 */

export interface CurrencyTotals {
  currency: string
  income: number
  /** Positive magnitude. */
  expense: number
  transactionCount: number
}

export interface AggregateResult {
  /** Converted into the display currency. */
  totals: MultiCurrencyTotals
  /** Per-currency breakdown, unconverted, for auditing the conversion. */
  byCurrency: CurrencyTotals[]
}

/**
 * Read per-currency income/expense subtotals for a date range.
 *
 * The GROUP BY is what makes this safe: each row's minor units belong to exactly
 * one currency, so the SUM inside a group is exact.
 */
export function readTotalsByCurrency(
  db: SqliteDatabase,
  from: string,
  to: string,
  accountIds: number[] | null = null
): CurrencyTotals[] {
  const params: unknown[] = [from, to]
  let accountClause = ''
  if (accountIds && accountIds.length > 0) {
    accountClause = `AND t.account_id IN (${accountIds.map(() => '?').join(', ')})`
    params.push(...accountIds)
  }

  const rows = db
    .prepare(
      `SELECT
         a.currency AS currency,
         COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expense,
         COALESCE(SUM(CASE WHEN t.type IN ('income','expense') THEN 1 ELSE 0 END), 0) AS count
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.date >= ? AND t.date <= ? ${accountClause}
       GROUP BY a.currency
       ORDER BY a.currency ASC`
    )
    .all(...params) as Array<{ currency: string; income: number; expense: number; count: number }>

  return rows.map((row) => ({
    currency: row.currency,
    income: row.income,
    // Expenses are stored negative; report a positive magnitude.
    expense: Math.abs(row.expense),
    transactionCount: row.count
  }))
}

/**
 * Convert per-currency subtotals into the display currency and combine them.
 *
 * Accumulates in MAJOR units as floating point, deliberately, and rounds once at
 * the end. That is the opposite of the rule for storing money, and it is correct
 * here: the intermediate value is a derived statistic that is never persisted,
 * and rounding it earlier would introduce error into the sum rather than remove
 * it. It is converted back to integer minor units before it leaves this function.
 */
export function combineCurrencyTotals(
  byCurrency: CurrencyTotals[],
  displayCurrency: string,
  rates: RateTable | null
): AggregateResult {
  let incomeMajor = 0
  let expenseMajor = 0
  let transactionCount = 0
  let hasUnconverted = false

  const sources: MultiCurrencyTotals['sources'] = []
  const displayScale = minorUnitScale(displayCurrency)

  for (const row of byCurrency) {
    const sameCurrency = row.currency.toUpperCase() === displayCurrency.toUpperCase()
    const rate = sameCurrency ? 1 : lookupRate(rates, row.currency, displayCurrency)
    const converted = rate !== null

    if (!converted) hasUnconverted = true

    // With no rate, the subtotal still contributes its count so the "N
    // transactions" figure stays truthful, but it is excluded from the money
    // totals rather than being added at a rate of 1 and silently understating
    // the period.
    if (converted) {
      const scale = minorUnitScale(row.currency)
      incomeMajor += (row.income / scale) * rate
      expenseMajor += (row.expense / scale) * rate
    }
    transactionCount += row.transactionCount

    sources.push({
      currency: row.currency,
      income: row.income,
      expense: row.expense,
      converted
    })
  }

  const income = Math.round(incomeMajor * displayScale)
  const expense = Math.round(expenseMajor * displayScale)

  return {
    totals: {
      income,
      expense,
      net: income - expense,
      transactionCount,
      currency: displayCurrency,
      sources,
      hasUnconverted
    },
    byCurrency
  }
}

/** Read and combine in one step, which is what most callers want. */
export function aggregateTotals(
  db: SqliteDatabase,
  from: string,
  to: string,
  displayCurrency: string,
  rates: RateTable | null,
  accountIds: number[] | null = null
): AggregateResult {
  return combineCurrencyTotals(readTotalsByCurrency(db, from, to, accountIds), displayCurrency, rates)
}

/**
 * Account balances per currency, each converted into the display currency.
 *
 * Balances use the same one-rounding rule as period totals. The `convertedTotal`
 * is null when ANY currency lacks a rate: a partial total presented as a total
 * would be worse than admitting the figure is unavailable.
 */
export function readBalancesWithConversion(
  db: SqliteDatabase,
  displayCurrency: string,
  rates: RateTable | null
): { balances: CurrencyBalance[]; convertedTotal: number | null } {
  const rows = db
    .prepare(
      `SELECT
         a.currency AS currency,
         COUNT(*) AS account_count,
         COALESCE(SUM(a.opening_balance), 0) AS opening_total,
         COALESCE((
           SELECT SUM(t.amount) FROM transactions t
           JOIN accounts a2 ON a2.id = t.account_id
           WHERE a2.currency = a.currency AND a2.archived = 0
         ), 0) AS movement_total
       FROM accounts a
       WHERE a.archived = 0
       GROUP BY a.currency
       ORDER BY a.currency ASC`
    )
    .all() as Array<{
    currency: string
    account_count: number
    opening_total: number
    movement_total: number
  }>

  const displayScale = minorUnitScale(displayCurrency)
  let totalMajor = 0
  let allConverted = true

  const balances: CurrencyBalance[] = rows.map((row) => {
    const balance = row.opening_total + row.movement_total
    const sameCurrency = row.currency.toUpperCase() === displayCurrency.toUpperCase()
    const rate = sameCurrency ? 1 : lookupRate(rates, row.currency, displayCurrency)

    let convertedBalance: number | null = null
    if (rate !== null) {
      convertedBalance = Math.round((balance / minorUnitScale(row.currency)) * rate * displayScale)
      totalMajor += (balance / minorUnitScale(row.currency)) * rate
    } else {
      allConverted = false
    }

    return {
      currency: row.currency,
      balance,
      accountCount: row.account_count,
      convertedBalance
    }
  })

  return {
    balances,
    // No accounts at all is a legitimate zero, not a missing figure.
    convertedTotal: allConverted ? Math.round(totalMajor * displayScale) : rows.length === 0 ? 0 : null
  }
}

/**
 * Per-category expense breakdown, converted into the display currency.
 *
 * Category totals span accounts, so they are grouped by category AND currency
 * first and then combined — summing straight into one category bucket would mix
 * minor units from different currencies.
 */
export function readCategoryBreakdown(
  db: SqliteDatabase,
  from: string,
  to: string,
  displayCurrency: string,
  rates: RateTable | null
): Array<{
  categoryId: number | null
  categoryName: string
  categoryIcon: string | null
  categoryColor: string | null
  total: number
  transactionCount: number
  share: number
}> {
  const rows = db
    .prepare(
      `SELECT
         c.id    AS category_id,
         COALESCE(c.name, '未分类') AS category_name,
         c.icon  AS category_icon,
         c.color AS category_color,
         a.currency AS currency,
         COALESCE(SUM(t.amount), 0) AS total,
         COUNT(*) AS transaction_count
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       JOIN accounts a ON a.id = t.account_id
       WHERE t.type = 'expense' AND t.date >= ? AND t.date <= ?
       GROUP BY c.id, a.currency
       ORDER BY c.id ASC`
    )
    .all(from, to) as Array<{
    category_id: number | null
    category_name: string
    category_icon: string | null
    category_color: string | null
    currency: string
    total: number
    transaction_count: number
  }>

  const displayScale = minorUnitScale(displayCurrency)
  const merged = new Map<
    number | null,
    {
      categoryId: number | null
      categoryName: string
      categoryIcon: string | null
      categoryColor: string | null
      major: number
      transactionCount: number
    }
  >()

  for (const row of rows) {
    const key = row.category_id
    const magnitude = Math.abs(row.total)
    const sameCurrency = row.currency.toUpperCase() === displayCurrency.toUpperCase()
    const rate = sameCurrency ? 1 : lookupRate(rates, row.currency, displayCurrency)
    if (rate === null) continue

    const existing = merged.get(key)
    const major = (magnitude / minorUnitScale(row.currency)) * rate

    if (existing) {
      existing.major += major
      existing.transactionCount += row.transaction_count
    } else {
      merged.set(key, {
        categoryId: row.category_id,
        categoryName: row.category_name,
        categoryIcon: row.category_icon,
        categoryColor: row.category_color,
        major,
        transactionCount: row.transaction_count
      })
    }
  }

  const totals = [...merged.values()].map((entry) => ({
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    categoryIcon: entry.categoryIcon,
    categoryColor: entry.categoryColor,
    total: Math.round(entry.major * displayScale),
    transactionCount: entry.transactionCount,
    share: 0
  }))

  const grandTotal = totals.reduce((sum, entry) => sum + entry.total, 0)
  for (const entry of totals) {
    entry.share = grandTotal > 0 ? entry.total / grandTotal : 0
  }

  return totals.sort((a, b) => b.total - a.total)
}
