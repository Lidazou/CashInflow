/**
 * Currency definitions and money formatting.
 *
 * FINANCIAL CORRECTNESS RULE (see spec §33)
 * -----------------------------------------
 * Amounts are NEVER stored or computed as JavaScript floats. Every amount in
 * this app is an INTEGER count of the currency's minor unit:
 *
 *     ¥28.00    ->  stored as  2800   (fen)
 *     RM 18.50  ->  stored as  1850   (sen)
 *     $1,234.56 ->  stored as  123456 (cents)
 *
 * 0.1 + 0.2 !== 0.3 in IEEE-754 binary floating point, and money is exactly the
 * place where that eventually becomes a visible bug. Integers avoid it
 * entirely: 10 + 20 === 30, always.
 *
 * Formatting back to a human string happens only at the edge, in the renderer.
 *
 * CROSS-CURRENCY: converting between currencies necessarily involves a decimal
 * exchange rate, so it cannot be pure integer arithmetic. The rule there is
 * different and equally strict — see shared/lib/rates.ts, which performs exactly
 * ONE rounding step per conversion and never chains conversions.
 */

export const CURRENCIES = {
  // The default: most users of this app are Chinese students abroad.
  CNY: { code: 'CNY', symbol: '¥', name: '人民币', nameEn: 'Chinese Yuan', minorUnits: 2, locale: 'zh-CN' },
  MYR: { code: 'MYR', symbol: 'RM', name: '马来西亚林吉特', nameEn: 'Malaysian Ringgit', minorUnits: 2, locale: 'ms-MY' },
  USD: { code: 'USD', symbol: '$', name: '美元', nameEn: 'US Dollar', minorUnits: 2, locale: 'en-US' },
  SGD: { code: 'SGD', symbol: 'S$', name: '新加坡元', nameEn: 'Singapore Dollar', minorUnits: 2, locale: 'en-SG' },
  HKD: { code: 'HKD', symbol: 'HK$', name: '港币', nameEn: 'Hong Kong Dollar', minorUnits: 2, locale: 'en-HK' },
  EUR: { code: 'EUR', symbol: '€', name: '欧元', nameEn: 'Euro', minorUnits: 2, locale: 'de-DE' },
  GBP: { code: 'GBP', symbol: '£', name: '英镑', nameEn: 'British Pound', minorUnits: 2, locale: 'en-GB' },
  JPY: { code: 'JPY', symbol: '¥', name: '日元', nameEn: 'Japanese Yen', minorUnits: 0, locale: 'ja-JP' },
  KRW: { code: 'KRW', symbol: '₩', name: '韩元', nameEn: 'Korean Won', minorUnits: 0, locale: 'ko-KR' },
  AUD: { code: 'AUD', symbol: 'A$', name: '澳元', nameEn: 'Australian Dollar', minorUnits: 2, locale: 'en-AU' },
  CAD: { code: 'CAD', symbol: 'C$', name: '加元', nameEn: 'Canadian Dollar', minorUnits: 2, locale: 'en-CA' },
  TWD: { code: 'TWD', symbol: 'NT$', name: '新台币', nameEn: 'New Taiwan Dollar', minorUnits: 2, locale: 'zh-TW' },
  THB: { code: 'THB', symbol: '฿', name: '泰铢', nameEn: 'Thai Baht', minorUnits: 2, locale: 'th-TH' },
  // Added because `getCurrency` falls back to the default for an unknown code,
  // which would print a foreign currency under the CNY symbol. Providers return
  // these for Malaysia- and Asia-adjacent destinations that students travel to.
  IDR: { code: 'IDR', symbol: 'Rp', name: '印尼盾', nameEn: 'Indonesian Rupiah', minorUnits: 2, locale: 'id-ID' },
  VND: { code: 'VND', symbol: '₫', name: '越南盾', nameEn: 'Vietnamese Dong', minorUnits: 0, locale: 'vi-VN' },
  PHP: { code: 'PHP', symbol: '₱', name: '菲律宾比索', nameEn: 'Philippine Peso', minorUnits: 2, locale: 'en-PH' },
  INR: { code: 'INR', symbol: '₹', name: '印度卢比', nameEn: 'Indian Rupee', minorUnits: 2, locale: 'en-IN' },
  NZD: { code: 'NZD', symbol: 'NZ$', name: '新西兰元', nameEn: 'New Zealand Dollar', minorUnits: 2, locale: 'en-NZ' },
  MOP: { code: 'MOP', symbol: 'MOP$', name: '澳门元', nameEn: 'Macanese Pataca', minorUnits: 2, locale: 'zh-MO' }
} as const

