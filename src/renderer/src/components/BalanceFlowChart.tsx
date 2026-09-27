import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

import { Icon } from '@renderer/components/Icon'
import { T, klineMoreTx, klineTxCount } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'
import { formatDate } from '@shared/lib/dates'
import type { KlineBucket, KlineDaily, KlineGranularity, KlinePoint, KlineSeries } from '@shared/types'

/**
 * BalanceFlowChart — the K-line view of the dashboard's period card.
 *
 * WHAT IT IS, IN TRADING TERMS
 * ---------------------------
 * A candle chart whose "price" is the user's TOTAL BALANCE, plus a bar chart of
 * that bucket's cashflow underneath the same x-axis:
 *
 *   - the candle body is balanceOpen → balanceClose, the wick is the day's high
 *     and low balance. Green when the balance ended higher, red when lower
 *     (OKX's convention; the light theme flips to the Chinese red-up rule via the
 *     --market-up/--market-down tokens).
 *   - the bars are income (up from the baseline) and expense (down from it),
 *     drawn on their own scale so a ¥12,000 balance does not flatten a ¥30
 *     coffee into nothing.
 *   - MA5/10/20/60/250 are running means of balanceClose. A window longer than
 *     the visible bucket count is NOT drawn and NOT listed — a "MA250" computed
 *     from twelve points is a different line that looks like the real one.
 *
 * WHY CANVAS RATHER THAN SVG
 * --------------------------
 * Panning a 3,000-point series as SVG nodes means re-laying-out thousands of
 * elements per pointer move. Canvas redraws the same frame in about a
 * millisecond, which is the difference between a chart that follows the cursor
 * and one that stutters. SVG stays the right choice for the small charts on the
 * statistics page; it is the wrong one here.
 *
 * WHY ALL TEXT IS DRAWN IN CANVAS
 * -------------------------------
 * Axis labels, the crosshair's price tag and the MA legend are all painted by
 * the same draw call as the chart. Putting them in the DOM would mean a React
 * re-render on every pointer move and every frame of the zoom animation, which
 * is exactly when smoothness matters. The one exception is the HOVER TOOLTIP,
 * which is real HTML so it can contain a scrollable transaction list.
 *
 * MONEY RULE
 * ----------
 * Every figure crossing this component is already an integer in the display
 * currency's minor units, converted ONCE in the main process. The chart only
 * ever compares and scales them; it never converts, and it never sums two
 * currencies. Aggregation on zoom sums integers, so re-bucketing cannot
 * introduce drift — only the axis maths uses fractions, and none of those values
 * are ever shown as money.
 */

export interface BalanceFlowChartProps {
  series: KlineSeries
  displayCurrency: string
  /** Called when the user changes the visible date span, so the parent can show it. */
  onRangeChange?: (range: { from: string; to: string; granularity: KlineGranularity } | null) => void
  height?: number
}

/* -------------------------------------------------------------------------- */
/* re-bucketing                                                               */
/* -------------------------------------------------------------------------- */

const GRANULARITIES: readonly KlineGranularity[] = ['day', 'week', 'month', 'quarter', 'year']
void GRANULARITIES

/**
 * Days represented by one bucket of each granularity.
 *
 * Used only to convert a candle count into a calendar span when choosing the next
 * granularity. The values are nominal (a month is 30 days, a quarter is 91): the
 * chooser only needs the right order of magnitude, because being one bucket off at
 * a threshold changes nothing a user can see.
 */
const DAYS_PER_BUCKET: Record<KlineGranularity, number> = {
  day: 1,
  week: 7,
  month: 30,
  quarter: 91,
  year: 365
}

/** 0 = Sunday, matching `Date#getDay`. Monday-based weeks are handled by offset. */
const WEEK_START_OFFSET = 6

/**
 * Start of the bucket containing `date`, for a given granularity.
 *
 * Pure string/Date arithmetic on a local calendar date. Deliberately not using
 * `toISOString()` anywhere: that converts to UTC first and would move a date
 * across a boundary for any user east or west of UTC, which silently mis-buckets
 * the first day of a month.
 */
