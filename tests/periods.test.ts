import { describe, expect, it } from 'vitest'
import {
  clampCycleStartDay,
  cycleFor,
  cycleFromKey,
  cycleLength,
  cycleProgress,
  customRangeLabel,
  cycleLabel,
  daysRemaining,
  isInCycle,
  recentCycles,
  shiftCycle,
  validateCustomRange,
  MAX_CYCLE_START_DAY,
  PRESET_MAX_DAYS,
  CUSTOM_RANGE_PRESETS
} from '@shared/lib/periods'

/**
 * Settlement-cycle tests.
 *
 * The requirement is that a student paid on the 5th sees "this month" as
 * 5 Aug – 4 Sep, and that consecutive cycles tile the calendar with no gap and
 * no overlap. The tiling property is the one that actually matters: a gap would
 * silently drop transactions from every report, and an overlap would double-count
 * them.
 */

describe('clampCycleStartDay', () => {
  it('clamps into the supported 1-28 range', () => {
    expect(clampCycleStartDay(1)).toBe(1)
    expect(clampCycleStartDay(15)).toBe(15)
    expect(clampCycleStartDay(28)).toBe(28)
    expect(clampCycleStartDay(29)).toBe(MAX_CYCLE_START_DAY)
    expect(clampCycleStartDay(31)).toBe(MAX_CYCLE_START_DAY)
    expect(clampCycleStartDay(0)).toBe(1)
    expect(clampCycleStartDay(-5)).toBe(1)
  })

  it('falls back to 1 for non-finite input', () => {
    // NaN and Infinity are corrupt values, not large ones. Treating Infinity as
    // "a big day" would silently move the reporting period to the 28th.
    expect(clampCycleStartDay(Number.NaN)).toBe(1)
    expect(clampCycleStartDay(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('cycleFor', () => {
  it('reproduces a calendar month when the start day is 1', () => {
    const cycle = cycleFor('2026-09-15', 1)
    expect(cycle.start).toBe('2026-09-01')
    expect(cycle.end).toBe('2026-09-30')
    expect(cycle.key).toBe('2026-09')
    expect(cycle.label).toBe('2026年9月')
  })

  it('anchors on the given day of month', () => {
    // 26 Sep is on/after the 5th, so the cycle opened on 5 Sep.
    const cycle = cycleFor('2026-09-26', 5)
    expect(cycle.start).toBe('2026-09-05')
    expect(cycle.end).toBe('2026-10-04')
    expect(cycle.key).toBe('2026-09')
  })

  it('belongs to the previous cycle when the date is before the anchor', () => {
    // 3 Sep is before the 5th, so it belongs to the cycle that opened 5 Aug.
    const cycle = cycleFor('2026-09-03', 5)
    expect(cycle.start).toBe('2026-08-05')
    expect(cycle.end).toBe('2026-09-04')
    expect(cycle.key).toBe('2026-08')
  })

  it('treats the anchor day itself as the first day of the new cycle', () => {
    const cycle = cycleFor('2026-09-05', 5)
    expect(cycle.start).toBe('2026-09-05')
  })

  it('treats the day before the anchor as the last day of the previous cycle', () => {
    const cycle = cycleFor('2026-09-04', 5)
    expect(cycle.end).toBe('2026-09-04')
    expect(cycle.start).toBe('2026-08-05')
  })

  it('handles the year boundary', () => {
    const cycle = cycleFor('2026-01-03', 5)
    expect(cycle.start).toBe('2025-12-05')
    expect(cycle.end).toBe('2026-01-04')
    expect(cycle.key).toBe('2025-12')
  })

  it('is exactly one month long for every supported start day', () => {
    // This is what capping at 28 guarantees, and why 29-31 are refused.
    for (let day = 1; day <= MAX_CYCLE_START_DAY; day += 1) {
      for (const date of ['2026-01-15', '2026-02-15', '2026-03-31', '2026-12-31', '2024-02-29']) {
        const cycle = cycleFor(date, day)
        expect(cycleLength(cycle)).toBeGreaterThanOrEqual(28)
        expect(cycleLength(cycle)).toBeLessThanOrEqual(31)
      }
    }
  })

  it('tiles the calendar with no gap and no overlap', () => {
    // Walk a year cycle-by-cycle and assert each starts exactly one day after the
    // previous ends. A gap would drop transactions; an overlap would double-count.
    const startDay = 5
    let cursor = '2026-01-05'
    const seen: string[] = []
    for (let i = 0; i < 13; i += 1) {
      const cycle = cycleFor(cursor, startDay)
      expect(seen).not.toContain(cycle.start)
      seen.push(cycle.start)
      // Next cycle begins the day after this one ends.
      const nextStart = addOneDay(cycle.end)
      const next = cycleFor(nextStart, startDay)
      expect(next.start).toBe(nextStart)
      cursor = nextStart
    }
    expect(seen.length).toBe(13)
  })

  it('covers every day of the year exactly once', () => {
    const startDay = 7
    const counted = new Map<string, number>()
    let cursor = '2026-01-07'
    for (let i = 0; i < 13; i += 1) {
      const cycle = cycleFor(cursor, startDay)
      let day = cycle.start
      while (day <= cycle.end) {
        counted.set(day, (counted.get(day) ?? 0) + 1)
        day = addOneDay(day)
      }
      cursor = addOneDay(cycle.end)
    }
    // Every day from the first cycle's start to the last cycle's end appears once.
    const duplicates = [...counted.entries()].filter(([, count]) => count > 1)
    expect(duplicates).toHaveLength(0)
  })
})

describe('shiftCycle', () => {
  it('moves forward and back by whole cycles', () => {
    const base = cycleFor('2026-09-26', 5)
    const next = shiftCycle('2026-09-26', 5, 1)
    expect(next.start).toBe('2026-10-05')
    const previous = shiftCycle('2026-09-26', 5, -1)
    expect(previous.start).toBe('2026-08-05')
    expect(previous.key).toBe(base.key === '2026-09' ? '2026-08' : previous.key)
  })

  it('round-trips back to the original cycle', () => {
    const forward = shiftCycle('2026-09-26', 12, 3)
    const back = shiftCycle(forward.start, 12, -3)
    expect(back.key).toBe(cycleFor('2026-09-26', 12).key)
  })

  it('preserves the anchor day across a year', () => {
    const shifted = shiftCycle('2026-03-15', 10, 12)
    expect(shifted.start.slice(8, 10)).toBe('10')
    expect(shifted.start.slice(0, 7)).toBe('2027-03')
  })
})

describe('cycleFromKey', () => {
  it('round-trips through the key', () => {
    const original = cycleFor('2026-09-26', 5)
    const fromKey = cycleFromKey(original.key, 5)
    expect(fromKey.start).toBe(original.start)
    expect(fromKey.end).toBe(original.end)
  })

  it('matches cycleFor for a calendar month', () => {
    expect(cycleFromKey('2026-09', 1).start).toBe('2026-09-01')
    expect(cycleFromKey('2026-09', 1).end).toBe('2026-09-30')
  })
})

describe('isInCycle / cycleLength / daysRemaining / cycleProgress', () => {
  const cycle = cycleFor('2026-09-05', 5) // 5 Sep – 4 Oct

  it('includes both boundary days', () => {
    expect(isInCycle('2026-09-05', cycle)).toBe(true)
    expect(isInCycle('2026-10-04', cycle)).toBe(true)
    expect(isInCycle('2026-09-04', cycle)).toBe(false)
    expect(isInCycle('2026-10-05', cycle)).toBe(false)
  })

  it('counts 30 days for 5 Sep – 4 Oct', () => {
    expect(cycleLength(cycle)).toBe(30)
  })

  it('reports days remaining inclusively of today', () => {
    // On the first day of a 30-day cycle, 30 days remain.
    expect(daysRemaining(cycle, '2026-09-05')).toBe(30)
    expect(daysRemaining(cycle, '2026-10-04')).toBe(1)
    expect(daysRemaining(cycle, '2026-10-05')).toBe(0)
    // Before the cycle starts, the whole cycle remains.
    expect(daysRemaining(cycle, '2026-09-01')).toBe(30)
  })

  it('reports progress between 0 and 1', () => {
    expect(cycleProgress(cycle, '2026-09-04')).toBe(0)
    expect(cycleProgress(cycle, '2026-10-05')).toBe(1)
    const mid = cycleProgress(cycle, '2026-09-19')
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(0.6)
  })
})

describe('recentCycles', () => {
  it('returns cycles oldest first, ending with the current one', () => {
    const cycles = recentCycles('2026-09-26', 5, 3)
    expect(cycles).toHaveLength(3)
    expect(cycles[2].key).toBe('2026-09')
    expect(cycles[0].key).toBe('2026-07')
    // Chronological order.
    expect(cycles[0].start < cycles[1].start).toBe(true)
    expect(cycles[1].start < cycles[2].start).toBe(true)
  })
})

describe('cycleLabel', () => {
  it('names a plain calendar month', () => {
    expect(cycleLabel('2026-09-01', '2026-09-30')).toBe('2026年9月')
  })

  it('renders a range within one year without repeating the year', () => {
    expect(cycleLabel('2026-09-05', '2026-10-04')).toBe('9月5日 – 10月4日')
  })

  it('includes both years when the cycle spans a year boundary', () => {
    expect(cycleLabel('2025-12-05', '2026-01-04')).toBe('2025年12月5日 – 2026年1月4日')
  })
})

describe('validateCustomRange', () => {
  it('accepts a valid range', () => {
    expect(validateCustomRange('2026-09-01', '2026-09-30')).toBeNull()
  })

  it('accepts a single-day range', () => {
    expect(validateCustomRange('2026-09-01', '2026-09-01')).toBeNull()
  })

  it('rejects an inverted range with a Chinese message', () => {
    const message = validateCustomRange('2026-09-30', '2026-09-01')
    expect(message).toContain('开始日期')
    expect(message).toContain('晚于')
  })

  it('rejects malformed dates', () => {
    expect(validateCustomRange('', '2026-09-30')).not.toBeNull()
    expect(validateCustomRange('2026-09-01', 'not-a-date')).not.toBeNull()
  })

  it('rejects an absurdly long range', () => {
    expect(validateCustomRange('1900-01-01', '2026-12-31')).not.toBeNull()
  })
})

describe('CUSTOM_RANGE_PRESETS', () => {
  it('produces in-range, correctly ordered ranges', () => {
    for (const preset of CUSTOM_RANGE_PRESETS) {
      const range = preset.build('2026-09-26')
      expect(range.from <= range.to).toBe(true)
      // Presets use the wider allowance: "all time" deliberately opens at 1900
      // as an unbounded lower limit rather than claiming a century of history.
      expect(validateCustomRange(range.from, range.to, PRESET_MAX_DAYS)).toBeNull()
    }
  })

  it('resolves "last 30 days" inclusively of today', () => {
    const preset = CUSTOM_RANGE_PRESETS.find((item) => item.id === 'last30')
    const range = preset!.build('2026-09-26')
    expect(range.to).toBe('2026-09-26')
    expect(range.from).toBe('2026-08-28')
  })

  it('starts the week on Monday', () => {
    const preset = CUSTOM_RANGE_PRESETS.find((item) => item.id === 'thisWeek')
    // 26 Sep 2026 is a Saturday; the week runs Mon 21 Sep – Sun 27 Sep.
    const range = preset!.build('2026-09-26')
    expect(range.from).toBe('2026-09-21')
    expect(range.to).toBe('2026-09-27')
  })

  it('computes the calendar quarter', () => {
    const preset = CUSTOM_RANGE_PRESETS.find((item) => item.id === 'thisQuarter')
    expect(preset!.build('2026-09-26').from).toBe('2026-07-01')
    expect(preset!.build('2026-09-26').to).toBe('2026-09-30')
    expect(preset!.build('2026-02-10').from).toBe('2026-01-01')
  })
})

describe('customRangeLabel', () => {
  it('renders both endpoints', () => {
    const label = customRangeLabel('2026-09-01', '2026-09-30')
    expect(label).toContain('1')
    expect(label).toContain('30')
    expect(label).toContain('–')
  })
})

/** Local helper: the next calendar day, computed from date parts. */
function addOneDay(date: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const next = new Date(year, month - 1, day + 1)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}
