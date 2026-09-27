import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bucketGranularity,
  chooseBucketGranularity,
  describeSpan,
  floorInstant,
  formatAxisLabel,
  instantOf,
  isIntradayGranularity,
  minStepForCurrency,
  niceStep,
  nominalBucketMs,
  panViewport,
  stepInstant,
  timeTicks,
  toDateKey,
  toTimeKey,
  valueDomain,
  zoomViewport
} from '@shared/lib/chart-time'

/**
 * The continuous time axis, the two adaptive axes and the zoom transform.
 *
 * These are the parts of v1.5.1 most likely to be silently wrong: a zoom that drifts
 * by a pixel per notch looks fine in a screenshot, and an axis whose labels overlap
 * at one particular span looks fine at every other span. Everything here is pure, so
 * the behaviour is asserted rather than eyeballed.
 *
 * All fixtures use LOCAL date construction, exactly as the module does, so the suite
 * passes in any timezone rather than only in the one it was written in.
 */

const DAY = 86_400_000

const at = (date: string, time?: string): number => instantOf(date, time ?? null)

describe('instants are local, never UTC', () => {
  it('maps a date to its local midnight', () => {
    const ms = at('2026-09-25')
    const date = new Date(ms)
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(8)
    expect(date.getDate()).toBe(25)
    expect(date.getHours()).toBe(0)
  })

  it('round-trips a date and a time', () => {
    expect(toDateKey(at('2026-09-25', '12:14'))).toBe('2026-09-25')
    expect(toTimeKey(at('2026-09-25', '12:14'))).toBe('12:14')
  })

  it('gives an entry with no time its own midnight, and never a fabricated hour', () => {
    // "09:00" would be a claim the ledger cannot support. Midnight is the one instant
    // that is true of every entry in the day.
    expect(instantOf('2026-09-25', null)).toBe(instantOf('2026-09-25', '00:00'))
    expect(toTimeKey(instantOf('2026-09-25', null))).toBe('00:00')
  })

  it('survives a malformed time rather than producing a NaN instant', () => {
    expect(Number.isFinite(instantOf('2026-09-25', 'not a time'))).toBe(true)
    expect(instantOf('2026-09-25', 'not a time')).toBe(at('2026-09-25'))
  })
})

describe('bucket boundaries', () => {
  it('floors to the start of each calendar period', () => {
    const ms = at('2026-09-25', '13:45')

    expect(toDateKey(floorInstant(ms, 'year'))).toBe('2026-01-01')
    expect(toDateKey(floorInstant(ms, 'quarter'))).toBe('2026-07-01')
    expect(toDateKey(floorInstant(ms, 'month'))).toBe('2026-09-01')
    expect(toDateKey(floorInstant(ms, 'day'))).toBe('2026-09-25')
    expect(toTimeKey(floorInstant(ms, 'hour'))).toBe('13:00')
    expect(toTimeKey(floorInstant(ms, 'minute'))).toBe('13:45')
  })

  it('starts weeks on Monday, matching the ledger and the calendar', () => {
    // 2026-09-27 is a Sunday. A Sunday-start week would floor it to itself; the app
    // and the statistics page both say the week began on Monday the 21st.
    expect(toDateKey(floorInstant(at('2026-09-27'), 'week'))).toBe('2026-09-21')
    expect(toDateKey(floorInstant(at('2026-09-21'), 'week'))).toBe('2026-09-21')
    expect(toDateKey(floorInstant(at('2026-09-28'), 'week'))).toBe('2026-09-28')
  })

  it('steps to the next boundary without landing on a short period', () => {
    // 31 January plus one month is February, and February has no 31st. Clamping to
    // the 28th keeps the boundary a real date; `new Date(2026, 0, 32)` would
    // normalize FORWARD to 3 March and skip February outright.
    expect(toDateKey(stepInstant(at('2026-01-31'), 'month'))).toBe('2026-02-28')
    expect(toDateKey(stepInstant(at('2026-01-31'), 'month', 2))).toBe('2026-03-31')
    expect(toDateKey(stepInstant(at('2026-11-01'), 'quarter', 1))).toBe('2027-02-01')
    expect(toDateKey(stepInstant(at('2026-12-31'), 'year'))).toBe('2027-12-31')
    expect(toDateKey(stepInstant(at('2026-09-25'), 'week'))).toBe('2026-10-02')
    expect(stepInstant(at('2026-09-25', '13:00'), 'hour')).toBe(at('2026-09-25', '14:00'))
    expect(stepInstant(at('2026-09-25', '13:45'), 'minute')).toBe(at('2026-09-25', '13:46'))
  })

  it('keeps every stepped boundary a real boundary, at every level', () => {
    // The identity the tick generator relies on: walking boundaries from a floored
    // start must never produce a "boundary" that floors somewhere else, or the grid
    // would drift off the candles. Started on the 31st, which is where a naive month
    // step loses February.
    for (const granularity of ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'] as const) {
      for (const start of ['2026-09-25', '2026-01-31', '2026-03-31', '2028-02-29']) {
        let cursor = floorInstant(at(start, '13:45'), granularity)
        for (let i = 0; i < 40; i += 1) {
          expect(floorInstant(cursor, granularity)).toBe(cursor)
          const next = stepInstant(cursor, granularity, 1)
          expect(next).toBeGreaterThan(cursor)
          cursor = next
        }
      }
    }
  })

  it('special-cases nothing for a fractional stride it cannot express', () => {
    // `stepInstant` only takes integers; the density sweep must not pass 1.5 through.
    expect(stepInstant(at('2026-09-25'), 'day', 2)).toBe(at('2026-09-27'))
    expect(stepInstant(at('2026-09-25'), 'month', 3)).toBe(at('2026-12-25'))
  })
})

