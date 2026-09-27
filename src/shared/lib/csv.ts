/**
 * CSV parsing and amount/date/text normalisation for statement imports.
 *
 * Implemented locally rather than pulled from a dependency because the bank and
 * wallet formats we must handle are messy in specific ways that generic parsers
 * do not cover by default: junk preamble rows, drifting header positions,
 * full-width currency symbols, GBK-encoded files and trailing footer rows.
 *
 * Parsing rules implemented here:
 *   - RFC 4180: quoted fields may contain the delimiter, doubled quotes, and
 *     embedded newlines. Splitting on '\n' is wrong and corrupts such files.
 *   - A UTF-8 BOM at the start of the file is stripped.
 *   - Delimiter is sniffed by finding the delimiter that yields the most
 *     CONSISTENT per-line field count, not the highest total occurrence. A
 *     description column containing many commas would win the naive test.
 */

export interface ParsedCsv {
  /** Every row, including preamble and footer rows. */
  rows: string[][]
  delimiter: string
  /** Index of the row that looks like the real header, or -1. */
  headerIndex: number
}

const DELIMITERS = [',', ';', '\t', '|']

/** Remove a UTF-8 BOM, which Excel writes and which corrupts the first header. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Parse delimited text into rows of cells.
 *
 * Written as an explicit character scan rather than a regex split so that quoted
 * newlines and escaped quotes are handled correctly in one pass.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const input = stripBom(text)

  while (i < input.length) {
    const char = input[i]

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"') {
      inQuotes = true
      i += 1
      continue
    }

    if (char === delimiter) {
      row.push(field)
      field = ''
      i += 1
      continue
    }

    if (char === '\r') {
      // Treat CRLF and a lone CR as one line break.
      i += input[i + 1] === '\n' ? 2 : 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    if (char === '\n') {
      i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    field += char
    i += 1
  }

  // Flush the final field/row when the file does not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * Choose the delimiter by consistency of field count.
 *
 * Scores each candidate by how many of the first N non-empty rows share the most
 * common field count, weighting by that count. This beats "most occurrences"
 * because a free-text description with many commas produces a high occurrence
 * total but an inconsistent field count.
 */
export function sniffDelimiter(text: string): string {
  const sample = stripBom(text)
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 25)

  if (sample.length === 0) return ','

  let best = ','
  let bestScore = -1

  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => parseDelimited(line, delimiter)[0]?.length ?? 1)
    const frequency = new Map<number, number>()
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1)

    let modeCount = 0
    let modeFrequency = 0
    for (const [count, freq] of frequency) {
      if (freq > modeFrequency || (freq === modeFrequency && count > modeCount)) {
        modeCount = count
        modeFrequency = freq
      }
    }

    // Require a real multi-column structure: a single-column file is not
    // meaningfully delimited by anything.
    if (modeCount < 2) continue

    const score = modeFrequency * 10 + modeCount
    if (score > bestScore) {
      bestScore = score
      best = delimiter
    }
  }

  return best
}

/**
 * Locate the real header row.
 *
 * WeChat and Alipay exports prepend a preamble whose length varies between
 * exports (Alipay adds a "常见问题" help block in some versions), so a hardcoded
 * skip count breaks on real files. Instead we look for the first row that
 * contains enough recognisable header keywords, which is robust to drift.
 */
export function findHeaderRow(rows: string[][], expected: string[], minMatches = 2): number {
  let bestIndex = -1
  let bestMatches = 0

  const limit = Math.min(rows.length, 60)
  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i].map((cell) => normaliseHeader(cell))
    if (cells.length < 2) continue

    const matches = expected.filter((keyword) =>
      cells.some((cell) => cell.includes(normaliseHeader(keyword)))
    ).length

    if (matches > bestMatches) {
      bestMatches = matches
      bestIndex = i
    }
    // Stop at the first row that clearly looks like the header rather than
    // scanning the entire data section for a coincidental match.
    if (matches >= minMatches + 1) return i
  }

  return bestMatches >= minMatches ? bestIndex : -1
}

/** Normalise a header cell for comparison: trim, strip spaces/underscores/punctuation, lowercase. */
export function normaliseHeader(value: string): string {
  return stripBom(String(value ?? ''))
    .replace(/[\s_\-()[\]（）【】]/g, '')
    .replace(/[，、]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * A row is a footer summary rather than data when it has very few filled cells
 * and contains summary wording. Stopping at the first such row prevents
 * "共43笔记录" being imported as a transaction.
 */
export function looksLikeFooter(cells: string[]): boolean {
  const filled = cells.filter((cell) => String(cell ?? '').trim() !== '')
  if (filled.length === 0) return true
  const joined = filled.join(' ')
  if (/^[-—=]+$/.test(joined.trim())) return true
  return /(共\s*\d+\s*笔|总计|合计|小计|以上|说明[:：]|常见问题|温馨提示)/.test(joined)
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

export interface AmountParseResult {
  minor: number | null
  negative: boolean
}

/**
 * Parse a statement amount cell into integer minor units.
 *
 * Handles the conventions that appear in real exports:
 *   '¥28.16'  '￥50.0'  'RM1,234.56'  '(123.45)'  '123.45-'  '1.234,56' (EU)
 * The European form is detected only when the comma is unambiguously the decimal
 * separator, so a plain '1,234' is still read as one thousand two hundred thirty
 * four rather than 1.234.
 */
export function parseStatementAmount(raw: string): AmountParseResult {
  const original = String(raw ?? '').trim()
  if (original === '' || original === '-' || original === '--' || original === '""') {
    return { minor: null, negative: false }
  }

  // Parentheses and a trailing minus both mean negative in bank exports.
  let negative = false
  let text = original

  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  if (/-\s*$/.test(text)) {
    negative = true
    text = text.replace(/-\s*$/, '')
  }

  const normalized = text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uFFE0-\uFFE6]/g, (ch) => ({ '\uFFE5': '\u00A5' })[ch] ?? ch)
    .replace(/\u3000/g, ' ')
    .replace(/HK\$|NT\$|S\$|US\$|RM|RMB|CNY|MYR|USD|SGD|HKD|NTD|JPY/gi, '')
    .replace(/[$¥€£₩₽₹฿₫\s]/g, '')

  if (normalized === '') return { minor: null, negative }

  // Decide whether a comma is a thousands separator or a decimal comma.
  let cleaned = normalized
  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  if (lastComma > lastDot && /,\d{1,2}$/.test(cleaned)) {
    // '1.234,56' -> decimal comma; drop dots as grouping, comma becomes a dot.
    cleaned = cleaned.replace(/\./g, '').replace(',', '.')
  } else {
    cleaned = cleaned.replace(/,/g, '')
  }

  if (cleaned.startsWith('-')) {
    negative = true
    cleaned = cleaned.slice(1)
  }
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)

  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    return { minor: null, negative }
  }

  // String-based conversion: never multiply a float by 100.
  const [intPart = '0', fracPart = ''] = cleaned.split('.')
  const frac = (fracPart + '00').slice(0, 2)
  const digits = `${intPart || '0'}${frac}`
  if (!/^\d+$/.test(digits)) return { minor: null, negative }

  const value = Number.parseInt(digits, 10)
  if (!Number.isSafeInteger(value)) return { minor: null, negative }

  return { minor: value, negative }
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

