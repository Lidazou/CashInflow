import { minorUnitScale } from '@shared/lib/money'
import type { KlineGranularity } from '@shared/types'

/**
 * Continuous time for the cashflow chart.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * v1.5.0's chart zoomed in DISCRETE STEPS: a wheel notch picked the next candle
 * size off a five-entry ladder and re-bucketed. That cannot express "a bit
 * closer", it cannot centre on the cursor (the anchor date had to survive a
 * change of bucket size, so the view jumped whenever the ladder stepped), and it
 * cannot reach anything finer than a day. The whole interaction the user asked
 * for — point at 14 March, scroll, end up inside 14 March — needs one continuous
 * axis that candles are drawn ON, rather than one axis per candle size.
 *
 * So: a single linear INSTANT axis, in local-midnight epoch milliseconds.
 *
 *   - The visible window is `{ from, to }` in ms — a real interval, not an index
 *     range.
 *   - A granularity is a function from an instant to the start of the period
 *     containing it (`floorInstant`).
 *   - Zoom is `span × f` about a fixed instant, which is trivially
 *     cursor-anchored because lying about the anchor's pixel position is what
 *     makes the naive version jump.
 *
 * Everything here is pure and calendar-based; nothing reads the clock, the DOM or
 * the ledger. That is deliberate: the zoom feel and the axis density are the two
 * things most likely to be silently wrong, and pure functions are the only way to
 * assert them in a test.
 *
 * LOCAL TIME, NEVER UTC
 * ---------------------
 * A ledger records local calendar days and wall-clock times, because that is what
 * a bank statement says. `Date.parse('2026-09-25')` is UTC midnight, which is the
 * previous day for anybody west of Greenwich, and it is exactly the bug the
 * original K-line shipped with in reverse. Every conversion here goes through
 * `new Date(year, month - 1, day)`, so a timestamp is always interpreted in the
 * same zone the user typed it in.
 */

/* -------------------------------------------------------------------------- */
/* granularity                                                                */
/* -------------------------------------------------------------------------- */

/** The granularities whose buckets are a calendar day or longer, coarsest first. */
export const CALENDAR_GRANULARITIES: readonly KlineGranularity[] = [
  'year',
  'quarter',
  'month',
  'week',
  'day'
]

/** The granularities only reachable when entries carry a real time, coarsest first. */
export const INTRADAY_GRANULARITIES: readonly KlineGranularity[] = ['hour', 'minute']

/**
 * Finest to coarsest, by actual duration.
 *
 * THE ORDER IS LOAD-BEARING and it is easy to get wrong. Three things walk this
 * array assuming the next entry is one step COARSER — and therefore that one
 * bucket of it covers less of the axis than the entry before:
 *
 *   - `chooseBucketGranularity`, which takes the first level that yields enough
 *     candles;
 *   - `timeTicks`, which steps the gridline cadence up one rung when the candle's
 *     own boundaries would be too dense to see;
 *   - the label composite, where "coarser" is what earns the right to name a tick.
 *
 * An earlier draft listed the calendar levels in calendar order — day, week, month,
 * quarter, year — after the intraday pair, which made "index + 1" mean "finer" at
 * the day boundary and produced a chart that thought a month was shorter than a day.
 * Writing the ladder once, in one order, means a new level cannot be added and
 * quietly mis-sorted.
 */
export const GRANULARITY_LADDER: readonly KlineGranularity[] = [
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year'
]

/** How many buckets a year holds, for span normalisation. Nominal on purpose. */
const PER_YEAR: Record<KlineGranularity, number> = {
  minute: 365 * 24 * 60,
  hour: 365 * 24,
  day: 365,
  week: 52,
  month: 12,
  quarter: 4,
  year: 1
}

export function isIntradayGranularity(granularity: KlineGranularity): boolean {
  return granularity === 'hour' || granularity === 'minute'
}

/**
 * The finest bucket that can be built for a window, given what the ledger holds.
 *
 * TWO QUESTIONS, and conflating them is how a chart ends up drawing either a
 * fabricated timeline or an empty one:
 *
 *   1. Is the window narrow enough to need intraday buckets? Below
 *      `minIntradayDays` the day stops being a useful unit. A window of a week is not:
 *      seven candles across the plot is a readable week, and splitting it into 168
 *      hourly ones two pixels wide would be zoom theatre.
 *   2. Does the DATA support it? Two conditions, and the second is the one that is
 *      easy to forget:
 *        - the entries must carry a real time, because a bank CSV with no time column
 *          can only ever be bucketed by day;
 *        - there must be enough of them to FILL the buckets. One day holding forty
 *          transactions is roughly one entry per hour, so hour buckets are right and
 *          minute buckets would draw 1,400 empty candles around six real ones. Density,
 *          not just span, is what makes a finer bucket informative.
 */