describe('bucketGranularity', () => {
  const plotWidth = 900

  it('never subdivides a ledger that has no times', () => {
    // THE constraint of the version. A bank CSV with no time column must stop at the
    // day, at every zoom, rather than piling every entry onto a fabricated 00:00.
    for (const spanMs of [DAY * 400, DAY * 60, DAY * 3, DAY, DAY / 4, DAY / 48]) {
      const granularity = bucketGranularity(spanMs, {
        transactionCount: 40,
        hasIntraday: false,
        plotWidth
      })
      expect(isIntradayGranularity(granularity)).toBe(false)
    }
  })

  it('reaches hours, then minutes, as a timed ledger is zoomed in', () => {
    const options = (count: number) => ({ transactionCount: count, hasIntraday: true, plotWidth })

    const at3Days = bucketGranularity(DAY * 3, options(40))
    expect(at3Days).toBe('day')

    // A day holding forty entries is roughly one per hour, so hours are the right unit
    // and minute candles would draw 1,400 empty ones around forty real ones.
    expect(bucketGranularity(DAY, options(40))).toBe('hour')

    // Six hours holding forty entries is one every nine minutes: an hourly candle holds
    // six of them and reads better than 360 minute candles with forty occupied.
    expect(bucketGranularity(DAY / 4, options(40))).toBe('hour')

    // Nine entries in an hour is one every seven minutes, so the hour bucket holds them
    // all and the axis stays readable; the minute bucket needs the density to justify it.
    expect(bucketGranularity(DAY / 24, options(9))).toBe('hour')
    // Forty entries in the same hour, and minutes are what separate 12:14 from 12:18.
    expect(bucketGranularity(DAY / 24, options(40))).toBe('minute')
    // A single entry is not a series, it is one candle.
    expect(bucketGranularity(DAY / 24, options(1))).toBe('day')
  })

  it('will not subdivide further than the data can fill', () => {
    // Four entries in an afternoon: hour candles hold them all, and asking for minute
    // buckets would be asking the axis to be mostly empty.
    expect(
      bucketGranularity(DAY / 4, { transactionCount: 4, hasIntraday: true, plotWidth })
    ).toBe('hour')
  })

  it('does not split a window that has nothing to split', () => {
    // One entry cannot define a sub-day interval, and a single candle per hour would be
    // 200 pixels of nothing.
    expect(bucketGranularity(DAY, { transactionCount: 1, hasIntraday: true, plotWidth })).toBe('day')
  })

  it('steps up the ladder as the window widens', () => {
    const sparse = { transactionCount: 30, hasIntraday: false, plotWidth }
    // A 45px candle is chunky; a 15px one is texture. The ladder stops at the coarsest
    // level that still clears ~35 candles of the plot, so a window where the week bucket
    // could only give 17 stays daily: seventeen weekly candles is a fine month view and a
    // poor five-month one.
    expect(bucketGranularity(DAY * 20, sparse)).toBe('day')
    expect(bucketGranularity(DAY * 120, sparse)).toBe('day')
    expect(bucketGranularity(DAY * 400, sparse)).toBe('week')
    expect(bucketGranularity(DAY * 1_500, sparse)).toBe('month')
    expect(bucketGranularity(DAY * 6_000, sparse)).toBe('quarter')
    expect(bucketGranularity(DAY * 30_000, sparse)).toBe('year')
  })

  it('fills the plot at every span, on the day-or-finer ladder', () => {
    // The shape invariant behind the fixtures above: whatever level is picked, the plot
    // ends up with a readable number of candles rather than four fat blocks or three
    // hundred hairlines.
    for (const days of [12, 20, 45, 90, 200, 400, 800, 1_500, 3_000, 6_000, 12_000, 40_000]) {
      const granularity = bucketGranularity(DAY * days, {
        transactionCount: 40,
        hasIntraday: false,
        plotWidth
      })
      const buckets = (DAY * days) / nominalBucketMs(granularity)
      expect(buckets).toBeGreaterThanOrEqual(12)
      expect(buckets).toBeLessThanOrEqual(380)
    }
  })

  it('keeps days rather than collapsing a short window into three weekly candles', () => {
    const options = { transactionCount: 30, hasIntraday: false, plotWidth }
    // 20 days at week granularity is three candles, which cannot show a fortnight's
    // shape, and the reader zoomed in to see the days.
    expect(bucketGranularity(DAY * 20, options)).toBe('day')
    // The week bucket only takes over once it can fill the plot: 57 candles over 400 days.
    expect(bucketGranularity(DAY * 400, options)).toBe('week')
  })

  it('is defined for a degenerate window', () => {
    // A zero span is not a large one: resolving it to the coarsest level would collapse
    // a one-afternoon ledger into a single candle.
    expect(chooseBucketGranularity(0, 40, ['day', 'week', 'year'])).toBe('day')
    expect(bucketGranularity(0, { transactionCount: 0, hasIntraday: false, plotWidth })).toBe('day')
    expect(chooseBucketGranularity(Number.NaN, 40, ['day', 'week', 'year'])).toBe('day')
  })
})

