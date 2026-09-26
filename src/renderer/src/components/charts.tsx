/**
 * charts.tsx — hand-rolled chart primitives for SpendWise.
 *
 * WHY NO CHART LIBRARY
 * --------------------
 * recharts / d3 / chart.js all ship a runtime that would sit in the renderer
 * bundle of an offline-first desktop app. Every visual this app needs is a
 * handful of SVG attributes, so they are built here directly.
 *
 * MONEY RULE (see src/shared/lib/money.ts)
 * ----------------------------------------
 * Every `value` prop is an INTEGER count of minor currency units
 * (1850 === RM 18.50). Amounts are only ever added with integer arithmetic.
 * Division happens exclusively to derive geometry (a ratio), and every such
 * division is guarded so a zero denominator cannot push NaN or Infinity into an
 * SVG attribute. A NaN in `d` / `cx` / `width` makes the browser drop the whole
 * element silently, which is the classic invisible-chart bug this file is
 * written to avoid.
 *
 * COLOUR RULE
 * -----------
 * No literal colours. Series colours come from the caller (normally
 * `var(--chart-1)` … `var(--chart-8)`) or from PALETTE below; chrome uses
 * var(--border-subtle), var(--text-secondary) and var(--bg-surface).
 */

import { useId } from 'react'

import { formatMoney } from '@shared/lib/money'

/* ------------------------------------------------------------------------- */
/* numeric guards                                                            */
/* ------------------------------------------------------------------------- */

/** Coerce anything non-finite (NaN, ±Infinity) to 0 before it reaches the DOM. */
const safe = (n: number): number => (Number.isFinite(n) ? n : 0)

/** Clamp into [min, max], tolerating non-finite input. */
const clamp = (n: number, min: number, max: number): number => {
  const value = safe(n)
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Emit SVG geometry at 2 decimals: no float noise, shorter attribute strings. */
const round2 = (n: number): number => Math.round(safe(n) * 100) / 100

/** Amounts are integers; truncating here keeps a stray fraction out of the DOM. */
const toMinor = (n: number): number => Math.trunc(safe(n))

/** Series palette, cycled by index when the caller supplies no colour. */
const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)'
] as const

const paletteColor = (index: number): string =>
  PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]

/**
 * Axis labels stay readable for large amounts by switching to compact notation.
 * The threshold is in minor units (~1000 major units for a 2-decimal currency).
 */
const moneyLabel = (minor: number, currency?: string): string =>
  formatMoney(toMinor(minor), currency, { compact: Math.abs(toMinor(minor)) >= 100_000 })

/**
 * Shared empty state. A chart with nothing to draw renders this instead of an
 * axis-only frame, so callers get one consistent "no data" treatment.
 */
function EmptyState({ message, height }: { message: string; height?: number }) {
  return (
    <p
      className="chart-empty muted"
      style={{
        background: 'var(--bg-surface)',
        minHeight: height,
        margin: 0,
        padding: 'var(--space-4) var(--space-3)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-sm)',
        textAlign: 'center'
      }}
    >
      {message}
    </p>
  )
}

/* ------------------------------------------------------------------------- */
/* DonutChart                                                                */
/* ------------------------------------------------------------------------- */

export interface DonutSegment {
  /** Category name, surfaced in the native tooltip and the a11y label. */
  label: string
  /** Integer minor units. Non-positive values are not drawn. */
  value: number
  /** CSS colour, normally `var(--chart-N)`. */
  color: string
}

export interface DonutChartProps {
  segments: DonutSegment[]
  /** Outer diameter in px. */
  size?: number
  /** Ring thickness in px, clamped to a third of `size`. */
  thickness?: number
  centerLabel?: string
  centerSubLabel?: string
  currency?: string
}

/**
 * DonutChart — proportional ring built from stroked circles.
 *
 * Each slice is one <circle> whose dash pattern is `arc, circumference - arc`
 * and whose dash offset is its running start position; the group is rotated
 * -90° because an SVG circle starts at 3 o'clock and the chart must start at
 * 12 o'clock. Drawing real <path> arcs instead would need large-arc-flag maths
 * for slices past 180° — the dash trick has no such failure mode.
 *
 * Empty or all-zero data draws a single faint full ring (not nothing) and the
 * centre slot is still rendered, so a card keeps its shape on a quiet month.
 */
