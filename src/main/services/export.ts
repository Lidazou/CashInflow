import { writeFileSync } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { FileError, ImportError } from '@main/database/errors'
import type { TransactionWithRefs } from '@shared/types'
import { CSV_EXPORT_HEADERS } from '@shared/constants'

/**
 * CSV export and XLSX reading.
 *
 * XLSX uses ExcelJS (MIT). The SheetJS `xlsx` package was avoided deliberately:
 * the version published to the npm registry is stale (0.18.5) while the
 * authoritative build lives on the vendor's own CDN, and for read-only
 * spreadsheet access ExcelJS covers the requirement with a clean licence.
 *
 * Legacy binary .xls is NOT supported; the import service detects that format by
 * its magic bytes and tells the user to re-save as .xlsx or CSV, rather than
 * producing mojibake from a binary file parsed as text.
 */

const CSV_MIME_BOM = '\ufeff'

/**
 * Quote a CSV field per RFC 4180.
 *
 * A field is quoted when it contains the delimiter, a quote, a newline, or when
 * leading/trailing whitespace would otherwise be lost. Embedded quotes are
 * doubled. Without this, a merchant such as `Coffee, Tea & Co` would shift every
 * subsequent column on that row.
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (text === '') return ''
  const needsQuotes = /[",\r\n]/.test(text) || text !== text.trim()
  if (!needsQuotes) return text
  return `"${text.replace(/"/g, '""')}"`
}

export function buildCsvRow(values: Array<string | number | null | undefined>): string {
  return values.map(escapeCsvField).join(',')
}

/**
 * Serialise transactions to CSV text.
 *
 * A UTF-8 BOM is prepended because Microsoft Excel on Windows otherwise reads a
 * UTF-8 CSV as the system ANSI codepage, which turns CJK merchant names into
 * mojibake. Excel is the single most likely destination for this file.
 *
 * Transfers are exported as separate rows with their own type, and the amount
 * carries the direction, so a round trip through the file preserves the ledger
 * exactly.
 */
export function transactionsToCsv(rows: TransactionWithRefs[]): string {
  const lines: string[] = [buildCsvRow([...CSV_EXPORT_HEADERS])]

  for (const row of rows) {
    // Export the magnitude with an explicit sign convention per type so the file
    // is readable on its own: expenses negative, income positive, transfers
    // signed by direction of travel.
    const currency = row.accountCurrency
    const decimals = 2
    const minor = row.amount
    const absolute = Math.abs(minor)
    const scale = 10 ** decimals
    const whole = Math.floor(absolute / scale)
    const frac = String(absolute % scale).padStart(decimals, '0')
    const amountText = `${minor < 0 ? '-' : ''}${whole}.${frac}`

    lines.push(
      buildCsvRow([
        row.date,
        row.time ?? '',
        row.type,
        amountText,
        currency,
        row.accountName,
        row.categoryName ?? '',
        row.merchant ?? '',
        row.note ?? '',
        row.counterpartAccountName ?? ''
      ])
    )
  }

  // CRLF line endings for maximum spreadsheet compatibility.
  return CSV_MIME_BOM + lines.join('\r\n') + '\r\n'
}

export function writeCsvFile(destination: string, rows: TransactionWithRefs[]): number {
  try {
    writeFileSync(destination, transactionsToCsv(rows), 'utf8')
  } catch (error) {
    throw new FileError(
      `The CSV file could not be written to ${destination}. ${error instanceof Error ? error.message : ''}`.trim(),
      error
    )
  }
  return rows.length
}

/**
 * Read the first worksheet of an XLSX workbook as a grid of strings.
 *
 * Returns raw strings so the CSV pipeline can normalise them uniformly: dates,
 * amounts and encodings all go through the same tested code whether they came
 * from a spreadsheet or a text file.
 */
export async function readXlsxRows(filePath: string): Promise<string[][]> {
  if (!existsSync(filePath)) {
    throw new ImportError(`The file could not be found at ${filePath}.`, 'FILE_IO')
  }

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(readFileSync(filePath) as unknown as ArrayBuffer)
  } catch (error) {
    throw new ImportError(
      `The spreadsheet could not be read. It may be corrupt, password protected, or not a real .xlsx file. ${
        error instanceof Error ? error.message : ''
      }`.trim(),
      'IMPORT_PARSE'
    )
  }

  const worksheet = workbook.worksheets[0]
  if (!worksheet) {
    throw new ImportError('The workbook contains no worksheets.', 'IMPORT_FORMAT')
  }

  const rows: string[][] = []
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = []
    // `row.values` is 1-based with a hole at index 0.
    const values = row.values as unknown[]
    for (let i = 1; i < values.length; i += 1) {
      cells.push(cellToString(values[i]))
    }
    rows.push(cells)
  })

  if (rows.length === 0) {
    throw new ImportError('The first worksheet is empty.', 'IMPORT_FORMAT')
  }

  return rows
}

/**
 * Convert an ExcelJS cell value to a plain string.
 *
 * Dates are formatted as local 'YYYY-MM-DD' rather than an ISO instant, because
 * that is what the downstream date parser expects and because an Excel date is a
 * calendar date, not an instant. Excel's serial-date epoch is handled by ExcelJS,
 * but the value must still be read from LOCAL parts, not via toISOString(), or a
 * date at midnight local shifts a day for users east of UTC.
 *
 * `useStyles` is deliberately omitted: rich-text runs are concatenated rather
 * than dropped, so a description with mixed formatting is not truncated.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''

  if (value instanceof Date) {
    const year = value.getFullYear()
    const month = String(value.getMonth() + 1).padStart(2, '0')
    const day = String(value.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  if (typeof value === 'object') {
    const candidate = value as {
      richText?: Array<{ text?: string }>
      text?: string
      result?: unknown
      hyperlink?: string
      formula?: string
    }
    // Rich text: concatenate every run so no part of the cell is lost.
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((run) => run.text ?? '').join('')
    }
    if (typeof candidate.text === 'string') return candidate.text
    if (candidate.result !== undefined) return String(candidate.result)
    if (candidate.hyperlink) return candidate.hyperlink
    if (candidate.formula) return ''
    return ''
  }

  return String(value)
}
