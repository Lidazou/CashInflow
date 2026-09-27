import { instantOf } from './chart-time'
import type { CashflowTransactionMarker, KlineBucket, KlineGranularity } from '@shared/types'

/**
 * Daily Cash Activity — the derived data behind the lower chart panel (v1.6.0).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The balance K-line answers "where is my money going". This answers a different
 * question — "what did today's money actually consist of" — and the two must not be
 * mixed, because a balance is a STOCK (one number per day, meaningful at any height)
 * while a day's activity is a FLOW made of individual, labelled events.
 *
 * So every day becomes exactly ONE column, and that column is a stack of its own
 * transactions, each sized by `amount / columnTotal`. Nothing here invents geometry:
 * the proportions are the real ones, so a RM 400 dinner is exactly twice the height of
 * a RM 200 shop.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * -------------------------------
 *   - No X position per transaction. Time orders the stack; it never becomes a
 *     coordinate. The x axis is days and only days.
 *   - No average or fixed segment heights, and no "one segment per transaction
 *     because there were five of them".
 *   - No pixel maths. Everything below is in minor units and day keys, which is what
 *     makes a RM 1 segment inside a RM 10,000 column selectable: hit testing measures
 *     against the DATA, not against the two tenths of a pixel it happens to occupy.
 *   - No database writes. This is derived, and it is rebuilt from the day markers the
 *     K-line service already ships.
 *
 * The one place pixels appear is `columnTotals`, and only so the caller can decide
 * whether a column is wide enough to draw its labels — never to decide what is there.
 */

/** Which series the lower panel draws. All five share one crosshair (spec §21). */
export type ActivityViewMode = 'stack' | 'net' | 'incomeExpense' | 'cumulative' | 'category'

export const ACTIVITY_VIEW_MODES: readonly ActivityViewMode[] = [
  'stack',
  'net',
  'incomeExpense',
  'cumulative',
  'category'
]

/** Direction of a value inside a column. Bars are income up, expense down. */
export type ActivityDirection = 'income' | 'expense'

/**
 * One transaction as a stackable, hit-testable segment.
 *
 * `startAmount`/`endAmount` are the segment's cumulative range measured from the zero
 * baseline in ITS OWN direction, in display-currency minor units. They are the whole
 * reason a segment smaller than a pixel is still selectable: the crosshair converts
 * the pointer's height into an amount and looks the amount up in this range.
 */
export interface ActivitySegment {
  /** Ledger id, unique inside a column. Doubles as the click-through target. */
  transactionId: number
  /** The day the transaction happened on. Always a day, even inside a week column. */
  date: string
  time: string | null
  type: ActivityDirection
  /** Converted magnitude in display minor units, always >= 0. */
  amount: number
  /** The same magnitude in the ledger's own currency, for the honest "original" line. */
  originalAmount: number
  currency: string
  /** True when no rate existed, so `amount` is the unconverted magnitude. */
  unconverted: boolean
  merchant: string | null
  categoryId: number | null
  categoryName: string | null
  categoryColor: string | null
  accountName: string
  note: string | null
  /** Cumulative range inside the column, from zero, in this segment's direction. */
  startAmount: number
  endAmount: number
  /** `amount / (columnTotal for this direction)`, in 0..1. */
  percentage: number
  /** 1-based position in ledger order inside the column, and how many there are. */
  index: number
  count: number
}

/** A category roll-up inside one column, for the category view and the tooltip. */
export interface ActivityCategoryTotal {
  /** Category name, or the '—' bucket for uncategorised rows. */
  key: string
  categoryId: number | null
  color: string | null
  type: ActivityDirection
  amount: number
  count: number
}

/** One x-axis unit — a day at day zoom, a week or a month once zoomed out. */
export interface ActivityColumn {
  /** The column's x-axis key: its bucket's start date. */
  date: string
  /** Bucket start instant, in local epoch ms. The x axis is drawn on this. */
  instant: number
  /** Every day folded into this column, ascending. One entry at day granularity. */
  days: string[]
  totalIncome: number
  totalExpense: number
  netCashFlow: number
  /** Running sum of `netCashFlow` across the visible window. Filled by `withCumulative`. */
  cumulativeCashFlow: number
  /** Segments in ledger order, already split by direction. */
  income: ActivitySegment[]
  expense: ActivitySegment[]
  /** Category roll-ups, largest first. */
  categories: ActivityCategoryTotal[]
  /** Transfers inside this column: balance-moving, never income or expense. */
  transferCount: number
  transactionCount: number
  hasUnconverted: boolean
}

