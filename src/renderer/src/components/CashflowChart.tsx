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
  visibleRange,
  zoomViewport
} from '@shared/lib/chart-time'
import type { ValueDomain, Viewport } from '@shared/lib/chart-time'
import {
  ACTIVITY_MAX_ZOOM,
  ACTIVITY_MIN_ZOOM,
  activityScale,
  buildColumns,
  columnAt,
  pickSegment,
  yAtAmount,
  zeroLineY
} from '@shared/lib/daily-activity'
import type { ActivityColumn, ActivityScale, ActivitySegment, ActivityViewMode } from '@shared/lib/daily-activity'
import { categoryColorFor } from '@shared/lib/category-colors'
import { T } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'
import type { CashflowTransactionMarker, KlineBucket, KlineGranularity, KlineSeries } from '@shared/types'

/**
 * CashflowChart — the cashflow terminal's canvas layer.
 *
 * TWO PANELS, ONE TIME AXIS, TWO VALUE AXES (v1.6.0)
 *     ┌─────────────────────────────────────────────┐
 *     │  BALANCE K-LINE          OHLC · wick · MA    │  ~52%
 *     ├─────────────────────────────────────────────┤  1px divider
 *     │  DAILY CASH ACTIVITY     stacked transactions │  ~48%
 *     └─────────────────────────────────────────────┘
 *        time axis, drawn once, shared
 *
 * They share EXACTLY ONE thing — the time axis and the day index on it — and share it
 * absolutely. One `Viewport` in milliseconds, one tick array, one `CrosshairState`.
 * Two panels with their own time ranges is the failure this shape exists to prevent: a
 * K-line scrolled to September above columns still showing August is a chart that lies
 * about cause.
 *
 * Everything else is deliberately NOT shared:
 *
 *   - **Y axis.** Balance is a stock, activity is a flow; they are not the same
 *     quantity. A RM 12,000 salary and a RM 200 dinner on ONE axis is a chart where
 *     the dinner is a five-pixel relic at the baseline. On separate axes the balance
 *     keeps its shape and the dinner keeps its height.
 *   - **Vertical zoom.** The activity axis has a zoom of its own, because fitting to
 *     the maximum is still not enough when the reader is asking about the small days.
 *   - **Value range.** The balance axis is fitted to the visible balance window — *     crucially NOT to zero, see `valueDomain` — while the activity axis is fitted
 *     through zero, because a flow chart that does not start at zero misstates every
 *     bar and every share inside it.
 *   - **Canvas and draw pass.** One canvas per panel, so repainting the stacks can
 *     never smear the candles, and the divider between them is a real 1px gap
 *     rather than a line painted over one picture.
 *
 * THE ACTIVITY PANEL IS A STACK, NOT A FIELD OF HAIRLINES
 * ------------------------------------------------------
 * Until v1.5.3 this panel drew one hairline per transaction, at the height of the
 * balance it produced. That is a picture of the balance drawn a second time — it says
 * nothing about what the money was. It now draws ONE COLUMN PER DAY, and that column is
 * the day's own transactions stacked end to end, each as tall as its share of the day.
 * The proportions are the real ones: nothing is averaged, nothing is a fixed height, and
 * a day with five transactions and a day with one are directly comparable.
 *
 * Time still orders the stack. It never becomes a coordinate: the x axis is days.
 *
 * CONTINUOUS, CURSOR-ANCHORED ZOOM
 * --------------------------------
 * Horizontal zoom is `span × f` about the instant under the pointer, so what the pointer
 * is on stays under the pointer for the whole gesture. It is CONTINUOUS: no ladder of
 * zoom levels, only the time range the reader has scrolled to, with the candle size
 * derived from that range rather than chosen from a menu.
 *
 * WHY CANVAS
 * ----------
 * A decade of daily candles is ~3,650 bodies, each with a wick and a stack of segments
 * — tens of thousands of primitives. As DOM nodes that is a stall on pan; as canvas
 * strokes it is one frame. The hover card is HTML, because it is text and tables and
 * re-implementing text layout in canvas would buy nothing.
 *
 * This file draws; it does not decide. Settings live in `KlinePanel`, which also
 * renders the header, the controls, the zoom badges and the hover card.
 */

/**
 * Interactive radius for a transaction on the BALANCE panel, in px.
 *
 * TWENTY, against a marker that is often a single pixel tall. This gap is the whole
 * reason a RM 0.50 entry on a RM 100,000 account is clickable: at any zoom where
 * that transaction is under a pixel the reader cannot aim AT it, so aiming is done
 * against the DATA — the true pixel position of the true balance — with a radius
 * wide enough to forgive the pointer. Shrinking the marker to match its importance
 * while keeping its hit area generous is the rule; the reverse (a fat marker for a
 * tiny amount) would be a chart that lies about the money.
 *
 * The ACTIVITY panel does not use a radius at all: it converts the pointer's height
 * into an amount and looks the amount up in the column's cumulative ranges, so a
 * segment two tenths of a pixel tall is selectable and stays selectable at any size.
 */
const HIT_RADIUS_PX = 20

/** How close two entries must be before their markers are pulled apart. */
const STACK_PX = 3

