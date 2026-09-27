import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

import {
  bucketGranularity,
  describeSpan,
  floorInstant,
  instantOf,
  isIntradayGranularity,
  minStepForCurrency,
  panViewport,
  stepInstant,
  timeTicks,
  toTimeKey,
  valueDomain,
  zoomViewport
} from '@shared/lib/chart-time'
import type { ValueDomain, Viewport } from '@shared/lib/chart-time'
import { T } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'
import type { CashflowTransactionMarker, KlineBucket, KlineGranularity, KlineSeries } from '@shared/types'

/**
 * CashflowChart — the cashflow terminal's canvas layer.
 *
 * TWO PANELS, ONE AXIS
 * --------------------
 * The balance K-line and the cash-activity bars are separate panels:
 *
 *     ┌──────────────────────────────────────────────┐
 *     │  BALANCE K-LINE          OHLC · wick · MA    │  ~71%
 *     ├──────────────────────────────────────────────┤  1px divider
 *     │  CASH ACTIVITY           income / expense    │  ~29%
 *     └──────────────────────────────────────────────┘
 *        time axis, drawn once, shared
 *
 * They share exactly one thing — the time axis — and share it absolutely. One
 * `Viewport` in milliseconds, one tick array, one crosshair. Two panels with their
 * own time ranges is the failure this shape exists to prevent: a K-line scrolled to
 * September above bars still showing August is a chart that lies about cause.
 *
 * Everything else is deliberately NOT shared:
 *
 *   - **Y axis.** Balance is a stock, activity is a flow; they are not the same
 *     quantity. A RM 3,000 salary into a RM 8,000 account would, on a shared axis,
 *     flatten the balance to a line. On separate axes the balance keeps its shape
 *     and the salary gets a bar of its own height.
 *   - **Value range.** The balance axis is fitted to the visible balance window —
 *     crucially NOT to zero, see `valueDomain` — while the activity axis is fitted
 *     to zero, because a flow chart that does not start at zero misstates every bar.
 *   - **Canvas and draw pass.** One canvas per panel, so repainting the bars can
 *     never smear the candles, and the divider between them is a real 1px gap
 *     rather than a line painted over one picture.
 *
 * CONTINUOUS, CURSOR-ANCHORED ZOOM
 * --------------------------------
 * Zoom is `span × f` about the instant under the pointer, so what the pointer is
 * on stays under the pointer for the whole gesture. It is CONTINUOUS: no ladder of
 * zoom levels, only the time range the reader has scrolled to, with the candle size
 * derived from that range rather than chosen from a menu.
 *
 * WHY CANVAS
 * ----------
 * A decade of daily candles is ~3,650 bodies, each with a wick and a handful of
 * markers — tens of thousands of primitives. As DOM nodes that is a stall on pan;
 * as canvas strokes it is one frame. The hover card is HTML, because it is text and
 * tables and re-implementing text layout in canvas would buy nothing.
 *
 * This file draws; it does not decide. Settings live in `KlinePanel`, which also
 * renders the header, the controls, the zoom badge and the hover card.
 */

/**
 * Interactive radius for a transaction, in px.
 *
 * TWENTY, against a marker that is often a single pixel tall. This gap is the whole
 * reason a RM 0.50 entry on a RM 100,000 account is clickable: at any zoom where
 * that transaction is under a pixel the reader cannot aim AT it, so aiming is done
 * against the DATA — the true pixel position of the true balance — with a radius
 * wide enough to forgive the pointer. Shrinking the marker to match its importance
 * while keeping its hit area generous is the rule; the reverse (a fat marker for a
 * tiny amount) would be a chart that lies about the money.
 */
const HIT_RADIUS_PX = 20

/** How close two entries must be before their markers are pulled apart. */
const STACK_PX = 3

const ACTIVITY_MIN_PX = 110
const BALANCE_MIN_PX = 150

/** Nominal split of the chart's height, before the minimums are enforced. */
const BALANCE_SHARE = 0.715

/** Value-axis gutter, on the right, where the amount labels live. */
const AXIS_W = 76
/** Height of the shared time axis at the bottom of the activity panel. */
const TIME_AXIS_H = 20

interface Palette {
  up: string
  down: string
  neutral: string
  marker: string
  markerHover: string
  grid: string
  axis: string
  crosshair: string
  background: string
  activity: string
  text: string
  ma: string[]
}

const FALLBACK_PALETTE: Palette = {
  up: '#16C784',
  down: '#F0616D',
  neutral: '#8A8A93',
  marker: 'rgba(255,255,255,0.34)',
  markerHover: '#F0B90B',
  grid: '#1A1A1E',
  axis: '#6E6E77',
  crosshair: '#8A8A93',
  background: '#121214',
  activity: '#4E9CF5',
  text: '#F2F2F4',
  ma: ['#F0B90B', '#4E9CF5', '#C77FA8', '#45C4B0', '#9A8CF0']
}

function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element)
  const get = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    up: get('--market-up', '#16C784'),
    down: get('--market-down', '#F0616D'),
    neutral: get('--market-neutral', '#8A8A93'),
    marker: get('--market-marker', 'rgba(255,255,255,0.34)'),
    markerHover: get('--market-marker-hover', '#F0B90B'),
    grid: get('--market-grid', '#1A1A1E'),
    axis: get('--market-axis', '#6E6E77'),
    crosshair: get('--market-crosshair', '#8A8A93'),
    background: get('--bg-surface', '#121214'),
    activity: get('--market-activity', '#4E9CF5'),
    text: get('--text-primary', '#F2F2F4'),
    ma: [
      get('--market-ma-1', '#F0B90B'),
      get('--market-ma-2', '#4E9CF5'),
      get('--market-ma-3', '#C77FA8'),
      get('--market-ma-4', '#45C4B0'),
      get('--market-ma-5', '#9A8CF0')
    ]
  }
}

/* -------------------------------------------------------------------------- */
/* shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One transaction resolved to pixels. `x`/`y` are the TRUE positions. */
export interface ChartMarker {
  marker: CashflowTransactionMarker
  instant: number
  x: number
  y: number
  /** Drawing x. Differs from `x` only for entries coincident in both axes. */
  drawX: number
  hovered: boolean
}

