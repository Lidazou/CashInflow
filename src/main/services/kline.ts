import type { Database as SqliteDatabase } from 'better-sqlite3'
import { lookupRate, type RateTable } from '@shared/lib/rates'
import { minorUnitScale } from '@shared/lib/money'
import { addDays, addMonths, isoWeekKey, startOfMonth, startOfWeek, type DateString } from '@shared/lib/dates'
import type {
  CashflowTransactionMarker,
  KlineDaily,
  KlineGranularity,
  KlinePoint,
  KlineSeries,
  KlineTransaction
} from '@shared/types'

/**
 * K-line (candlestick) balance history.
 *
 * WHY THIS IS NOT `statistics.trend()` WITH MORE FIELDS
 * ----------------------------------------------------
 * `trend()` reports FLOWS — how much came in and went out per bucket. A candle
 * chart plots the BALANCE, which is a stock, and the difference is where every
 * naive implementation goes wrong:
 *
 *   1. A balance cannot be rebuilt from the chart's own bars. The user's money
 *      did not start at zero; it started at the accounts' opening balances, which
 *      are not transactions and appear in no period total. A series that starts
 *      summing flows from zero draws a chart that is wrong by exactly the amount
 *      the user already had.
 *
 *   2. Buckets must be contiguous. Drop a month with no activity and the line is
 *      drawn straight from June to August, which reads as "nothing changed" when
 *      the truth is "no activity, balance carried forward" — usually a different
 *      number, because June's flows still moved it.
 *
 *   3. The balance must be converted per ACCOUNT, not per flow. Converting each
 *      transaction and adding the converted results accumulates a rounding error
 *      per row; converting each account's CURRENT balance once and summing those
 *      keeps the single-rounding rule the rest of the app follows. Summing
 *      converted flows cannot reproduce a balance at all — the flows were already
 *      rounded individually, so the error is baked in before the first total.
 *
 *   4. Transfers are excluded from income/expense but INCLUDED in the balance.
 *      Both legs are ledger rows that move real money between accounts, so the
 *      cumulative sum must contain them; the tooltip's breakdown must not.
 *
 * THE DAILY SERIES, AND WHY THE FLOWS ARE A DIFFERENCE OF ROUNDED TOTALS
 * ---------------------------------------------------------------------
 * Every series ships `daily` as well as the chosen buckets, because zooming has to
 * change the BUCKET SIZE and not merely the visible window: rolling daily candles
 * up into weeks is arithmetic on numbers already converted, and re-querying per
 * wheel notch would be slower and a second place for the conversion to disagree
 * with the first.
 *
 * That only works if the daily figures add up. Rounding each day's converted
 * income independently does not add up: half a minor unit of error per day
 * accumulates, so a week rolled up from seven daily bars drifts from the week the
 * statistics page reports for the same dates. So the flow figures are emitted as
 * the FIRST DIFFERENCE of a rounded cumulative curve — one rounding per emitted
 * value, and every window of days sums to that window's own single-rounding
 * total. Balances need no such treatment: a balance is a stock, rounded from the
 * accounts' real balances on each day, so daily and bucket values already agree
 * exactly wherever they meet.
 *
 * PERFORMANCE SHAPE
 * -----------------
 * A fixed number of queries, never one per bucket: one account list, one
 * aggregate per (day, account), one capped tooltip read. All bucketing happens in
 * memory, and `daily` is bounded by the calendar span of the ledger (a 10-year
 * ledger is ~3,650 entries), not by the transaction count.
 *
 * THE MEASURED FIGURE
 * -------------------
 * The paragraph above is a claim, so `tests/kline.test.ts` measures it instead of
 * trusting the shape of the code: a generated 20,000-transaction ledger over
 * 1,000 days returns 33 month buckets and 1,000 daily entries in ~45 ms here,
 * against a 1-second budget. Re-run that test before believing any number in this
 * comment — the caps and the query plan are what keep it there.
 */

/** MA windows drawn by default. 250 is roughly a trading year of daily candles. */
export const DEFAULT_MA_WINDOWS: readonly number[] = [5, 10, 20, 60, 250]

/**
 * The granularities this service can SELECT, coarsest last.
 *
 * `KlineGranularity` also carries `hour` and `minute`, which the renderer reaches
 * when the reader zooms into a single day and the entries in view have real times.
 * Those are never chosen here — `chooseGranularity` works from a calendar span and
 * a day-only ledger must never be split into hours — but they are legal inputs, so
 * the guard has to accept them rather than rejecting a request the chart can serve.
 */
export const CALENDAR_GRANULARITIES: readonly KlineGranularity[] = [
  'day',
  'week',
  'month',
  'quarter',
  'year'
]

/**
 * Tooltip rows kept per bucket.
 *
 * A year bucket can legitimately hold thousands of transactions, and shipping all
 * of them to the renderer to draw a hover card would cost more than the rest of
 * the series put together. The cap is deliberately generous enough that a user
 * never notices it in normal use; `KlineBucket.transactionCount` carries the TRUE
 * count, so the UI can say so instead of silently showing a subset.
 */
export const KLINE_MAX_TRANSACTIONS_PER_BUCKET = 200