describe('cursor-anchored zoom', () => {
  const bounds = { from: at('2020-01-01'), to: at('2026-01-01') }

  it('holds the instant under the cursor at the same pixel ratio', () => {
    // The whole point of the gesture: point at 14 March, scroll, and 14 March is
    // still under the pointer. Anchoring on the centre instead is the bug this
    // replaces, and it is invisible in a screenshot.
    const viewport = { from: at('2025-01-01'), to: at('2025-12-31') }
    for (const ratio of [0, 0.25, 0.5, 0.73, 1]) {
      for (const factor of [0.5, 0.9, 1.1, 2, 3]) {
        const next = zoomViewport(viewport, factor, ratio, bounds)
        // A result clamped to the data's own limits is the zoom floor, not a failure to
        // anchor; the invariant only applies while there is room on both sides.
        if (next.from === bounds.from || next.to === bounds.to) continue
        const anchorBefore = viewport.from + ratio * (viewport.to - viewport.from)
        const anchorAfter = next.from + ratio * (next.to - next.from)
        expect(Math.abs(anchorAfter - anchorBefore)).toBeLessThan(1_000)
      }
    }
  })

  it('scales the span by the factor', () => {
    const viewport = { from: at('2025-01-01'), to: at('2025-02-01') }
    const zoomedIn = zoomViewport(viewport, 0.5, 0.5, bounds)
    expect(zoomedIn.to - zoomedIn.from).toBeCloseTo((viewport.to - viewport.from) / 2, -3)
  })

  it('stops at the full history rather than showing empty margin', () => {
    const next = zoomViewport(bounds, 8, 0.5, bounds)
    expect(next.from).toBe(bounds.from)
    expect(next.to).toBe(bounds.to)
  })

  it('cannot be zoomed out past the data, whatever edge the cursor is on', () => {
    // The clamp is what keeps an empty margin off the chart: zooming out past the
    // history would show a blank gutter that reads as missing records. The window must
    // still be positioned coherently inside the data afterwards.
    const bounds = { from: at('2020-01-01'), to: at('2026-01-01') }
    const viewport = { from: at('2025-06-01'), to: at('2025-07-01') }
    for (const ratio of [0, 0.5, 1]) {
      const next = zoomViewport(viewport, 40, ratio, bounds)
      expect(next.from).toBeGreaterThanOrEqual(bounds.from)
      expect(next.to).toBeLessThanOrEqual(bounds.to)
      expect(next.to).toBeGreaterThan(next.from)
      // 40x of a month is 1,200 days, which fits inside the six-year history.
      expect(next.to - next.from).toBeCloseTo(1_200 * DAY, -6)
    }
  })

  it('anchors the LEFT edge of the window when that is what the cursor is on', () => {
    // Ratio 0 with a modest zoomout, placed so the growing window still fits inside the
    // data: the instant under the cursor IS the window's left edge, so the new window
    // must start at it. Ratio 1 with a huge step is covered above, where the clamp
    // legitimately wins.
    const bounds = { from: at('2020-01-01'), to: at('2026-01-01') }
    const viewport = { from: at('2022-06-01'), to: at('2022-07-01') }
    const next = zoomViewport(viewport, 2, 0, bounds)
    expect(next.from).toBe(viewport.from)
    expect(next.to - next.from).toBeCloseTo(2 * (viewport.to - viewport.from), -6)
  })

  it('leaves a view that is already outside the data alone rather than inverting it', () => {
    // Defensive: a clamp that pushes `from` past `to` would produce a negative span and
    // a chart drawn backwards.
    const bounds = { from: at('2020-01-01'), to: at('2026-01-01') }
    const next = zoomViewport({ from: at('2030-01-01'), to: at('2030-02-01') }, 1, 0.5, bounds)
    expect(next.to).toBeGreaterThan(next.from)
  })

  it('keeps the requested span when it hits an edge', () => {
    // Shifting first and re-spanning after is what preserves the zoom rate: a reader
    // zooming out near the right-hand end of their history must not have the step
    // silently compressed by the clamp.
    const bounds = { from: at('2020-01-01'), to: at('2026-01-01') }
    const viewport = { from: at('2024-01-01'), to: at('2024-12-31') }
    const next = zoomViewport(viewport, 2, 1, bounds)
    expect(next.to - next.from).toBeCloseTo((viewport.to - viewport.from) * 2, -6)
    // The right edge was the anchor, and the grown window still fits, so it holds.
    expect(next.to).toBe(viewport.to)
  })

  it('will not zoom past one hour', () => {
    let viewport = bounds
    for (let i = 0; i < 200; i += 1) viewport = zoomViewport(viewport, 0.5, 0.5, bounds)
    expect(viewport.to - viewport.from).toBe(3_600_000)
  })

  it('clamps a cursor outside the plot instead of extrapolating', () => {
    const viewport = { from: at('2025-01-01'), to: at('2025-12-31') }
    const left = zoomViewport(viewport, 0.5, -3, bounds)
    const right = zoomViewport(viewport, 0.5, 4, bounds)
    expect(left.to - left.from).toBeCloseTo(right.to - right.from, -3)
  })
})