export interface ParsedDate {
  date: string | null
  time: string | null
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
}

/**
 * Parse the date formats found in statements.
 *
 * Supports:
 *   '2026-09-26 14:05:00'  (WeChat/Alipay, already local wall-clock time)
 *   '26/09/2026'  '09/26/2026'  '26-09-2026'  '26.09.2026'
 *   '26 Sep 2026'  '19 Jul 2024'  'Sep 26, 2026'
 *   '20260926'
 *
 * AMBIGUITY: '03/04/2026' is 3 April in Malaysia and 4 March in the US. The
 * `dayFirst` hint (user's region preference) resolves it. When a component is
 * greater than 12 the format is unambiguous and the hint is ignored, so a wrong
 * hint cannot corrupt a self-evident date.
 */
export function parseStatementDate(raw: string, dayFirst = true): ParsedDate {
  const original = String(raw ?? '').trim()
  if (!original) return { date: null, time: null }

  const text = original
    .replace(/\u3000/g, ' ')
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/\./g, '-')

  // Extract an optional trailing time component.
  let time: string | null = null
  const timeMatch = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (timeMatch) {
    const hh = Number(timeMatch[1])
    const mm = Number(timeMatch[2])
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }
  }

  const dateOnly = text.replace(/\d{1,2}:\d{2}(:\d{2})?/, '').trim()

  // ISO: 2026-09-26
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateOnly)
  if (iso) return { date: buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3])), time }

  // Compact: 20260926
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(dateOnly)
  if (compact) return { date: buildDate(Number(compact[1]), Number(compact[2]), Number(compact[3])), time }

  // Numeric with separators: 26-09-2026 / 26/09/26
  const numeric = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$/.exec(dateOnly)
  if (numeric) {
    let a = Number(numeric[1])
    let b = Number(numeric[2])
    let c = Number(numeric[3])

    // A 4-digit first component is unambiguous ISO-ish ordering.
    if (numeric[1].length === 4) return { date: buildDate(a, b, c), time }

    let year = c
    if (numeric[3].length <= 2) year = c >= 70 ? 1900 + c : 2000 + c

    // Whichever component exceeds 12 must be the day.
    if (a > 12 && b <= 12) return { date: buildDate(year, b, a), time }
    if (b > 12 && a <= 12) return { date: buildDate(year, a, b), time }

    return dayFirst ? { date: buildDate(year, b, a), time } : { date: buildDate(year, a, b), time }
  }

  // Named month: '26 Sep 2026', '19 Jul 2024'
  const namedDmy = /^(\d{1,2})[-\s]+([A-Za-z]{3,9})[-\s]+(\d{2,4})$/.exec(dateOnly)
  if (namedDmy) {
    const month = MONTH_NAMES[namedDmy[2].toLowerCase()]
    if (month) return { date: buildDate(normaliseYear(Number(namedDmy[3])), month, Number(namedDmy[1])), time }
  }

  // Named month: 'Sep 26, 2026'
  const namedMdy = /^([A-Za-z]{3,9})[-\s]+(\d{1,2}),?[-\s]+(\d{2,4})$/.exec(dateOnly)
  if (namedMdy) {
    const month = MONTH_NAMES[namedMdy[1].toLowerCase()]
    if (month) return { date: buildDate(normaliseYear(Number(namedMdy[3])), month, Number(namedMdy[2])), time }
  }

  return { date: null, time }
}

function normaliseYear(year: number): number {
  if (year >= 100) return year
  return year >= 70 ? 1900 + year : 2000 + year
}

/** Build a validated 'YYYY-MM-DD', rejecting impossible dates like 2026-02-31. */
function buildDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (year < 1900 || year > 2200) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null

  const probe = new Date(year, month - 1, day)
  // Date rolls invalid values forward (Feb 31 -> Mar 3); reject instead.
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace and strip stray tabs that CN wallet exports embed. */
export function cleanCell(value: string | undefined | null): string {
  return String(value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Normalise a payee/description for duplicate-key comparison. */
export function normaliseForKey(value: string | null | undefined): string {
  return cleanCell(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}