export function bucketGranularity(
  spanMs: number,
  options: {
    /** Entries in the window. One entry cannot define a sub-day interval. */
    transactionCount: number
    /** True when at least one entry in the window carries a real time. */
    hasIntraday: boolean
    /** Plot width, for the "how many candles fit" question. */
    plotWidth: number
    /** Candles narrower than this are not candles, they are texture. */
    minBucketPx?: number
    /** A window this short gets sub-day buckets when the data can pay for them. */
    minIntradayDays?: number
  }
): KlineGranularity {
  const minBucketPx = options.minBucketPx ?? 26
  const minIntradayDays = options.minIntradayDays ?? 2.5

  const days = spanMs / 86_400_000
  const wanted = Math.max(4, Math.min(3_000, Math.round(options.plotWidth / minBucketPx)))
  const count = options.transactionCount

  // The finest bucket this window and this ledger can support.
  let finest: KlineGranularity = 'day'
  if (days < minIntradayDays && options.hasIntraday && count >= 2) {
    /*
      Minutes when the window is short enough that they can carry the information.

      Two conditions, both about the DATA rather than about the plot width:

        - the window is under an hour, because that is the scale at which "12:14, then
          12:18, then 12:25" is three events rather than one morning; and
        - there are at least two entries per two expected candles, so the axis is not a
          row of empty boxes with one spike in it.

      An earlier version compared the span against the entry count, which let a 6-hour
      window holding forty entries produce 360 minute candles with 40 occupied. Widening
      the window does not make the data finer, and neither does zooming.
    */
    const minuteSlots = spanMs / 60_000
    const hourly = spanMs / 3_600_000
    finest = hourly <= 1 && count * 2 >= minuteSlots ? 'minute' : 'hour'
  }

  /*
    The candidate ladder: finest first, and it stops at the day.

    `finest` is already the finest bucket this window and this ledger can support —
    it is 'minute' or 'hour' only when the window is under a couple of days AND the
    entries in it carry real times, and 'day' otherwise. Climbing from there gives a
    monotonically decreasing bucket count, which is the property
    `chooseBucketGranularity` walks.
  */
  const ladder: KlineGranularity[] = [...GRANULARITY_LADDER]
  const start = ladder.indexOf(finest)
  const allowed = ladder.slice(start === -1 ? ladder.indexOf('day') : start)

  return chooseBucketGranularity(spanMs, wanted, allowed)
}

/* -------------------------------------------------------------------------- */
/* instants                                                                   */
/* -------------------------------------------------------------------------- */

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 'YYYY-MM-DD' → local midnight. Zero-padded input, as the DB always stores it. */
export function dayStartMs(date: string): number {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return new Date(year, month - 1, day).getTime()
}

/** Local midnight of the day containing `ms`. */
export function startOfDayMs(ms: number): number {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 'YYYY-MM-DD' of the local day containing `ms`. */
export function toDateKey(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 'HH:MM' of the local wall-clock time of `ms`. */
export function toTimeKey(ms: number): string {
  const date = new Date(ms)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * The instant an entry happened at.
 *
 * A null or unparseable time resolves to LOCAL MIDNIGHT OF ITS DAY — the earliest
 * instant that day could have occurred — and never to a made-up 09:00 or 12:00.
 * That is honest for the two things this feeds:
 *
 *   - ORDER: a day-only row sorts before the timed rows of the same day, which
 *     matches the ledger, where it is also ordered by `COALESCE(time, '')`.
 *   - DRAWING: the marker lands on the day's opening balance, i.e. "this happened
 *     somewhere in this day and the app is not going to claim where".
 *
 * Callers that must not imply a time at all check `time === null` and label it
 * "时间未记录" instead.
 */
export function instantOf(date: string, time: string | null | undefined): number {
  const base = dayStartMs(date)
  if (!time) return base
  const hour = Number(time.slice(0, 2))
  const minute = Number(time.slice(3, 5))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return base
  return base + (hour * 60 + minute) * 60_000
}

/**
 * Start of the period containing `ms`.
 *
 * The single definition of a bucket boundary for both the main process's
 * `bucketStart` (where it is expressed as a date string) and the chart's
 * geometry. Weeks are ISO — Monday — matching `startOfWeek(date, 1)` in the
 * ledger and the calendar, NOT the Sunday start an earlier version of the chart
 * used, which put Saturday and Sunday in different weeks in two places on the
 * same screen.
 */
export function floorInstant(ms: number, granularity: KlineGranularity): number {
  const date = new Date(ms)
  switch (granularity) {
    case 'year':
      return new Date(date.getFullYear(), 0, 1).getTime()
    case 'quarter':
      return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1).getTime()
    case 'month':
      return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
    case 'week': {
      // getDay() is 0=Sunday; ISO weeks start on Monday, so Sunday walks back six.
      const shift = (date.getDay() + 6) % 7
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() - shift).getTime()
    }
    case 'hour':
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours()
      ).getTime()
    case 'minute':
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes()
      ).getTime()
    case 'day':
    default:
      return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
}

/**
 * The next boundary after `ms`.
 *
 * Stepping from the previous boundary rather than from a date inside the bucket is
 * what keeps the sequence gapless: an August start always yields September, and
 * there is no arithmetic that could skip a month.
 *
 * THE DAY IS CLAMPED, and that is not a detail. `new Date(2026, 0, 31 + 1)` means
 * "31 February", which JavaScript normalises FORWARD to 3 March — so a naive month
 * step from 31 January skips February outright and the series silently loses a
 * bucket. Clamping to the last day of the target month keeps every boundary a real
 * first-of-month.
 */
