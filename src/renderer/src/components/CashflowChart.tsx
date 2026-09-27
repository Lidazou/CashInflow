import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

import { T } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'
import type { CashflowTransactionMarker, KlineBucket, KlineGranularity, KlineSeries } from '@shared/types'

/**
 * CashflowChart — the canvas layer of the dashboard's K-line view.
 *
 * WHAT MAKES THIS A CASHFLOW CHART AND NOT A STOCK CHART
 * -----------------------------------------------------
 * A stock candle reports that a price moved. A balance candle can report WHY, because
 * a balance only moves when a transaction moves it. So every transaction is drawn as
 * a hairline at the exact balance it produced (`balanceAfter`), inside the candle
 * that contains it:
 *
 *        ┌────────────┐   ← balanceHigh
 *        │            │
 *        ├────────────┤   ← Salary  +3000
 *        │            │
 *        ├────────────┤   ← Lunch    −30
 *        │            │
 *        ├────────────┤   ← Shopping −500
 *        └────────────┘   ← Dinner   −80
 *             ▲                balanceClose
 *        balanceOpen
 *
 * The gap between two consecutive hairlines IS that transaction's size, so a ¥3,000
 * salary and a ¥30 lunch are distinguishable without hovering. This is the feature
 * the whole view exists for; everything else here is the scaffolding that makes it
 * readable.
 *
 * WHY CANVAS
 * ----------
 * A decade of daily candles is ~3,650 bodies, each with a wick and a handful of
 * markers — tens of thousands of primitives. As DOM nodes that is a stall on pan;
 * as canvas strokes it is one frame. SVG remains the right choice for the small
 * charts on the statistics page; it is the wrong one here.
 *
 * WHAT THIS COMPONENT DOES NOT DO
 * -------------------------------
 * It draws; it does not decide. Visible period, MA selection, activity mode and the
 * hovered bucket all arrive as props, and the hovered bucket goes back out through
 * `onHover`. The header figures and the Daily Detail panel are HTML in the caller,
 * because they are text and tables — canvas would mean re-implementing text layout
 * to no benefit.
 */

/** Hover radius for grabbing a marker, in px. Generous: hairlines are hard to hit. */
const MARKER_HIT_PX = 5

export interface CashflowChartProps {
  series: KlineSeries
  displayCurrency: string
  granularity: KlineGranularity
  /** MA windows to draw, in buckets. Longest-first is applied internally. */
  maWindows: number[]
  activityMode: 'flow' | 'count'
  height?: number
  /**
   * The visible slice and the bucket under the cursor, reported upward so the
   * caller can render the header and the detail panel from the same numbers the
   * chart is drawing.
   */
  onViewChange?: (view: { from: string; to: string; granularity: KlineGranularity }) => void
  onHover?: (bucket: KlineBucket | null, marker: CashflowTransactionMarker | null) => void
  onClickBucket?: (bucket: KlineBucket) => void
  onClickMarker?: (marker: CashflowTransactionMarker) => void
  /** Set by the caller to jump the view to a date; consumed once. */
  gotoDate?: string | null
  onGotoConsumed?: () => void
  /** Bumping this resets the view to the full range. */
  resetToken?: number
}

/* -------------------------------------------------------------------------- */
/* bucketing                                                                  */
/* -------------------------------------------------------------------------- */

/** Days represented by one bucket, for span maths. Nominal on purpose. */
const DAYS_PER_BUCKET: Record<KlineGranularity, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365
}

const WEEK_START = 6

/**
 * Start of the bucket containing `date`.
 *
 * Local-calendar arithmetic only. `toISOString()` would convert to UTC first and can
 * move a date across a bucket boundary for any user not on UTC, silently misfiling
 * the first day of a month.
 */
export function bucketStart(date: string, granularity: KlineGranularity): string {
  const [year, month, day] = date.split('-').map(Number)
  const pad = (n: number): string => String(n).padStart(2, '0')

  switch (granularity) {
    case 'day':
      return date
    case 'week': {
      const local = new Date(year, month - 1, day)
      // Weeks run Monday..Sunday, matching the app's calendar.
      local.setDate(local.getDate() - ((local.getDay() + WEEK_START) % 7))
      return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
    }
    case 'month':
      return `${year}-${pad(month)}-01`
    case 'quarter':
      return `${year}-${pad(Math.floor((month - 1) / 3) * 3 + 1)}-01`
    case 'year':
    default:
      return `${year}-01-01`
  }
}

