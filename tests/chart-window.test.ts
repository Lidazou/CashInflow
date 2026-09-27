import { describe, expect, it } from 'vitest'

import { visibleRange } from '@shared/lib/chart-time'
import type { Viewport } from '@shared/lib/chart-time'

/**
 * The window slice.
 *
 * This exists because of a bug that shipped in v1.5.1 and survived two releases: the
 * chart's binary search returned ANY bucket inside the window rather than the first, so
 * with the whole history in view it started at the MIDDLE. A two-year ledger was drawn
 * from its one-year mark, and the missing older half looked like nothing more than
 * "the chart starts somewhere in the past".
 */

const DAY = 86_400_000
const start = Date.UTC(2026, 8, 24, 0, 0, 0)

/** Nine consecutive days, the shape the v1.6.0 verification fixture has. */
const nineDays = Array.from({ length: 9 }, (_, index) => ({
  instant: start + index * DAY,
  date: `day-${index}`
}))

const everything: Viewport = { from: start, to: start + 9 * DAY }

describe('visibleRange', () => {
  it('returns EVERY bucket when the whole history is in view', () => {
    expect(visibleRange(nineDays, everything)).toHaveLength(9)
    expect(visibleRange(nineDays, everything)[0].date).toBe('day-0')
  })

  it('does not start at the midpoint, which is what the old search did', () => {
    const out = visibleRange(nineDays, everything)
    expect(out[0].date).not.toBe('day-4')
  })

  it('handles a two-year ledger without dropping its first year', () => {
    const daily = Array.from({ length: 730 }, (_, index) => ({ instant: start + index * DAY }))
    const out = visibleRange(daily, { from: daily[0].instant, to: daily[729].instant + DAY })
    expect(out).toHaveLength(730)
  })

  it('starts at the first bucket that overlaps a window beginning mid-history', () => {
    const out = visibleRange(nineDays, { from: start + 3 * DAY + DAY / 2, to: start + 6 * DAY })
    expect(out.map((bucket) => bucket.date)).toEqual(['day-3', 'day-4', 'day-5'])
  })

  it('keeps a bucket that starts before the window but ends inside it', () => {
    // A week bucket beginning one day earlier still covers the window's first day.
    const weeks = [
      { instant: start, date: 'week-0' },
      { instant: start + 7 * DAY, date: 'week-1' }
    ]
    const out = visibleRange(weeks, { from: start + 2 * DAY, to: start + 8 * DAY })
    expect(out.map((bucket) => bucket.date)).toEqual(['week-0', 'week-1'])
  })

  it('returns nothing when the window sits entirely before the data', () => {
    expect(visibleRange(nineDays, { from: start - 5 * DAY, to: start - DAY })).toEqual([])
  })

  it('returns nothing when the window sits entirely after the data', () => {
    // `dataEnd` is what stops the open-ended final bucket from matching every future
    // window: without it, scrolling past the ledger still drew its last candle.
    expect(visibleRange(nineDays, { from: start + 20 * DAY, to: start + 30 * DAY }, start + 9 * DAY)).toEqual([])
    // And with no dataEnd supplied the caller is asking for the open-ended behaviour.
    expect(visibleRange(nineDays, { from: start + 20 * DAY, to: start + 30 * DAY })).toHaveLength(1)
  })

  it('keeps the final bucket, which is open-ended', () => {
    const out = visibleRange(nineDays, { from: start + 8 * DAY, to: start + 40 * DAY })
    expect(out.map((bucket) => bucket.date)).toEqual(['day-8'])
  })

  it('is exact for a single day window', () => {
    const out = visibleRange(nineDays, { from: start + 2 * DAY, to: start + 3 * DAY })
    expect(out.map((bucket) => bucket.date)).toEqual(['day-2'])
  })

  it('handles an empty list', () => {
    expect(visibleRange([], everything)).toEqual([])
  })
})