/** A day's transactions, keyed by day, as the K-line service ships them. */
export type DayMarkerMap = Record<string, CashflowTransactionMarker[]>

/**
 * Ledger order inside a day: timestamp ascending, then the order the rows were entered.
 *
 * WHY UNTIMED ENTRIES GO LAST rather than first
 * ---------------------------------------------
 * The input array is already in `(date, time, created_at, id)` order from the service,
 * so "entered order" is simply the order they arrive in. A row with no recorded time is
 * a row that says "somewhere in this day", and putting it at the bottom of the stack
 * keeps the timed part of the day in true chronological order instead of pretending the
 * untimed row happened at midnight. `tests/daily-activity.test.ts` pins this.
 */
export function orderDayMarkers(markers: readonly CashflowTransactionMarker[]): CashflowTransactionMarker[] {
  const timed: CashflowTransactionMarker[] = []
  const untimed: CashflowTransactionMarker[] = []
  for (const marker of markers) {
    if (marker.time === null) untimed.push(marker)
    else timed.push(marker)
  }
  timed.sort((a, b) => (a.time as string).localeCompare(b.time as string) || a.transactionId - b.transactionId)
  return [...timed, ...untimed]
}

/** Magnitude of a marker on the converted axis, or its own units when no rate existed. */
export function markerMagnitude(marker: CashflowTransactionMarker): { amount: number; unconverted: boolean } {
  if (marker.convertedDelta === null) return { amount: Math.abs(marker.amount), unconverted: true }
  return { amount: Math.abs(marker.convertedDelta), unconverted: false }
}

/**
 * Build the segments of one direction inside one column.
 *
 * The percentages are taken against the direction's own total, which is what the reader
 * is looking at: the expense stack always sums to exactly 100%, so "40%" on the dinner
 * segment means 40% of what left the account that day, not 40% of some mixed total.
 */
export function buildSegments(
  entries: ReadonlyArray<{ marker: CashflowTransactionMarker; date: string }>,
  type: ActivityDirection
): ActivitySegment[] {
  const rows = entries
    .filter((entry) => entry.marker.type === type)
    .sort((a, b) => {
      const at = a.marker.time
      const bt = b.marker.time
      if (at === null && bt === null) return a.marker.transactionId - b.marker.transactionId
      if (at === null) return 1
      if (bt === null) return -1
      return at.localeCompare(bt) || a.marker.transactionId - b.marker.transactionId
    })

  const total = rows.reduce((sum, entry) => sum + markerMagnitude(entry.marker).amount, 0)
  let running = 0
  return rows.map((entry, index) => {
    const { amount, unconverted } = markerMagnitude(entry.marker)
    const startAmount = running
    running += amount
    return {
      transactionId: entry.marker.transactionId,
      date: entry.date,
      time: entry.marker.time,
      type,
      amount,
      originalAmount: Math.abs(entry.marker.amount),
      currency: entry.marker.currency,
      unconverted,
      merchant: entry.marker.merchant,
      categoryId: entry.marker.categoryId ?? null,
      categoryName: entry.marker.categoryName,
      categoryColor: entry.marker.categoryColor,
      accountName: entry.marker.accountName,
      note: entry.marker.note,
      startAmount,
      endAmount: running,
      // A column whose total is zero has no proportion to speak of; 0 is the truthful
      // answer and the segment is not drawn anyway.
      percentage: total > 0 ? amount / total : 0,
      index: index + 1,
      count: rows.length
    }
  })
}

/** Category roll-up for one column, largest first, ties broken by name for stability. */
export function rollUpCategories(
  segments: readonly ActivitySegment[]
): ActivityCategoryTotal[] {
  const map = new Map<string, ActivityCategoryTotal>()
  for (const segment of segments) {
    const key = segment.categoryName ?? '\u2014'
    const existing = map.get(`${segment.type}:${key}`)
    if (existing) {
      existing.amount += segment.amount
      existing.count += 1
      continue
    }
    map.set(`${segment.type}:${key}`, {
      key,
      categoryId: segment.categoryId,
      color: segment.categoryColor,
      type: segment.type,
      amount: segment.amount,
      count: 1
    })
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key))
}