/**
 * Span thresholds for adaptive granularity, in INCLUSIVE CALENDAR DAYS.
 *
 * Calendar span, not the number of days that happen to contain a transaction.
 * The distinction matters: a student who records three transactions a year for
 * five years has "3 days with data" but a 1,825-day chart, and a day-granularity
 * choice there — which gapless bucketing then expands to 1,825 candles — is
 * exactly the unreadable chart these thresholds exist to prevent. The span is
 * also the quantity `statistics.daysInRange` already reports, so the two features
 * describe the same window with the same arithmetic.
 */
export const KLINE_GRANULARITY_THRESHOLDS = [
  { granularity: 'day', maxSpanDays: 120 },
  { granularity: 'week', maxSpanDays: 400 },
  { granularity: 'month', maxSpanDays: 1100 },
  { granularity: 'quarter', maxSpanDays: 2600 },
  { granularity: 'year', maxSpanDays: Number.POSITIVE_INFINITY }
] as const

/**
 * Pick a candle size for a span of recorded history.
 *
 * Exported as a standalone function because it is a policy decision, not a
 * detail: the thresholds are the difference between "readable at a glance" and
 * "3,000 one-pixel candles", and a policy that can only be exercised through a
 * fully seeded database is a policy that never gets tested at its boundaries.
 */
export function chooseGranularity(spanDays: number): KlineGranularity {
  // A corrupt or empty span is not a large one. Falling through to 'year' would
  // collapse a one-afternoon ledger into a single candle, so it resolves to the
  // finest granularity instead.
  if (!Number.isFinite(spanDays) || spanDays <= 0) return 'day'
  for (const step of KLINE_GRANULARITY_THRESHOLDS) {
    if (spanDays <= step.maxSpanDays) return step.granularity
  }
  return 'year'
}

export function isKlineGranularity(value: unknown): value is KlineGranularity {
  return (
    value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'quarter' ||
    value === 'year' ||
    value === 'hour' ||
    value === 'minute'
  )
}

/**
 * Inclusive day count, computed from UTC midnights.
 *
 * Same arithmetic as the private `daysInRange` in statistics.ts rather than a
 * shared export: `new Date('2026-09-26')` parses as UTC and would then be shifted
 * by the local offset, making the bucket size depend on the machine's timezone.
 */
function inclusiveDays(from: DateString, to: DateString): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0
  return Math.round((end - start) / 86_400_000) + 1
}

/**
 * First day of the bucket containing `date`. ISO weeks (Monday) match the app default.
 *
 * Intraday granularities resolve to the day: this service buckets a calendar series,
 * and the renderer's sub-day candles are built from the per-transaction balance
 * markers rather than from anything that could be keyed here.
 */
export function bucketStart(date: DateString, granularity: KlineGranularity): DateString {
  switch (granularity) {
    case 'week':
      return startOfWeek(date, 1)
    case 'month':
      return startOfMonth(date)
    case 'quarter': {
      const month = Number(date.slice(5, 7))
      const quarterStart = Math.floor((month - 1) / 3) * 3 + 1
      return `${date.slice(0, 4)}-${String(quarterStart).padStart(2, '0')}-01`
    }
    case 'year':
      return `${date.slice(0, 4)}-01-01`
    case 'day':
    case 'hour':
    case 'minute':
    default:
      return date
  }
}

/**
 * The next bucket's key.
 *
 * Stepping from the key rather than from a date inside the bucket is what makes
 * the series gapless: every bucket boundary is reachable from the previous one,
 * so there is no arithmetic by which a month could be skipped.
 */
export function nextBucketKey(key: DateString, granularity: KlineGranularity): DateString {
  switch (granularity) {
    case 'week':
      return addDays(key, 7)
    case 'month':
      return addMonths(key, 1)
    case 'quarter':
      return addMonths(key, 3)
    case 'year':
      return addMonths(key, 12)
    case 'day':
    case 'hour':
    case 'minute':
    default:
      return addDays(key, 1)
  }
}

/**
 * Axis labels, hand-built in Chinese for the same reason `statistics.bucketLabel`
 * is: `Intl` output depends on the ICU data installed on the machine, so the same
 * date can label differently on two computers.
 */
export function bucketLabel(key: DateString, granularity: KlineGranularity): string {
  switch (granularity) {
    case 'week': {
      const [year, week] = isoWeekKey(key).split('-W')
      return `${year}年第${Number(week)}周`
    }
    case 'month':
      return `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`
    case 'quarter':
      return `${key.slice(0, 4)}年Q${Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1}`
    case 'year':
      return `${key.slice(0, 4)}年`
    case 'day':
    case 'hour':
    case 'minute':
    default:
      return `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`
  }
}

/**
 * De-duplicate, sort and sanity-check the requested MA windows.
 *
 * An unknown window arriving over IPC must not produce a line the UI has no
 * legend for, and an empty list means "the caller did not care" rather than "draw
 * nothing", so both resolve to the defaults.
 */
export function normaliseMaWindows(windows?: readonly number[] | null): number[] {
  const source = Array.isArray(windows) && windows.length > 0 ? windows : DEFAULT_MA_WINDOWS
  const clean = [...new Set(source.filter((window) => Number.isInteger(window) && window > 0))].sort(
    (a, b) => a - b
  )
  return clean.length > 0 ? clean : [...DEFAULT_MA_WINDOWS]
}

