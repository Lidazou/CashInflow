import { parseStatementAmount, parseStatementDate } from '@shared/lib/csv'
import { minorUnitScale } from '@shared/lib/money'
import { isValidDateString, today } from '@shared/lib/dates'

/**
 * Reading a receipt out of OCR text.
 *
 * WHY THIS IS A PARSER AND NOT A MODEL CALL
 * -----------------------------------------
 * The input is already text by the time it gets here — tesseract did the hard part locally and
 * for free. What is left is a layout problem: find the number that is the total, the date, the
 * time, and a merchant name, in a wall of lines whose order is only loosely meaningful. A
 * handful of ordered rules does that predictably and offline, and every rule can be tested
 * against a captured sample. A model call would be less code and considerably more ways to
 * fail: it needs a network, it needs a key, it costs money per receipt, and it would send a
 * photograph of somebody's bank statement to a stranger's server, which for a local-first
 * finance app is the wrong trade at any price.
 *
 * THE ONE THING IT MUST NOT DO
 * ----------------------------
 * Guess. Every field it returns is either supported by the text or null, and each candidate
 * carries which rule produced it so the UI can say "from the line marked TOTAL" rather than
 * presenting a number with no provenance. A confidently wrong amount on a receipt is worse than
 * an empty field, because the empty field gets filled in and the wrong number gets saved.
 *
 * REAL OCR OUTPUT IT IS WRITTEN AGAINST
 * -------------------------------------
 * Chinese recognition inserts spaces inside words and sometimes drops or invents a character:
 *
 *     MAYBANK
 *     Kuala Lumpur Malaysia
 *     2026-09-25 12:14
 *     Lunch
 *     TOTAL
 *     RM 172.50
 *     午 餐
 *     合 计 RM 172.50
 *
 * So: whitespace is normalised to nothing before keyword matching (「合 计」 must match 「合计」),
 * but the RAW line is kept for the merchant, because that is what the user is going to read and
 * correct.
 */

/** What a candidate amount was found next to. Drives how much it is trusted. */
export type AmountReason = 'total-keyword' | 'currency' | 'largest' | 'only'

export interface ReceiptCandidate {
  /** Positive magnitude in the currency's minor units. Never a float. */
  amountMinor: number
  currency: string | null
  /** Why this number was chosen, so the UI can show it and the user can distrust it. */
  amountReason: AmountReason
  /** The line the amount came from, for the same reason. */
  amountSource: string
  /** 'YYYY-MM-DD', or null. */
  date: string | null
  /** 'HH:MM', or null. Never invented. */
  time: string | null
  merchant: string | null
  /** The line that looked like a title — a shop name, a first non-numeric line. */
  merchantSource: string | null
  /** 0..1, for the UI to decide whether to look confident. */
  confidence: number
}

export interface ReceiptParseResult {
  candidates: ReceiptCandidate[]
  /** The text as it arrived, so the UI can offer it for inspection. */
  rawText: string
  /** Lines that looked like they carried information, for a debug view. */
  notes: string[]
}

/** Currency tokens, longest first so `RM` is not eaten by `R`. */
const CURRENCY_TOKENS: Array<{ pattern: RegExp; code: string | null }> = [
  { pattern: /HK\$/i, code: 'HKD' },
  { pattern: /NT\$/i, code: 'TWD' },
  { pattern: /US\$/i, code: 'USD' },
  { pattern: /S\$/i, code: 'SGD' },
  { pattern: /RM/i, code: 'MYR' },
  { pattern: /RMB/i, code: 'CNY' },
  { pattern: /CNY/i, code: 'CNY' },
  { pattern: /MYR/i, code: 'MYR' },
  { pattern: /USD/i, code: 'USD' },
  { pattern: /SGD/i, code: 'SGD' },
  { pattern: /HKD/i, code: 'HKD' },
  { pattern: /JPY/i, code: 'JPY' },
  { pattern: /€/, code: 'EUR' },
  { pattern: /£/, code: 'GBP' },
  { pattern: /¥/, code: 'CNY' },
  { pattern: /\$/, code: 'USD' },
  { pattern: /₩/, code: 'KRW' },
  { pattern: /฿/, code: 'THB' }
]

/**
 * Words that mean "this is the total".
 *
 * Weighted, because they are not equally strong. `TOTAL`/`合计` on their own line is the
 * receipt telling you the answer; `金额` can head a column of line items and `应收` can be a
 * subtotal. The weights only order the candidates — the ordering is what picks the amount.
 */