/**
 * One column per bucket.
 *
 * `days` comes from the bucket list the chart is already drawing, so the activity panel
 * and the candles can never disagree about which days are on screen. Transfers are
 * counted but never stacked: moving your own money between accounts is not income, and
 * a stack that included it would make a day look like it earned what it merely moved.
 */
export function buildColumn(
  bucket: Pick<KlineBucket, 'date' | 'income' | 'expense' | 'net' | 'transactionCount' | 'hasUnconverted'>,
  days: readonly string[],
  dayMarkers: DayMarkerMap
): ActivityColumn {
  const entries: Array<{ marker: CashflowTransactionMarker; date: string }> = []
  let transferCount = 0
  for (const day of days) {
    for (const marker of orderDayMarkers(dayMarkers[day] ?? [])) {
      if (marker.type === 'transfer') {
        transferCount += 1
        continue
      }
      entries.push({ marker, date: day })
    }
  }

  const income = buildSegments(entries, 'income')
  const expense = buildSegments(entries, 'expense')

  /*
    The totals prefer the segments when there are any, and fall back to the bucket's own
    figures when there are not.

    That fallback matters at coarse zoom: the service caps how many rows it ships for the
    tooltip payload, and a month whose transactions are not all present would otherwise
    report a total that is smaller than the candle above it claims. The bucket's income
    and expense come from the same query as the candle, so they are the authority; the
    segments are the composition.
  */
  const segmentIncome = income.reduce((sum, segment) => sum + segment.amount, 0)
  const segmentExpense = expense.reduce((sum, segment) => sum + segment.amount, 0)

  return {
    date: bucket.date,
    instant: instantOf(bucket.date, null),
    days: [...days],
    totalIncome: income.length > 0 ? Math.max(segmentIncome, 0) : bucket.income,
    totalExpense: expense.length > 0 ? Math.max(segmentExpense, 0) : bucket.expense,
    netCashFlow: bucket.net,
    cumulativeCashFlow: 0,
    income,
    expense,
    categories: rollUpCategories([...income, ...expense]),
    transferCount,
    transactionCount: bucket.transactionCount,
    hasUnconverted: bucket.hasUnconverted || income.some((s) => s.unconverted) || expense.some((s) => s.unconverted)
  }
}

/** Fill `cumulativeCashFlow` across the visible window. */
export function withCumulative(columns: readonly ActivityColumn[]): ActivityColumn[] {
  let running = 0
  return columns.map((column) => {
    running += column.netCashFlow
    return { ...column, cumulativeCashFlow: running }
  })
}

/**
 * Build the columns for a list of buckets, sub-day days and all.
 *
 * The day list for a coarse bucket is derived by walking the daily spine, so a week
 * column contains exactly the days the K-line drew inside that week — not a calendar
 * guess that could include a day the ledger never had.
 */
export function buildColumns(
  buckets: ReadonlyArray<Pick<KlineBucket, 'date'> & Partial<KlineBucket>>,
  daily: ReadonlyArray<Pick<KlineBucket, 'date'>>,
  dayMarkers: DayMarkerMap,
  granularity: KlineGranularity
): ActivityColumn[] {
  const daysByBucket = groupDays(buckets, daily, granularity)
  const columns = buckets.map((bucket, index) =>
    buildColumn(
      {
        date: bucket.date,
        income: bucket.income ?? 0,
        expense: bucket.expense ?? 0,
        net: bucket.net ?? 0,
        transactionCount: bucket.transactionCount ?? 0,
        hasUnconverted: bucket.hasUnconverted ?? false
      },
      daysByBucket[index],
      dayMarkers
    )
  )
  return withCumulative(columns)
}

