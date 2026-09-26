import { describe, it, expect } from 'vitest'
import {
  addDays,
  addMonths,
  calendarGridStart,
  endOfMonth,
  formatDate,
  formatMonthLabel,
  isoWeekKey,
  monthKeyOf,
  parseDateString,
  relativeDayLabel,
  startOfWeek,
  today,
  toDateString,
  weekKey
} from '@shared/lib/dates'

describe('dates: local calendar dates', () => {
  it('formats from local parts, not via toISOString', () => {
    // A late-evening transaction must keep its own calendar date. Note that
    // 23:30 is NOT always a date-shifting hour: at UTC+8 it is still 15:30 UTC
    // on the same day. The shift happens in the early-morning hours east of
    // UTC, which is why the probe below is derived from the real offset rather
    // than hardcoded — this test must hold in any timezone.
    const late = new Date(2026, 8, 26, 23, 30, 0)
    expect(toDateString(late)).toBe('2026-09-26')

    const offsetMinutes = late.getTimezoneOffset()
    // Local midnight on the 26th, expressed as the UTC instant it corresponds to.
    const localMidnight = new Date(2026, 8, 26, 0, 0, 0)
    const utcDateOfLocalMidnight = localMidnight.toISOString().slice(0, 10)

    if (offsetMinutes < 0) {
      // East of UTC: local midnight is still the previous day in UTC, which is
      // exactly the off-by-one that storing instants would introduce.
      expect(utcDateOfLocalMidnight).toBe('2026-09-25')
    } else if (offsetMinutes > 0) {
      // West of UTC: late evening local time is already the next day in UTC.
      const lateEvening = new Date(2026, 8, 26, 23, 30, 0)
      expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-09-27')
    }

    // Whatever the offset, our own formatter must agree with the local clock.
    expect(toDateString(localMidnight)).toBe('2026-09-26')
  })

  it('parses and rejects impossible dates', () => {
    expect(parseDateString('2026-09-26')).toBeInstanceOf(Date)
    expect(parseDateString('2026-02-31')).toBeNull() // Date would roll this to Mar 3
    expect(parseDateString('2026-13-01')).toBeNull()
    expect(parseDateString('26/09/2026')).toBeNull()
    expect(parseDateString('')).toBeNull()
  })

  it('computes month boundaries without float date math', () => {
    expect(startOfWeek('2026-09-26', 1)).toBe('2026-09-21') // Monday
    expect(startOfWeek('2026-09-26', 0)).toBe('2026-09-20') // Sunday
    expect(endOfMonth('2026-09-15')).toBe('2026-09-30')
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28')
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29') // leap year
    expect(monthKeyOf('2026-09-26')).toBe('2026-09')
  })

  it('clamps day-of-month when adding months', () => {
    // 31 Jan + 1 month must not become 3 March.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
  })

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('computes ISO week keys', () => {
    // 2026-01-01 is a Thursday, so it belongs to ISO week 2026-W01.
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01')
    // Monday and the following Sunday share an ISO week.
    expect(isoWeekKey('2026-09-21')).toBe(isoWeekKey('2026-09-27'))
    expect(isoWeekKey('2026-09-21')).not.toBe(isoWeekKey('2026-09-28'))
    expect(weekKey('2026-09-26', 1)).toBe(isoWeekKey('2026-09-26'))
    expect(weekKey('2026-09-26', 0)).toBe('W2026-09-20')
  })

  it('builds a calendar grid aligned to the configured week start', () => {
    expect(calendarGridStart('2026-09', 1)).toBe('2026-08-31') // Mon before 1 Sep 2026
    expect(calendarGridStart('2026-09', 0)).toBe('2026-08-30') // Sun before 1 Sep 2026
  })

  it('formats dates in each supported display format', () => {
    // Month and weekday names are Chinese constants rather than Intl output, so
    // the result is identical on every machine regardless of installed ICU data.
    expect(formatDate('2026-09-26', 'DD MMM YYYY')).toBe('26 9月 2026')
    expect(formatDate('2026-09-26', 'DD/MM/YYYY')).toBe('26/09/2026')
    expect(formatDate('2026-09-26', 'MM/DD/YYYY')).toBe('09/26/2026')
    expect(formatDate('2026-09-26', 'YYYY-MM-DD')).toBe('2026-09-26')
    expect(formatDate('2026-09-26', 'DD MMM YYYY', { weekday: true })).toBe('周六, 26 9月 2026')
  })

  it('labels months and relative days for the UI', () => {
    expect(formatMonthLabel('2026-09')).toBe('2026年9月')
    expect(formatMonthLabel('2026-10')).toBe('2026年10月')
    expect(relativeDayLabel('2026-09-26', '2026-09-26')).toBe('Today')
    expect(relativeDayLabel('2026-09-25', '2026-09-26')).toBe('Yesterday')
    expect(relativeDayLabel('2026-09-23', '2026-09-26')).toBe('3 days ago')
    // 1 Sep 2026 is a Tuesday.
    expect(relativeDayLabel('2026-09-01', '2026-09-26')).toBe('周二, 1 9月')
  })

  it('returns a valid today string', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