const TOTAL_KEYWORDS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /grand\s*total|total\s*amount|amount\s*due|合计金额|总计|总额|应付总额/, weight: 100 },
  { pattern: /合\s*计|总\s*计|应\s*付|实\s*付|total|amount\s*due|balance\s*due|to\s*pay/, weight: 80 },
  { pattern: /小\s*计|sub\s*total|subtotal/, weight: 45 },
  { pattern: /金\s*额|amount/, weight: 25 },
  { pattern: /扣\s*款|支付|已付|paid|payment/, weight: 20 }
]

/** Words that mean the number is NOT the total. */
const NEGATIVE_KEYWORDS: RegExp[] = [
  /余\s*额|balance|change|找零|折\s*扣|discount|税|tax|gst|sst|服务费|service\s*charge|tip|小费|汇率|rate|积分|point|cash|现金|刷卡|card\s*no|卡号/i
]

/** A date anywhere in a line, in the shapes receipts actually print. */
const DATE_PATTERNS: RegExp[] = [
  /\d{4}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}\s?日?/,
  /\d{1,2}[-/.月]\s?\d{1,2}[-/.日]\s?[,]?\s?\d{2,4}/,
  /\d{4}\d{2}\d{2}/,
  /\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}/i,
  /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{2,4}/i
]

const TIME_PATTERN = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/

/** A line that is only a number, or a number with a currency token. */
const AMOUNT_LINE = /^[^\d]{0,4}(-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*$/

/** Lines that are never a shop name. */
const MERCHANT_STOPWORDS =
  /receipt|invoice|tax|thank|welcome|tel|phone|www\.|http|@|gst|sst|reg\s*no|no\.|date|time|table|cashier|server|terminal|地址|电话|发票|收据|谢谢|欢迎|小票|机号|单号|详情|账单|交易|支付|付款|收款|商户|商品|订单|金额|状态|方式|时间|支付宝|微信/i

function squash(text: string): string {
  // tesseract puts spaces between CJK glyphs; removing ALL whitespace makes 「合 计」 match
  // 「合计」. Only ever used for keyword matching, never for anything the user reads.
  return text.replace(/\s+/g, '').toLowerCase()
}

/** Currency of a line, or null when the line names none. */
function currencyOf(line: string): string | null {
  for (const token of CURRENCY_TOKENS) {
    if (token.pattern.test(line)) return token.code
  }
  return null
}

/**
 * The bare amount in a line, ready for `parseStatementAmount`.
 *
 * THE PARSER IS A CELL PARSER, AND OCR GIVES LINES. `parseStatementAmount` was written for the
 * CSV importer, where the value arrives on its own — `"RM 172.50"`, `"1,234.50"`, `"(80.00)"`.
 * Handed a whole OCR line it returns null, because a line has words in it:
 *
 *     parseStatementAmount('RM 172.50')        -> 17250
 *     parseStatementAmount('TOTAL RM 12.00')   -> null     <-- the bug this fixes
 *     parseStatementAmount('合 计 RM 34.00')    -> null
 *
 * So the number is located first and only the number is handed over, which keeps the importer's
 * tested arithmetic — thousands separators, full-width digits, parenthesised negatives — as the
 * single answer to "what does this number mean".
 *
 * WHY A TOKEN WITH NEITHER A DECIMAL POINT NOR A CURRENCY SYMBOL IS REJECTED
 * -------------------------------------------------------------------------
 * A receipt is full of bare integers that are not money: order numbers, phone numbers, table
 * numbers, card digits, loyalty points. `12345` and `202609232200145` both parse happily as
 * amounts and neither is one. Requiring a decimal point, or a currency marker on the same line,
 * or an explicit money word, removes essentially all of them — real prices have decimals, and
 * the ones that do not ("合计 128") are on a line that says 合计.
 */
const NUMERIC_TOKEN = /-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+\.\d{1,2}|-?\d+/

function amountToken(line: string): string | null {
  const hasDecimal = /\d[.,]\d{2}\b/.test(line)
  const hasMoneyMark = currencyOf(line) !== null || /金\s*额|合\s*计|总\s*计|应\s*付|实\s*付|total|amount|paid|小\s*计/i.test(squash(line))
  if (!hasDecimal && !hasMoneyMark) return null

  const match = NUMERIC_TOKEN.exec(line)
  return match ? match[0] : null
}

/** Currency implied by the whole receipt, for amounts whose own line omits it. */
function dominantCurrency(lines: string[]): string | null {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const code = currencyOf(line)
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [code, count] of counts) {
    if (count > bestCount) {
      best = code
      bestCount = count
    }
  }
  return best
}