/**
 * Moving averages over an integer series, in one pass per window.
 *
 * The running sum is what keeps this O(n) instead of O(n·w): recomputing each
 * window by iterating its members turns a 250-bucket MA250 into 62,500 additions
 * on every redraw. The sum stays in integer minor units, and `Math.round` is
 * applied ONCE per emitted value, so the rounding error is bounded at half a
 * minor unit per point rather than accumulating along the line.
 */
export function movingAverages(
  values: readonly number[],
  windows: readonly number[]
): Array<Record<number, number | null>> {
  const result: Array<Record<number, number | null>> = values.map(() => ({}))
  if (values.length === 0) return result

  const runningSum: number[] = new Array(values.length)
  let total = 0
  for (let i = 0; i < values.length; i += 1) {
    total += values[i]
    runningSum[i] = total
  }

  for (const window of windows) {
    for (let i = 0; i < values.length; i += 1) {
      // No partial windows: an "MA5" drawn from two points is a different line
      // that looks like the real one.
      if (window <= 0 || i < window - 1) {
        result[i][window] = null
        continue
      }
      const before = i - window >= 0 ? runningSum[i - window] : 0
      result[i][window] = Math.round((runningSum[i] - before) / window)
    }
  }

  return result
}

/**
 * The earliest bucket date at which each MA window has a full window behind it.
 *
 * Returned per series rather than computed in the renderer because only the
 * service knows where the buckets actually start: the line begins at bucket `w`,
 * not at the start of the user's history, and the UI needs to be able to say why.
 */
function maReadyKeys(
  windows: readonly number[],
  points: ReadonlyArray<{ date: string }>
): Record<number, string | null> {
  const ready: Record<number, string | null> = {}
  for (const window of windows) {
    ready[window] = points.length >= window ? points[window - 1].date : null
  }
  return ready
}

/**
 * SQL expression yielding a transaction's bucket start date.
 *
 * Used ONLY to partition the tooltip query, so that the per-bucket row cap is
 * applied in SQLite instead of after shipping the whole ledger to the renderer.
 * The rows are grouped by `bucketStart` in TypeScript afterwards, which is the
 * single source of truth for bucket boundaries.
 */
function tooltipBucketExpression(granularity: KlineGranularity): string {
  switch (granularity) {
    case 'week':
      // Monday start: %w is 0=Sunday, so Sunday walks back six days.
      return `date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER) + 6) % 7) || ' days')`
    case 'month':
      return `date(t.date, 'start of month')`
    case 'quarter':
      return `date(t.date, 'start of month', '-' || ((CAST(strftime('%m', t.date) AS INTEGER) - 1) % 3) || ' months')`
    case 'year':
      return `strftime('%Y-01-01', t.date)`
    case 'day':
    default:
      return 't.date'
  }
}

/** Per-currency subtotals inside one bucket, in ORIGINAL minor units. */
interface CurrencySubtotal {
  income: number
  expense: number
}

/** One day on which something happened, with the balance it produced. */
interface ActivityDay {
  date: DateString
  /** Converted total balance at the END of this day, display minor units. */
  balanceAfter: number
  income: Map<string, number>
  expense: Map<string, number>
  /** Income + expense rows that day. Transfers are not counted. */
  count: number
  /**
   * This day's income/expense as the first difference of the rounded cumulative
   * curve, in display minor units. Summing these over any run of days yields that
   * run's single-rounding total — see the module header.
   */
  incomeRounded: number
  expenseRounded: number
  /** True when a currency transacted on this day had no usable rate. */
  hasUnconverted: boolean
}

/**
 * Balance history as a candle series.
 *
 * `ratesProvider` is injected rather than read from the exchange service so the
 * chart can be tested against a fixed table and so a rates failure degrades to
 * "unconverted" instead of taking the chart down with it.
 */
export class KlineService {
  constructor(
    private readonly db: SqliteDatabase,
    /** Reads the cached rate table. Injected so tests never touch the network. */
    private readonly ratesProvider: () => RateTable | null = () => null
  ) {}

  private rates(): RateTable | null {
    try {
      return this.ratesProvider()
    } catch {
      // Same rule as StatisticsService: an unavailable rate table must not throw
      // out of a read path. Figures fall back to unconverted and the series is
      // flagged, which the UI can explain.
      return null
    }
  }

