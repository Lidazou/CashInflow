/**
 * Donut3D.tsx — the large, three-dimensional category donut.
 *
 * WHY THIS EXISTS SEPARATELY FROM charts.tsx
 * ------------------------------------------
 * `DonutChart` is a flat 180px ring: correct, small, and one of several equal
 * widgets on a page. This one is the visual anchor of its card at 320px, and the
 * brief asks for genuine depth — a raised ring with a visible side wall and a
 * contact shadow — plus a centre slot that holds a large figure, a caption and a
 * date range *inside the hole* without clipping any of them.
 *
 * HOW THE DEPTH IS BUILT (SVG only, no canvas, no filters beyond a blur)
 * ---------------------------------------------------------------------
 * Bottom to top, exactly four layers:
 *
 *   1. Extrusion ring — the same arcs, drawn again one darkening step down and
 *      translated downward by `depth`. This is the side wall that makes the ring
 *      look like a solid object rather than a flat stroke. The darkening is a
 *      single CSS `filter: brightness()` on the group (see DONUT3D_STYLES), so
 *      every slice — including caller-supplied colours — is treated identically.
 *   2. Contact shadow — one blurred ellipse just under the ring's lower edge, at
 *      low opacity. "Floats slightly", not "glows": nothing here is additive,
 *      nothing is bright, and the opacity is a constant.
 *   3. Top face — stroked circles with `stroke-dasharray` / `stroke-dashoffset`,
 *      the same technique as DonutChart, rotated -90° so slices start at 12
 *      o'clock. Real arc paths would need large-arc-flag maths past 180°; the
 *      dash trick has no such failure mode.
 *   4. Sheen — one extra full-circle stroke in a `radialGradient` that runs from
 *      a translucent light tone at the outer edge to fully transparent at the
 *      hole. Reads as a polished, curved surface. The gradient id is derived from
 *      `useId()` so two donuts on one page cannot capture each other's paint.
 *
 * MONEY RULE (see src/shared/lib/money.ts)
 * ----------------------------------------
 * `value` is an INTEGER count of minor units (1850 === RM 18.50). Values are only
 * ever added as integers. Division happens exclusively to derive ratios
 * (a slice's share of the ring, a slice's mid-angle), and every one of those
 * divisions sits behind `safe()` / a zero-total guard, because a `NaN` reaching
 * `stroke-dasharray` makes the browser drop the element silently — the classic
 * invisible-chart bug.
 *
 * COLOUR RULE
 * -----------
 * No literal colours. Slice colours come from the caller (`var(--chart-1)` …);
 * chrome uses tokens. The two component-local custom properties below exist only
 * because the sheen must be light and the shadow must be dark in BOTH themes,
 * and no single token is both: they are defined from tokens per theme.
 */

import { useId, useState } from 'react'
import type { CSSProperties, JSX } from 'react'

import { T } from '@shared/lib/i18n'
import { formatMoney } from '@shared/lib/money'

export interface Donut3DSegment {
  /** Category name; used in the native tooltip and the a11y summary. */
  label: string
  /** Integer minor units, e.g. 1850 for RM 18.50. Never a float. */
  value: number
  /** CSS colour, normally `var(--chart-N)`. */
  color: string
  /** Overrides `currency` for this slice only. */
  currency?: string
  /** Optional transaction count, offered to assistive tech. */
  count?: number
  /**
   * The category's id, when the slice came from one (v1.6.0).
   *
   * Carried so a click can open the real category — the transaction list filtered to
   * those rows — instead of a look-alike detail view keyed on a display NAME. A name is
   * a label the user can change and two categories can share across types; the id is the
   * thing every other screen already filters by.
   */
  categoryId?: number | null
}

/** What the hover card needs, gathered in one place. */
export interface Donut3DHover {
  label: string
  value: number
  percent: number
  count?: number
  color: string
  currency?: string
}