describe('panning', () => {
  const bounds = { from: at('2020-01-01'), to: at('2026-01-01') }

  it('moves by exactly the pixel delta', () => {
    const viewport = { from: at('2025-01-01'), to: at('2025-02-01') }
    const pxPerMs = 900 / (viewport.to - viewport.from)
    const next = panViewport(viewport, 90, pxPerMs, bounds)
    expect(viewport.from - next.from).toBeCloseTo((viewport.to - viewport.from) / 10, -3)
    expect(next.to - next.from).toBe(viewport.to - viewport.from)
  })

  it('cannot be dragged off the data at either end', () => {
    // The SHIFT is clamped, not the resulting `from`. Clamping `from` alone leaves the
    // window sticking out past the far edge — the drag stops, but the chart is showing
    // weeks that hold no records.
    const viewport = { from: at('2022-01-01'), to: at('2022-02-01') }
    const pxPerMs = 900 / (viewport.to - viewport.from)
    const span = viewport.to - viewport.from
    // `deltaPx` is how far the content was DRAGGED, so a negative delta is a drag to the
    // LEFT and reveals later dates.
    const px = (days: number): number => days * DAY * pxPerMs
    const later = panViewport(viewport, -px(2_500), pxPerMs, bounds)
    const earlier = panViewport(viewport, px(2_500), pxPerMs, bounds)
    expect(later.from).toBe(bounds.to - span)
    expect(later.to).toBe(bounds.to)
    expect(earlier.from).toBe(bounds.from)
    expect(earlier.to).toBe(bounds.from + span)
  })

  it('does nothing when the scale is degenerate', () => {
    const viewport = { from: bounds.from, to: bounds.to }
    expect(panViewport(viewport, 100, 0, bounds)).toBe(viewport)
  })
})

