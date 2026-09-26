import { addDays, addMonths, endOfMonth, monthKeyOf, startOfMonth, today, formatMonthLabel, formatDate, type DateString } from './dates'

/**
 * Billing / settlement periods.
 *
 * THE PROBLEM WITH CALENDAR MONTHS
 * --------------------------------
 * A student whose allowance arrives on the 5th does not think in calendar
 * months. On the 3rd of September their "this month" spending is nearly zero and
 * their remaining figure looks reassuring, while in truth they are at the end of
 * an almost-empty cycle and about to be paid. Reporting 1–30 September answers a
 * question nobody asked.
 *
 * A settlement cycle is therefore a month-long window anchored on a chosen day:
 * with `startDay = 5`, the cycle containing 3 September is
 *
 *     5 August  ->  4 September
 *
 * Everything the app reports — the dashboard ring, "this cycle" totals, budgets,
 * the statistics period — is computed over that window instead of the calendar
 * month, so the numbers line up with how the money actually arrives.
 *
 * `startDay = 1` reproduces a plain calendar month exactly, so this is a strict
 * generalisation rather than a separate mode.
 */

export interface SettlementCycle {
  /** 'YYYY-MM-DD', inclusive. */
  start: DateString
  /** 'YYYY-MM-DD', inclusive. */
  end: DateString
  /** Identifies the cycle for lookups and month pickers, e.g. '2026-09'. */
  key: string
  /** Day of month the cycle is anchored on, 1-28. */
  startDay: number
  /** Display label, e.g. "9月5日 – 10月4日". */
  label: string
}

/** Day-of-month values a cycle may start on. 29-31 are excluded (see below). */
export const MIN_CYCLE_START_DAY = 1
export const MAX_CYCLE_START_DAY = 28

/**
 * Clamp a requested start day into the supported range.
 *
 * Why 28 is the maximum: a cycle starting on the 31st has no 31st in February,
 * so its length would vary between 28 and 31 days and the same transaction could
 * fall into different cycles depending on the month. Capping at 28 keeps every
 * cycle exactly one month long, which is what makes cycles comparable to each
 * other.
 *
 * Non-finite input falls back to 1 rather than to 28: NaN and Infinity are
 * corrupt values, not large ones, and treating them as "a big day" would
 * silently move the user's reporting period instead of leaving it alone.
 */
export function clampCycleStartDay(day: number): number {
  if (!Number.isFinite(day)) return 1
  const rounded = Math.trunc(day)
  if (rounded < MIN_CYCLE_START_DAY) return MIN_CYCLE_START_DAY
  if (rounded > MAX_CYCLE_START_DAY) return MAX_CYCLE_START_DAY
  return rounded
}

/**
 * The cycle containing `reference`.
 *
 * When `startDay` is 1 the result is exactly the calendar month, so callers do
 * not need a special case.
 */
export function cycleFor(reference: DateString, startDay: number): SettlementCycle {
  const day = clampCycleStartDay(startDay)

  if (day === 1) {
    const key = monthKeyOf(reference)
    return {
      start: startOfMonth(reference),
      end: endOfMonth(reference),
      key,
      startDay: 1,
      label: cycleLabel(startOfMonth(reference), endOfMonth(reference))
    }
  }

  const dayOfMonth = Number(reference.slice(8, 10))

  // On or after the anchor day, the cycle opened this month; before it, last month.
  const anchorMonth = dayOfMonth >= day ? reference : addMonths(reference, -1)
  const start = withDayOfMonth(anchorMonth, day)
  // The cycle ENDS the day before the next anchor, so consecutive cycles tile
  // the calendar with no gap and no overlap.
  const end = addDays(withDayOfMonth(addMonths(start, 1), day), -1)

  return {
    start,
    end,
    // Keyed by the month the cycle STARTS in, which is stable and sortable.
    key: monthKeyOf(start),
    startDay: day,
    label: cycleLabel(start, end)
  }
}

/** Shift to the cycle `delta` cycles away from the one containing `reference`. */
export function shiftCycle(reference: DateString, startDay: number, delta: number): SettlementCycle {
  const current = cycleFor(reference, startDay)
  const day = clampCycleStartDay(startDay)
  if (day === 1) {
    return cycleFor(addMonths(current.start, delta), day)
  }
  // Step from the cycle's start so the anchor day is preserved exactly, then
  // resolve from a date safely inside the target cycle.
  const targetStart = addMonths(current.start, delta)
  return cycleFor(addDays(targetStart, 1), day)
}

/**
 * The cycle identified by a 'YYYY-MM' key, i.e. the one whose start falls in
 * that month. Used by month pickers that store a key rather than a date.
 */
export function cycleFromKey(key: string, startDay: number): SettlementCycle {
  const first = `${key}-01`
  const day = clampCycleStartDay(startDay)
  if (day === 1) return cycleFor(first, day)
  // Resolve from the anchor day itself so the key always names its own cycle.
  return cycleFor(withDayOfMonth(first, day), day)
}