const ACTIVITY_MIN_PX = 170
const BALANCE_MIN_PX = 190

/** Nominal split of the chart's height, before the minimums are enforced. */
const BALANCE_SHARE = 0.52

/** Value-axis gutter, on the right, where the amount labels live. */
const AXIS_W = 76
/** Height of the shared time axis at the bottom of the activity panel. */
const TIME_AXIS_H = 22

/** How long freshly built segments take to grow in, in ms (spec 鎼?8: 150— 50). */
const SEGMENT_ANIM_MS = 190

/** Multiplier applied per wheel notch or button press on the activity value axis. */
const ACTIVITY_ZOOM_STEP = 1.6

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

/**
 * What the pointer is on — resolved ONCE, consumed by everything (spec 鎼?3).
 *
 * THE BUG THIS EXISTS TO KILL
 * ---------------------------
 * The crosshair used to be assembled by three parties: the chart decided which marker
 * was near the pointer, the vertical line followed that marker's TRUE instant, the
 * horizontal line followed the raw pointer height, and the tooltip read the candle
 * whose bucket contained the marker. On a week or month zoom those three answers are
 * three different dates, which is how a reader ends up looking at a vertical line on
 * Sep 28, a horizontal line at RM 720 and a tooltip that says Sep 27 / RM 680.
 *
 * Everything below is derived from one resolution, so the lines, the tags, the header
 * and the card cannot describe different things. In particular:
 *
 *   - `crossX` is the x of the SELECTED data point (the candle's slot centre on the
 *     balance panel, the column's slot centre on the activity panel).
 *   - `crossY` is the y of the SELECTED data point — the transaction's own balance on
 *     the balance panel, the pointer's amount inside the selected segment on the
 *     activity panel — never the raw pointer position on the balance panel.
 *   - `value` is what the axis tag prints, and it is the amount `crossY` represents.
 */
export interface CrosshairState {
  /** Pointer, in chart-local px. */
  px: number
  py: number
  /** Which panel resolved it. `gutter` means the value-axis strip on the right. */
  panel: 'balance' | 'activity' | 'gutter'
  /** x the vertical crosshair is drawn at, in both panels. */
  crossX: number
  /** y the horizontal crosshair is drawn at, in the panel that owns it. */
  crossY: number
  /** Shared date index: the same bucket drives both panels. */
  dateIndex: number
  /** The bucket's key date, or null when the pointer is outside the buckets. */
  date: string
  /** Instant under the vertical crosshair. */
  instant: number
  candle: CandleGeometry | null
  marker: ChartMarker | null
  /** Activity: the column and the transaction (or category band) under the pointer. */
  column: ActivityColumn | null
  segment: ActivitySegment | null
  /** Amount at the pointer's height on the hovered panel's own axis. */
  pointerValue: number | null
  /** The amount the horizontal line and its tag report (snapped, see above). */
  value: number | null
  /** True when the pointer is inside the hovered panel's plot rectangle. */
  inside: boolean
}

/** Everything the caller needs to render a header and a hover card consistently. */
export interface ChartFrame {
  viewport: Viewport
  granularity: KlineGranularity
  /** Human name of the visible span, e.g. "3个月". */
  zoomLabel: string
  /** Plot geometry, so a verification run can convert pixels to instants exactly. */
  geometry: {
    plotLeft: number
    plotRight: number
    balanceTop: number
    balanceBottom: number
    activityTop: number
    activityBottom: number
    /** y of the activity panel's zero baseline, after zoom. */
    activityZeroY: number
  }
  buckets: KlineBucket[]
  candles: CandleGeometry[]
  markers: ChartMarker[]
  balance: ValueDomain
  activity: ValueDomain
  /** The activity panel's own scale, including the reader's vertical zoom. */
  activityScale: ActivityScale
  /** The activity panel's columns — one per visible bucket, each a stack of days. */
  activityColumns: ActivityColumn[]
  /** Which series the activity panel is drawing. */
  activityMode: ActivityViewMode
  activityZoom: number
  crosshair: CrosshairState | null
  /** MA values at the crosshair's bucket, or the last one. */
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

/**
 * An instruction to the activity panel's VALUE axis (not the time axis).
 *
 * Kept separate from `ViewRequest` because they are different axes: one moves through
 * time, the other changes how tall a ringgit is. Mixing them into one request type
 * would make every "reset the view" button silently reset the reader's vertical zoom
 * as well.
 */
export interface ActivityZoomRequest {
  token: number
  action: 'in' | 'out' | 'reset'
}

export interface CashflowChartProps {
  series: KlineSeries
  displayCurrency: string
  maWindows: number[]
  activityMode: ActivityViewMode
  height?: number
  onFrame?: (frame: ChartFrame | null) => void
  onClickBucket?: (bucket: KlineBucket) => void
  onClickMarker?: (marker: CashflowTransactionMarker) => void
  /** Click on an activity segment: the same transaction, reached from the stack. */
  onClickSegment?: (segment: ActivitySegment) => void
  /** Jump the view in time: everything, an explicit span, or a day at the current zoom. */
  viewRequest?: ViewRequest | null
  /** Move the activity panel's value axis. */
  zoomRequest?: ActivityZoomRequest | null
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
  height = 560,
  onFrame,
  onClickBucket,
  onClickMarker,
  onClickSegment,
  viewRequest,
  zoomRequest
}: CashflowChartProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const balanceRef = useRef<HTMLCanvasElement | null>(null)
  const activityRef = useRef<HTMLCanvasElement | null>(null)
  const balanceBoxRef = useRef<HTMLDivElement | null>(null)
  const activityBoxRef = useRef<HTMLDivElement | null>(null)