  /**
   * The full balance/flow series.
   *
   * `granularity: 'auto'` picks a candle size from the span of recorded history;
   * pass an explicit one to override. `maWindows` defaults to
   * `DEFAULT_MA_WINDOWS`.
   */
  series(
    displayCurrency: string,
    granularity: KlineGranularity | 'auto' = 'auto',
    maWindows: number[] = [...DEFAULT_MA_WINDOWS]
  ): KlineSeries {
    const rates = this.rates()
    const currency = String(displayCurrency || 'CNY').toUpperCase()
    const displayScale = minorUnitScale(currency)
    const windows = normaliseMaWindows(maWindows)

    // The rate is looked up per currency, never per transaction: one conversion
    // per currency subtotal keeps the single-rounding rule intact.
    const rateOf = (code: string): number | null =>
      code.toUpperCase() === currency ? 1 : lookupRate(rates, code, currency)

    // Archived accounts are excluded, matching readBalancesWithConversion and the
    // accounts page. Leaving them in would make the chart's last candle disagree
    // with the balance the user sees everywhere else in the app.
    const accounts = this.db
      .prepare('SELECT id, currency, opening_balance FROM accounts WHERE archived = 0')
      .all() as Array<{ id: number; currency: string; opening_balance: number }>

    // The y-axis baseline. It is the sum of the accounts' opening balances, not
    // zero: the money existed before the first recorded transaction.
    let openingMajor = 0
    let balanceIncomplete = false
    for (const account of accounts) {
      const rate = rateOf(account.currency)
      if (rate === null) {
        balanceIncomplete = true
        continue
      }
      openingMajor += (account.opening_balance / minorUnitScale(account.currency)) * rate
    }
    const openingBalance = Math.round(openingMajor * displayScale)

    // ONE aggregate for the whole history, keyed by (day, account) so the running
    // balance can be built per account — the unit a balance is actually converted
    // in. `delta` includes transfers, `income`/`expense` deliberately do not.
    const dailyRows = this.db
      .prepare(
        `SELECT
           t.date AS date,
           t.account_id AS account_id,
           a.currency AS currency,
           COALESCE(SUM(t.amount), 0) AS delta,
           COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expense,
           COALESCE(SUM(CASE WHEN t.type IN ('income','expense') THEN 1 ELSE 0 END), 0) AS tx_count
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.archived = 0
         GROUP BY t.date, t.account_id
         ORDER BY t.date ASC`
      )
      .all() as Array<{
      date: string
      account_id: number
      currency: string
      delta: number
      income: number
      expense: number
      tx_count: number
    }>

    if (dailyRows.length === 0) {
      // No history at all. An empty series is the honest answer: one synthetic
      // candle at the opening balance would invent a data point the user never
      // recorded, and the UI needs an empty-series state regardless.
      return {
        granularity: isKlineGranularity(granularity) ? granularity : chooseGranularity(0),
        points: [],
        daily: [],
        dayMarkers: {},
        maWindows: windows,
        currency,
        from: '',
        to: '',
        openingBalance,
        hasUnconverted: balanceIncomplete,
        maReadyFrom: maReadyKeys(windows, [])
      }
    }

    const running = new Map<number, number>()
    for (const account of accounts) running.set(account.id, account.opening_balance)

    // Cumulative per-currency income/expense, in each currency's OWN minor units.
    // Kept cumulative rather than per-day because the converted flow figures are
    // emitted as differences of a rounded running total; see the module header for
    // why that is what makes a rolled-up week agree with the week's own total.
    const cumulativeIncome = new Map<string, number>()
    const cumulativeExpense = new Map<string, number>()
    let previousCumulativeIncome = 0
    let previousCumulativeExpense = 0

    // The same one-rounding rule for the flows, applied to a running total rather
    // than to a single bucket. A currency with no rate is dropped from the running
    // total AND flagged: it is never added at a rate of 1.
    const convertRunningTotal = (subtotals: Map<string, number>): number => {
      let major = 0
      for (const [code, value] of subtotals) {
        const rate = rateOf(code)
        if (rate === null) continue
        major += (value / minorUnitScale(code)) * rate
      }
      return Math.round(major * displayScale)
    }

    const activity: ActivityDay[] = []
    let rowIndex = 0
    while (rowIndex < dailyRows.length) {
      const date = dailyRows[rowIndex].date
      const income = new Map<string, number>()
      const expense = new Map<string, number>()
      let count = 0

      while (rowIndex < dailyRows.length && dailyRows[rowIndex].date === date) {
        const row = dailyRows[rowIndex]
        running.set(row.account_id, (running.get(row.account_id) ?? 0) + row.delta)
        if (row.income !== 0) income.set(row.currency, (income.get(row.currency) ?? 0) + row.income)
        // Expenses are stored negative; carry a positive magnitude.
        if (row.expense !== 0) expense.set(row.currency, (expense.get(row.currency) ?? 0) + Math.abs(row.expense))
        count += row.tx_count
        rowIndex += 1
      }

      for (const [code, value] of income) cumulativeIncome.set(code, (cumulativeIncome.get(code) ?? 0) + value)
      for (const [code, value] of expense) cumulativeExpense.set(code, (cumulativeExpense.get(code) ?? 0) + value)

      // Convert each ACCOUNT's balance once and add the major-unit results, then
      // round a single time. This is the trap requirement of the whole feature:
      // summing the converted flows above would give a number that drifts from
      // the accounts page by a cent per row, and no amount of later rounding
      // repairs an error that was introduced before the sum.
      let dayMajor = 0
      for (const account of accounts) {
        const rate = rateOf(account.currency)
        if (rate === null) {
          balanceIncomplete = true
          continue
        }
        const balance = running.get(account.id) ?? 0
        dayMajor += (balance / minorUnitScale(account.currency)) * rate
      }

      let unconvertedToday = false
      for (const code of income.keys()) if (rateOf(code) === null) unconvertedToday = true
      for (const code of expense.keys()) if (rateOf(code) === null) unconvertedToday = true

      const cumulativeIncomeRounded = convertRunningTotal(cumulativeIncome)
      const cumulativeExpenseRounded = convertRunningTotal(cumulativeExpense)

      activity.push({
        date,
        balanceAfter: Math.round(dayMajor * displayScale),
        income,
        expense,
        count,
        incomeRounded: cumulativeIncomeRounded - previousCumulativeIncome,
        expenseRounded: cumulativeExpenseRounded - previousCumulativeExpense,
        hasUnconverted: unconvertedToday
      })

      previousCumulativeIncome = cumulativeIncomeRounded
      previousCumulativeExpense = cumulativeExpenseRounded
    }

    const firstDate = activity[0].date
    const lastDate = activity[activity.length - 1].date
    const spanDays = inclusiveDays(firstDate, lastDate)
    const resolved: KlineGranularity = isKlineGranularity(granularity) ? granularity : chooseGranularity(spanDays)

    // Every bucket from the first to the last, including the empty ones. A gap
    // would be drawn as a straight line across a period the user had no activity
    // in, which reads as "nothing happened" instead of "the chart is missing a
    // bucket" — and it would also shift every MA window by the missing count.
    const firstKey = bucketStart(firstDate, resolved)
    const lastKey = bucketStart(lastDate, resolved)
    const bucketKeys: string[] = []
    for (let key = firstKey; key <= lastKey; key = nextBucketKey(key, resolved)) {
      bucketKeys.push(key)
    }

    const { transactions: tooltips, markers, dayMarkers, dayExtremes } = this.readTooltipTransactions(
      resolved,
      firstKey,
      lastDate,
      currency,
      rateOf,
      openingBalance
    )

    const points: KlinePoint[] = []
    let cursor = 0
    let carry = openingBalance

    // Flows travel as a rounded running total. A bucket's figure is the difference
    // between the total at its two edges, which is what makes the sum of its days
    // — and therefore any zoomed roll-up — agree with it exactly.
    let runningIncome = 0
    let runningExpense = 0

    for (const key of bucketKeys) {
      const nextKey = nextBucketKey(key, resolved)
      const open = carry
      const incomeAtStart = runningIncome
      const expenseAtStart = runningExpense
      const byCurrency = new Map<string, CurrencySubtotal>()
      let count = 0
      let unconvertedInBucket = false

      // `pendingFrom` tracks the first day of the bucket whose end-of-day balance
      // has not been accounted for yet. Between two activity days every day ends
      // at the same carried value, so one comparison covers the whole gap without
      // iterating empty days.
      let pendingFrom = key
      let high = Number.NEGATIVE_INFINITY
      let low = Number.POSITIVE_INFINITY

      while (cursor < activity.length && activity[cursor].date < nextKey) {
        const day = activity[cursor]
        if (day.date > pendingFrom) {
          if (carry > high) high = carry
          if (carry < low) low = carry
        }
        carry = day.balanceAfter
        if (carry > high) high = carry
        if (carry < low) low = carry
        pendingFrom = addDays(day.date, 1)

        for (const [code, value] of day.income) {
          const entry = byCurrency.get(code) ?? { income: 0, expense: 0 }
          entry.income += value
          byCurrency.set(code, entry)
        }
        for (const [code, value] of day.expense) {
          const entry = byCurrency.get(code) ?? { income: 0, expense: 0 }
          entry.expense += value
          byCurrency.set(code, entry)
        }
        if (day.hasUnconverted) unconvertedInBucket = true
        runningIncome += day.incomeRounded
        runningExpense += day.expenseRounded
        count += day.count
        cursor += 1
      }

      // The bucket's tail — including the whole bucket when nothing happened in
      // it — ends at the carried balance, which is also its close.
      if (carry > high) high = carry
      if (carry < low) low = carry
      const close = carry

      /*
        Fold the INTRADAY extremes in.

        The walk above only ever sees end-of-day balances, so without this step a
        candle whose salary arrived at 09:00 and was spent by 20:00 would report
        High = max(open, close) and Low = min(open, close) — hiding the peak the chart
        exists to show and making the day look like it barely moved.

        A bucket's true range is the highest and lowest balance the accounts held at
        any point inside it, which is the finest granularity the data has: each day's
        own extremes, themselves derived from the balance after every transaction.
      */
      for (let d = key; d < nextKey; d = addDays(d, 1)) {
        const extreme = dayExtremes.get(d)
        if (!extreme) continue
        if (extreme.high > high) high = extreme.high
        if (extreme.low < low) low = extreme.low
      }

      const income = runningIncome - incomeAtStart
      const expense = runningExpense - expenseAtStart
      const hasUnconverted = balanceIncomplete || unconvertedInBucket
      const sources: KlinePoint['sources'] = []

      for (const code of [...byCurrency.keys()].sort()) {
        const entry = byCurrency.get(code) as CurrencySubtotal
        sources.push({
          currency: code,
          income: entry.income,
          expense: entry.expense,
          net: entry.income - entry.expense
        })
      }

      points.push({
        date: key,
        label: bucketLabel(key, resolved),
        balanceClose: close,
        balanceOpen: open,
        balanceHigh: Number.isFinite(high) ? high : close,
        balanceLow: Number.isFinite(low) ? low : close,
        income,
        expense,
        // Derived from the already-rounded halves so the net always equals what
        // the two bars show; recomputing it from the floats can differ by a cent.
        net: income - expense,
        transactionCount: count,
        hasUnconverted,
        ma: {},
        deltaBalance: close - open,
        /*
          Measured against THIS bucket's opening balance, not the series'.

          The header shows "net change" next to the bucket the cursor is on, so the
          denominator has to be where that bucket started — otherwise a day's ¥5 gain
          would be reported as a fraction of the balance ten years ago and read as 0%.
          Null when the bucket opened at nothing: "up 100% from zero" is not a number
          anyone can act on.
        */
        changeRatio: open !== 0 ? (close - open) / open : null,
        sources,
        transactions: tooltips.get(key) ?? [],
        markers: markers.get(key) ?? []
      })
    }

    // Every day, gapless, for the zoom path. `daily` is bounded by the calendar
    // span rather than by the transaction count — a 10-year ledger is ~3,650
    // entries — and carries no per-transaction payload, which stays on `points`.
    const daily: KlineDaily[] = []
    let dayCursor = 0
    let dayOpen = openingBalance
    for (let date = firstKey; date <= lastDate; date = addDays(date, 1)) {
      // The activity list is walked in lockstep with the calendar: every date
      // between the first and last activity day is visited exactly once, so the
      // cursor can never stall on a date that was skipped.
      const entry = dayCursor < activity.length && activity[dayCursor].date === date ? activity[dayCursor] : null
      if (entry) dayCursor += 1

      const close = entry ? entry.balanceAfter : dayOpen
      const income = entry ? entry.incomeRounded : 0
      const expense = entry ? entry.expenseRounded : 0
      const dailyExtreme = dayExtremes.get(date)

      daily.push({
        // The wick is the day's true intraday range, from the balance after each
        // transaction. A day with a morning salary and an evening spend genuinely
        // reaches higher than either its open or its close, and the candle has to say
        // so — that peak is the whole reason to look at a candle chart of a balance.
        date,
        label: bucketLabel(date, 'day'),
        balanceOpen: dayOpen,
        balanceClose: close,
        balanceHigh: dailyExtreme ? Math.max(dailyExtreme.high, dayOpen, close) : Math.max(dayOpen, close),
        balanceLow: dailyExtreme ? Math.min(dailyExtreme.low, dayOpen, close) : Math.min(dayOpen, close),
        // Zero on a day with no activity: the cumulative curve did not move, so
        // its first difference is zero. No special case, and no drift.
        income,
        expense,
        net: income - expense,
        transactionCount: entry ? entry.count : 0,
        hasUnconverted: balanceIncomplete || (entry !== null && entry.hasUnconverted)
      })

      dayOpen = close
    }

    const averages = movingAverages(
      points.map((point) => point.balanceClose),
      windows
    )
    points.forEach((point, index) => {
      point.ma = averages[index]
    })

    return {
      granularity: resolved,
      points,
      daily,
      dayMarkers,
      maWindows: windows,
      currency,
      from: firstKey,
      // The last day with data, not the last bucket's end: a bucket can extend
      // past today (the current month does), and a range readout of "1 Sep –
      // 31 Dec" would claim data the user has not lived yet.
      to: lastDate,
      openingBalance,
      hasUnconverted: balanceIncomplete || points.some((point) => point.hasUnconverted),
      maReadyFrom: maReadyKeys(windows, points)
    }
  }