/** The day keys falling inside each bucket, ascending. One bucket's worth per bucket. */
export function groupDays(
  buckets: ReadonlyArray<Pick<KlineBucket, 'date'>>,
  daily: ReadonlyArray<Pick<KlineBucket, 'date'>>,
  granularity: KlineGranularity
): string[][] {
  const out: string[][] = buckets.map(() => [])
  if (buckets.length === 0) return out

  if (granularity === 'day') {
    // The daily spine is gapless, so a day bucket's day is its own key. Using the spine
    // rather than `[bucket.date]` keeps a single code path for both cases.
    const index = new Map(buckets.map((bucket, i) => [bucket.date, i]))
    for (const day of daily) {
      const at = index.get(day.date)
      if (at !== undefined) out[at] = [day.date]
    }
    return out
  }

  let cursor = 0
  for (const day of daily) {
    while (cursor < buckets.length - 1 && day.date >= nextBucketDate(buckets, cursor)) cursor += 1
    if (day.date < buckets[cursor].date) continue
    out[cursor].push(day.date)
  }
  return out
}

function nextBucketDate(buckets: ReadonlyArray<Pick<KlineBucket, 'date'>>, index: number): string {
  return index + 1 < buckets.length ? buckets[index + 1].date : '\uffff'
}

/* -------------------------------------------------------------------------- */
/* the value axis                                                             */
/* -------------------------------------------------------------------------- */

export interface ActivityScale {
  /** Magnitude the axis is fitted to before zoom, per direction. */
  rawIncome: number
  rawExpense: number
  /** Divisor the reader applied with the vertical zoom control, always >= 1. */
  zoom: number
  /** Amount window actually drawn, per direction. */
  income: number
  expense: number
  /**
   * How the two directions share the panel.
   *
   * `shared` — one linear scale across the zero line, so a bar's height is comparable
   * to a bar on the other side of it. Used by the modes that plot a single signed
   * quantity (net flow, cumulative flow), where an asymmetric axis would make a
   * −RM 200 day look like a +RM 12,000 one.
   *
   * `perDirection` — each side is fitted to its own maximum and gets its own half of
   * the panel. Used by the composition modes (transaction stack, income vs expense,
   * category activity), because that is the only way a RM 200 dinner beside a RM 12,000
   * salary can both be read: on a shared scale the dinner is 1.6% of the panel, which is
   * five pixels of "I cannot see what I spent today". The two windows are printed on the
   * axis, so nothing about that is hidden — and the tooltip always reports real amounts.
   */
  split: 'shared' | 'perDirection'
  /** True when at least one bar is taller than the window and is drawn clipped. */
  clipped: boolean
}

export const ACTIVITY_MIN_ZOOM = 1
export const ACTIVITY_MAX_ZOOM = 400

/** Modes that plot one signed quantity, and therefore need one shared scale. */
export function isSharedScaleMode(mode: ActivityViewMode): boolean {
  return mode === 'net' || mode === 'cumulative'
}

/**
 * Fit the activity axis to the visible columns and apply the reader's vertical zoom.
 *
 * WHY THIS IS A SEPARATE AXIS FROM THE K-LINE (spec §7, §8)
 * --------------------------------------------------------
 * A RM 12,000 salary and a RM 200 dinner on one scale is a chart where the dinner is
 * 1.6% of the panel. The two panels therefore have independent Y axes, this one has a
 * zoom of its own, and — for the composition modes — the two directions are fitted
 * independently so that neither side can be flattened by the other.
 *
 * ZERO STAYS PUT. As with any bar chart, the baseline is not negotiable: zooming must
 * never leave a bar floating and misstate its size relative to its neighbours.
 */
export function activityScale(
  columns: readonly ActivityColumn[],
  mode: ActivityViewMode,
  zoom: number
): ActivityScale {
  const safeZoom = Math.min(ACTIVITY_MAX_ZOOM, Math.max(ACTIVITY_MIN_ZOOM, zoom))
  let rawIncome = 0
  let rawExpense = 0

  if (mode === 'cumulative') {
    let low = 0
    let high = 0
    for (const column of columns) {
      low = Math.min(low, column.cumulativeCashFlow)
      high = Math.max(high, column.cumulativeCashFlow)
    }
    rawIncome = Math.max(high, 0)
    rawExpense = Math.max(-low, 0)
  } else if (mode === 'net') {
    for (const column of columns) {
      if (column.netCashFlow > 0) rawIncome = Math.max(rawIncome, column.netCashFlow)
      else rawExpense = Math.max(rawExpense, -column.netCashFlow)
    }
  } else {
    for (const column of columns) {
      rawIncome = Math.max(rawIncome, column.totalIncome)
      rawExpense = Math.max(rawExpense, column.totalExpense)
    }
  }

  const income = rawIncome / safeZoom
  const expense = rawExpense / safeZoom
  const clipped =
    mode === 'cumulative'
      ? columns.some(
          (column) =>
            column.cumulativeCashFlow > income + 0.5 || -column.cumulativeCashFlow > expense + 0.5
        )
      : columns.some((column) => {
          const up = mode === 'net' ? Math.max(column.netCashFlow, 0) : column.totalIncome
          const down = mode === 'net' ? Math.max(-column.netCashFlow, 0) : column.totalExpense
          return up > income + 0.5 || down > expense + 0.5
        })

  return {
    rawIncome,
    rawExpense,
    zoom: safeZoom,
    income,
    expense,
    split: isSharedScaleMode(mode) ? 'shared' : 'perDirection',
    clipped
  }
}