export interface Donut3DProps {
  segments: Donut3DSegment[]
  /** Outer diameter in px. Default 320. */
  size?: number
  /** Ring thickness in px. Default 44. */
  thickness?: number
  /** Big figure in the middle (already formatted, e.g. "¥2,806.50"). */
  centerLabel?: string
  /** Caption under the big figure, e.g. "本期结余". */
  centerSubLabel?: string
  /** Small line under the caption, e.g. "9月5日 – 10月4日". */
  centerHint?: string
  /**
   * Extra line at the very bottom of the centre slot, e.g. "余额 ¥12,000.00".
   *
   * Separate from `centerHint` rather than appended to it because the two answer
   * different questions and only this one is optional: the hint says WHICH period
   * is being shown and the footnote says what the account holds right now. A
   * period with no transactions is exactly when the footnote matters most — the
   * big figure is legitimately ¥0 and looks like a failed load without it.
   */
  centerFootnote?: string
  /**
   * Font size for `centerFootnote`, in px. Omit to auto-fit.
   *
   * Auto-fitting shrinks text until it fits the hole, which is right for a figure
   * that must never clip but wrong for a footnote: a long balance would render at
   * 9px and be the least readable line in the card. Callers that know their card
   * has room pass a size and let the ellipsis handle the pathological case.
   */
  footnoteSize?: number
  /**
   * Display currency for the tooltips and the a11y summary. Values are expected
   * to already be in this currency — conversion is the caller's job, because the
   * page owns the period and the rate table that the figure was computed with.
   */
  currency?: string
  /**
   * Called when a slice is clicked, for drilling into a category. Slices are only
   * focusable (role="button", tabIndex) when this is supplied.
   */
  onSegmentClick?: (segment: Donut3DSegment, index: number) => void
  /**
   * Hover affordances: lift the hovered slice and dim the rest. Default true.
   * Turning it off leaves the ring fully clickable but visually static.
   */
  interactive?: boolean
  /**
   * Show a card next to the ring while a slice is hovered (v1.6.0).
   *
   * Hovering used to lift a slice and dim the others, which says WHICH one you are on
   * but not what it is worth — so the reader had to move to the legend and match colours
   * by eye. The card prints the three things a ring can never say on its own: the name,
   * the amount and the share. Defaults to true; the card only appears when `interactive`
   * is on, because a static ring that pops up a card is a contradiction.
   */
  showHoverCard?: boolean
  /** Called with the hovered slice (or null), for a caller that wants to mirror it. */
  onSegmentHover?: (segment: Donut3DSegment | null, index: number | null) => void
}

/* ------------------------------------------------------------------------- */
/* numeric guards — nothing non-finite may reach an SVG attribute            */
/* ------------------------------------------------------------------------- */

/** Coerce anything non-finite (NaN, ±Infinity) to 0 before it reaches the DOM. */
const safe = (n: number): number => (Number.isFinite(n) ? n : 0)

/** Clamp into [min, max], tolerating non-finite input. */
const clamp = (n: number, min: number, max: number): number => {
  const value = safe(n)
  // `max` is authoritative when the caller passes an inverted range.
  const low = Math.min(min, max)
  const high = Math.max(min, max)
  if (value < low) return low
  if (value > high) return high
  return value
}

/** Emit geometry at 2 decimals: no float noise, shorter attribute strings. */
const round2 = (n: number): number => Math.round(safe(n) * 100) / 100

/** Percentages read better at one decimal ("43.2%"). */
const round1 = (n: number): number => Math.round(safe(n) * 10) / 10

/** Amounts are integers; truncating here keeps a stray fraction out of the DOM. */
const toMinor = (n: number): number => Math.trunc(safe(n))

/* ------------------------------------------------------------------------- */
/* text measurement                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Rough advance width of a string, in ems, for the fonts this app ships.
 *
 * The centre slot must never clip, and the only way to guarantee that without a
 * DOM measurement pass (which would need a layout effect and a re-render, and
 * still be wrong on the first paint) is to estimate the width and shrink the
 * font until it fits. The estimate is deliberately pessimistic — every group
 * rounds up — so a value that fits by this model fits in reality.
 */
function advanceEm(text: string): number {
  let em = 0
  for (const ch of text) {
    if (ch === ' ' || ch === '\u00a0') em += 0.3
    else if (ch >= '0' && ch <= '9') em += 0.6 // tabular figures
    else if (ch === '.' || ch === ',' || ch === ':' || ch === "'" || ch === '\u00b7') em += 0.32
    else if (ch === '-' || ch === '+' || ch === '%' || ch === '/') em += 0.38
    else if (ch >= 'A' && ch <= 'Z') em += 0.7
    // CJK, full-width forms and CJK punctuation are one em wide.
    else if (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) em += 1
    else em += 0.58
  }
  return em
}

/**
 * Largest font size at or below `ideal` whose estimated width fits `maxWidth`.
 * Never returns more than `ideal` (the design size) nor less than `min`.
 */