export type CurrencyCode = keyof typeof CURRENCIES

/** Chinese Yuan — the default for this app's target users. */
export const DEFAULT_CURRENCY: CurrencyCode = 'CNY'

/**
 * Currencies offered in the quick currency switcher, in priority order.
 * The full list remains available in Settings.
 */
export const QUICK_CURRENCIES: readonly CurrencyCode[] = ['CNY', 'MYR', 'SGD', 'USD', 'HKD', 'EUR', 'GBP', 'JPY']

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code)
}

export function getCurrency(code: string): (typeof CURRENCIES)[CurrencyCode] {
  return isSupportedCurrency(code) ? CURRENCIES[code] : CURRENCIES[DEFAULT_CURRENCY]
}

/** Number of decimal places used by a currency's minor unit. */
export function minorUnitsOf(code: string): number {
  return getCurrency(code).minorUnits
}

/**
 * Scale factor between the major unit and the minor unit.
 * MYR -> 100, JPY -> 1.
 */
export function minorUnitScale(code: string): number {
  return 10 ** minorUnitsOf(code)
}

/**
 * Every currency marker we expect to see as a prefix, a suffix or a decoration.
 *
 * ORDER IS SIGNIFICANT: JavaScript alternation is first-match, not longest-match.
 * A naive /[$¥...]|SGD|HK\$/ pattern consumes the bare '$' in "S$12.30" on the
 * first pass, leaving the leading 'S' behind to fail numeric validation. The
 * symbolic prefixes are therefore listed longest-first, ahead of the bare
 * symbols, and the bare symbols are listed last as the catch-all.
 */
const CURRENCY_MARKERS = /HK\$|NT\$|S\$|US\$|RM|RMB|CNY|MYR|USD|SGD|HKD|NTD|JPY|[$¥€£₩₽₹฿₫]/gi

/**
 * Full-width currency symbols mapped to their half-width counterparts.
 *
 * These live in U+FFE0..U+FFE6, which is NOT part of the contiguous
 * U+FF01..U+FF5E full-width ASCII block and is NOT offset from ASCII by a
 * constant: U+FFE5 (￥) minus 0xFEE0 is U+0105 (ą), not U+00A5 (¥). Applying the
 * usual arithmetic widening to this range silently produces a Latin letter and
 * makes every full-width yen amount fail to parse, which is exactly what
 * happens in real WeChat Pay exports. An explicit table avoids that trap.
 */
const FULLWIDTH_CURRENCY: Readonly<Record<string, string>> = {
  '\uFFE0': '\u00A2', // ￠ -> ¢
  '\uFFE1': '\u00A3', // ￡ -> £
  '\uFFE2': '\u00AC', // ￢ -> ¬
  '\uFFE3': '\u00AF', // ￣ -> ¯
  '\uFFE4': '\u00A6', // ￤ -> ¦
  '\uFFE5': '\u00A5', // ￥ -> ¥
  '\uFFE6': '\u20A9' // ￦ -> ₩
}

/**
 * Normalise the width of an amount string and drop currency decorations.
 *
 * Two separate ranges must be handled, and conflating them is a real bug:
 *   - U+FF01..U+FF5E  full-width ASCII, offset 0xFEE0 (covers '＄' and '０-９')
 *   - U+FFE0..U+FFE6  full-width currency symbols, requiring an explicit table
 *   - U+3000          ideographic space, which must be trimmed like a space
 */
function normalizeAmountText(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uFFE0-\uFFE6]/g, (ch) => FULLWIDTH_CURRENCY[ch] ?? ch)
    .replace(/\u3000/g, ' ')
    .replace(CURRENCY_MARKERS, '')
}

/**
 * Parse user input ("1,234.56", "RM 28", "-12.5", "￥50.0") into integer minor
 * units.
 *
 * Returns `null` when the text cannot be interpreted as a number, so callers
 * can surface a validation error instead of silently storing a wrong value.
 *
 * Uses string manipulation, not float multiplication, because
 * Math.round(19.99 * 100) is only accidentally correct and
 * Math.round(1.005 * 100) is famously 100 instead of 101.
 */