/** Set the day-of-month on a date, clamping to a valid day for that month. */
function withDayOfMonth(reference: DateString, day: number): DateString {
  const year = Number(reference.slice(0, 4))
  const month = Number(reference.slice(5, 7))
  const lastDay = new Date(year, month, 0).getDate()
  const safeDay = Math.min(day, lastDay)
  return `${reference.slice(0, 7)}-${String(safeDay).padStart(2, '0')}`
}

/** '9月5日 – 10月4日' style label, or a month name when the cycle is a plain month. */
export function cycleLabel(start: DateString, end: DateString): string {
  const startMonth = Number(start.slice(5, 7))
  const endMonth = Number(end.slice(5, 7))
  const startYear = start.slice(0, 4)
  const endYear = end.slice(0, 4)

  // A calendar month reads better as "2026年9月" than as a date range.
  if (start.slice(8, 10) === '01' && end === endOfMonth(start)) {
    return `${startYear}年${startMonth}月`
  }

  const startText = `${startMonth}月${Number(start.slice(8, 10))}日`
  const endText = `${endMonth}月${Number(end.slice(8, 10))}日`
  return startYear === endYear ? `${startText} – ${endText}` : `${startYear}年${startText} – ${endYear}年${endText}`
}

/** Short label for tight spaces, e.g. "9/5–10/4". */
export function cycleLabelShort(cycle: SettlementCycle): string {
  const s = cycle.start
  const e = cycle.end
  return `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}–${Number(e.slice(5, 7))}/${Number(e.slice(8, 10))}`
}

/** True when `date` falls inside the cycle. */
export function isInCycle(date: DateString, cycle: SettlementCycle): boolean {
  return date >= cycle.start && date <= cycle.end
}