export function bucketLabel(key: string, granularity: KlineGranularity): string {
  const [year, month, day] = key.split('-').map(Number)
  switch (granularity) {
    case 'day':
      return `${month}月${day}日`
    case 'week': {
      const end = new Date(year, month - 1, day)
      end.setDate(end.getDate() + 6)
      return `${end.getMonth() + 1}月${end.getDate()}日`
    }
    case 'month':
      return `${year}年${month}月`
    case 'quarter':
      return `${year}年Q${Math.floor((month - 1) / 3) + 1}`
    case 'year':
    default:
      return `${year}年`
  }
}

/**
 * Roll the daily spine up into buckets of the requested size.
 *
 * The open comes from the previous bucket's close and the extremes are folded from
 * each day's OWN high and low — not from the day closes. A week whose salary landed
 * on Tuesday reaches a peak the closing balances never show, and a candle that
 * reports only the closes is a candle that hides the week's best day.
 *
 * Integer addition throughout, so a zoomed-out view is the exact sum of the
 * zoomed-in one rather than a differently-rounded number.
 */
export function bucketDaily(daily: KlineBucket[], granularity: KlineGranularity): KlineBucket[] {
  if (granularity === 'day') return daily

  const out: KlineBucket[] = []
  for (const day of daily) {
    const key = bucketStart(day.date, granularity)
    const last = out.length > 0 ? out[out.length - 1] : null

    if (last && last.date === key) {
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
      date: key,
      label: bucketLabel(key, granularity),
      balanceOpen: last ? last.balanceClose : day.balanceOpen,
      balanceClose: day.balanceClose,
      balanceHigh: day.balanceHigh,
      balanceLow: day.balanceLow,
      income: day.income,
      expense: day.expense,
      net: day.net,
      transactionCount: day.transactionCount,
      hasUnconverted: day.hasUnconverted
    })
  }
  return out
}

/**
 * The finest granularity that still fits the span in a readable number of candles.
 *
 * Measured in candles, not days: zooming out has to reveal coarser candles rather
 * than shrink the same picture, which is what makes "zoom out for the long trend,
 * zoom in for the detail" true instead of merely decorative.
 */
export function granularityForCandles(candles: number, current: KlineGranularity): KlineGranularity {
  const days = candles * DAYS_PER_BUCKET[current]
  if (days <= 180) return 'day'
  if (days <= 900) return 'week'
  if (days <= 2000) return 'month'
  if (days <= 5000) return 'quarter'
  return 'year'
}

/* -------------------------------------------------------------------------- */
/* painting helpers                                                           */
/* -------------------------------------------------------------------------- */

const round2 = (n: number): number => Math.round(n * 100) / 100
void round2