  const [width, setWidth] = useState(0)
  const [measured, setMeasured] = useState({ balance: 0, activity: 0 })
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const [pointer, setPointer] = useState<{ px: number; py: number; panel: 'balance' | 'activity' | 'gutter' } | null>(null)
  /** The activity panel's own vertical zoom, >= 1. Lives here, not in the parent:
   *  the wheel gesture must not round-trip through a React state update in another
   *  component, and the frame reports the value so the badge can show it. */
  const [activityZoom, setActivityZoom] = useState(1)
  /** Grows 0 → 1 once whenever the segment set is rebuilt, so a mode switch reads as
   *  a change rather than a jump cut. Never applied to the crosshair. */
  const [segmentProgress, setSegmentProgress] = useState(1)

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

  /**
   * Candles intersecting the window, in order.
   *
   * `visibleRange` is a lower bound on each bucket's END, so it returns the FIRST bucket
   * that intersects the window. The loop this replaced returned whichever bucket the
   * binary search happened to land on, which with the whole history in view is the
   * middle one — see the note on `visibleRange` itself.
   */
  const visible = useMemo(() => visibleRange(buckets, active, bounds.to), [buckets, active, bounds.to])

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

  /*
    THE ACTIVITY PANEL'S COLUMNS (spec 鎼?, 鎼?, 鎼?5)

    One column per visible bucket, built from the day markers the service already ships.
    At day granularity that is literally one column per day, each a stack of that day's
    transactions in ledger order; at week/month granularity the days fold into the
    bucket, so the column is the bucket's stack and the x position still means one thing
    to both panels.

    Derived, never stored: this is geometry for a view, and writing it anywhere would
    give the database a second, staler copy of the ledger.
  */
  const activityColumns = useMemo(
    () => buildColumns(visible, series.daily, series.dayMarkers, granularity),
    [visible, series.daily, series.dayMarkers, granularity]
  )

  /**
   * The activity axis: fitted to the visible columns, then divided by the reader's zoom.
   *
   * Independent of `balanceDomain` above on purpose (spec 鎼?). RM 12,000 of income and
   * RM 200 of dinner on one axis is a chart where the dinner does not exist.
   */
  const activity = useMemo(
    () => activityScale(activityColumns, activityMode, activityZoom),
    [activityColumns, activityMode, activityZoom]
  )

  const activityDomain = useMemo(() => {
    // Zero is always inside this domain: bars are drawn from the baseline, so an axis
    // that excluded it would misstate every share in the stack.
    const low = activity.expense > 0 ? -activity.expense : 0
    const high = activity.income > 0 ? activity.income : 0
    return valueDomain(low, high, { minStep: 1 })
  }, [activity])

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

  /* The activity panel's zero baseline and the amount the pointer's height means. */
  const activityZeroY = useMemo(
    () => zeroLineY(panels.activity.top, panels.activity.bottom, activity, activityMode),
    [panels.activity, activity, activityMode]
  )

