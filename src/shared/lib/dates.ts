/**
 * Date helpers.
 *
 * THE RULE: a transaction's date is a LOCAL CALENDAR DATE stored as
 * 'YYYY-MM-DD'. It is not an instant.
 *
 * A purchase made at 23:30 on 26 September must stay on the 26th forever. If we
 * stored `Date.now()` instead, a user who later opens the app in a different
 * timezone — or whose machine crosses a DST boundary — would see that purchase
 * silently move to the 27th, and "today's transactions" would disagree with what
 * the bank statement says.
 *
 * So: format from local date parts, never via toISOString(). `toISOString()`
 * converts to UTC first, which is exactly the bug we are avoiding.
 *
 * Companion rule for SQL: SQLite's date('now') is UTC. Always pass explicit
 * date strings from here rather than letting SQL compute "today".
 */

export type DateString = string // 'YYYY-MM-DD'

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Format a Date's LOCAL calendar parts as 'YYYY-MM-DD'. */
export function toDateString(date: Date): DateString {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * Today in the user's local timezone.
 *
 * Note the deliberate absence of toISOString(): for a user at UTC+8 before
 * 08:00 local, toISOString().slice(0,10) returns yesterday.
 */
export function today(now: Date = new Date()): DateString {
  return toDateString(now)
}

/** Current local wall-clock time as 'HH:MM'. */
export function nowTime(now: Date = new Date()): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

/** Parse 'YYYY-MM-DD' into a Date at LOCAL midnight. */
export function parseDateString(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(year, month - 1, day)
  // Reject impossible dates like 2026-02-31, which Date would roll forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

export function isValidDateString(value: string): boolean {
  return parseDateString(value) !== null
}

/** 'YYYY-MM' month key for a date or Date. */
export function monthKeyOf(value: DateString | Date): string {
  return typeof value === 'string' ? value.slice(0, 7) : toDateString(value).slice(0, 7)
}

/** First day of the month containing `value`. */
export function startOfMonth(value: DateString | Date): DateString {
  const key = monthKeyOf(value)
  return `${key}-01`
}

/** Last day of the month containing `value`, computed without float date math. */
export function endOfMonth(value: DateString | Date): DateString {
  const key = monthKeyOf(value)
  const [y, m] = key.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  return `${key}-${pad2(lastDay)}`
}

export function startOfYear(value: DateString | Date): DateString {
  return `${(typeof value === 'string' ? value : toDateString(value)).slice(0, 4)}-01-01`
}

export function endOfYear(value: DateString | Date): DateString {
  return `${(typeof value === 'string' ? value : toDateString(value)).slice(0, 4)}-12-31`
}

/** Add days to a date string, returning a date string. Uses local date parts. */
export function addDays(value: DateString, days: number): DateString {
  const date = parseDateString(value)
  if (!date) return value
  date.setDate(date.getDate() + days)
  return toDateString(date)
}

/** Add months, clamping the day to the target month's length (31 Jan + 1m = 28/29 Feb). */
export function addMonths(value: DateString, months: number): DateString {
  const date = parseDateString(value)
  if (!date) return value
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() + months)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(day, lastDay))
  return toDateString(date)
}

export function addYears(value: DateString, years: number): DateString {
  const date = parseDateString(value)
  if (!date) return value
  const day = date.getDate()
  const month = date.getMonth()
  date.setDate(1)
  date.setFullYear(date.getFullYear() + years)
  const lastDay = new Date(date.getFullYear(), month + 1, 0).getDate()
  date.setDate(Math.min(day, lastDay))
  return toDateString(date)
}

/** Whole days between two date strings (b - a). */
export function daysBetween(a: DateString, b: DateString): number {
  const da = parseDateString(a)
  const db = parseDateString(b)
  if (!da || !db) return 0
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}

/** 0 = Sunday .. 6 = Saturday, in local time. */
export function weekdayOf(value: DateString): number {
  const date = parseDateString(value)
  return date ? date.getDay() : 0
}

/** True when `value` falls in the same calendar month as `reference`. */
export function isSameMonth(value: DateString, reference: DateString | Date): boolean {
  return monthKeyOf(value) === monthKeyOf(reference)
}

export function isSameDay(a: DateString, b: DateString): boolean {
  return a === b
}

/**
 * ISO-8601 week key, 'YYYY-Www'.
 *
 * ISO weeks start on Monday and week 1 is the week containing 4 January. This is
 * computed from local date parts to stay consistent with how transaction dates
 * are stored.
 */