interface ScoredAmount {
  minor: number
  currency: string | null
  weight: number
  reason: AmountReason
  source: string
}

/**
 * Every number on the receipt, with a weight saying how likely it is to be the total.
 *
 * `parseStatementAmount` does the reading, and it is the same function the CSV importer uses:
 * it already knows that `RM 1,234.50` is 123450 minor units, that a trailing minus means
 * negative, and that full-width digits and full-width currency signs are things real bank
 * exports contain. Reimplementing that here would be a second answer to a question the app has
 * already answered.
 */
function scoreAmounts(lines: string[], fallbackCurrency: string | null): ScoredAmount[] {
  const out: ScoredAmount[] = []

  for (const line of lines) {
    const token = amountToken(line)
    if (token === null) continue
    const parsed = parseStatementAmount(token)
    if (parsed.minor === null || parsed.minor === 0) continue

    const code = currencyOf(line) ?? fallbackCurrency
    const squashed = squash(line)
    let weight = 10
    let reason: AmountReason = code ? 'currency' : 'largest'

    for (const keyword of TOTAL_KEYWORDS) {
      if (keyword.pattern.test(squashed)) {
        // Only ever upgrade: a line that says TOTAL and also happens to contain 「现金」 is still
        // the total.
        if (keyword.weight > weight) {
          weight = keyword.weight
          reason = 'total-keyword'
        }
        break
      }
    }
    for (const negative of NEGATIVE_KEYWORDS) {
      if (negative.test(squashed)) {
        weight = Math.min(weight, 5)
        break
      }
    }
    // A line with no digits other than the amount is a stronger candidate than a line buried in
    // prose, because receipts put the total on its own line.
    if (AMOUNT_LINE.test(line.trim())) weight += 8

    /*
      Scale by currency.

      `parseStatementAmount` reads the DIGITS: `RM 172.50` and `¥172.50` both come back as 17250,
      which is correct for a 2-decimal currency and wrong for JPY, where those digits mean 172
      yen-and-a-half. Every currency this app supports is 2-decimal except JPY and KRW, so the
      correction is applied from the currency's own declared minor units rather than guessed.
    */
    const scale = code ? minorUnitScale(code) / 100 : 1
    const minor = Math.round(parsed.minor * scale)

    out.push({
      minor: Math.abs(minor),
      currency: code,
      weight,
      reason,
      source: line.trim()
    })
  }

  return out
}

/**
 * A label and its value on one line: 「商户名称  星巴克咖啡」, `Merchant: Starbucks`.
 *
 * The value is what follows the label, and the label is thrown away — 「商户名称星巴克咖啡」 is
 * not a shop anybody has heard of. Matched on a Chinese label with no separator at all, because
 * that is how these screens are laid out and OCR keeps or drops the spacing unpredictably.
 */
const LABELLED_VALUE = /^\s*(?:商户名称|商户|商家|收款方|付款方|merchant|payee|vendor|shop\s*name)\s*[:：]?\s*(.+)$/i

/** The first plausible shop name: an early line that is mostly letters. */
function findMerchant(lines: string[]): { name: string | null; source: string | null } {
  /** Is this text usable as a shop name? */
  const usable = (text: string): boolean => {
    if (text.length < 2 || text.length > 60) return false
    if (MERCHANT_STOPWORDS.test(text)) return false
    // Must be mostly letters: a line of digits is an order number, a date or an amount.
    const letters = (text.match(/[\p{L}]/gu) ?? []).length
    const digits = (text.match(/\d/g) ?? []).length
    if (letters < 2 || digits > letters) return false
    // A line that parses as a date or an amount is not a name.
    if (parseStatementDate(text).date) return false
    if (amountToken(text) !== null) return false
    return true
  }

  /*
    Pass one: an explicitly labelled merchant.

    A WeChat or Alipay screenshot puts the shop on a line marked 商户名称, and the label is a
    stronger signal than position, so it wins over whatever happens to be on line one. Its own
    line is also the only place the name appears without an app name above it.
  */
  for (const line of lines.slice(0, 14)) {
    const labelled = LABELLED_VALUE.exec(line.trim())
    if (!labelled) continue
    const value = labelled[1].trim()
    if (usable(value)) return { name: value, source: line.trim() }
  }

  // Pass two: the first usable line near the top.
  for (const line of lines.slice(0, 8)) {
    const text = line.trim()
    if (usable(text)) return { name: text, source: text }
  }
  return { name: null, source: null }
}