function bucketStart(date: string, granularity: KlineGranularity): string {
  const [year, month, day] = date.split('-').map(Number)
  const pad = (n: number): string => String(n).padStart(2, '0')

  switch (granularity) {
    case 'day':
      return date
    case 'week': {
      const local = new Date(year, month - 1, day)
      // getDay(): 0=Sun. Shift so weeks run Monday..Sunday, matching the app's
      // date handling and every Chinese calendar the user has seen.
      const back = (local.getDay() + WEEK_START_OFFSET) % 7
      local.setDate(local.getDate() - back)
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

function bucketLabel(key: string, granularity: KlineGranularity): string {
  const [year, month, day] = key.split('-').map(Number)
  switch (granularity) {
    case 'day':
      return `${month}月${day}日`
    case 'week': {
      // Label by the week's END, which is what a person means by "that week".
      const start = new Date(year, month - 1, day)
      const end = new Date(start)
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
 * Roll the daily series up into buckets of the requested size.
 *
 * Integer addition only, so a zoomed-out view is the exact sum of the zoomed-in
 * one rather than a differently-rounded number.
 *
 * The OPEN is taken from the previous bucket's close rather than from the first
 * day's open, and the HIGH/LOW are folded from each day's high and low. Taking the
 * bucket's open/close only would lose a salary that arrived and was spent inside
 * one month, and the resulting candle would claim that month was flat.
 */
function bucketDaily(daily: KlineDaily[], granularity: KlineGranularity): KlineBucket[] {
  if (granularity === 'day') return daily

  const out: KlineBucket[] = []

  for (const day of daily) {
    const key = bucketStart(day.date, granularity)
    const existing = out.length > 0 ? out[out.length - 1] : null

    if (existing && existing.date === key) {
      existing.balanceClose = day.balanceClose
      if (day.balanceHigh > existing.balanceHigh) existing.balanceHigh = day.balanceHigh
      if (day.balanceLow < existing.balanceLow) existing.balanceLow = day.balanceLow
      existing.income += day.income
      existing.expense += day.expense
      existing.net += day.net
      existing.transactionCount += day.transactionCount
      existing.hasUnconverted = existing.hasUnconverted || day.hasUnconverted
      continue
    }

    out.push({
      date: key,
      label: bucketLabel(key, granularity),
      balanceOpen: existing ? existing.balanceClose : day.balanceOpen,
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
 * The finest granularity that still fits `count` days in a readable number of
 * candles.
 *
 * The thresholds come from the pixel budget, not from taste: a candle needs
 * about 5px to be legible, so a 900px plot holds roughly 180 of them
 * comfortably. Zooming therefore makes the chart show MORE DETAIL, not merely a
 * magnified version of the same picture.
 */
function granularityForSpan(days: number): KlineGranularity {
  if (days <= 180) return 'day'
  if (days <= 900) return 'week'
  if (days <= 2000) return 'month'
  if (days <= 5000) return 'quarter'
  return 'year'
}

/* -------------------------------------------------------------------------- */
/* drawing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the theme's market colours from the live CSS custom properties.
 *
 * Read at draw time rather than hard-coded, so the light theme's red-up override
 * and any future user preference are picked up without the chart knowing about
 * themes at all.
 */
function readMarketColors(element: HTMLElement): {
  up: string
  down: string
  upSoft: string
  downSoft: string
  grid: string
  axis: string
  crosshair: string
  ma: string[]
} {
  const style = getComputedStyle(element)
  const get = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    up: get('--market-up', '#16C784'),
    down: get('--market-down', '#F0616D'),
    upSoft: get('--market-up-soft', 'rgba(22,199,132,0.22)'),
    downSoft: get('--market-down-soft', 'rgba(240,97,109,0.22)'),
    grid: get('--market-grid', '#1A1A1E'),
    axis: get('--market-axis', '#6E6E77'),
    crosshair: get('--market-crosshair', '#8A8A93'),
    ma: [
      get('--market-ma-1', '#F0B90B'),
      get('--market-ma-2', '#4E9CF5'),
      get('--market-ma-3', '#C77FA8'),
      get('--market-ma-4', '#45C4B0'),
      get('--market-ma-5', '#9A8CF0')
    ]
  }
}

/** Running mean over `window` buckets, `null` until a full window exists. */
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

/** A "nice" axis step (1/2/5 × 10ⁿ) so labels land on round numbers. */
function niceStep(rough: number): number {
  if (!(rough > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

/* -------------------------------------------------------------------------- */
/* component                                                                  */
/* -------------------------------------------------------------------------- */

export function BalanceFlowChart({
  series,
  displayCurrency,
  onRangeChange,
  height = 420
}: BalanceFlowChartProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const [width, setWidth] = useState(0)
  const [granularity, setGranularity] = useState<KlineGranularity>(series.granularity)
  /** null = show everything. Otherwise the visible slice of buckets. */
  const [view, setView] = useState<{ start: number; end: number } | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; index: number } | null>(null)

  const dragRef = useRef<{ pointerId: number; x: number; startView: { start: number; end: number } } | null>(null)

  /** Buckets at the current granularity, rebuilt only when it changes. */
  const buckets = useMemo(() => bucketDaily(series.daily, granularity), [series.daily, granularity])

  /**
   * Transactions looked up by the bucket they belong to.
   *
   * The main process returns transactions on the buckets IT chose (`series.points`),
   * but the chart re-buckets on zoom, so a transaction has to be attached to
   * whichever bucket currently contains it. A date-keyed index is enough for the
   * day granularity and degrades honestly for coarser ones: the tooltip then shows
   * the transactions of the bucket's first day rather than inventing a merge across
   * days that the data does not carry.
   */
  const transactionsByDate = useMemo(() => {
    const map = new Map<string, KlinePoint['transactions']>()
    for (const point of series.points) {
      const existing = map.get(point.date)
      if (existing) existing.push(...point.transactions)
      else map.set(point.date, [...point.transactions])
    }
    return map
  }, [series.points])

  const transactionsFor = useCallback(
    (key: string): KlinePoint['transactions'] => transactionsByDate.get(key) ?? [],
    [transactionsByDate]
  )

  const scale = useMemo(
    () => ({
      formatMoney: (minor: number): string => formatMoney(minor, displayCurrency),
      formatAxis: (minor: number): string => formatMoney(minor, displayCurrency, { compact: true })
    }),
    [displayCurrency]
  )

  /**
   * The visible window, always clamped to the data.
   *
   * Default is the WHOLE recorded range, which is what the brief asks for: on
   * open, the chart shows every day the user has ever recorded without any
   * interaction.
   */
  const viewWindow = useMemo(() => {
    const total = buckets.length
    if (total === 0) return { start: 0, end: 0, count: 0 }
    const start = view ? Math.max(0, Math.min(view.start, total - 1)) : 0
    const end = view ? Math.max(start, Math.min(view.end, total - 1)) : total - 1
    return { start, end, count: end - start + 1 }
  }, [buckets.length, view])

  /**
   * Moving averages for the visible window.
   *
   * Computed over the FULL series and then sliced, never over the visible slice:
   * an MA20 that restarts at the left edge of the viewport is not an MA20, and a
   * trader reading it would draw the wrong conclusion. The cost is one O(n) pass
   * per window over at most a few thousand buckets.
   */
  const maSeries = useMemo(() => {
    const closes = buckets.map((bucket) => bucket.balanceClose)
    return series.maWindows.map((windowSize) => ({
      windowSize,
      values: movingAverage(closes, windowSize)
    }))
  }, [buckets, series.maWindows])

  /** Windows that actually have a full window inside the data, so can be drawn. */
  const drawableMa = useMemo(
    () => maSeries.filter((entry) => entry.values.some((value) => value !== null)),
    [maSeries]
  )

  /* ---- resize ---------------------------------------------------------- */
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return

    const measure = (): void => setWidth(element.clientWidth)
    measure()

    // A ResizeObserver rather than a window resize listener, because the width
    // also changes when the card EXPANDS — the donut→chart animation resizes this
    // element from ~600px to the full content width over 360ms, and observing it
    // is what lets the chart draw itself correctly at every frame of that
    // animation instead of stretching a bitmap drawn at the old size.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /* ---- geometry -------------------------------------------------------- */
  const layout = useMemo(() => {
    const width0 = Math.max(280, width)
    const axisWidth = 62
    const axisHeight = 22
    const legendHeight = 26
    // The flow bars get their own band under the candles, sharing the x-axis.
    const flowHeight = Math.max(56, Math.round((height - legendHeight - axisHeight) * 0.26))
    const plotHeight = Math.max(80, height - legendHeight - axisHeight - flowHeight - 10)

    return {
      width: width0,
      height,
      legendHeight,
      axisWidth,
      axisHeight,
      flowHeight,
      plotHeight,
      plotLeft: 8,
      plotRight: width0 - axisWidth,
      plotTop: legendHeight,
      plotBottom: legendHeight + plotHeight,
      flowTop: legendHeight + plotHeight + 10,
      flowBottom: height - axisHeight
    }
  }, [width, height])

  /** Price (balance) range, with padding so the extremes are not on the frame. */
  const yScale = useMemo(() => {
    const slice = buckets.slice(viewWindow.start, viewWindow.end + 1)
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
    if (min === max) {
      // A flat line would otherwise divide by zero; give it a band to sit in.
      const pad = Math.max(Math.abs(min) * 0.02, 100)
      return { min: min - pad, max: max + pad }
    }
    // 8%, not more: the balance range is already dominated by the largest
    // transaction of the period, so extra padding only flattens every candle that
    // is not that one.
    const pad = (max - min) * 0.08
    return { min: min - pad, max: max + pad }
  }, [buckets, viewWindow.start, viewWindow.end, drawableMa])

  /** Flow range, mirrored so income goes up from the centre line. */
  const flowScale = useMemo(() => {
    let max = 0
    for (let i = viewWindow.start; i <= viewWindow.end; i += 1) {
      const bucket = buckets[i]
      if (!bucket) continue
      if (bucket.income > max) max = bucket.income
      if (bucket.expense > max) max = bucket.expense
    }
    return max > 0 ? max * 1.15 : 1
  }, [buckets, viewWindow.start, viewWindow.end])

  /**
   * Did the balance move at all inside the visible window?
   *
   * A ledger holding only an opening balance draws one hairline candle in an empty
   * plot, which looks like a failed render rather than a truthful "nothing has
   * happened yet". Naming the state is the same treatment the dashboard's donut gets
   * for an empty period, and for the same reason: on a finance screen, zero and
   * broken must not look alike.
   */
  const isFlat = useMemo(() => {
    const slice = buckets.slice(viewWindow.start, viewWindow.end + 1)
    if (slice.length === 0) return true
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const bucket of slice) {
      if (bucket.balanceLow < min) min = bucket.balanceLow
      if (bucket.balanceHigh > max) max = bucket.balanceHigh
    }
    return !Number.isFinite(min) || !Number.isFinite(max) || min === max
  }, [buckets, viewWindow.start, viewWindow.end])

  const step = viewWindow.count > 0 ? (layout.plotRight - layout.plotLeft) / viewWindow.count : 0
  // 2px minimum, not 1: at 1px a candle body is indistinguishable from its own
  // wick, and a day whose balance barely moved reads as a day with no data.
  const candleWidth = Math.max(2, Math.min(14, step * 0.62))

  const xFor = useCallback(
    (index: number): number => layout.plotLeft + (index - viewWindow.start + 0.5) * step,
    [layout.plotLeft, viewWindow.start, step]
  )
  const yFor = useCallback(
    (balance: number): number => {
      const range = yScale.max - yScale.min
      const ratio = range > 0 ? (balance - yScale.min) / range : 0.5
      return layout.plotBottom - ratio * (layout.plotBottom - layout.plotTop)
    },
    [yScale, layout.plotBottom, layout.plotTop]
  )

  /* ---- drawing --------------------------------------------------------- */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const cssWidth = layout.width
    const cssHeight = layout.height
    if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr)
      canvas.height = Math.round(cssHeight * dpr)
    }
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`

    const logicalWidth = cssWidth
    const logicalHeight = cssHeight
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, logicalWidth, logicalHeight)

    const colors = readMarketColors(canvas)
    const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'
    const slice = buckets.slice(viewWindow.start, viewWindow.end + 1)

    if (slice.length === 0) {
      ctx.fillStyle = colors.axis
      ctx.font = `13px ${fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(T.klineNoData, cssWidth / 2, cssHeight / 2)
      return
    }

    /* --- horizontal grid + y labels --- */
    const range = yScale.max - yScale.min
    const tickStep = niceStep(range / 4)
    const firstTick = Math.ceil(yScale.min / tickStep) * tickStep
    ctx.font = `11px ${fontFamily}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    for (let value = firstTick; value <= yScale.max; value += tickStep) {
      const y = Math.round(yFor(value)) + 0.5
      ctx.strokeStyle = colors.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(layout.plotLeft, y)
      ctx.lineTo(layout.plotRight, y)
      ctx.stroke()

      ctx.fillStyle = colors.axis
      ctx.fillText(scale.formatAxis(value), layout.plotRight + 6, y)
    }

    /* --- flow band grid: the zero line is the band's centre --- */
    const flowMid = (layout.flowTop + layout.flowBottom) / 2
    ctx.strokeStyle = colors.grid
    ctx.beginPath()
    ctx.moveTo(layout.plotLeft, Math.round(flowMid) + 0.5)
    ctx.lineTo(layout.plotRight, Math.round(flowMid) + 0.5)
    ctx.stroke()

    /*
      A balance that never moved: one line across the plot and a caption, instead of
      a lone hairline candle floating in an empty chart. The numbers are the same
      either way; only the reading changes, from "this failed to render" to "your
      balance has not moved yet".
    */
    if (isFlat) {
      const y = yFor(slice[0].balanceClose)
      ctx.strokeStyle = colors.axis
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(layout.plotLeft, Math.round(y) + 0.5)
      ctx.lineTo(layout.plotRight, Math.round(y) + 0.5)
      ctx.stroke()

      ctx.fillStyle = colors.axis
      ctx.font = `12px ${fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(T.klineFlat, (layout.plotLeft + layout.plotRight) / 2, y - 12)
    }

    /* --- candles --- */
    for (let i = 0; !isFlat && i < slice.length; i += 1) {
      const bucket = slice[i]
      const index = viewWindow.start + i
      const x = xFor(index)
      const rising = bucket.balanceClose >= bucket.balanceOpen
      const color = rising ? colors.up : colors.down

      // Wick: the bucket's high and low balance.
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      const wickX = Math.round(x) + 0.5
      ctx.beginPath()
      ctx.moveTo(wickX, yFor(bucket.balanceHigh))
      ctx.lineTo(wickX, yFor(bucket.balanceLow))
      ctx.stroke()

      // Body: open → close. A doji (no change) still gets a hairline so a day
      // with no activity is visibly present rather than a gap.
      const yOpen = yFor(bucket.balanceOpen)
      const yClose = yFor(bucket.balanceClose)
      const top = Math.min(yOpen, yClose)
      const bodyHeight = Math.max(2, Math.abs(yClose - yOpen))
      ctx.fillStyle = color
      ctx.fillRect(x - candleWidth / 2, top, candleWidth, bodyHeight)
    }

    /* --- flow bars: income above the centre, expense below --- */
    const flowUnit = (layout.flowBottom - flowMid) / flowScale
    for (let i = 0; !isFlat && i < slice.length; i += 1) {
      const bucket = slice[i]
      const index = viewWindow.start + i
      const x = xFor(index)

      if (bucket.income > 0) {
        const barHeight = Math.max(1, bucket.income * flowUnit)
        ctx.fillStyle = colors.up
        ctx.globalAlpha = 0.85
        ctx.fillRect(x - candleWidth / 2, flowMid - barHeight, candleWidth, barHeight)
        ctx.globalAlpha = 1
      }
      if (bucket.expense > 0) {
        const barHeight = Math.max(1, bucket.expense * flowUnit)
        ctx.fillStyle = colors.down
        ctx.globalAlpha = 0.85
        ctx.fillRect(x - candleWidth / 2, flowMid, candleWidth, barHeight)
        ctx.globalAlpha = 1
      }
    }

    /* --- moving averages: draw only inside the visible window --- */
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    for (let m = 0; m < drawableMa.length; m += 1) {
      const entry = drawableMa[m]
      const color = colors.ma[m % colors.ma.length]
      ctx.strokeStyle = color
      ctx.beginPath()
      let started = false
      for (let i = 0; i < slice.length; i += 1) {
        const value = entry.values[viewWindow.start + i]
        if (value === null) {
          started = false
          continue
        }
        const x = xFor(viewWindow.start + i)
        const y = yFor(value)
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else {
          ctx.lineTo(x, y)
        }
      }
      ctx.stroke()
    }

    /* --- x axis labels, thinned to whatever fits --- */
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = colors.axis
    const labelEvery = Math.max(1, Math.ceil((slice.length * 52) / Math.max(1, layout.plotRight - layout.plotLeft)))
    for (let i = 0; i < slice.length; i += labelEvery) {
      const bucket = slice[i]
      const x = xFor(viewWindow.start + i)
      if (x < layout.plotLeft + 12 || x > layout.plotRight - 12) continue
      ctx.fillText(bucketLabel(bucket.date, granularity), x, layout.flowBottom + 5)
    }

    /* --- MA legend, top-left of the plot --- */
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = `11px ${fontFamily}`
    let legendX = layout.plotLeft + 2
    for (let m = 0; m < drawableMa.length; m += 1) {
      const entry = drawableMa[m]
      const value = entry.values[Math.min(viewWindow.end, entry.values.length - 1)]
      const text = `MA${entry.windowSize} ${
        value === null ? '—' : scale.formatAxis(value)
      }`
      ctx.fillStyle = colors.ma[m % colors.ma.length]
      ctx.fillText(text, legendX, layout.legendHeight / 2 + 2)
      legendX += ctx.measureText(text).width + 14
    }

    /* --- crosshair, drawn last so it sits over everything --- */
    if (hover && hover.index >= viewWindow.start && hover.index <= viewWindow.end) {
      const hoveredBucket = buckets[hover.index]
      const x = Math.round(xFor(hover.index)) + 0.5
      const y = Math.round(hover.y) + 0.5

      ctx.save()
      ctx.strokeStyle = colors.crosshair
      ctx.globalAlpha = 0.7
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, layout.plotTop)
      ctx.lineTo(x, layout.flowBottom)
      ctx.moveTo(layout.plotLeft, y)
      ctx.lineTo(layout.plotRight, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1

      // Price tag on the right axis, at the cursor's height.
      if (y >= layout.plotTop && y <= layout.plotBottom) {
        const ratio = (layout.plotBottom - hover.y) / (layout.plotBottom - layout.plotTop)
        const value = yScale.min + ratio * (yScale.max - yScale.min)
        const text = scale.formatAxis(value)
        ctx.font = `11px ${fontFamily}`
        const textWidth = ctx.measureText(text).width
        ctx.fillStyle = colors.crosshair
        ctx.fillRect(layout.plotRight, y - 9, textWidth + 10, 18)
        ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--bg-app').trim() || '#0A0A0B'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, layout.plotRight + 5, y)
      }

      // Date tag on the bottom axis, centred on the cursor's column.
      const label = hoveredBucket.label || bucketLabel(hoveredBucket.date, granularity)
      ctx.font = `11px ${fontFamily}`
      const labelWidth = ctx.measureText(label).width + 12
      const labelX = Math.min(Math.max(x - labelWidth / 2, layout.plotLeft), layout.plotRight - labelWidth)
      ctx.fillStyle = colors.crosshair
      ctx.fillRect(labelX, layout.flowBottom + 2, labelWidth, 17)
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--bg-app').trim() || '#0A0A0B'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, labelX + labelWidth / 2, layout.flowBottom + 11)
      ctx.restore()
    }
  }, [
    width,
    layout,
    buckets,
    viewWindow.start,
    viewWindow.end,
    yScale,
    flowScale,
    xFor,
    yFor,
    drawableMa,
    hover,
    granularity,
    scale,
    isFlat
  ])

  useEffect(() => {
    draw()
  }, [draw])

  // Redraw when the theme flips: the market colours are read from CSS variables
  // at draw time, so nothing would repaint otherwise and the chart would keep the
  // previous theme's green/red.
  useEffect(() => {
    const observer = new MutationObserver(() => draw())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [draw])

  /* ---- interaction ----------------------------------------------------- */

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const plotWidth = Math.max(1, layout.plotRight - layout.plotLeft)
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left - layout.plotLeft) / plotWidth))

      // Zooming out reveals coarser candles and zooming in reveals finer ones, so
      // the unit of `nextCount` is always CANDLES and never days. Mixing the two
      // is what makes a chart jump two granularities on one wheel notch.
      const factor = event.deltaY > 0 ? 1.3 : 1 / 1.3
      const nextCount = Math.max(8, viewWindow.count * factor)

      // The bucket under the cursor, identified by DATE. Indices mean different
      // dates at different bucket sizes, so anchoring by index would teleport the
      // view whenever the granularity changes.
      const anchorIndex = Math.min(
        viewWindow.end,
        viewWindow.start + Math.round(ratio * Math.max(0, viewWindow.count - 1))
      )
      const anchorDate = buckets[anchorIndex]?.date ?? series.from

      const source = bucketDaily(series.daily, granularityForSpan(nextCount * DAYS_PER_BUCKET[granularity]))
      const count = Math.max(8, Math.min(source.length, Math.round(nextCount)))

      // First bucket whose span covers the anchor date. `findIndex` on a key >=
      // anchorDate is exact for day buckets and correct for coarser ones, because
      // bucket keys are the START of each bucket and are sorted.
      const anchorBucket = Math.max(
        0,
        source.findIndex((bucket) => bucket.date >= anchorDate)
      )

      let start = Math.round(anchorBucket - ratio * (count - 1))
      start = Math.max(0, Math.min(start, Math.max(0, source.length - count)))

      const wantedGranularity = granularityForSpan(count * DAYS_PER_BUCKET[granularity])
      setGranularity(wantedGranularity)
      setView({ start, end: start + count - 1 })
    },
    [
      layout.plotLeft,
      layout.plotRight,
      viewWindow.start,
      viewWindow.end,
      viewWindow.count,
      granularity,
      buckets,
      series.daily,
      series.from
    ]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        startView: { start: viewWindow.start, end: viewWindow.end }
      }
    },
    [viewWindow.start, viewWindow.end]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top

      const drag = dragRef.current
      if (drag && step > 0) {
        const movedBuckets = Math.round((drag.x - event.clientX) / step)
        const count = drag.startView.end - drag.startView.start + 1
        let start = drag.startView.start + movedBuckets
        start = Math.max(0, Math.min(start, buckets.length - count))
        setView({ start, end: start + count - 1 })
      }

      if (localX >= layout.plotLeft - step && localX <= layout.plotRight + step && localY <= layout.flowBottom + 20) {
        const index = Math.max(
          viewWindow.start,
          Math.min(viewWindow.end, Math.floor((localX - layout.plotLeft) / Math.max(step, 0.0001)) + viewWindow.start)
        )
        setHover({ x: localX, y: localY, index })
      } else {
        setHover(null)
      }
    },
    [step, layout.plotLeft, layout.plotRight, layout.flowBottom, viewWindow.start, viewWindow.end, buckets.length]
  )

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        /* the capture was already released */
      }
      dragRef.current = null
    }
  }, [])

  const resetView = useCallback(() => {
    setView(null)
    setGranularity(series.granularity)
  }, [series.granularity])

  // Report the visible span upward, so the card header can show it.
  useEffect(() => {
    if (!onRangeChange) return
    if (buckets.length === 0) {
      onRangeChange(null)
      return
    }
    onRangeChange({
      from: buckets[viewWindow.start]?.date ?? series.from,
      to: buckets[viewWindow.end]?.date ?? series.to,
      granularity
    })
  }, [buckets, viewWindow.start, viewWindow.end, granularity, onRangeChange, series.from, series.to])

  /* ---- tooltip --------------------------------------------------------- */
  const hovered = hover ? buckets[hover.index] : null
  /**
   * The MA legend, shown whether or not the cursor is on the chart.
   *
   * Hovering reports that bucket's value; at rest it reports the LAST visible
   * bucket's. Showing which windows are drawn is not a hover affordance — a user
   * who never moves the mouse still needs to know that MA60 is absent because
   * there is not enough history, rather than assuming it is there and flat.
   */
  const legendMa = maSeries.map((entry) => ({
    windowSize: entry.windowSize,
    value: entry.values[hover ? hover.index : viewWindow.end] ?? null
  }))
  /**
   * The hovered bucket's transactions.
   *
   * Looked up by date rather than read off the bucket, because the bucket may be
   * one the chart produced by re-bucketing on zoom — only the main process's own
   * buckets carry transaction lists.
   */
  const hoveredTransactions = hovered ? transactionsFor(hovered.date) : []
  const isZoomed = view !== null

  return (
    <div className="kline" ref={wrapRef}>
      <style>{KLINE_STYLES}</style>

      <div className="kline__toolbar">
        <div className="kline__readout">
          {hovered ? (
            <>
              <span className="kline__readout-date">{formatDate(hovered.date, 'YYYY-MM-DD')}</span>
              <span className="kline__readout-item">
                {T.klineBalance}
                <b className="num">{scale.formatMoney(hovered.balanceClose)}</b>
              </span>
              <span
                className={`kline__readout-item ${hovered.net >= 0 ? 'is-up' : 'is-down'}`}
              >
                {T.klineChange}
                <b className="num">
                  {hovered.net >= 0 ? '+' : '−'}
                  {scale.formatMoney(Math.abs(hovered.net))}
                </b>
              </span>
              <span className="kline__readout-item">
                {T.income}
                <b className="num is-up">{scale.formatMoney(hovered.income)}</b>
              </span>
              <span className="kline__readout-item">
                {T.expense}
                <b className="num is-down">{scale.formatMoney(hovered.expense)}</b>
              </span>
            </>
          ) : (
            <span className="kline__readout-hint">{T.klineHoverHint}</span>
          )}
        </div>

        <div className="kline__actions">
          {legendMa.length > 0 ? (
            <span className="kline__ma-legend" aria-hidden="true">
              {legendMa.map((entry, index) => (
                <span key={entry.windowSize} className={`kline__ma kline__ma--${index + 1}`}>
                  MA{entry.windowSize}
                  <b className="num">{entry.value === null ? '—' : scale.formatMoney(entry.value)}</b>
                </span>
              ))}
            </span>
          ) : null}
          {isZoomed ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetView}>
              <Icon name="refresh" size={13} />
              {T.klineResetZoom}
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="kline__stage"
        style={{ height: layout.height, cursor: dragRef.current ? 'grabbing' : 'crosshair' }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          setHover(null)
          dragRef.current = null
        }}
      >
        <canvas ref={canvasRef} className="kline__canvas" />

        {hovered && hoveredTransactions.length > 0 ? (
          <div
            className="kline__tip"
            style={{
              left: Math.min(Math.max(hover!.x + 14, 8), Math.max(8, layout.width - 268)),
              top: Math.min(Math.max(hover!.y - 8, 8), Math.max(8, layout.height - 200))
            }}
            role="tooltip"
          >
            <div className="kline__tip-head">
              <span>{formatDate(hovered.date, 'YYYY-MM-DD')}</span>
              <span className="muted">{klineTxCount(hoveredTransactions.length)}</span>
            </div>
            <ul className="kline__tip-list">
              {hoveredTransactions.slice(0, 6).map((transaction) => (
                <li key={transaction.id} className="kline__tip-row">
                  <span
                    className={`kline__tip-amount num ${transaction.type === 'income' ? 'is-up' : 'is-down'}`}
                  >
                    {transaction.type === 'income' ? '+' : '−'}
                    {scale.formatMoney(
                      transaction.convertedAmount === null
                        ? transaction.amount
                        : Math.abs(transaction.convertedAmount)
                    )}
                  </span>
                  <span className="kline__tip-body">
                    <span className="kline__tip-title truncate">
                      {transaction.merchant ?? transaction.categoryName ?? T.klineUnnamed}
                    </span>
                    <span className="kline__tip-meta truncate">
                      {[
                        transaction.categoryName,
                        transaction.accountName,
                        transaction.time,
                        transaction.convertedAmount === null ? T.noRateForPair : null
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {hoveredTransactions.length > 6 ? (
              <p className="kline__tip-more muted">{klineMoreTx(hoveredTransactions.length - 6)}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const KLINE_STYLES = `
.kline { display: flex; flex-direction: column; gap: var(--space-2); width: 100%; min-width: 0; }
.kline__toolbar {
  display: flex; align-items: center; gap: var(--space-3);
  min-height: 26px; flex-wrap: wrap;
}
.kline__readout { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; font-size: var(--text-xs); color: var(--text-secondary); }
.kline__readout-hint { color: var(--text-tertiary); }
.kline__readout-date { color: var(--text-primary); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
.kline__readout-item { display: inline-flex; align-items: baseline; gap: 4px; }
.kline__readout-item b { font-weight: var(--weight-semibold); color: var(--text-primary); }
.kline__readout-item.is-up b, b.is-up { color: var(--market-up); }
.kline__readout-item.is-down b, b.is-down { color: var(--market-down); }
.kline__actions { display: flex; align-items: center; gap: var(--space-2); margin-left: auto; }
.kline__ma-legend { display: inline-flex; gap: var(--space-2); font-size: var(--text-2xs); }
.kline__ma { display: inline-flex; gap: 3px; align-items: baseline; }
.kline__ma b { font-weight: var(--weight-medium); }
.kline__ma--1 { color: var(--market-ma-1); }
.kline__ma--2 { color: var(--market-ma-2); }
.kline__ma--3 { color: var(--market-ma-3); }
.kline__ma--4 { color: var(--market-ma-4); }
.kline__ma--5 { color: var(--market-ma-5); }

.kline__stage { position: relative; width: 100%; min-width: 0; touch-action: none; user-select: none; }
.kline__canvas { display: block; }

.kline__tip {
  position: absolute; z-index: 5; width: 258px;
  padding: var(--space-2) var(--space-3);
  background-color: var(--bg-glass);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  pointer-events: none;
  animation: pop-in var(--duration-fast) var(--ease-out) both;
}
.kline__tip-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2);
  font-size: var(--text-xs); font-weight: var(--weight-medium); color: var(--text-primary);
  padding-bottom: var(--space-1); margin-bottom: var(--space-1);
  border-bottom: 1px solid var(--border-subtle);
}
.kline__tip-head .muted { font-size: var(--text-2xs); font-weight: var(--weight-normal); }
.kline__tip-list { display: flex; flex-direction: column; gap: 5px; }
.kline__tip-row { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.kline__tip-amount {
  flex: 0 0 auto; min-width: 66px; font-size: var(--text-xs); font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
}
.kline__tip-amount.is-up { color: var(--market-up); }
.kline__tip-amount.is-down { color: var(--market-down); }
.kline__tip-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.kline__tip-title { font-size: var(--text-xs); color: var(--text-primary); }
.kline__tip-meta { font-size: var(--text-2xs); color: var(--text-tertiary); }
.kline__tip-more { margin: var(--space-1) 0 0; font-size: var(--text-2xs); }
`

export { bucketDaily as __bucketDaily, granularityForSpan as __granularityForSpan, movingAverage as __movingAverage }