export function isoWeekKey(value: DateString): string {
  const date = parseDateString(value)
  if (!date) return value
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  // Shift to the Thursday of this week; its year is the ISO week-year.
  const dayNum = (target.getDay() + 6) % 7 // Mon = 0
  target.setDate(target.getDate() - dayNum + 3)
  const isoYear = target.getFullYear()
  const firstThursday = new Date(isoYear, 0, 4)
  const firstDayNum = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3)
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${isoYear}-W${pad2(week)}`
}

/**
 * Week key honouring a configurable first day of week (spec §29).
 * `weekStartsOn` 0 = Sunday, 1 = Monday.
 */
export function weekKey(value: DateString, weekStartsOn: 0 | 1 = 1): string {
  if (weekStartsOn === 1) return isoWeekKey(value)
  const date = parseDateString(value)
  if (!date) return value
  // Walk back to the most recent Sunday, then key on that day's date.
  const start = addDays(value, -date.getDay())
  return `W${start}`
}

/** Start (inclusive) of the week containing `value`. */
export function startOfWeek(value: DateString, weekStartsOn: 0 | 1 = 1): DateString {
  const date = parseDateString(value)
  if (!date) return value
  const dow = date.getDay()
  const diff = weekStartsOn === 1 ? (dow + 6) % 7 : dow
  return addDays(value, -diff)
}

export function endOfWeek(value: DateString, weekStartsOn: 0 | 1 = 1): DateString {
  return addDays(startOfWeek(value, weekStartsOn), 6)
}

/**
 * Build the 6x7 grid of days shown by the statistics calendar (spec §18).
 * Starts on the configured first day of week so the layout matches the
 * user's locale expectation.
 */
export function calendarGridStart(monthKey: string, weekStartsOn: 0 | 1 = 1): DateString {
  const first = `${monthKey}-01`
  return startOfWeek(first, weekStartsOn)
}

/**
 * Short display label. Deliberately hand-rolled rather than
 * Intl.DateTimeFormat so the output is deterministic in tests and identical
 * across machines regardless of installed ICU data.
 */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function monthName(monthIndex: number): string {
  return MONTHS_LONG[monthIndex] ?? ''
}

export function monthNameShort(monthIndex: number): string {
  return MONTHS_SHORT[monthIndex] ?? ''
}

export function weekdayNameShort(dayIndex: number): string {
  return WEEKDAYS_SHORT[dayIndex] ?? ''
}

/** 'September 2026' from '2026-09'. */
export function formatMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  if (!y || !m) return monthKey
  return `${monthName(m - 1)} ${y}`
}

/**
 * Render a date string using the user's configured format (spec §29).
 */
export function formatDate(
  value: DateString,
  format: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD MMM YYYY' = 'DD MMM YYYY',
  options: { weekday?: boolean } = {}
): string {
  const date = parseDateString(value)
  if (!date) return value
  const d = pad2(date.getDate())
  const m = pad2(date.getMonth() + 1)
  const y = date.getFullYear()

  let base: string
  switch (format) {
    case 'DD/MM/YYYY':
      base = `${d}/${m}/${y}`
      break
    case 'MM/DD/YYYY':
      base = `${m}/${d}/${y}`
      break
    case 'YYYY-MM-DD':
      base = `${y}-${m}-${d}`
      break
    case 'DD MMM YYYY':
    default:
      base = `${date.getDate()} ${monthNameShort(date.getMonth())} ${y}`
      break
  }
  return options.weekday ? `${weekdayNameShort(date.getDay())}, ${base}` : base
}

/** 'Mon 26 Sep' style label used inside the Today column. */
export function formatDayHeading(value: DateString): string {
  const date = parseDateString(value)
  if (!date) return value
  return `${weekdayNameShort(date.getDay())}, ${date.getDate()} ${monthNameShort(date.getMonth())}`
}

/** '14:05' from 'HH:MM' or 'HH:MM:SS'; null-safe. */
export function formatTime(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!m) return null
  return `${pad2(Number(m[1]))}:${m[2]}`
}

/** Relative label for recent dates, used in the transaction list. */
export function relativeDayLabel(value: DateString, reference: DateString = today()): string {
  const diff = daysBetween(value, reference)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff === -1) return 'Tomorrow'
  if (diff > 1 && diff < 7) return `${diff} days ago`
  return formatDayHeading(value)
}