export function stepInstant(ms: number, granularity: KlineGranularity, stride = 1): number {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()
  const clampToMonth = (targetYear: number, targetMonth: number): number => {
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate()
    return new Date(targetYear, targetMonth, Math.min(day, lastDay)).getTime()
  }
  switch (granularity) {
    case 'year':
      return clampToMonth(year + stride, month)
    case 'quarter':
      return clampToMonth(year, month + stride * 3)
    case 'month':
      return clampToMonth(year, month + stride)
    case 'week':
      return new Date(year, month, day + stride * 7).getTime()
    case 'hour':
      return ms + stride * 3_600_000
    case 'minute':
      return ms + stride * 60_000
    case 'day':
    default:
      return new Date(year, month, day + stride).getTime()
  }
}

/**
 * Nominal length of ONE bucket of this granularity, in ms.
 *
 * `PER_YEAR` counts buckets per year, so the year's length is DIVIDED by it. Getting
 * that the wrong way up is not a small error: it makes a day look 365 times longer
 * than a decade, every density decision inverts, and the chart quietly picks the
 * coarsest bucket it has for a one-month window.
 */
export function nominalBucketMs(granularity: KlineGranularity): number {
  return (365 * 24 * 3_600_000) / PER_YEAR[granularity]
}

/**
 * Coarsest bucket that still yields at least `minBuckets` across `spanMs`.
 *
 * The zoom-out side of the ladder: asking for 400 candles over three years must not
 * return 1,095 daily ones. Finest-first so the first acceptable level wins.
 */
export function chooseBucketGranularity(
  spanMs: number,
  minBuckets: number,
  allowed: readonly KlineGranularity[] = GRANULARITY_LADDER
): KlineGranularity {
  const finest = allowed[0] ?? 'day'
  // A zero or negative span is not a large one. Resolving it to the coarsest level
  // would collapse a one-afternoon ledger into a single candle.
  if (!(spanMs > 0)) return finest
  /*
    Walk COARSE to FINE and take the first level that still yields enough candles.

    Walking the other way and returning the first level that fits is the trap: the
    finest level always fits a short window, so an eight-year view would come back as
    daily candles because 2,900 of them is "at least forty". Coarsest-first returns
    the largest candle the window can afford, which is the whole point of the ladder.
  */
  for (let index = allowed.length - 1; index >= 0; index -= 1) {
    if (spanMs / nominalBucketMs(allowed[index]) >= minBuckets) return allowed[index]
  }
  return finest
}

/* -------------------------------------------------------------------------- */
/* labels                                                                     */
/* -------------------------------------------------------------------------- */

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

export interface LabelContext {
  /**
   * How far the visible window reaches, in days.
   *
   * The one thing a label cannot work out about itself. "09-25" is a month and a
   * day in a view that spans a season and a bare time of day in one that spans an
   * afternoon, and `6月` is unambiguous over a year but not over three.
   */
  spanDays: number
}

/**
 * Axis label for one bucket boundary.
 *
 * Hand-built rather than `Intl`: ICU data differs between Windows installs, so
 * `toLocaleDateString` can label the same axis "Sep 25" on one machine and
 * "25.9." on another, and a trading terminal whose axis reflows on a different PC
 * is not a chart anybody can trust.
 */
export function formatAxisLabel(ms: number, granularity: KlineGranularity, context: LabelContext): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()

  switch (granularity) {
    case 'year':
      return `${year}`
    case 'quarter':
      // Over a decade "Q3" is ambiguous, and so is a bare "2016"; the year-month form is
      // the one shape every level can share, which is what keeps a wide axis in ONE naming
      // system instead of four.
      return context.spanDays > 1_200
        ? `${year}-${pad2(Math.floor(month / 3) * 3 + 1)}`
        : context.spanDays > 400
          ? `${year}Q${Math.floor((month - 1) / 3) + 1}`
          : `Q${Math.floor((month - 1) / 3) + 1}`
    case 'month':
      return context.spanDays > 400 ? `${year}-${pad2(month)}` : MONTHS[month - 1]
    case 'week':
      return `${pad2(month)}/${pad2(day)}`
    case 'day':
      // A midnight tick inside an intraday window is the day boundary, so it is
      // labelled with its date rather than with "00:00" — which would read as just
      // another hour in the middle of the axis.
      if (context.spanDays > 400) return `${year}-${pad2(month)}`
      // Under a season the month is already on the axis as a coarser row, so repeating
      // it in every label spends most of the width saying the same thing.
      return context.spanDays > 90 ? `${pad2(month)}/${pad2(day)}` : `${day}`
    case 'hour':
      return `${pad2(date.getHours())}:00`
    case 'minute':
    default:
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
}

/* -------------------------------------------------------------------------- */
/* adaptive time axis                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Target spacing between two LABELS, in canvas px, and the floor below which a
 * label is dropped whatever its level.
 *
 * Roughly what one date label needs to be readable, with a little air. The floor
 * is about two-thirds of it, which is what lets the spacing float continuously:
 * a label is emitted as soon as the previous one is 52px back, so the effective
 * density slides between 52px and (52px + one stride) instead of quantising to
 * the stride ladder. A reader scrolling through a zoom sees the axis tighten and
 * loosen smoothly rather than in visible clunks.
 */
const LABEL_MIN_GAP_PX = 52

/**
 * Blank space a label of this level needs, in px.
 *
 * A LABEL IS NOT A LABEL. "2026年" and "1月" are three CJK glyphs wide and need the full
 * gap; a bare day number is two digits and needs a third of it. Using one figure for both —
 * which the first version did — makes the day level look unaffordable at exactly the spans
 * where it is the right level, so a one-month window came out labelled in WEEKS: four
 * "09/07"-style names spread across the axis instead of thirty day numbers, on the one view
 * where the reader is asking "which day was that".
 *
 * The gap is what makes a level affordable, so it has to be estimated from what the level
 * will actually print.
 */