/** One candle resolved to pixels. */
export interface CandleGeometry {
  bucket: KlineBucket
  instant: number
  x: number
  bodyLeft: number
  bodyRight: number
  yOpen: number
  yClose: number
  yHigh: number
  yLow: number
  up: boolean
  down: boolean
}

/** What is under the pointer. Resolved once, consumed by both panels and the tooltip. */
export interface HoverState {
  /** Pointer, in chart-local px. */
  px: number
  py: number
  panel: 'balance' | 'activity'
  /** x the vertical crosshair is drawn at, after snapping. */
  crossX: number
  marker: ChartMarker | null
  candle: CandleGeometry | null
  /** Value under the pointer on the hovered panel's own axis. Null in the gutter. */
  value: number | null
  /** Time under the vertical crosshair. */
  instant: number
}

/** Everything the caller needs to render a header and a hover card consistently. */
export interface ChartFrame {
  viewport: Viewport
  granularity: KlineGranularity
  /** Human name of the visible span, e.g. "3个月". */
  zoomLabel: string
  /** Plot geometry, so a verification run can convert pixels to instants exactly. */
  geometry: { plotLeft: number; plotRight: number; balanceTop: number; balanceBottom: number; activityTop: number; activityBottom: number }
  buckets: KlineBucket[]
  candles: CandleGeometry[]
  markers: ChartMarker[]
  balance: ValueDomain
  activity: ValueDomain
  hover: HoverState | null
  /** MA values at the hovered (or last) bucket, keyed by window. */
  ma: Array<{ windowSize: number; value: number | null }>
}

/**
 * An instruction from the caller to move the view, consumed once.
 *
 * `token` only has to CHANGE — it is what makes "show everything" work as a button
 * the reader can press twice. `fromMs`/`toMs` pin both edges when supplied, which is
 * what a custom range needs; a bare `anchorMs` keeps the current zoom level and
 * centres on a day, which is what the date picker needs.
 */
export interface ViewRequest {
  token: number
  anchorMs?: number
  fromMs?: number
  toMs?: number
}

export interface CashflowChartProps {
  series: KlineSeries
  displayCurrency: string
  maWindows: number[]
  activityMode: 'flow' | 'count'
  height?: number
  onFrame?: (frame: ChartFrame | null) => void
  onClickBucket?: (bucket: KlineBucket) => void
  onClickMarker?: (marker: CashflowTransactionMarker) => void
  /** Jump the view: everything, an explicit span, or a day at the current zoom. */
  viewRequest?: ViewRequest | null
}

/* -------------------------------------------------------------------------- */
/* pure geometry                                                              */
/* -------------------------------------------------------------------------- */

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 'YYYY-MM-DD' of the local day containing `ms`. */
export function keyOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** A bucket plus the instant it starts at, which is what the axis is drawn on. */
type InstantBucket = KlineBucket & { instant: number }

/**
 * Roll the daily spine up into buckets, carrying an instant alongside each date.
 *
 * Deliberately a roll-up of the daily rows rather than a re-derivation: the main
 * process already emitted every day gaplessly with the day's TRUE intraday extremes
 * folded in, so re-bucketing from it stays exact — balances are stocks, and flows
 * travel as a rounded running total, so summing dailies reproduces the bucket the
 * service would have produced for the same span. `tests/kline.test.ts` asserts that
 * equality; this function is the thing to blame if it ever stops holding.
 */
export function bucketDaily(daily: KlineBucket[], granularity: KlineGranularity): InstantBucket[] {
  const out: InstantBucket[] = []
  if (daily.length === 0) return out

  if (granularity === 'day') {
    for (const day of daily) out.push({ ...day, instant: instantOf(day.date, null) })
    return out
  }

  for (const day of daily) {
    const keyMs = floorInstant(instantOf(day.date, null), granularity)
    const last = out.length > 0 ? out[out.length - 1] : null

    if (last && last.instant === keyMs) {
      last.balanceClose = day.balanceClose
      if (day.balanceHigh > last.balanceHigh) last.balanceHigh = day.balanceHigh
      if (day.balanceLow < last.balanceLow) last.balanceLow = day.balanceLow
      last.income += day.income
      last.expense += day.expense
      last.net += day.net
      last.transactionCount += day.transactionCount
      last.hasUnconverted = last.hasUnconverted || day.hasUnconverted
      continue
    }

    out.push({
      date: keyOf(keyMs),
      label: '',
      balanceOpen: last ? last.balanceClose : day.balanceOpen,
      balanceClose: day.balanceClose,
      balanceHigh: day.balanceHigh,
      balanceLow: day.balanceLow,
      income: day.income,
      expense: day.expense,
      net: day.net,
      transactionCount: day.transactionCount,
      hasUnconverted: day.hasUnconverted,
      instant: keyMs
    })
  }
  return out
}

/**
 * Sub-day candles, built from the instants the transactions actually happened at.
 *
 * THIS IS THE MICRO VIEW, AND IT IS DERIVED, NOT INVENTED
 * ------------------------------------------------------
 * The ledger stores a calendar day per row and, optionally, a time, so below one
 * day there is no stored balance series to read — but there IS a real one to
 * reconstruct: each entry carries the balance it produced, so the balance between
 * two entries is known exactly, and a period opens at the previous period's close.
 *
 * What is deliberately NOT done:
 *
 *   - No entry without a recorded time is given one. It contributes to the day's
 *     movement but not to any hour, because "somewhere in this day" is not "09:00".
 *   - No sub-day bucket is built for a ledger that cannot support one.
 *     `bucketGranularity` refuses intraday granularity for a day-only history
 *     before this function is reached.
 *   - No balance is interpolated across a day whose entries cannot be placed. Such a
 *     day lands its whole net movement on its own boundary, so the curve stays
 *     continuous while the day's interior stays empty rather than wrong.
 */