function fitFontSize(text: string, maxWidth: number, ideal: number, min: number): number {
  const design = round2(ideal)
  const floor = Math.min(min, design)
  if (text === '' || !(maxWidth > 0)) return design
  const em = advanceEm(text)
  if (!(em > 0)) return design
  return round2(clamp(Math.min(design, maxWidth / em), floor, design))
}

/* ------------------------------------------------------------------------- */
/* styles                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Component-local styles.
 *
 * Two custom properties are declared here because no single token is both a light
 * sheen and a dark shadow:
 *   --donut3d-sheen    outer-edge highlight
 *   --donut3d-shadow   contact shadow
 *
 * The base values are the DARK-theme pair (a near-white sheen over a dark card),
 * and `.light` picks the other end of the same scale. Toggling `.light` rather
 * than `.dark` matches tokens.css, where dark is `:root` and light opts out.
 */
const DONUT3D_STYLES = `
.donut3d {
  --donut3d-sheen: var(--text-primary);
  --donut3d-shadow: var(--bg-inset);
  position: relative;
  max-width: 100%;
}
.light .donut3d {
  --donut3d-sheen: var(--bg-surface);
  --donut3d-shadow: var(--text-primary);
}
.donut3d__svg { display: block; max-width: 100%; height: auto; }
/* The side wall: identical arcs, one darkening step down. */
.donut3d__base { filter: brightness(0.62); }
/* Decorative layers must never intercept a slice's hover. */
.donut3d__base, .donut3d__shadow, .donut3d__sheen { pointer-events: none; }
.donut3d__slice {
  transition: transform var(--duration-base) var(--ease-out), opacity var(--duration-base) var(--ease-out);
}
.donut3d__slice.is-clickable { cursor: pointer; }
.donut3d__center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  text-align: center;
}
.donut3d__value {
  font-weight: var(--weight-bold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  letter-spacing: -0.02em;
  line-height: var(--leading-tight);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.donut3d__caption {
  color: var(--text-secondary);
  line-height: var(--leading-tight);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.donut3d__hint {
  color: var(--text-tertiary);
  line-height: var(--leading-tight);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* ---- the hover card (v1.6.0) ----
   Over the ring's top-right corner, where it covers the least of the slice being
   asked about. Compact on purpose: name, amount, share, count, and how to open it. */
.donut3d__hover {
  position: absolute; top: 4px; right: -6px; z-index: 3;
  display: flex; flex-direction: column; gap: 1px; min-width: 132px; max-width: 210px;
  padding: 7px 10px; border-radius: var(--radius-md);
  background-color: var(--bg-surface-raised);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-md);
  pointer-events: none; text-align: left;
  animation: donut3d-hover var(--duration-fast) var(--ease-out);
}
@keyframes donut3d-hover {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .donut3d__hover { animation: none; }
}
.donut3d__hover-name {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--text-xs); color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.donut3d__hover-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.donut3d__hover-value { font-size: var(--text-base); color: var(--text-primary); font-variant-numeric: tabular-nums; }
.donut3d__hover-meta { font-size: var(--text-2xs); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.donut3d__hover-hint { font-size: var(--text-2xs); color: var(--accent-text); margin-top: 2px; }
/* The footnote is the one line in the slot that carries a live account figure,
   so it gets a subtle rule above it to separate it from the period metadata.
   It is deliberately the SAME colour and size as the hint: bolding it competed
   with the ring's own centre figure, which is still the primary number. */
.donut3d__footnote {
  color: var(--text-secondary);
  line-height: var(--leading-tight);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-top: 5px;
  margin-top: 3px;
  border-top: 1px solid var(--border-subtle);
}
@media (prefers-reduced-motion: reduce) {
  .donut3d__slice { transition: none; }
}
`

/** Opacity applied to every slice that is not the hovered one. */
const DIM_OPACITY = 0.4
/** Contact-shadow strength. Constant, and low: the spec forbids glow. */
const SHADOW_OPACITY = 0.14
/** Sheen strength at the outer edge. Constant, and low. */
const SHEEN_OPACITY = 0.18

/* ------------------------------------------------------------------------- */
/* Donut3D                                                                   */
/* ------------------------------------------------------------------------- */

interface Arc {
  segment: Donut3DSegment
  /** Index in the ORIGINAL `segments` array, so clicks report the caller's index. */
  index: number
  value: number
  /** Drawn arc length, already shortened by the inter-slice gap. */
  arc: number
  /** `circumference - arc`, precomputed so the attribute string stays short. */
  dash: number
  /** Dash offset, negative so the slice starts where the cursor is. */
  offset: number
  /** Mid-angle in radians, in the rotated (12 o'clock) frame. */
  midAngle: number
  percent: number
}