  /**
   * Resolve the pointer into ONE crosshair state — once (spec §12–§19).
   *
   * The order below is the whole fix:
   *
   *   1. `px` — a bucket index. One index, shared, which is what makes the vertical line,
   *      the candle, the activity column and the date label the same day by construction.
   *   2. On the BALANCE panel, a nearby transaction marker (within `HIT_RADIUS_PX`, ranked
   *      by drawn position) or the bucket's own candle. The horizontal line is then drawn
   *      at THAT point's balance — not at the raw pointer height, which is the v1.5.x bug
   *      where the two lines pointed at different data.
   *   3. On the ACTIVITY panel, the pointer's height is converted to an amount on the
   *      activity axis, and the amount picks the segment by its cumulative range. A
   *      segment is a RANGE, so the horizontal line stays where the pointer is and the
   *      card names the segment that contains it; those two can never disagree because
   *      the segment was chosen BY the amount the line is at.
   */
  const crosshair = useMemo<CrosshairState | null>(() => {
    if (pointer === null || candles.length === 0) return null
    const { px, py, panel } = pointer

    /* --- 1. one shared x --- */
    let dateIndex = step > 0 ? Math.floor((px - plotLeft) / step) : 0
    dateIndex = Math.max(0, Math.min(candles.length - 1, dateIndex))
    const candle = candles[dateIndex] ?? null
    const bucket = visible[dateIndex] ?? null

    /* --- 2. the balance panel's own resolution --- */
    let marker: ChartMarker | null = null
    if (panel === 'balance') {
      let best = HIT_RADIUS_PX
      for (const entry of markers) {
        const dx = Math.abs(entry.drawX - px)
        if (dx > HIT_RADIUS_PX) continue
        const distance = Math.hypot(dx, entry.y - py)
        if (distance <= best) {
          best = distance
          marker = entry
        }
      }
    } else {
      /*
        In the activity panel the crosshair still reports the transaction it is on, but
        it is resolved by AMOUNT below, not by pixel proximity to a hairline. The marker
        is looked up from that segment so the card and the balance panel agree about
        which ledger row is selected.
      */
      marker = null
    }

    /* --- 3. the activity panel's own resolution, in data space --- */
    let column: ActivityColumn | null = null
    let segment: ActivitySegment | null = null
    let pointerValue: number | null = null
    if (panel === 'activity' && bucket !== null) {
      const picked = pickSegment(
        activityColumns,
        bucket.instant,
        py,
        panels.activity.top,
        panels.activity.bottom,
        activityZeroY,
        activity,
        activityMode
      )
      column = picked?.column ?? columnAt(activityColumns, bucket.instant)
      segment = picked?.segment ?? null
      pointerValue = picked?.amount ?? null
      if (segment !== null) {
        marker =
          markers.find((entry) => entry.marker.transactionId === segment?.transactionId) ?? null
      }
    }

    const plot = panel === 'activity' ? panels.activity : panels.balance
    const inside = py >= plot.top && py <= plot.bottom && px >= plotLeft && px <= plotRight

    /* --- what the lines are drawn at --- */
    const crossX = candle !== null ? candle.x : px
    let crossY = py
    let value: number | null = null

    if (panel === 'balance') {
      // Snap to the point being reported, so the horizontal line is AT the number.
      if (marker !== null) {
        value = marker.marker.balanceAfter ?? balanceAtY(py)
        crossY = marker.y
      } else if (candle !== null) {
        value = candle.bucket.balanceClose
        crossY = candle.yClose
      }
    } else if (panel === 'activity') {
      value = pointerValue
      crossY = Math.max(panels.activity.top, Math.min(panels.activity.bottom, py))
    } else {
      value = inside ? balanceAtY(py) : null
    }

    const instant = bucket !== null ? bucket.instant : active.from + ((px - plotLeft) / plotWidth) * spanMs

    return {
      px,
      py,
      panel,
      crossX,
      crossY,
      dateIndex,
      date: bucket?.date ?? keyOf(instant),
      instant,
      candle,
      marker,
      column,
      segment,
      pointerValue,
      value,
      inside
    }

    function balanceAtY(y: number): number | null {
      const domain = panel === 'activity' ? activityDomain : balanceDomain
      const target = panel === 'activity' ? panels.activity : panels.balance
      if (y < target.top || y > target.bottom) return null
      return (
        domain.min +
        ((target.bottom - y) / Math.max(1, target.bottom - target.top)) * (domain.max - domain.min)
      )
    }
  }, [
    pointer,
    candles,
    markers,
    visible,
    step,
    plotLeft,
    plotRight,
    plotWidth,
    active.from,
    spanMs,
    panels,
    balanceDomain,
    activityDomain,
    activityColumns,
    activity,
    activityZeroY,
    activityMode
  ])

  /** The same marker set with the resolved crosshair baked in, for the draw passes. */
  const litMarkers = useMemo(() => {
    const id = crosshair?.marker?.marker.transactionId
    if (id === undefined) return markers
    return markers.map((entry) => (entry.marker.transactionId === id ? { ...entry, hovered: true } : entry))
  }, [markers, crosshair])