describe('valueDomain — the axis that must not start at zero', () => {
  it('fits the visible window, which is what makes a small amount visible', () => {
    // THE micro-view requirement, stated as arithmetic. A RM 5,000 balance that moves
    // by RM 4.80 spans 0.096% of a zero-based axis — under a pixel on an 800px plot,
    // so the transaction is drawn and nobody can see it.
    const zeroBased = valueDomain(0, 500_000)
    const fitted = valueDomain(499_520, 500_000)

    const pixelHeight = (domain: { min: number; max: number }, low: number, high: number): number =>
      ((high - low) / (domain.max - domain.min)) * 300

    expect(pixelHeight(zeroBased, 499_520, 500_000)).toBeLessThan(1)
    expect(pixelHeight(fitted, 499_520, 500_000)).toBeGreaterThan(20)
  })

  it('keeps a handful of round ticks, never a wall of them', () => {
    const cases: Array<[number, number]> = [
      [0, 10_000_000],
      [0, 100],
      [499_900, 500_100],
      [-50_000, 50_000],
      [500_000, 700_000],
      [1_140, 1_260]
    ]
    for (const [low, high] of cases) {
      const domain = valueDomain(low, high)
      expect(domain.ticks.length).toBeGreaterThanOrEqual(4)
      expect(domain.ticks.length).toBeLessThanOrEqual(11)
      for (const tick of domain.ticks) {
        expect(tick).toBeGreaterThanOrEqual(domain.min)
        expect(tick).toBeLessThanOrEqual(domain.max)
      }
    }
  })

  it('accepts a coarse axis when the range has no room for a finer one', () => {
    // One minor unit has no round numbers between its ends, so two labels is the
    // honest answer — adding more would print the same number twice.
    const domain = valueDomain(12_345_678, 12_345_679, { minStep: 1 })
    expect(domain.step).toBeGreaterThanOrEqual(1)
    expect(new Set(domain.ticks).size).toBe(domain.ticks.length)
    expect(domain.ticks.length).toBeGreaterThanOrEqual(2)
  })

  it('lands the ticks on round numbers', () => {
    const domain = valueDomain(0, 8_432_100)
    for (const tick of domain.ticks) expect(tick % domain.step).toBe(0)
    expect(niceStep(8_432)).toBe(10_000)
    expect(niceStep(1)).toBe(1)
    // Half a minor unit is not an interval the money can be printed at.
    expect(niceStep(0.4)).toBe(1)
    expect(niceStep(0.4, 0.01)).toBeCloseTo(0.5, 6)
  })

  it('never lets the step fall below what the currency can print', () => {
    const domain = valueDomain(1, 2, { minStep: 1 })
    expect(domain.step).toBeGreaterThanOrEqual(1)
    expect(new Set(domain.ticks).size).toBe(domain.ticks.length)
  })

  it('lets zero in when the data reaches it', () => {
    expect(valueDomain(0, 500_000).min).toBe(0)
    expect(valueDomain(-100, 500_000).min).toBeLessThanOrEqual(0)
  })

  it('lets zero in when excluding it would misstate the distance', () => {
    // A balance of RM 12 graphed across RM 11.40..RM 12.60 with no visible zero looks
    // like a fortune changing hands, so zero joins the axis.
    expect(valueDomain(140, 1_260).min).toBe(0)
    // At a quarter of the upper bound the window is far enough from zero that the fit
    // is worth more than the anchor: RM 4,000 against RM 8,000 is not "near nothing".
    expect(valueDomain(400_000, 800_000).min).toBeGreaterThan(0)
  })

  it('keeps a high balance off the zero floor', () => {
    // RM 5,000 is nowhere near zero relative to its own range, so the axis is fitted.
    const domain = valueDomain(499_900, 500_100)
    expect(domain.min).toBeGreaterThan(400_000)
  })

  it('invents a symmetric window for a perfectly flat series', () => {
    const domain = valueDomain(500_000, 500_000)
    expect(domain.max).toBeGreaterThan(500_000)
    expect(domain.min).toBeLessThan(500_000)
    expect(domain.ticks.length).toBeGreaterThanOrEqual(2)
  })

  it('never emits a step smaller than the currency can print', () => {
    const domain = valueDomain(500_000, 500_001, { minStep: 1 })
    expect(domain.step).toBeGreaterThanOrEqual(1)
    expect(new Set(domain.ticks).size).toBe(domain.ticks.length)
  })

  it('knows a two-decimal currency from a zero-decimal one', () => {
    expect(minStepForCurrency('CNY')).toBe(1)
    expect(minStepForCurrency('MYR')).toBe(1)
    expect(minStepForCurrency('JPY')).toBe(1)
  })
})