function labelGapPx(level: KlineGranularity): number {
  switch (level) {
    case 'year':
      return LABEL_MIN_GAP_PX
    case 'quarter':
      return LABEL_MIN_GAP_PX
    case 'month':
      return LABEL_MIN_GAP_PX
    case 'week':
      return LABEL_MIN_GAP_PX * 0.85
    case 'day':
      return LABEL_MIN_GAP_PX * 0.4
    case 'hour':
    case 'minute':
    default:
      return LABEL_MIN_GAP_PX * 0.7
  }
}


/** Below this, a gridline is a fill rather than a grid. */
const GRID_MIN_PX = 4

export interface TimeTick {
  ms: number
  x: number
  /** 0..1 line strength. 1 is a period boundary the candles do not align to on their own. */
  weight: number
  /** Non-null only on ticks the collision pass kept. */
  label: string | null
  /** Opacity of the label, so a level can fade in and out instead of switching. */
  opacity: number
}

export interface TimeAxisOptions {
  from: number
  to: number
  granularity: KlineGranularity
  /** Left edge of the plot area, in canvas px. */
  plotLeft: number
  plotWidth: number
}

/** Name for one instant at one level, or null when that instant is not a boundary of it. */
function levelLabel(ms: number, level: KlineGranularity, context: LabelContext): string | null {
  if (floorInstant(ms, level) !== ms) return null
  return formatAxisLabel(ms, level, context)
}

/**
 * The time axis: gridlines at the candle's own boundaries, labels that fade
 * between levels as the window narrows.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * "Show years when wide, days when narrow" written as an if/else produces the
 * single worst moment in a zoomable chart: one wheel notch and every label on the
 * axis is replaced by a different kind of label. The reader loses their place at
 * exactly the moment they were looking most closely.
 *
 * So labels are COMPOSITED rather than switched. At any span every level from the
 * candle size up to the coarsest that still fits is a candidate, each carrying its
 * own opacity, and each slides from 0 to 1 across roughly a factor of two of zoom.
 * Scroll from three years to one and "2026" fades out while "01"…"12" fade in
 * underneath it. There is no frame at which the axis is unlabelled and none at
 * which two levels are both at full strength.
 *
 * TICKS COME FROM ONE CADENCE
 * ---------------------------
 * Every gridline is a boundary of the CANDLE granularity, so a gridline is always
 * a real candle edge and never a decoration implying a period the candles do not
 * have. A coarser level contributes no gridlines of its own, only names — a month
 * name is emitted on the tick that happens to be the 1st. That is why the axis
 * cannot drift out of sync with the candles the way two independently computed
 * axes would: there is only one axis, described several ways.
 */