/** A "nice" axis step (1/2/5 × 10ⁿ) so labels land on round numbers. */
function niceStep(rough: number): number {
  if (!(rough > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

/** Running mean over `window` buckets, null until a full window exists. */
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
  ma: string[]
}

/**
 * Read the market palette from the live CSS custom properties.
 *
 * At draw time and never hard-coded, so the light theme's red-up override, the
 * dark theme's greens and any future user preference all reach the canvas without
 * this component knowing that themes exist.
 */
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
/* component                                                                  */
/* -------------------------------------------------------------------------- */

export function CashflowChart({
  series,
  displayCurrency,
  granularity,
  maWindows,
  activityMode,
  height = 420,
  onViewChange,
  onHover,
  onClickBucket,
  onClickMarker,
  gotoDate,
  onGotoConsumed,
  resetToken
}: CashflowChartProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [width, setWidth] = useState(0)
  const [view, setView] = useState<{ start: number; end: number } | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [hoverMarkerId, setHoverMarkerId] = useState<number | null>(null)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ pointerId: number; x: number; start: { start: number; end: number } } | null>(null)

  const buckets = useMemo(() => bucketDaily(series.daily, granularity), [series.daily, granularity])

  /**
   * Markers by the bucket they belong to.
   *
   * `series.points` carries markers only for the buckets the SERVICE chose, while
   * this component re-buckets locally when the user zooms. Keying them by date lets a
   * day bucket pick up its own markers regardless of what the service bucketed into,
   * so zooming does not make the markers disappear. Markers are only drawn at day
   * granularity anyway (see the density rules), and the daily spine covers every day,
   * so the lookup is complete for every bucket that can show them.
   */
  const markersByDate = useMemo(() => {
    const map = new Map<string, CashflowTransactionMarker[]>()
    for (const point of series.points) {
      if (point.markers.length === 0) continue
      map.set(point.date, point.markers)
    }
    return map
  }, [series.points])

  const size = useMemo(() => {
    const w = Math.max(320, width)
    const axisW = 66
    const axisH = 22
    const activityH = Math.max(52, Math.round(height * 0.2))
    const plotH = Math.max(80, height - axisH - activityH - 12)
    return {
      width: w,
      height,
      axisW,
      axisH,
      activityH,
      plotH,
      left: 6,
      right: w - axisW,
      top: 8,
      bottom: 8 + plotH,
      activityTop: 8 + plotH + 12,
      activityBottom: height - axisH
    }
  }, [width, height])

  const viewWindow = useMemo(() => {
    const total = buckets.length
    if (total === 0) return { start: 0, end: 0, count: 0 }
    const start = view ? Math.max(0, Math.min(view.start, total - 1)) : 0
    const end = view ? Math.max(start, Math.min(view.end, total - 1)) : total - 1
    return { start, end, count: end - start + 1 }
  }, [buckets.length, view])

  const slice = useMemo(() => buckets.slice(viewWindow.start, viewWindow.end + 1), [buckets, viewWindow.start, viewWindow.end])

  /**
   * Moving averages over the FULL series, then sliced for display.
   *
   * Never computed over the visible slice: an MA20 that restarts at the left edge of
   * the viewport is not an MA20, and the line would be a different line from the same
   * indicator one pan to the right.
   */
  const averages = useMemo(() => {
    const closes = buckets.map((bucket) => bucket.balanceClose)
    return maWindows.map((windowSize) => ({ windowSize, values: movingAverage(closes, windowSize) }))
  }, [buckets, maWindows])

  /** Windows with at least one real value inside the data, so drawable at all. */
  const drawableMa = useMemo(
    () => averages.filter((entry) => entry.values.some((value) => value !== null)),
    [averages]
  )

  /* ---- y range: the VISIBLE slice only ---- */
  const yRange = useMemo(() => {
    if (slice.length === 0) return { min: 0, max: 1 }
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const bucket of slice) {
      if (bucket.balanceLow < min) min = bucket.balanceLow
      if (bucket.balanceHigh > max) max = bucket.balanceHigh
    }
    for (const entry of drawableMa) {
      for (let i = viewWindow.start; i <= viewWindow.end; i += 1) {
        const value = entry.values[i]
        if (value === null) continue
        if (value < min) min = value
        if (value > max) max = value
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }

    /*
      Scaled to the window the user is looking at, never to all of history.

      This is what keeps the chart useful after a windfall: an account that once held
      ¥100,000 and now holds ¥7,000 must not be drawn as a flat line pinned to the
      bottom of a ¥100,000 axis.
    */
    if (min === max) {
      const pad = Math.max(Math.abs(min) * 0.02, 100)
      return { min: min - pad, max: max + pad }
    }
    const pad = (max - min) * 0.08
    return { min: min - pad, max: max + pad }
  }, [slice, drawableMa, viewWindow.start, viewWindow.end])

  const activityMax = useMemo(() => {
    let max = 0
    for (const bucket of slice) {
      if (activityMode === 'count') {
        if (bucket.transactionCount > max) max = bucket.transactionCount
      } else {
        if (bucket.income > max) max = bucket.income
        if (bucket.expense > max) max = bucket.expense
      }
    }
    return max > 0 ? max : 1
  }, [slice, activityMode])

  const step = viewWindow.count > 0 ? (size.right - size.left) / viewWindow.count : 0
  const bodyW = Math.max(2, Math.min(16, step * 0.66))

  const xFor = useCallback(
    (index: number): number => size.left + (index - viewWindow.start + 0.5) * step,
    [size.left, viewWindow.start, step]
  )
  const yFor = useCallback(
    (balance: number): number => {
      const range = yRange.max - yRange.min
      const ratio = range > 0 ? (balance - yRange.min) / range : 0.5
      return size.bottom - ratio * (size.bottom - size.top)
    },
    [yRange, size.bottom, size.top]
  )

  /** Whether markers are drawn at this density. Day view only — see the header. */
  const showMarkers = granularity === 'day' && step >= 3

  /* ---- resize ---- */
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const measure = (): void => setWidth(element.clientWidth)
    measure()
    // Observing the element rather than the window: the card expands from ~900px to
    // the full content width during the donut→chart animation, and the chart has to
    // redraw at every frame of it rather than being stretched from the old size.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* ---- external control: reset ---- */
  useEffect(() => {
    if (resetToken === undefined) return
    setView(null)
  }, [resetToken])

  /* ---- external control: go to date ---- */
  useEffect(() => {
    if (!gotoDate || buckets.length === 0) return
    const index = buckets.findIndex((bucket) => bucket.date >= gotoDate)
    const target = index === -1 ? buckets.length - 1 : index
    const count = Math.max(8, Math.min(buckets.length, viewWindow.count || buckets.length))
    let start = Math.round(target - count / 2)
    start = Math.max(0, Math.min(start, Math.max(0, buckets.length - count)))
    setView({ start, end: start + count - 1 })
    onGotoConsumed?.()
    // Deliberately keyed on the request only: re-running on every window change would
    // fight the user's own panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoDate])

  /* ---- report the visible window upward ---- */
  useEffect(() => {
    if (!onViewChange) return
    if (buckets.length === 0) return
    onViewChange({
      from: buckets[viewWindow.start]?.date ?? series.from,
      to: buckets[viewWindow.end]?.date ?? series.to,
      granularity
    })
  }, [buckets, viewWindow.start, viewWindow.end, granularity, onViewChange, series.from, series.to])

  const hoveredBucket = hoverIndex !== null ? buckets[hoverIndex] : null
  const hoveredMarker = useMemo(() => {
    if (!hoveredBucket || hoverMarkerId === null) return null
    const list = markersByDate.get(hoveredBucket.date) ?? []
    return list.find((marker) => marker.transactionId === hoverMarkerId) ?? null
  }, [hoveredBucket, hoverMarkerId, markersByDate])

  useEffect(() => {
    onHover?.(hoveredBucket, hoveredMarker)
  }, [hoveredBucket, hoveredMarker, onHover])

  /* ---- draw ---- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = size.width
    const h = size.height
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const palette = readPalette(canvas)
    const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'

    if (slice.length === 0) {
      ctx.fillStyle = palette.axis
      ctx.font = `13px ${fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(T.klineNoData, w / 2, h / 2)
      return
    }

    /* --- horizontal grid + amount axis --- */
    const range = yRange.max - yRange.min
    const tickStep = niceStep(range / 4)
    ctx.font = `11px ${fontFamily}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let value = Math.ceil(yRange.min / tickStep) * tickStep; value <= yRange.max; value += tickStep) {
      const y = Math.round(yFor(value)) + 0.5
      ctx.strokeStyle = palette.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(size.left, y)
      ctx.lineTo(size.right, y)
      ctx.stroke()
      ctx.fillStyle = palette.axis
      ctx.fillText(
        formatMoney(value, displayCurrency, { compact: true }),
        size.right + 6,
        y
      )
    }

    /* --- the activity band's baseline --- */
    const activityMid = (size.activityTop + size.activityBottom) / 2
    ctx.strokeStyle = palette.grid
    ctx.beginPath()
    ctx.moveTo(size.left, Math.round(activityMid) + 0.5)
    ctx.lineTo(size.right, Math.round(activityMid) + 0.5)
    ctx.stroke()

    const isFlatSeries = slice.every(
      (b) => b.income === 0 && b.expense === 0 && b.balanceHigh === b.balanceLow
    )

    if (isFlatSeries) {
      const y = yFor(slice[0].balanceClose)
      ctx.strokeStyle = palette.axis
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(size.left, Math.round(y) + 0.5)
      ctx.lineTo(size.right, Math.round(y) + 0.5)
      ctx.stroke()
      ctx.fillStyle = palette.axis
      ctx.font = `12px ${fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(T.klineFlat, (size.left + size.right) / 2, y - 12)
    }

    /* --- candles --- */
    for (let i = 0; !isFlatSeries && i < slice.length; i += 1) {
      const bucket = slice[i]
      const x = xFor(viewWindow.start + i)
      const open = bucket.balanceOpen
      const close = bucket.balanceClose

      // Direction from close versus open, NOT from whether income was recorded: a day
      // that earned ¥3,000 and spent ¥3,100 closes DOWN, and colouring it by income
      // would say the opposite of what happened to the balance.
      const up = close > open
      const down = close < open
      const color = up ? palette.up : down ? palette.down : palette.neutral

      ctx.strokeStyle = color
      ctx.lineWidth = 1
      const cx = Math.round(x) + 0.5
      ctx.beginPath()
      ctx.moveTo(cx, yFor(bucket.balanceHigh))
      ctx.lineTo(cx, yFor(bucket.balanceLow))
      ctx.stroke()

      const yOpen = yFor(open)
      const yClose = yFor(close)
      const top = Math.min(yOpen, yClose)
      const bodyH = Math.max(1.5, Math.abs(yClose - yOpen))
      ctx.fillStyle = color
      ctx.fillRect(x - bodyW / 2, top, bodyW, bodyH)

      /*
        At a coarser candle size the individual entries are not drawn at all.

        A month holds dozens of transactions; drawing them all as hairlines produces a
        solid block that says nothing. The count is the useful summary at that density,
        and zooming back in to days restores the individual markers — which is the
        whole point of the zoom being able to change the candle size.
      */
      if (!showMarkers) {
        if (bucket.transactionCount > 0 && bodyW >= 18 && bodyH >= 16) {
          ctx.save()
          ctx.fillStyle = palette.background
          ctx.font = `10px ${fontFamily}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          // "6 笔" rather than a bare 6: a lone digit inside a candle reads as a price.
          ctx.fillText(`${bucket.transactionCount} 笔`, x, top + bodyH / 2)
          ctx.restore()
        }
        continue
      }

      /*
        TRANSACTION MARKERS — the reason this is a cashflow chart.

        Each entry is a hairline at the balance it produced, so the vertical gap
        between two consecutive lines is that transaction's size. They are drawn in
        the chart's own background colour so they read as cuts through the body in
        both themes without needing a second colour token per direction.
      */
      const markers = markersByDate.get(bucket.date) ?? []
      if (markers.length === 0) continue

      ctx.save()
      ctx.lineWidth = 1
      for (const marker of markers) {
        if (marker.balanceAfter === null) continue
        const my = Math.round(yFor(marker.balanceAfter)) + 0.5
        if (my < size.top || my > size.bottom) continue
        const active = marker.transactionId === hoverMarkerId
        ctx.strokeStyle = active ? palette.markerHover : palette.marker
        ctx.lineWidth = active ? 1.5 : 1
        ctx.beginPath()
        // Spans the full body width plus a little, so a marker on a one-pixel body is
        // still visible.
        ctx.moveTo(x - bodyW / 2 - 2, my)
        ctx.lineTo(x + bodyW / 2 + 2, my)
        ctx.stroke()
      }
      ctx.restore()
    }

    /* --- activity band --- */
    if (!isFlatSeries) {
      for (let i = 0; i < slice.length; i += 1) {
        const bucket = slice[i]
        const x = xFor(viewWindow.start + i)

        if (activityMode === 'count') {
          const barH = Math.max(0, (bucket.transactionCount / activityMax) * (size.activityBottom - activityMid))
          if (barH <= 0) continue
          ctx.fillStyle = palette.activity
          ctx.globalAlpha = 0.8
          ctx.fillRect(x - bodyW / 2, activityMid - barH, bodyW, barH)
          ctx.globalAlpha = 1
          continue
        }

        if (bucket.income > 0) {
          const barH = Math.max(1, (bucket.income / activityMax) * (activityMid - size.activityTop))
          ctx.fillStyle = palette.up
          ctx.globalAlpha = 0.85
          ctx.fillRect(x - bodyW / 2, activityMid - barH, bodyW, barH)
          ctx.globalAlpha = 1
        }
        if (bucket.expense > 0) {
          const barH = Math.max(1, (bucket.expense / activityMax) * (size.activityBottom - activityMid))
          ctx.fillStyle = palette.down
          ctx.globalAlpha = 0.85
          ctx.fillRect(x - bodyW / 2, activityMid, bodyW, barH)
          ctx.globalAlpha = 1
        }
      }
    }

    /* --- moving averages --- */
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    for (let m = 0; m < drawableMa.length; m += 1) {
      const entry = drawableMa[m]
      ctx.strokeStyle = palette.ma[m % palette.ma.length]
      ctx.beginPath()
      let started = false
      for (let i = 0; i < slice.length; i += 1) {
        const value = entry.values[viewWindow.start + i]
        if (value === null) {
          started = false
          continue
        }
        const px = xFor(viewWindow.start + i)
        const py = yFor(value)
        if (started) ctx.lineTo(px, py)
        else {
          ctx.moveTo(px, py)
          started = true
        }
      }
      ctx.stroke()
    }

    /* --- time axis, thinned to whatever fits --- */
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = palette.axis
    const plotW = Math.max(1, size.right - size.left)
    const labelEvery = Math.max(1, Math.ceil((slice.length * 54) / plotW))
    for (let i = 0; i < slice.length; i += labelEvery) {
      const x = xFor(viewWindow.start + i)
      if (x < size.left + 14 || x > size.right - 14) continue
      ctx.fillText(slice[i].label, x, size.activityBottom + 4)
    }

    /* --- crosshair --- */
    if (hoverIndex !== null && hoverIndex >= viewWindow.start && hoverIndex <= viewWindow.end) {
      const x = Math.round(xFor(hoverIndex)) + 0.5
      const y = Math.round(pointer.y) + 0.5

      ctx.save()
      ctx.strokeStyle = palette.crosshair
      ctx.globalAlpha = 0.65
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, size.top)
      ctx.lineTo(x, size.activityBottom)
      ctx.moveTo(size.left, y)
      ctx.lineTo(size.right, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1

      // Amount tag on the right axis, at the cursor's height.
      if (y >= size.top && y <= size.bottom) {
        const ratio = (size.bottom - pointer.y) / (size.bottom - size.top)
        const value = yRange.min + ratio * (yRange.max - yRange.min)
        const text = formatMoney(value, displayCurrency, { compact: true })
        ctx.font = `11px ${fontFamily}`
        const tagW = ctx.measureText(text).width + 10
        ctx.fillStyle = palette.crosshair
        ctx.fillRect(size.right, y - 9, tagW, 18)
        ctx.fillStyle = palette.background
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, size.right + 5, y)
      }

      // Date tag on the time axis.
      const label = slice[hoverIndex - viewWindow.start]?.label ?? ''
      ctx.font = `11px ${fontFamily}`
      const labelW = ctx.measureText(label).width + 12
      const labelX = Math.min(Math.max(x - labelW / 2, size.left), size.right - labelW)
      ctx.fillStyle = palette.crosshair
      ctx.fillRect(labelX, size.activityBottom + 2, labelW, 17)
      ctx.fillStyle = palette.background
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, labelX + labelW / 2, size.activityBottom + 11)
      ctx.restore()
    }
  }, [
    width,
    size,
    slice,
    viewWindow.start,
    viewWindow.end,
    yRange,
    activityMax,
    activityMode,
    xFor,
    yFor,
    bodyW,
    step,
    drawableMa,
    markersByDate,
    showMarkers,
    hoverIndex,
    hoverMarkerId,
    pointer,
    displayCurrency
  ])

  useEffect(() => {
    draw()
  }, [draw])

  // The palette is read from CSS variables at draw time, so a theme change needs an
  // explicit repaint or the chart keeps the previous theme's colours.
  useEffect(() => {
    const observer = new MutationObserver(() => draw())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [draw])

  /* ---- interaction ---- */

  const pointerToIndex = useCallback(
    (localX: number): number => {
      if (step <= 0) return viewWindow.start
      const raw = Math.floor((localX - size.left) / step) + viewWindow.start
      return Math.max(viewWindow.start, Math.min(viewWindow.end, raw))
    },
    [step, size.left, viewWindow.start, viewWindow.end]
  )

  /**
   * Nearest marker to a pointer position, or null.
   *
   * A tolerance in PIXELS, not in money: hairlines are a few px apart on a busy day,
   * and a money-based tolerance would either miss on a small scale or grab the wrong
   * line on a large one.
   */
  const markerAt = useCallback(
    (bucket: KlineBucket, localY: number): CashflowTransactionMarker | null => {
      const list = markersByDate.get(bucket.date)
      if (!list || list.length === 0) return null
      let best: CashflowTransactionMarker | null = null
      let bestDistance = MARKER_HIT_PX
      for (const marker of list) {
        if (marker.balanceAfter === null) continue
        const distance = Math.abs(yFor(marker.balanceAfter) - localY)
        if (distance <= bestDistance) {
          bestDistance = distance
          best = marker
        }
      }
      return best
    },
    [markersByDate, yFor]
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const plotW = Math.max(1, size.right - size.left)
      const ratio = Math.max(0, Math.min(1, (localX - size.left) / plotW))

      const factor = event.deltaY > 0 ? 1.3 : 1 / 1.3
      const nextCount = Math.max(6, viewWindow.count * factor)
      const anchorDate = buckets[Math.min(viewWindow.end, viewWindow.start + Math.round(ratio * Math.max(0, viewWindow.count - 1)))]
        ?.date

      const wanted = granularityForCandles(nextCount, granularity)
      const source = wanted === granularity ? buckets : bucketDaily(series.daily, wanted)
      const count = Math.max(6, Math.min(source.length, Math.round(nextCount)))

      // Re-anchor by DATE, not by index: index 40 is a different day at day
      // granularity than at month granularity, so an index anchor teleports the view
      // the moment the candle size changes.
      const anchorIndex = anchorDate
        ? Math.max(0, source.findIndex((bucket) => bucket.date >= anchorDate))
        : 0
      let start = Math.round(anchorIndex - ratio * (count - 1))
      start = Math.max(0, Math.min(start, Math.max(0, source.length - count)))
      setView({ start, end: start + count - 1 })
    },
    [size.left, size.right, viewWindow.start, viewWindow.end, viewWindow.count, buckets, series.daily, granularity]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, start: { start: viewWindow.start, end: viewWindow.end } }
    },
    [viewWindow.start, viewWindow.end]
  )

  const dragMoved = useRef(false)

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const lx = event.clientX - rect.left
      const ly = event.clientY - rect.top
      setPointer({ x: lx, y: ly })

      const drag = dragRef.current
      if (drag && step > 0) {
        const moved = Math.round((drag.x - event.clientX) / step)
        if (moved !== 0) dragMoved.current = true
        const count = drag.start.end - drag.start.start + 1
        let start = drag.start.start + moved
        start = Math.max(0, Math.min(start, Math.max(0, buckets.length - count)))
        setView({ start, end: start + count - 1 })
      }

      if (lx < size.left - step || lx > size.right + step || ly > size.activityBottom + 22) {
        setHoverIndex(null)
        setHoverMarkerId(null)
        return
      }

      const index = pointerToIndex(lx)
      setHoverIndex(index)
      const bucket = buckets[index]
      const marker = bucket && showMarkers ? markerAt(bucket, ly) : null
      setHoverMarkerId(marker ? marker.transactionId : null)
    },
    [step, size.left, size.right, size.activityBottom, buckets, pointerToIndex, markerAt, showMarkers]
  )

  const endDrag = useCallback(
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
      // A click, not a drag: open the bucket or the transaction under the cursor.
      if (!dragMoved.current) {
        const bucket = hoverIndex !== null ? buckets[hoverIndex] : null
        if (bucket) {
          if (hoveredMarker) onClickMarker?.(hoveredMarker)
          else onClickBucket?.(bucket)
        }
      }
      dragMoved.current = false
    },
    [hoverIndex, buckets, hoveredMarker, onClickBucket, onClickMarker]
  )

  return (
    <div className="cfc" ref={wrapRef}>
      <style>{CHART_STYLES}</style>
      <div
        className="cfc__stage"
        style={{ height: size.height }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          setHoverIndex(null)
          setHoverMarkerId(null)
          dragRef.current = null
        }}
        onDoubleClick={() => setView(null)}
      >
        <canvas ref={canvasRef} className="cfc__canvas" />
      </div>
    </div>
  )
}

const CHART_STYLES = `
.cfc { width: 100%; min-width: 0; }
.cfc__stage { position: relative; width: 100%; min-width: 0; touch-action: none; user-select: none; cursor: crosshair; }
.cfc__canvas { display: block; }
`