export function DonutChart({
  segments,
  size = 180,
  thickness = 22,
  centerLabel,
  centerSubLabel,
  currency
}: DonutChartProps) {
  const dim = Math.max(8, safe(size))
  // Capping the stroke at a third of the box guarantees radius > 0, so the
  // circumference used as the dash denominator can never be 0.
  const strokeWidth = clamp(thickness, 1, dim / 3)
  const radius = round2((dim - strokeWidth) / 2)
  const circumference = round2(2 * Math.PI * radius)
  const center = round2(dim / 2)
  const valueFontSize = round2(dim * 0.17)
  const captionFontSize = round2(dim * 0.08)

  // Integer addition only — money is never summed as a float.
  let total = 0
  for (const segment of segments) total += toMinor(segment.value)

  const visible = segments.filter((segment) => toMinor(segment.value) > 0)
  const hasData = total > 0 && visible.length > 0

  // A hairline gap between slices reads better than butt-jointed arcs. It is
  // derived from the circumference so a ring with many slices cannot lose whole
  // arcs to the gap.
  const gap = visible.length > 1 ? Math.min(2, circumference / (visible.length * 8)) : 0

  let cursor = 0
  const arcs = visible.map((segment) => {
    const value = toMinor(segment.value)
    // Ratio for geometry; guarded so a zero total yields 0 rather than NaN.
    const length = clamp((total > 0 ? value / total : 0) * circumference, 0, circumference)
    const drawn = length > gap ? length - gap : length
    const arc = { segment, value, length: round2(drawn), offset: round2(cursor) }
    cursor += length
    return arc
  })

  const description = hasData
    ? visible.map((segment) => `${segment.label} ${formatMoney(toMinor(segment.value), currency)}`).join(', ')
    : 'No spending recorded'
  const hasCaption = centerSubLabel !== undefined && centerSubLabel !== ''

  return (
    <svg
      className="chart-donut"
      viewBox={`0 0 ${dim} ${dim}`}
      width={dim}
      height={dim}
      role="img"
      aria-label={centerLabel !== undefined && centerLabel !== '' ? `${centerLabel}: ${description}` : description}
      style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
    >
      <g transform={`rotate(-90 ${center} ${center})`}>
        {hasData ? (
          arcs.map((arc, index) => (
            <circle
              key={`${arc.segment.label}-${index}`}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={arc.segment.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${arc.length} ${round2(circumference - arc.length)}`}
              strokeDashoffset={round2(-arc.offset)}
            >
              {/* Native tooltip: label + amount, no JS hover state needed. */}
              <title>{`${arc.segment.label}: ${formatMoney(arc.value, currency)}`}</title>
            </circle>
          ))
        ) : (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={strokeWidth}
          />
        )}
      </g>

      {centerLabel !== undefined && centerLabel !== '' && (
        <text
          className="chart-donut__value"
          x={center}
          y={hasCaption ? round2(center - valueFontSize * 0.25) : center}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={valueFontSize}
          fontWeight={600}
          style={{ fill: 'currentColor' }}
        >
          {centerLabel}
        </text>
      )}

      {hasCaption && (
        <text
          className="chart-donut__caption"
          x={center}
          y={round2(center + valueFontSize * 0.55)}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={captionFontSize}
          style={{ fill: 'var(--text-secondary)' }}
        >
          {centerSubLabel}
        </text>
      )}
    </svg>
  )
}

/* ------------------------------------------------------------------------- */
/* HorizontalBarChart                                                        */
/* ------------------------------------------------------------------------- */

export interface HorizontalBarRow {
  label: string
  /** Integer minor units. */
  value: number
  /** CSS colour; defaults to the next palette entry. */
  color?: string
  /** Optional right-aligned detail, e.g. "12 transactions". */
  meta?: string
}

export interface HorizontalBarChartProps {
  rows: HorizontalBarRow[]
  currency?: string
  /** Keep only the first N rows (already expected to be sorted by the caller). */
  maxRows?: number
  showRank?: boolean
}

/** A 0.4% slice of a large total rounds to a sub-pixel bar; this keeps it visible. */
const MIN_BAR_PCT = 2

/**
 * HorizontalBarChart — ranked list of labelled bars (DOM, not SVG).
 *
 * Bar width is `value / maxValue`; when maxValue is 0 (an all-zero period)
 * every bar is simply 0% wide instead of producing NaN%. Non-zero values are
 * floored at MIN_BAR_PCT so a tiny category is still perceptible, and each row
 * carries role="listitem" with the amount in a `.amount` span for styling.
 */
export function HorizontalBarChart({
  rows,
  currency,
  maxRows,
  showRank = false
}: HorizontalBarChartProps) {
  const limit = maxRows !== undefined && Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : rows.length
  const visible = rows.slice(0, limit)

  if (visible.length === 0) {
    return <EmptyState message="No spending to show yet." />
  }

  // Integer comparison only; no money arithmetic happens in this component.
  let maxValue = 0
  for (const row of visible) {
    const value = toMinor(row.value)
    if (value > maxValue) maxValue = value
  }

  return (
    <ul className="chart-bars" role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {visible.map((row, index) => {
        const value = toMinor(row.value)
        const meta = typeof row.meta === 'string' && row.meta !== '' ? row.meta : null
        const color = row.color ?? paletteColor(index)
        // Ratio is geometry, never money. Zero denominator -> 0 width.
        const ratio = maxValue > 0 ? clamp(value / maxValue, 0, 1) : 0
        const widthPct = value > 0 ? Math.max(ratio * 100, MIN_BAR_PCT) : 0

        return (
          <li
            key={`${row.label}-${index}`}
            role="listitem"
            className="chart-bars__row"
            style={{ marginBottom: 'var(--space-3)' }}
          >
            <div className="chart-bars__head" style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
              {showRank && (
                <span
                  className="chart-bars__rank muted"
                  style={{ fontSize: 'var(--text-xs)', minWidth: 'var(--space-4)' }}
                >
                  {index + 1}
                </span>
              )}
              <span className="chart-bars__label">{row.label}</span>
              {meta !== null && (
                <span
                  className="chart-bars__meta muted"
                  style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)' }}
                >
                  {meta}
                </span>
              )}
              {/* `.amount` is a global class: tabular figures for column alignment. */}
              <span className="amount" style={{ marginLeft: meta === null ? 'auto' : undefined }}>
                {formatMoney(value, currency)}
              </span>
            </div>
            <div
              className="chart-bars__track"
              style={{
                background: 'var(--border-subtle)',
                borderRadius: 'var(--radius-full)',
                height: 8,
                marginTop: 'var(--space-1)',
                overflow: 'hidden'
              }}
            >
              <div
                className="chart-bars__fill"
                style={{
                  width: `${round2(widthPct)}%`,
                  height: '100%',
                  background: color,
                  borderRadius: 'var(--radius-full)',
                  // Token-driven so the reduced-motion override in tokens.css applies.
                  transition: 'width var(--duration-base) var(--ease-out)'
                }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------------------------------------------------- */
/* LineChart                                                                 */
/* ------------------------------------------------------------------------- */

export interface LineChartPoint {
  label: string
  /** Integer minor units. */
  value: number
}

export interface LineChartProps {
  points: LineChartPoint[]
  /** Intrinsic viewBox width; the SVG itself scales to its container. */
  width?: number
  height?: number
  color?: string
  currency?: string
  /** Draw a soft gradient area under the line. */
  fill?: boolean
  /** Draw gridlines, the baseline and the axis labels. */
  showAxis?: boolean
}

/** At most this many x labels are drawn, so they can never overlap. */
const X_LABEL_LIMIT = 8
/** Interior gridlines; the top one doubles as the max-value level. */
const GRID_LINES = 4
/** Above this point count, per-point dots become noise. */
const DOT_LIMIT = 24

/**
 * LineChart — responsive line/area chart on an explicit viewBox.
 *
 * The SVG gets `width: 100%; height: auto`, so it scales with its container
 * while keeping the aspect ratio implied by the viewBox (no
 * preserveAspectRatio="none" stretching, which would distort the stroke).
 *
 * The y scale always spans zero, so `yFor(0)` is a real baseline rather than an
 * assumption. A zero range (all-zero series) collapses every point onto the
 * baseline instead of dividing by zero, and `points.length === 1` is drawn as a
 * flat line plus one dot — never a degenerate single-segment path.
 */
export function LineChart({
  points,
  width = 640,
  height = 220,
  color = 'var(--chart-1)',
  currency,
  fill = false,
  showAxis = true
}: LineChartProps) {
  // useId gives each instance its own gradient id; its raw value contains
  // characters that are not valid inside a `url(#…)` fragment, so it is
  // stripped down to alphanumerics.
  const gradientId = `chart-line-gradient-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  const w = Math.max(120, safe(width))
  const h = Math.max(60, safe(height))

  if (points.length === 0) {
    return <EmptyState message="No data for this period." height={round2(h)} />
  }

  const n = points.length
  const padLeft = showAxis ? 64 : 10
  const padRight = showAxis ? 16 : 10
  const padTop = 14
  const padBottom = showAxis ? 28 : 10

  const plotLeft = round2(padLeft)
  const plotRight = round2(Math.max(padLeft + 1, w - padRight))
  const plotTop = round2(padTop)
  const plotBottom = round2(Math.max(padTop + 1, h - padBottom))
  const plotWidth = round2(plotRight - plotLeft)
  const plotHeight = round2(plotBottom - plotTop)

  const values = points.map((point) => toMinor(point.value))

  let maxValue = 0
  let minValue = 0
  for (const value of values) {
    if (value > maxValue) maxValue = value
    if (value < minValue) minValue = value
  }

  // Including zero in the scale keeps the baseline honest for negative series
  // too (e.g. net cash flow), without a second y-axis concept.
  const low = Math.min(0, minValue)
  const high = Math.max(0, maxValue)
  const range = high - low

  const yFor = (value: number): number =>
    range > 0 ? round2(plotBottom - ((value - low) / range) * plotHeight) : plotBottom

  const xFor = (index: number): number =>
    n === 1 ? round2(plotLeft + plotWidth / 2) : round2(plotLeft + (index / (n - 1)) * plotWidth)

  const baselineY = yFor(0)
  const singleValue = values[0]
  const firstX = n === 1 ? plotLeft : xFor(0)
  const lastX = n === 1 ? plotRight : xFor(n - 1)

  const linePath =
    n === 1
      ? `M ${firstX} ${yFor(singleValue)} L ${lastX} ${yFor(singleValue)}`
      : values
          .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(value)}`)
          .join(' ')

  const areaPath = `${linePath} L ${lastX} ${baselineY} L ${firstX} ${baselineY} Z`

  // Evenly spaced indices including the first and the last, capped at
  // X_LABEL_LIMIT so labels never collide on a dense series.
  const labelIndices: number[] = []
  if (showAxis) {
    if (n === 1) {
      labelIndices.push(0)
    } else {
      const count = Math.min(n, X_LABEL_LIMIT)
      const seen = new Set<number>()
      for (let i = 0; i < count; i += 1) {
        const index = Math.round((i * (n - 1)) / (count - 1))
        if (!seen.has(index)) {
          seen.add(index)
          labelIndices.push(index)
        }
      }
    }
  }

  const gridYs: number[] = []
  if (showAxis && range > 0) {
    for (let i = 1; i <= GRID_LINES; i += 1) {
      gridYs.push(yFor(low + (range * i) / GRID_LINES))
    }
  }

  const showDots = n <= DOT_LIMIT
  const lastValue = values[n - 1]
  const description = `${n} data ${n === 1 ? 'point' : 'points'}, latest ${formatMoney(lastValue, currency)}`

  return (
    <div className="chart-line">
      <svg
        className="chart-line__svg"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={description}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        {fill && (
          <defs>
            {/* Fades to fully transparent: a faint wash, never a solid block. */}
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}

        {gridYs.map((y, index) => (
          <line
            key={`grid-${index}`}
            x1={plotLeft}
            y1={y}
            x2={plotRight}
            y2={y}
            stroke="var(--border-subtle)"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ))}

        <line
          x1={plotLeft}
          y1={baselineY}
          x2={plotRight}
          y2={baselineY}
          stroke="var(--border-subtle)"
          strokeWidth={1}
        />

        {fill && <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />}

        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {showDots &&
          values.map((value, index) => {
            const isLast = index === n - 1
            return (
              <circle
                key={`dot-${index}`}
                cx={xFor(index)}
                cy={yFor(value)}
                r={isLast ? 3 : 2}
                fill={isLast ? 'var(--accent)' : color}
              />
            )
          })}

        {showAxis && high !== 0 && (
          <text
            x={round2(plotLeft - 10)}
            y={round2(plotTop + 8)}
            textAnchor="end"
            fontSize={11}
            style={{ fill: 'var(--text-secondary)' }}
          >
            {moneyLabel(high, currency)}
          </text>
        )}

        {showAxis && (
          <text
            x={round2(plotLeft - 10)}
            y={round2(clamp(baselineY - 6, plotTop + 8, plotBottom - 2))}
            textAnchor="end"
            fontSize={11}
            style={{ fill: 'var(--text-secondary)' }}
          >
            {formatMoney(0, currency)}
          </text>
        )}

        {labelIndices.map((index) => (
          <text
            key={`xlabel-${index}`}
            x={xFor(index)}
            y={round2(plotBottom + 16)}
            textAnchor={n === 1 || (index !== 0 && index !== n - 1) ? 'middle' : index === 0 ? 'start' : 'end'}
            fontSize={11}
            style={{ fill: 'var(--text-secondary)' }}
          >
            {points[index].label}
          </text>
        ))}
      </svg>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* Sparkline                                                                 */
/* ------------------------------------------------------------------------- */

export interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  color?: string
}

/**
 * Sparkline — tiny trend line for summary cards.
 *
 * No axes, no labels, no tooltips: it is decorative, so it is hidden from
 * assistive tech (the surrounding card carries the real numbers).
 *
 * Fewer than two values (including an empty array) has no slope to draw and no
 * range to normalise against, so it renders a flat line through the middle.
 */
export function Sparkline({ values, width = 120, height = 32, color = 'var(--chart-1)' }: SparklineProps) {
  const w = Math.max(8, safe(width))
  const h = Math.max(4, safe(height))
  const strokeWidth = 1.5
  // Inset by half the stroke so the line is never clipped at the edges.
  const pad = strokeWidth / 2 + 0.5
  const top = pad
  const bottom = Math.max(top + 0.5, h - pad)
  const middle = round2((top + bottom) / 2)

  const series = values.map(toMinor)
  let d: string

  if (series.length < 2) {
    d = `M ${round2(pad)} ${middle} L ${round2(w - pad)} ${middle}`
  } else {
    let min = series[0]
    let max = series[0]
    for (const value of series) {
      if (value < min) min = value
      if (value > max) max = value
    }
    // Flat series (min === max) has a zero range: keep the line centred rather
    // than dividing by zero.
    const span = max - min
    const step = (w - pad * 2) / (series.length - 1)
    d = series
      .map((value, index) => {
        const x = round2(pad + index * step)
        const y = span > 0 ? round2(bottom - ((value - min) / span) * (bottom - top)) : middle
        return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
      })
      .join(' ')
  }

  return (
    <svg
      className="chart-sparkline"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* ------------------------------------------------------------------------- */
/* ProgressBar                                                               */
/* ------------------------------------------------------------------------- */

export interface ProgressBarProps {
  /** Integer minor units spent so far. */
  value: number
  /** Integer minor units of budget. 0 means "no budget set". */
  max: number
  color?: string
  height?: number
  /** Opt in to the restrained over-budget treatment. */
  showOverflow?: boolean
  'aria-label'?: string
}

/**
 * ProgressBar — budget progress track.
 *
 * The visual fill is clamped at 100% so a blown budget cannot paint outside its
 * track; the overspend is communicated by the overflow treatment instead
 * (var(--expense) fill plus a thicker right edge), which the spec asks to keep
 * noticeable but restrained rather than alarm-like.
 *
 * `max === 0` means no budget was set: there is no ratio to compute, so the
 * track simply stays empty instead of evaluating 0/0.
 */
export function ProgressBar({
  value,
  max,
  color = 'var(--chart-1)',
  height = 8,
  showOverflow = false,
  'aria-label': ariaLabel = 'Progress'
}: ProgressBarProps) {
  const current = Math.max(0, toMinor(value))
  const total = Math.max(0, toMinor(max))

  // Geometry only; guarded against a zero denominator.
  const ratio = total > 0 ? clamp(current / total, 0, 1) : 0
  // The *reported* percentage is not clamped: the bar stops at 100% wide, but
  // "135% of budget" is the honest figure for assistive tech.
  const actualPercent = total > 0 ? safe(Math.round((current / total) * 100)) : 0
  // With no budget defined there is nothing to exceed, so the overflow styling
  // stays off even when a value is present.
  const overBudget = showOverflow && total > 0 && current > total

  const barHeight = clamp(height, 2, 48)
  const fillColor = overBudget ? 'var(--expense)' : color
  const valueText =
    total > 0 ? `${actualPercent}% of budget${overBudget ? ' — over budget' : ''}` : 'No budget set'

  return (
    <div
      className={overBudget ? 'progress-bar is-over-budget' : 'progress-bar'}
      role="progressbar"
      aria-label={ariaLabel}
      /* valuenow is clamped into [min, max] to keep the ARIA range valid; the
         over-budget fact is carried by aria-valuetext (and data-overflow). */
      aria-valuenow={total > 0 ? Math.min(current, total) : 0}
      aria-valuemin={0}
      aria-valuemax={total > 0 ? total : 0}
      aria-valuetext={valueText}
      data-overflow={overBudget ? 'true' : undefined}
      style={{
        background: 'var(--border-subtle)',
        borderRadius: 'var(--radius-full)',
        height: barHeight,
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      <div
        className="progress-bar__fill"
        style={{
          width: `${round2(ratio * 100)}%`,
          height: '100%',
          background: fillColor,
          borderRadius: 'var(--radius-full)',
          transition: 'width var(--duration-base) var(--ease-out), background-color var(--duration-base) var(--ease-out)'
        }}
      />
      {overBudget && (
        <span
          className="progress-bar__overflow"
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 3,
            background: 'var(--expense)'
          }}
        />
      )}
    </div>
  )
}