/** The amount window as a value domain, ready for `valueDomain`'s tick ladder. */
export function activityDomainRange(scale: ActivityScale): { low: number; high: number } {
  return { low: -scale.expense, high: scale.income }
}

/* -------------------------------------------------------------------------- */
/* hit testing — in data space, never in pixels                               */
/* -------------------------------------------------------------------------- */

/**
 * Which segment of a column sits at `amount`, measured from the zero baseline.
 *
 * THE REQUIREMENT THIS EXISTS FOR (spec §17)
 * ------------------------------------------
 * A RM 1 transaction inside a RM 10,000 column is 0.02% of the panel: at 300px tall it
 * is 0.06px, and it is still a real thing the reader paid. Nothing here looks at how
 * tall a segment is drawn. The pointer's height is converted into an amount by the
 * caller, and this function answers "which transaction does that amount belong to",
 * so the answer does not change when the window is resized, when the zoom changes, or
 * when a bigger transaction happens to be in the same column.
 *
 * Pointing ABOVE the stack answers null, not the topmost segment. That distinction was
 * found by the acceptance run: a pointer halfway down a mostly-empty column used to
 * report the day's largest transaction, which made the tooltip name a dinner worth
 * RM 659 while the crosshair's own amount read RM 8,243 — the exact "the lines and the
 * card describe different things" failure this release exists to remove. Nothing under
 * the pointer means nothing is selected; the card then falls back to the day's totals,
 * which is true.
 *
 * Binary search over the cumulative ranges — O(log n) per column, not a scan.
 */
export function hitSegment(
  segments: readonly ActivitySegment[],
  amount: number
): ActivitySegment | null {
  if (segments.length === 0 || !Number.isFinite(amount)) return null
  const total = segments[segments.length - 1].endAmount
  if (amount < 0) return null
  if (total <= 0) return null
  // The exact top edge belongs to the topmost segment; anything above it belongs to
  // nothing at all.
  if (amount > total) return null
  if (amount === total) return segments[segments.length - 1]

  let lo = 0
  let hi = segments.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (amount < segments[mid].endAmount) hi = mid
    else lo = mid + 1
  }
  const found = segments[lo]
  return amount >= found.startAmount && amount <= found.endAmount ? found : null
}

/** The column whose bucket covers `instant`. Binary search; linear only when tiny. */
export function columnAt(columns: readonly ActivityColumn[], instant: number): ActivityColumn | null {
  if (columns.length === 0) return null
  let lo = 0
  let hi = columns.length - 1
  if (instant < columns[0].instant) return columns[0]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (columns[mid].instant <= instant) lo = mid
    else hi = mid - 1
  }
  return columns[lo]
}

/**
 * Amount at a pointer height, in the panel's own data space.
 *
 * Kept here rather than in the component so it can be tested: the sign convention
 * (up is income, down is expense, zero in between) is the contract the whole crosshair
 * rests on, and getting it backwards would report a RM 200 expense as income.
 */
export function amountAtY(
  y: number,
  top: number,
  bottom: number,
  zeroY: number,
  scale: ActivityScale,
  mode: ActivityViewMode
): number {
  if (bottom <= top) return 0
  if (mode === 'cumulative') {
    return scale.expense + ((bottom - y) / (bottom - top)) * (scale.income + scale.expense)
  }
  if (y <= zeroY) {
    const height = Math.max(1, zeroY - top)
    return ((zeroY - y) / height) * scale.income
  }
  const height = Math.max(1, bottom - zeroY)
  return -((y - zeroY) / height) * scale.expense
}