  /**
   * Per-bucket tooltip rows, in one query.
   *
   * Capped per bucket in SQL with ROW_NUMBER() rather than by fetching everything
   * and slicing in memory: a 20,000-row ledger would otherwise cross the IPC
   * bridge in full to render a hover card. The partition expression is the
   * bucket's own start date, computed with SQLite's date functions; the rows are
   * then grouped in TypeScript by `bucketStart`, so a disagreement between the two
   * could only ever cost a few rows of the cap, never misfiled data.
   */
  private readTooltipTransactions(
    granularity: KlineGranularity,
    from: DateString,
    to: DateString,
    displayCurrency: string,
    /**
     * The series' own rate rule, passed in rather than re-derived.
     *
     * It matters: `lookupRate` returns null for ANY pair when no table exists,
     * including a currency against itself, while the series (like
     * `combineCurrencyTotals`) converts an account in the display currency at 1
     * with no table at all. Re-deriving the rule here made a CNY row report
     * "no rate available" next to a CNY total that had been converted — two
     * answers to one question on the same tooltip.
     */
    rateOf: (code: string) => number | null,
    /**
     * The converted total of every account before the first transaction in range.
     *
     * Passed in so the marker walk starts from the same number the candle's first
     * Open is built from. Deriving it here instead would create a second definition
     * of "opening balance", and the two would eventually disagree.
     */
    openingBalance: number
  ): {
    transactions: Map<string, KlineTransaction[]>
    markers: Map<string, CashflowTransactionMarker[]>
    /** The same markers keyed by DAY, for a view that re-buckets locally. */
    dayMarkers: Record<string, CashflowTransactionMarker[]>
    /** True intraday balance extremes per day, from the marker walk. */
    dayExtremes: Map<string, { high: number; low: number }>
  } {
    const rows = this.db
      .prepare(
        `SELECT id, date, time, type, amount, currency, account_name, category_name, category_color, merchant, note
         FROM (
           SELECT
             t.id AS id, t.date AS date, t.time AS time, t.type AS type, t.amount AS amount,
             a.currency AS currency, a.name AS account_name,
             c.name AS category_name, c.color AS category_color,
             t.merchant AS merchant, t.note AS note,
             ROW_NUMBER() OVER (
               PARTITION BY ${tooltipBucketExpression(granularity)}
               ORDER BY t.date ASC, COALESCE(t.time, '') ASC, t.id ASC
             ) AS rn
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE t.type IN ('income','expense') AND a.archived = 0 AND t.date >= ? AND t.date <= ?
         )
         WHERE rn <= ?
         ORDER BY date ASC, COALESCE(time, '') ASC, id ASC`
      )
      .all(from, to, KLINE_MAX_TRANSACTIONS_PER_BUCKET) as Array<{
      id: number
      date: string
      time: string | null
      type: string
      amount: number
      currency: string
      account_name: string
      category_name: string | null
      category_color: string | null
      merchant: string | null
      note: string | null
    }>

    /**
     * Every entry that moves a balance, in ledger order, uncapped.
     *
     * SEPARATE FROM THE QUERY ABOVE, and it has to be:
     *   - transfers are included, because a transfer leg moves the balance of its
     *     own account even though it is not income or expense — leaving it out would
     *     shift every later marker on that day by the transfer amount;
     *   - `created_at` joins the sort key, so two entries at the same minute are
     *     ordered the way they were entered rather than by a tie-break nobody can
     *     observe;
     *   - it is not capped. The cap on tooltip rows is a rendering decision; dropping
     *     a marker is a correctness one.
     */
    const flowRows = this.db
      .prepare(
        `SELECT t.id AS id, t.date AS date, t.time AS time, t.type AS type, t.amount AS amount,
                a.currency AS currency, a.name AS account_name,
                c.name AS category_name, c.color AS category_color,
                t.merchant AS merchant, t.note AS note
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.type IN ('income','expense','transfer') AND a.archived = 0
           AND t.date >= ? AND t.date <= ?
         ORDER BY t.date ASC, COALESCE(t.time, '') ASC, t.created_at ASC, t.id ASC`
      )
      .all(from, to) as Array<{
      id: number
      date: string
      time: string | null
      type: string
      amount: number
      currency: string
      account_name: string
      category_name: string | null
      category_color: string | null
      merchant: string | null
      note: string | null
    }>

    const displayScale = minorUnitScale(displayCurrency)
    const conversion = new Map<string, number | null>()

    const rateFor = (code: string): number | null => {
      let rate = conversion.get(code)
      if (rate === undefined) {
        rate = rateOf(code)
        conversion.set(code, rate)
      }
      return rate
    }

    const magnitudeMinor = (row: { amount: number; currency: string }): number => Math.abs(row.amount)
    const toDisplay = (row: { amount: number; currency: string }): number | null => {
      const rate = rateFor(row.currency)
      if (rate === null) return null
      return Math.round((magnitudeMinor(row) / minorUnitScale(row.currency)) * rate * displayScale)
    }

    const byBucket = new Map<string, KlineTransaction[]>()
    for (const row of rows) {
      const key = bucketStart(row.date, granularity)
      const entry: KlineTransaction = {
        id: row.id,
        date: row.date,
        time: row.time,
        type: row.type === 'income' ? 'income' : 'expense',
        amount: magnitudeMinor(row),
        currency: row.currency,
        convertedAmount: toDisplay(row),
        categoryName: row.category_name,
        categoryColor: row.category_color,
        merchant: row.merchant,
        accountName: row.account_name,
        note: row.note
      }

      const bucket = byBucket.get(key)
      if (bucket) bucket.push(entry)
      else byBucket.set(key, [entry])
    }

    /**
     * Position each entry on the balance curve.
     *
     * ANCHORED PER DAY, not accumulated across the whole range, and that is the
     * important part. Two ways to place a marker were tried:
     *
     *   1. Convert each transaction and sum the results across the entire history.
     *      Rejected: converting many small amounts and adding them drifts from
     *      converting each account's balance, because every conversion rounds. Two
     *      existing tests caught it — a bucket reported Low 8605 while its own days
     *      reported 8604 — and the drift grows with the number of transactions, so the
     *      markers would slowly slide off the candle they belong to.
     *   2. Re-anchor at each day's true opening balance, then accumulate only WITHIN
     *      that day.
     *
     * This is the second. The day's open and close come from the same per-account
     * conversion the candle's own open and close use, so a day's first marker starts
     * exactly on the candle's open and its last marker lands within one minor unit
     * per leg of the close — a bounded error confined to one day, which cannot
     * accumulate into a marker floating above or below its own candle.
     */
    const days = this.readDailyBalances(from, to, displayCurrency, rateOf)
    const openByDay = new Map<string, number>()
    for (const day of days) openByDay.set(day.date, day.balanceOpen)

    const markers = new Map<string, CashflowTransactionMarker[]>()
    /*
      The same entries keyed by their own DAY.

      `markers` above is partitioned by the bucket the caller asked for, which makes
      it useless to a chart that re-buckets locally: at week granularity every entry
      of the week sits under the week's Monday, so zooming into a single Tuesday finds
      nothing. The renderer's continuous zoom changes bucket size on every wheel
      notch, so it needs the day key — and shipping it here costs one extra map on a
      payload that is already bounded by the transaction count.
    */
    const dayMarkers: Record<string, CashflowTransactionMarker[]> = {}

    /*
      True daily extremes, accumulated in the same pass that positions the markers.

      A day used to be the finest period the series modelled, so its wick had nowhere
      to go and `balanceHigh === balanceLow === close`. Markers gave every day an
      internal sequence, so that is no longer true: a salary at 09:00 and lunch at
      12:00 make the day's high the salary peak rather than the close.

      Computing it here — from the very numbers the markers are drawn at — keeps ONE
      definition of a day's range, shared by the `points` wicks, the zoom-rebuilt
      `daily` rows and the chart's `bucketDaily`. Deriving it twice is how a
      zoomed-in candle ends up disagreeing with the candle it was built from.
    */
    const dayExtremes = new Map<string, { high: number; low: number }>()
    let dayCursor = ''
    let dayHigh = 0
    let dayLow = 0

    const closeDay = (): void => {
      if (dayCursor === '') return
      dayExtremes.set(dayCursor, { high: dayHigh, low: dayLow })
    }

    let running = openingBalance
    let currentDay = ''

    for (const row of flowRows) {
      const key = bucketStart(row.date, granularity)

      // Entering a new day: jump to that day's real opening balance rather than
      // trusting the accumulated total, and start a fresh extreme range.
      if (row.date !== currentDay) {
        closeDay()
        currentDay = row.date
        const dayOpen = openByDay.get(row.date)
        if (dayOpen !== undefined) running = dayOpen
        dayCursor = row.date
        dayHigh = running
        dayLow = running
      }

      const delta = toDisplay(row)
      const signed =
        delta === null ? null : row.type === 'expense' ? -delta : row.type === 'income' ? delta : 0

      const after = signed === null ? null : running + signed

      const entry: CashflowTransactionMarker = {
        transactionId: row.id,
        time: row.time,
        type: row.type === 'income' ? 'income' : row.type === 'expense' ? 'expense' : 'transfer',
        amount: magnitudeMinor(row),
        currency: row.currency,
        convertedDelta: signed,
        // Both are left null for an unconvertible entry rather than being pinned to
        // the running total: a marker drawn where the money is not is worse than a
        // marker that is simply absent.
        balanceBefore: signed === null ? null : running,
        balanceAfter: after,
        merchant: row.merchant,
        categoryName: row.category_name,
        categoryColor: row.category_color,
        accountName: row.account_name,
        note: row.note
      }

      const bucket = markers.get(key)
      if (bucket) bucket.push(entry)
      else markers.set(key, [entry])

      const day = dayMarkers[row.date]
      if (day) day.push(entry)
      else dayMarkers[row.date] = [entry]

      if (after !== null) {
        if (after > dayHigh) dayHigh = after
        if (after < dayLow) dayLow = after
        running = after
      }
    }
    closeDay()

    return { transactions: byBucket, markers, dayMarkers, dayExtremes }
  }

