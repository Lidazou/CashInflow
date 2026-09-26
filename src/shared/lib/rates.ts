import { CURRENCIES, DEFAULT_CURRENCY, formatMoney, getCurrency, minorUnitScale, type CurrencyCode } from './money'

/**
 * Currency conversion.
 *
 * WHY THIS CANNOT BE PURE INTEGER ARITHMETIC
 * -----------------------------------------
 * Every stored amount is an integer in its own currency's minor unit, which
 * makes same-currency arithmetic exact. Conversion is different in kind: it
 * multiplies by a decimal exchange rate, and that step is inherently
 * fractional. The discipline therefore changes rather than disappears:
 *
 *   1. Convert with ONE multiplication and ONE rounding. Never chain
 *      conversions (CNY -> USD -> MYR accumulates two rounding errors and, more
 *      importantly, disagrees with the published CNY -> MYR rate).
 *   2. Keep the rate as a double with its full published precision. Storing it
 *      as a rounded string would cap accuracy at whatever we chose to print.
 *   3. Round half-away-from-zero at the final minor unit, and be able to explain
 *      the result: ¥100 at 0.606575 is exactly MYR 60.66 (60.6575 -> 60.66),
 *      not 60.65.
 *
 * A converted figure is a DISPLAY value. It is never written back into the
 * ledger — transactions keep the currency of the account they belong to, so the
 * books always balance in the unit the money actually moved in.
 */

/** Rate table: how many units of `quote` one unit of `base` buys. */
export interface RateTable {
  /** The currency every rate in the table is expressed against. */
  base: CurrencyCode | string
  /** quote currency code -> units per 1 base unit. Includes base: 1. */
  rates: Record<string, number>
  /** When the provider last published these rates. */
  fetchedAt: string
  /** Which provider supplied them. */
  provider: string
  /** True when the user typed the rate by hand instead of fetching it. */
  isManual?: boolean
}

export interface ConversionResult {
  /** Converted amount in the target currency's minor units. */
  minor: number
  /** The rate actually used (target per 1 source). */
  rate: number
  from: string
  to: string
  /** True when no rate was available and the amount was passed through as-is. */
  approximate: boolean
}

/** ISO date (YYYY-MM-DD) of a timestamp, used to flag stale rates. */
function isoDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Look up the rate from `from` to `to`.
 *
 * Returns null when it cannot be determined, so callers must decide what to do
 * rather than silently receiving `undefined` and producing NaN in the UI.
 */
export function lookupRate(table: RateTable | null, from: string, to: string): number | null {
  if (!table) return null
  const source = from.toUpperCase()
  const target = to.toUpperCase()
  if (source === target) return 1

  const base = String(table.base).toUpperCase()

  // Direct: both currencies are quoted against the table's base.
  if (source === base) {
    const rate = table.rates[target]
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null
  }
  if (target === base) {
    const rate = table.rates[source]
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? 1 / rate : null
  }

  // Cross rate via the base: (target/base) / (source/base).
  // This is a single division of two published rates, which is exactly how a
  // provider would publish the cross rate itself — as opposed to chaining two
  // separate conversions of an actual amount.
  const sourceRate = table.rates[source]
  const targetRate = table.rates[target]
  if (
    typeof sourceRate === 'number' &&
    typeof targetRate === 'number' &&
    Number.isFinite(sourceRate) &&
    Number.isFinite(targetRate) &&
    sourceRate > 0 &&
    targetRate > 0
  ) {
    return targetRate / sourceRate
  }

  return null
}

/**
 * Convert an integer minor-unit amount from one currency to another.
 *
 * Rounding is half-away-from-zero (the convention people expect from a bank
 * statement) rather than Math.round's half-up, which rounds -0.5 towards zero
 * and would make a converted expense disagree with its mirror-image income.
 */
export function convertMinor(
  minor: number,
  from: string,
  to: string,
  table: RateTable | null
): ConversionResult {
  const source = from.toUpperCase()
  const target = to.toUpperCase()

  if (source === target) {
    return { minor, rate: 1, from: source, to: target, approximate: false }
  }

  const rate = lookupRate(table, source, target)
  if (rate === null) {
    // No rate available. Passing the raw number through would be a lie; the
    // `approximate` flag exists so the UI can label it instead of implying a
    // conversion happened.
    return { minor, rate: 1, from: source, to: target, approximate: true }
  }

  const fromScale = minorUnitScale(source)
  const toScale = minorUnitScale(target)

  // major = minor / fromScale; converted = major * rate; result = converted * toScale.
  // The two divisions are exact for power-of-ten scales, so the only fractional
  // step is the intended multiplication by the rate.
  const major = minor / fromScale
  const convertedMinor = major * rate * toScale

  return {
    minor: roundHalfAwayFromZero(convertedMinor),
    rate,
    from: source,
    to: target,
    approximate: false
  }
}