export function timeTicks(options: TimeAxisOptions): TimeTick[] {
  const { from, to, granularity, plotLeft, plotWidth } = options
  if (!(to > from) || !(plotWidth > 0)) return []

  const spanDays = (to - from) / 86_400_000
  const context: LabelContext = { spanDays }
  const pxPerMs = plotWidth / (to - from)
  const xOf = (ms: number): number => plotLeft + (ms - from) * pxPerMs

  /*
    Which levels may name the axis.

    THE LEVELS FOLLOW THE WINDOW, NOT THE CANDLE SIZE, and that distinction is the whole
    fix for this function's messiest bug. Tying them to `granularity` looked reasonable —
    "a day chart is labelled in days" — and produced a decade view whose only possible
    names were week-ending dates like "01/04", "08/08", "03/13": the day level was the
    finest thing on offer and the month level was never consulted. The reader asked for ten
    years of history and got seventeen week labels drawn from ten different years, in an
    order that looked random and was merely under-specified.

    What a reader needs is decided by how much time is on screen: months over a year, years
    over a decade, minutes over an hour. `granularity` says how the candles are cut, which
    is a different question with a different answer.

    THREE levels at most, finest first: one coarse enough to fit, plus up to two coarser
    ones. The middle level is what names a month inside its year; the third is the year
    itself, and stopping there is what keeps the axis from becoming a table of contents.
    Nothing FINER than the candle granularity is ever considered, because a level finer than
    the candles would be naming gridlines that are not its own boundaries.
  */
  const fineIndex = GRANULARITY_LADDER.indexOf(granularity)
  const fitsLabel = (level: KlineGranularity): boolean =>
    nominalBucketMs(level) * pxPerMs >= labelGapPx(level)

  /*
    The FINEST level that fits, searching fine to coarse and stopping at the first hit.

    The direction is the whole point and it is easy to invert: walking coarse to fine and
    taking the first hit returns the COARSEST level, which named a one-year window in years —
    two labels, both at opacity zero — and a decade in quarters. Fine-to-coarse returns the
    level carrying the most detail the plot can still show, which is what "as precise as
    there is room for" means.
  */
  let finestLabel: KlineGranularity = granularity
  for (let index = fineIndex; index < GRANULARITY_LADDER.length; index += 1) {
    if (fitsLabel(GRANULARITY_LADDER[index])) {
      finestLabel = GRANULARITY_LADDER[index]
      break
    }
  }

  const labelLevels: KlineGranularity[] = []
  for (let index = GRANULARITY_LADDER.indexOf(finestLabel); index < GRANULARITY_LADDER.length; index += 1) {
    labelLevels.push(GRANULARITY_LADDER[index])
    if (labelLevels.length >= 3) break
  }

  /*
    Gridlines: the finest level whose boundaries are actually separable, and never coarser
    than the finest level that can be NAMED.

    A decade of daily candles is 3,650 vertical lines across 900px — a grey block, not a
    grid — so the cadence steps up until the lines clear `GRID_MIN_PX`. Left unbounded that
    walk can overshoot the whole window: a three-month span at day granularity steps day →
    week → month → quarter → year, because each one is still too dense, and the only year
    boundary may fall outside the window entirely. The axis then has no gridlines, so it has
    no labels, so the reader sees a blank strip under a perfectly good chart.

    Capping at the coarsest NAMEABLE level fixes that by construction: if a boundary of the
    cadence can fall outside the window, a coarser one can only be worse, so the cap
    guarantees at least one gridline and therefore at least one name inside it.
  */
  const capIndex = GRANULARITY_LADDER.indexOf(labelLevels[labelLevels.length - 1])
  let cadence: KlineGranularity = granularity
  while (nominalBucketMs(cadence) * pxPerMs < GRID_MIN_PX) {
    const index = GRANULARITY_LADDER.indexOf(cadence)
    if (index >= capIndex) break
    cadence = GRANULARITY_LADDER[index + 1]
  }

  const cadenceIndex = GRANULARITY_LADDER.indexOf(cadence)
  const ticks: TimeTick[] = []
  const byMs = new Map<number, TimeTick>()
  const push = (ms: number): TimeTick => {
    const existing = byMs.get(ms)
    if (existing) return existing
    const tick: TimeTick = { ms, x: xOf(ms), weight: 0.32, label: null, opacity: 0 }
    // Strongest (coarsest) alignment wins: 1 January is a year line even though it is
    // also a month line and a day line.
    const span = GRANULARITY_LADDER.length - cadenceIndex - 1
    for (let index = cadenceIndex + 1; index < GRANULARITY_LADDER.length; index += 1) {
      if (floorInstant(ms, GRANULARITY_LADDER[index]) === ms && span > 0) {
        tick.weight = Math.min(1, 0.32 + (0.68 * (index - cadenceIndex)) / span)
      }
    }
    ticks.push(tick)
    byMs.set(ms, tick)
    return tick
  }

  /*
    A label level may only add a gridline INSIDE the window.

    Letting it add one outside is the subtle half of the same bug the bounded label walk
    fixes: a month pass over a decade pushed January 2016 and January 2027 into the tick
    list, which are not on screen and are not candle edges, and the chart then drew a
    line at an instant it had no candle for. `byMs` also means a boundary that IS a
    cadence line is found rather than duplicated, so a coarser level still gets its own
    line when it needs one.
  */
  const within = (ms: number): boolean => ms >= from && ms <= to

  for (let cursor = floorInstant(from, cadence), guard = 0; cursor <= to && guard < 20_000; guard += 1) {
    if (cursor >= from) push(cursor)
    cursor = stepInstant(cursor, cadence, 1)
  }

  /*
    A cadence coarser than the whole window has no boundary in it.

    A caller who asks for year candles over nine months gets a window that contains no
    1 January, so the grid comes out empty and the axis with it. Rather than leave the reader
    with a blank strip and no explanation, the window gets one gridline at its own left edge
    — the smallest possible statement, and a true one.
  */
  if (ticks.length === 0) push(from)

  /**
   * One global collision pass over every candidate label from every level.
   *
   * THE THING THIS REPLACES, AND WHY
   * --------------------------------
   * The first three attempts placed one level at a time, coarse first, each level
   * tracking its own "last placed" marker. That cannot work, and the reason is worth
   * recording because it looks so reasonable:
   *
   *   - a level only knows the labels IT has placed, so a finer level happily drops a
   *     name 7 pixels from one a coarser level already put down;
   *   - a level's candidates are not its neighbours on the axis. A coarser level APPENDS
   *     the gridlines it needs, so after a quarter pass the tick list reads Jan, Apr,
   *     Jul, Oct, Jan… and "the previous tick in the array" is a month and a half away
   *     from the current one;
   *   - a level that only names its OWN boundaries is blocked entirely by a coarser
   *     level that happens to share them, which is why the year names vanished from a
   *     decade view.
   *
   * Collecting every candidate first and resolving them in ONE pass removes all three
   * at once. The priorities are explicit: earlier in the list wins, so a coarser name
   * beats a finer one on the same tick, and a lower x wins on equal priority, which
   * makes the surviving set evenly spread by construction rather than by luck.
   */
  const all: Array<{ tick: TimeTick; level: KlineGranularity; label: string; priority: number; opacity: number }> = []
  for (const level of labelLevels) {
    const levelIndex = GRANULARITY_LADDER.indexOf(level)
    const candidates: TimeTick[] = []

    /*
      A level coarser than the gridline cadence contributes its own TICKS as well as its
      names, so 1 January is guaranteed a line to name even when the cadence has thinned
      the grid down to weeks. A level FINER than the cadence contributes only names,
      aliased onto lines that are already there: a day name has no business inventing a
      gridline that is not also a week boundary.
    */
    if (levelIndex >= cadenceIndex) {
      for (let cursor = floorInstant(from, level), guard = 0; cursor <= to && guard < 4_000; guard += 1) {
        if (cursor >= from && within(cursor)) candidates.push(push(cursor))
        cursor = stepInstant(cursor, level, 1)
      }
      /*
        On a wide window, name the left edge too.

        Without it the axis opens with its first arbitrary boundary — "01/26" on a view that
        starts on the 1st — which reads as though the chart had been cropped.
      */
      if (candidates.length > 0 && candidates.length <= 24 && candidates[0].ms > from) {
        candidates.unshift(push(from))
      }
    } else {
      // Finer than the grid: reuse the lines that are already there.
      for (const tick of ticks) {
        if (floorInstant(tick.ms, level) === tick.ms) candidates.push(tick)
      }
    }

    /*
      Opacity is driven by how many labels the level brought.

      Driving it from the bucket size instead was an earlier attempt, and it wasted the
      crossfade: "affordable" and "fully opaque" landed in the same frame, so every level
      switched on at full strength and the axis popped rather than dissolved. Measured on
      the real count, a level fades in over the four-to-six label range — at four it is a
      hint, at six it has taken over — which is a change the reader scrolls through.
    */
    const opacity = Math.max(0, Math.min(1, (candidates.length - 4) / 2))
    if (opacity <= 0.02) continue

    for (const tick of candidates) {
      if (tick.x < plotLeft - 1 || tick.x > plotLeft + plotWidth + 1) continue
      const label = levelLabel(tick.ms, level, context)
      if (label === null) continue
      all.push({ tick, level, label, priority: levelIndex, opacity })
    }
  }

  const settled: number[] = []
  all.sort((a, b) => {
    if (a.tick.x !== b.tick.x) return a.tick.x - b.tick.x
    // On the same tick the COARSER name wins: "2026" is more use than "01", and "1月" is
    // more use than the bare "1" the day level would put in the same place.
    return b.priority - a.priority
  })

  for (const entry of all) {
    // One label per tick: a coarser name has already claimed it if it wanted it.
    if (entry.tick.label !== null) continue
    const gap = labelGapPx(entry.level)
    const collision = settled.some((x) => Math.abs(entry.tick.x - x) < gap)
    if (collision) continue
    entry.tick.label = entry.label
    entry.tick.opacity = entry.opacity
    settled.push(entry.tick.x)
  }

  /*
    Back into time order.

    The label pass APPENDS the gridlines a coarser level needed, so the array is no longer
    in the order it was walked: a first-of-month tick can sit after a December one. Every
    consumer — the gridline loop, the caller's "which label is nearest" logic, and the
    test that asserts labels do not overlap — reads this array in sequence and assumes
    that sequence is left to right.
  */
  ticks.sort((a, b) => a.ms - b.ms)

  /*
    A window with nothing nameable still has to be readable. This only fires for a
    degenerate case — no level produced a boundary inside the window — and an
    unlabelled axis is worse than a dense one.
  */
  if (!ticks.some((tick) => tick.label !== null)) {
    let lastPlaced: number | null = null
    for (const tick of ticks) {
      if (tick.x < plotLeft - 1 || tick.x > plotLeft + plotWidth + 1) continue
      if (lastPlaced !== null && tick.x - lastPlaced < LABEL_MIN_GAP_PX) continue
      tick.label = formatAxisLabel(tick.ms, cadence, context)
      tick.opacity = 1
      lastPlaced = tick.x
    }
  }

  return ticks
}