  /**
   * Per-day opening and closing balances, converted, for the marker anchors.
   *
   * A narrow read of the same thing the main series walk builds, kept separate
   * because the marker walk needs one number per day and must not depend on the
   * bucketing that walk is doing at the same time.
   */
  private readDailyBalances(
    from: DateString,
    to: DateString,
    displayCurrency: string,
    rateOf: (code: string) => number | null
  ): Array<{ date: string; balanceOpen: number; balanceClose: number }> {
    /*
      `SUM(t.amount)` and nothing cleverer.

      Amounts are stored SIGNED — an expense row holds a negative minor-unit value —
      which is exactly how the main series walk reads them. Writing the sign into this
      query instead (`CASE WHEN type = 'expense' THEN -amount`) double-negates every
      expense; that bug flipped the entire balance curve and was caught only because a
      debug run printed a marker balance of +549 where the answer was -549.
    */
    const rows = this.db
      .prepare(
        `SELECT t.date AS date, a.currency AS currency, a.id AS account_id,
                COALESCE(SUM(t.amount), 0) AS delta
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         WHERE a.archived = 0 AND t.date >= ? AND t.date <= ?
         GROUP BY t.date, a.id
         ORDER BY t.date ASC`
      )
      .all(from, to) as Array<{ date: string; currency: string; account_id: number; delta: number }>

    const displayScale = minorUnitScale(displayCurrency)
    const byDay = new Map<string, number>()
    for (const row of rows) {
      const rate = rateOf(row.currency)
      if (rate === null) continue
      const converted = Math.round((row.delta / minorUnitScale(row.currency)) * rate * displayScale)
      byDay.set(row.date, (byDay.get(row.date) ?? 0) + converted)
    }

    const days: Array<{ date: string; balanceOpen: number; balanceClose: number }> = []
    let balance = this.openingBalanceIn(from, displayCurrency, rateOf)
    for (const [date, delta] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const open = balance
      balance += delta
      days.push({ date, balanceOpen: open, balanceClose: balance })
    }
    return days
  }

  /** Converted total of every account before `from`. */
  private openingBalanceIn(
    from: DateString,
    displayCurrency: string,
    rateOf: (code: string) => number | null
  ): number {
    // Signed sum, matching the ledger and the series walk — see readDailyBalances.
    const rows = this.db
      .prepare(
        `SELECT a.currency AS currency, a.opening_balance AS opening_balance,
                COALESCE(SUM(t.amount), 0) AS delta
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id AND t.date < ?
         WHERE a.archived = 0
         GROUP BY a.id`
      )
      .all(from) as Array<{ currency: string; opening_balance: number; delta: number }>

    const displayScale = minorUnitScale(displayCurrency)
    let total = 0
    for (const row of rows) {
      const rate = rateOf(row.currency)
      if (rate === null) continue
      const balance = row.opening_balance + row.delta
      total += Math.round((balance / minorUnitScale(row.currency)) * rate * displayScale)
    }
    return total
  }
}