/** Convert minor units without the metadata, for call sites that do not need it. */
export function convertAmount(minor: number, from: string, to: string, table: RateTable | null): number {
  return convertMinor(minor, from, to, table).minor
}

function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/**
 * Convert and format in one step.
 *
 * `approximate` conversions are suffixed with a marker so a figure that was not
 * actually converted can never be mistaken for one that was.
 */
export function formatConverted(
  minor: number,
  from: string,
  to: string,
  table: RateTable | null,
  options: Parameters<typeof formatMoney>[2] = {}
): { text: string; approximate: boolean; rate: number } {
  const result = convertMinor(minor, from, to, table)
  const text = formatMoney(result.minor, result.to, options)
  return {
    text: result.approximate && result.from !== result.to ? `${text} *` : text,
    approximate: result.approximate,
    rate: result.rate
  }
}

/** Decimals to show for a rate, chosen from its magnitude. */
export function ratePrecision(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 4
  if (rate >= 100) return 2
  if (rate >= 1) return 4
  if (rate >= 0.01) return 4
  return 6
}

/**
 * Format a rate with an explicit, tested precision rule.
 *
 * Trailing zeros after a decimal point are trimmed so the output reads
 * naturally: 1.1665 rather than 1.166500.
 *
 * The trim must ANCHOR on the decimal point. A bare `/0+$/` also strips the
 * zeros of an integer part, turning "23.40" into "23.4" and — worse — leaving
 * "23.00" as "23." and then "23", which silently changes an exchange rate by two
 * decimal places of precision.
 */
export function formatRatePrecise(rate: number, from: string, to: string): string {
  const decimals = ratePrecision(rate)
  const fixed = rate.toFixed(decimals)
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
  const fromInfo = getCurrency(from)
  const toInfo = getCurrency(to)
  return `1 ${fromInfo.code} = ${trimmed} ${toInfo.code}`
}

export type RateFreshness = 'fresh' | 'today' | 'recent' | 'stale' | 'manual' | 'missing'

/**
 * Classify how trustworthy the current rates are.
 *
 * A finance app that shows an outdated exchange rate without saying so is
 * worse than one that shows nothing, because the user will budget against a
 * number that is quietly wrong. The UI surfaces this classification directly.
 */
export function rateFreshness(table: RateTable | null, now: Date = new Date()): RateFreshness {
  if (!table) return 'missing'
  if (table.isManual) return 'manual'

  const fetched = new Date(table.fetchedAt)
  if (Number.isNaN(fetched.getTime())) return 'stale'

  const todayIso = isoDate(now)
  const fetchedIso = isoDate(fetched)
  if (todayIso === fetchedIso) {
    // Under an hour old is genuinely fresh; same-day is still current.
    return now.getTime() - fetched.getTime() < 60 * 60 * 1000 ? 'fresh' : 'today'
  }

  const days = Math.round((now.getTime() - fetched.getTime()) / 86_400_000)
  return days <= 3 ? 'recent' : 'stale'
}

/** Currencies present in the rate table, base first then alphabetical. */
export function availableCurrencies(table: RateTable | null): string[] {
  const base = table ? String(table.base).toUpperCase() : DEFAULT_CURRENCY
  const others = Object.keys(table?.rates ?? {})
    .map((code) => code.toUpperCase())
    .filter((code) => code !== base)
    .sort()
  return [base, ...others]
}

/**
 * Every currency the app knows about, plus any extra ones the provider returns
 * that are not in our table (so a user is never blocked by our own shortlist).
 */
export function selectableCurrencies(table: RateTable | null): Array<{ code: string; label: string; symbol: string }> {
  const known = new Set<string>(Object.keys(CURRENCIES))
  const fromProvider = availableCurrencies(table)

  const codes = [...known]
  for (const code of fromProvider) {
    if (!known.has(code)) codes.push(code)
  }

  return codes
    .map((code) => {
      const info = (CURRENCIES as Record<string, { symbol: string; name: string; nameEn: string }>)[code]
      return {
        code,
        symbol: info?.symbol ?? code,
        label: info ? `${info.name} ${code}` : code
      }
    })
    .sort((a, b) => {
      // Keep the curated order first so the common currencies are at the top.
      const order: string[] = ['CNY', 'MYR', 'SGD', 'USD', 'HKD', 'EUR', 'GBP', 'JPY']
      const ai = order.indexOf(a.code)
      const bi = order.indexOf(b.code)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.code.localeCompare(b.code)
    })
}

export function currencyLabel(code: string): string {
  const info = (CURRENCIES as Record<string, { symbol: string; name: string; nameEn: string }>)[code]
  return info ? `${info.name} (${code})` : code
}

export function currencySymbol(code: string): string {
  return (CURRENCIES as Record<string, { symbol: string }>)[code]?.symbol ?? code
}

export type { CurrencyCode }