describe('adaptive time axis', () => {
  const plotLeft = 0
  const plotWidth = 900

  const ticksFor = (from: number, to: number, granularity: Parameters<typeof timeTicks>[0]['granularity']) =>
    timeTicks({ from, to, granularity, plotLeft, plotWidth })

  it('labels a decade with years', () => {
    const ticks = ticksFor(at('2016-01-01'), at('2026-01-01'), 'year')
    const labels = ticks.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(labels.length).toBeGreaterThanOrEqual(5)
    expect(labels.length).toBeLessThanOrEqual(12)
    expect(labels.every((label) => /^\d{4}$/.test(label))).toBe(true)
    expect(labels).toContain('2016')
  })

  it('labels a year with months, and crossfades in from a wider view', () => {
    const ticks = ticksFor(at('2026-01-01'), at('2027-01-01'), 'day')
    const labels = ticks.map((tick) => tick.label).filter((label): label is string => label !== null)
    /*
      The MONTH level fits this window, so the year is named in months.

      January reads "Q1" rather than "1月": both levels land on 1 January, and the coarser
      name wins that tick — which is the crossfade working, not a gap. The remaining eleven
      months carry the month names, so the axis reads as a year of months with a quarter
      marker where a quarter begins.
    */
    expect(labels).toContain('2月')
    expect(labels).toContain('8月')
    expect(labels).toContain('Q1')
    expect(labels.length).toBeGreaterThanOrEqual(11)
  })

  it('crossfades to the coarser level as the window widens', () => {
    /*
      The same pair of levels, handing over.

      Over one year the months are named and the quarter boundaries are faint; over a decade
      the months cannot fit the plot at all and the names that survive are years. There is no
      span at which the axis is unlabelled — that gradient is the whole "blurred to precise"
      behaviour the version exists to deliver.
    */
    const year = ticksFor(at('2026-01-01'), at('2027-01-01'), 'day')
    const yearLabels = year.map((t) => t.label).filter((label): label is string => label !== null)
    expect(yearLabels).toContain('2月')
    expect(yearLabels).toContain('Q1')

    const decade = ticksFor(at('2016-01-01'), at('2026-01-01'), 'day')
    const decadeLabels = decade.map((t) => t.label).filter((label): label is string => label !== null)
    expect(decadeLabels.length).toBeGreaterThanOrEqual(8)
    expect(decadeLabels.every((label) => /^\d{4}$/.test(label))).toBe(true)
  })

  it('labels a month with days', () => {
    const ticks = ticksFor(at('2026-09-01'), at('2026-10-01'), 'day')
    const labels = ticks.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(labels.length).toBeGreaterThanOrEqual(6)
    // The month is on the axis once, as the coarser row; the day labels carry only the
    // day, so the axis does not repeat "09/" a dozen times.
    const dayOnly = labels.filter((label) => /^\d+$/.test(label))
    expect(dayOnly.length).toBeGreaterThanOrEqual(6)
    expect(dayOnly).toContain('15')
  })

  it('labels hours once the window is intraday', () => {
    const ticks = ticksFor(at('2026-09-25', '09:00'), at('2026-09-25', '21:00'), 'hour')
    const labels = ticks.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(labels).toContain('12:00')
    expect(labels.every((label) => /^\d\d:00$/.test(label))).toBe(true)
  })

  it('labels minutes at maximum zoom', () => {
    const ticks = ticksFor(at('2026-09-25', '12:00'), at('2026-09-25', '13:00'), 'minute')
    const labels = ticks.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(labels.length).toBeGreaterThanOrEqual(6)
    expect(labels.every((label) => /^\d\d:\d\d$/.test(label))).toBe(true)
  })

  it('never lets two labels overlap, at any span', () => {
    /*
      The invariant that matters most, swept rather than spot-checked.

      A collision only appears at one particular span, so a single fixture proves
      nothing. This walks a factor-of-1.15 zoom from a decade to an hour and asserts the
      gap for every frame a reader could actually scroll through.
    */
    const end = at('2026-09-25', '21:00')
    for (let span = 3_650 * DAY; span > 3_600_000; span /= 1.15) {
      const from = end - span
      for (const granularity of ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'] as const) {
        const ticks = ticksFor(from, end, granularity)
        const labelled = ticks.filter((tick) => tick.label !== null)
        for (let i = 1; i < labelled.length; i += 1) {
          /*
            Twenty pixels, not the fifty-two the placement aims for.

            A finer level may place a label in a gap a coarser one left, and the gap it
            finds is whatever was free — so the guarantee is "no overlap", not "every
            label is 52px from its neighbour". A minute label needs about 30px and two
            numeric day labels about 20, so anything above that is legible.
          */
          expect(labelled[i].x - labelled[i - 1].x).toBeGreaterThan(20)
        }
      }
    }
  })

  it('never leaves the axis unlabelled while there is room for a label', () => {
    const end = at('2026-09-25', '21:00')
    for (let span = 3_650 * DAY; span > 3_600_000; span /= 1.3) {
      for (const granularity of ['year', 'month', 'day', 'hour', 'minute'] as const) {
        const ticks = ticksFor(end - span, end, granularity)
        expect(ticks.some((tick) => tick.label !== null)).toBe(true)
      }
    }
  })

  it('describes a wide window in one naming system, not several', () => {
    /*
      The failure this guards.

      Ten years of daily candles, named by the DAY level: the only boundaries available were
      weekly gridlines, so the axis came out as "01/04, 08/08, 03/13, 10/16…" — seventeen
      week-ending dates from ten different years, in an order that looked random because
      nothing on the axis said which year any of them belonged to. The fix is that the levels
      follow the WINDOW rather than the candle size, so a decade is named in years.
    */
    const ticks = ticksFor(at('2016-01-01'), at('2026-01-01'), 'day')
    const labels = ticks.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(labels.length).toBeGreaterThanOrEqual(8)
    expect(labels.every((label) => /^\d{4}$/.test(label))).toBe(true)
    expect(labels).toContain('2020')
  })

  it('names a year in months and a month in days, without being told which', () => {
    // The same window-follows rule at two other scales, so the behaviour is a rule rather
    // than a special case for decades.
    const year = ticksFor(at('2026-01-01'), at('2027-01-01'), 'day')
    const yearLabels = year.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(yearLabels.some((label) => /^\d+月$/.test(label))).toBe(true)

    const month = ticksFor(at('2026-09-01'), at('2026-10-01'), 'day')
    const monthLabels = month.map((tick) => tick.label).filter((label): label is string => label !== null)
    expect(monthLabels.filter((label) => /^\d+$/.test(label)).length).toBeGreaterThanOrEqual(6)
  })

  it('keeps every label inside the plot', () => {
    const ticks = ticksFor(at('2026-01-01'), at('2027-01-01'), 'day')
    for (const tick of ticks) {
      if (tick.label === null) continue
      expect(tick.x).toBeGreaterThanOrEqual(plotLeft - 1)
      expect(tick.x).toBeLessThanOrEqual(plotLeft + plotWidth + 1)
    }
  })

  it('thins the gridlines when the candle size would paint a solid block', () => {
    // Three thousand daily gridlines across 900px is a fill, not a grid. The cadence steps
    // up to the first level whose boundaries are actually separable — and stops at the
    // coarsest NAMEABLE level, so the axis always has something on it.
    const short = ticksFor(at('2026-09-01'), at('2026-10-01'), 'day')
    expect(short.length).toBeLessThan(40)
    const decade = ticksFor(at('2016-01-01'), at('2026-01-01'), 'day')
    expect(decade.length).toBeLessThan(600)
    expect(decade.length).toBeGreaterThan(8)
    expect(decade.some((tick) => tick.label !== null)).toBe(true)
  })

  it('weights a coarser boundary more heavily than a candle boundary', () => {
    // A decade of daily candles thins the grid to a weekly cadence, and the year and
    // month boundaries still have to stand out from it — the visual hierarchy is what
    // turns a field of lines into a readable axis.
    const ticks = ticksFor(at('2016-01-01'), at('2026-01-01'), 'day')
    const weights = new Set(ticks.map((tick) => tick.weight))
    expect(ticks.some((tick) => tick.weight === 1)).toBe(true)
    expect(ticks.some((tick) => tick.weight < 0.5)).toBe(true)
    expect(weights.size).toBeGreaterThanOrEqual(3)
  })

  it('is empty for a degenerate window rather than throwing', () => {
    expect(timeTicks({ from: 5, to: 5, granularity: 'day', plotLeft: 0, plotWidth: 900 })).toEqual([])
    expect(timeTicks({ from: 0, to: DAY, granularity: 'day', plotLeft: 0, plotWidth: 0 })).toEqual([])
  })
})