export function intradayCandles(
  daily: KlineBucket[],
  dayMarkers: Record<string, CashflowTransactionMarker[]>,
  granularity: KlineGranularity,
  viewport: Viewport
): InstantBucket[] {
  const byDate = new Map<string, KlineBucket>()
  for (const day of daily) byDate.set(day.date, day)

  const out: InstantBucket[] = []
  let carried: number | null = null

  const firstDay = floorInstant(viewport.from, 'day')
  const lastDay = floorInstant(viewport.to, 'day')

  for (let dayStart = firstDay; dayStart <= lastDay; dayStart = stepInstant(dayStart, 'day', 1)) {
    const key = keyOf(dayStart)
    const day = byDate.get(key) ?? null
    const open: number = carried ?? day?.balanceOpen ?? 0
    const dayClose: number = day ? day.balanceClose : open

    // Anchors: the balance after every entry in this day that can be positioned.
    const anchors: Array<{ instant: number; balanceAfter: number; marker: CashflowTransactionMarker }> = []
    let running = open
    for (const marker of dayMarkers[key] ?? []) {
      if (marker.time === null || marker.convertedDelta === null) continue
      running += marker.convertedDelta
      anchors.push({ instant: instantOf(key, marker.time), balanceAfter: running, marker })
    }
    anchors.sort((a, b) => a.instant - b.instant || a.marker.transactionId - b.marker.transactionId)

    const dayEnd = dayStart + 86_400_000
    let cursor = dayStart
    let lastClose = open
    let guard = 0
    while (cursor < dayEnd && guard < 200) {
      guard += 1
      const next = stepInstant(cursor, granularity, 1)
      let close = lastClose
      let high = lastClose
      let low = lastClose
      let count = 0
      for (const anchor of anchors) {
        if (anchor.instant < cursor || anchor.instant >= next) continue
        close = anchor.balanceAfter
        if (close > high) high = close
        if (close < low) low = close
        count += 1
      }
      // The final bucket of the day lands on the day's own close, so the intraday
      // curve meets the daily candle it came from regardless of entries that could
      // not be positioned.
      if (next >= dayEnd) close = dayClose
      if (close > high) high = close
      if (close < low) low = close

      out.push({
        date: keyOf(cursor),
        label: '',
        balanceOpen: lastClose,
        balanceClose: close,
        balanceHigh: high,
        balanceLow: low,
        income: 0,
        expense: 0,
        net: close - lastClose,
        transactionCount: count,
        hasUnconverted: false,
        instant: cursor
      })
      lastClose = close
      cursor = next
    }

    carried = dayClose
  }

  return out
}

function movingAverage(values: number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  if (window <= 0 || values.length < window) return out
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    if (i >= window - 1) out[i] = Math.round(sum / window)
  }
  return out
}

/**
 * Every entry in the window, at its true position, with stacks pulled apart.
 *
 * The x position is the transaction's own instant and the y position is the balance
 * it produced — both true, both round-trippable to the numbers in the tooltip. Only
 * when two entries land within `STACK_PX` in BOTH axes are they nudged apart
 * horizontally, which is the one case where a true position is unreadable: two
 * hairlines on top of each other look like one entry, and the second could never be
 * clicked. The nudge is capped at ±6px, and `x` — used for the crosshair readout and
 * for hit distance — is left untouched, so nothing the reader is told about WHEN a
 * transaction happened is affected by it.
 */
