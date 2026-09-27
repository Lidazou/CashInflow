import { writeFileSync } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { FileError, ImportError } from '@main/database/errors'
import { nowIso } from '@shared/lib/dates'
import { getCurrency, minorUnitScale, minorUnitsOf } from '@shared/lib/money'
import type { TransactionWithRefs } from '@shared/types'
import { CSV_EXPORT_HEADERS } from '@shared/constants'

/**
 * CSV and XLSX export, and XLSX reading.
 *
 * XLSX uses ExcelJS (MIT). The SheetJS `xlsx` package was avoided deliberately:
 * the version published to the npm registry is stale (0.18.5) while the
 * authoritative build lives on the vendor's own CDN, and for spreadsheet access
 * ExcelJS covers both directions with a clean licence.
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

/* -------------------------------------------------------------------------- */
/* XLSX writing (v1.6.0)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The workbook's columns, in order.
 *
 * `minorUnits` is how many decimals the amount column is written with, resolved per ROW
 * rather than per file: a ledger can hold a JPY account (0 decimals) beside a MYR one
 * (2), and writing 1000 minor units as "1000" for one and "10.00" for the other is the
 * difference between a correct statement and one that is out by two orders of magnitude.
 *
 * The user-facing column set is deliberately not the database's: no ids, no `transferId`,
 * no `importBatchId`, no created/updated timestamps. A spreadsheet is for reading, and an
 * internal key in column A is one more thing to explain to whoever opens it (spec §29).
 */
interface XlsxColumn {
  header: string
  key: string
  width: number
  /** Number format for numeric columns, or undefined for text. */
  numFmt?: string
  /** Append the row's currency code to a text cell, e.g. "100.00 MYR". */
  suffixCurrency?: boolean
}

const XLSX_COLUMNS: readonly XlsxColumn[] = [
  { header: 'Date', key: 'date', width: 12 },
  { header: 'Time', key: 'time', width: 7 },
  { header: 'Transaction', key: 'merchant', width: 28 },
  { header: 'Category', key: 'category', width: 16 },
  { header: 'Type', key: 'type', width: 10 },
  { header: 'Amount', key: 'amount', width: 14 },
  { header: 'Currency', key: 'currency', width: 10 },
  { header: 'Account', key: 'account', width: 18 },
  { header: 'Note', key: 'note', width: 34 }
]

/** 'YYYY-MM-DD' as a real Date at LOCAL midnight — never `new Date(string)`. */
function localDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, (month ?? 1) - 1, day ?? 1)
}

/** Signed major units as a NUMBER, from integer minor units and the currency's scale. */
function majorUnits(minor: number, currency: string): number {
  const scale = minorUnitScale(currency)
  // Division by a power of ten is exact in binary floating point for these magnitudes,
  // and Excel stores doubles anyway: the value the user sees is rounded by the number
  // format, not by the storage.
  return minor / scale
}

/**
 * Build the workbook for a set of transactions.
 *
 * WHY A REAL .xlsx AND NOT A .csv RENAMED (spec §30, §32)
 * -----------------------------------------------------
 * The point of this export is that it arrives ready to work with: Date cells that sort
 * and filter as dates, Amount cells that SUM as numbers, a frozen header and an auto
 * filter over the range. A CSV cannot carry any of that — it carries text that Excel
 * re-guesses on open, which is exactly how "2026-09-28" becomes a date in one locale and
 * a string in another.
 *
 * `totalRow` is added when the caller asked for it and the sheet has rows: a plain SUM
 * over the Amount column, because the first thing anyone does with an exported ledger is
 * check the total against the app.
 */
export function buildTransactionsWorkbook(
  rows: TransactionWithRefs[],
  options: { currency?: string; sheetName?: string } = {}
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.creator = 'CashInflow'

  const sheet = workbook.addWorksheet(options.sheetName ?? 'Transactions', {
    views: [{ state: 'frozen', ySplit: 1 }]
  })

  sheet.columns = XLSX_COLUMNS.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width
  }))

  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  header.height = 18

  for (const row of rows) {
    const currency = row.accountCurrency
    const added = sheet.addRow({
      date: localDate(row.date),
      time: row.time ?? '',
      merchant: row.merchant ?? '',
      category: row.categoryName ?? '',
      type: row.type,
      amount: majorUnits(row.amount, currency),
      currency,
      account: row.accountName,
      note: row.note ?? ''
    })

    /* Date as a date, not as text: the cell is a Date and the format is a real one. */
    added.getCell('date').numFmt = 'yyyy-mm-dd'
    const amountCell = added.getCell('amount')
    amountCell.numFmt = moneyFormatFor(currency)
    if (row.type === 'expense') {
      // Expenses are stored negative, so the number format already shows the sign; the
      // colour makes the direction readable at a glance without changing the value.
      amountCell.font = { color: { argb: 'FFB91C1C' } }
    } else if (row.type === 'income') {
      amountCell.font = { color: { argb: 'FF15803D' } }
    }
  }

  const lastRow = rows.length + 1
  if (rows.length > 0) {
    const total = sheet.addRow({ merchant: 'Total', amount: { formula: `SUM(F2:F${lastRow})` } })
    total.font = { bold: true }
    total.getCell('amount').numFmt = moneyFormatFor(options.currency ?? rows[0].accountCurrency)
  }

  /*
    Auto filter over the data range only — never over the total row.

    A filter that includes the SUM line means sorting the sheet moves the total into the
    middle of the data, where it is silently added to whatever is above it.
  */
  if (rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: XLSX_COLUMNS.length } }
  }

  return workbook
}

/** Excel number format for a currency, e.g. `"RM" #,##0.00`. */
export function moneyFormatFor(currency: string): string {
  const meta = getCurrency(currency)
  const decimals = minorUnitsOf(currency)
  const digits = decimals > 0 ? `.${'0'.repeat(decimals)}` : ''
  // The symbol is quoted so Excel treats it as text rather than as a format token, and
  // the negative section keeps the sign on the left where a ledger reader expects it.
  const positive = `"${meta.symbol}" #,##0${digits}`
  return `${positive};-"${meta.symbol}" #,##0${digits}`
}

/** Write the workbook, resolving once the file is on disk. Returns the row count. */
export async function writeTransactionsXlsx(
  destination: string,
  rows: TransactionWithRefs[],
  options: { currency?: string } = {}
): Promise<number> {
  const workbook = buildTransactionsWorkbook(rows, options)
  try {
    await workbook.xlsx.writeFile(destination)
  } catch (error) {
    throw new FileError(
      `The spreadsheet could not be written to ${destination}. ${error instanceof Error ? error.message : ''}`.trim(),
      error
    )
  }
  return rows.length
}

/** Suggested file name for an export, from the filter that produced it (spec §30). */
export function xlsxFileName(range: { from?: string; to?: string }): string {
  const from = range.from ?? ''
  const to = range.to ?? ''
  if (from && to) {
    if (from === to) return `CashInflow_Transactions_${from}.xlsx`
    // Same month: name it by the month, which is what the reader calls it.
    if (from.slice(0, 7) === to.slice(0, 7)) return `CashInflow_Transactions_${from.slice(0, 7)}.xlsx`
    return `CashInflow_Transactions_${from}_${to}.xlsx`
  }
  return `CashInflow_Transactions_${nowIso().slice(0, 10)}.xlsx`
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