describe('axis label formatting', () => {
  it('disambiguates a month by how wide the window is', () => {
    // "6月" is unambiguous over a year and useless over three.
    expect(formatAxisLabel(at('2026-06-01'), 'month', { spanDays: 30 })).toBe('6月')
    expect(formatAxisLabel(at('2026-06-01'), 'month', { spanDays: 900 })).toBe('2026-06')
  })

  it('spells out the year on a long day axis', () => {
    expect(formatAxisLabel(at('2026-06-01'), 'day', { spanDays: 30 })).toBe('1')
    expect(formatAxisLabel(at('2026-06-15'), 'day', { spanDays: 30 })).toBe('15')
    expect(formatAxisLabel(at('2026-06-01'), 'day', { spanDays: 200 })).toBe('06/01')
    expect(formatAxisLabel(at('2026-06-01'), 'day', { spanDays: 900 })).toBe('2026-06')
  })

  it('labels hours and minutes without a date, which the axis tag carries', () => {
    expect(formatAxisLabel(at('2026-06-01', '09:00'), 'hour', { spanDays: 0.5 })).toBe('09:00')
    expect(formatAxisLabel(at('2026-06-01', '09:05'), 'minute', { spanDays: 0.04 })).toBe('09:05')
  })
})

describe('describeSpan', () => {
  it('names the window the way a reader would', () => {
    expect(describeSpan(10 * 365 * DAY)).toBe('10年')
    expect(describeSpan(400 * DAY)).toBe('13个月')
    expect(describeSpan(90 * DAY)).toBe('3个月')
    expect(describeSpan(21 * DAY)).toBe('3周')
    expect(describeSpan(5 * DAY)).toBe('5天')
    expect(describeSpan(6 * 3_600_000)).toBe('6小时')
    expect(describeSpan(90 * 60_000)).toBe('90分钟')
    expect(describeSpan(1)).toBe('1分钟')
  })
})

describe('timezone independence', () => {
  const original = process.env.TZ
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles'
  })
  afterEach(() => {
    process.env.TZ = original
  })

  it('reads a date as the local day it names, not the UTC one', () => {
    // The bug this guards: `Date.parse('2026-09-25')` is UTC midnight, which in
    // Los Angeles is the 24th, and a chart built on it files every first-of-month
    // transaction under the previous month.
    expect(toDateKey(at('2026-09-25'))).toBe('2026-09-25')
    expect(toDateKey(floorInstant(at('2026-09-01'), 'month'))).toBe('2026-09-01')
    expect(toDateKey(floorInstant(at('2026-01-01'), 'year'))).toBe('2026-01-01')
  })
})