/* -------------------------------------------------------------------------- */
/* adaptive value axis                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 1/2/2.5/5 × 10ⁿ, so labels land on numbers a person reads without arithmetic.
 *
 * `precision` sets the floor: the default of 1 is what a two-decimal currency's minor
 * unit wants, and a caller working in major units passes 0.01. Without a floor the
 * ladder happily returns 0.5 for an input of 0.4, which as a minor-unit step is half a
 * cent — a tick interval the money cannot be printed at.
 */
export function niceStep(rough: number, precision = 1): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return precision
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalized = rough / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return Math.max(precision, step * magnitude)
}

export interface ValueDomain {
  min: number
  max: number
  step: number
  /** Tick values, ascending, all inside [min, max]. */
  ticks: number[]
}

/**
 * A value axis that fits the visible data, measured in MINOR UNITS.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * The axis must NOT start at zero. This is the entire point of the micro view: an
 * account holding RM 5,000 that moves by RM 4.80 spans 0.096% of a
 * zero-based axis, which on an 800-pixel plot is 0.77 pixels — the transaction is
 * drawn, and nobody can see it. Fitting the window to the visible range puts the
 * same RM 4.80 on 20–40 pixels and the movement is legible without the number
 * being exaggerated by even one minor unit.
 *
 * Zero IS included when the data actually reaches it, or when the window sits
 * close enough to it that excluding it would misrepresent the distance — a
 * balance of RM 12.00 graphed across RM 11.40..RM 12.60 with no visible zero would
 * look like a fortune changing hands.
 *
 * `minMajorTicks`..`maxMajorTicks` is enforced by tightening the step rather than
 * by adding labels: a step that produces three ticks is a coarse axis, not a
 * broken one, but a step that produces forty is a wall of text, and the ladder is
 * walked until the count is inside the band.
 */