export function Donut3D({
  segments,
  size = 320,
  thickness = 44,
  centerLabel,
  centerSubLabel,
  centerHint,
  centerFootnote,
  footnoteSize,
  currency,
  onSegmentClick,
  interactive = true,
  showHoverCard = true,
  onSegmentHover
}: Donut3DProps): JSX.Element {
  // Two donuts on one page must not share a gradient or filter id. useId() emits
  // characters that are not valid in a url(#…) fragment, so keep alphanumerics.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const sheenId = `donut3d-sheen-${uid}`
  const shadowId = `donut3d-shadow-${uid}`

  const [highlighted, setHighlighted] = useState<number | null>(null)

  /* ---- geometry -------------------------------------------------------- */
  const dim = Math.max(80, round2(size))
  // Capping the stroke at size/3.2 keeps the hole open: radius stays >= 0.34·dim,
  // so the circumference used as the dash denominator can never be 0.
  const strokeWidth = round2(clamp(thickness, 1, dim / 3.2))
  const radius = round2((dim - strokeWidth) / 2)
  const circumference = round2(2 * Math.PI * radius)
  const center = round2(dim / 2)
  const outerRadius = round2(dim / 2)

  // Extrusion depth scales with the donut, but is bounded: below 6px it reads as
  // a rendering artefact, above 10px the ring looks like a wedding cake.
  const depth = round2(clamp(dim * 0.028, 6, 10))
  const blur = round2(clamp(dim * 0.019, 4, 8))
  const shadowRy = round2(dim * 0.045)
  // Sits just above the bottom of the extrusion, so the visible sliver is a
  // contact shadow rather than a puddle.
  const shadowCy = round2(dim + depth - dim * 0.02)
  const height = round2(dim + depth + shadowRy + blur * 2)

  /** Radial distance a hovered slice travels outward. */
  const lift = round2(clamp(dim * 0.014, 3, 5))

  /* ---- centre slot ----------------------------------------------------- */
  // The hole's inner diameter, then the usable text width inside it. The 24px is
  // breathing room, so the figure never touches the ring's inner edge.
  const holeDiameter = round2(dim - 2 * strokeWidth)
  const textBox = round2(Math.max(40, dim - 2 * strokeWidth - 24))
  const textBoxHeight = round2(Math.max(40, holeDiameter - 24))
  const slotX = round2(center - textBox / 2)
  const slotY = round2(center - textBoxHeight / 2)

  const hasValue = centerLabel !== undefined && centerLabel !== ''
  const hasCaption = centerSubLabel !== undefined && centerSubLabel !== ''
  const hasHint = centerHint !== undefined && centerHint !== ''
  const hasFootnote = centerFootnote !== undefined && centerFootnote !== ''

  // One label is one line that must not overflow: shrink it, and let CSS clip
  // with an ellipsis as the final backstop.
  const valueFontSize = fitFontSize(centerLabel ?? '', textBox, dim * 0.13, 11)
  const captionFontSize = fitFontSize(centerSubLabel ?? '', textBox, dim * 0.05, 10)
  const hintFontSize = fitFontSize(centerHint ?? '', textBox, Math.min(12, dim * 0.0375), 9)
  const footnoteFontSize =
    typeof footnoteSize === 'number' && Number.isFinite(footnoteSize) && footnoteSize > 0
      ? round2(clamp(footnoteSize, 9, dim * 0.1))
      : fitFontSize(centerFootnote ?? '', textBox, Math.min(13, dim * 0.042), 9)

  /* ---- slices ---------------------------------------------------------- */
  // Integer addition only. Non-positive values are not drawn and, deliberately,
  // are not part of the total either: a negative "slice" would make the
  // percentages sum to something other than 100.
  let total = 0
  for (const segment of segments) {
    const value = toMinor(segment.value)
    if (value > 0) total += value
  }

  const drawable = segments
    .map((segment, index) => ({ segment, index, value: toMinor(segment.value) }))
    .filter((entry) => entry.value > 0)

  const hasData = total > 0 && drawable.length > 0

  // A hairline gap between slices reads better than butt-jointed arcs, and is
  // derived from the circumference so a many-sliced ring cannot lose whole arcs.
  const gap = drawable.length > 1 ? Math.min(2, circumference / (drawable.length * 8)) : 0

  let cursor = 0
  const arcs: Arc[] = drawable.map(({ segment, index, value }) => {
    // Geometry only, and `total > 0` is guaranteed by `hasData` above.
    const share = total > 0 ? value / total : 0
    const length = clamp(share * circumference, 0, circumference)
    const arc = length > gap ? length - gap : length
    const offset = cursor
    cursor += length
    // Circumference is > 0 (see strokeWidth clamp), so this cannot be NaN.
    const midAngle = ((offset + length / 2) / circumference) * Math.PI * 2
    return {
      segment,
      index,
      value,
      arc: round2(arc),
      dash: round2(circumference - arc),
      offset: round2(-offset),
      midAngle,
      percent: round1(share * 100)
    }
  })

  const clickable = typeof onSegmentClick === 'function'

  /** Hover/focus treatment: slide outward along the slice's own mid-angle. */
  const sliceStyle = (arc: Arc): CSSProperties => {
    const lifted = interactive && highlighted === arc.index
    const dimmed = interactive && highlighted !== null && highlighted !== arc.index
    return {
      transform: lifted
        ? `translate(${round2(Math.cos(arc.midAngle) * lift)}px, ${round2(Math.sin(arc.midAngle) * lift)}px)`
        : 'translate(0px, 0px)',
      opacity: dimmed ? DIM_OPACITY : 1
    }
  }

  const money = (value: number, segment: Donut3DSegment): string =>
    formatMoney(value, segment.currency ?? currency)

  /* ---- accessibility --------------------------------------------------- */
  const description = hasData
    ? arcs
        .map((arc) => {
          const count =
            typeof arc.segment.count === 'number' && Number.isFinite(arc.segment.count)
              ? `，${Math.trunc(arc.segment.count)} 笔`
              : ''
          return `${arc.segment.label} ${money(arc.value, arc.segment)}（${arc.percent}%）${count}`
        })
        .join('；')
    : T.noData

  const ariaLabel = hasValue ? `${centerLabel}，${description}` : description

  /** The hovered slice, resolved once and used by the card and the a11y text. */
  const hovered = interactive && highlighted !== null ? (arcs.find((arc) => arc.index === highlighted) ?? null) : null

  /* ---- layers ---------------------------------------------------------- */
  const baseRing = hasData ? (
    arcs.map((arc) => (
      <circle
        key={`base-${arc.segment.label}-${arc.index}`}
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={arc.segment.color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${arc.arc} ${arc.dash}`}
        strokeDashoffset={arc.offset}
        // The side wall of a lifted slice travels with it, or the object tears.
        style={sliceStyle(arc)}
      />
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
  )

  return (
    <div className="donut3d" style={{ width: dim, position: 'relative' }}>
      <style>{DONUT3D_STYLES}</style>
      <svg
        className="donut3d__svg"
        viewBox={`0 0 ${dim} ${height}`}
        width={dim}
        height={height}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          {/*
            The blur region is generous in every direction: a filter that clips
            its own tail leaves a hard rectangular edge where the shadow should
            fade out. sRGB interpolation keeps the opacity arithmetic predictable.
          */}
          <filter
            id={shadowId}
            x="-25%"
            y="-120%"
            width="150%"
            height="340%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation={blur} />
          </filter>

          {/*
            One concentric radial gradient for the whole ring: transparent from
            the centre out to the hole, then rising to a light edge. Applied to a
            full-circle stroke this is what makes the band read as curved.
          */}
          <radialGradient id={sheenId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--donut3d-sheen)" stopOpacity={0} />
            <stop
              offset={`${round2(clamp(((radius - strokeWidth / 2) / radius) * 100, 0, 100))}%`}
              stopColor="var(--donut3d-sheen)"
              stopOpacity={0}
            />
            <stop offset="100%" stopColor="var(--donut3d-sheen)" stopOpacity={SHEEN_OPACITY} />
          </radialGradient>
        </defs>

        {/* 1. Extrusion ring — the side wall, one step darker, pushed down. */}
        <g className="donut3d__base" transform={`translate(0 ${depth})`}>
          <g transform={`rotate(-90 ${center} ${center})`}>{baseRing}</g>
        </g>

        {/* 2. Contact shadow — keeps the ring looking like it rests on the card. */}
        <ellipse
          className="donut3d__shadow"
          cx={center}
          cy={shadowCy}
          rx={outerRadius}
          ry={shadowRy}
          fill="var(--donut3d-shadow)"
          opacity={SHADOW_OPACITY}
          filter={`url(#${shadowId})`}
        />

        {/* 3. Top face — the slices themselves. */}
        <g className="donut3d__top" transform={`rotate(-90 ${center} ${center})`}>
          {hasData ? (
            arcs.map((arc) => (
              <circle
                key={`slice-${arc.segment.label}-${arc.index}`}
                className={clickable ? 'donut3d__slice is-clickable' : 'donut3d__slice'}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={arc.segment.color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${arc.arc} ${arc.dash}`}
                strokeDashoffset={arc.offset}
                style={sliceStyle(arc)}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-label={clickable ? `${arc.segment.label} ${money(arc.value, arc.segment)}` : undefined}
                onMouseEnter={
                  interactive
                    ? () => {
                        setHighlighted(arc.index)
                        onSegmentHover?.(arc.segment, arc.index)
                      }
                    : undefined
                }
                onMouseLeave={
                  interactive
                    ? () => {
                        setHighlighted(null)
                        onSegmentHover?.(null, null)
                      }
                    : undefined
                }
                onFocus={
                  interactive
                    ? () => {
                        setHighlighted(arc.index)
                        onSegmentHover?.(arc.segment, arc.index)
                      }
                    : undefined
                }
                onBlur={
                  interactive
                    ? () => {
                        setHighlighted(null)
                        onSegmentHover?.(null, null)
                      }
                    : undefined
                }
                onClick={clickable ? () => onSegmentClick?.(arc.segment, arc.index) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                          event.preventDefault()
                          onSegmentClick?.(arc.segment, arc.index)
                        }
                      }
                    : undefined
                }
              >
                {/* Native tooltip: label, amount and share, with no JS hover state. */}
                <title>{`${arc.segment.label} · ${money(arc.value, arc.segment)} · ${arc.percent}%`}</title>
              </circle>
            ))
          ) : (
            /* Empty or all-zero: one faint full ring, so the card keeps its shape
               and the 3D base + shadow still read as a deliberate object. */
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

        {/* 4. Sheen — a single full-circle stroke, over everything else. */}
        <circle
          className="donut3d__sheen"
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={`url(#${sheenId})`}
          strokeWidth={strokeWidth}
        />

        {/*
          Centre slot. A <foreignObject> keeps the figure, the caption and the
          hint in the SVG's own coordinate system, so they scale with the chart
          and stay inside the hole at every rendered size. It does not accept
          pointer events, so it can never block a slice underneath it.
        */}
        <foreignObject
          x={slotX}
          y={slotY}
          width={textBox}
          height={textBoxHeight}
          style={{ pointerEvents: 'none' }}
        >
          <div className="donut3d__center" style={{ gap: round2(dim * 0.02) }}>
            {hasValue ? (
              <div className="donut3d__value num" style={{ fontSize: valueFontSize }}>
                {centerLabel}
              </div>
            ) : null}
            {hasCaption ? (
              <div className="donut3d__caption" style={{ fontSize: captionFontSize }}>
                {centerSubLabel}
              </div>
            ) : null}
            {hasHint ? (
              <div className="donut3d__hint" style={{ fontSize: hintFontSize }}>
                {centerHint}
              </div>
            ) : null}
            {hasFootnote ? (
              <div className="donut3d__footnote" style={{ fontSize: footnoteFontSize }}>
                {centerFootnote}
              </div>
            ) : null}
          </div>
        </foreignObject>
      </svg>

      {/*
        The hover card (v1.6.0).

        Positioned over the ring's top-right rather than following the pointer: a ring is
        a small target and a card that chases the cursor covers the very slice being
        asked about. HTML rather than SVG text because it is a three-line table that
        should inherit the theme's type scale and tokens.

        The three facts are the ones a ring cannot state by itself — name, amount, share —
        plus the transaction count when the caller knows it (spec §23, §27). Colour is
        never the only channel.
      */}
      {interactive && showHoverCard && hovered !== null ? (
        <div className="donut3d__hover" role="status" data-segment-index={hovered.index}>
          <span className="donut3d__hover-name">
            <i className="donut3d__hover-dot" style={{ backgroundColor: hovered.segment.color }} />
            {hovered.segment.label}
          </span>
          <b className="donut3d__hover-value num">{money(hovered.value, hovered.segment)}</b>
          <span className="donut3d__hover-meta num">
            {hovered.percent}%
            {typeof hovered.segment.count === 'number' && Number.isFinite(hovered.segment.count)
              ? ` · ${Math.trunc(hovered.segment.count)} 笔`
              : ''}
          </span>
          {clickable ? <span className="donut3d__hover-hint">{T.donutClickHint}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