  const frame = useMemo<ChartFrame | null>(() => {
    if (visible.length === 0) return null
    const focus = crosshair?.candle ?? candles[candles.length - 1]
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
        activityBottom: panels.activity.bottom,
        activityZeroY
      },
      buckets: visible,
      candles,
      markers,
      balance: balanceDomain,
      activity: activityDomain,
      activityScale: activity,
      activityColumns,
      activityMode,
      activityZoom: activity.zoom,
      crosshair,
      ma: averages.map((entry) => ({
        windowSize: entry.windowSize,
        value: index === undefined ? null : (entry.values[index] ?? null)
      }))
    }
  }, [
    visible,
    crosshair,
    candles,
    active,
    granularity,
    spanMs,
    markers,
    balanceDomain,
    activityDomain,
    activity,
    activityColumns,
    activityMode,
    activityZeroY,
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

  /* ---- external control: the activity panel's VALUE axis ---- */
  const consumedZoom = useRef<number | null>(null)
  useEffect(() => {
    if (!zoomRequest || consumedZoom.current === zoomRequest.token) return
    consumedZoom.current = zoomRequest.token
    setActivityZoom((current) => {
      if (zoomRequest.action === 'reset') return 1
      const next = zoomRequest.action === 'in' ? current * ACTIVITY_ZOOM_STEP : current / ACTIVITY_ZOOM_STEP
      return Math.min(ACTIVITY_MAX_ZOOM, Math.max(ACTIVITY_MIN_ZOOM, next))
    })
  }, [zoomRequest])

  /*
    The 190ms grow-in for a new stack.

    Deliberately NOT part of the crosshair path: it re-runs only when the segment set is
    rebuilt (a mode switch, a zoom, a different window), never on pointer movement, so a
    reader moving the mouse across the panel gets an immediate crosshair. The spec asks
    for exactly this split — segments may animate, the crosshair may not.
  */
  useEffect(() => {
    if (activityColumns.length === 0) return
    setSegmentProgress(0)
    let raf = 0
    const started = performance.now()
    const tick = (now: number): void => {
      const ratio = Math.min(1, (now - started) / SEGMENT_ANIM_MS)
      setSegmentProgress(ratio)
      if (ratio < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // Keyed on what the stack IS, not on its identity: a repaint of the same columns
    // must not restart the animation, or the bars would breathe while panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityMode, granularity, activityColumns.length, activityColumns[0]?.date ?? ''])

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
    if (crosshair !== null && crosshair.panel === 'balance') {
      // At the SELECTED point's balance, not at the pointer: the vertical line, the
      // horizontal line, the tag and the card must all describe one data point.
      const y = Math.round(crosshair.crossY) + 0.5
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

    if (crosshair !== null) drawVerticalCrosshair(ctx, crosshair.crossX, top, bottom, palette.crosshair)
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
    crosshair,
    bodyW
  ])

  /**
   * The Daily Cash Activity panel.
   *
   * FIVE SERIES, ONE COORDINATE SYSTEM (spec 鎼?0, 鎼?1)
   * -------------------------------------------------
   * Every mode below draws into the same plot, on the same x slots, against the same
   * independent value axis, and is resolved through the same `CrosshairState`. Adding a
   * mode therefore means writing a draw loop — never a second crosshair, and never a
   * second axis that disagrees with the one the tooltip reads.
   *
   * The stack mode is the one this panel exists for: one column per day, its
   * transactions end to end, each as tall as its true share of that day.
   */
  const drawActivity = useCallback(() => {
    const canvas = activityRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    paintCanvas(canvas, ctx, chartWidth, panels.activityHeight)
    const font = getComputedStyle(document.body).fontFamily || 'sans-serif'
    const { top, bottom } = panels.activity
    const zeroY = activityZeroY

    /*
      The activity grid, drawn per the axis model the mode uses.

      For the composition modes each direction is fitted to its own maximum, so there is
      no single set of tick values to print: each half gets its own ladder, tinted in that
      direction's colour. That is not decoration — it is the only honest way to show a
      chart whose up side is scaled to RM 12,000 while its down side is scaled to RM 200.
    */
    if (activity.split === 'perDirection') {
      drawSplitGrid(ctx, activity, zeroY, top, bottom, plotLeft, plotRight, palette, displayCurrency, font)
    } else {
      drawValueGrid(ctx, activityDomain, top, bottom, plotLeft, plotRight, palette, displayCurrency, font)
    }

    const columnW = (index: number): { left: number; width: number } => {
      const candle = candles[index]
      const slotCentre = candle ? candle.x : timeToX(activityColumns[index]?.instant ?? active.from) + step / 2
      const w = slotCentreWidth(step)
      return { left: Math.round(slotCentre - w / 2), width: Math.max(1, Math.round(w)) }
    }
    /** Column bodies use the same slot as the candle above, so they line up exactly. */
    const slotCentreWidth = (slot: number): number => Math.max(1, Math.min(72, slot * 0.86))
    /** Height in px for an amount, in the given direction, on the zoomed axis. */
    const heightFor = (amount: number, up: boolean): number => {
      const span = up ? activity.income : activity.expense
      const pixels = up ? Math.max(1, zeroY - top) : Math.max(1, bottom - zeroY)
      if (span <= 0) return 0
      return (amount / span) * pixels
    }
    const grow = 0.25 + 0.75 * segmentProgress

    /* --- the zero baseline, always drawn: shares are read against it --- */
    if (zeroY > top && zeroY < bottom) {
      ctx.strokeStyle = palette.axis
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(plotLeft, Math.round(zeroY) + 0.5)
      ctx.lineTo(plotRight, Math.round(zeroY) + 0.5)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    const selectedId = crosshair?.segment?.transactionId ?? null
    const selectedDate = crosshair?.panel === 'activity' ? crosshair.date : null

    for (let index = 0; index < activityColumns.length; index += 1) {
      const column = activityColumns[index]
      const { left, width: w } = columnW(index)
      if (left + w < plotLeft - 2 || left > plotRight + 2) continue
      const isFocus = selectedDate !== null && column.date === selectedDate

      if (activityMode === 'stack' || activityMode === 'category') {
        /*
          Stacked composition.

          `segments` is the day's own transactions in ledger order (stack mode) or the
          category roll-up (category mode). Either way each band's height is
          `amount / total × available`, so the proportions are the data's, and a RM 1
          band inside a RM 10,000 column is a real, selectable, zero-height band rather
          than something that was rounded away.
        */
        const drawStack = (
          segments: ReadonlyArray<{ amount: number; color: string; id: number | null }>,
          up: boolean,
          baseAlpha: number
        ): void => {
          const total = segments.reduce((sum, entry) => sum + entry.amount, 0)
          if (total <= 0) return
          let cursor = 0
          for (const entry of segments) {
            const h = heightFor(entry.amount, up) * grow
            const start = cursor
            cursor += h
            // A band is never thinner than one pixel: a band that rounds to zero INSIDE
            // a column that is drawn is indistinguishable from a missing transaction,
            // and the crosshair would report something the reader cannot see at all.
            const height = Math.max(1, h)
            const y = up ? zeroY - start - height : zeroY + start
            ctx.globalAlpha = baseAlpha
            ctx.fillStyle = entry.color
            ctx.fillRect(left, y, w, height)
            /* The selected band is outlined, so the card and the pixels agree about
               which transaction is being described — including when it is 1px tall. */
            if (entry.id !== null && entry.id === selectedId) {
              ctx.globalAlpha = 1
              ctx.strokeStyle = palette.text
              ctx.lineWidth = 1.5
              ctx.strokeRect(left + 0.75, Math.round(y) + 0.75, Math.max(1, w - 1.5), Math.max(1, height - 1.5))
            }
            ctx.globalAlpha = 1
          }
          /* Clipped: say so, rather than drawing a bar that quietly stops. */
          const drawn = cursor
          const available = up ? Math.max(1, zeroY - top) : Math.max(1, bottom - zeroY)
          if (drawn > available + 0.5) {
            ctx.fillStyle = palette.text
            ctx.beginPath()
            const cy = up ? top + 3 : bottom - 3
            ctx.moveTo(left + w / 2 - 3, cy + (up ? 0 : 0))
            ctx.lineTo(left + w / 2 + 3, cy)
            ctx.lineTo(left + w / 2, cy + (up ? 3 : -3))
            ctx.closePath()
            ctx.fill()
          }
        }

        if (activityMode === 'stack') {
          drawStack(
            column.expense.map((segment) => ({
              amount: segment.amount,
              color: categoryColorFor(segment.categoryName, segment.categoryColor),
              id: segment.transactionId
            })),
            false,
            isFocus ? 0.98 : 0.82
          )
          drawStack(
            column.income.map((segment) => ({
              amount: segment.amount,
              color: categoryColorFor(segment.categoryName, segment.categoryColor),
              id: segment.transactionId
            })),
            true,
            isFocus ? 0.98 : 0.82
          )
        } else {
          const bands = (type: 'income' | 'expense'): Array<{ amount: number; color: string; id: number | null }> =>
            column.categories
              .filter((entry) => entry.type === type)
              .map((entry) => ({
                amount: entry.amount,
                color: categoryColorFor(entry.key === '\u2014' ? null : entry.key, entry.color),
                id: null
              }))
          drawStack(bands('expense'), false, isFocus ? 0.98 : 0.85)
          drawStack(bands('income'), true, isFocus ? 0.98 : 0.85)
        }
        continue
      }

      if (activityMode === 'net') {
        /* One bar per column: income − expense, above or below the baseline. */
        const net = column.netCashFlow * grow
        const up = net >= 0
        const h = Math.max(net === 0 ? 0 : 1, heightFor(Math.abs(net), up))
        if (h <= 0) continue
        const y = up ? zeroY - h : zeroY
        ctx.globalAlpha = isFocus ? 1 : 0.85
        ctx.fillStyle = up ? palette.up : palette.down
        ctx.fillRect(left, y, w, h)
        ctx.globalAlpha = 1
        continue
      }

      if (activityMode === 'incomeExpense') {
        /* Two half-width columns per slot: what came in beside what went out. */
        const halfW = Math.max(1, Math.floor(w / 2))
        const incomeH = heightFor(column.totalIncome, true) * grow
        const expenseH = heightFor(column.totalExpense, false) * grow
        ctx.globalAlpha = isFocus ? 1 : 0.85
        if (incomeH > 0) {
          ctx.fillStyle = palette.up
          ctx.fillRect(left, zeroY - Math.max(1, incomeH), halfW, Math.max(1, incomeH))
        }
        if (expenseH > 0) {
          ctx.fillStyle = palette.down
          ctx.fillRect(left + halfW, zeroY, Math.max(1, w - halfW), Math.max(1, expenseH))
        }
        ctx.globalAlpha = 1
      }
    }

    /* --- cumulative: a continuous line over the same slots --- */
    if (activityMode === 'cumulative' && activityColumns.length > 0) {
      ctx.strokeStyle = palette.activity
      ctx.lineWidth = 1.75
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false
      for (let index = 0; index < activityColumns.length; index += 1) {
        const column = activityColumns[index]
        const { left, width: w } = columnW(index)
        const x = left + w / 2
        const y = yAtAmount(column.cumulativeCashFlow, top, bottom, zeroY, activity, activityMode)
        if (started) ctx.lineTo(x, y)
        else {
          ctx.moveTo(x, y)
          started = true
        }
      }
      ctx.stroke()

      /* The area under it, faint, so the direction is readable at a glance. */
      const gradient = ctx.createLinearGradient(0, top, 0, bottom)
      gradient.addColorStop(0, palette.up)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 0.16
      ctx.fillStyle = gradient
      ctx.beginPath()
      for (let index = 0; index < activityColumns.length; index += 1) {
        const column = activityColumns[index]
        const { left, width: w } = columnW(index)
        const x = left + w / 2
        const y = yAtAmount(column.cumulativeCashFlow, top, bottom, zeroY, activity, activityMode)
        if (index === 0) ctx.moveTo(x, zeroY)
        ctx.lineTo(x, y)
      }
      const lastSlot = columnW(activityColumns.length - 1)
      ctx.lineTo(lastSlot.left + lastSlot.width / 2, zeroY)
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
    }

    /* --- the crosshair: horizontal at the amount, vertical at the shared date --- */
    if (crosshair !== null && crosshair.panel === 'activity') {
      const y = Math.round(crosshair.crossY) + 0.5
      ctx.save()
      ctx.strokeStyle = palette.crosshair
      ctx.globalAlpha = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(plotLeft, y)
      ctx.lineTo(plotRight, y)
      ctx.stroke()
      ctx.restore()
    }
    if (crosshair !== null) {
      drawVerticalCrosshair(
        ctx,
        crosshair.crossX,
        top,
        bottom,
        crosshair.panel === 'activity' ? palette.markerHover : palette.crosshair
      )
    }

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
    activity,
    activityZeroY,
    activityColumns,
    activityMode,
    segmentProgress,
    plotLeft,
    plotRight,
    palette,
    displayCurrency,
    candles,
    active.from,
    crosshair,
    step,
    timeToX,
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
   * Wheel handling — and, since v1.6.0, TWO KINDS OF ZOOM.
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
   * WHICH AXIS THE WHEEL DRIVES
   * ---------------------------
   *   - Over the ACTIVITY panel: its own VALUE axis. That is the panel a reader zooms
   *     when a RM 200 day sits under a RM 12,000 month, and it is where the gesture
   *     should do the local thing.
   *   - Over the BALANCE panel: the time axis, as before.
   *   - Ctrl (or ⌘) anywhere: the time axis, so the familiar gesture is still available
   *     from either panel.
   *
   * `stopPropagation` as well as `preventDefault`: a parent scroll container that
   * listens in the bubble phase would otherwise see the event it was never meant to.
   */
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return

    const onWheel = (event: WheelEvent): void => {
      const delta = Math.max(-240, Math.min(240, event.deltaY))
      if (delta === 0) return
      const rect = element.getBoundingClientRect()
      const localY = event.clientY - rect.top
      const overActivity = localY >= (activityBoxRef.current?.offsetTop ?? Number.POSITIVE_INFINITY)
      const wantsTime = event.ctrlKey || event.metaKey || !overActivity

      event.preventDefault()
      event.stopPropagation()

      if (wantsTime) {
        const factor = Math.exp(delta * 0.0016)
        if (!Number.isFinite(factor) || factor === 1) return
        setViewport((current) => zoomViewport(current ?? bounds, factor, anchorRatio(event.clientX - rect.left), bounds))
        return
      }

      // Vertical zoom on the activity axis, about the baseline: bars keep their
      // footing and grow, which is the only way this gesture can stay honest.
      setActivityZoom((current) => {
        const next = current * Math.exp(-delta * 0.0016)
        return Math.min(ACTIVITY_MAX_ZOOM, Math.max(ACTIVITY_MIN_ZOOM, next))
      })
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
      /*
        A click means "this one".

        In the activity panel the segment wins over the marker, because the segment is
        what the reader aimed at; it carries the same transaction id, so the drawer that
        opens is the same row either way.
      */
      if (crosshair?.segment && crosshair.segment.transactionId > 0) {
        onClickSegment?.(crosshair.segment)
        return
      }
      if (crosshair?.marker) onClickMarker?.(crosshair.marker.marker)
      else if (crosshair?.candle) onClickBucket?.(crosshair.candle.bucket)
    },
    [crosshair, onClickSegment, onClickMarker, onClickBucket]
  )

  const clearHover = useCallback(() => {
    setPointer(null)
    dragRef.current = null
  }, [])

  const cursor = crosshair?.marker || crosshair?.segment ? 'pointer' : 'crosshair'

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
          {crosshair !== null && crosshair.panel === 'balance' && crosshair.value !== null ? (
            /* Tagged at `crossY`, the value the horizontal line is actually on — the
               two used to be drawn from different numbers. */
            <span className="cfc__axis-tag" style={{ top: crosshair.crossY, right: AXIS_W }}>
              {formatMoney(crosshair.value, displayCurrency, { compact: true })}
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
          onDoubleClick={() => setActivityZoom(1)}
        >
          <canvas ref={activityRef} className="cfc__canvas" />
          <span className="cfc__panel-title">
            {T.klineActivityPanel}
            <span className="cfc__panel-mode">{ACTIVITY_MODE_LABEL[activityMode]}</span>
            {/* Both windows, whenever the two sides are scaled separately: the one
                piece of information a dual-scale chart must never hide. */}
            {activity.split === 'perDirection' && (activity.income > 0 || activity.expense > 0) ? (
              <span className="cfc__panel-scale num" title={T.klineActivitySplitHint}>
                <span className="is-up">↑{formatMoney(activity.income, displayCurrency, { compact: true })}</span>
                <span className="is-down">↓{formatMoney(activity.expense, displayCurrency, { compact: true })}</span>
              </span>
            ) : null}
            {activity.zoom > 1.001 ? (
              <span className="cfc__panel-zoom" title={T.klineActivityZoomHint}>
                脳{activity.zoom < 10 ? activity.zoom.toFixed(1) : Math.round(activity.zoom)}
              </span>
            ) : null}
            {activity.clipped ? (
              <span className="cfc__panel-clip" title={T.klineActivityClipped}>
                {T.klineActivityClippedShort}
              </span>
            ) : null}
          </span>
          {crosshair !== null && crosshair.panel === 'activity' && crosshair.value !== null ? (
            <span className="cfc__axis-tag" style={{ top: crosshair.crossY, right: AXIS_W }}>
              {formatMoney(Math.abs(crosshair.value), displayCurrency, { compact: true })}
            </span>
          ) : null}
          {crosshair !== null && crosshair.segment === null ? (
            <span
              className="cfc__time-tag"
              style={{ left: Math.max(plotLeft + 30, Math.min(crosshair.crossX, plotRight - 30)), top: panels.axisTop }}
            >
              {isIntradayGranularity(granularity)
                ? `${crosshair.date} ${toTimeKey(crosshair.instant)}`
                : crosshair.date}
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

/**
 * The unified vertical crosshair. Drawn by BOTH panels at the same x.
 *
 * One function and one x is the point: the vertical line is a statement about a DATE,
 * and a date is shared by the two panels. The colour differs so the reader can see
 * which panel currently owns the crosshair, but the position never does.
 */
function drawVerticalCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  color: string
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, top - 8)
  ctx.lineTo(Math.round(x) + 0.5, bottom + 6)
  ctx.stroke()
  ctx.restore()
}

/** Panel captions for the five activity series. */
const ACTIVITY_MODE_LABEL: Record<ActivityViewMode, string> = {
  stack: T.klineActivityStack,
  net: T.klineActivityNet,
  incomeExpense: T.klineActivityIncomeExpense,
  cumulative: T.klineActivityCumulative,
  category: T.klineActivityCategory
}

/**
 * The two-ladder grid for the composition modes.
 *
 * Each half is labelled with ITS OWN values, in its own colour, because the two halves
 * are fitted separately. A reader who wants to compare an income bar with an expense bar
 * is told by the numbers that the scales differ rather than being quietly misled into
 * thinking a RM 200 dinner is the same size as a RM 12,000 salary.
 */
function drawSplitGrid(
  ctx: CanvasRenderingContext2D,
  scale: ActivityScale,
  zeroY: number,
  top: number,
  bottom: number,
  left: number,
  right: number,
  palette: Palette,
  currency: string,
  font: string
): void {
  ctx.font = `10px ${font}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'

  const half = (window_: number, from: number, to: number, color: string): void => {
    if (window_ <= 0 || to <= from) return
    const domain = valueDomain(0, window_, { minStep: 1, maxMajorTicks: 4, minMajorTicks: 2 })
    for (const value of domain.ticks) {
      if (value <= 0) continue
      const ratio = value / window_
      const y = Math.round(to - ratio * (to - from)) + 0.5
      if (y < Math.min(from, to) - 1 || y > Math.max(from, to) + 1) continue
      ctx.strokeStyle = palette.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
      ctx.stroke()
      ctx.globalAlpha = 0.85
      ctx.fillStyle = color
      ctx.fillText(formatMoney(value, currency, { compact: true }), right + 6, y)
      ctx.globalAlpha = 1
    }
  }

  // Income above the baseline, expense below it: the same convention as the bars.
  half(scale.income, top, zeroY, palette.up)
  half(scale.expense, bottom, zeroY, palette.down)
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
.cfc__panel--balance { flex: 0 0 auto; min-height: 190px; }
.cfc__panel--activity { flex: 1 1 auto; min-height: 170px; }
.cfc__divider { height: 1px; flex: 0 0 1px; background-color: var(--border-subtle); }
.cfc__canvas { display: block; }
/* Panel captions sit in the top-left corner of each plot, the way a terminal labels
   its panes. Decorative, so they never intercept the pointer. */
.cfc__panel-title {
  position: absolute; left: 10px; top: 3px; pointer-events: none;
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 9px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--text-tertiary);
}
/* Which series the activity panel is drawing, and how far its value axis is zoomed. */
.cfc__panel-mode { color: var(--accent-text); letter-spacing: 0.04em; }
/* The two windows, when the up and down sides are scaled separately. */
.cfc__panel-scale { display: inline-flex; gap: 6px; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.cfc__panel-scale .is-up { color: var(--market-up); }
.cfc__panel-scale .is-down { color: var(--market-down); }
.cfc__panel-zoom {
  font-variant-numeric: tabular-nums; letter-spacing: 0;
  color: var(--warning); background-color: var(--warning-subtle);
  border-radius: var(--radius-full); padding: 0 5px;
}
.cfc__panel-clip {
  letter-spacing: 0; color: var(--warning);
  border: 1px solid var(--warning); border-radius: var(--radius-full); padding: 0 5px;
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