/**
 * Where the zero baseline sits.
 *
 * Two placements, matching the two axis models:
 *
 *   - `perDirection`: dead centre. Each side owns half the panel and is fitted to its
 *     own maximum, so a RM 200 day is drawn as large as a RM 12,000 one — which is the
 *     point of the composition modes, and is why the two windows are labelled.
 *   - `shared`: proportional to the two windows, so the pixel height of a bar above the
 *     line and one below it mean the same amount. Net flow and cumulative flow are
 *     signed quantities and must be read that way.
 */
export function zeroLineY(top: number, bottom: number, scale: ActivityScale, mode: ActivityViewMode): number {
  if (scale.split === 'perDirection') return top + (bottom - top) / 2
  const span = scale.income + scale.expense
  if (span <= 0) return mode === 'cumulative' ? bottom : bottom
  return bottom - (scale.expense / span) * (bottom - top)
}

/** Pointer height for an amount, the inverse of `amountAtY`. */
export function yAtAmount(
  amount: number,
  top: number,
  bottom: number,
  zeroY: number,
  scale: ActivityScale,
  mode: ActivityViewMode
): number {
  if (bottom <= top) return zeroY
  if (mode === 'cumulative') {
    const span = scale.income + scale.expense
    if (span <= 0) return bottom
    return bottom - ((amount + scale.expense) / span) * (bottom - top)
  }
  if (amount >= 0) {
    const height = Math.max(1, zeroY - top)
    const window_ = scale.income > 0 ? scale.income : 1
    return zeroY - (amount / window_) * height
  }
  const height = Math.max(1, bottom - zeroY)
  const window_ = scale.expense > 0 ? scale.expense : 1
  return zeroY + (Math.abs(amount) / window_) * height
}

/**
 * Which direction a pointer height is on.
 *
 * Deliberately geometric and independent of the data: a reader pointing below the zero
 * line is asking about expenses, and the answer must not flip because the day happened
 * to have no expenses at all.
 */
export function directionAtY(y: number, zeroY: number): ActivityDirection {
  return y <= zeroY ? 'income' : 'expense'
}

/** The segment under the pointer, in the column under the pointer. Pure and testable. */
export function pickSegment(
  columns: readonly ActivityColumn[],
  instant: number,
  y: number,
  top: number,
  bottom: number,
  zeroY: number,
  scale: ActivityScale,
  mode: ActivityViewMode
): { column: ActivityColumn; segment: ActivitySegment | null; amount: number } | null {
  const column = columnAt(columns, instant)
  if (column === null) return null
  const amount = amountAtY(y, top, bottom, zeroY, scale, mode)
  if (mode === 'stack') {
    const direction = directionAtY(y, zeroY)
    return { column, segment: hitSegment(direction === 'income' ? column.income : column.expense, Math.abs(amount)), amount }
  }
  if (mode === 'category') {
    const direction = directionAtY(y, zeroY)
    return { column, segment: hitCategory(column, direction, Math.abs(amount)), amount }
  }
  return { column, segment: null, amount }
}

/**
 * Which category band a pointer height falls in, in the category view.
 *
 * Reuses `hitSegment`'s binary search by projecting the category roll-up onto the same
 * cumulative range shape, so both views answer from one implementation.
 */
export function hitCategory(
  column: ActivityColumn,
  direction: ActivityDirection,
  amount: number
): ActivitySegment | null {
  const totals = column.categories.filter((entry) => entry.type === direction)
  if (totals.length === 0) return null
  let running = 0
  for (const total of totals) {
    const start = running
    running += total.amount
    if (amount >= start && amount <= running) {
      return {
        transactionId: -1,
        date: column.date,
        time: null,
        type: direction,
        amount: total.amount,
        originalAmount: total.amount,
        currency: '',
        unconverted: false,
        merchant: null,
        categoryId: total.categoryId,
        categoryName: total.key === '\u2014' ? null : total.key,
        categoryColor: total.color,
        accountName: '',
        note: null,
        startAmount: start,
        endAmount: running,
        percentage: 0,
        index: 1,
        count: total.count
      }
    }
  }
  return null
}