export function valueDomain(
  low: number,
  high: number,
  options: {
    targetTicks?: number
    minMajorTicks?: number
    maxMajorTicks?: number
    /** Smallest step the currency can render. 1 for a 2-decimal currency. */
    minStep?: number
  } = {}
): ValueDomain {
  const targetTicks = options.targetTicks ?? 6
  const minMajor = options.minMajorTicks ?? 4
  const maxMajor = options.maxMajorTicks ?? 11
  const minStep = Math.max(1, options.minStep ?? 1)

  let lo = Number.isFinite(low) ? low : 0
  let hi = Number.isFinite(high) ? high : 1
  if (hi < lo) [lo, hi] = [hi, lo]

  /*
    A flat window — one day, one transaction, no movement — has no range to scale
    to. The pad is a fraction of the balance so the line sits mid-plot rather than
    on an edge, with a floor in minor units so a small balance does not get an
    axis of 0.01-wide ticks.
  */
  if (hi - lo < minStep) {
    const magnitude = Math.max(Math.abs(lo), Math.abs(hi), 1)
    const pad = Math.max(magnitude * 0.02, minStep * 100)
    lo -= pad
    hi += pad
  }

  // Zero joins the domain when the data touches it, or when the window starts close
  // enough to it that excluding it would misstate the distance: a balance of RM 12
  // graphed across RM 11.40..RM 12.60 with no visible zero looks like a fortune
  // changing hands. The threshold is relative to the UPPER bound rather than to the
  // range, because the range is what the fit is trying to keep tight — measuring
  // against it would let zero in only when the fit no longer mattered.
  if (lo > 0 && lo <= hi * 0.25) lo = 0
  if (hi < 0 && -hi <= -lo * 0.25) hi = 0

  /*
    Step selection: start where the target tick count points, then walk the ladder
    until the count lands inside the band. See the two passes below for why the band
    is not enforced symmetrically.
  */
  const nudge = (value: number, up: boolean): number => {
    const magnitude = 10 ** Math.floor(Math.log10(value))
    const normalized = value / magnitude
    const nextUp = normalized < 1.5 ? 2 : normalized < 2.25 ? 2.5 : normalized < 3.5 ? 5 : 10
    const nextDown = normalized > 7 ? 5 : normalized > 4 ? 2.5 : normalized > 2.25 ? 2 : normalized > 1.5 ? 1 : 0.5
    return (up ? nextUp : nextDown) * magnitude
  }

  let step = niceStep((hi - lo) / targetTicks, minStep)
  const ticks: number[] = []
  const countTicks = (candidate: number): number =>
    Math.max(1, Math.floor(hi / candidate) - Math.ceil(lo / candidate) + 1)

  /*
    Two passes, each terminating on a genuine fixpoint rather than on a guard count.

    Coarsen first while there are too many labels, then refine while there are too
    few. `minMajor` is a preference and `maxMajor` a hard limit, and the asymmetry is
    deliberate: too many labels is the failure that makes an axis unreadable and is
    corrected every time, while too few is merely a coarse axis — a narrow range only
    offers a handful of round numbers before the labels would repeat, so the
    refinement stops at `minStep` and accepts what it has.
  */
  for (let guard = 0; guard < 8 && countTicks(step) > maxMajor; guard += 1) {
    const candidate = nudge(step, true)
    if (!(candidate > step)) break
    step = candidate
  }
  for (let guard = 0; guard < 8 && countTicks(step) < minMajor; guard += 1) {
    const candidate = Math.max(minStep, nudge(step, false))
    if (!(candidate < step)) break
    step = candidate
  }

  // A step below one minor unit would print the same label twice.
  step = Math.max(step, minStep)
  const min = Math.floor(lo / step) * step
  const max = Math.ceil(hi / step) * step
  for (let value = min, guard = 0; value <= max + step / 2 && guard < 200; guard += 1) {
    ticks.push(Math.round(value))
    value += step
  }

  return { min, max, step, ticks }
}

/** Minor-unit step floor for a currency: the smallest amount it can actually show. */
export function minStepForCurrency(currency: string): number {
  return Math.max(1, Math.round(minorUnitScale(currency) / 100))
}

/* -------------------------------------------------------------------------- */
/* viewport                                                                   */
/* -------------------------------------------------------------------------- */

export interface Viewport {
  /** Visible interval, local epoch ms, inclusive of `from` and exclusive of `to`. */
  from: number
  to: number
}

/** Narrowest window the chart will zoom to: one hour. */
export const MIN_SPAN_MS = 3_600_000

/**
 * Continuous, cursor-anchored zoom.
 *
 * THE INTERACTION
 * ---------------
 * `anchorRatio` is where the cursor sits in the plot, 0 at the left edge and 1 at
 * the right. The instant under the cursor is held at that same ratio, so the thing
 * the user is pointing at stays under the pointer for the whole gesture — which is
 * the difference between zooming into "14 March" and zooming into "somewhere near
 * 14 March". Anchoring on the centre of the plot instead is the bug this replaces:
 * the reader points at a Tuesday and the chart walks away from it.
 *
 * The span is clamped to `[MIN_SPAN_MS, bounds]`. At the outer end the view settles
 * on the full history and stops — a chart that can zoom out past its own data
 * shows an empty margin that reads as missing records.
 */