export function parseAmountToMinor(input: string | number, currency: string = DEFAULT_CURRENCY): number | null {
  const decimals = minorUnitsOf(currency)

  let text: string
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    // Numbers are converted through a fixed-precision string first so that
    // binary representation error cannot leak into the stored integer.
    text = input.toFixed(decimals + 2)
  } else {
    text = input
  }

  const cleaned = normalizeAmountText(text)
    .trim()
    .replace(/[\s,_]/g, '')

  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return null

  const negative = cleaned.startsWith('-')
  const unsigned = negative ? cleaned.slice(1) : cleaned
  if (unsigned === '' || unsigned === '.') return null

  const dot = unsigned.indexOf('.')
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot)
  const fracRaw = dot === -1 ? '' : unsigned.slice(dot + 1)

  // Truncate extra precision rather than rounding, matching how banks present
  // statement values: a value with more decimals than the currency supports is
  // a parsing problem, not something to invent precision for.
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals)
  if (dot !== -1 && fracRaw.replace(/0/g, '') === '' && intPart === '') return null

  const digits = `${intPart || '0'}${frac}`
  if (!/^\d+$/.test(digits)) return null

  const value = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(value)) return null

  return negative ? -value : value
}

/** Render integer minor units as a plain decimal string, e.g. 1850 -> "18.50". */
export function formatMinorToPlain(minor: number, currency: string = DEFAULT_CURRENCY): string {
  const decimals = minorUnitsOf(currency)
  const negative = minor < 0
  const abs = Math.abs(Math.trunc(minor))
  if (decimals === 0) return `${negative ? '-' : ''}${abs}`

  const scale = 10 ** decimals
  const whole = Math.floor(abs / scale)
  const frac = String(abs % scale).padStart(decimals, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

export interface FormatMoneyOptions {
  /** Include the currency symbol. Default true. */
  withSymbol?: boolean
  /** Always show a leading + or -. Default false (only negatives are signed). */
  signed?: boolean
  /** Group thousands with separators. Default true. */
  grouping?: boolean
  /** Render the absolute value. Default false. */
  absolute?: boolean
  /** Use compact notation for large values (12.3K). Default false. */
  compact?: boolean
}

/**
 * Format integer minor units for display.
 *
 * This never uses toLocaleString on a float, so the output cannot drift from
 * the stored integer.
 */
export function formatMoney(
  minor: number,
  currency: string = DEFAULT_CURRENCY,
  options: FormatMoneyOptions = {}
): string {
  const { withSymbol = true, signed = false, grouping = true, absolute = false, compact = false } = options
  const meta = getCurrency(currency)
  const value = absolute ? Math.abs(minor) : minor
  const isNegative = value < 0

  let body = formatMinorToPlain(Math.abs(value), currency)

  if (compact) {
    const scale = minorUnitScale(currency)
    const major = Math.abs(value) / scale
    if (major >= 1_000_000) body = `${trimZero(major / 1_000_000)}M`
    else if (major >= 1_000) body = `${trimZero(major / 1_000)}K`
  } else if (grouping) {
    const [whole, frac] = body.split('.')
    body = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '')
  }

  const sign = isNegative ? '-' : signed && value > 0 ? '+' : ''
  const symbol = withSymbol ? (meta.minorUnits === 0 ? `${meta.symbol}` : `${meta.symbol} `) : ''
  return `${sign}${symbol}${body}`.replace(`${meta.symbol}  `, `${meta.symbol} `)
}

function trimZero(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '')
}

/**
 * Add minor-unit amounts safely.
 *
 * Because inputs are integers, this is exact. It exists mainly so call sites
 * express intent and so a future switch to bigint has one place to change.
 */
export function sumMinor(values: readonly number[]): number {
  let total = 0
  for (const v of values) total += Math.trunc(v)
  return total
}

/**
 * Split a major-unit float into minor units without float multiplication.
 * Useful when a value arrives from a third-party parser that already produced
 * a JS number (e.g. Excel cell values).
 */
export function numberToMinor(value: number, currency: string = DEFAULT_CURRENCY): number {
  if (!Number.isFinite(value)) return 0
  const decimals = minorUnitsOf(currency)
  // Round at the string level to avoid 1.005 -> 100 style errors.
  const fixed = value.toFixed(decimals)
  return parseAmountToMinor(fixed, currency) ?? 0
}