/**
 * The first valid date and time anywhere in the text.
 *
 * The date is read from the MATCH rather than from the whole line, because the line has words
 * in it:
 *
 *     parseStatementDate('2026年9月25日 15:30')               -> 2026-09-25
 *     parseStatementDate('支付时间  2026年9月25日 15:30')      -> null      <-- the bug this fixes
 *
 * Its own patterns are anchored, which is right for a CSV column and wrong for a screenshot.
 */
function findDate(lines: string[]): { date: string | null; time: string | null; source: string | null } {
  for (const line of lines) {
    for (const pattern of DATE_PATTERNS) {
      const match = pattern.exec(line)
      if (!match) continue
      const parsed = parseStatementDate(match[0])
      if (!parsed.date || !isValidDateString(parsed.date)) continue
      const time = parsed.time ?? TIME_PATTERN.exec(line)?.[0] ?? null
      return { date: parsed.date, time: time ? time.slice(0, 5) : null, source: line.trim() }
    }
  }
  // A time with no date on the same line: keep the time, leave the date for the caller.
  for (const line of lines) {
    const time = TIME_PATTERN.exec(line)?.[0]
    if (time) return { date: null, time: time.slice(0, 5), source: line.trim() }
  }
  return { date: null, time: null, source: null }
}

/**
 * Read one or more amounts out of OCR text.
 *
 * More than one candidate only when the text genuinely offers several — a receipt with a
 * subtotal and a total, or a photo of two receipts. When there is one obvious answer the list
 * has one entry, because a chooser with a single option is noise.
 */
export function parseReceiptText(text: string, options: { defaultCurrency?: string | null } = {}): ReceiptParseResult {
  const rawText = String(text ?? '')
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\u00a0/g, ' ').trimEnd())
    .filter((line) => line.trim().length > 0)

  const notes: string[] = []
  if (lines.length === 0) return { candidates: [], rawText, notes: ['no text'] }

  const fallback = dominantCurrency(lines) ?? options.defaultCurrency ?? null
  const scored = scoreAmounts(lines, fallback)
  const { date, time, source: dateSource } = findDate(lines)
  const { name: merchant } = findMerchant(lines)
  if (dateSource) notes.push('date from: ' + dateSource)
  if (fallback) notes.push('currency: ' + fallback)

  if (scored.length === 0) {
    return { candidates: [], rawText, notes: [...notes, 'no amount found'] }
  }

  /*
    Order candidates.

    Weight first — a line marked TOTAL outranks any amount merely because it is large — then
    size, largest first. Size breaks ties because on a receipt the total is larger than its own
    line items, and it is the only signal left when no keyword survived OCR.
  */
  const ordered = [...scored].sort((a, b) => b.weight - a.weight || b.minor - a.minor)

  /*
    Keep distinct amounts, best-scoring first.

    Two lines can carry the same total (`TOTAL` and `合计`), and offering it twice would make the
    chooser look like it found two things. Duplicates are collapsed by amount+currency, keeping
    whichever instance scored higher.
  */
  const seen = new Set<string>()
  const unique: ScoredAmount[] = []
  for (const entry of ordered) {
    const key = `${entry.minor}:${entry.currency ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(entry)
    if (unique.length >= 5) break
  }

  const candidates: ReceiptCandidate[] = unique.map((entry, index) => {
    /*
      Confidence, as a number the UI can threshold.

      Anchored on what was actually recognised rather than on how the parse "feels": a total
      keyword plus a date plus a merchant is a receipt that read cleanly; an amount found only by
      being the largest number on an otherwise unreadable page is a coin flip, and the interface
      should say so rather than pre-fill and move on.
    */
    let confidence = 0.35
    if (entry.reason === 'total-keyword') confidence += 0.4
    else if (entry.reason === 'currency') confidence += 0.15
    if (entry.currency) confidence += 0.1
    if (date) confidence += 0.1
    if (merchant) confidence += 0.05
    confidence -= index * 0.08

    return {
      amountMinor: entry.minor,
      currency: entry.currency,
      amountReason: entry.reason,
      amountSource: entry.source,
      date,
      time,
      merchant,
      merchantSource: merchant,
      confidence: Math.max(0.05, Math.min(0.99, Number(confidence.toFixed(2))))
    }
  })

  return { candidates, rawText, notes }
}

/** Today, as the fallback the UI offers when a receipt carried no readable date. */
export function receiptFallbackDate(): string {
  return today()
}