/** Number of days in the cycle, inclusive. */
export function cycleLength(cycle: SettlementCycle): number {
  const start = Date.parse(`${cycle.start}T00:00:00Z`)
  const end = Date.parse(`${cycle.end}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.round((end - start) / 86_400_000) + 1
}

/**
 * Whole days remaining in the cycle as of `asOf`, inclusive of today.
 * Zero or negative means the cycle has ended.
 */
export function daysRemaining(cycle: SettlementCycle, asOf: DateString = today()): number {
  if (asOf > cycle.end) return 0
  if (asOf < cycle.start) return cycleLength(cycle)
  const from = Date.parse(`${asOf}T00:00:00Z`)
  const end = Date.parse(`${cycle.end}T00:00:00Z`)
  return Math.round((end - from) / 86_400_000) + 1
}

/** Fraction of the cycle already elapsed, 0-1. Used for pace comparisons. */
export function cycleProgress(cycle: SettlementCycle, asOf: DateString = today()): number {
  const total = cycleLength(cycle)
  if (total <= 0) return 0
  const remaining = daysRemaining(cycle, asOf)
  return Math.min(Math.max((total - remaining) / total, 0), 1)
}

/** The last N cycles ending with the one containing `reference`, oldest first. */
export function recentCycles(reference: DateString, startDay: number, count: number): SettlementCycle[] {
  const cycles: SettlementCycle[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    cycles.push(shiftCycle(reference, startDay, -i))
  }
  return cycles
}

// ---------------------------------------------------------------------------
// Arbitrary custom ranges (spec: "随意设定任意时间段为统计周期")
// ---------------------------------------------------------------------------

export interface CustomRange {
  from: DateString
  to: DateString
  /** User-supplied label; falls back to a generated date range. */
  label?: string
  /**
   * Optional total budget for the period. When set, the statistics page reports
   * spend against it, which is what makes an arbitrary range useful for a
   * one-off question like "how much of my RM 2,000 trip budget did I use?".
   */
  budgetMinor?: number
}

export interface CustomRangePreset {
  id: string
  label: string
  build: (reference?: DateString) => { from: DateString; to: DateString }
}

/**
 * Quick ranges offered alongside the date pickers.
 *
 * Deliberately relative to today rather than fixed dates: "最近30天" is almost
 * always what someone means when they want a non-standard period, and typing two
 * dates to express it is friction.
 */
export const CUSTOM_RANGE_PRESETS: readonly CustomRangePreset[] = [
  { id: 'last7', label: '最近 7 天', build: (ref = today()) => ({ from: addDays(ref, -6), to: ref }) },
  { id: 'last30', label: '最近 30 天', build: (ref = today()) => ({ from: addDays(ref, -29), to: ref }) },
  { id: 'last90', label: '最近 90 天', build: (ref = today()) => ({ from: addDays(ref, -89), to: ref }) },
  {
    id: 'thisWeek',
    label: '本周',
    build: (ref = today()) => {
      // Week starts Monday, matching the app's default.
      const dow = new Date(`${ref}T00:00:00`).getDay()
      const offset = (dow + 6) % 7
      const start = addDays(ref, -offset)
      return { from: start, to: addDays(start, 6) }
    }
  },
  {
    id: 'thisQuarter',
    label: '本季度',
    build: (ref = today()) => {
      const year = Number(ref.slice(0, 4))
      const month = Number(ref.slice(5, 7))
      const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1
      const from = `${year}-${String(quarterStartMonth).padStart(2, '0')}-01`
      const to = endOfMonth(addMonths(from, 2))
      return { from, to }
    }
  },
  {
    id: 'thisYear',
    label: '本年',
    build: (ref = today()) => ({ from: `${ref.slice(0, 4)}-01-01`, to: `${ref.slice(0, 4)}-12-31` })
  },
  { id: 'allTime', label: '全部时间', build: () => ({ from: '1900-01-01', to: today() }) }
]

/**
 * Validate a user-supplied range.
 *
 * Returns a message in Chinese suitable for display, or null when valid. An
 * inverted range (from after to) is the common mistake and returns zero rows with
 * no explanation, so it must be caught rather than silently accepted.
 *
 * `maxDays` is generous by default but exists so a hand-typed range cannot ask
 * the database to scan a century. Built-in presets that legitimately span
 * everything the user has ever recorded pass a larger allowance.
 */
export function validateCustomRange(from: string, to: string, maxDays = 3660): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return '请选择有效的开始日期。'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return '请选择有效的结束日期。'
  if (from > to) return '开始日期不能晚于结束日期。'
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
  if (days > maxDays) return `统计区间不能超过 ${Math.floor(maxDays / 365)} 年。`
  return null
}

/**
 * The allowance used when validating a built-in preset.
 *
 * The "all time" preset starts at 1900 on purpose: it is an open-ended lower
 * bound rather than a claim that the user has data from 1900, and the query
 * simply returns whatever exists. Bounding it to "today minus ten years" would
 * silently exclude a long-running ledger.
 */
export const PRESET_MAX_DAYS = 365 * 200

/** Human label for a range, e.g. "2026年8月5日 – 2026年9月4日". */
export function customRangeLabel(from: string, to: string): string {
  return `${formatDate(from, 'DD MMM YYYY')} – ${formatDate(to, 'DD MMM YYYY')}`
}

// ---------------------------------------------------------------------------
// The dashboard's switchable reporting period
// ---------------------------------------------------------------------------

/** Month key one month away from `key`, e.g. shiftMonthKey('2026-01', -1) = '2025-12'. */
export function shiftMonthKey(key: string, delta: number): string {
  return addMonths(`${key}-01`, delta).slice(0, 7)
}

/**
 * Step the dashboard's selected month for the given mode.
 *
 * Cycles are resolved from the KEY rather than from a day inside the month.
 * `shiftCycle` starts by finding the cycle containing its reference, so passing
 * '2026-09-01' with an anchor of 5 would silently resolve the PREVIOUS cycle
 * (5 Aug - 4 Sep) and step to 2026-09 instead of 2026-10 — one press would do
 * nothing and the next would jump two. `cycleFromKey` names the cycle by its
 * start month, which is exactly the key the dashboard holds.
 *
 * Custom ranges are absolute rather than anchored to a month, so stepping
 * translates the whole window by whole months instead of re-deriving it. That
 * keeps "next period" meaning "the same window, later"; moving only the anchor
 * would silently change the window's length.
 */
export function shiftDashboardMonth(
  mode: 'natural' | 'cycle' | 'custom',
  cycleKey: string,
  cycleStartDay: number,
  delta: number,
  range?: { from: string; to: string } | null
): { key: string; range: { from: string; to: string } | null } {
  if (mode === 'custom' && range) {
    return {
      key: cycleKey,
      range: { from: addMonths(range.from, delta), to: addMonths(range.to, delta) }
    }
  }
  const anchorDay = mode === 'natural' ? 1 : cycleStartDay
  const current = cycleFromKey(cycleKey, anchorDay)
  return { key: shiftCycle(current.start, anchorDay, delta).key, range: null }
}

/**
 * The dashboard's period, resolved for display or for a request.
 *
 * One function for both so the header and the figures can never describe
 * different windows: the label is derived from the same `start`/`end` that the
 * query used, rather than being computed separately in the component.
 */
export function dashboardPeriod(
  mode: 'natural' | 'cycle' | 'custom',
  cycleKey: string,
  cycleStartDay: number,
  range: { from: string; to: string } | null | undefined,
  asOf: DateString = today()
): {
  start: DateString
  end: DateString
  label: string
  startDay: number | null
  daysTotal: number
  daysRemaining: number
} {
  if (mode === 'custom' && range) {
    const daysTotal = daySpan(range.from, range.to)
    const daysRemaining = range.to < asOf ? 0 : daySpan(asOf < range.from ? range.from : asOf, range.to)
    return {
      start: range.from,
      end: range.to,
      label: customRangeLabel(range.from, range.to),
      startDay: null,
      daysTotal,
      daysRemaining
    }
  }
  const cycle = cycleFromKey(cycleKey, mode === 'natural' ? 1 : cycleStartDay)
  return {
    start: cycle.start,
    end: cycle.end,
    label: cycle.label,
    startDay: cycle.startDay,
    daysTotal: cycleLength(cycle),
    daysRemaining: daysRemaining(cycle, asOf)
  }
}

/** Inclusive day count between two local dates. */
function daySpan(from: DateString, to: DateString): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0
  return Math.round((end - start) / 86_400_000) + 1
}

export { formatMonthLabel }