export function buildMarkers(
  dayMarkers: Record<string, CashflowTransactionMarker[]>,
  viewport: Viewport,
  timeToX: (ms: number) => number,
  balanceToY: (value: number) => number,
  hoveredId: number | null
): ChartMarker[] {
  const fromKey = keyOf(floorInstant(viewport.from, 'day'))
  const toKey = keyOf(floorInstant(viewport.to, 'day'))
  const out: ChartMarker[] = []

  for (const [key, list] of Object.entries(dayMarkers)) {
    if (key < fromKey || key > toKey) continue
    for (const marker of list) {
      if (marker.balanceAfter === null) continue
      const instant = instantOf(key, marker.time)
      if (instant < viewport.from || instant > viewport.to) continue
      const x = timeToX(instant)
      out.push({
        marker,
        instant,
        x,
        y: balanceToY(marker.balanceAfter),
        drawX: x,
        hovered: marker.transactionId === hoveredId
      })
    }
  }

  out.sort((a, b) => a.instant - b.instant || a.marker.transactionId - b.marker.transactionId)

  for (let i = 1; i < out.length; i += 1) {
    let offset = 0
    for (let j = i - 1; j >= 0 && i - j <= 8; j -= 1) {
      const sameRow = Math.abs(out[i].y - out[j].y) <= 2
      const sameColumn = Math.abs(out[i].x - out[j].x) <= STACK_PX
      if (!sameRow || !sameColumn) continue
      offset = Math.abs(offset) + STACK_PX
      offset = j % 2 === 0 ? offset : -offset
    }
    if (offset !== 0) out[i].drawX = out[i].x + Math.max(-6, Math.min(6, offset))
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* component                                                                  */
/* -------------------------------------------------------------------------- */

export function CashflowChart({
  series,
  displayCurrency,
  maWindows,
  activityMode,
  height = 470,
  onFrame,
  onClickBucket,
  onClickMarker,
  viewRequest
}: CashflowChartProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const balanceRef = useRef<HTMLCanvasElement | null>(null)
  const activityRef = useRef<HTMLCanvasElement | null>(null)
  const balanceBoxRef = useRef<HTMLDivElement | null>(null)
  const activityBoxRef = useRef<HTMLDivElement | null>(null)

  const [width, setWidth] = useState(0)
  const [measured, setMeasured] = useState({ balance: 0, activity: 0 })
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const [pointer, setPointer] = useState<{ px: number; py: number; panel: 'balance' | 'activity' } | null>(null)

  const dragRef = useRef<{ pointerId: number; x: number; start: Viewport; moved: boolean } | null>(null)
  const palette = usePalette()

  /* ---- bounds: the whole recorded history ---- */
  const bounds = useMemo<Viewport>(() => {
    if (series.daily.length === 0) {
      const now = Date.now()
      return { from: now, to: now + 86_400_000 }
    }
    const first = instantOf(series.daily[0].date, null)
    const last = instantOf(series.daily[series.daily.length - 1].date, null)
    // Exclusive upper bound — the day AFTER the last — so the final candle has width.
    return { from: first, to: last + 86_400_000 }
  }, [series.daily])

  const active = viewport ?? bounds
  const spanMs = Math.max(1, active.to - active.from)

  const chartWidth = Math.max(320, width)
  const plotLeft = 10
  const plotRight = Math.max(plotLeft + 60, chartWidth - AXIS_W)
  const plotWidth = Math.max(40, plotRight - plotLeft)

  const panels = useMemo(() => {
    const balanceHeight = Math.max(BALANCE_MIN_PX, measured.balance || Math.round(height * BALANCE_SHARE))
    const activityHeight = Math.max(ACTIVITY_MIN_PX, measured.activity || height - balanceHeight)
    return {
      balance: { top: 18, bottom: Math.max(64, balanceHeight - 10) },
      activity: { top: 14, bottom: Math.max(46, activityHeight - TIME_AXIS_H - 8) },
      axisTop: activityHeight - TIME_AXIS_H,
      balanceHeight,
      activityHeight
    }
  }, [measured, height])

  /* ---- which entries are in the window, for the granularity decision ---- */
  const windowEntries = useMemo(() => {
    const fromKey = keyOf(floorInstant(active.from, 'day'))
    const toKey = keyOf(floorInstant(active.to, 'day'))
    let total = 0
    let timed = 0
    for (const [key, list] of Object.entries(series.dayMarkers)) {
      if (key < fromKey || key > toKey) continue
      total += list.length
      for (const marker of list) if (marker.time !== null && marker.convertedDelta !== null) timed += 1
    }
    return { total, timed }
  }, [series.dayMarkers, active.from, active.to])

  const granularity = useMemo(
    () =>
      bucketGranularity(spanMs, {
        transactionCount: windowEntries.total,
        hasIntraday: windowEntries.timed > 0,
        plotWidth
      }),
    [spanMs, windowEntries, plotWidth]
  )

  const buckets = useMemo<InstantBucket[]>(() => {
    if (series.daily.length === 0) return []
    return isIntradayGranularity(granularity)
      ? intradayCandles(series.daily, series.dayMarkers, granularity, active)
      : bucketDaily(series.daily, granularity)
  }, [series.daily, series.dayMarkers, granularity, active])

  /** Candles intersecting the window. Binary search, then walk forward. */
  const visible = useMemo(() => {
    if (buckets.length === 0) return [] as InstantBucket[]
    let lo = 0
    let hi = buckets.length - 1
    let start = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const next = mid + 1 < buckets.length ? buckets[mid + 1].instant : Number.POSITIVE_INFINITY
      if (next <= active.from) lo = mid + 1
      else if (buckets[mid].instant > active.to) hi = mid - 1
      else {
        start = mid
        break
      }
      start = Math.max(0, lo)
    }
    const out: InstantBucket[] = []
    for (let i = start; i < buckets.length; i += 1) {
      if (buckets[i].instant > active.to) break
      out.push(buckets[i])
    }
    return out
  }, [buckets, active])

  const averages = useMemo(() => {
    const closes = buckets.map((bucket) => bucket.balanceClose)
    return maWindows.map((windowSize) => ({ windowSize, values: movingAverage(closes, windowSize) }))
  }, [buckets, maWindows])

  const visibleIndex = useMemo(() => {
    const map = new Map<number, number>()
    if (visible.length === 0) return map
    const firstIndex = buckets.findIndex((bucket) => bucket.instant === visible[0].instant)
    for (let i = 0; i < visible.length; i += 1) map.set(visible[i].instant, firstIndex + i)
    return map
  }, [buckets, visible])

  /* ---- y axes: independent, both fitted to the VISIBLE window ---- */
  /**
   * The balances the entries inside the window produced.
   *
   * Read from the series rather than from the resolved markers, because the axis and the
   * marker positions are mutually dependent: the markers are placed BY the axis, so the axis
   * cannot be fitted to their pixel positions. These are the raw numbers, available before
   * anything is drawn.
   *
   * WHY THE AXIS NEEDS THEM AT ALL — the bug this closes
   * ---------------------------------------------------
   * Fitting the axis to the visible candles' open/high/low/close and the moving averages is
   * not enough, and the failure is spectacular rather than subtle. The last visible bucket is
   * the one still in progress: its `balanceHigh` covers only the entries the chart has walked
   * past, so an entry the reader has scrolled up TO, sitting at a later instant, can be above
   * it. The marker is then drawn outside the plot and CLIPPED. On the spec's own fixture that
   * hid every transaction: a six-day window whose closes sat at RM 14,807.73 produced an axis
   * of RM 14,807.73..RM 15,016.27, while the salary marker sat at RM 15,092.93 — above the top
   * edge, invisible, with no error anywhere.
   */
  const markerExtremes = useMemo(() => {
    const fromKey = keyOf(floorInstant(active.from, 'day'))
    const toKey = keyOf(floorInstant(active.to, 'day'))
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const [key, list] of Object.entries(series.dayMarkers)) {
      if (key < fromKey || key > toKey) continue
      for (const marker of list) {
        if (marker.balanceAfter === null) continue
        const instant = instantOf(key, marker.time)
        if (instant < active.from || instant > active.to) continue
        if (marker.balanceAfter < low) low = marker.balanceAfter
        if (marker.balanceAfter > high) high = marker.balanceAfter
      }
    }
    return { low, high }
  }, [series.dayMarkers, active])

  const balanceDomain = useMemo(() => {
    const minStep = minStepForCurrency(displayCurrency)
    if (visible.length === 0) return valueDomain(0, 1, { minStep })
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const bucket of visible) {
      low = Math.min(low, bucket.balanceLow, bucket.balanceOpen, bucket.balanceClose)
      high = Math.max(high, bucket.balanceHigh, bucket.balanceOpen, bucket.balanceClose)
    }
    for (const entry of averages) {
      for (const bucket of visible) {
        const index = visibleIndex.get(bucket.instant)
        if (index === undefined) continue
        const value = entry.values[index]
        if (value === null || value === undefined) continue
        low = Math.min(low, value)
        high = Math.max(high, value)
      }
    }
    // Every marker in the window is inside the axis. See `markerExtremes`.
    if (Number.isFinite(markerExtremes.low)) low = Math.min(low, markerExtremes.low)
    if (Number.isFinite(markerExtremes.high)) high = Math.max(high, markerExtremes.high)
    return valueDomain(low, high, { minStep })
  }, [visible, averages, visibleIndex, displayCurrency, markerExtremes])

  const activityDomain = useMemo(() => {
    let max = 0
    for (const bucket of visible) {
      max =
        activityMode === 'count'
          ? Math.max(max, bucket.transactionCount)
          : Math.max(max, bucket.income, bucket.expense)
    }
    // Always anchored at zero: a flow chart whose bars float misstates every one.
    return valueDomain(0, max > 0 ? max : 1, { minStep: 1 })
  }, [visible, activityMode])

  const timeToX = useCallback(
    (ms: number): number => plotLeft + ((ms - active.from) / spanMs) * plotWidth,
    [plotLeft, active.from, spanMs, plotWidth]
  )

  const balanceToY = useCallback(
    (value: number): number => {
      const range = balanceDomain.max - balanceDomain.min
      const ratio = range > 0 ? (value - balanceDomain.min) / range : 0.5
      return panels.balance.bottom - ratio * (panels.balance.bottom - panels.balance.top)
    },
    [balanceDomain, panels.balance]
  )

  const step = visible.length > 0 ? plotWidth / visible.length : 0

  /**
   * Candle bodies fill most of their slot.
   *
   * 82% of the slot, so the gap is 18% — a hairline gutter rather than a corridor.
   * v1.5.0 used 66%, which is a "candle" in the sense that a fence post is a tree:
   * with any gap at all the eye reads the spaces, and at 66% the spaces were half
   * the chart. The cap of 64px stops a zoomed-in seven-candle week from turning into
   * seven fat blocks, and the floor of 1px keeps a 3,650-candle decade drawable.
   */
  const bodyW = Math.max(1, Math.min(64, step * 0.82))

  const times = useMemo(
    () => timeTicks({ from: active.from, to: active.to, granularity, plotLeft, plotWidth }),
    [active.from, active.to, granularity, plotLeft, plotWidth]
  )

  const markers = useMemo(
    () => buildMarkers(series.dayMarkers, active, timeToX, balanceToY, null),
    [series.dayMarkers, active, timeToX, balanceToY]
  )

  const candles = useMemo<CandleGeometry[]>(
    () =>
      visible.map((bucket) => {
        const centre = timeToX(bucket.instant) + step / 2
        const bodyLeft = Math.round(centre - bodyW / 2)
        return {
          bucket,
          instant: bucket.instant,
          x: centre,
          bodyLeft,
          bodyRight: Math.max(bodyLeft + 1, Math.round(centre + bodyW / 2)),
          yOpen: balanceToY(bucket.balanceOpen),
          yClose: balanceToY(bucket.balanceClose),
          yHigh: balanceToY(bucket.balanceHigh),
          yLow: balanceToY(bucket.balanceLow),
          up: bucket.balanceClose > bucket.balanceOpen,
          down: bucket.balanceClose < bucket.balanceOpen
        }
      }),
    [visible, timeToX, step, bodyW, balanceToY]
  )

  /**
   * Resolve the pointer to a transaction, a candle and a value — once.
   *
   * ONE resolution feeding both panels, the crosshair and the hover card is what
   * keeps them from describing three slightly different things. Every consumer reads
   * this object, and the hovered marker's highlight is DERIVED from it rather than
   * stored, so there is no second, staler copy of "what is under the cursor".
   */
  const hover = useMemo<HoverState | null>(() => {
    if (pointer === null || candles.length === 0) return null
    const { px, py, panel } = pointer

    /*
      Nearest transaction, ranked by where the hairline is DRAWN.

      Aiming is a visual act: the reader points at a line they can see. For an entry that had to
      be nudged aside because another landed on top of it, the drawn position IS the line they
      see — so ranking on the TRUE instant instead leaves that entry permanently unclickable,
      with the pointer resolving to whichever neighbour happens to sit nearer the un-nudged
      coordinate. Which is what measuring found: on the fixture's midday cluster, a marker
      drawn at x=623 resolved to the entry at x=626 every time.

      The crosshair still snaps to the true instant below, so what the reader is TOLD about when
      a transaction happened is unaffected by the nudge.
    */
    let marker: ChartMarker | null = null
    let best = HIT_RADIUS_PX
    for (const entry of markers) {
      const dx = Math.abs(entry.drawX - px)
      if (dx > HIT_RADIUS_PX) continue
      const dy = panel === 'balance' ? Math.abs(entry.y - py) : 0
      const distance = panel === 'balance' ? Math.hypot(dx, dy) : dx
      if (distance <= best) {
        best = distance
        marker = entry
      }
    }

    let candle: CandleGeometry | null = null
    if (marker !== null) {
      for (const candidate of candles) {
        const next = stepInstant(candidate.instant, granularity, 1)
        if (marker.instant >= candidate.instant && marker.instant < next) {
          candle = candidate
          break
        }
      }
    }
    if (candle === null && step > 0) {
      const index = Math.max(0, Math.min(candles.length - 1, Math.floor((px - plotLeft) / step)))
      candle = candles[index]
    }

    const crossX = marker !== null ? marker.x : candle !== null ? candle.x : px
    const instant = active.from + ((crossX - plotLeft) / plotWidth) * spanMs

    const plot = panel === 'balance' ? panels.balance : panels.activity
    const domain = panel === 'balance' ? balanceDomain : activityDomain
    const inside = py >= plot.top && py <= plot.bottom
    const value = inside
      ? domain.min + ((plot.bottom - py) / Math.max(1, plot.bottom - plot.top)) * (domain.max - domain.min)
      : null

    return { px, py, panel, crossX, marker, candle, value, instant }
  }, [
    pointer,
    candles,
    markers,
    step,
    plotLeft,
    plotWidth,
    active.from,
    spanMs,
    panels,
    balanceDomain,
    activityDomain,
    granularity
  ])

  /** The same marker set with the resolved hover baked in, for the draw passes. */
  const litMarkers = useMemo(() => {
    const id = hover?.marker?.marker.transactionId
    if (id === undefined) return markers
    return markers.map((entry) => (entry.marker.transactionId === id ? { ...entry, hovered: true } : entry))
  }, [markers, hover])

  const frame = useMemo<ChartFrame | null>(() => {
    if (visible.length === 0) return null
    const focus = hover?.candle ?? candles[candles.length - 1]
    const index = focus ? visibleIndex.get(focus.instant) : undefined
    return {
      viewport: active,
      granularity,
      zoomLabel: describeSpan(spanMs),
      geometry: {
        plotLeft,
        plotRight,
        balanceTop: panels.balance.top,
        balanceBottom: panels.balance.bottom,
        activityTop: panels.activity.top,
        activityBottom: panels.activity.bottom
      },
      buckets: visible,
      candles,
      markers,
      balance: balanceDomain,
      activity: activityDomain,
      hover,
      ma: averages.map((entry) => ({
        windowSize: entry.windowSize,
        value: index === undefined ? null : (entry.values[index] ?? null)
      }))
    }
  }, [
    visible,
    hover,
    candles,
    active,
    granularity,
    spanMs,
    markers,
    balanceDomain,
    activityDomain,
    averages,
    visibleIndex,
    panels,
    plotLeft,
    plotRight
  ])

  useEffect(() => {
    onFrame?.(frame)
    /*
      The frame, reachable from a debugging session.

      Every visual property of this chart — the two value domains, the candle geometry, the
      marker positions, the tick labels — lives inside a canvas, where no DOM assertion can
      reach it. `tools/verify-kline.cjs` reads this to check that the axis it is looking at is
      the axis the numbers deserve, which is the difference between "a chart appeared" and
      "the chart is right".
    */
    ;(window as unknown as { __cfcFrame?: ChartFrame | null }).__cfcFrame = frame
  }, [frame, onFrame])

  /* ---- resize ---- */
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const measure = (): void => {
      setWidth(element.clientWidth)
      setMeasured({
        balance: balanceBoxRef.current?.clientHeight ?? 0,
        activity: activityBoxRef.current?.clientHeight ?? 0
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (balanceBoxRef.current) observer.observe(balanceBoxRef.current)
    if (activityBoxRef.current) observer.observe(activityBoxRef.current)
    return () => observer.disconnect()
  }, [])

  /* ---- external control: one-shot view requests ---- */
  const consumedView = useRef<number | null>(null)
  useEffect(() => {
    if (!viewRequest || consumedView.current === viewRequest.token) return
    consumedView.current = viewRequest.token
    setPointer(null)

    if (viewRequest.fromMs !== undefined && viewRequest.toMs !== undefined) {
      const from = Math.max(bounds.from, viewRequest.fromMs)
      const to = Math.min(bounds.to, viewRequest.toMs)
      setViewport(to > from ? { from, to } : null)
      return
    }

    if (viewRequest.anchorMs !== undefined) {
      if (bounds.to <= bounds.from) return
      // Keep the current zoom level and centre on the target: the reader asked
      // "where is this day", not "how long was it".
      const keep = Math.min(Math.max(spanMs, 86_400_000), bounds.to - bounds.from)
      const from = Math.max(bounds.from, Math.min(viewRequest.anchorMs - keep / 2, bounds.to - keep))
      setViewport({ from, to: from + keep })
      return
    }

    // No target: show everything.
    setViewport(null)
    // Keyed on the request identity only. Re-running on every window change would
    // fight the reader's own panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRequest])

  /* ---- drawing ---- */
  const drawBalance = useCallback(() => {
    const canvas = balanceRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paintCanvas(canvas, ctx, chartWidth, panels.balanceHeight)
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif'
    const { top, bottom } = panels.balance

    drawValueGrid(ctx, balanceDomain, top, bottom, plotLeft, plotRight, palette, displayCurrency, font)

    if (candles.length === 0) {
      ctx.fillStyle = palette.axis
      ctx.font = `13px ${font}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(T.klineNoData, (plotLeft + plotRight) / 2, (top + bottom) / 2)
      return
    }

    /* --- moving averages, under the candles --- */
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    for (let m = 0; m < averages.length; m += 1) {
      const entry = averages[m]
      if (!entry.values.some((value) => value !== null)) continue
      ctx.strokeStyle = palette.ma[m % palette.ma.length]
      ctx.beginPath()
      let started = false
      for (const bucket of visible) {
        const index = visibleIndex.get(bucket.instant)
        if (index === undefined) continue
        const value = entry.values[index]
        if (value === null || value === undefined) {
          started = false
          continue
        }
        const px = timeToX(bucket.instant) + step / 2
        const py = balanceToY(value)
        if (started) ctx.lineTo(px, py)
        else {
          ctx.moveTo(px, py)
          started = true
        }
      }
      ctx.stroke()
    }

    /* --- wicks and bodies --- */
    for (const candle of candles) {
      const color = candle.up ? palette.up : candle.down ? palette.down : palette.neutral
      const centre = Math.round(candle.x) + 0.5
      if (candle.bodyRight - candle.bodyLeft >= 3) {
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(centre, candle.yHigh)
        ctx.lineTo(centre, candle.yLow)
        ctx.stroke()
      }

      const bodyTop = Math.min(candle.yOpen, candle.yClose)
      const bodyBottom = Math.max(candle.yOpen, candle.yClose)
      /*
        A body is never thinner than one pixel, and never shorter than one.

        A day that moved a hundredth of a percent has a body 0.05px tall, and a
        candle drawn at its true height would simply not exist. Rounding UP to one
        pixel is the smallest falsification available and is what every trading
        terminal does; the true number is in the tooltip at full precision.

        Hollow up-candles, filled down-candles — the OKX/terminal convention, and it
        makes direction legible in a dense field where colour alone is not enough.
      */
      const height = Math.max(1, Math.round(bodyBottom - bodyTop))
      const width = candle.bodyRight - candle.bodyLeft
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      if (candle.up && height >= 3) {
        ctx.strokeRect(candle.bodyLeft + 0.5, Math.round(bodyTop) + 0.5, Math.max(1, width - 1), height - 1)
      } else {
        ctx.fillStyle = color
        ctx.fillRect(candle.bodyLeft, Math.round(bodyTop), width, height)
      }
    }

    /* --- transaction markers: a hairline at the balance each entry produced --- */
    ctx.lineWidth = 1
    for (const entry of litMarkers) {
      const y = Math.round(entry.y) + 0.5
      if (y < top - 1 || y > bottom + 1) continue
      const half = Math.max(2, bodyW / 2) + 1
      ctx.strokeStyle = entry.hovered ? palette.markerHover : palette.marker
      ctx.lineWidth = entry.hovered ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(entry.drawX - half, y)
      ctx.lineTo(entry.drawX + half, y)
      ctx.stroke()
    }

    /* --- horizontal crosshair + value tag, only when the pointer is in THIS panel --- */
    if (hover !== null && hover.panel === 'balance') {
      const y = Math.round(hover.py) + 0.5
      ctx.save()
      ctx.strokeStyle = palette.crosshair
      ctx.globalAlpha = 0.45
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(plotLeft, y)
      ctx.lineTo(plotRight, y)
      ctx.stroke()
      ctx.restore()
    }

    if (hover !== null) drawVerticalCrosshair(ctx, hover.crossX, top, bottom, palette)
  }, [
    width,
    chartWidth,
    panels.balance,
    balanceDomain,
    plotLeft,
    plotRight,
    palette,
    displayCurrency,
    candles,
    litMarkers,
    averages,
    visible,
    visibleIndex,
    timeToX,
    step,
    balanceToY,
    hover,
    bodyW
  ])

  const drawActivity = useCallback(() => {
    const canvas = activityRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paintCanvas(canvas, ctx, chartWidth, panels.activityHeight)
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif'
    const { top, bottom } = panels.activity

    drawValueGrid(ctx, activityDomain, top, bottom, plotLeft, plotRight, palette, displayCurrency, font)

    const zeroY = bottom
    for (const candle of candles) {
      const bucket = candle.bucket
      const width = candle.bodyRight - candle.bodyLeft
      if (activityMode === 'count') {
        if (bucket.transactionCount <= 0) continue
        const ratio = activityDomain.max > 0 ? bucket.transactionCount / activityDomain.max : 0
        const h = Math.max(1, ratio * (bottom - top))
        ctx.fillStyle = palette.activity
        ctx.globalAlpha = 0.85
        ctx.fillRect(candle.bodyLeft, bottom - h, width, h)
        ctx.globalAlpha = 1
        continue
      }
      const half = (bottom - top) / 2
      if (bucket.income > 0) {
        const ratio = activityDomain.max > 0 ? bucket.income / activityDomain.max : 0
        const h = Math.max(1, ratio * (half - 2))
        ctx.fillStyle = palette.up
        ctx.globalAlpha = 0.85
        ctx.fillRect(candle.bodyLeft, zeroY - h, width, h)
        ctx.globalAlpha = 1
      }
      if (bucket.expense > 0) {
        const ratio = activityDomain.max > 0 ? bucket.expense / activityDomain.max : 0
        const h = Math.max(1, ratio * (half - 2))
        ctx.fillStyle = palette.down
        ctx.globalAlpha = 0.85
        ctx.fillRect(candle.bodyLeft, zeroY, width, h)
        ctx.globalAlpha = 1
      }
    }

    /*
      Individual transactions as thin columns, on top of the aggregates.

      At a coarse zoom they collapse into the bar they belong to and cost nothing; at
      maximum zoom they ARE the chart, and the reader sees six columns where the day
      bar used to be. This is why the same panel serves "what did September look
      like" and "what did 12:14 cost" without a mode switch.
    */
    for (const entry of litMarkers) {
      const flow = entry.marker.convertedDelta
      if (flow === null || flow === 0 || entry.marker.type === 'transfer') continue
      const half = (bottom - top) / 2
      const ratio = activityDomain.max > 0 ? Math.abs(flow) / activityDomain.max : 0
      const h = Math.max(1, ratio * (half - 2))
      const y = flow > 0 ? zeroY - h : zeroY
      ctx.globalAlpha = entry.hovered ? 1 : 0.6
      ctx.fillStyle = flow > 0 ? palette.up : palette.down
      ctx.fillRect(Math.round(entry.drawX) - 1, y, 2, h)
      ctx.globalAlpha = 1
    }

    if (hover !== null && hover.panel === 'activity') {
      const y = Math.round(hover.py) + 0.5
      ctx.save()
      ctx.strokeStyle = palette.crosshair
      ctx.globalAlpha = 0.45
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(plotLeft, y)
      ctx.lineTo(plotRight, y)
      ctx.stroke()
      ctx.restore()
    }

    if (hover !== null) drawVerticalCrosshair(ctx, hover.crossX, top, bottom, palette)

    /* --- the shared time axis, drawn once, at the bottom of this panel --- */
    ctx.font = `10px ${font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = palette.axis
    ctx.strokeStyle = palette.grid
    for (const tick of times) {
      if (tick.x < plotLeft - 1 || tick.x > plotRight + 1) continue
      ctx.globalAlpha = 0.25 + 0.5 * tick.weight
      ctx.beginPath()
      ctx.moveTo(Math.round(tick.x) + 0.5, top - 6)
      ctx.lineTo(Math.round(tick.x) + 0.5, bottom)
      ctx.stroke()
      if (tick.label === null) continue
      ctx.globalAlpha = 0.4 + 0.6 * tick.opacity
      ctx.fillText(tick.label, tick.x, panels.axisTop + 3)
    }
    ctx.globalAlpha = 1
  }, [
    width,
    chartWidth,
    panels.activity,
    panels.axisTop,
    activityDomain,
    plotLeft,
    plotRight,
    palette,
    displayCurrency,
    candles,
    litMarkers,
    activityMode,
    hover,
    times
  ])

  useLayoutEffect(() => {
    drawBalance()
    drawActivity()
  }, [drawBalance, drawActivity])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      drawBalance()
      drawActivity()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [drawBalance, drawActivity])

  /* ---- interaction ---- */
  const anchorRatio = useCallback(
    (localX: number): number => Math.max(0, Math.min(1, (localX - plotLeft) / plotWidth)),
    [plotLeft, plotWidth]
  )

  /**
   * Wheel zoom.
   *
   * BOUND IN AN EFFECT WITH `passive: false`, not through React's `onWheel`.
   *
   * React attaches its wheel listener passively at the root, so `preventDefault()`
   * inside a synthetic handler is ignored — which is precisely the v1.5.0 bug where
   * scrolling over the chart zoomed it AND scrolled the page. A non-passive listener
   * registered on the element is the only way to cancel the scroll, and it is
   * cancelled only while the pointer is over one of the two panels, so the rest of
   * the page keeps scrolling normally.
   *
   * `stopPropagation` as well as `preventDefault`: a parent scroll container that
   * listens in the bubble phase would otherwise see the event it was never meant to.
   */
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return

    const onWheel = (event: WheelEvent): void => {
      const delta = Math.max(-240, Math.min(240, event.deltaY))
      const factor = Math.exp(delta * 0.0016)
      if (!Number.isFinite(factor) || factor === 1) return
      event.preventDefault()
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      setViewport((current) => zoomViewport(current ?? bounds, factor, anchorRatio(event.clientX - rect.left), bounds))
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [bounds, anchorRatio])

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, panel: 'balance' | 'activity') => {
      const rect = event.currentTarget.getBoundingClientRect()
      setPointer({ px: event.clientX - rect.left, py: event.clientY - rect.top, panel })

      const drag = dragRef.current
      if (!drag) return
      if (Math.abs(event.clientX - drag.x) > 2) drag.moved = true
      setViewport(panViewport(drag.start, event.clientX - drag.x, plotWidth / spanMs, bounds))
    },
    [bounds, plotWidth, spanMs]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, start: active, moved: false }
    },
    [active]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (drag?.pointerId === event.pointerId) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          /* already released */
        }
        dragRef.current = null
      }
      if (drag?.moved) return
      if (hover?.marker) onClickMarker?.(hover.marker.marker)
      else if (hover?.candle) onClickBucket?.(hover.candle.bucket)
    },
    [hover, onClickMarker, onClickBucket]
  )

  const clearHover = useCallback(() => {
    setPointer(null)
    dragRef.current = null
  }, [])

  const cursor = hover?.marker ? 'pointer' : 'crosshair'

  return (
    <div className="cfc" ref={wrapRef}>
      <style>{CHART_STYLES}</style>
      <div className="cfc__panels" style={{ height }}>
        <div
          className="cfc__panel cfc__panel--balance"
          ref={balanceBoxRef}
          style={{ flexBasis: `${Math.round(height * BALANCE_SHARE)}px`, cursor }}
          onPointerMove={(event) => handlePointerMove(event, 'balance')}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={clearHover}
          onDoubleClick={() => setViewport(null)}
        >
          <canvas ref={balanceRef} className="cfc__canvas" />
          <span className="cfc__panel-title">{T.klineBalancePanel}</span>
          {hover !== null && hover.panel === 'balance' && hover.value !== null ? (
            <span className="cfc__axis-tag" style={{ top: hover.py, right: AXIS_W }}>
              {formatMoney(hover.value, displayCurrency, { compact: true })}
            </span>
          ) : null}
        </div>

        <div className="cfc__divider" role="separator" aria-orientation="horizontal" />

        <div
          className="cfc__panel cfc__panel--activity"
          ref={activityBoxRef}
          style={{ cursor }}
          onPointerMove={(event) => handlePointerMove(event, 'activity')}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={clearHover}
          onDoubleClick={() => setViewport(null)}
        >
          <canvas ref={activityRef} className="cfc__canvas" />
          <span className="cfc__panel-title">
            {activityMode === 'flow' ? T.klineActivityFlow : T.klineActivityCount}
          </span>
          {hover !== null && hover.panel === 'activity' && hover.value !== null ? (
            <span className="cfc__axis-tag" style={{ top: hover.py, right: AXIS_W }}>
              {formatMoney(hover.value, displayCurrency, { compact: true })}
            </span>
          ) : null}
          {hover !== null && hover.marker === null ? (
            <span
              className="cfc__time-tag"
              style={{ left: Math.max(plotLeft + 30, Math.min(hover.crossX, plotRight - 30)), top: panels.axisTop }}
            >
              {isIntradayGranularity(granularity)
                ? `${keyOf(hover.instant)} ${toTimeKey(hover.instant)}`
                : keyOf(hover.instant)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* drawing helpers                                                            */
/* -------------------------------------------------------------------------- */

function paintCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
}

function drawValueGrid(
  ctx: CanvasRenderingContext2D,
  domain: ValueDomain,
  top: number,
  bottom: number,
  left: number,
  right: number,
  palette: Palette,
  currency: string,
  font: string
): void {
  const range = domain.max - domain.min
  ctx.font = `10px ${font}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const value of domain.ticks) {
    const ratio = range > 0 ? (value - domain.min) / range : 0.5
    const y = Math.round(bottom - ratio * (bottom - top)) + 0.5
    ctx.strokeStyle = palette.grid
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
    ctx.fillStyle = palette.axis
    ctx.fillText(formatMoney(value, currency, { compact: true }), right + 6, y)
  }
}

/** The unified vertical crosshair. Drawn by BOTH panels at the same x. */
function drawVerticalCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  palette: Palette
): void {
  ctx.save()
  ctx.strokeStyle = palette.crosshair
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, top - 8)
  ctx.lineTo(Math.round(x) + 0.5, bottom + 6)
  ctx.stroke()
  ctx.restore()
}

/** Repaint when the theme changes: the palette is read from CSS at draw time. */
function usePalette(): Palette {
  const [palette, setPalette] = useState<Palette>(FALLBACK_PALETTE)
  useEffect(() => {
    const read = (): void => setPalette(readPalette(document.documentElement))
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])
  return palette
}

const CHART_STYLES = `
.cfc { width: 100%; min-width: 0; }
.cfc__panels { display: flex; flex-direction: column; width: 100%; min-width: 0; }
/* Two stacked boxes, not one canvas with a line across it. Each owns its height,
   its value axis and its draw pass; they meet at a 1px divider. */
.cfc__panel {
  position: relative; width: 100%; min-width: 0; overflow: hidden;
  touch-action: none; user-select: none; cursor: crosshair;
}
.cfc__panel--balance { flex: 0 0 auto; min-height: 150px; }
.cfc__panel--activity { flex: 1 1 auto; min-height: 110px; }
.cfc__divider { height: 1px; flex: 0 0 1px; background-color: var(--border-subtle); }
.cfc__canvas { display: block; }
/* Panel captions sit in the top-left corner of each plot, the way a terminal labels
   its panes. Decorative, so they never intercept the pointer. */
.cfc__panel-title {
  position: absolute; left: 10px; top: 3px; pointer-events: none;
  font-size: 9px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--text-tertiary);
}
.cfc__axis-tag {
  position: absolute; transform: translateY(-50%);
  padding: 1px 5px; border-radius: 3px; pointer-events: none; white-space: nowrap;
  font-size: 10px; font-variant-numeric: tabular-nums;
  background-color: var(--market-crosshair); color: var(--bg-surface);
}
.cfc__time-tag {
  position: absolute; transform: translateX(-50%);
  padding: 1px 6px; border-radius: 3px; pointer-events: none; white-space: nowrap;
  font-size: 10px; font-variant-numeric: tabular-nums;
  background-color: var(--market-crosshair); color: var(--bg-surface);
}
`