export function zoomViewport(
  viewport: Viewport,
  factor: number,
  anchorRatio: number,
  bounds: Viewport,
  minSpanMs: number = MIN_SPAN_MS
): Viewport {
  const span = Math.max(1, viewport.to - viewport.from)
  const total = Math.max(minSpanMs, bounds.to - bounds.from)
  const ratio = Math.max(0, Math.min(1, anchorRatio))

  /*
    Clamp the SPAN first, and derive the window from the clamped value.

    Measuring the anchor against the requested span and only then shrinking is the trap:
    asking to zoom out to 79 years of a 6-year history leaves the anchor 39 years into
    the future, and the window is dragged there before the clamp notices — which is how
    a zoom-out at the left edge of the data used to land the reader in 2022.
  */
  const nextSpan = Math.max(minSpanMs, Math.min(total, span * factor))
  const boundSpan = bounds.to - bounds.from
  if (nextSpan >= boundSpan) return { from: bounds.from, to: bounds.to }

  const anchor = viewport.from + ratio * span
  let from = anchor - ratio * nextSpan
  let to = from + nextSpan

  /*
    Shift into range, keeping the span exactly.

    Order matters: adjusting the span after hitting an edge would silently compress the
    zoom step, so a reader zooming out at the end of their history would find the chart
    slowing down for no reason they could see.
  */
  if (from < bounds.from) {
    from = bounds.from
    to = from + nextSpan
  }
  if (to > bounds.to) {
    to = bounds.to
    from = to - nextSpan
  }
  return { from, to }
}

/**
 * Pan by a pixel delta. `pxPerMs` comes from the current frame, so drag stays 1:1.
 *
 * A POSITIVE delta moves the window EARLIER: `deltaPx` is the distance the content was
 * dragged to the right, and dragging content right reveals what is to its left. The
 * pointer handler passes `clientX - dragStartX`, so the content follows the finger.
 *
 * The SHIFT is clamped rather than the resulting `from`. Clamping `from` alone stops the
 * window's leading edge at the data and lets its trailing edge stay out past the far side,
 * so a hard drag parks the chart showing weeks that hold no records — which reads as
 * missing data rather than as the end of the history.
 */
export function panViewport(viewport: Viewport, deltaPx: number, pxPerMs: number, bounds: Viewport): Viewport {
  if (!(pxPerMs > 0)) return viewport
  const span = viewport.to - viewport.from
  const shift = -deltaPx / pxPerMs
  // A rightward drag is a negative shift, so it can move at most to the data's end.
  const earliest = bounds.from
  const latest = Math.max(earliest, bounds.to - span)
  const from = Math.max(earliest, Math.min(viewport.from + shift, latest))
  return { from, to: from + span }
}

/** Human name for the current window, for the "1M" style badge next to the chart. */
export function describeSpan(spanMs: number): string {
  const days = spanMs / 86_400_000
  if (days >= 700) return `${(days / 365).toFixed(days >= 3_650 ? 0 : 1)}年`
  if (days >= 70) return `${Math.round(days / 30)}个月`
  if (days >= 14) return `${Math.round(days / 7)}周`
  if (days >= 2) return `${Math.round(days)}天`
  const hours = spanMs / 3_600_000
  if (hours >= 2) return `${Math.round(hours)}小时`
  const minutes = Math.max(1, Math.round(spanMs / 60_000))
  return `${minutes}分钟`
}

/* -------------------------------------------------------------------------- */
/* the visible slice                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The items intersecting a viewport, in order — the FIRST one, not any one.
 *
 * THE BUG THIS REPLACES (found while building v1.6.0, present since v1.5.1)
 * ----------------------------------------------------------------------
 * The chart used to search for the first visible bucket with a loop that `break`s the
 * moment it lands on ANY bucket inside the window:
 *
 *     while (lo <= hi) {
 *       const mid = (lo + hi) >> 1
 *       if (next <= from) lo = mid + 1
 *       else if (buckets[mid].instant > to) hi = mid - 1
 *       else { start = mid; break }        // ← any bucket, usually the middle one
 *       start = Math.max(0, lo)
 *     }
 *
 * With the whole history in view that returns the MIDDLE bucket, so a two-year ledger
 * was drawn from its one-year mark onwards and a nine-day ledger from its fifth day.
 * Nobody noticed because "the chart starts somewhere in the past" looks exactly like a
 * chart, and the older half was simply missing.
 *
 * The rule is a lower bound on `end`: the first item whose END is past the window's
 * start is the first one that intersects it. `end` is the next item's instant — buckets
 * are half-open, [instant, next) — and `dataEnd` for the last one, because an
 * open-ended final bucket would otherwise "intersect" every window in the future and a
 * chart scrolled past the end of the ledger would still draw its last candle.
 */
export function visibleRange<T extends { instant: number }>(
  items: readonly T[],
  viewport: Viewport,
  dataEnd: number = Number.POSITIVE_INFINITY
): T[] {
  if (items.length === 0) return []

  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const end = mid + 1 < items.length ? items[mid + 1].instant : dataEnd
    if (end <= viewport.from) lo = mid + 1
    else hi = mid
  }

  const out: T[] = []
  for (let i = lo; i < items.length; i += 1) {
    // The viewport is half-open, so an item starting exactly at `to` is out of it.
    if (items[i].instant >= viewport.to) break
    out.push(items[i])
  }
  return out
}
